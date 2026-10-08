import * as THREE from 'three';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Centreline of a circuit resampled at ~1m spacing, with fast nearest-point
 * queries. Everything that needs to know "where am I on the track" goes
 * through here (physics, camera, HUD, scenery placement).
 *
 * Conventions: heading h gives forward = (sin h, 0, cos h); "left" of the
 * track is (tz, 0, -tx); lateral offsets are positive to the left.
 */
export class TrackPath {
  constructor(def) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.runoff = def.runoff;
    this.wallOffset = def.halfWidth + def.runoff;

    const curve = new THREE.CatmullRomCurve3(
      def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      true,
      'centripetal'
    );
    curve.arcLengthDivisions = 6000;
    this.curve = curve;
    this.length = curve.getLength();

    const n = Math.round(this.length);
    this.n = n;
    this.ds = this.length / n;

    const pts = curve.getSpacedPoints(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.kerb = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      this.px[i] = pts[i].x;
      this.py[i] = pts[i].y;
      this.pz[i] = pts[i].z;
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const dx = this.px[b] - this.px[a];
      const dz = this.pz[b] - this.pz[a];
      const len = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / len;
      this.tz[i] = dz / len;
      this.heading[i] = Math.atan2(dx, dz);
      this.slope[i] = (this.py[b] - this.py[a]) / len;
    }

    // Signed curvature (positive = left turn), smoothed over a few metres
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      raw[i] = wrapAngle(this.heading[b] - this.heading[a]) / (2 * this.ds);
    }
    const win = 4;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -win; k <= win; k++) sum += raw[(i + k + n) % n];
      this.curv[i] = sum / (win * 2 + 1);
    }

    // Kerbs only where the track actually bends, padded a little either side
    if (def.kerbs) {
      const pad = 10;
      for (let i = 0; i < n; i++) {
        if (Math.abs(this.curv[i]) > 1 / 110) {
          for (let k = -pad; k <= pad; k++) this.kerb[(i + k + n) % n] = this.curv[i] > 0 ? 1 : 2;
        }
      }
    }
  }

  wrapIndex(i) {
    return ((i % this.n) + this.n) % this.n;
  }

  /**
   * Nearest centreline point to (x, z). Pass the previous result's index as
   * `hint` for an O(window) search; pass -1 to scan the whole track.
   */
  query(x, z, hint, out = {}) {
    const n = this.n;
    let best = 0;
    let bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const dx = x - this.px[i];
        const dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let k = -40; k <= 40; k++) {
        const i = (hint + k + n) % n;
        const dx = x - this.px[i];
        const dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }

    const i = best;
    const dx = x - this.px[i];
    const dz = z - this.pz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const j = along >= 0 ? (i + 1) % n : (i - 1 + n) % n;
    const f = Math.min(1, Math.abs(along) / this.ds);

    const h = this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * f;
    const tx = Math.sin(h);
    const tz = Math.cos(h);

    out.index = i;
    out.s = (((i * this.ds + along) % this.length) + this.length) % this.length;
    out.offset = dx * tz - dz * tx;
    out.y = this.py[i] + this.slope[i] * along;
    out.heading = h;
    out.tx = tx;
    out.tz = tz;
    out.slope = this.slope[i] + (this.slope[j] - this.slope[i]) * f;
    out.curv = this.curv[i] + (this.curv[j] - this.curv[i]) * f;
    out.kerb = this.kerb[i];
    return out;
  }

  /** World position at distance s along the track, `offset` metres to the left. */
  pointAt(s, offset = 0, out = new THREE.Vector3()) {
    const u = ((s % this.length) + this.length) % this.length / this.ds;
    const i = Math.floor(u) % this.n;
    const j = (i + 1) % this.n;
    const f = u - Math.floor(u);
    const h = this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * f;
    out.set(
      this.px[i] + (this.px[j] - this.px[i]) * f + Math.cos(h) * offset,
      this.py[i] + (this.py[j] - this.py[i]) * f,
      this.pz[i] + (this.pz[j] - this.pz[i]) * f - Math.sin(h) * offset
    );
    return out;
  }

  headingAt(s) {
    const u = ((s % this.length) + this.length) % this.length / this.ds;
    const i = Math.floor(u) % this.n;
    const j = (i + 1) % this.n;
    return this.heading[i] + wrapAngle(this.heading[j] - this.heading[i]) * (u - Math.floor(u));
  }
}
