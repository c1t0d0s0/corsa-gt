import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, foliageTexture, barkTextures } from './ProceduralTextures.js';

/**
 * Plant models built from alpha-cut foliage cards. Every model is unit sized
 * (height 1, base at the origin) so instances set the real size, and comes as
 * a `wood` geometry (bark) and/or a `leaves` geometry (cards).
 *
 * Leaf cards carry normals pointing out of the crown rather than off the card,
 * so a crown shades as one soft volume instead of a pile of flat planes, and a
 * vertex colour that darkens the inside of the crown.
 */

const wind = { value: 0 };

/** Collects quads into one geometry. */
class CardBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
  }

  /** corners: 4 points (bl, br, tr, tl); normalAt(p) and shadeAt(p) per corner. */
  quad(corners, normalAt, shadeAt, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = corners[k];
      const n = normalAt(p);
      const s = shadeAt(p);
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(uvs[k][0], uvs[k][1]);
      this.col.push(s, s, s);
    }
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return geo;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Random unit vector perpendicular to `n`. */
function perpendicular(n, rand) {
  const a = Math.abs(n.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3().crossVectors(n, a).normalize();
  return t.applyAxisAngle(n, rand() * Math.PI * 2);
}

/** Tapered limb from `a` to `b`, with bark uv running along it. */
function limb(a, b, r0, r1, sides = 6) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * len * 3);
  geo.translate(0, len / 2, 0);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  geo.translate(a.x, a.y, a.z);
  return geo;
}

/** Spray of square cards around `centre`, facing out of the crown at `crown`. */
function crownCards(cards, rand, { crown, radii, clumps, perClump, size, spread }) {
  const radial = (p) => new THREE.Vector3().subVectors(p, crown).divide(radii);
  const normalAt = (p) => radial(p).normalize().add(new THREE.Vector3(0, 0.25, 0)).normalize();
  // Darker towards the core and underneath: cheap ambient occlusion
  const shadeAt = (p) => {
    const r = radial(p);
    return THREE.MathUtils.clamp(0.35 + r.length() * 0.5 + r.y * 0.2, 0.25, 1.05);
  };
  for (const c of clumps) {
    for (let k = 0; k < perClump; k++) {
      const centre = c.clone().add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(spread));
      const facing = radial(centre).normalize()
        .add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(1.2)).normalize();
      const s = size * (0.8 + rand() * 0.4);
      const u = perpendicular(facing, rand).multiplyScalar(s / 2);
      const v = new THREE.Vector3().crossVectors(facing, u);
      cards.quad([
        centre.clone().sub(u).sub(v), centre.clone().add(u).sub(v),
        centre.clone().add(u).add(v), centre.clone().sub(u).add(v)
      ], normalAt, shadeAt);
    }
  }
}

/** Deciduous tree: forked trunk, a few main limbs and a lumpy crown of leaf sprays. */
export function broadleafModel(seed) {
  const rand = mulberry32(seed);
  const lean = new THREE.Vector3((rand() - 0.5) * 0.08, 0, (rand() - 0.5) * 0.08);
  const fork = new THREE.Vector3(lean.x, 0.33 + rand() * 0.07, lean.z);
  const wood = [limb(new THREE.Vector3(0, -0.05, 0), fork, 0.034, 0.024, 8)];
  const crown = new THREE.Vector3(lean.x * 1.5, 0.6, lean.z * 1.5);
  const radii = new THREE.Vector3(0.33 + rand() * 0.05, 0.3 + rand() * 0.05, 0.33 + rand() * 0.05);
  const clumps = [];

  const limbs = 4 + Math.floor(rand() * 2);
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rand() * 0.8;
    const start = fork.clone().add(new THREE.Vector3(0, (rand() - 0.7) * 0.08, 0));
    const dir = new THREE.Vector3(Math.cos(a) * 0.75, 0.6 + rand() * 0.35, Math.sin(a) * 0.75).normalize();
    const end = start.clone().addScaledVector(dir, 0.24 + rand() * 0.1);
    wood.push(limb(start, end, 0.016, 0.006, 5));
    // A twig off each limb gives the bare inside of the crown some structure
    const mid = start.clone().lerp(end, 0.55);
    const twigEnd = mid.clone().add(new THREE.Vector3(rand() - 0.5, 0.6, rand() - 0.5).normalize().multiplyScalar(0.12));
    wood.push(limb(mid, twigEnd, 0.007, 0.003, 4));
    clumps.push(end, twigEnd);
  }
  // Fill out the silhouette, biased upward so the crown has a rounded top
  for (let i = 0; i < 11; i++) {
    const d = new THREE.Vector3(rand() - 0.5, rand() * 1.1 - 0.35, rand() - 0.5).normalize();
    clumps.push(crown.clone().add(d.multiply(radii).multiplyScalar(0.55 + rand() * 0.3)));
  }

  const cards = new CardBuilder();
  crownCards(cards, rand, { crown, radii, clumps, perClump: 4, size: 0.28, spread: 0.14 });
  // A few big dim cards in the core stop the crown looking hollow through gaps
  crownCards(cards, rand, { crown, radii, clumps: [crown], perClump: 4, size: 0.4, spread: 0.12 });

  const merged = mergeGeometries(wood);
  wood.forEach((g) => g.dispose());
  return { wood: merged, leaves: cards.build() };
}

/** Conifer: a straight trunk ringed with drooping boughs, each a pair of crossed cards. */
export function coniferModel(seed) {
  const rand = mulberry32(seed);
  const wood = limb(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, 0.97, 0), 0.022, 0.004, 7);
  const cards = new CardBuilder();
  const normalAt = (p) => new THREE.Vector3(p.x, 0, p.z).normalize().add(new THREE.Vector3(0, 0.55, 0)).normalize();

  const levels = 12;
  for (let l = 0; l < levels; l++) {
    const t = l / (levels - 1);
    const y = 0.12 + Math.pow(t, 0.9) * 0.78;
    const len = 0.05 + 0.24 * Math.pow(1 - t, 1.05) * (0.85 + rand() * 0.3);
    const boughs = t > 0.75 ? 4 : 6;
    const shadeAt = (p) => 0.45 + Math.min(1, Math.hypot(p.x, p.z) / len) * 0.5 + t * 0.1;
    for (let b = 0; b < boughs; b++) {
      const a = (b / boughs) * Math.PI * 2 + l * 2.4 + rand() * 0.5;
      const dir = new THREE.Vector3(Math.cos(a), -0.3 - (1 - t) * 0.25, Math.sin(a)).normalize();
      const p0 = new THREE.Vector3(0, y, 0).addScaledVector(dir, 0.01);
      const p1 = p0.clone().addScaledVector(dir, len);
      const flat = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      for (const tilt of [-0.75, 0.75]) {
        const side = flat.clone().applyAxisAngle(dir, tilt).multiplyScalar(len * 0.42);
        cards.quad(
          [p0.clone().sub(side), p1.clone().sub(side), p1.clone().add(side), p0.clone().add(side)],
          normalAt, shadeAt, [[0, 0], [1, 0], [1, 1], [0, 1]]
        );
      }
    }
  }
  // Leader at the very top
  for (const a of [0, Math.PI / 2]) {
    const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.04);
    const p0 = new THREE.Vector3(0, 0.86, 0);
    const p1 = new THREE.Vector3(0, 1.0, 0);
    cards.quad([p0.clone().sub(side), p1.clone().sub(side), p1.clone().add(side), p0.clone().add(side)],
      () => UP, () => 1, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  return { wood, leaves: cards.build() };
}

/** Low, round scrub bush: just a crown of sparse cards sitting on the ground. */
export function bushModel(seed) {
  const rand = mulberry32(seed);
  const crown = new THREE.Vector3(0, 0.42, 0);
  const radii = new THREE.Vector3(0.62, 0.45, 0.62);
  const clumps = [];
  for (let i = 0; i < 7; i++) {
    const d = new THREE.Vector3(rand() - 0.5, rand() * 0.9 - 0.2, rand() - 0.5).normalize();
    clumps.push(crown.clone().add(d.multiply(radii).multiplyScalar(0.5)));
  }
  const cards = new CardBuilder();
  crownCards(cards, rand, { crown, radii, clumps, perClump: 3, size: 0.75, spread: 0.3 });
  return { leaves: cards.build() };
}

/** Grass tuft: three blades cards crossed in a star. */
export function tuftModel() {
  const cards = new CardBuilder();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const h = new THREE.Vector3(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
    cards.quad(
      [h.clone().negate(), h.clone(), h.clone().setY(1), h.clone().negate().setY(1)],
      // Point normals mostly up so tufts light like the ground they stand on
      (p) => new THREE.Vector3(p.x * 0.4, 1, p.z * 0.4).normalize(),
      (p) => 0.55 + p.y * 0.5
    );
  }
  return { leaves: cards.build() };
}

/**
 * Wind: the whole plant leans with a slow gust that drifts across the map,
 * and leaves flutter on top of that. Bending grows with height above `base`.
 */
function addWind(shader, { base, sway, flutter }) {
  shader.uniforms.windTime = wind;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float windTime;')
    .replace('#include <begin_vertex>', /* glsl */ `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 windAt = instanceMatrix[3].xz;
      #else
        vec2 windAt = vec2(0.0);
      #endif
      float windPhase = dot(windAt, vec2(0.021, 0.013));
      float bend = max(position.y - ${base.toFixed(2)}, 0.0);
      float gust = sin(windTime * 0.9 + windPhase) * 0.7 + sin(windTime * 2.3 + windPhase * 1.7) * 0.3;
      transformed.xz += vec2(0.8, 0.45) * gust * bend * bend * ${sway.toFixed(3)};
      transformed += sin(windTime * 7.0 + dot(position, vec3(31.0, 17.0, 23.0)) + windPhase) * ${flutter.toFixed(4)} * bend;
    `);
}

/**
 * Foliage card material. Alpha-to-coverage gives soft cut-outs under MSAA, and
 * alpha is boosted on distant mips so far-off crowns don't thin to nothing.
 */
export function foliageMaterial(kind, { sway = 0.05, flutter = 0.004, base = 0.2 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: foliageTexture(kind),
    alphaTest: 0.42,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.82
  });
  mat.onBeforeCompile = (shader) => {
    addWind(shader, { base, sway, flutter });
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>
        vec2 texel = vMapUv * 256.0;
        float mip = 0.5 * log2(max(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel))), 1.0));
        diffuseColor.a *= 1.0 + mip * 0.35;
      `)
      // Both faces of a card share the crown normal; don't flip it for back faces
      .replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  mat.customProgramCacheKey = () => `foliage-${base}-${sway}-${flutter}`;
  return mat;
}

export function barkMaterial({ sway = 0.05, base = 0.2 } = {}) {
  const bark = barkTextures();
  const mat = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughness: 0.95 });
  mat.onBeforeCompile = (shader) => addWind(shader, { base, sway, flutter: 0 });
  mat.customProgramCacheKey = () => `bark-${base}-${sway}`;
  return mat;
}

/** Advance the shared wind clock; hook onto any one mesh's onBeforeRender. */
export function tickWind() {
  wind.value = performance.now() / 1000;
}
