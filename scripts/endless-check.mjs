// Drives the endless road in headless Chromium: streaming stays bounded,
// seeds reproduce the same road, the seed UI and autodrive work.
// Usage: start `npm run dev`, then `node scripts/endless-check.mjs [url] [screenshotDir]`
import { openBrowser, reporter } from './cdp.mjs';

const url = process.argv[2] || 'http://localhost:3000/';
const report = reporter();
const { check } = report;
let browser;

// Fingerprint of the first stretch of road, to compare seeds
const roadHash = `(() => { const t = corsa.physics.track; let h = 0; for (let k = 0; k < 600; k++) h = (Math.imul(h, 31) + Math.round(t.dx[k] * 10) + Math.round(t.py[k] * 10) * 7) | 0; return h; })()`;
// Advance the simulation and the streaming as if `metres` were driven on autodrive
const drive = (metres) => `(() => {
  const p = corsa.physics;
  const input = { steering: 0, throttle: 0, brake: 0, handbrake: 0 };
  const goal = p.totalDistance + ${metres};
  let recovers = 0;
  for (let f = 0; f < 60 * 400 && p.totalDistance < goal; f++) {
    for (let k = 0; k < 2; k++) p.step(input, 1 / 120);
    if (p.needsRecover) { recovers++; p.recover(); }
    corsa.trackBuilder.update(p.position, 1 / 60);
  }
  const w = corsa.trackBuilder.world;
  return { km: p.totalDistance / 1000, recovers, tiles: w.tiles.size, chunks: w.roadChunks.size, geometries: corsa.renderer.renderer.info.memory.geometries };
})()`;

try {
  browser = await openBrowser({ shotDir: process.argv[3] || null });
  const { send, run, until, waitFrames, shot, problems } = browser;
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);

  await send('Page.navigate', { url: `${url}?lang=en&autostart=1&autopilot=1&track=endless&seed=test` });
  check('endless road boots', await until("!!(window.corsa && corsa.started && corsa.trackBuilder.def.id === 'endless')", 180000));
  check('renders frames', await waitFrames());
  check('HUD shows the seed and the landscape', await run("document.getElementById('hud-lap-best').textContent === 'test' && document.getElementById('hud-lap-num').textContent.length > 1"));
  check('autodrive on from the URL', await run("corsa.physics.autopilot && document.getElementById('btn-auto').classList.contains('active')"));
  check('quiet EV sound on the endless road', await run("corsa.audio.ev && document.querySelector('.sound-btn[data-sound=\"ev\"]').classList.contains('active')"));
  const hashTest = await run(roadHash);
  await shot('endless-start');

  console.log('streaming');
  const a = await run(drive(3000));
  check('autodrive covers 3 km without leaving the road', a.km >= 3 && a.recovers === 0, `${a.km.toFixed(1)} km, ${a.recovers} recovers`);
  const b = await run(drive(3000));
  check('world stays bounded while driving', b.tiles < 400 && b.chunks < 40 && b.geometries < a.geometries * 1.5 + 50, `tiles ${b.tiles}, chunks ${b.chunks}, geometries ${a.geometries} → ${b.geometries}`);
  await waitFrames(3);
  await shot('endless-6km');

  console.log('seeds');
  await click('#btn-track');
  await click('.sound-btn[data-sound="engine"]'); // picked in the garage: should survive a new seed
  await run("document.getElementById('seed-input').value = 'test'");
  await click('#seed-go');
  check('same seed, same road', (await run(roadHash)) === hashTest && (await run('corsa.physics.totalDistance')) < 1);
  check('  keeps the sound picked in the garage', !(await run('corsa.audio.ev')));
  await click('#seed-random');
  const randomSeed = await run('corsa.physics.track.seed');
  check('random seed loads a different road', randomSeed !== 'test' && (await run(roadHash)) !== hashTest, randomSeed);
  check('  and fills in the seed box', (await run("document.getElementById('seed-input').value")) === randomSeed);
  const hashRandom = await run(roadHash);
  await run(drive(400));
  await click('#btn-reset');
  check('restart starts the same road over', (await run(roadHash)) === hashRandom && (await run('corsa.physics.totalDistance')) < 1);
  await click('#btn-track');
  // Typing into the seed box must not drive the car or switch the camera
  const cam = await run('corsa.renderer.cameraMode');
  await run("document.getElementById('seed-input').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', bubbles: true }))");
  check('typing a seed leaves the hotkeys alone', (await run('corsa.renderer.cameraMode')) === cam);
  await click('#track-select-close');

  console.log('autodrive and recovery');
  await click('#btn-auto');
  check('autodrive button toggles off', !(await run('corsa.physics.autopilot')));
  await run("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }))");
  check('O key toggles it back on', await run('corsa.physics.autopilot'));
  // Shove the car far off the road: it should be put back on it
  await run('(() => { const p = corsa.physics; p.position.x += 60; p.prevPosition.copy(p.position); })()');
  check('strayed car is brought back to the road', await until('Math.abs(corsa.physics.q.offset) < 3', 30000));

  console.log('circuits still load');
  await click('#btn-track');
  await click('.track-card[data-track="apex"]');
  check('back to a circuit', (await run("corsa.trackBuilder.def.id === 'apex' && !corsa.trackBuilder.world")) && await waitFrames());
  check('  lap HUD restored', await run("document.getElementById('hud-lap-num').textContent.startsWith('LAP')"));
  await click('.track-card[data-track="endless"]');
  check('back on the endless road: EV sound again', await run("corsa.trackBuilder.def.id === 'endless' && corsa.audio.ev"));
  await click('.track-card[data-track="desert"]');
  check('on a circuit: engine sound', await run("corsa.trackBuilder.def.id === 'desert' && !corsa.audio.ev"));
  await click('#track-select-close');

  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  report.fail();
} finally {
  if (browser) browser.close();
}
console.log(report.failures ? `\n${report.failures} check(s) failed` : '\nAll endless-road checks passed');
process.exit(report.failures ? 1 : 0);
