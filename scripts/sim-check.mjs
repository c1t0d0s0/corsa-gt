// Headless sanity check for track layouts and vehicle dynamics.
// Usage: node scripts/sim-check.mjs
import { TRACKS } from '../src/engine/track/TrackData.js';
import { TrackPath } from '../src/engine/track/TrackPath.js';
import { VehiclePhysics } from '../src/engine/Physics.js';
import { CAR_SPECS } from '../src/engine/CarSpecs.js';

// Every check runs once per car, each on its middle ("track spec") engine tune
let spec = CAR_SPECS.gt;
function makeCar() {
  const car = new VehiclePhysics();
  car.setCar(spec.physics);
  car.setEngineTune(spec.tunes[1]);
  return car;
}
import { RoadGenerator } from '../src/engine/endless/RoadGenerator.js';
import { EndlessPath } from '../src/engine/endless/EndlessPath.js';
import { NEIGHBOURS } from '../src/engine/endless/Biomes.js';

const DT = 1 / 120;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };
const idle = { steering: 0, throttle: 0, brake: 0, handbrake: 0 };

function checkLayout(path) {
  let maxCurv = 0;
  for (let i = 0; i < path.n; i++) maxCurv = Math.max(maxCurv, Math.abs(path.curv[i]));
  // Closest approach between two different parts of the circuit
  let minSep = Infinity;
  const gap = Math.ceil((path.wallOffset * 2 * Math.PI) / path.ds) + 40;
  for (let i = 0; i < path.n; i += 3) {
    for (let j = i + gap; j < path.n; j += 3) {
      if (path.n - j + i < gap) continue;
      const d = Math.hypot(path.px[i] - path.px[j], path.pz[i] - path.pz[j]);
      if (d < minSep) minSep = d;
    }
  }
  const minRadius = 1 / maxCurv;
  console.log(`  length ${path.length.toFixed(0)}m  min radius ${minRadius.toFixed(1)}m  min separation ${minSep.toFixed(1)}m (walls need ${(path.wallOffset * 2).toFixed(1)}m)`);
  if (minRadius < path.wallOffset + 4) fail('corner tighter than the track is wide');
  if (minSep < path.wallOffset * 2 + 4) fail('track sections overlap');
}

function runLaps(path, { mode, weather, driver, laps = 2 }) {
  const car = makeCar();
  car.setDrivingMode(mode);
  car.setWeather(weather);
  car.setTrack(path);
  car.autopilot = driver === 'autopilot';
  const input = driver === 'autopilot' ? idle : { steering: 0, throttle: 1, brake: 0, handbrake: 0 };
  let maxOff = 0, maxKmh = 0, wallHits = 0, t = 0;
  const limit = 600;
  while (car.currentLap <= laps && t < limit) {
    car.step(input, DT);
    t += DT;
    if (!Number.isFinite(car.position.x + car.position.z + car.vx + car.vy + car.yawRate + car.heading)) {
      fail(`${mode}/${weather}/${driver}: NaN at t=${t.toFixed(1)}`);
      return;
    }
    maxOff = Math.max(maxOff, Math.abs(car.q.offset));
    maxKmh = Math.max(maxKmh, car.speedKmh);
    if (car.wallHit > 1) wallHits++;
    if (Math.abs(car.q.offset) > path.wallOffset) { fail(`${mode}/${weather}/${driver}: through the wall`); return; }
  }
  const tag = `${mode}/${weather}/${driver}`.padEnd(24);
  const best = car.bestLapTime;
  console.log(`  ${tag} best ${best ? best.toFixed(2) + 's' : '--'}  vmax ${maxKmh.toFixed(0)}km/h  max offset ${maxOff.toFixed(1)}m  wall frames ${wallHits}`);
  if (car.currentLap <= laps) fail(`${tag} did not finish ${laps} laps in ${limit}s`);
  if (maxOff > path.halfWidth + 1.5) fail(`${tag} left the road`);
}

/**
 * A stand-in for someone driving on the keyboard: every control is fully on or
 * off, ramped the way InputManager ramps key presses, with no assists beyond
 * what the chosen mode provides.
 */
function runKeyboardLaps(path, { mode, weather, laps = 2 }) {
  const car = makeCar();
  car.setDrivingMode(mode);
  car.setWeather(weather);
  car.setTrack(path);
  const input = { steering: 0, throttle: 0, brake: 0, handbrake: 0 };
  const ramp = (v, target, rate) => (Math.abs(target - v) <= rate * DT ? target : v + Math.sign(target - v) * rate * DT);
  let t = 0, wallHits = 0, maxOff = 0, maxSlide = 0;
  while (car.currentLap <= laps && t < 900) {
    const mu = car.tyreMu * car.weatherGrip;
    const v = Math.abs(car.vx);
    const lock = Math.min(0.56, Math.atan((2.6 * 1.55 * mu * 9.81) / Math.max(v * v, 1)) + 0.012);
    const want = Math.max(-1, Math.min(1, -car.lineSteer() / lock));
    const key = Math.abs(want - input.steering) > 0.18 ? Math.sign(want - input.steering) : 0;
    input.steering = ramp(input.steering, key, key === 0 ? 5.5 : 3.2);
    const vSafe = car.safeSpeedAhead(mu, 0.6, 0.55);
    input.throttle = ramp(input.throttle, car.vx < vSafe - 2 ? 1 : 0, 6);
    input.brake = ramp(input.brake, car.vx > vSafe + 1 ? 1 : 0, 7);
    const wasHit = car.wallHit > 1;
    car.step(input, DT);
    t += DT;
    if (car.wallHit > 1 && !wasHit) wallHits++;
    maxOff = Math.max(maxOff, Math.abs(car.q.offset));
    if (car.vx > 8) maxSlide = Math.max(maxSlide, Math.abs(Math.atan2(car.vy, car.vx)));
  }
  const tag = `${mode}/${weather}/keyboard`.padEnd(24);
  console.log(`  ${tag} best ${car.bestLapTime ? car.bestLapTime.toFixed(2) + 's' : '--'}  max offset ${maxOff.toFixed(1)}m  max slide ${(maxSlide * 57.3).toFixed(0)}deg  wall hits ${wallHits}`);
  if (car.currentLap <= laps) fail(`${tag} did not finish`);
  if (wallHits > 0) fail(`${tag} hit the wall ${wallHits} times`);
  if (maxSlide > 0.6) fail(`${tag} spun`);
  if (maxOff > path.halfWidth + 1.5) fail(`${tag} left the road`);
}

function benchmarks(path) {
  for (const mode of ['easy', 'normal']) {
    const car = makeCar();
    car.setDrivingMode(mode);
    car.setTrack(path);
    let t = 0;
    while (car.speedKmh < 100 && t < 20) { car.step({ steering: 0, throttle: 1, brake: 0, handbrake: 0 }, DT); t += DT; }
    const x0 = car.position.z;
    let tb = 0;
    while (car.speedKmh > 0.5 && tb < 20) { car.step({ steering: 0, throttle: 0, brake: 1, handbrake: 0 }, DT); tb += DT; }
    console.log(`  ${mode}: 0-100 ${t.toFixed(2)}s, 100-0 ${(car.position.z - x0).toFixed(1)}m, top speed est ${car.estimateTopSpeedKmh().toFixed(0)}km/h`);
    if (t > 7) fail(`${mode} 0-100 too slow`);
    // Standing still with no input must stay still
    for (let i = 0; i < 240; i++) car.step(idle, DT);
    if (car.speedKmh > 0.1) fail(`${mode} creeps at rest (${car.speedKmh.toFixed(2)}km/h)`);
  }
  // Steering sign: steering right from +Z heading must move towards -X
  const car = makeCar();
  car.setDrivingMode('normal');
  car.setTrack(path);
  for (let i = 0; i < 360; i++) car.step({ steering: 1, throttle: 0.5, brake: 0, handbrake: 0 }, DT);
  if (!(car.position.x < -0.5)) fail(`steer right went to x=${car.position.x.toFixed(2)}`);
  // Panic input at speed must not spin the car: flat out, then full lock
  for (const mode of ['easy', 'normal']) {
    const c = makeCar();
    c.setDrivingMode(mode);
    c.setTrack(path);
    while (c.speedKmh < 150) c.step({ steering: 0, throttle: 1, brake: 0, handbrake: 0 }, DT);
    let slide = 0;
    for (let i = 0; i < 180; i++) {
      c.step({ steering: 1, throttle: 1, brake: 0, handbrake: 0 }, DT);
      if (c.vx > 8) slide = Math.max(slide, Math.abs(Math.atan2(c.vy, c.vx)));
    }
    console.log(`  ${mode}: full lock at 150km/h → max slide ${(slide * 57.3).toFixed(0)}deg`);
    if (slide > 0.45) fail(`${mode} spins on full lock at speed`);
  }
  // Reverse: holding brake from rest backs up
  const rev = makeCar();
  rev.setTrack(path);
  const z0 = rev.position.z;
  for (let i = 0; i < 360; i++) rev.step({ steering: 0, throttle: 0, brake: 1, handbrake: 0 }, DT);
  if (!(rev.position.z < z0 - 3) || rev.currentGear !== 0) fail('reverse does not engage');
}

for (spec of Object.values(CAR_SPECS)) {
  for (const def of Object.values(TRACKS)) {
    console.log(`\n== ${def.name} / ${spec.name}`);
    const path = new TrackPath(def);
    if (spec.id === 'gt') checkLayout(path);
    for (const weather of ['clear', 'rainy']) {
      for (const mode of ['easy', 'normal']) runLaps(path, { mode, weather, driver: 'autopilot' });
      runLaps(path, { mode: 'easy', weather, driver: 'throttle-only' });
      for (const mode of ['easy', 'normal']) runKeyboardLaps(path, { mode, weather });
    }
    if (def.id === 'apex') benchmarks(path);
  }
}
spec = CAR_SPECS.gt;

/** The generated road: deterministic, never crossing itself, within its curvature and grade limits. */
function checkEndlessLayout(seed, km) {
  const gen = new RoadGenerator(seed);
  const n = km * 1000;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  let maxCurv = 0, maxGrade = 0, hash = 0;
  for (let i = 0; i < n; i++) {
    const smp = gen.next();
    xs[i] = smp.x;
    zs[i] = smp.z;
    maxCurv = Math.max(maxCurv, Math.abs(smp.curv));
    maxGrade = Math.max(maxGrade, Math.abs(smp.slope));
    hash = (Math.imul(hash, 31) + Math.round(smp.x * 10) + Math.round(smp.y * 10) * 7 + Math.round(smp.z * 10) * 13) | 0;
  }
  // Closest approach between parts of the road at least 500 m apart along it
  const cell = 60;
  const grid = new Map();
  for (let i = 0; i < n; i += 4) {
    const key = `${Math.floor(xs[i] / cell)},${Math.floor(zs[i] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  let minSep = Infinity;
  for (let i = 0; i < n; i += 4) {
    const gx = Math.floor(xs[i] / cell);
    const gz = Math.floor(zs[i] / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gz + b}`) || []) {
        if (Math.abs(i - j) < 500) continue;
        minSep = Math.min(minSep, Math.hypot(xs[i] - xs[j], zs[i] - zs[j]));
      }
    }
  }
  const segs = gen.schedule.segments.filter((sg) => sg.start < n);
  const badStep = segs.find((sg, i) => i > 0 && !NEIGHBOURS[segs[i - 1].biome].includes(sg.biome));
  console.log(`  seed "${seed}": ${km}km  min radius ${(1 / maxCurv).toFixed(0)}m  max grade ${(maxGrade * 100).toFixed(1)}%  min separation ${minSep === Infinity ? '>60' : minSep.toFixed(0)}m`);
  console.log(`    ${segs.map((sg) => `${sg.biome} ${((sg.end - sg.start) / 1000).toFixed(1)}km`).join(' → ')}`);
  if (1 / maxCurv < 55) fail(`endless "${seed}": bend tighter than 55 m`);
  if (maxGrade > 0.105) fail(`endless "${seed}": grade over 10%`);
  if (minSep < 60) fail(`endless "${seed}": road comes back within ${minSep.toFixed(0)} m of itself`);
  if (badStep) fail(`endless "${seed}": ${badStep.prev} borders ${badStep.biome}`);
  return hash;
}

/**
 * The endless road's terrain is fixed by the seed: sampling the same spots
 * again after driving on (road added ahead, old road dropped behind) must
 * give the same ground, or coastlines and hills visibly shift as tiles rebuild.
 */
function checkEndlessTerrain(seed) {
  const path = new EndlessPath(seed);
  const gen = path.generator;
  const height = (x, z) => { const t = path.terrainQuery(x, z, {}); return gen.groundHeight(x, z, t, gen.paramsCached(t.sAbs)); };
  const driveTo = (abs) => { for (let a = Math.max(path.startS, abs - 2000); a <= abs; a += 100) { while (path.head <= a) path.extendTo(path.head + 256); path.update(a % path.n); } };
  let worst = 0, total = 0;
  for (let c = 4000; c <= 30000; c += 6500) {
    driveTo(c);
    const [cx, cz] = [path.dx[c % path.n], path.dz[c % path.n]];
    const pts = [];
    for (let x = -2200; x <= 2200; x += 150) for (let z = -2200; z <= 2200; z += 150) if (Math.hypot(x, z) < 2200) pts.push([cx + x, cz + z]);
    const before = pts.map(([x, z]) => height(x, z));
    driveTo(c + 1000);
    const [nx, nz] = [path.dx[(c + 1000) % path.n], path.dz[(c + 1000) % path.n]];
    pts.forEach(([x, z], i) => {
      if (Math.hypot(x - nx, z - nz) > 2200) return; // only what is still in view
      total++;
      worst = Math.max(worst, Math.abs(height(x, z) - before[i]));
    });
  }
  console.log(`  terrain "${seed}": ${total} spots re-sampled after driving on, worst change ${worst.toFixed(3)}m`);
  if (worst > 0.001) fail(`endless "${seed}": terrain shifts as the road streams (${worst.toFixed(2)} m)`);
}

/** Autopilot cruising the endless road: stays in its lane at a relaxed pace. */
function runEndless(seed, km, weather) {
  const path = new EndlessPath(seed);
  const car = makeCar();
  car.setWeather(weather);
  car.setTrack(path);
  car.autopilot = true;
  let t = 0, maxErr = 0, recovers = 0, maxKmh = 0;
  while (car.totalDistance < km * 1000 && t < km * 120) {
    car.step(idle, DT);
    t += DT;
    if (car.needsRecover) { recovers++; car.recover(); }
    if (car.totalDistance > 200) maxErr = Math.max(maxErr, Math.abs(car.q.offset - car.laneOffset));
    maxKmh = Math.max(maxKmh, car.speedKmh);
  }
  const avg = (car.totalDistance / t) * 3.6;
  console.log(`  autopilot "${seed}" ${weather}: ${(car.totalDistance / 1000).toFixed(1)}km  avg ${avg.toFixed(0)}km/h  vmax ${maxKmh.toFixed(0)}km/h  max lane error ${maxErr.toFixed(2)}m  recovers ${recovers}`);
  if (car.totalDistance < km * 1000) fail(`autopilot "${seed}" did not cover ${km} km`);
  if (recovers > 0) fail(`autopilot "${seed}" left the road`);
  if (maxErr > path.halfWidth / 2) fail(`autopilot "${seed}" wandered out of its lane`);
  if (maxKmh > 100) fail(`autopilot "${seed}" cruised too fast`);
}

console.log('\n== ENDLESS ROAD');
const hashes = ['alpha', 'alpha', 'pine-4821', 'coast'].map((seed) => checkEndlessLayout(seed, 50));
if (hashes[0] !== hashes[1]) fail('endless: same seed gave a different road');
if (hashes[0] === hashes[2]) fail('endless: different seeds gave the same road');
for (const seed of ['alpha', 'coast']) checkEndlessTerrain(seed);
for (const seed of ['alpha', 'pine-4821']) runEndless(seed, 20, 'clear');
runEndless('coast', 10, 'rainy');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
