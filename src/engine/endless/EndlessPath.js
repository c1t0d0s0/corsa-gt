import * as THREE from 'three';
import { RoadGenerator, ROAD_HALF_WIDTH } from './RoadGenerator.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const CAPACITY = 16384; // metres of road held at once
const AHEAD = 3200; // keep at least this much generated in front of the car
const BEHIND = 1200; // never overwrite road this close behind the car
const START = 400; // the car starts this far along, so there is road behind it too
// Road is held for this far either side of the car along the overall direction:
// the scenery's reach (2.2 km) plus NEAR, so every terrain query finds the road it needs
const U_MARGIN = 2700;
const NEAR = 400; // the road counts as "near" a point within this distance
const RAIL_HOLD = 30; // a guardrail runs on this far past the hazard

export const ENDLESS_DEF = {
  id: 'endless',
  name: 'ENDLESS ROAD',
  theme: 'endless',
  defaultTod: 'noon',
  halfWidth: ROAD_HALF_WIDTH,
  runoff: 10,
  runoffSurface: 'grass',
  kerbs: false
};

/**
 * The endless road, as a drop-in for TrackPath: the same sample arrays and
 * queries, but stored in a ring buffer that the generator keeps topping up
 * ahead of the car while old road behind it is overwritten.
 *
 * Sample k (k metres from the start) lives in slot k % n, so all the
 * `(i + k) % n` look-ahead in Physics works unchanged, and `s` is the slot
 * position (it wraps every n metres). `sAbs[slot]` holds the real distance.
 * There are no walls: `endless` tells Physics to use `groundAt` and to bring
 * the car back when it strays too far instead.
 *
 * The road always heads within 75° of the generator's overall direction, so
 * its position `u` along that direction only ever increases: for any point
 * there is exactly one stretch of road "level with it". The terrain hangs off
 * that (see terrainQuery), never off whatever road happens to be held, so the
 * ground anywhere is fixed by the seed and doesn't shift as road is added
 * ahead and dropped behind.
 */
export class EndlessPath {
  constructor(seed) {
    this.def = ENDLESS_DEF;
    this.endless = true;
    this.halfWidth = ENDLESS_DEF.halfWidth;
    this.runoff = ENDLESS_DEF.runoff;
    this.wallOffset = this.halfWidth + this.runoff;
    this.recoverOffset = 18;

    this.generator = new RoadGenerator(seed);
    this.seed = this.generator.seedText;
    const n = CAPACITY;
    this.n = n;
    this.ds = 1;
    this.length = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.kerb = new Uint8Array(n);
    this.rail = new Uint8Array(n); // guardrail on the left (1) / right (2)
    this.railHold = [0, 0];
    this.sAbs = new Float64Array(n);
    // Position along / across the overall direction (left positive)
    const dir = this.generator.direction;
    this.axis = { ux: Math.sin(dir), uz: Math.cos(dir), vx: Math.cos(dir), vz: -Math.sin(dir) };
    this.dirU = new Float64Array(n);
    this.dirV = new Float64Array(n);
    // Positions in double precision: float32 loses centimetres tens of km out
    this.dx = new Float64Array(n);
    this.dz = new Float64Array(n);
    this.head = 0; // samples generated so far
    this._p = {};

    this.extendTo(START + AHEAD);
    this.startS = START % n;
    this.update(this.startS);
  }

  /** Generate road up to absolute distance `abs`. */
  extendTo(abs) {
    const g = this.generator;
    while (this.head < abs) {
      const smp = g.next();
      const i = smp.s % this.n;
      this.px[i] = smp.x;
      this.py[i] = smp.y;
      this.pz[i] = smp.z;
      this.dx[i] = smp.x;
      this.dz[i] = smp.z;
      this.heading[i] = smp.heading;
      this.tx[i] = Math.sin(smp.heading);
      this.tz[i] = Math.cos(smp.heading);
      this.slope[i] = smp.slope;
      this.curv[i] = smp.curv;
      this.sAbs[i] = smp.s;
      this.dirU[i] = smp.x * this.axis.ux + smp.z * this.axis.uz;
      this.dirV[i] = smp.x * this.axis.vx + smp.z * this.axis.vz;
      this.rail[i] = this.railsAt(smp);
      this.head++;
    }
  }

  /** Guardrails where the road runs along the sea, a river or a drop. */
  railsAt(smp) {
    const g = this.generator;
    const p = g.paramsAt(smp.s, this._p);
    let bits = 0;
    for (const [k, side] of [[0, 1], [1, -1]]) {
      const off = side * (this.halfWidth + 18);
      const x = smp.x + Math.cos(smp.heading) * off;
      const z = smp.z - Math.sin(smp.heading) * off;
      const drop = smp.y - g.groundHeight(x, z, { side: off, near: true, offset: off, y: smp.y, roadS: smp.s }, p);
      const hazard = (p.sea > 0.5 && side === p.seaSide) || (p.river > 0.5 && side === p.riverSide) || drop > 4;
      if (hazard) this.railHold[k] = RAIL_HOLD;
      if (this.railHold[k] > 0) {
        bits |= k + 1;
        this.railHold[k]--;
      }
    }
    return bits;
  }

  /** How far out the car can go before meeting a guardrail on that side. */
  railLimitAt(index, offset) {
    return this.rail[index] & (offset > 0 ? 1 : 2) ? this.halfWidth + 0.9 : Infinity;
  }

  /** Latest sample (absolute index) at or before position `u` along the overall direction. */
  absAtU(u) {
    let lo = this.tail;
    let hi = this.head - 1;
    if (u <= this.dirU[lo % this.n]) return lo;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.dirU[mid % this.n] <= u) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** The road level with (x, z): its distance and the point's sideways offset from it. */
  graphAt(x, z, out) {
    const n = this.n;
    const u = x * this.axis.ux + z * this.axis.uz;
    const v = x * this.axis.vx + z * this.axis.vz;
    const k = this.absAtU(u);
    const i = k % n;
    const j = Math.min(k + 1, this.head - 1) % n;
    const t = j === i ? 0 : Math.min(1, Math.max(0, (u - this.dirU[i]) / (this.dirU[j] - this.dirU[i])));
    out.sAbs = k + t;
    out.side = v - (this.dirV[i] + (this.dirV[j] - this.dirV[i]) * t);
    return u;
  }

  /**
   * Everything the terrain needs at a point, as a pure function of the seed:
   *  - sAbs, side: the road level with the point (landscape, which side the sea is)
   *  - near: whether the road passes within NEAR m; if so offset (true sideways
   *    distance), y (road height) and roadS of the closest road, for the road bed
   *    and the river. Only road level with the point ±NEAR can be that close, and
   *    update() keeps all of that held.
   */
  terrainQuery(x, z, out = {}) {
    const n = this.n;
    const u = this.graphAt(x, z, out);
    const lo = this.absAtU(u - NEAR);
    const hi = Math.min(this.head - 1, this.absAtU(u + NEAR) + 1);
    let best = lo;
    let bestD = Infinity;
    const test = (k) => {
      const i = k % n;
      const dx = x - this.dx[i];
      const dz = z - this.dz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = k; }
    };
    for (let k = lo; k <= hi; k += 4) test(k);
    const c = best;
    for (let k = Math.max(lo, c - 4); k <= Math.min(hi, c + 4); k++) test(k);
    out.near = bestD <= NEAR * NEAR;
    const i = best % n;
    if (out.near) {
      const dx = x - this.dx[i];
      const dz = z - this.dz[i];
      const along = Math.max(-1, Math.min(1, dx * this.tx[i] + dz * this.tz[i]));
      out.offset = dx * this.tz[i] - dz * this.tx[i];
      out.y = this.py[i] + this.slope[i] * along;
      out.roadS = best + along;
    } else {
      out.offset = out.side;
      out.y = this.py[i];
      out.roadS = out.sAbs;
    }
    out.index = i;
    return out;
  }

  /** Keep road held for the car's surroundings. Returns true if it grew. */
  update(index) {
    const carAbs = this.sAbs[index];
    const carU = this.dirU[index];
    // Hold road back to U_MARGIN behind (but always leave room to generate ahead)
    const keepFrom = Math.min(carAbs - BEHIND, Math.max(this.absAtU(carU - U_MARGIN), carAbs + AHEAD + 512 - this.n));
    const limit = keepFrom + this.n;
    let grew = false;
    while (this.head < limit && (this.head - carAbs < AHEAD || this.dirU[(this.head - 1) % this.n] < carU + U_MARGIN)) {
      this.extendTo(Math.min(limit, this.head + 256));
      grew = true;
    }
    return grew;
  }

  /** Oldest absolute distance still held. */
  get tail() {
    return Math.max(0, this.head - this.n);
  }

  wrapIndex(i) {
    return ((i % this.n) + this.n) % this.n;
  }

  /** Same contract as TrackPath.query. */
  query(x, z, hint, out = {}) {
    const n = this.n;
    let best = 0;
    let bestD = Infinity;
    if (hint < 0) {
      for (let k = this.tail; k < this.head; k++) {
        const i = k % n;
        const dx = x - this.dx[i];
        const dz = z - this.dz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let k = -40; k <= 40; k++) {
        const i = (hint + k + n) % n;
        const dx = x - this.dx[i];
        const dz = z - this.dz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }

    const i = best;
    const dx = x - this.dx[i];
    const dz = z - this.dz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const j = along >= 0 ? (i + 1) % n : (i - 1 + n) % n;
    const f = Math.min(1, Math.abs(along) / this.ds);
    const h = this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * f;
    const tx = Math.sin(h);
    const tz = Math.cos(h);

    out.index = i;
    out.s = (((i + along) % n) + n) % n;
    out.offset = dx * tz - dz * tx;
    out.y = this.py[i] + this.slope[i] * along;
    out.heading = h;
    out.tx = tx;
    out.tz = tz;
    out.slope = this.slope[i] + (this.slope[j] - this.slope[i]) * f;
    out.curv = this.curv[i] + (this.curv[j] - this.curv[i]) * f;
    out.kerb = 0;
    return out;
  }

  pointAt(s, offset = 0, out = new THREE.Vector3()) {
    const u = ((s % this.n) + this.n) % this.n;
    const i = Math.floor(u) % this.n;
    const j = (i + 1) % this.n;
    const f = u - Math.floor(u);
    const h = this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * f;
    out.set(
      this.dx[i] + (this.dx[j] - this.dx[i]) * f + Math.cos(h) * offset,
      this.py[i] + (this.py[j] - this.py[i]) * f,
      this.dz[i] + (this.dz[j] - this.dz[i]) * f - Math.sin(h) * offset
    );
    return out;
  }

  headingAt(s) {
    const u = ((s % this.n) + this.n) % this.n;
    const i = Math.floor(u) % this.n;
    const j = (i + 1) % this.n;
    return this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * (u - Math.floor(u));
  }

  /** Blended landscape parameters at a slot. */
  paramsAt(index, out = this._p) {
    return this.generator.paramsAt(this.sAbs[index], out);
  }

  /** Terrain query for a point near the car, reusing Physics' road query for the near part. */
  carTerrain(x, z, q) {
    const t = this._t || (this._t = {});
    this.graphAt(x, z, t);
    t.near = true;
    t.offset = q.offset;
    t.y = q.y;
    t.roadS = this.sAbs[q.index];
    return t;
  }

  /** Ground under (x, z) given Physics' query result there; matches the terrain mesh. */
  groundAt(x, z, q) {
    const t = this.carTerrain(x, z, q);
    return this.generator.groundHeight(x, z, t, this.generator.paramsCached(t.sAbs));
  }

  inWater(x, z, q, ground) {
    const t = this.carTerrain(x, z, q);
    return this.generator.inWater(t, ground, this.generator.paramsCached(t.sAbs));
  }

  /** What the car drives on off the tarmac here. */
  runoffAt(index) {
    const p = this.paramsAt(index);
    return p.sand > 0.6 && p.grass < 0.5 ? 'sand' : 'grass';
  }

  biomeAt(index) {
    return this.paramsAt(index).biome;
  }
}
