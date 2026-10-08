import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  mulberry32, fbm, grassTextures, sandTextures, concreteTextures, rockTextures,
  buildingTextures, radialTexture, bannerTexture
} from './ProceduralTextures.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Coarse nearest-centreline lookup, good enough for placing scenery. */
function nearestOnTrack(path, x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.n; i += 6) {
    const dx = x - path.px[i];
    const dz = z - path.pz[i];
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { dist: Math.sqrt(bestD), y: path.py[best] };
}

const THEME_TERRAIN = {
  apex: { amp: 46, bias: -12, scale: 360, rim: 150, textures: grassTextures, repeat: 300 },
  desert: { amp: 78, bias: -14, scale: 300, rim: 210, textures: sandTextures, repeat: 240 },
  city: { amp: 0, bias: 0, scale: 300, rim: 0, textures: concreteTextures, repeat: 400 }
};

/**
 * Themed surroundings for a circuit: rolling terrain that meets the track
 * edges, plus trees / skyline / canyon dressing. Everything is positioned
 * relative to the centreline so nothing ever lands on the road.
 */
export function buildScenery(path, def, group) {
  const rand = mulberry32(def.id.length * 977 + 13);
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
      const n = fbm(x / 90, z / 90, 3, 9);
      if (def.theme === 'apex') {
        c.setRGB(0.72 + n * 0.5, 0.86 + n * 0.3, 0.7 + n * 0.3);
        if (y > 55) c.lerp(new THREE.Color(0.75, 0.74, 0.72), smoothstep(55, 120, y));
      } else if (def.theme === 'desert') {
        c.setRGB(0.92 + n * 0.2, 0.84 + n * 0.2, 0.78 + n * 0.2);
        c.lerp(new THREE.Color(0.85, 0.55, 0.42), smoothstep(18, 90, y));
      } else {
        c.setRGB(0.2, 0.2, 0.22);
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = theme.textures();
    const map = tex.map.clone();
    map.repeat.set(theme.repeat, theme.repeat);
    map.needsUpdate = true;
    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 1 }));
    terrain.receiveShadow = true;
    terrain.userData.ownTextures = [map];
    group.add(terrain);
  }

  /** Random spot `min..max` metres beyond the barrier that is clear of every part of the track. */
  const spotBesideTrack = (min, max, clearance) => {
    for (let tries = 0; tries < 12; tries++) {
      const s = rand() * path.length;
      const side = rand() < 0.5 ? -1 : 1;
      const off = wo + min + Math.pow(rand(), 1.6) * (max - min);
      const p = path.pointAt(s, side * off);
      if (nearestOnTrack(path, p.x, p.z).dist >= wo + clearance) {
        return { x: p.x, z: p.z, s, side, heading: path.headingAt(s) };
      }
    }
    return null;
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
    const trunks = [];
    const broadleaf = [];
    const pines = [];
    for (let i = 0; i < 900; i++) {
      const spot = spotBesideTrack(5, 260, 5);
      if (!spot) continue;
      const y = heightAt(spot.x, spot.z) - 0.2;
      const h = 5 + rand() * 6;
      const ry = rand() * Math.PI * 2;
      trunks.push({ x: spot.x, y: y + h * 0.25, z: spot.z, sx: 0.5 + h * 0.03, sy: h * 0.5, sz: 0.5 + h * 0.03 });
      if (rand() < 0.4) {
        pines.push({ x: spot.x, y: y + h * 0.75, z: spot.z, sx: h * 0.3, sy: h, sz: h * 0.3, ry, tint: rand() });
      } else {
        // A main crown plus a couple of smaller clumps so no two trees share a silhouette
        const r = h * 0.4;
        const tint = rand();
        const cy = y + h * 0.5 + r * 0.6;
        broadleaf.push({ x: spot.x, y: cy, z: spot.z, sx: r, sy: r * (0.8 + rand() * 0.35), sz: r, ry, tint });
        for (let c = 0; c < 2; c++) {
          const a = rand() * Math.PI * 2;
          const cr = r * (0.55 + rand() * 0.25);
          broadleaf.push({
            x: spot.x + Math.cos(a) * r * 0.6, y: cy - r * 0.15 + rand() * r * 0.5, z: spot.z + Math.sin(a) * r * 0.6,
            sx: cr, sy: cr * 0.85, sz: cr, ry: rand() * 6.3, tint: tint + (rand() - 0.5) * 0.15
          });
        }
      }
    }
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 6);
    instanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 1 }), trunks);

    // Lumpy canopy: a jittered icosphere reads as foliage once lit
    let canopy = new THREE.IcosahedronGeometry(1, 2);
    canopy.deleteAttribute('normal');
    canopy.deleteAttribute('uv');
    canopy = mergeVertices(canopy); // weld so the jitter stays watertight and shading is smooth
    const cp = canopy.attributes.position;
    const jr = mulberry32(3);
    for (let i = 0; i < cp.count; i++) {
      const k = 0.8 + jr() * 0.4;
      cp.setXYZ(i, cp.getX(i) * k, cp.getY(i) * k, cp.getZ(i) * k);
    }
    canopy.computeVertexNormals();
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    const tint = new THREE.Color();
    instanced(canopy, leafMat, broadleaf, {
      color: (t) => tint.setHSL(0.26 + t.tint * 0.07, 0.55, 0.13 + t.tint * 0.08).clone()
    });
    const pineGeo = new THREE.ConeGeometry(1, 1, 7, 3);
    instanced(pineGeo, leafMat, pines, {
      color: (t) => tint.setHSL(0.36 + t.tint * 0.04, 0.5, 0.07 + t.tint * 0.05).clone()
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
      const geo = new THREE.CylinderGeometry(r * (0.55 + rand() * 0.25), r, h, 11, 5);
      const p = geo.attributes.position;
      const seed = Math.floor(rand() * 1000);
      for (let v = 0; v < p.count; v++) {
        const ang = Math.atan2(p.getZ(v), p.getX(v));
        const k = 0.78 + fbm(ang * 1.3 + 9, p.getY(v) / 26 + 3, 3, seed, 64) * 0.5;
        p.setX(v, p.getX(v) * k);
        p.setZ(v, p.getZ(v) * k);
      }
      const uv = geo.attributes.uv;
      for (let v = 0; v < uv.count; v++) uv.setXY(v, uv.getX(v) * Math.round(r / 6), uv.getY(v) * (h / 40));
      geo.rotateY(rand() * Math.PI * 2);
      geo.translate(spot.x, heightAt(spot.x, spot.z) + h / 2 - 3, spot.z);
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
  }

  const setLook = (look) => lookHooks.forEach((fn) => fn(look));
  return { setLook, heightAt };
}
