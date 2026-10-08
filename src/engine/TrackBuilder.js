import * as THREE from 'three';
import { getTrackDef } from './track/TrackData.js';
import { TrackPath } from './track/TrackPath.js';
import { buildScenery } from './Scenery.js';
import {
  asphaltTextures, grassTextures, sandTextures, concreteTextures,
  kerbTexture, checkerTexture, bannerTexture
} from './ProceduralTextures.js';

/**
 * Sweep a 2D cross-section along the whole circuit as one mesh.
 *
 * profile: [{ o, y, u?, c?, cut? }] — lateral offset (left +), height above the
 * road, optional texture u, optional grey level, and `cut` to not join this
 * point to the next (for hard edges). Offsets should increase for an
 * upward-facing surface.
 */
export function sweep(path, profile, { step = 2, uvScale = 4, mask = null, colors = false } = {}) {
  const n = path.n;
  const rows = Math.ceil(n / step);
  const cols = profile.length;
  const vRepeat = Math.max(1, Math.round(path.length / uvScale));
  const pos = new Float32Array((rows + 1) * cols * 3);
  const uv = new Float32Array((rows + 1) * cols * 2);
  const col = colors ? new Float32Array((rows + 1) * cols * 3) : null;
  const index = [];

  for (let r = 0; r <= rows; r++) {
    const i = r === rows ? 0 : r * step;
    const lx = path.tz[i];
    const lz = -path.tx[i];
    const v = (r / rows) * vRepeat;
    for (let k = 0; k < cols; k++) {
      const p = profile[k];
      const w = r * cols + k;
      pos[w * 3] = path.px[i] + lx * p.o;
      pos[w * 3 + 1] = path.py[i] + p.y;
      pos[w * 3 + 2] = path.pz[i] + lz * p.o;
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
const mirror = (profile) => profile.map((p) => ({ ...p, o: -p.o })).reverse()
  .map((p, k, arr) => ({ ...p, cut: k < arr.length - 1 ? profile[profile.length - 2 - k].cut : false }));

const RUNOFF_LOOK = {
  grass: { textures: grassTextures, color: 0xffffff, uvScale: 7 },
  sand: { textures: sandTextures, color: 0xffffff, uvScale: 9 },
  asphalt: { textures: concreteTextures, color: 0x8a8a8a, uvScale: 5 }
};

/**
 * Builds the drivable circuit (road, markings, kerbs, verges, barriers, start
 * gantry) plus themed scenery, and owns their lifetime.
 */
export class TrackBuilder {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this.path = null;
    this.def = null;
    this.roadMaterial = null;
    this.scenery = null;
  }

  build(trackId = 'apex') {
    this.dispose();
    const def = getTrackDef(trackId);
    const path = new TrackPath(def);
    this.def = def;
    this.path = path;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    const hw = path.halfWidth;
    const wo = path.wallOffset;
    const add = (geo, mat, { cast = false, receive = true } = {}) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.group.add(mesh);
      return mesh;
    };

    // Road surface, slightly darker along the racing line
    const asphalt = asphaltTextures();
    this.roadMaterial = new THREE.MeshStandardMaterial({
      map: asphalt.map,
      normalMap: asphalt.normalMap,
      normalScale: new THREE.Vector2(0.3, 0.3),
      roughness: 0.86,
      metalness: 0,
      vertexColors: true
    });
    add(sweep(path, [
      { o: -hw, y: 0, c: 1 }, { o: -hw * 0.55, y: 0, c: 0.92 }, { o: 0, y: 0, c: 0.8 },
      { o: hw * 0.55, y: 0, c: 0.92 }, { o: hw, y: 0, c: 1 }
    ], { uvScale: 5, colors: true }), this.roadMaterial);

    // Painted lines sit a hair above the road; polygon offset stops z-fighting
    const paint = new THREE.MeshStandardMaterial({
      color: 0xe8e8e8, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const edge = [{ o: hw - 0.5, y: 0.012 }, { o: hw - 0.3, y: 0.012 }];
    add(sweep(path, edge), paint);
    add(sweep(path, mirror(edge)), paint);
    if (def.theme === 'city') {
      const dashed = (i) => (i * path.ds) % 12 < 4;
      for (const o of [-hw / 3, hw / 3]) {
        add(sweep(path, [{ o: o - 0.08, y: 0.012 }, { o: o + 0.08, y: 0.012 }], { step: 1, mask: dashed }), paint);
      }
    }

    // Kerbs through the corners
    if (def.kerbs) {
      const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.55 });
      const kerb = [
        { o: hw - 0.05, y: 0.012, u: 0 }, { o: hw + 0.7, y: 0.075, u: 0.5 }, { o: hw + 1.35, y: 0.02, u: 1 }
      ];
      const onKerb = (i) => path.kerb[i] !== 0;
      add(sweep(path, kerb, { step: 1, uvScale: 3, mask: onKerb }), kerbMat);
      add(sweep(path, mirror(kerb), { step: 1, uvScale: 3, mask: onKerb }), kerbMat);
    }

    // Run-off between the road and the barrier, then a skirt that tucks under the terrain
    const look = RUNOFF_LOOK[def.runoffSurface] || RUNOFF_LOOK.grass;
    const vergeTex = look.textures();
    const vergeMat = new THREE.MeshStandardMaterial({
      map: vergeTex.map, normalMap: vergeTex.normalMap, color: look.color, roughness: 0.95
    });
    const verge = [{ o: hw, y: -0.004 }, { o: wo + 0.4, y: -0.004 }, { o: wo + 28, y: -0.95 }];
    add(sweep(path, verge, { uvScale: look.uvScale }), vergeMat);
    add(sweep(path, mirror(verge), { uvScale: look.uvScale }), vergeMat);

    // Barriers: these line up exactly with the physics wall
    const wallH = def.theme === 'city' ? 1.15 : 0.95;
    const concrete = concreteTextures();
    const wallMat = new THREE.MeshStandardMaterial({
      map: concrete.map, normalMap: concrete.normalMap, roughness: 0.8, side: THREE.DoubleSide,
      color: def.theme === 'desert' ? 0xd8b48c : 0xdcdcdc
    });
    const wall = [
      { o: wo, y: -0.1, u: 0 }, { o: wo, y: wallH, u: 0.3, cut: true },
      { o: wo, y: wallH, u: 0.3 }, { o: wo + 0.4, y: wallH, u: 0.42, cut: true },
      { o: wo + 0.4, y: wallH, u: 0.42 }, { o: wo + 0.4, y: -0.6, u: 0.8 }
    ];
    add(sweep(path, wall, { uvScale: 3 }), wallMat, { cast: true });
    add(sweep(path, mirror(wall), { uvScale: 3 }), wallMat, { cast: true });

    const band = (o, y0, y1) => [{ o, y: y0, u: 0 }, { o, y: y1, u: 1 }];
    if (def.theme === 'city') {
      // Neon strips along the barrier tops; HDR colours so they bloom
      const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 1.5, 2.0), side: THREE.DoubleSide });
      const pink = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.0, 0.22, 1.15), side: THREE.DoubleSide });
      add(sweep(path, band(wo - 0.015, wallH - 0.2, wallH - 0.06)), cyan, { receive: false });
      add(sweep(path, band(-wo + 0.015, wallH - 0.2, wallH - 0.06)), pink, { receive: false });
    } else if (def.theme === 'apex') {
      const capMat = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.6, side: THREE.DoubleSide });
      add(sweep(path, band(wo - 0.012, wallH - 0.3, wallH), { uvScale: 8 }), capMat);
      add(sweep(path, band(-wo + 0.012, wallH - 0.3, wallH), { uvScale: 8 }), capMat);
    }

    this.buildStartLine(path, hw, wo);
    this.scenery = buildScenery(path, def, this.group);
    return path;
  }

  buildStartLine(path, hw, wo) {
    const origin = path.pointAt(0);
    const heading = path.headingAt(0);
    const start = new THREE.Group();
    start.position.copy(origin);
    start.rotation.y = heading;
    this.group.add(start);

    // Chequered line
    const lineGeo = new THREE.PlaneGeometry(hw * 2 - 1, 1.6);
    const uv = lineGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (hw * 2 - 1) / 1.6, uv.getY(i));
    lineGeo.rotateX(-Math.PI / 2);
    const decal = { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 };
    const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.6, ...decal }));
    line.position.y = 0.014;
    line.receiveShadow = true;
    start.add(line);

    // Grid slots behind the line
    const slotMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, ...decal });
    for (let i = 0; i < 6; i++) {
      const slot = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.18).rotateX(-Math.PI / 2), slotMat);
      slot.position.set(i % 2 ? -2.6 : 2.6, 0.014, -10 - i * 8);
      slot.receiveShadow = true;
      start.add(slot);
    }

    // Gantry
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.8, roughness: 0.35 });
    const span = wo + 1.2;
    for (const x of [-span, span]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8.4, 0.7), steel);
      post.position.set(x, 4.2, 0);
      post.castShadow = true;
      start.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.7, 1.5, 0.9), steel);
    beam.position.set(0, 7.9, 0);
    beam.castShadow = true;
    start.add(beam);

    const bannerMat = new THREE.MeshBasicMaterial({ map: bannerTexture(0), side: THREE.DoubleSide });
    for (const z of [-0.47, 0.47]) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.25), bannerMat);
      banner.position.set(0, 7.9, z);
      if (z < 0) banner.rotation.y = Math.PI;
      start.add(banner);
    }

    // Start lights facing the grid
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 1.7, 0.3) });
    for (let i = 0; i < 5; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lampMat);
      lamp.position.set((i - 2) * 0.8, 6.85, -0.5);
      start.add(lamp);
    }
  }

  /** Rain: darker, glossier tarmac that mirrors the sky. */
  setWet(wet) {
    if (!this.roadMaterial) return;
    this.roadMaterial.roughness = wet ? 0.22 : 0.86;
    this.roadMaterial.color.setScalar(wet ? 0.62 : 1);
    this.roadMaterial.normalScale.setScalar(wet ? 0.15 : 0.3);
    this.roadMaterial.envMapIntensity = wet ? 1.5 : 1;
  }

  /** Night/day switch for scenery lighting (windows, lamps, light pools). */
  setLook(look) {
    this.setWet(look.wet);
    if (this.scenery) this.scenery.setLook(look);
  }

  dispose() {
    if (!this.group) return;
    this.scene.remove(this.group);
    // Textures are shared via the procedural cache, so only geometry and materials go
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) [].concat(obj.material).forEach((m) => m.dispose());
      if (obj.userData.ownTextures) obj.userData.ownTextures.forEach((t) => t.dispose());
    });
    this.group = null;
    this.scenery = null;
    this.roadMaterial = null;
  }
}
