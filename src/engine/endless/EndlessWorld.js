import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sweep, mirror } from '../track/Sweep.js';
import {
  mulberry32, fbm, asphaltTextures, concreteTextures, stoneTextures
} from '../ProceduralTextures.js';
import {
  broadleafModel, coniferModel, bushModel, tuftModel, cactusGeometry, foliageMaterial, barkMaterial, tickWind
} from '../Vegetation.js';
import { endlessTerrainMaterial } from './TerrainMaterial.js';
import { waterMaterial, riverMaterial, tickWater } from './Water.js';
import { SEA_LEVEL, RIVER_WATERLINE } from './RoadGenerator.js';

const CHUNK = 256; // metres of road per road mesh
const TILE = 256; // terrain tile size
const KEEP_BEHIND = 1100; // road kept behind the car
const BUDGET_MS = 4; // building time allowed per frame
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const tileKey = (tx, tz) => `${tx},${tz}`;

/**
 * Streams the endless road's world around the car: road meshes per 256 m
 * stretch as the road is generated, and terrain tiles on a world grid (fine
 * near the car, coarse further out, with skirts hiding the cracks between),
 * dressed with the plants of whatever landscape the road beside it is in.
 *
 * Everything is built from the seed and world position only, so a tile looks
 * the same whenever it is built. Building is spread over frames within a
 * small time budget, nearest first: each job is a generator that yields
 * every few rows, so even a big tile never stalls a frame. What falls out of
 * range is disposed.
 * Meshes are positioned at their own origin with local vertices, so nothing
 * loses precision tens of kilometres out.
 */
export class EndlessWorld {
  constructor(path, group, { mobile = false } = {}) {
    this.path = path;
    this.gen = path.generator;
    this.group = group;
    this.density = mobile ? 0.5 : 1;
    this.nearRadius = mobile ? 420 : 640; // fine terrain
    this.vegRadius = mobile ? 360 : 520; // plants
    this.farRadius = mobile ? 1400 : 2200; // coarse terrain
    this.roadChunks = new Map();
    this.tiles = new Map();
    this.carAbs = path.startS;
    this.near = {};
    this.planTimer = 0;
    this.tasks = []; // queued jobs (functions returning iterators), nearest first
    this.job = null; // the job in progress

    this.makeMaterials();
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(this.farRadius * 2, this.farRadius * 2).rotateX(-Math.PI / 2), this.seaMat);
    this.sea.position.y = SEA_LEVEL;
    this.sea.renderOrder = 1;
    // The terrain is always on screen, so the sea (also always present) drives the animation clocks
    this.sea.onBeforeRender = () => { tickWind(); tickWater(); };
    this.sea.frustumCulled = false;
    group.add(this.sea);
  }

  makeMaterials() {
    const asphalt = asphaltTextures();
    this.roadMat = new THREE.MeshStandardMaterial({
      map: asphalt.map, normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(0.3, 0.3),
      roughness: 0.86, vertexColors: true
    });
    this.paintMat = new THREE.MeshStandardMaterial({
      color: 0xe8e8e8, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const gravel = concreteTextures();
    this.shoulderMat = new THREE.MeshStandardMaterial({ map: gravel.map, normalMap: gravel.normalMap, roughness: 1, color: 0x9a948a });
    this.railMat = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide });
    this.postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.5, roughness: 0.5 });
    this.terrainMat = endlessTerrainMaterial();
    this.seaMat = waterMaterial({ color: 0x1b4a63, opacity: 0.92 });
    this.riverMat = riverMaterial();

    this.plants = {
      broadleaf: broadleafModel(11),
      conifer: coniferModel(5),
      bush: bushModel(3),
      scrub: bushModel(7),
      tuft: tuftModel(),
      cactus: cactusGeometry(),
      rock: new THREE.DodecahedronGeometry(1, 0),
      post: new THREE.BoxGeometry(0.12, 1, 0.12)
    };
    this.plantMats = {
      bark: barkMaterial(),
      leaf: foliageMaterial('leaf'),
      needle: foliageMaterial('needle', { sway: 0.03, flutter: 0.002 }),
      scrub: foliageMaterial('scrub', { sway: 0.03 }),
      grass: foliageMaterial('grass', { base: 0, sway: 0.12, flutter: 0.01 }),
      cactus: new THREE.MeshStandardMaterial({ color: 0x4f7a43, roughness: 0.9 }),
      rock: new THREE.MeshStandardMaterial({ map: stoneTextures().map, roughness: 0.95, flatShading: true })
    };
  }

  // --- Per frame -----------------------------------------------------------

  /** Build what's missing near `focus`, drop what's far away. */
  update(focus, dt = 0, budget = BUDGET_MS) {
    this.carAbs = this.path.terrainQuery(focus.x, focus.z, this.near).roadS;
    this.focus = focus;
    // Snap so the sea's ripples (world-space) don't swim
    this.sea.position.x = Math.round(focus.x / 64) * 64;
    this.sea.position.z = Math.round(focus.z / 64) * 64;
    this.sea.visible = this.seaNearby();

    this.planTimer -= dt;
    if (this.planTimer <= 0) {
      this.planTimer = 0.3;
      this.plan(focus);
    }
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      if (!this.job) {
        if (!this.tasks.length) break;
        this.job = this.tasks.shift()();
      }
      if (this.job.next().done) this.job = null;
    }
  }

  /** Nothing queued or in progress. */
  get idle() {
    return !this.job && this.tasks.length === 0;
  }

  /** Is there sea anywhere within sight along the road? */
  seaNearby() {
    for (let d = -1500; d <= 2500; d += 250) {
      const s = this.carAbs + d;
      if (s < this.path.tail || s >= this.path.head) continue;
      if (this.gen.paramsCached(s).sea > 0.01) return true;
    }
    return false;
  }

  /** Work out what to build and what to drop, nearest first. */
  plan(focus) {
    const tasks = [];
    // Road: every stretch from a little behind the car to the end of the generated road
    const first = Math.max(Math.floor(this.path.tail / CHUNK), Math.floor((this.carAbs - KEEP_BEHIND) / CHUNK));
    const last = Math.floor((this.path.head - 2) / CHUNK) - 1;
    for (const [c, chunk] of this.roadChunks) {
      if (c < first || c > last) {
        this.disposeObject(chunk);
        this.roadChunks.delete(c);
      }
    }
    for (let c = first; c <= last; c++) {
      if (!this.roadChunks.has(c)) tasks.push({ d: Math.abs(c * CHUNK - this.carAbs) * 0.5, run: () => this.buildRoadChunk(c) });
    }

    // Terrain tiles in a disc around the car
    const r = Math.ceil(this.farRadius / TILE);
    const cx = Math.floor(focus.x / TILE);
    const cz = Math.floor(focus.z / TILE);
    const wanted = new Set();
    for (let tx = cx - r; tx <= cx + r; tx++) {
      for (let tz = cz - r; tz <= cz + r; tz++) {
        const d = Math.hypot((tx + 0.5) * TILE - focus.x, (tz + 0.5) * TILE - focus.z);
        if (d > this.farRadius) continue;
        const key = tileKey(tx, tz);
        wanted.add(key);
        const fine = d < this.nearRadius;
        const veg = d < this.vegRadius;
        const tile = this.tiles.get(key);
        if (!tile || tile.fine !== fine) {
          tasks.push({ d, run: () => this.buildTile(tx, tz, fine) });
        } else if (veg && !tile.veg) {
          tasks.push({ d: d + 40, run: () => this.buildPlants(tile) });
        } else if (!veg && tile.veg) {
          this.disposeObject(tile.veg);
          tile.veg = null;
        }
      }
    }
    for (const [key, tile] of this.tiles) {
      if (!wanted.has(key)) {
        this.disposeObject(tile.mesh);
        if (tile.veg) this.disposeObject(tile.veg);
        this.tiles.delete(key);
      }
    }
    tasks.sort((a, b) => a.d - b.d);
    this.tasks = tasks.map((t) => t.run);
  }

  disposeObject(obj) {
    this.group.remove(obj);
    // Materials and plant geometries are shared; only per-object geometry goes
    obj.traverse((o) => {
      if (o.geometry && !o.userData.sharedGeometry) o.geometry.dispose();
    });
  }

  // --- Road ------------------------------------------------------------------

  *buildRoadChunk(c) {
    const path = this.path;
    const from = c * CHUNK;
    const to = from + CHUNK;
    if (this.roadChunks.has(c) || to >= path.head || from < path.tail) return;
    const i0 = from % path.n;
    const origin = new THREE.Vector3(path.dx[i0], path.py[i0], path.dz[i0]);
    const chunk = new THREE.Group();
    chunk.position.copy(origin);
    const opts = { from, to, origin };
    const add = (geo, mat, { cast = false } = {}) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = cast;
      chunk.add(mesh);
      return mesh;
    };

    const hw = path.halfWidth;
    const merged = (geos) => {
      const geo = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      return geo;
    };
    add(sweep(path, [
      { o: -hw, y: 0, c: 0.95 }, { o: -hw / 2, y: 0, c: 0.86 }, { o: 0, y: 0, c: 0.95 },
      { o: hw / 2, y: 0, c: 0.86 }, { o: hw, y: 0, c: 0.95 }
    ], { ...opts, uvScale: 5, colors: true }), this.roadMat);
    // Solid edge lines, dashed centre line (5 m on, 5 m off)
    const edge = [{ o: hw - 0.35, y: 0.012 }, { o: hw - 0.2, y: 0.012 }];
    add(merged([
      sweep(path, edge, opts),
      sweep(path, mirror(edge), opts),
      sweep(path, [{ o: -0.07, y: 0.012 }, { o: 0.07, y: 0.012 }], { ...opts, step: 1, mask: (i) => path.sAbs[i] % 10 < 5 })
    ]), this.paintMat);
    // Gravel shoulder, then a skirt that tucks under the terrain
    const shoulder = [{ o: hw, y: -0.005 }, { o: hw + 0.7, y: -0.03 }, { o: hw + 1.6, y: -0.9 }];
    add(merged([
      sweep(path, shoulder, { ...opts, uvScale: 3 }),
      sweep(path, mirror(shoulder), { ...opts, uvScale: 3 })
    ]), this.shoulderMat);
    yield;

    // Guardrails where Physics has them too
    const posts = [];
    for (const [bit, side] of [[1, 1], [2, -1]]) {
      const has = (i) => (path.rail[i] & bit) !== 0;
      let any = false;
      for (let k = from; k < to; k++) if (has(k % path.n)) { any = true; break; }
      if (!any) continue;
      const o = side * (hw + 0.9);
      add(sweep(path, [{ o, y: 0.5, u: 0 }, { o, y: 0.82, u: 1 }], { ...opts, step: 1, mask: has }), this.railMat);
      for (let k = from; k < to; k += 4) {
        const i = k % path.n;
        if (!has(i)) continue;
        const p = path.pointAt(i, side * (hw + 1.0));
        posts.push({ x: p.x - origin.x, y: p.y - origin.y + 0.4, z: p.z - origin.z, sy: 0.85 });
      }
    }
    if (posts.length) chunk.add(this.instances(this.plants.post, this.postMat, posts, { cast: true }));

    const river = this.riverStrip(from, to, origin);
    if (river) add(river, this.riverMat).renderOrder = 1;

    this.group.add(chunk);
    this.roadChunks.set(c, chunk);
  }

  /** Water ribbon along the river's course beside this stretch of road. */
  riverStrip(from, to, origin) {
    const path = this.path;
    const gen = this.gen;
    const pos = [];
    const uv = [];
    const flow = []; // metres across, metres along (wrapped), half width: see riverMaterial
    let any = false;
    const step = 4;
    for (let k = from; k <= to; k += step) {
      const i = Math.min(k, to) % path.n;
      const s = path.sAbs[i];
      const p = gen.paramsCached(s);
      if (p.river > 0.12) any = true;
      const ro = gen.riverOffset(s, p);
      const y = gen.riverLevel(path.py[i]) - origin.y;
      // Reach just past the waterline; the shader fades the edge into the bank. Where the river
      // is only half cut (fading out, far off the road) there's no water, so pinch the strip shut.
      const half = p.river > 0.12 ? (RIVER_WATERLINE + 0.5) * gen.riverWidth(s) : 0.01;
      const along = (from % 2048) + (Math.min(k, to) - from);
      for (const w of [-half, half]) {
        const q = path.pointAt(i, ro + w);
        pos.push(q.x - origin.x, y, q.z - origin.z);
        uv.push(q.x - origin.x, q.z - origin.z);
        flow.push(w, along, half);
      }
    }
    if (!any) return null;
    const index = [];
    const rows = pos.length / 6;
    for (let r = 0; r < rows - 1; r++) {
      const a = r * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aRiver', new THREE.Float32BufferAttribute(flow, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    // Strips wind with the river; make sure they face up
    const nrm = geo.attributes.normal;
    for (let k = 0; k < nrm.count; k++) nrm.setXYZ(k, 0, 1, 0);
    return geo;
  }

  // --- Terrain ---------------------------------------------------------------

  /**
   * Ground height and what's needed to dress it at a world point. Depends on
   * the seed and position only (see EndlessPath.terrainQuery), so a tile comes
   * out the same whenever it's built.
   */
  sample(x, z, out) {
    const t = this.path.terrainQuery(x, z, this.near);
    const p = this.gen.paramsCached(t.sAbs);
    out.h = this.gen.groundHeight(x, z, t, p);
    out.offset = t.offset; // sideways from the closest road (or the road level with it, when far)
    out.near = t.near;
    out.roadS = t.roadS;
    out.p = p;
    return out;
  }

  /** Is `s` (a sample) within reach of the river? */
  byRiver(s, distance) {
    return s.near && s.p.river > 0.02 && Math.abs(s.offset - this.gen.riverOffset(s.roadS, s.p)) < distance * this.gen.riverWidth(s.roadS);
  }

  *buildTile(tx, tz, fine) {
    const seg = fine ? 64 : 16;
    const step = TILE / seg;
    const ox = tx * TILE;
    const oz = tz * TILE;
    const w = seg + 3; // one extra row/column all round, for normals
    const heights = new Float32Array(w * w);
    const splat = new Float32Array((seg + 1) * (seg + 1) * 4);
    const extra = new Float32Array((seg + 1) * (seg + 1) * 2);
    const smp = {};
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const x = ox + (i - 1) * step;
        const z = oz + (j - 1) * step;
        const inner = i >= 1 && j >= 1 && i <= seg + 1 && j <= seg + 1;
        this.sample(x, z, smp);
        heights[j * w + i] = smp.h;
        if (inner) this.surfaceAt(x, z, smp, splat, extra, (j - 1) * (seg + 1) + (i - 1));
      }
      if (j % 8 === 7) yield;
    }

    // Grid plus a skirt round the edge that hangs down to hide cracks against coarser tiles
    const verts = (seg + 1) * (seg + 1);
    const perim = seg * 4;
    const pos = new Float32Array((verts + perim) * 3);
    const nrm = new Float32Array((verts + perim) * 3);
    const col = new Float32Array((verts + perim) * 3);
    const spl = new Float32Array((verts + perim) * 4);
    const ext = new Float32Array((verts + perim) * 2);
    const H = (i, j) => heights[(j + 1) * w + (i + 1)];
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const v = j * (seg + 1) + i;
        const h = H(i, j);
        pos.set([i * step, h, j * step], v * 3);
        const nx = (H(i - 1, j) - H(i + 1, j)) / (2 * step);
        const nz = (H(i, j - 1) - H(i, j + 1)) / (2 * step);
        const len = Math.hypot(nx, 1, nz);
        nrm.set([nx / len, 1 / len, nz / len], v * 3);
        const tone = 0.86 + fbm((ox + i * step) / 90, (oz + j * step) / 90, 3, 9) * 0.3;
        col.set([tone, tone, tone], v * 3);
        spl.set(splat.subarray(v * 4, v * 4 + 4), v * 4);
        ext.set(extra.subarray(v * 2, v * 2 + 2), v * 2);
      }
    }
    const index = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i;
        index.push(a, a + seg + 1, a + 1, a + 1, a + seg + 1, a + seg + 2);
      }
    }
    // Walk the perimeter; each edge vertex gets a twin hanging below it
    const ring = [];
    for (let i = 0; i < seg; i++) ring.push(i);
    for (let j = 0; j < seg; j++) ring.push(j * (seg + 1) + seg);
    for (let i = seg; i > 0; i--) ring.push(seg * (seg + 1) + i);
    for (let j = seg; j > 0; j--) ring.push(j * (seg + 1));
    const drop = fine ? 3 : 8;
    ring.forEach((v, k) => {
      const t = verts + k;
      pos.set([pos[v * 3], pos[v * 3 + 1] - drop, pos[v * 3 + 2]], t * 3);
      nrm.set(nrm.subarray(v * 3, v * 3 + 3), t * 3);
      col.set(col.subarray(v * 3, v * 3 + 3), t * 3);
      spl.set(spl.subarray(v * 4, v * 4 + 4), t * 4);
      ext.set(ext.subarray(v * 2, v * 2 + 2), t * 2);
    });
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const at = verts + k;
      const bt = verts + ((k + 1) % ring.length);
      index.push(a, at, b, b, at, bt);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4));
    geo.setAttribute('aExtra', new THREE.BufferAttribute(ext, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    const key = tileKey(tx, tz);
    const old = this.tiles.get(key);
    const tile = { tx, tz, ox, oz, fine, mesh, veg: old ? old.veg : null };
    if (old) this.disposeObject(old.mesh);
    if (!fine && tile.veg) {
      this.disposeObject(tile.veg);
      tile.veg = null;
    }
    this.group.add(mesh);
    this.tiles.set(key, tile);
  }

  /** Splat weights (grass, dirt, sand, rock) and extras (dryness, wetness) for one vertex. */
  surfaceAt(x, z, smp, splat, extra, v) {
    const p = smp.p;
    const h = smp.h;
    const off = Math.abs(smp.offset);
    let grass = p.grass;
    let dirt = p.dirt * smoothstep(0.45, 0.75, fbm(x / 50 + 7, z / 50 + 3, 3, 21));
    let sand = p.sand;
    let rock = p.rock * smoothstep(0.4, 0.7, fbm(x / 110 + 1, z / 110 + 5, 3, 33));
    let wet = 0;
    // Bare rock on high ground
    rock += smoothstep(180, 300, h) * 0.8;
    // Beach: sand at the water's edge, wet just above it
    if (p.sea > 0.05) {
      const beach = smoothstep(4, 1.5, h - SEA_LEVEL) * p.sea;
      sand += beach * 2;
      grass *= 1 - beach;
      wet = smoothstep(1.4, 0.2, h - SEA_LEVEL) * p.sea;
    }
    // River banks: grass right down to a narrow, uneven strip of gravel at the waterline, dark and
    // wet where the water laps it
    if (smp.near && p.river > 0.02) {
      const d = Math.abs(smp.offset - this.gen.riverOffset(smp.roadS, p)) / this.gen.riverWidth(smp.roadS) - RIVER_WATERLINE;
      const gravel = smoothstep(0.8, -0.6, d) * (0.6 + 0.6 * fbm(x / 9 + 3, z / 9 + 1, 2, 41));
      dirt += gravel * 0.45;
      sand += gravel * 0.9;
      grass *= 1 - Math.min(1, gravel) * 0.85;
      wet = Math.max(wet, smoothstep(0.6, -0.6, d));
    }
    // Worn verge right by the road
    dirt += smoothstep(this.path.halfWidth + 3, this.path.halfWidth + 1, off) * 0.3;
    splat.set([grass, dirt, sand, rock], v * 4);
    extra.set([p.dry, wet], v * 2);
  }

  // --- Plants ----------------------------------------------------------------

  /** Trees, bushes, grass, cacti and rocks for one fine tile, by the local landscape. */
  *buildPlants(tile) {
    const { tx, tz, ox, oz } = tile;
    if (this.tiles.get(tileKey(tx, tz)) !== tile) return; // rebuilt or dropped since this was queued
    const rand = mulberry32((this.gen.seed ^ Math.imul(tx, 73856093) ^ Math.imul(tz, 19349663)) >>> 0);
    const hw = this.path.halfWidth;
    const lists = { broadleaf: [], conifer: [], bush: [], scrub: [], tuft: [], cactus: [], rock: [] };
    const smp = {};
    const d = this.density;
    const slopeAt = (x, z, h) => {
      const hx = this.sample(x + 2, z, {}).h;
      const hz = this.sample(x, z + 2, {}).h;
      return Math.hypot(hx - h, hz - h) / 2;
    };
    // `river`: how close to the river's centre line it may grow (the waterline is RIVER_WATERLINE out)
    const ok = (s, clear, river = RIVER_WATERLINE + 2) => {
      if (Math.abs(s.offset) < hw + clear) return false;
      if (s.p.sea > 0.05 && s.h < SEA_LEVEL + 2.5) return false;
      if (this.byRiver(s, river)) return false;
      return true;
    };

    // Trees, bushes, cacti and rocks on a jittered 8 m grid
    for (let gz = 0; gz < TILE; gz += 8) {
      for (let gx = 0; gx < TILE; gx += 8) {
        const lx = gx + rand() * 8;
        const lz = gz + rand() * 8;
        const r1 = rand();
        const r2 = rand();
        const r3 = rand();
        const s = this.sample(ox + lx, oz + lz, smp);
        const p = s.p;
        const base = { x: lx, y: s.h, z: lz, ry: r2 * 6.3, tint: r3 };
        if (r1 < p.trees * 0.5 * d) {
          if (!ok(s, 7) || slopeAt(ox + lx, oz + lz, s.h) > 0.7) continue;
          const conifer = this.coniferAt(ox + lx, oz + lz, s.h, p);
          const h = conifer ? 10 + r3 * 10 : 8 + r3 * 7;
          const wd = h * (conifer ? 0.8 + r1 : 0.9 + r1 * 0.6);
          lists[conifer ? 'conifer' : 'broadleaf'].push({ ...base, y: s.h - 0.2, sx: wd, sy: h, sz: wd });
        } else if (r1 < (p.trees * 0.5 + p.bushes * 0.25) * d) {
          if (!ok(s, 3)) continue;
          const sc = 0.9 + r3 * 1.6;
          lists[p.dry > 0.5 ? 'scrub' : 'bush'].push({ ...base, y: s.h - 0.15, sx: sc * 1.5, sy: sc, sz: sc * 1.3 });
        } else if (r1 < (p.trees * 0.5 + p.bushes * 0.25 + p.cacti * 0.12) * d) {
          if (!ok(s, 3)) continue;
          lists.cactus.push({ ...base, y: s.h - 0.1, s: 0.8 + r3 * 0.9 });
        } else if (r1 < (p.trees * 0.5 + p.bushes * 0.25 + p.cacti * 0.12 + p.rocks * 0.05) * d) {
          if (!ok(s, 2)) continue;
          const sc = 0.5 + r3 * r3 * 3;
          lists.rock.push({ ...base, y: s.h + sc * 0.2, sx: sc, sy: sc * (0.5 + r1), sz: sc * (0.7 + r2 * 0.5), rx: r1 });
        }
      }
      if (gz % 64 === 56) yield;
    }
    // Grass tufts on a 4 m grid, near the road where they're seen up close
    for (let gz = 0; gz < TILE; gz += 4) {
      for (let gx = 0; gx < TILE; gx += 4) {
        const lx = gx + rand() * 4;
        const lz = gz + rand() * 4;
        const r1 = rand();
        const r2 = rand();
        const t = this.path.terrainQuery(ox + lx, oz + lz, this.near);
        if (Math.abs(t.offset) > 160) continue;
        const p = this.gen.paramsCached(t.sAbs);
        if (r1 > p.tufts * 0.55 * d) continue;
        const s = this.sample(ox + lx, oz + lz, smp);
        if (!ok(s, 1.2, RIVER_WATERLINE + 0.4)) continue; // grass grows right down to the water
        const sc = 0.45 + r2 * 0.6;
        lists.tuft.push({ x: lx, y: s.h - 0.03, z: lz, sx: sc * 1.3, sy: sc * (0.6 + r1), sz: sc * 1.3, ry: r2 * 6.3, tint: r2, dry: p.dry });
      }
      if (gz % 32 === 28) yield;
    }
    if (this.tiles.get(tileKey(tx, tz)) !== tile) return; // replaced while we were working

    const veg = new THREE.Group();
    veg.position.set(ox, 0, oz);
    const P = this.plants;
    const M = this.plantMats;
    const c = new THREE.Color();
    const leafTint = (t) => (t.tint > 0.95
      ? c.setHSL(0.13, 0.55, 0.36)
      : c.setHSL(0.2 + t.tint * 0.08, 0.38 + t.tint * 0.12, 0.2 + t.tint * 0.1)).clone();
    const put = (geo, mat, list, opts) => { if (list.length) veg.add(this.instances(geo, mat, list, opts)); };
    put(P.broadleaf.wood, M.bark, lists.broadleaf, { cast: true });
    put(P.broadleaf.leaves, M.leaf, lists.broadleaf, { cast: true, color: leafTint });
    put(P.conifer.wood, M.bark, lists.conifer, { cast: true });
    put(P.conifer.leaves, M.needle, lists.conifer, { cast: true, color: (t) => c.setHSL(0.3 + t.tint * 0.06, 0.35, 0.2 + t.tint * 0.1).clone() });
    put(P.bush.leaves, M.leaf, lists.bush, { cast: true, color: leafTint });
    put(P.scrub.leaves, M.scrub, lists.scrub, { cast: true, color: (t) => c.setHSL(0.12 + t.tint * 0.08, 0.15 + t.tint * 0.1, 0.4 + t.tint * 0.14).clone() });
    put(P.tuft.leaves, M.grass, lists.tuft, {
      color: (t) => c.setHSL(0.2 + t.tint * 0.06 - t.dry * 0.12, 0.4 + t.dry * 0.25, 0.27 + t.tint * 0.1 + t.dry * 0.2).clone()
    });
    put(P.cactus, M.cactus, lists.cactus, { cast: true });
    put(P.rock, M.rock, lists.rock, { cast: true, color: (t) => c.setHSL(0.06, 0.25 * (t.tint > 0.5 ? 1 : 0.2), 0.45 + t.tint * 0.2).clone() });

    if (tile.veg) this.disposeObject(tile.veg);
    tile.veg = veg;
    this.group.add(veg);
  }

  /**
   * Conifer or broadleaf? Conifers belong where it's cold: in cold country,
   * and higher up anywhere (about one step colder per 350 m of altitude). Where
   * the climate is in between, the two grow in separate stands a few hundred
   * metres across, never tree by tree.
   */
  coniferAt(x, z, h, p) {
    const cold = p.cold + Math.max(0, h - 80) / 350;
    const share = smoothstep(0.45, 0.65, cold);
    if (share <= 0 || share >= 1) return share >= 1;
    const stand = 0.02 + 0.96 * smoothstep(0.25, 0.75, fbm(x / 220 + 13.1, z / 220 + 7.7, 3, this.gen.noiseSeed + 11));
    return stand < share;
  }

  /** One InstancedMesh; transforms are { x, y, z, s | sx sy sz, rx, ry }. */
  instances(geo, mat, list, { cast = false, color = null } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.userData.sharedGeometry = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    list.forEach((t, i) => {
      q.setFromEuler(e.set(t.rx || 0, t.ry || 0, 0));
      m.compose(v.set(t.x, t.y, t.z), q, sc.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1));
      mesh.setMatrixAt(i, m);
      if (color) mesh.setColorAt(i, color(t));
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  /** Dominant landscape at the car, for the HUD. */
  get biome() {
    return this.gen.paramsCached(this.carAbs).biome;
  }
}
