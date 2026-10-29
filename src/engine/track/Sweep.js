import * as THREE from 'three';

/**
 * Sweep a 2D cross-section along the whole circuit as one mesh.
 *
 * profile: [{ o, y, u?, c?, cut? }] — lateral offset (left +), height above the
 * road, optional texture u, optional grey level, and `cut` to not join this
 * point to the next (for hard edges). Offsets should increase for an
 * upward-facing surface.
 *
 * By default the strip runs the whole loop and closes. With `from`/`to`
 * (absolute distances, for the endless road) it covers just that stretch,
 * open-ended, with vertices relative to `origin` so they stay precise far
 * from the world origin.
 */
export function sweep(path, profile, { step = 2, uvScale = 4, mask = null, colors = false, from = null, to = null, origin = null } = {}) {
  const n = path.n;
  const open = from !== null;
  const rows = Math.ceil((open ? to - from : n) / step);
  const cols = profile.length;
  const vRepeat = Math.max(1, Math.round(path.length / uvScale));
  const ox = origin ? origin.x : 0;
  const oy = origin ? origin.y : 0;
  const oz = origin ? origin.z : 0;
  const px = path.dx || path.px; // double-precision positions where the path has them
  const pz = path.dz || path.pz;
  const pos = new Float32Array((rows + 1) * cols * 3);
  const uv = new Float32Array((rows + 1) * cols * 2);
  const col = colors ? new Float32Array((rows + 1) * cols * 3) : null;
  const index = [];

  for (let r = 0; r <= rows; r++) {
    let i;
    let v;
    if (open) {
      const d = Math.min(r * step, to - from);
      i = (from + d) % n;
      // Continuous with the neighbouring stretches: v measured from the start of the road
      v = (d + (from % (uvScale * 64))) / uvScale;
    } else {
      i = r === rows ? 0 : r * step;
      v = (r / rows) * vRepeat;
    }
    const lx = path.tz[i];
    const lz = -path.tx[i];
    for (let k = 0; k < cols; k++) {
      const p = profile[k];
      const w = r * cols + k;
      pos[w * 3] = px[i] + lx * p.o - ox;
      pos[w * 3 + 1] = path.py[i] + p.y - oy;
      pos[w * 3 + 2] = pz[i] + lz * p.o - oz;
      uv[w * 2] = p.u !== undefined ? p.u : p.o / uvScale;
      uv[w * 2 + 1] = v;
      if (col) {
        const c = p.c !== undefined ? p.c : 1;
        col[w * 3] = col[w * 3 + 1] = col[w * 3 + 2] = c;
      }
    }
    if (r === rows) break;
    if (mask && !mask(i)) continue;
    for (let k = 0; k < cols - 1; k++) {
      if (profile[k].cut) continue;
      const a = r * cols + k;
      const b = a + cols;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** Mirror a left-side profile to the right, keeping offsets increasing. */
export const mirror = (profile) => profile.map((p) => ({ ...p, o: -p.o })).reverse()
  .map((p, k, arr) => ({ ...p, cut: k < arr.length - 1 ? profile[profile.length - 2 - k].cut : false }));
