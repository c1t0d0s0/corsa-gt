import { mulberry32, fbm } from '../ProceduralTextures.js';
import { BiomeSchedule, hashSeed } from './Biomes.js';

export const ROAD_HALF_WIDTH = 4; // two 3.5 m lanes plus edge lines
export const SEA_LEVEL = 0;
export const RIVER_DEPTH = 3.4; // channel depth below the banks

const LOOKAHEAD = 220; // metres of terrain the road's grade looks ahead at
const EASE = 40; // half-window of the curvature moving average
const MAX_DEVIATION = 1.3; // rad either side of the overall direction; keeps the road from doubling back
const VERTICAL_RATE = 1 / 1600; // grade change per metre: crests and dips ~1.6 km in radius

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Lays out the endless road a metre at a time from a seed. Same seed, same
 * road: everything comes from one sequential PRNG and from noise in world
 * coordinates, never from timing.
 *
 * Plan view: straights and arcs drawn from the local biome, eased into each
 * other with a moving average of curvature (as TrackData's `layout` does for
 * circuits). Headings stay within MAX_DEVIATION of one overall direction, so
 * the road always makes progress and can never cross itself.
 *
 * Profile: the road follows the terrain ahead with a limited grade and a
 * limited change of grade, so climbs, crests and dips flow like a real road
 * and the terrain is cut or filled where they disagree.
 */
export class RoadGenerator {
  constructor(seedText) {
    this.seedText = String(seedText);
    this.seed = hashSeed(seedText);
    this.noiseSeed = (this.seed % 9973) + 1;
    this.rand = mulberry32(this.seed);
    this.schedule = new BiomeSchedule(this.seed);
    this.direction = this.rand() * Math.PI * 2;
    this._p = {};
    this.paramCache = new Map();

    // Plan view state
    this.raw = []; // planned per-metre curvature not yet consumed
    this.rawHeading = this.direction; // heading at the end of everything planned
    this.window = new Array(EASE * 2 + 1).fill(0); // raw curvature around the current metre
    this.windowSum = 0;
    this.planS = 0;
    this.x = 0;
    this.z = 0;
    this.heading = this.direction;
    this.plan = []; // plan-view points waiting for their elevation

    // Profile state
    this.targetSum = 0;
    this.y = null;
    this.grade = 0;
    this.s = 0; // index of the next sample handed out
    this.prev = null;

    for (let k = 0; k < EASE; k++) this.shiftWindow();
  }

  paramsAt(s, out = this._p) {
    return this.schedule.paramsAt(s, out);
  }

  /**
   * Landscape parameters at `s`, quantised to 2 m and cached: the world asks
   * for them at every terrain vertex and plant. The result is shared, so
   * don't modify it.
   */
  paramsCached(s) {
    const key = Math.round(s / 2);
    let p = this.paramCache.get(key);
    if (!p) {
      if (this.paramCache.size > 20000) this.paramCache.clear();
      p = this.schedule.paramsAt(key * 2, {});
      this.paramCache.set(key, p);
    }
    return p;
  }

  /** The overall heading drifts slowly so long stretches aren't all one way. */
  macroHeading(s) {
    return this.direction + (fbm(s / 7000 + 3, 0.5, 3, this.noiseSeed) - 0.5) * 1.6;
  }

  /** Plan the next straight or bend in the local style. */
  planSegment() {
    const s = this.planS + this.raw.length;
    const p = this.schedule.paramsAt(s, {});
    const r = this.rand;
    const range = ([a, b]) => a + r() * (b - a);
    if (r() < p.straightP) {
      const len = Math.round(range(p.straight));
      for (let i = 0; i < len; i++) this.raw.push(0);
      return;
    }
    const radius = range(p.radius);
    let turn = range(p.turn) * Math.PI / 180;
    // Lean back towards the overall direction, harder the further off it we are
    const off = wrapAngle(this.rawHeading - this.macroHeading(s));
    let sign = r() < 0.5 + clamp(off, -1, 1) * 0.45 ? -1 : 1;
    const dev = wrapAngle(this.rawHeading - this.direction);
    if (Math.abs(dev + sign * turn) > MAX_DEVIATION) {
      if (Math.abs(dev - sign * turn) <= MAX_DEVIATION) sign = -sign;
      else turn = Math.max(0, MAX_DEVIATION - Math.abs(dev)) * 0.9;
    }
    const n = Math.max(1, Math.round(turn * radius));
    for (let i = 0; i < n; i++) this.raw.push((sign * turn) / n);
    this.rawHeading += sign * turn;
  }

  shiftWindow() {
    if (this.raw.length === 0) this.planSegment();
    const k = this.raw.length ? this.raw.shift() : 0;
    this.windowSum += k - this.window.shift();
    this.window.push(k);
  }

  /** Next plan-view point: heading eased by the moving average. */
  stepPlan() {
    this.shiftWindow();
    const curv = this.windowSum / this.window.length;
    const s = this.planS++;
    const p = this.schedule.paramsAt(s, this._p);
    let target = this.naturalHeight(this.x, this.z, p, 0, s);
    // Never below the sea (mountain valleys can dip under it); by the coast stay up on the shoreline
    target = Math.max(target, 3);
    target = target + (Math.max(target, 6) - target) * p.sea;
    this.plan.push({ s, x: this.x, z: this.z, heading: this.heading, curv, target });
    this.targetSum += target;
    this.heading += curv;
    this.x += Math.sin(this.heading);
    this.z += Math.cos(this.heading);
  }

  /** Next road sample { s, x, y, z, heading, curv, slope } (1 m apart). */
  next() {
    while (this.plan.length < LOOKAHEAD) this.stepPlan();
    const pt = this.plan.shift();
    const ahead = this.targetSum / LOOKAHEAD;
    this.targetSum -= pt.target;
    const p = this.schedule.paramsAt(pt.s, this._p);
    if (this.y === null) this.y = ahead;
    const desired = clamp((ahead - this.y) / 140, -p.grade, p.grade);
    this.grade += clamp(desired - this.grade, -VERTICAL_RATE, VERTICAL_RATE);
    const sample = { s: this.s++, x: pt.x, y: this.y, z: pt.z, heading: pt.heading, curv: pt.curv, slope: this.grade };
    this.y += this.grade;
    return sample;
  }

  // --- Terrain ------------------------------------------------------------

  /**
   * Lateral offset of the river's centre from the road (left positive). As a
   * riverside stretch fades out the river swings away into the distance
   * rather than stopping.
   */
  riverOffset(s, p) {
    return p.riverSide * (33 + Math.sin(s / 210) * 7 + Math.sin(s / 77 + 1) * 4 + (1 - p.river) * 300);
  }

  /**
   * Untouched ground at (x, z), given the landscape at the nearest road
   * sample (`p`, at distance `s`) and the lateral offset from it.
   */
  naturalHeight(x, z, p, offset, s) {
    // Value-noise fbm bunches around 0.5; stretch it to use the full range
    const n = smoothstep(0.2, 0.8, fbm(x / p.scale + 31.7, z / p.scale + 17.3, 5, this.noiseSeed));
    let h = p.base + (n - 0.5) * 2 * p.amp;
    // Hills (or, in the mountains, ridged peaks) rise away from the road, which keeps to the valley floor
    const r = smoothstep(0.25, 0.75, fbm(x / 1300 + 5.1, z / 1300 + 9.7, 5, this.noiseSeed + 3));
    const ridged = (1 - Math.abs(r * 2 - 1)) ** 2;
    const valley = smoothstep(60, 700, Math.abs(offset));
    h += p.relief * (r + (ridged - r) * p.sharp) * valley;
    // The coast falls away under the sea on one side
    if (p.sea > 0) {
      const d = offset * p.seaSide;
      h -= p.sea * smoothstep(18, 160, d) * (h + 24);
    }
    return h;
  }

  /**
   * Final ground height: level with the road along it, blending into the
   * natural ground over the next ~50 m (cuttings and embankments), with the
   * river channel carved in.
   */
  groundHeight(x, z, roadY, offset, p, s, carve = true) {
    const n = this.naturalHeight(x, z, p, offset, s);
    const f = smoothstep(ROAD_HALF_WIDTH + 3, ROAD_HALF_WIDTH + 50, Math.abs(offset));
    let g = roadY - 0.06 + (n - roadY + 0.06) * f;
    if (carve && p.river > 0.02) {
      const d = Math.abs(offset - this.riverOffset(s, p));
      g -= RIVER_DEPTH * smoothstep(0.02, 0.2, p.river) * (1 - smoothstep(5, 13, d));
    }
    return g;
  }

  /** Whether a point at `offset` with ground height `ground` is under water. */
  inWater(offset, ground, p, s) {
    if (p.river > 0.3 && Math.abs(offset - this.riverOffset(s, p)) < 7) return true;
    return p.sea > 0.05 && ground < SEA_LEVEL - 0.3;
  }
}
