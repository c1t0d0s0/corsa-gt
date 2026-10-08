// Renders the engine sound offline in headless Chromium and checks that it is
// pitched to the revs, gets louder and brighter under load, and never clips.
// Usage: start `npm run dev`, then `node scripts/audio-check.mjs [url]`
import { openBrowser, reporter } from './cdp.mjs';

const url = process.argv[2] || 'http://localhost:3000/';
const report = reporter();
const { check } = report;
let browser;

// Runs in the page: render one steady state and measure it
const measure = `async (state) => {
  const { AudioEngine } = await import('/src/engine/AudioEngine.js');
  const rate = 44100, seconds = 1.5;
  const ctx = new OfflineAudioContext(1, rate * seconds, rate);
  const audio = new AudioEngine();
  audio.init(ctx);
  for (let i = 0; i < 60; i++) audio.update({ maxRpm: 8200, slip: 0, speedKmh: 0, surface: 'asphalt', wet: false, wallHit: 0, cut: false, running: true, ...state }, 1 / 60);
  const data = (await ctx.startRendering()).getChannelData(0).subarray(rate * 0.5); // skip the fade-in
  let peak = 0, sum = 0;
  for (const v of data) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  // Magnitude at one frequency (Goertzel-style correlation)
  const mag = (hz) => { let re = 0, im = 0; for (let i = 0; i < data.length; i++) { const p = 2 * Math.PI * hz * i / rate; re += data[i] * Math.cos(p); im += data[i] * Math.sin(p); } return Math.hypot(re, im) / data.length; };
  const firing = state.rpm / 60 * 3;
  // RMS frequency: where the energy sits on average, as a measure of brightness
  let d = 0; for (let i = 1; i < data.length; i++) d += (data[i] - data[i - 1]) ** 2;
  return { peak, rms: Math.sqrt(sum / data.length), firing: mag(firing), offPitch: Math.max(mag(firing * 0.87), mag(firing * 1.13)), bright: Math.sqrt(d / sum) * rate / (2 * Math.PI) };
}`;

try {
  browser = await openBrowser({});
  const { send, run, until, problems } = browser;
  await send('Page.navigate', { url });
  await until('!!window.corsa', 60000);
  const render = (state) => run(`(${measure})(${JSON.stringify(state)})`);
  const fmt = (m) => `peak ${m.peak.toFixed(2)} rms ${m.rms.toFixed(3)} centre ${m.bright.toFixed(0)} Hz`;

  const results = {};
  for (const rpm of [1000, 3000, 5500, 8000]) {
    for (const throttle of [0, 1]) {
      const m = await render({ rpm, throttle, speedKmh: rpm / 40 });
      results[`${rpm}/${throttle}`] = m;
      console.log(`  ${String(rpm).padStart(4)} rpm, throttle ${throttle}: ${fmt(m)}`);
      check(`    audible, no clipping`, m.rms > 0.01 && m.peak < 0.98);
      check(`    pitched at the firing frequency (${(rpm / 20).toFixed(0)} Hz)`, m.firing > m.offPitch * 2.5, `${(m.firing / m.offPitch).toFixed(1)}x neighbours`);
    }
  }
  check('louder on throttle than off', [3000, 5500, 8000].every((r) => results[`${r}/1`].rms > results[`${r}/0`].rms * 1.5));
  check('brighter on throttle than off', [3000, 5500, 8000].every((r) => results[`${r}/1`].bright > results[`${r}/0`].bright));
  check('louder at high revs than at idle', results['8000/1'].rms > results['1000/1'].rms * 1.3);

  const quiet = await render({ rpm: 1000, throttle: 0 });
  const squeal = await render({ rpm: 1000, throttle: 0, slip: 1.2, speedKmh: 80 });
  const wind = await render({ rpm: 1000, throttle: 0, speedKmh: 250 });
  check('tyre squeal adds sound', squeal.rms > quiet.rms * 1.3, `${(squeal.rms / quiet.rms).toFixed(1)}x`);
  check('wind adds sound at speed', wind.rms > quiet.rms * 1.3, `${(wind.rms / quiet.rms).toFixed(1)}x`);
  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  report.fail();
} finally {
  if (browser) browser.close();
}
console.log(report.failures ? `\n${report.failures} check(s) failed` : '\nAll audio checks passed');
process.exit(report.failures ? 1 : 0);
