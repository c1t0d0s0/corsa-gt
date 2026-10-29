import * as THREE from 'three';
import { RoadGenerator, ROAD_HALF_WIDTH } from './RoadGenerator.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const CAPACITY = 8192; // metres of road held at once
const AHEAD = 3200; // keep at least this much generated in front of the car
const BEHIND = 1200; // never overwrite road this close behind the car
const START = 400; // the car starts this far along, so there is road behind it too
const CELL = 64; // nearest-road grid
const RAIL_HOLD = 30; // a guardrail runs on this far past the hazard
const cellKey = (x, z) => (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);

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
    this.grid = new Map(); // cell → absolute indices of every other sample in it
    this.sAbs = new Float64Array(n);
    // Positions in double precision: float32 loses centimetres tens of km out
    this.dx = new Float64Array(n);
    this.dz = new Float64Array(n);
    this.head = 0; // samples generated so far
    this._p = {};

    this.extendTo(START + AHEAD);
    this.startS = START % n;
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
      this.rail[i] = this.railsAt(smp);
      if (smp.s % 2 === 0) {
        const key = cellKey(smp.x, smp.z);
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(smp.s);
      }
      this.head++;
    }
    // Forget overwritten road
    const tail = this.tail;
    for (const [key, list] of this.grid) {
      if (list[list.length - 1] < tail) this.grid.delete(key);
      else if (list[0] < tail) this.grid.set(key, list.filter((k) => k >= tail));
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
      const drop = smp.y - g.groundHeight(x, z, smp.y, off, p, smp.s);
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

  /**
   * Nearest road to any point (not just near the car): grid search close to
   * the road, a coarse scan further away. Fills `out` with index, offset, y
   * (road height there) and sAbs.
   */
  nearest(x, z, out = {}) {
    const n = this.n;
    const tail = this.tail;
    let best = -1;
    let bestD = Infinity;
    const test = (k) => {
      const i = k % n;
      const dx = x - this.dx[i];
      const dz = z - this.dz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = k; }
    };
    const gx = Math.floor(x / CELL);
    const gz = Math.floor(z / CELL);
    for (let r = 0; r <= 3; r++) {
      for (let cx = gx - r; cx <= gx + r; cx++) {
        for (let cz = gz - r; cz <= gz + r; cz++) {
          if (Math.max(Math.abs(cx - gx), Math.abs(cz - gz)) !== r) continue;
          const list = this.grid.get((cx + 32768) * 65536 + (cz + 32768));
          if (list) for (const k of list) if (k >= tail) test(k);
        }
      }
      // Anything in an unsearched cell is at least r cells away
      if (best >= 0 && bestD <= (r * CELL) ** 2) break;
    }
    if (best < 0 || bestD > (3 * CELL) ** 2) {
      for (let k = tail; k < this.head; k += 8) test(k);
    }
    // Refine between the coarse samples
    const c = best;
    for (let k = Math.max(tail, c - 8); k <= Math.min(this.head - 1, c + 8); k++) test(k);

    const i = best % n;
    const dx = x - this.dx[i];
    const dz = z - this.dz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    out.index = i;
    out.sAbs = best + along;
    out.offset = dx * this.tz[i] - dz * this.tx[i];
    out.y = this.py[i] + this.slope[i] * Math.max(-1, Math.min(1, along));
    return out;
  }

  /** Ground height anywhere, from the nearest road. */
  groundAtPoint(x, z, near = this.nearest(x, z, {})) {
    const p = this.generator.paramsAt(near.sAbs, this._p);
    return this.generator.groundHeight(x, z, near.y, near.offset, p, near.sAbs);
  }

  /** Keep road generated ahead of the slot the car is in. Returns true if it grew. */
  update(index) {
    const carAbs = this.sAbs[index];
    if (this.head - carAbs >= AHEAD) return false;
    this.extendTo(Math.min(carAbs + AHEAD + 512, carAbs + this.n - BEHIND));
    return true;
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

  /** Ground under (x, z) given a query result near it. */
  groundAt(x, z, q) {
    const p = this.paramsAt(q.index);
    return this.generator.groundHeight(x, z, q.y, q.offset, p, this.sAbs[q.index]);
  }

  inWater(q, ground) {
    const p = this.paramsAt(q.index);
    return this.generator.inWater(q.offset, ground, p, this.sAbs[q.index]);
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
