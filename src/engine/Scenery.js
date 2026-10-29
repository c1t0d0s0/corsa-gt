import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  mulberry32, fbm, grassTextures, sandTextures, concreteTextures, rockTextures, dirtTextures, stoneTextures,
  buildingTextures, radialTexture, bannerTexture
} from './ProceduralTextures.js';
import {
  broadleafModel, coniferModel, bushModel, tuftModel, foliageMaterial, barkMaterial, tickWind
} from './Vegetation.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const GRID_CELL = 40;
const GRID_RINGS = 8;
const grids = new WeakMap();

/**
 * Coarse nearest-centreline lookup, good enough for placing scenery. Every
 * 6th sample is bucketed into a grid so queries near the track (where all the
 * plants go) only look at a few cells; far-off points fall back to a full scan.
 */
function nearestOnTrack(path, x, z) {
  let grid = grids.get(path);
  if (!grid) {
    grid = new Map();
    for (let i = 0; i < path.n; i += 6) {
      const key = `${Math.floor(path.px[i] / GRID_CELL)},${Math.floor(path.pz[i] / GRID_CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    grids.set(path, grid);
  }
  let best = 0;
  let bestD = Infinity;
  const test = (i) => {
    const dx = x - path.px[i];
    const dz = z - path.pz[i];
    const d = dx * dx + dz * dz;
    if (d < bestD || (d === bestD && i < best)) { bestD = d; best = i; }
  };
  const gx = Math.floor(x / GRID_CELL);
  const gz = Math.floor(z / GRID_CELL);
  for (let r = 0; r <= GRID_RINGS; r++) {
    for (let cx = gx - r; cx <= gx + r; cx++) {
      for (let cz = gz - r; cz <= gz + r; cz++) {
        if (Math.max(Math.abs(cx - gx), Math.abs(cz - gz)) !== r) continue;
        const cell = grid.get(`${cx},${cz}`);
        if (cell) cell.forEach(test);
      }
    }
    // Anything outside ring r is at least r cells away
    if (bestD <= (r * GRID_CELL) ** 2) return { dist: Math.sqrt(bestD), y: path.py[best] };
  }
  for (let i = 0; i < path.n; i += 6) test(i);
  return { dist: Math.sqrt(bestD), y: path.py[best] };
}

/**
 * `alt` and `rock` are the secondary surfaces the terrain shader blends in:
 * `alt` in noisy patches, `rock` on steep slopes and high ground.
 */
const THEME_TERRAIN = {
  apex: {
    amp: 46, bias: -12, scale: 360, rim: 150, textures: grassTextures, repeat: 300,
    alt: dirtTextures, rock: stoneTextures, rockSlope: [0.78, 0.58], rockHeight: [170, 260]
  },
  desert: {
    amp: 78, bias: -14, scale: 300, rim: 210, textures: sandTextures, repeat: 240,
    alt: dirtTextures, rock: rockTextures, rockSlope: [0.86, 0.68], rockHeight: [120, 220]
  },
  city: { amp: 0, bias: 0, scale: 300, rim: 0, textures: concreteTextures, repeat: 400 }
};

/**
 * Splatted terrain: the base surface sampled at two scales (the coarse one
 * takes over with distance so tiling never shows), patches of `alt`, and
 * tri-planar `rock` on slopes so cliffs aren't smeared. Blend edges follow
 * the textures' own brightness, so grass gives way to dirt between the
 * pebbles rather than along a soft smudge. Per-vertex weights come in `aMix`.
 */
function terrainMaterial(theme, size) {
  const base = theme.textures();
  const alt = theme.alt();
  const rock = theme.rock();
  const normalMap = base.normalMap.clone();
  normalMap.repeat.set(theme.repeat, theme.repeat);
  normalMap.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, normalMap, normalScale: new THREE.Vector2(0.8, 0.8)
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tBase: { value: base.map }, tAlt: { value: alt.map }, tRock: { value: rock.map },
      uScale: { value: theme.repeat / size }
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute vec2 aMix;
        varying vec2 vMix;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainNormal;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vMix = aMix;
        vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform sampler2D tBase;
        uniform sampler2D tAlt;
        uniform sampler2D tRock;
        uniform float uScale;
        varying vec2 vMix;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainNormal;
        float terrainLuma(vec3 c) { return dot(c, vec3(0.333)); }
      `)
      .replace('#include <map_fragment>', /* glsl */ `
        vec2 wuv = vTerrainPos.xz * uScale;
        float far = smoothstep(20.0, 300.0, distance(vTerrainPos, cameraPosition)) * 0.8;
        vec3 sBase = mix(texture2D(tBase, wuv).rgb, texture2D(tBase, wuv * 0.19 + 0.37).rgb, far);
        vec3 sAlt = mix(texture2D(tAlt, wuv * 1.4).rgb, texture2D(tAlt, wuv * 0.23 + 0.11).rgb, far);
        vec3 tw = pow(abs(normalize(vTerrainNormal)), vec3(4.0));
        tw /= tw.x + tw.y + tw.z;
        vec3 rp = vTerrainPos * uScale * 0.3;
        vec3 sRock = texture2D(tRock, rp.zy).rgb * tw.x + texture2D(tRock, rp.xz).rgb * tw.y + texture2D(tRock, rp.xy).rgb * tw.z;
        float wAlt = smoothstep(0.42, 0.58, vMix.x + (terrainLuma(sAlt) - terrainLuma(sBase)) * 0.9);
        vec3 soil = mix(sBase, sAlt, wAlt);
        float wRock = smoothstep(0.42, 0.58, vMix.y + (terrainLuma(sRock) - terrainLuma(soil)) * 0.9);
        diffuseColor.rgb *= mix(soil, sRock, wRock);
      `);
  };
  mat.customProgramCacheKey = () => 'terrain';
  return { material: mat, textures: [normalMap] };
}

/**
 * Themed surroundings for a circuit: rolling terrain that meets the track
 * edges, plus trees / skyline / canyon dressing. Everything is positioned
 * relative to the centreline so nothing ever lands on the road.
 */
export function buildScenery(path, def, group, { mobile = false } = {}) {
  const rand = mulberry32(def.id.length * 977 + 13);
  // Phones get a thinner forest and fewer grass tufts
  const density = mobile ? 0.55 : 1;
  const wo = path.wallOffset;
  const theme = THEME_TERRAIN[def.theme] || THEME_TERRAIN.apex;
  const lookHooks = [];

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < path.n; i++) { cx += path.px[i]; cz += path.pz[i]; }
  cx /= path.n;
  cz /= path.n;

  // Height of the surrounding land: flat beside the track, hills further out
  const heightAt = (x, z) => {
    const near = nearestOnTrack(path, x, z);
    const base = near.y - 0.6;
    if (theme.amp === 0) return base;
    const blend = smoothstep(wo + 24, wo + 150, near.dist);
    const n = fbm(x / theme.scale + 40, z / theme.scale + 40, 5, 5);
    const rim = smoothstep(520, 1150, Math.hypot(x - cx, z - cz)) * theme.rim;
    return base + (n * theme.amp + theme.bias + rim) * blend;
  };

  // --- Terrain ---------------------------------------------------------
  {
    const size = 3000;
    const seg = 190;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = heightAt(x, z);
      pos.setY(i, y);
      // Broad tonal variation; the textures supply the actual colour
      const n = fbm(x / 90, z / 90, 3, 9);
      if (def.theme === 'apex') {
        c.setRGB(0.78 + n * 0.45, 0.82 + n * 0.38, 0.74 + n * 0.3);
      } else if (def.theme === 'desert') {
        c.setRGB(0.92 + n * 0.2, 0.84 + n * 0.2, 0.78 + n * 0.2);
        c.lerp(new THREE.Color(0.95, 0.66, 0.52), smoothstep(18, 90, y));
      } else {
        c.setRGB(0.2, 0.2, 0.22);
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    let terrain;
    if (theme.alt) {
      // Splat weights: alt surface in patches, rock where it's steep or high
      const nrm = geo.attributes.normal;
      const mix = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        // Bare patches only settle on gentle ground; on slopes they'd smear into streaks
        mix[i * 2] = smoothstep(0.56, 0.78, fbm(x / 45 + 7, z / 45 + 3, 4, 21)) * 0.75 * smoothstep(0.88, 0.96, nrm.getY(i));
        // Outcrops rather than whole hillsides: noise thins the rock out
        const crag = smoothstep(0.3, 0.7, fbm(x / 110 + 1, z / 110 + 5, 3, 33)) * 1.4;
        mix[i * 2 + 1] = Math.min(1, (smoothstep(theme.rockSlope[0], theme.rockSlope[1], nrm.getY(i))
          + smoothstep(theme.rockHeight[0], theme.rockHeight[1], pos.getY(i)) * 0.7) * crag);
      }
      geo.setAttribute('aMix', new THREE.BufferAttribute(mix, 2));
      const { material, textures } = terrainMaterial(theme, size);
      terrain = new THREE.Mesh(geo, material);
      terrain.userData.ownTextures = textures;
    } else {
      const map = theme.textures().map.clone();
      map.repeat.set(theme.repeat, theme.repeat);
      map.needsUpdate = true;
      terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 1 }));
      terrain.userData.ownTextures = [map];
    }
    terrain.receiveShadow = true;
    terrain.onBeforeRender = tickWind; // the terrain is always on screen, so it drives the wind clock
    group.add(terrain);
  }

  /**
   * Random spot `min..max` metres beyond the barrier that is clear of every part of the track.
   * `ground` is where it meets the surface: the run-off skirt near the barrier, terrain beyond.
   */
  const spotBesideTrack = (min, max, clearance) => {
    for (let tries = 0; tries < 12; tries++) {
      const s = rand() * path.length;
      const side = rand() < 0.5 ? -1 : 1;
      const off = wo + min + Math.pow(rand(), 1.6) * (max - min);
      const p = path.pointAt(s, side * off);
      if (nearestOnTrack(path, p.x, p.z).dist >= wo + clearance) {
        // Matches the verge profile in TrackBuilder: level to wo + 0.4, then sloping down
        const skirt = p.y - 0.004 - Math.max(0, off - wo - 0.4) * (0.946 / 27.6);
        const ground = Math.max(heightAt(p.x, p.z), skirt);
        return { x: p.x, z: p.z, s, side, heading: path.headingAt(s), ground };
      }
    }
    return null;
  };

  /**
   * Instanced plants split into a grid of blocks so the ones behind the
   * camera get frustum-culled. Same transform format as `instanced`.
   */
  const chunked = (geo, mat, transforms, opts = {}) => {
    const cell = 500;
    const blocks = new Map();
    for (const t of transforms) {
      const key = `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(t);
    }
    return [...blocks.values()].map((list) => instanced(geo, mat, list, opts));
  };

  const instanced = (geo, mat, transforms, { cast = true, color = null } = {}) => {
    const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    transforms.forEach((t, i) => {
      e.set(t.rx || 0, t.ry || 0, t.rz || 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1));
      mesh.setMatrixAt(i, m);
      if (color) mesh.setColorAt(i, color(t, i));
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Advertising boards facing the track, shared by every theme
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6, metalness: 0.5 });
    const count = Math.floor(path.length / 170);
    for (let i = 0; i < count; i++) {
      const s = 60 + i * 170 + rand() * 40;
      const side = i % 2 ? -1 : 1;
      const p = path.pointAt(s, side * (wo + 1.4));
      const board = new THREE.Group();
      board.position.copy(p);
      board.rotation.y = path.headingAt(s) - side * Math.PI / 2;
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 1.7),
        new THREE.MeshStandardMaterial({ map: bannerTexture(i), roughness: 0.5, side: THREE.DoubleSide })
      );
      face.position.y = 2.2;
      face.castShadow = true;
      board.add(face);
      for (const x of [-4, 4]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3, 0.15), postMat);
        post.position.set(x, 1.5, -0.1);
        board.add(post);
      }
      group.add(board);
    }
  }

  if (def.theme === 'apex') buildForest();
  if (def.theme === 'city') buildCity();
  if (def.theme === 'desert') buildCanyon();

  // --- Apex: trees and a grandstand -------------------------------------
  function buildForest() {
    const tint = new THREE.Color();
    // Two variants of each model; instances also vary in size, spin and squash
    const broadleafKinds = [broadleafModel(11), broadleafModel(29)];
    const coniferKinds = [coniferModel(5), coniferModel(17)];
    const broadleaf = [[], []];
    const conifers = [[], []];
    // Keep the forest as dense on a long circuit as on a short one
    const treeCount = Math.min(2400, Math.round(path.length * 0.45 * density));
    for (let i = 0; i < treeCount; i++) {
      const spot = spotBesideTrack(5, 260, 5);
      if (!spot) continue;
      const ry = rand() * Math.PI * 2;
      const v = rand() < 0.5 ? 0 : 1;
      if (rand() < 0.4) {
        const h = 10 + rand() * 9;
        const w = h * (0.85 + rand() * 0.25);
        conifers[v].push({ x: spot.x, y: spot.ground - 0.2, z: spot.z, sx: w, sy: h, sz: w, ry, tint: rand() });
      } else {
        const h = 8 + rand() * 7;
        const w = h * (0.9 + rand() * 0.3);
        broadleaf[v].push({ x: spot.x, y: spot.ground - 0.2, z: spot.z, sx: w, sy: h, sz: w * (0.85 + rand() * 0.3), ry, tint: rand() });
      }
    }

    // Thinner woods climbing the hills further out
    for (let i = 0; i < treeCount * 0.6; i++) {
      const spot = spotBesideTrack(260, 700, 200);
      if (!spot) continue;
      const h = 10 + rand() * 9;
      const w = h * (0.85 + rand() * 0.25);
      const list = rand() < 0.6 ? conifers : broadleaf;
      list[rand() < 0.5 ? 0 : 1].push({ x: spot.x, y: spot.ground - 0.2, z: spot.z, sx: w, sy: h, sz: w, ry: rand() * 6.3, tint: rand() });
    }

    const bark = barkMaterial();
    const leaves = foliageMaterial('leaf');
    const needles = foliageMaterial('needle', { sway: 0.03, flutter: 0.002 });
    const leafTint = (t) => (t.tint > 0.94
      ? tint.setHSL(0.13 + t.tint * 0.02, 0.55, 0.36) // the odd tree already turning
      : tint.setHSL(0.2 + t.tint * 0.08, 0.38 + t.tint * 0.12, 0.2 + t.tint * 0.1)).clone();
    const needleTint = (t) => tint.setHSL(0.3 + t.tint * 0.06, 0.35, 0.2 + t.tint * 0.1).clone();
    broadleafKinds.forEach((model, k) => {
      chunked(model.wood, bark, broadleaf[k]);
      chunked(model.leaves, leaves, broadleaf[k], { color: leafTint });
    });
    coniferKinds.forEach((model, k) => {
      chunked(model.wood, bark, conifers[k]);
      chunked(model.leaves, needles, conifers[k], { color: needleTint });
    });

    // Undergrowth: bushes under the canopy and grass tufts on the verges
    const bushes = [];
    for (let i = 0; i < treeCount * 0.7; i++) {
      const spot = spotBesideTrack(2, 200, 2);
      if (!spot) continue;
      const s = 1 + rand() * 1.6;
      bushes.push({ x: spot.x, y: spot.ground - 0.15, z: spot.z, sx: s * 1.6, sy: s, sz: s * 1.4, ry: rand() * 6.3, tint: rand() });
    }
    chunked(bushModel(3).leaves, leaves, bushes, { color: leafTint });

    const tufts = [];
    for (let i = 0; i < 22000 * density; i++) {
      const spot = spotBesideTrack(0.6, 90, 0.6);
      if (!spot) continue;
      const s = 0.5 + rand() * 0.6;
      tufts.push({ x: spot.x, y: spot.ground - 0.03, z: spot.z, sx: s * 1.3, sy: s * (0.6 + rand() * 0.6), sz: s * 1.3, ry: rand() * 6.3, tint: rand() });
    }
    const grass = foliageMaterial('grass', { base: 0, sway: 0.12, flutter: 0.01 });
    chunked(tuftModel().leaves, grass, tufts, {
      cast: false, color: (t) => tint.setHSL(0.2 + t.tint * 0.06, 0.4, 0.27 + t.tint * 0.1).clone()
    });

    // Grandstand on the outside of the main straight
    const standLen = 110;
    const profile = new THREE.Shape();
    // Cross-section in local (x, y): steps climb away from the track, which lies towards +X
    profile.moveTo(0, 0);
    profile.lineTo(0, 2.2);
    for (let i = 0; i < 9; i++) {
      profile.lineTo(-(i * 1.3 + 1.3), 2.2 + i * 0.9);
      profile.lineTo(-(i * 1.3 + 1.3), 2.2 + (i + 1) * 0.9);
    }
    profile.lineTo(-11.7, 0);
    const standGeo = new THREE.ExtrudeGeometry(profile, { depth: standLen, bevelEnabled: false });
    const concrete = concreteTextures();
    const stand = new THREE.Mesh(standGeo, new THREE.MeshStandardMaterial({ map: concrete.map, color: 0xb9bcc2, roughness: 0.85 }));
    const base = path.pointAt(40, -(wo + 5));
    stand.position.copy(base);
    stand.rotation.y = path.headingAt(40);
    stand.castShadow = true;
    stand.receiveShadow = true;
    group.add(stand);

    const crowd = [];
    const crowdTint = new THREE.Color();
    for (let row = 0; row < 9; row++) {
      for (let k = 0; k < 150; k++) {
        if (rand() < 0.25) continue;
        crowd.push({
          lx: -(row * 1.3 + 0.75), ly: 2.2 + row * 0.9 + 0.31, lz: 1 + k * (standLen - 2) / 150, tint: rand()
        });
      }
    }
    const standMatrix = new THREE.Matrix4().compose(
      base, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), path.headingAt(40)), new THREE.Vector3(1, 1, 1)
    );
    const v = new THREE.Vector3();
    instanced(new THREE.BoxGeometry(0.42, 0.62, 0.3), new THREE.MeshStandardMaterial({ roughness: 0.9 }), crowd.map((p) => {
      v.set(p.lx, p.ly, p.lz).applyMatrix4(standMatrix);
      return { x: v.x, y: v.y, z: v.z, ry: path.headingAt(40), tint: p.tint };
    }), { cast: false, color: (t) => crowdTint.setHSL(t.tint, 0.5, 0.12 + (t.tint * 7 % 1) * 0.3).clone() });

    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.3, standLen),
      new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.4, roughness: 0.4 })
    );
    v.set(-6.5, 13.4, standLen / 2).applyMatrix4(standMatrix);
    roof.position.copy(v);
    roof.rotation.y = path.headingAt(40);
    roof.rotation.z = 0.08;
    roof.castShadow = true;
    group.add(roof);
  }

  // --- City: skyline, street lamps, neon ---------------------------------
  function buildCity() {
    const tex = buildingTextures();
    const placed = [];
    const boxes = [];
    const signs = [];
    const signPalette = [[1.9, 0.2, 1.1], [0.12, 1.5, 2.0], [2.0, 1.3, 0.2], [0.9, 0.4, 2.2], [0.2, 1.9, 0.7]];

    const addBuilding = (x, z, heading, w, d, h, frontSide) => {
      const radius = Math.hypot(w, d) / 2;
      if (nearestOnTrack(path, x, z).dist < wo + 3 + radius) return false;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + radius + 2)) return false;
      placed.push({ x, z, r: radius });

      const geo = new THREE.BoxGeometry(w, h, d);
      const uv = geo.attributes.uv;
      const ou = Math.floor(rand() * 8) / 8;
      const ov = Math.floor(rand() * 16) / 16;
      // Faces in BoxGeometry order: +x, -x, +y, -y, +z, -z (4 verts each)
      for (let f = 0; f < 6; f++) {
        const span = f < 2 ? d : w;
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          if (f === 2 || f === 3) uv.setXY(i, 0.01, 0.01);
          else uv.setXY(i, ou + uv.getX(i) * Math.round(span / 3.2) / 8, ov + uv.getY(i) * Math.round(h / 3.6) / 16);
        }
      }
      geo.rotateY(heading);
      geo.translate(x, h / 2 - 1, z);
      boxes.push(geo);

      // The occasional neon sign on the facade that faces the road
      if (frontSide && rand() < 0.45) {
        const sw = 3 + rand() * 6;
        const sh = 1.2 + rand() * 2.5;
        const sign = new THREE.PlaneGeometry(sw, sh);
        const col = signPalette[Math.floor(rand() * signPalette.length)];
        sign.setAttribute('color', new THREE.BufferAttribute(new Float32Array([...col, ...col, ...col, ...col]), 3));
        sign.rotateY(heading - frontSide * Math.PI / 2);
        const out = d / 2 + 0.15;
        sign.translate(
          x - frontSide * Math.cos(heading) * out,
          6 + rand() * Math.min(30, h * 0.5),
          z + frontSide * Math.sin(heading) * out
        );
        signs.push(sign);
      }
      return true;
    };

    // Front row hugging the street, aligned to it
    for (let s = 0; s < path.length; s += 9) {
      for (const side of [-1, 1]) {
        if (rand() < 0.3) continue;
        const w = 16 + rand() * 20;
        const d = 16 + rand() * 18;
        const h = 22 + Math.pow(rand(), 2) * 90;
        const p = path.pointAt(s, side * (wo + 7 + d / 2 + rand() * 6));
        addBuilding(p.x, p.z, path.headingAt(s), w, d, h, side);
      }
    }
    // Towers behind for depth
    for (let i = 0; i < 420; i++) {
      const spot = spotBesideTrack(60, 480, 50);
      if (!spot) continue;
      const w = 24 + rand() * 30;
      addBuilding(spot.x, spot.z, rand() * Math.PI, w, w * (0.7 + rand() * 0.6), 60 + Math.pow(rand(), 1.5) * 210, 0);
    }

    const towerMat = new THREE.MeshStandardMaterial({
      map: tex.map, emissiveMap: tex.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.4, metalness: 0.55
    });
    const towers = new THREE.Mesh(mergeGeometries(boxes), towerMat);
    towers.castShadow = true;
    towers.receiveShadow = true;
    group.add(towers);
    boxes.forEach((g) => g.dispose());

    if (signs.length) {
      const signMesh = new THREE.Mesh(
        mergeGeometries(signs),
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      );
      group.add(signMesh);
      signs.forEach((g) => g.dispose());
      lookHooks.push((look) => { signMesh.visible = look.night || look.headlights; });
    }

    // Street lamps: emissive heads plus a fake pool of light on the road
    const poles = [];
    const heads = [];
    const pools = [];
    let k = 0;
    for (let s = 10; s < path.length - 20; s += 38) {
      const side = k++ % 2 ? -1 : 1;
      const heading = path.headingAt(s);
      const foot = path.pointAt(s, side * (wo + 0.9));
      const head = path.pointAt(s, side * (wo - 2.2));
      poles.push({ x: foot.x, y: foot.y + 4.4, z: foot.z, sy: 8.8 });
      heads.push({ x: (foot.x + head.x) / 2, y: foot.y + 8.7, z: (foot.z + head.z) / 2, ry: heading, sx: 3.4 });
      pools.push({ x: head.x, y: head.y + 0.03, z: head.z, s: 15 });
    }
    instanced(new THREE.CylinderGeometry(0.09, 0.13, 1, 6), new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.7, roughness: 0.4 }), poles);
    const headMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    instanced(new THREE.BoxGeometry(1, 0.14, 0.4), headMat, heads, { cast: false });
    const poolMat = new THREE.MeshBasicMaterial({
      map: radialTexture(), color: 0xffc98a, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4
    });
    const poolMesh = instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, pools, { cast: false });
    poolMesh.receiveShadow = false;

    lookHooks.push((look) => {
      const lit = look.night || look.headlights;
      towerMat.emissiveIntensity = look.night ? 1.25 : lit ? 0.7 : 0.04;
      headMat.color.setRGB(lit ? 2.6 : 0.5, lit ? 2.0 : 0.5, lit ? 1.2 : 0.5);
      poolMesh.visible = lit;
      poolMat.opacity = look.night ? 0.34 : 0.14;
    });
  }

  // --- Desert: mesas, boulders, cacti ------------------------------------
  function buildCanyon() {
    const rock = rockTextures();
    const rockMat = new THREE.MeshStandardMaterial({ map: rock.map, normalMap: rock.normalMap, roughness: 0.95, flatShading: true });
    const mesas = [];
    for (let i = 0; i < 70; i++) {
      const spot = spotBesideTrack(34, 520, 34);
      if (!spot) continue;
      const r = 18 + rand() * 46;
      if (nearestOnTrack(path, spot.x, spot.z).dist < wo + r + 12) continue;
      const h = 22 + rand() * 70;
      const geo = new THREE.CylinderGeometry(r, r, h, 18, 16);
      const p = geo.attributes.position;
      const seed = Math.floor(rand() * 1000);
      // Stepped profile: sheer bands of cliff separated by ledges, on a scree apron
      const steps = 2 + Math.floor(rand() * 3);
      const shelf = 0.18 + rand() * 0.14;
      for (let v = 0; v < p.count; v++) {
        const ang = Math.atan2(p.getZ(v), p.getX(v));
        const t = p.getY(v) / h + 0.5;
        const band = Math.min(steps - 1, Math.floor(t * steps));
        const profile = 1 - shelf * band - (t * steps - band) * 0.05 + (1 - smoothstep(0, 0.2, t)) * 0.35;
        const k = 0.78 + fbm(ang * 1.3 + 9, p.getY(v) / 26 + 3, 3, seed, 64) * 0.5
          + (fbm(ang * 7 + 3, t * 2, 2, seed + 5) - 0.5) * 0.16; // gullies
        p.setX(v, p.getX(v) * k * profile);
        p.setZ(v, p.getZ(v) * k * profile);
      }
      const uv = geo.attributes.uv;
      for (let v = 0; v < uv.count; v++) uv.setXY(v, uv.getX(v) * Math.round(r / 6), uv.getY(v) * (h / 40));
      geo.rotateY(rand() * Math.PI * 2);
      // Sit on the lowest ground under the footprint so no edge is left floating
      let floor = heightAt(spot.x, spot.z);
      for (let a = 0; a < 6; a++) {
        floor = Math.min(floor, heightAt(spot.x + Math.cos(a) * r * 1.3, spot.z + Math.sin(a) * r * 1.3));
      }
      geo.translate(spot.x, floor + h / 2 - 3, spot.z);
      mesas.push(geo);
    }
    if (mesas.length) {
      const merged = mergeGeometries(mesas);
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, rockMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      mesas.forEach((g) => g.dispose());
    }

    const boulders = [];
    const cacti = [];
    for (let i = 0; i < 520; i++) {
      const spot = spotBesideTrack(3, 150, 3);
      if (!spot) continue;
      const y = heightAt(spot.x, spot.z);
      if (rand() < 0.6) {
        const s = 0.5 + Math.pow(rand(), 2) * 3.2;
        boulders.push({ x: spot.x, y: y + s * 0.25, z: spot.z, sx: s, sy: s * (0.55 + rand() * 0.4), sz: s * (0.7 + rand() * 0.6), ry: rand() * 6.3, rx: rand() * 0.5 });
      } else {
        cacti.push({ x: spot.x, y: y - 0.1, z: spot.z, s: 0.8 + rand() * 0.9, ry: rand() * 6.3 });
      }
    }
    instanced(new THREE.DodecahedronGeometry(1, 0), rockMat, boulders);

    const trunk = new THREE.CylinderGeometry(0.22, 0.26, 3.4, 8).translate(0, 1.7, 0);
    const armA = new THREE.CylinderGeometry(0.15, 0.15, 1.3, 7).translate(0.72, 2.25, 0);
    const elbowA = new THREE.CylinderGeometry(0.15, 0.15, 0.6, 7).rotateZ(Math.PI / 2).translate(0.42, 1.65, 0);
    const armB = new THREE.CylinderGeometry(0.14, 0.14, 0.9, 7).translate(-0.62, 1.75, 0);
    const elbowB = new THREE.CylinderGeometry(0.14, 0.14, 0.5, 7).rotateZ(Math.PI / 2).translate(-0.38, 1.35, 0);
    const cactusGeo = mergeGeometries([trunk, armA, elbowA, armB, elbowB]);
    instanced(cactusGeo, new THREE.MeshStandardMaterial({ color: 0x4f7a43, roughness: 0.9 }), cacti);

    // Sage scrub and dry bunch grass scattered over the sand
    const tint = new THREE.Color();
    const bushes = [];
    for (let i = 0; i < 900 * density; i++) {
      const spot = spotBesideTrack(1.5, 220, 1.5);
      if (!spot) continue;
      const s = 0.9 + Math.pow(rand(), 1.5) * 1.8;
      bushes.push({ x: spot.x, y: spot.ground - 0.1, z: spot.z, sx: s * 1.4, sy: s, sz: s * 1.3, ry: rand() * 6.3, tint: rand() });
    }
    chunked(bushModel(7).leaves, foliageMaterial('scrub', { sway: 0.03 }), bushes, {
      color: (t) => tint.setHSL(0.12 + t.tint * 0.08, 0.12 + t.tint * 0.1, 0.42 + t.tint * 0.14).clone()
    });
    const tufts = [];
    for (let i = 0; i < 7000 * density; i++) {
      const spot = spotBesideTrack(0.6, 120, 0.6);
      if (!spot) continue;
      const s = 0.4 + rand() * 0.5;
      tufts.push({ x: spot.x, y: spot.ground - 0.03, z: spot.z, sx: s * 1.3, sy: s * (0.7 + rand() * 0.5), sz: s * 1.3, ry: rand() * 6.3, tint: rand() });
    }
    chunked(tuftModel().leaves, foliageMaterial('grass', { base: 0, sway: 0.1, flutter: 0.008 }), tufts, {
      cast: false, color: (t) => tint.setHSL(0.07 + t.tint * 0.03, 0.7, 0.5 + t.tint * 0.15).clone()
    });
  }

  const setLook = (look) => lookHooks.forEach((fn) => fn(look));
  return { setLook, heightAt };
}
