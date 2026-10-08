// Drives the real app in headless Chromium over the DevTools protocol and
// checks that the interactive paths work (menus, cameras, driving, tracks).
// Usage: start `npm run dev`, then `node scripts/browser-check.mjs [url] [screenshotDir]`
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:3000/';
const shotDir = process.argv[3] || null;
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(process.env.CHROME || 'chromium', [
  '--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--window-size=1280,720', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, 'about:blank'
], { stdio: 'ignore' });

let failures = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(500);
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(msg.params.args.map((a) => a.description || a.value).join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval failed');
    return res.result.result.value;
  };
  const key = (type, code) => run(`window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}', bubbles: true }))`);
  const tap = async (code) => { await key('keydown', code); await key('keyup', code); };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const frames = () => run('corsa.renderer.renderer.info.render.frame');
  const waitFrames = async (n = 3) => {
    const start = await frames();
    for (let i = 0; i < 300; i++) { await sleep(100); if ((await frames()) >= start + n) return true; }
    return false;
  };
  const until = async (expression, timeout = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await run(expression)) return true; await sleep(200); }
    return false;
  };
  const shot = async (name) => {
    if (!shotDir) return;
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${shotDir}/${name}.png`, Buffer.from(res.result.data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  check('app boots', await until('!!(window.corsa && corsa.physics.track)', 60000));
  check('renders frames before start', await waitFrames());

  console.log('start / driving');
  await click('#start-btn');
  check('start overlay dismissed', await run('corsa.started'));
  await run("document.getElementById('btn-mode').click()"); // normal mode: no lane keeping
  await key('keydown', 'KeyW');
  check('accelerates under throttle', await until('corsa.physics.speedKmh > 95', 240000), `${(await run('corsa.physics.speedKmh')).toFixed(0)} km/h`);
  check('automatic upshift', (await run('corsa.physics.currentGear')) >= 2);
  const x0 = await run('corsa.physics.position.x');
  await key('keydown', 'KeyD');
  check('steering right moves right (-X)', await until(`corsa.physics.position.x < ${x0} - 1.5`, 30000));
  await key('keyup', 'KeyD');
  await key('keyup', 'KeyW');
  await key('keydown', 'KeyS');
  check('brakes to a stop then reverses', await until('corsa.physics.currentGear === 0 && corsa.physics.vx < -1', 240000));
  await key('keyup', 'KeyS');
  await shot('drive');

  console.log('cameras');
  for (const mode of ['hood', 'cockpit', 'orbit', 'chase']) {
    await tap('KeyC');
    check(`camera ${mode} renders`, (await run('corsa.renderer.cameraMode')) === mode && await waitFrames());
    if (mode === 'cockpit') await shot('cockpit');
  }

  console.log('garage');
  await tap('KeyG');
  check('garage opens in orbit view', await run("corsa.garageUI.visible && corsa.renderer.cameraMode === 'orbit'") && await waitFrames());
  for (const sel of ['.body-swatch[data-color="2563eb"]', '.rim-swatch[data-color="b08d3c"]', '.finish-btn[data-finish="iridescent"]', '.finish-btn[data-finish="matte"]', '.finish-btn[data-finish="gloss"]']) await click(sel);
  for (const wing of ['stealth', 'hyper', 'none', 'gt3']) {
    await click(`.wing-btn[data-wing="${wing}"]`);
    check(`wing ${wing}`, (await run('corsa.carModel.wingStyle')) === wing && await waitFrames(2));
  }
  await click('.tune-btn[data-hp="850"]');
  check('paint, rims and tune applied', await run('corsa.carModel.bodyColor === 0x2563eb && corsa.carModel.rimColor === 0xb08d3c && corsa.physics.engineHp === 850'));
  await shot('garage');
  await click('#garage-close-btn');
  check('garage closes, camera restored', await run("!corsa.garageUI.visible && corsa.renderer.cameraMode === 'chase'") && await waitFrames());

  console.log('transmission / pause / recover');
  await tap('KeyM');
  check('manual mode', (await run('corsa.physics.transmission')) === 'manual');
  await run('corsa.physics.currentGear = 1');
  await tap('KeyE');
  check('manual upshift', (await run('corsa.physics.currentGear')) === 2);
  await tap('KeyQ');
  check('manual downshift', (await run('corsa.physics.currentGear')) === 1);
  await tap('KeyM');
  await tap('KeyP');
  const tPaused = await run('corsa.physics.currentLapTime');
  await waitFrames(4);
  check('pause freezes the simulation', (await run('corsa.paused')) && (await run('corsa.physics.currentLapTime')) === tPaused);
  await tap('KeyP');
  await tap('KeyR');
  check('recover puts the car on the centreline', Math.abs(await run('corsa.physics.q.offset')) < 0.5);

  console.log('tracks and environment');
  for (const track of ['city', 'desert', 'apex']) {
    await click('#btn-track');
    await click(`.track-card[data-track="${track}"]`);
    check(`track ${track} loads`, (await run('corsa.trackBuilder.def.id')) === track && await waitFrames());
    check(`  time of day synced`, await run("document.querySelector('.tod-btn.active').dataset.tod === corsa.timeOfDay"));
    for (const tod of ['noon', 'sunset', 'midnight']) await click(`.tod-btn[data-tod="${tod}"]`);
    await click('.weather-btn[data-weather="rainy"]');
    check(`  rain on ${track}`, (await run('corsa.physics.weatherGrip')) < 1 && await waitFrames(2));
    await click('.weather-btn[data-weather="clear"]');
    await click('#track-select-close');
    check(`  menu closed`, !(await run('corsa.trackSelectUI.visible')));
  }
  await click('#btn-reset');
  await click('#btn-telemetry');
  await waitFrames(3);
  await shot('final');

  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
  ws.close();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  chrome.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
process.exit(failures ? 1 : 0);
