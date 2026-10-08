import * as THREE from 'three';
import { radialTexture } from './ProceduralTextures.js';

const MAX_PARTICLES = 260;
const MAX_SKID_QUADS = 700;

const SURFACE_PUFF = {
  asphalt: [0.86, 0.86, 0.88],
  kerb: [0.86, 0.86, 0.88],
  grass: [0.42, 0.4, 0.26],
  sand: [0.78, 0.62, 0.44]
};

const particleVertex = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float scale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * scale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const particleFragment = /* glsl */ `
  uniform sampler2D map;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float a = texture2D(map, gl_PointCoord).a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const rainVertex = /* glsl */ `
  attribute float tip;
  uniform float time;
  uniform vec3 box;
  uniform vec3 lean;
  void main() {
    vec3 p = position;
    p.y -= time * 30.0;
    p = mod(p - cameraPosition, box) - box * 0.5 + cameraPosition;
    p += tip * (vec3(0.0, 0.85, 0.0) + lean);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;
const rainFragment = /* glsl */ `
  uniform vec3 color;
  void main() { gl_FragColor = vec4(color, 0.26); }
`;

/**
 * Transient visuals driven by the car: tyre smoke, dust, wet spray, skid
 * marks and rainfall.
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.wet = false;
    this.ambient = 1;

    // --- Particles ---
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pColor = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pAlpha = new Float32Array(MAX_PARTICLES);
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pMaxLife = new Float32Array(MAX_PARTICLES);
    this.pGrow = new Float32Array(MAX_PARTICLES);
    this.pStrength = new Float32Array(MAX_PARTICLES);
    this.cursor = 0;
    this.emitDebt = 0;

    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pGeo.setAttribute('aColor', new THREE.BufferAttribute(this.pColor, 3));
    pGeo.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1));
    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      uniforms: { map: { value: radialTexture() }, scale: { value: 600 } },
      transparent: true,
      depthWrite: false
    });
    this.particles = new THREE.Points(pGeo, this.particleMat);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 5;
    scene.add(this.particles);

    // --- Skid marks: a ring buffer of quads laid on the road ---
    this.skidPos = new Float32Array(MAX_SKID_QUADS * 12);
    this.skidColor = new Float32Array(MAX_SKID_QUADS * 16);
    const index = [];
    for (let i = 0; i < MAX_SKID_QUADS; i++) {
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(this.skidPos, 3));
    sGeo.setAttribute('color', new THREE.BufferAttribute(this.skidColor, 4));
    sGeo.setIndex(index);
    this.skids = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({
      color: 0x060606, vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide
    }));
    this.skids.frustumCulled = false;
    this.skids.renderOrder = 1;
    scene.add(this.skids);
    this.skidCursor = 0;
    this.skidLast = [null, null];

    // --- Rain: streaks in a box that wraps around the camera ---
    const drops = 1600;
    const box = new THREE.Vector3(44, 26, 44);
    const rPos = new Float32Array(drops * 6);
    const rTip = new Float32Array(drops * 2);
    for (let i = 0; i < drops; i++) {
      const x = Math.random() * box.x;
      const y = Math.random() * box.y;
      const z = Math.random() * box.z;
      rPos.set([x, y, z, x, y, z], i * 6);
      rTip[i * 2 + 1] = 1;
    }
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
    rGeo.setAttribute('tip', new THREE.BufferAttribute(rTip, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: rainVertex,
      fragmentShader: rainFragment,
      uniforms: {
        time: { value: 0 },
        box: { value: box },
        lean: { value: new THREE.Vector3() },
        color: { value: new THREE.Color(0.75, 0.82, 0.92) }
      },
      transparent: true,
      depthWrite: false
    });
    this.rain = new THREE.LineSegments(rGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 6;
    scene.add(this.rain);

    this._v = new THREE.Vector3();
  }

  /** Particles are unlit, so they need telling how bright the scene is. */
  setLook(look) {
    this.wet = look.wet;
    this.rain.visible = look.wet;
    this.ambient = look.night ? 0.16 : look.wet ? 0.6 : look.headlights ? 0.75 : 1;
    this.rainMat.uniforms.color.value.setRGB(0.75, 0.82, 0.92).multiplyScalar(look.night ? 0.45 : 1);
  }

  /** Drop all marks and smoke, e.g. after changing circuit. */
  clear() {
    this.pLife.fill(0);
    this.pAlpha.fill(0);
    this.skidPos.fill(0);
    this.skidColor.fill(0);
    this.skidLast = [null, null];
    this.particles.geometry.attributes.aAlpha.needsUpdate = true;
    this.skids.geometry.attributes.position.needsUpdate = true;
    this.skids.geometry.attributes.color.needsUpdate = true;
  }

  /** Forget the previous skid points so a teleport doesn't draw a streak across the map. */
  breakSkids() {
    this.skidLast = [null, null];
  }

  emit(x, y, z, vx, vy, vz, color, size, life, strength) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.pPos.set([x, y, z], i * 3);
    this.pVel.set([vx, vy, vz], i * 3);
    this.pColor.set([color[0] * this.ambient, color[1] * this.ambient, color[2] * this.ambient], i * 3);
    this.pSize[i] = size;
    this.pGrow[i] = size * 1.5;
    this.pLife[i] = life;
    this.pMaxLife[i] = life;
    this.pStrength[i] = strength;
  }

  /**
   * @param carGroup    car scene node, posed for this frame
   * @param pixelScale  drawing-buffer height / (2 tan(fov/2)), for world-sized points
   */
  update(physics, carGroup, dt, pixelScale) {
    this.time += dt;
    this.particleMat.uniforms.scale.value = pixelScale;

    const speed = Math.hypot(physics.vx, physics.vy);
    const surface = physics.surface;
    const onRoad = surface === 'asphalt' || surface === 'kerb';
    const slip = physics.slipAmount;

    // What the rear tyres are throwing up right now
    let rate = 0;
    let color = SURFACE_PUFF.asphalt;
    let strength = 0.2;
    let size = 0.5;
    if (!onRoad && speed > 4) {
      rate = Math.min(60, speed * 2.2);
      color = SURFACE_PUFF[surface] || SURFACE_PUFF.grass;
      strength = surface === 'sand' ? 0.3 : 0.2;
      size = 0.7;
    } else if (slip > 0.4 && !this.wet) {
      rate = 30 + slip * 55;
      strength = Math.min(0.34, 0.1 + slip * 0.2);
    } else if (this.wet && speed > 12) {
      rate = Math.min(90, speed * 2);
      color = [0.8, 0.84, 0.9];
      strength = 0.07;
      size = 0.55;
    }

    carGroup.updateMatrixWorld();
    const wheelPos = [null, null];
    for (let w = 0; w < 2; w++) {
      wheelPos[w] = this._v.set(w === 0 ? 0.8 : -0.8, 0.03, -1.35).applyMatrix4(carGroup.matrixWorld).clone();
    }

    this.emitDebt += rate * dt;
    while (this.emitDebt >= 1) {
      this.emitDebt -= 1;
      const p = wheelPos[Math.random() < 0.5 ? 0 : 1];
      this.emit(
        p.x + (Math.random() - 0.5) * 0.3, p.y + 0.1, p.z + (Math.random() - 0.5) * 0.3,
        physics.velocity.x * 0.25 + (Math.random() - 0.5) * 1.2,
        0.6 + Math.random() * 1.2,
        physics.velocity.z * 0.25 + (Math.random() - 0.5) * 1.2,
        color, size * (0.7 + Math.random() * 0.6), 0.7 + Math.random() * 0.7, strength
      );
    }

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pAlpha[i] = 0; continue; }
      const t = 1 - this.pLife[i] / this.pMaxLife[i];
      const drag = Math.exp(-1.8 * dt);
      this.pVel[i * 3] *= drag;
      this.pVel[i * 3 + 2] *= drag;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      this.pSize[i] += this.pGrow[i] * dt;
      this.pAlpha[i] = this.pStrength[i] * Math.min(1, t * 8) * (1 - t);
    }
    const pa = this.particles.geometry.attributes;
    pa.position.needsUpdate = true;
    pa.aColor.needsUpdate = true;
    pa.aSize.needsUpdate = true;
    pa.aAlpha.needsUpdate = true;

    // Skid marks under the rear tyres while they are sliding on tarmac
    const skidding = onRoad && speed > 3 && slip > 0.4;
    const alpha = Math.min(0.75, (slip - 0.3) * 0.9) * (this.wet ? 0.4 : 1);
    const lx = Math.cos(physics.renderHeading) * 0.13;
    const lz = -Math.sin(physics.renderHeading) * 0.13;
    let wrote = false;
    for (let w = 0; w < 2; w++) {
      if (!skidding) { this.skidLast[w] = null; continue; }
      const p = wheelPos[w];
      const last = this.skidLast[w];
      const cur = { ax: p.x + lx, az: p.z + lz, bx: p.x - lx, bz: p.z - lz, y: p.y, alpha };
      if (!last) { this.skidLast[w] = cur; continue; }
      if (Math.hypot(p.x - (last.ax + last.bx) / 2, p.z - (last.az + last.bz) / 2) < 0.35) continue;
      const q = this.skidCursor;
      this.skidCursor = (q + 1) % MAX_SKID_QUADS;
      this.skidPos.set([last.ax, last.y, last.az, last.bx, last.y, last.bz, cur.ax, cur.y, cur.az, cur.bx, cur.y, cur.bz], q * 12);
      this.skidColor.set([1, 1, 1, last.alpha, 1, 1, 1, last.alpha, 1, 1, 1, alpha, 1, 1, 1, alpha], q * 16);
      this.skidLast[w] = cur;
      wrote = true;
    }
    if (wrote) {
      this.skids.geometry.attributes.position.needsUpdate = true;
      this.skids.geometry.attributes.color.needsUpdate = true;
    }

    if (this.wet) {
      this.rainMat.uniforms.time.value = this.time;
      // Streaks lean back with speed so rain rushes at the windscreen
      this.rainMat.uniforms.lean.value.set(physics.velocity.x * 0.03, 0, physics.velocity.z * 0.03);
    }
  }
}
