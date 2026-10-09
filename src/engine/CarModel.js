import * as THREE from 'three';
import { radialTexture } from './ProceduralTextures.js';

// Body envelope in car space: +Z forward, +X left, origin on the ground under the CG
const ZF = 2.12;
const ZR = -2.08;
const WHEEL_Z = { front: 1.25, rear: -1.35 };
const WHEEL_X = 0.8;
const WHEEL_R = 0.33;
const ARCH_R = 0.39;
const RING_SUB = 3; // smoothing subdivisions between cross-section control points
const HALF_WIDTH = 0.915;

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

const BELT = [[2.12, 0.6], [1.7, 0.75], [1.25, 0.83], [0.95, 0.89], [0.2, 0.93], [-1.0, 0.96], [-1.7, 0.99], [-2.08, 0.94]];
const ROOF = [[0.3, 1.285], [-0.2, 1.32], [-1.05, 1.265]];
const WINDSHIELD = [0.95, 0.3];
const BACKLIGHT = [-1.05, -1.78];
const SIDE_GLASS = [0.72, -1.12];

/**
 * Half cross-section of the body at station z, from the underside centre (0)
 * up and over to the roof centre (12).
 */
function section(z) {
  const tF = clamp01((z - (ZF - 0.55)) / 0.55);
  const tR = clamp01((ZR + 0.4 - z) / 0.4);

  let arch = 0;
  for (const wz of [WHEEL_Z.front, WHEEL_Z.rear]) {
    const dz = Math.abs(z - wz);
    if (dz < ARCH_R) arch = Math.max(arch, Math.sqrt(ARCH_R * ARCH_R - dz * dz));
  }

  const w = HALF_WIDTH * (1 - 0.3 * Math.pow(tF, 2.4)) * (1 - 0.12 * tR * tR) + (arch > 0 ? 0.012 : 0);
  const yb = 0.17 + 0.1 * tF * tF + 0.14 * Math.pow(tR, 1.5);
  const belt = spline1(BELT, z);
  const g = Math.min(
    clamp01((WINDSHIELD[0] - z) / (WINDSHIELD[0] - WINDSHIELD[1])),
    clamp01((z - BACKLIGHT[1]) / (BACKLIGHT[0] - BACKLIGHT[1]))
  );
  const top = belt + 0.015 + g * (spline1(ROOF, z) - belt - 0.015);
  const gh = top - belt;
  const ya = Math.max(yb, arch > 0 ? WHEEL_R + arch : 0);
  const xi = w - 0.3;
  const wr = lerp(w - 0.16, 0.6 * (w / HALF_WIDTH), g);

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
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const d = at(i + 2);
    for (let k = 0; k < RING_SUB; k++) {
      const t = k / RING_SUB;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((n) => 0.5 * (2 * b[n] + (c[n] - a[n]) * t + (2 * a[n] - 5 * b[n] + 4 * c[n] - d[n]) * t2 + (3 * b[n] - a[n] - 3 * c[n] + d[n]) * t3)));
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

/** Which material a body panel gets, by cross-section band and position along the car. */
function panelMaterial(band, z) {
  if (band <= 2) return TRIM;
  const inRange = (r) => z < r[0] && z > r[1];
  if ((band === 7 || band === 8) && inRange(SIDE_GLASS)) {
    return z < -0.3 && z > -0.4 ? TRIM : GLASS; // B-pillar
  }
  if (band >= 10 && (inRange(WINDSHIELD) || inRange(BACKLIGHT))) return GLASS;
  return PAINT;
}

function buildBodyGeometry() {
  const stations = new Set();
  for (let z = ZR; z <= ZF + 1e-6; z += 0.042) stations.add(z.toFixed(3));
  [
    ...WINDSHIELD, ...BACKLIGHT, ...SIDE_GLASS, -0.3, -0.4,
    WHEEL_Z.front + ARCH_R, WHEEL_Z.front - ARCH_R, WHEEL_Z.rear + ARCH_R, WHEEL_Z.rear - ARCH_R, ZF
  ].forEach((z) => stations.add(z.toFixed(3)));
  const zs = [...stations].map(Number).sort((a, b) => a - b);

  const top = section(0).length - 1; // index of the roof centre in a half section
  const ring = top * 2;
  const pos = [];
  for (const z of zs) {
    const half = section(z);
    for (let k = 0; k < ring; k++) {
      const p = k <= top ? half[top - k] : half[k - top];
      pos.push(k <= top ? p[0] : -p[0], p[1], z);
    }
  }

  const tris = [[], [], []];
  for (let r = 0; r < zs.length - 1; r++) {
    const zMid = (zs[r] + zs[r + 1]) / 2;
    for (let k = 0; k < ring; k++) {
      const band = bandOf(k < top ? top - 1 - k : k - top);
      const a = r * ring + k;
      const b = a + ring;
      const c = r * ring + ((k + 1) % ring);
      const d = c + ring;
      tris[panelMaterial(band, zMid)].push(a, b, c, c, b, d);
    }
  }

  // Close the nose and tail
  const cap = (row, z, front) => {
    const half = section(zs[row]);
    const centre = pos.length / 3;
    pos.push(0, (half[0][1] + half[top][1]) / 2, z);
    for (let k = 0; k < ring; k++) {
      const a = row * ring + k;
      const b = row * ring + ((k + 1) % ring);
      if (front) tris[PAINT].push(centre, b, a);
      else tris[PAINT].push(centre, a, b);
    }
  };
  cap(zs.length - 1, ZF + 0.04, true);
  cap(0, ZR - 0.03, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex([...tris[0], ...tris[1], ...tris[2]]);
  geo.addGroup(0, tris[0].length, PAINT);
  geo.addGroup(tris[0].length, tris[1].length, GLASS);
  geo.addGroup(tris[0].length + tris[1].length, tris[2].length, TRIM);
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
 * Procedural GT hatchback: a lofted one-piece body with glazing, detailed
 * wheels, working lights and swappable aero.
 */
export class CarModel {
  constructor(options = {}) {
    this.bodyColor = options.bodyColor ?? 0xdc2626;
    this.paintFinish = options.paintFinish || 'metallic';
    this.rimColor = options.rimColor ?? 0x18181b;
    this.wingStyle = options.wingStyle || 'gt3';

    // group: position, yaw and road gradient. body: lean and squat on the springs.
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
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

    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 5.4).rotateX(-Math.PI / 2),
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
    this.bodyGeometry = buildBodyGeometry();
    const shell = new THREE.Mesh(this.bodyGeometry, [this.paintMat, this.glassMat, this.trimMat]);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);

    // Front: grille, splitter, intakes
    this.part(new THREE.BoxGeometry(0.96, 0.17, 0.06), this.trimMat, 0, 0.42, ZF + 0.01);
    this.part(new THREE.BoxGeometry(1.5, 0.035, 0.32), this.carbonMat, 0, 0.2, ZF - 0.12);
    for (const x of [-0.62, 0.62]) {
      this.part(new THREE.BoxGeometry(0.3, 0.13, 0.08), this.trimMat, x, 0.37, ZF - 0.13).rotation.y = x > 0 ? 0.5 : -0.5;
    }

    // Sills and rear diffuser
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.07, 0.07, 1.72), this.carbonMat, x * 0.9, 0.2, -0.05);
    }
    this.part(new THREE.BoxGeometry(1.36, 0.16, 0.3), this.carbonMat, 0, 0.3, ZR + 0.08).rotation.x = -0.25;
    for (const x of [-0.42, -0.14, 0.14, 0.42]) {
      this.part(new THREE.BoxGeometry(0.02, 0.15, 0.3), this.carbonMat, x, 0.27, ZR + 0.04);
    }
    const pipeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.16, 16).rotateX(Math.PI / 2);
    for (const x of [-0.56, 0.56]) this.part(pipeGeo, this.chromeMat, x, 0.36, ZR - 0.0);

    // Mirrors
    const mirrorGeo = new THREE.SphereGeometry(0.1, 16, 12).scale(0.75, 0.62, 1.15);
    for (const x of [-1, 1]) {
      this.part(mirrorGeo, this.paintMat, x * 0.99, 1.0, 0.5);
      this.part(new THREE.BoxGeometry(0.14, 0.025, 0.06), this.trimMat, x * 0.9, 0.97, 0.5);
    }

    // Roof antenna fin
    this.part(new THREE.ConeGeometry(0.035, 0.12, 8).scale(1, 1, 2.5), this.trimMat, 0, 1.34, -0.85);
  }

  createLights() {
    // Headlights: a dark housing on each front corner with a slim LED blade in it
    const housingGeo = new THREE.SphereGeometry(1, 20, 12).scale(0.2, 0.045, 0.17);
    const bladeGeo = new THREE.BoxGeometry(0.28, 0.016, 0.035);
    for (const x of [-1, 1]) {
      const lamp = new THREE.Group();
      lamp.position.set(x * 0.54, 0.672, ZF - 0.3);
      lamp.rotation.set(-0.34, x * 0.55, x * -0.1, 'YXZ');
      this.body.add(lamp);
      this.headlamps.push(lamp);
      this.part(housingGeo, this.glassMat, 0, 0, 0, lamp).castShadow = false;
      this.part(bladeGeo, this.headMat, 0, -0.004, 0.158, lamp).castShadow = false;

      const spot = new THREE.SpotLight(0xfff1dc, 0, 120, 0.44, 0.8, 1.5);
      spot.position.set(x * 0.56, 0.7, ZF - 0.2);
      spot.target.position.set(x * 1.2, -0.1, ZF + 40);
      spot.visible = false;
      this.group.add(spot, spot.target);
      this.headlightSpots.push(spot);
    }

    // Full-width tail light bar, plus reversing lamps
    const bar = this.part(new THREE.BoxGeometry(1.4, 0.065, 0.05), this.tailMat, 0, 0.86, ZR - 0.005);
    bar.castShadow = false;
    for (const x of [-1, 1]) {
      this.part(new THREE.BoxGeometry(0.12, 0.04, 0.05), this.reverseMat, x * 0.3, 0.62, ZR - 0.01).castShadow = false;
    }
    this.part(new THREE.BoxGeometry(0.4, 0.2, 0.03), this.trimMat, 0, 0.64, ZR - 0.015);
  }

  createWheels() {
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
        pivot.position.set(side * WHEEL_X, WHEEL_R, WHEEL_Z[axle]);
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
    this.interior.add(new THREE.Mesh(this.bodyGeometry, [liningMat, windowMat, liningMat]));

    // Dashboard, running the full width of the cabin up to the base of the windscreen
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.2, 0.7), dashMat);
    dash.position.set(0, 0.78, 0.7);
    dash.rotation.x = 0.1;
    this.interior.add(dash);
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.2), dashMat);
    binnacle.position.set(-0.36, 0.88, 0.56);
    this.interior.add(binnacle);
    this.steeringWheel = new THREE.Group();
    this.steeringWheel.position.set(-0.36, 0.8, 0.36);
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

    if (style === 'stealth') {
      const lip = this.part(new THREE.BoxGeometry(1.5, 0.035, 0.26), this.carbonMat, 0, 1.03, -1.96, g);
      lip.rotation.x = -0.3;
      return;
    }

    const hyper = style === 'hyper';
    const span = hyper ? 1.86 : 1.66;
    const height = hyper ? 1.5 : 1.38;
    const chord = hyper ? 0.4 : 0.32;
    const z = -1.92;
    for (const x of [-0.45, 0.45]) {
      const strut = this.part(new THREE.BoxGeometry(0.03, height - 0.97, 0.16), this.carbonMat, x, (height + 0.97) / 2, z + 0.06, g);
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

  /** Pose the whole car from the physics state for this frame. */
  update(physics, dt) {
    this.group.position.copy(physics.renderPosition);
    this.group.rotation.set(physics.gradePitch, physics.renderHeading, 0);
    this.body.rotation.x = physics.bodyPitch;
    this.body.rotation.z = physics.bodyRoll;
    this.body.position.y = -Math.abs(physics.bodyRoll) * 0.25;

    this.steerPivots.forEach((pivot) => { pivot.rotation.y = physics.steerRad; });
    this.wheels.forEach((wheel) => {
      const omega = wheel.axle === 'front' ? physics.wheelOmegaFront : physics.wheelOmegaRear;
      wheel.spin.rotation.x += omega * dt * wheel.dir;
    });
    this.wheelRim.rotation.z = -physics.steerRad * 4.5;

    const braking = physics.isBraking && !physics.isReversing;
    this.tailMat.emissiveIntensity = braking ? 7 : this.lightsOn ? 1.6 : 0.5;
    this.reverseMat.emissiveIntensity = physics.isReversing ? 5 : 0;
  }
}
