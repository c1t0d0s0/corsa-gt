// Emulates a phone (touch, landscape and portrait) and checks the mobile
// layout and on-screen controls with real multi-touch input.
// Usage: start `npm run dev`, then `node scripts/mobile-check.mjs [url] [screenshotDir]`
import { openBrowser, reporter, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://localhost:3000/';
const report = reporter();
const { check } = report;
let browser;

const HUD_PARTS = ['.top-nav', '.hud-lap-box', '.hud-minimap-box', '.hud-center-cluster', '#touch-steer', '.touch-right'];

try {
  browser = await openBrowser({ shotDir: process.argv[3] || null });
  const { send, run, waitFrames, until, shot, problems } = browser;

  const device = (width, height) => send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: true,
    screenOrientation: width > height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 }
  });
  const centre = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })) });
  const tapOn = async (selector) => {
    const c = await centre(selector);
    await touch('touchStart', [{ ...c, id: 9 }]);
    await touch('touchEnd', []);
    await sleep(150);
  };
  // Every HUD block on screen, none overlapping another
  const layoutProblems = () => run(`(() => {
    const parts = ${JSON.stringify(HUD_PARTS)}.map((s) => ({ s, r: document.querySelector(s).getBoundingClientRect() }));
    const out = [];
    for (const p of parts) {
      if (p.r.width === 0) out.push(p.s + ' hidden');
      if (p.r.left < 0 || p.r.top < 0 || p.r.right > innerWidth + 0.5 || p.r.bottom > innerHeight + 0.5) out.push(p.s + ' off-screen');
    }
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i].r, b = parts[j].r;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(parts[i].s + ' overlaps ' + parts[j].s);
    }
    return out;
  })()`);

  await device(844, 390);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  check('app boots', await until('!!(window.corsa && corsa.physics.track)', 60000));
  check('touch device detected, mobile render settings', await run("document.body.classList.contains('touch') && corsa.renderer.mobile"));
  check('touch hints replace keyboard hints', await run("getComputedStyle(document.querySelector('.touch-hints')).display !== 'none' && getComputedStyle(document.querySelector('.key-hints')).display === 'none'"));
  check('title screen fits without scrolling or clipping', await run("['.title-wordmark', '#start-btn', '.touch-hints'].every((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })"));
  await shot('m-start');

  console.log('landscape 844x390');
  await tapOn('#start-btn');
  check('tap starts the game', await run('corsa.started'));
  await waitFrames();
  let issues = await layoutProblems();
  check('HUD and controls fit without overlapping', issues.length === 0, issues.join('; '));

  check('telemetry is not offered on a phone', await run("getComputedStyle(document.getElementById('btn-telemetry')).display === 'none'"));
  await run("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', bubbles: true }))");
  check('and cannot be opened', await run("!corsa.telemetryUI.visible && getComputedStyle(document.getElementById('telemetry-panel')).display === 'none'"));

  const gas = await centre('#touch-accel-btn');
  const pad = await centre('#touch-steer');
  await touch('touchStart', [{ ...gas, id: 1 }]);
  check('GAS accelerates', await until('corsa.physics.speedKmh > 40', 240000));
  // Second finger steers while the first stays on the throttle
  await touch('touchStart', [{ ...gas, id: 1 }, { ...pad, id: 2 }]);
  await touch('touchMove', [{ ...gas, id: 1 }, { x: pad.x + 40, y: pad.y, id: 2 }]);
  check('steering pad is analog, throttle still held', await until('corsa.input.steering > 0.3 && corsa.input.steering < 0.95 && corsa.input.throttle > 0.9', 30000),
    `steer ${(await run('corsa.input.steering')).toFixed(2)}`);
  await shot('m-drive');
  await touch('touchMove', [{ ...gas, id: 1 }, { x: pad.x - 200, y: pad.y, id: 2 }]);
  check('full lock the other way', await until('corsa.input.steering < -0.95', 30000));
  // touchEnd names the fingers being lifted: steering thumb first, throttle stays down
  await touch('touchEnd', [{ x: pad.x - 200, y: pad.y, id: 2 }]);
  check('steering centres on release, throttle unaffected', await until('corsa.input.steering === 0 && !corsa.input.touchSteerActive', 30000) && await run('corsa.input.touchThrottle === 1'));
  await touch('touchEnd', []);
  check('throttle released', await until('corsa.input.throttle === 0', 30000));

  const brake = await centre('#touch-brake-btn');
  await touch('touchStart', [{ ...brake, id: 1 }]);
  check('BRAKE slows the car', await until('corsa.physics.speedKmh < 15', 240000));
  await touch('touchEnd', []);
  await tapOn('#touch-recover-btn');
  check('recover button', Math.abs(await run('corsa.physics.q.offset')) < 0.5);

  await tapOn('#btn-garage');
  check('garage opens beside the car', await run("corsa.garageUI.visible && document.querySelector('#garage-panel .modal-card').getBoundingClientRect().bottom <= innerHeight") && await waitFrames());
  await shot('m-garage');
  await tapOn('#garage-close-btn');
  await tapOn('#btn-track');
  check('track menu fits', await run("corsa.trackSelectUI.visible && document.querySelector('#track-select-modal .modal-card').getBoundingClientRect().bottom <= innerHeight"));
  await shot('m-tracks');
  await tapOn('.track-card[data-track="city"]');
  check('track switch by tap', (await run('corsa.trackBuilder.def.id')) === 'city' && await waitFrames());
  await tapOn('#track-select-close');
  await waitFrames();
  await shot('m-city');

  console.log('small phone 667x375');
  await device(667, 375);
  await waitFrames();
  issues = await layoutProblems();
  check('HUD and controls fit without overlapping', issues.length === 0, issues.join('; '));
  check('canvas follows the viewport', await run('corsa.renderer.renderer.domElement.clientWidth === innerWidth && corsa.renderer.renderer.domElement.clientHeight === innerHeight'));
  await shot('m-small');

  console.log('portrait 390x844');
  await device(390, 844);
  await waitFrames();
  check('rotate prompt shown', await run("getComputedStyle(document.getElementById('rotate-overlay')).display === 'flex'"));
  const t0 = await run('corsa.physics.currentLapTime + corsa.physics.position.z');
  await waitFrames(4);
  check('game waits while upright', (await run('corsa.physics.currentLapTime + corsa.physics.position.z')) === t0);
  await shot('m-portrait');
  await device(844, 390);
  await waitFrames();
  check('prompt clears in landscape', await run("getComputedStyle(document.getElementById('rotate-overlay')).display === 'none'"));

  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  report.fail();
} finally {
  if (browser) browser.close();
}
console.log(report.failures ? `\n${report.failures} check(s) failed` : '\nAll mobile checks passed');
process.exit(report.failures ? 1 : 0);
