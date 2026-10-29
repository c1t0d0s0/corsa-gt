import * as THREE from 'three';
import { radialTexture } from './ProceduralTextures.js';
import { CAR_SPECS } from './CarSpecs.js';

// Car space: +Z forward, +X left, origin on the ground under the CG. Shapes come from CarSpecs.js.
const RING_SUB = 3; // smoothing subdivisions between cross-section control points

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;

/** Catmull-Rom through [z, value] pairs sorted by descending z. */
function spline1(pts, z) {
  if (z >= pts[0][0]) return pts[0][1];
  const last = pts.length - 1;
  if (z <= pts[last][0]) return pts[last][1];
  let i = 0;
  while (z < pts[i + 1][0]) i++;
  const p0 = pts[Math.max(0, i - 1)][1];
  const p1 = pts[i][1];
  const p2 = pts[i + 1][1];
  const p3 = pts[Math.min(last, i + 2)][1];
  const t = (z - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}

/** How far into the greenhouse station z is: 0 on the bonnet and boot, 1 under the roof. */
function greenhouse(b, z) {
  return Math.min(
    clamp01((b.windshield[0] - z) / (b.windshield[0] - b.windshield[1])),
    clamp01((z - b.backlight[1]) / (b.backlight[0] - b.backlight[1]))
  );
}

/**
 * Half cross-section of the body at station z, from the underside centre (0)
 * up and over to the roof centre (12).
 */
function section(b, z) {
  const tF = clamp01((z - (b.zf - b.nose.length)) / b.nose.length);
  const tR = clamp01((b.zr + b.tail.length - z) / b.tail.length);

  let arch = 0;
  for (const wz of [b.wheelZ.front, b.wheelZ.rear]) {
    const dz = Math.abs(z - wz);
    if (dz < b.archR) arch = Math.max(arch, Math.sqrt(b.archR * b.archR - dz * dz));
  }

  const w = b.halfWidth * (1 - b.nose.taper * Math.pow(tF, b.nose.power)) * (1 - b.tail.taper * tR * tR) + (arch > 0 ? 0.012 : 0);
  const yb = b.groundClear + b.nose.rise * tF * tF + b.tail.rise * Math.pow(tR, 1.5);
  const belt = spline1(b.belt, z);
  const g = greenhouse(b, z);
  const top = belt + 0.015 + g * (spline1(b.roof, z) - belt - 0.015);
  const gh = top - belt;
  const ya = Math.max(yb, arch > 0 ? b.wheelR + arch : 0);
  const xi = w - 0.3;
  const wr = lerp(w - b.shoulderInset, b.roofWidth * (w / b.halfWidth), g);

  const p7 = [w - 0.05, belt + Math.min(0.03, gh * 0.3)];
  const p9 = [wr, top - Math.min(0.045, gh * 0.3)];
  const ctrl = [
    [0, yb],
    [xi, yb],
    [xi, ya],
    [w - 0.03, ya],
    [w, ya + (belt - ya) * 0.3],
    [w + 0.008, ya + (belt - ya) * 0.65],
    [w - 0.015, belt],
    p7,
    [(p7[0] + p9[0]) / 2 + 0.012 * g, (p7[1] + p9[1]) / 2],
    p9,
    [wr - 0.1, top - Math.min(0.012, gh * 0.1)],
    [wr * 0.5, top + 0.012],
    [0, top + 0.02]
  ];

  // Underside and wheel wells stay hard-edged; the painted skin (3..12) is rounded off
  const out = [ctrl[0], ctrl[1], ctrl[2]];
  const at = (i) => (i < 3 ? ctrl[3] : i > 12 ? [-ctrl[11][0], ctrl[11][1]] : ctrl[i]);
  for (let i = 3; i < 12; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < RING_SUB; k++) {
      const t = k / RING_SUB;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((n) => 0.5 * (2 * p1[n] + (p2[n] - p0[n]) * t + (2 * p0[n] - 5 * p1[n] + 4 * p2[n] - p3[n]) * t2 + (3 * p1[n] - p0[n] - 3 * p2[n] + p3[n]) * t3)));
    }
  }
  out.push(ctrl[12]);
  return out;
}

/** Control-point band (0..11) that refined half-section segment j belongs to. */
const bandOf = (j) => (j < 3 ? j : 3 + Math.floor((j - 3) / RING_SUB));

const PAINT = 0;
const GLASS = 1;
const TRIM = 2;
const ROOF = 3;

/** Which material a body panel gets, by cross-section band and position along the car. */
function panelMaterial(b, band, z) {
  if (band <= 2) return TRIM;
  const inRange = (r) => z < r[0] && z > r[1];
  const g = greenhouse(b, z);
  if (band === 7 || band === 8) {
    if (inRange(b.sideGlass)) return inRange(b.bPillar) ? TRIM : GLASS;
    // Blacked-out A and C pillars make the roof look as if it floats
    if (b.floatingRoof && g > 0.05) return TRIM;
  }
  if (band >= 10 && (inRange(b.windshield) || inRange(b.backlight))) return GLASS;
  if (band >= 9 && g >= 0.999) return ROOF;
  return PAINT;
}

function buildBodyGeometry(b) {
  const stations = new Set();
  for (let z = b.zr; z <= b.zf + 1e-6; z += 0.042) stations.add(z.toFixed(3));
  [
    ...b.windshield, ...b.backlight, ...b.sideGlass, ...b.bPillar,
    b.wheelZ.front + b.archR, b.wheelZ.front - b.archR, b.wheelZ.rear + b.archR, b.wheelZ.rear - b.archR, b.zf
  ].forEach((z) => stations.add(z.toFixed(3)));
  const zs = [...stations].map(Number).sort((p, q) => p - q);

  const top = section(b, 0).length - 1; // index of the roof centre in a half section
  const ring = top * 2;
  const pos = [];
  for (const z of zs) {
    const half = section(b, z);
    for (let k = 0; k < ring; k++) {
      const p = k <= top ? half[top - k] : half[k - top];
      pos.push(k <= top ? p[0] : -p[0], p[1], z);
    }
  }

  const tris = [[], [], [], []];
  for (let r = 0; r < zs.length - 1; r++) {
    const zMid = (zs[r] + zs[r + 1]) / 2;
    for (let k = 0; k < ring; k++) {
      const band = bandOf(k < top ? top - 1 - k : k - top);
      const i0 = r * ring + k;
      const i1 = i0 + ring;
      const i2 = r * ring + ((k + 1) % ring);
      const i3 = i2 + ring;
      tris[panelMaterial(b, band, zMid)].push(i0, i1, i2, i2, i1, i3);
    }
  }

  // Close the nose and tail
  const cap = (row, z, front) => {
    const half = section(b, zs[row]);
    const centre = pos.length / 3;
    pos.push(0, (half[0][1] + half[top][1]) / 2, z);
    for (let k = 0; k < ring; k++) {
      const i0 = row * ring + k;
      const i1 = row * ring + ((k + 1) % ring);
      if (front) tris[PAINT].push(centre, i1, i0);
      else tris[PAINT].push(centre, i0, i1);
    }
  };
  cap(zs.length - 1, b.zf + 0.04, true);
  cap(0, b.zr - 0.03, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(tris.flat());
  let start = 0;
  tris.forEach((list, material) => {
    geo.addGroup(start, list.length, material);
    start += list.length;
  });
  geo.computeVertexNormals();
  return geo;
}

const FINISHES = {
  gloss: { metalness: 0.0, roughness: 0.3, clearcoat: 1.0, iridescence: 0 },
  metallic: { metalness: 0.55, roughness: 0.24, clearcoat: 1.0, iridescence: 0 },
  matte: { metalness: 0.15, roughness: 0.78, clearcoat: 0.0, iridescence: 0 },
  iridescent: { metalness: 0.75, roughness: 0.28, clearcoat: 1.0, iridescence: 1 }
};

/**
 * Procedural car: a lofted one-piece body with glazing, detailed wheels,
 * working lights and swappable aero, shaped by a spec from CarSpecs.js.
 */
export class CarModel {
  constructor(options = {}) {
    this.spec = options.spec || CAR_SPECS.gt;
    this.bodyColor = options.bodyColor ?? 0xdc2626;
    this.paintFinish = options.paintFinish || 'metallic';
    this.rimColor = options.rimColor ?? 0x18181b;
    this.wingStyle = options.wingStyle || 'gt3';

    // group: position, yaw and road gradient. body: lean and squat on the springs.
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.group.userData.cameras = this.spec.cameras;
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.wheels = [];
    this.steerPivots = [];
    this.wingGroup = null;
    this.headlightSpots = [];
    this.headlamps = [];
    this.lightsOn = false;

    this.createMaterials();
    this.createBody();
    this.createLights();
    this.createWheels();
    this.createInterior();
    this.setWing(this.wingStyle);

    const [sw, sl] = this.spec.details.shadow;
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(sw, sl).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: radialTexture(), color: 0x000000, transparent: true, opacity: 0.6,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
      })
    );
    blob.position.y = 0.02;
    this.group.add(blob);
  }

  createMaterials() {
    this.paintMat = new THREE.MeshPhysicalMaterial({ color: this.bodyColor, clearcoatRoughness: 0.04, iridescenceIOR: 1.8, envMapIntensity: 1.25 });
    // Contrast roof when the spec has one; otherwise the roof is simply body colour
    const roofColor = this.spec.body.roofColor;
    this.roofMat = roofColor === null ? this.paintMat : new THREE.MeshPhysicalMaterial({
      color: roofColor, roughness: 0.35, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: 0.9
    });
    this.applyFinish();
    this.glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x06090d, metalness: 0.0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6
    });
    this.trimMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.65, metalness: 0.1 });
    this.carbonMat = new THREE.MeshPhysicalMaterial({ color: 0x121214, roughness: 0.45, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });
    this.chromeMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.12, metalness: 1 });
    this.rimMat = new THREE.MeshStandardMaterial({ color: this.rimColor, roughness: 0.3, metalness: 0.85 });
    this.tyreMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.9 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dd, emissiveIntensity: 1.5, roughness: 0.2 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x400505, emissive: 0xff1a10, emissiveIntensity: 0.6, roughness: 0.3 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0x999999, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  }

  applyFinish() {
    const f = FINISHES[this.paintFinish] || FINISHES.gloss;
    this.paintMat.color.setHex(this.bodyColor);
    this.paintMat.metalness = f.metalness;
    this.paintMat.roughness = f.roughness;
    this.paintMat.clearcoat = f.clearcoat;
    this.paintMat.iridescence = f.iridescence;
    this.paintMat.needsUpdate = true;
  }

  part(geo, mat, x, y, z, parent = this.body) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  createBody() {
    const b = this.spec.body;
    this.bodyGeometry = buildBodyGeometry(b);
    const shell = new THREE.Mesh(this.bodyGeometry, [this.paintMat, this.glassMat, this.trimMat, this.roofMat]);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);

    // Door mirrors: body colour on the GT, roof colour on cars with a contrast roof
    const [mx, my, mz] = this.spec.details.mirror;
    const mirrorGeo = new THREE.SphereGeometry(0.1, 16, 12).scale(0.75, 0.62, 1.15);
    for (const x of [-1, 1]) {
      this.part(mirrorGeo, this.roofMat, x * mx, my, mz);
      this.part(new THREE.BoxGeometry(0.14, 0.025, 0.06), this.trimMat, x * (mx - 0.09), my - 0.03, mz);
    }

    if (this.spec.details.style === 'piccola') this.createPiccolaBody(b);
    else this.createGtBody(b);
  }

  createGtBody(b) {
    const { zf, zr } = b;
    // Front: grille, splitter, intakes
    this.part(new THREE.BoxGeometry(0.96, 0.17, 0.06), this.trimMat, 0, 0.42, zf + 0.01);
    this.part(new THREE.BoxGeometry(1.5, 0.035, 0.32), this.carbonMat, 0, 0.2, zf - 0.12);
    for (const x of [-0.62, 0.62]) {
      this.part(new THREE.BoxGeometry(0.3, 0.13, 0.08), this.trimMat, x, 0.37, zf - 0.13).rotation.y = x > 0 ? 0.5 : -0.5;
    }

    // Sills and rear diffuser
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.07, 0.07, 1.72), this.carbonMat, x * 0.9, 0.2, -0.05);
    }
    this.part(new THREE.BoxGeometry(1.36, 0.16, 0.3), this.carbonMat, 0, 0.3, zr + 0.08).rotation.x = -0.25;
    for (const x of [-0.42, -0.14, 0.14, 0.42]) {
      this.part(new THREE.BoxGeometry(0.02, 0.15, 0.3), this.carbonMat, x, 0.27, zr + 0.04);
    }
    const pipeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.16, 16).rotateX(Math.PI / 2);
    for (const x of [-0.56, 0.56]) this.part(pipeGeo, this.chromeMat, x, 0.36, zr);

    // Roof antenna fin
    this.part(new THREE.ConeGeometry(0.035, 0.12, 8).scale(1, 1, 2.5), this.trimMat, 0, 1.34, -0.85);
  }

  /** Retro city-car details: hexagonal chrome grille, black arches and sills, twin centre exhausts. */
  createPiccolaBody(b) {
    const { zf, zr } = b;

    // Hexagonal grille tucked up under the bonnet line between the headlamps
    const hex = (r, depth) => new THREE.CylinderGeometry(r, r, depth, 6).rotateX(Math.PI / 2).rotateZ(Math.PI / 6).scale(1.6, 0.62, 1);
    this.part(hex(0.24, 0.05), this.chromeMat, 0, 0.6, zf + 0.025);
    this.part(hex(0.21, 0.06), this.trimMat, 0, 0.6, zf + 0.03);
    // Lower bumper intake and a slim chrome bar across the bumper
    this.part(new THREE.BoxGeometry(0.8, 0.1, 0.06), this.trimMat, 0, 0.3, zf + 0.0);
    this.part(new THREE.BoxGeometry(1.2, 0.025, 0.04), this.chromeMat, 0, 0.4, zf + 0.03);

    // Black arch flares around every wheel, the car's most recognisable outline
    const flareGeo = new THREE.TorusGeometry(b.archR + 0.015, 0.045, 8, 28, Math.PI).rotateY(Math.PI / 2);
    for (const wz of [b.wheelZ.front, b.wheelZ.rear]) {
      for (const x of [-1, 1]) {
        this.part(flareGeo, this.trimMat, x * (b.halfWidth + 0.005), b.wheelR, wz);
      }
    }
    // Sill cladding between the arches
    const sillLength = b.wheelZ.front - b.wheelZ.rear - 2 * b.archR - 0.04;
    const sillZ = (b.wheelZ.front + b.wheelZ.rear) / 2;
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.05, 0.13, sillLength), this.trimMat, x * (b.halfWidth - 0.005), 0.27, sillZ);
    }

    // Rear: black bumper insert, twin exhausts in the middle
    this.part(new THREE.BoxGeometry(1.1, 0.12, 0.06), this.trimMat, 0, 0.3, zr - 0.0);
    const pipeGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.16, 16).rotateX(Math.PI / 2);
    for (const x of [-0.08, 0.08]) this.part(pipeGeo, this.chromeMat, x, 0.27, zr - 0.02);

    // Short whip aerial at the back of the roof
    this.part(new THREE.CylinderGeometry(0.008, 0.012, 0.28, 6), this.trimMat, 0, 1.55, -1.35).rotation.x = -0.35;
  }

  createLights() {
    const b = this.spec.body;
    const [sx, sy, sz] = this.spec.details.headlightSpot;
    const piccola = this.spec.details.style === 'piccola';

    for (const x of [-1, 1]) {
      const lamp = new THREE.Group();
      this.body.add(lamp);
      this.headlamps.push(lamp);
      if (piccola) {
        // Big round headlamps on the front face, their tops rising above the bonnet line
        lamp.position.set(x * 0.5, 0.71, b.zf - 0.02);
        lamp.rotation.set(-0.1, x * 0.18, 0, 'YXZ');
        this.part(new THREE.TorusGeometry(0.155, 0.026, 10, 36), this.chromeMat, 0, 0, 0, lamp).castShadow = false;
        this.part(new THREE.CylinderGeometry(0.145, 0.145, 0.06, 36).rotateX(Math.PI / 2), this.glassMat, 0, 0, -0.02, lamp).castShadow = false;
        this.part(new THREE.TorusGeometry(0.115, 0.012, 8, 36), this.headMat, 0, 0, 0.012, lamp).castShadow = false;
        this.part(new THREE.CircleGeometry(0.055, 24), this.headMat, 0, 0, 0.012, lamp).castShadow = false;
      } else {
        // A dark housing on each front corner with a slim LED blade in it
        lamp.position.set(x * 0.54, 0.672, b.zf - 0.3);
        lamp.rotation.set(-0.34, x * 0.55, x * -0.1, 'YXZ');
        this.part(new THREE.SphereGeometry(1, 20, 12).scale(0.2, 0.045, 0.17), this.glassMat, 0, 0, 0, lamp).castShadow = false;
        this.part(new THREE.BoxGeometry(0.28, 0.016, 0.035), this.headMat, 0, -0.004, 0.158, lamp).castShadow = false;
      }

      const spot = new THREE.SpotLight(0xfff1dc, 0, 120, 0.44, 0.8, 1.5);
      spot.position.set(x * sx, sy, b.zf + sz);
      spot.target.position.set(x * 1.2, -0.1, b.zf + 40);
      spot.visible = false;
      this.group.add(spot, spot.target);
      this.headlightSpots.push(spot);
    }

    if (piccola) {
      // Tall tail lamps at each rear corner, reversing lamps in the bumper
      for (const x of [-1, 1]) {
        this.part(new THREE.BoxGeometry(0.16, 0.24, 0.05), this.chromeMat, x * 0.66, 0.84, b.zr + 0.01).castShadow = false;
        this.part(new THREE.BoxGeometry(0.13, 0.21, 0.05), this.tailMat, x * 0.66, 0.84, b.zr - 0.0).castShadow = false;
        this.part(new THREE.BoxGeometry(0.1, 0.04, 0.05), this.reverseMat, x * 0.36, 0.42, b.zr - 0.01).castShadow = false;
      }
      this.part(new THREE.BoxGeometry(0.42, 0.13, 0.03), this.trimMat, 0, 0.6, b.zr - 0.015);
      return;
    }

    // Full-width tail light bar, plus reversing lamps
    this.part(new THREE.BoxGeometry(1.4, 0.065, 0.05), this.tailMat, 0, 0.86, b.zr - 0.005).castShadow = false;
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.12, 0.04, 0.05), this.reverseMat, x * 0.3, 0.62, b.zr - 0.01).castShadow = false;
    }
    this.part(new THREE.BoxGeometry(0.4, 0.2, 0.03), this.trimMat, 0, 0.64, b.zr - 0.015);
  }

  createWheels() {
    const b = this.spec.body;
    // Wheel parts are modelled for a 0.33 m tyre and scaled to the spec
    const scale = b.wheelR / 0.33;
    const tyreGeo = new THREE.LatheGeometry([
      [0.2, -0.125], [0.29, -0.13], [0.32, -0.105], [0.33, -0.06], [0.33, 0.06], [0.32, 0.105], [0.29, 0.13], [0.2, 0.125]
    ].map(([r, y]) => new THREE.Vector2(r, y)), 36).rotateZ(-Math.PI / 2);
    const barrelGeo = new THREE.CylinderGeometry(0.205, 0.205, 0.25, 28, 1, true).rotateZ(Math.PI / 2);
    const lipGeo = new THREE.TorusGeometry(0.2, 0.014, 8, 36).rotateY(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.05, 16).rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.028, 0.155, 0.03);
    const discGeo = new THREE.CylinderGeometry(0.165, 0.165, 0.022, 28).rotateZ(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(0.07, 0.1, 0.15);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x8c8c90, metalness: 0.9, roughness: 0.35 });
    const caliperMat = new THREE.MeshStandardMaterial({ color: 0xd8222a, roughness: 0.4 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });

    for (const axle of ['front', 'rear']) {
      for (const side of [1, -1]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * b.wheelX, b.wheelR, b.wheelZ[axle]);
        pivot.scale.setScalar(scale);
        this.group.add(pivot);

        // Built for the left side (outer face towards +X) and turned around for the right
        const hand = new THREE.Group();
        hand.rotation.y = side > 0 ? 0 : Math.PI;
        pivot.add(hand);

        const spin = new THREE.Group();
        hand.add(spin);
        this.part(tyreGeo, this.tyreMat, 0, 0, 0, spin);
        this.part(barrelGeo, barrelMat, 0, 0, 0, spin).castShadow = false;
        this.part(lipGeo, this.rimMat, 0.115, 0, 0, spin).castShadow = false;
        this.part(hubGeo, this.rimMat, 0.1, 0, 0, spin).castShadow = false;
        for (let i = 0; i < 10; i++) {
          // Five twin spokes
          const ang = (Math.floor(i / 2) / 5) * Math.PI * 2 + (i % 2 ? 0.2 : -0.2);
          const spoke = this.part(spokeGeo, this.rimMat, 0.1, Math.cos(ang) * 0.122, Math.sin(ang) * 0.122, spin);
          spoke.rotation.x = ang;
          spoke.castShadow = false;
        }
        this.part(discGeo, discMat, 0.04, 0, 0, spin).castShadow = false;
        this.part(caliperGeo, caliperMat, 0.045, 0.06, axle === 'front' ? -0.13 : 0.13, hand).castShadow = false;

        this.wheels.push({ spin, axle, dir: side });
        if (axle === 'front') this.steerPivots.push(pivot);
      }
    }
  }

  /** Dashboard and wheel, only shown from the cockpit camera. */
  createInterior() {
    const c = this.spec.cameras;
    this.interior = new THREE.Group();
    this.interior.visible = false;
    this.body.add(this.interior);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x1d1e22, emissive: 0x08080a, roughness: 0.8 });

    // The body shell is only drawn from outside, so from the driver's seat the doors,
    // pillars and roof would simply not be there. Line the cabin with the same shape seen
    // from within: trim where the panels are, a light tint where the glass is.
    const liningMat = new THREE.MeshStandardMaterial({
      color: 0x34373d, emissive: 0x0d0e10, roughness: 0.9, side: THREE.BackSide
    });
    const windowMat = new THREE.MeshBasicMaterial({
      color: 0x8fa3b3, transparent: true, opacity: 0.1, side: THREE.BackSide, depthWrite: false
    });
    this.interior.add(new THREE.Mesh(this.bodyGeometry, [liningMat, windowMat, liningMat, liningMat]));

    // Dashboard, running the full width of the cabin up to the base of the windscreen
    const dash = new THREE.Mesh(new THREE.BoxGeometry(...c.dash.size), dashMat);
    dash.position.set(...c.dash.pos);
    dash.rotation.x = 0.1;
    this.interior.add(dash);
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.2), dashMat);
    binnacle.position.set(...c.binnacle);
    this.interior.add(binnacle);
    this.steeringWheel = new THREE.Group();
    this.steeringWheel.position.set(...c.wheel);
    this.steeringWheel.rotation.x = -0.35;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.015, 8, 28), dashMat);
    const spokes = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.015), dashMat);
    this.wheelRim = new THREE.Group();
    this.wheelRim.add(rim, spokes);
    this.steeringWheel.add(this.wheelRim);
    this.interior.add(this.steeringWheel);
  }

  setWing(style) {
    this.wingStyle = style;
    if (this.wingGroup) {
      this.wingGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.body.remove(this.wingGroup);
    }
    const g = new THREE.Group();
    this.wingGroup = g;
    this.body.add(g);
    if (style === 'none') return;

    const mount = this.spec.details.wing;
    if (style === 'stealth') {
      const { y, z, width, pitch } = mount.lip;
      this.part(new THREE.BoxGeometry(width, 0.035, 0.26), this.carbonMat, 0, y, z, g).rotation.x = pitch;
      return;
    }

    const hyper = style === 'hyper';
    const span = hyper ? 1.86 : 1.66;
    const height = mount.deckY + (hyper ? 0.53 : 0.41);
    const chord = hyper ? 0.4 : 0.32;
    const z = mount.deckZ;
    for (const x of [-0.45, 0.45]) {
      const strut = this.part(new THREE.BoxGeometry(0.03, height - mount.deckY, 0.16), this.carbonMat, x, (height + mount.deckY) / 2, z + 0.06, g);
      strut.rotation.x = 0.18;
    }
    this.part(new THREE.BoxGeometry(span, 0.03, chord), this.carbonMat, 0, height, z, g).rotation.x = -0.14;
    if (hyper) this.part(new THREE.BoxGeometry(span, 0.022, 0.16), this.carbonMat, 0, height + 0.09, z - 0.2, g).rotation.x = -0.45;
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.02, hyper ? 0.3 : 0.2, chord + 0.12), this.carbonMat, x * span / 2, height + 0.02, z - 0.02, g);
    }
  }

  updateCustomization(config) {
    if (config.bodyColor !== undefined) this.bodyColor = config.bodyColor;
    if (config.paintFinish !== undefined) this.paintFinish = config.paintFinish;
    this.applyFinish();
    if (config.rimColor !== undefined && config.rimColor !== this.rimColor) {
      this.rimColor = config.rimColor;
      this.rimMat.color.setHex(this.rimColor);
    }
    if (config.wingStyle !== undefined && config.wingStyle !== this.wingStyle) this.setWing(config.wingStyle);
  }

  /** Headlight beams and brighter running lights for dusk, night and rain. */
  setLights(on, night = false) {
    this.lightsOn = on;
    this.lightsNight = night;
    this.headlightSpots.forEach((spot) => {
      spot.visible = on;
      spot.intensity = on ? (night ? 420 : 160) : 0;
    });
    this.headMat.emissiveIntensity = on ? 7 : 1.6;
  }

  /**
   * The lamp units sit proud of the bonnet line, so from the driver's-eye cameras their
   * glowing strips stick up into view as bright slabs. Hide them there; the beams stay on.
   */
  setHeadlampsVisible(visible) {
    this.headlamps.forEach((lamp) => { lamp.visible = visible; });
  }

  setInteriorVisible(visible) {
    this.interior.visible = visible;
  }

  /** Free GPU resources when this car is swapped out. Shared textures are left alone. */
  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) [].concat(obj.material).forEach((m) => m.dispose());
    });
  }

  /** Pose the whole car from the physics state for this frame. */
  update(physics, dt) {
    this.group.position.copy(physics.renderPosition);
    this.group.rotation.set(physics.gradePitch, physics.renderHeading, 0);
    this.body.rotation.x = physics.bodyPitch;
    this.body.rotation.z = physics.bodyRoll;
    this.body.position.y = -Math.abs(physics.bodyRoll) * 0.25;

    this.steerPivots.forEach((pivot) => { pivot.rotation.y = physics.steerRad; });
    // Physics reports wheel speed for its own tyre radius; match the size drawn here
    const radiusRatio = physics.wheelRadius / this.spec.body.wheelR;
    this.wheels.forEach((wheel) => {
      const omega = wheel.axle === 'front' ? physics.wheelOmegaFront : physics.wheelOmegaRear;
      wheel.spin.rotation.x += omega * radiusRatio * dt * wheel.dir;
    });
    this.wheelRim.rotation.z = -physics.steerRad * 4.5;

    const braking = physics.isBraking && !physics.isReversing;
    this.tailMat.emissiveIntensity = braking ? 7 : this.lightsOn ? 1.6 : 0.5;
    this.reverseMat.emissiveIntensity = physics.isReversing ? 5 : 0;
  }
}
