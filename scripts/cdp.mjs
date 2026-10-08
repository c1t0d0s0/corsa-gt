// Minimal Chrome DevTools Protocol driver shared by the browser checks.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chromium (software GL) and attach to its first page. */
export async function openBrowser({ port = 9333, shotDir = null } = {}) {
  const chrome = spawn(process.env.CHROME || 'chromium', [
    '--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--window-size=1280,720', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', // scripted clicks don't count as gestures; let audio run
    `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(500);
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null);
  }
  if (!targets) { chrome.kill(); throw new Error('Chromium did not start'); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const pending = new Map();
  const problems = [];
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
  const close = () => { ws.close(); chrome.kill(); };

  await send('Runtime.enable');
  await send('Page.enable');
  return { send, run, frames, waitFrames, until, shot, problems, close };
}

/** Tally of pass/fail lines for a check script. */
export function reporter() {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failures++;
  };
  return { check, fail: () => { failures++; }, get failures() { return failures; } };
}
