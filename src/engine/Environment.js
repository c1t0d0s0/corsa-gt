import * as THREE from 'three';
import { mulberry32 } from './ProceduralTextures.js';

/**
 * Time-of-day looks. The sky is a gradient dome (zenith → horizon) with a sun
 * disc and halo; `clear: false` hides the sun for overcast.
 * bloom = [strength, radius, threshold].
 */
const PRESETS = {
  noon: {
    top: 0x1f5fc4, horizon: 0xb9d6f2, glow: 0xfff1d6, glowPower: 0.25, sunDisc: 6, elevation: 50, azimuth: 140,
    sunColor: 0xfff3e0, sunIntensity: 3.1,
    hemiSky: 0xbcd8ff, hemiGround: 0x51493a, hemiIntensity: 0.35,
    fog: 0xb6d0ea, fogDensity: 0.0008, ground: 0x4b5340,
    exposure: 0.95, envIntensity: 0.6, bloom: [0.16, 0.5, 1.6],
    clouds: { cover: 0.5, color: 0xffffff, shade: 0xa9b8cc }, stars: false, headlights: false
  },
  sunset: {
    top: 0x24356e, horizon: 0xff9d5c, glow: 0xff7a2e, glowPower: 1.0, sunDisc: 8, elevation: 6, azimuth: 248,
    sunColor: 0xffa560, sunIntensity: 2.6,
    hemiSky: 0xd9a48c, hemiGround: 0x3a2a22, hemiIntensity: 0.75,
    fog: 0xe0a57c, fogDensity: 0.0012, ground: 0x4a3428,
    exposure: 0.95, envIntensity: 0.8, bloom: [0.28, 0.6, 1.3],
    clouds: { cover: 0.52, color: 0xffb98a, shade: 0x6a4460 }, stars: false, headlights: true
  },
  midnight: {
    top: 0x03050c, horizon: 0x1b2748, glow: 0x2a2440, glowPower: 0, sunDisc: 0, elevation: 48, azimuth: 30,
    sunColor: 0x9db4ff, sunIntensity: 0.9,
    hemiSky: 0x3a4c82, hemiGround: 0x10121c, hemiIntensity: 1.3,
    fog: 0x0b1020, fogDensity: 0.0016, ground: 0x0a0b10,
    exposure: 1.25, envIntensity: 1.1, bloom: [0.36, 0.6, 1.1],
    clouds: null, stars: true, headlights: true
  }
};

/** Overcast variants swap in a flat grey sky; the sun is hidden and dimmed. */
const RAIN = {
  noon: { top: 0x58626e, horizon: 0x98a3ad, fog: 0x8f9aa4, hemiSky: 0xaab4c0 },
  sunset: { top: 0x3d3a44, horizon: 0x8a6d62, fog: 0x7d675f, hemiSky: 0x9a8078 },
  midnight: { top: 0x030408, horizon: 0x141a28, fog: 0x0a0d16, hemiSky: 0x222a40 }
};

const domeVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const domeFragment = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 glowColor;
  uniform vec3 sunDir;
  uniform float glowPower;
  uniform float sunDisc;
  uniform float horizonGlow;
  varying vec3 vDir;
  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(horizonColor, topColor, pow(h, 0.5));
    // Sun: tight disc, then a wide halo that warms the sky around it
    float s = max(dot(dir, sunDir), 0.0);
    col += glowColor * glowPower * (pow(s, 6.0) * 0.5 + pow(s, 60.0));
    col += glowColor * sunDisc * smoothstep(0.9993, 0.9998, s);
    // Low band of light pollution hugging the horizon at night
    col += glowColor * horizonGlow * pow(1.0 - h, 10.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const cloudVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const cloudFragment = /* glsl */ `
  uniform vec3 color;
  uniform vec3 shade;
  uniform float cover;
  uniform float time;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0; float a = 0.5;
    for (int i = 0; i < 5; i++) { s += noise(p) * a; p = p * 2.03 + 11.0; a *= 0.5; }
    return s;
  }
  void main() {
    vec2 p = vWorld.xz * 0.00042 + vec2(time * 0.004, 0.0);
    float n = fbm(p);
    float d = smoothstep(1.0 - cover, 1.0 - cover + 0.28, n);
    float thick = smoothstep(1.0 - cover + 0.1, 1.0 - cover + 0.5, fbm(p + 0.07));
    vec3 col = mix(color, shade, thick * 0.8);
    float fade = 1.0 - smoothstep(2200.0, 5600.0, length(vWorld.xz - cameraPosition.xz));
    gl_FragColor = vec4(col, d * fade * 0.92);
  }
`;

/**
 * Sky, lighting, fog and image-based lighting for the scene.
 */
export class Environment {
  constructor(scene, renderer, { shadowMapSize = 2048 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;
    this.time = 0;
    this.preset = PRESETS.noon;
    this.wet = false;

    scene.fog = new THREE.FogExp2(0xb4cbe2, 0.001);

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(2500, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: domeVertex,
        fragmentShader: domeFragment,
        uniforms: {
          topColor: { value: new THREE.Color() },
          horizonColor: { value: new THREE.Color() },
          glowColor: { value: new THREE.Color() },
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          glowPower: { value: 0 },
          sunDisc: { value: 0 },
          horizonGlow: { value: 0 }
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
      })
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        uniforms: {
          color: { value: new THREE.Color() },
          shade: { value: new THREE.Color() },
          cover: { value: 0.5 },
          time: { value: 0 }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false
      })
    );
    this.clouds.rotation.x = Math.PI / 2;
    this.clouds.position.y = 1100;
    this.clouds.renderOrder = -5;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    this.stars = this.createStars();
    scene.add(this.stars);

    this.hemiLight = new THREE.HemisphereLight(0xbcd8ff, 0x51493a, 0.5);
    scene.add(this.hemiLight);

    // Sun / moon. The shadow frustum is small and follows the car so shadows
    // stay crisp everywhere on the circuit.
    this.sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = this.sunLight.shadow.camera;
    cam.near = 1;
    cam.far = 400;
    cam.left = cam.bottom = -48;
    cam.right = cam.top = 48;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.04;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
  }

  createStars() {
    const rand = mulberry32(7);
    const count = 1400;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = rand() * Math.PI * 2;
      const y = 0.04 + rand() * 0.96;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(theta) * r * 2400;
      pos[i * 3 + 1] = y * 2400;
      pos[i * 3 + 2] = Math.sin(theta) * r * 2400;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false
    }));
    stars.frustumCulled = false;
    stars.renderOrder = -9;
    return stars;
  }

  /** Switch look. Returns the resolved settings the renderer and car need. */
  apply(timeOfDay = 'noon', weather = 'clear') {
    const base = PRESETS[timeOfDay] || PRESETS.noon;
    const rainy = weather === 'rainy';
    const p = rainy ? { ...base, ...(RAIN[timeOfDay] || RAIN.noon), glowPower: 0, sunDisc: 0, clouds: null } : base;
    this.preset = p;
    this.wet = rainy;

    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const u = this.dome.material.uniforms;
    u.topColor.value.setHex(p.top);
    u.horizonColor.value.setHex(p.horizon);
    u.glowColor.value.setHex(p.glow);
    u.sunDir.value.copy(this.sunDir);
    u.glowPower.value = p.glowPower;
    u.sunDisc.value = p.sunDisc;
    u.horizonGlow.value = timeOfDay === 'midnight' ? 1 : 0;

    this.clouds.visible = !!p.clouds;
    if (p.clouds) {
      this.clouds.material.uniforms.color.value.setHex(p.clouds.color);
      this.clouds.material.uniforms.shade.value.setHex(p.clouds.shade);
      this.clouds.material.uniforms.cover.value = p.clouds.cover;
    }
    this.stars.visible = p.stars && !rainy;

    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = p.sunIntensity * (rainy ? 0.3 : 1);
    this.hemiLight.color.setHex(p.hemiSky);
    this.hemiLight.groundColor.setHex(p.hemiGround);
    this.hemiLight.intensity = p.hemiIntensity * (rainy ? 1.25 : 1);

    this.scene.fog.color.setHex(p.fog);
    this.scene.fog.density = p.fogDensity * (rainy ? 2.6 : 1);
    this.scene.environmentIntensity = p.envIntensity;

    this.bakeEnvironment(p, timeOfDay);

    return {
      exposure: p.exposure,
      bloom: p.bloom,
      headlights: p.headlights || rainy,
      wet: rainy,
      night: timeOfDay === 'midnight'
    };
  }

  /** Render the sky into a prefiltered cube map so paint and glass have something to reflect. */
  bakeEnvironment(p, timeOfDay) {
    const envScene = new THREE.Scene();
    const skyObject = this.dome;
    envScene.add(skyObject);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(20000, 24),
      new THREE.MeshBasicMaterial({ color: p.ground })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -4;
    envScene.add(ground);

    const disposables = [ground];
    if (timeOfDay === 'midnight') {
      // A ring of city glow so the car has coloured highlights to pick up at night
      const glows = [0x35d6ff, 0xff4fa8, 0xffc56a, 0x7a6bff, 0x35d6ff, 0xffc56a];
      glows.forEach((hex, i) => {
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(900, 260),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(1.6), side: THREE.DoubleSide })
        );
        const ang = (i / glows.length) * Math.PI * 2 + 0.4;
        panel.position.set(Math.cos(ang) * 1800, 260, Math.sin(ang) * 1800);
        panel.lookAt(0, 200, 0);
        envScene.add(panel);
        disposables.push(panel);
      });
    }

    const target = this.pmrem.fromScene(envScene, 0, 1, 60000);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;

    disposables.forEach((mesh) => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    this.scene.add(skyObject);
  }

  update(dt, focus) {
    this.time += dt;
    this.clouds.material.uniforms.time.value = this.time;

    // Snap the shadow frustum to whole metres to keep shadow edges from crawling
    const tx = Math.round(focus.x);
    const tz = Math.round(focus.z);
    this.sunLight.target.position.set(tx, focus.y, tz);
    this.sunLight.position.set(tx, focus.y, tz).addScaledVector(this.sunDir, 160);
    this.clouds.position.x = focus.x;
    this.clouds.position.z = focus.z;
    this.stars.position.copy(focus);
    this.dome.position.copy(focus);
  }
}
