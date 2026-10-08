import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Environment } from './Environment.js';
import { CameraRig } from './CameraRig.js';

/** Vignette and a gentle contrast curve, applied in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 0.32 },
    saturation: { value: 1.08 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(luma), c.rgb, saturation);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * smoothstep(0.25, 0.95, dot(d, d) * 2.0);
      gl_FragColor = c;
    }
  `
};

const PIXEL_RATIO_STEPS = [2, 1.5, 1.25, 1, 0.8];

/**
 * Owns the WebGL renderer, scene, post-processing chain, sky/lighting and camera rig.
 */
export class RenderEngine {
  /** @param options.mobile  start from lighter settings suited to phone GPUs */
  constructor(containerElement, { mobile = false } = {}) {
    this.container = containerElement;
    this.mobile = mobile;
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.15, 6000);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.6;
    this.container.appendChild(this.renderer.domElement);

    // Start at the best pixel ratio the display wants; drop a step if the GPU can't keep up
    const device = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
    this.ratioIndex = PIXEL_RATIO_STEPS.findIndex((r) => r <= device);
    this.frameTimeAvg = 1 / 60;
    this.slowTime = 0;

    this.qualityStage = 0;

    this.environment = new Environment(this.scene, this.renderer, { shadowMapSize: mobile ? 1024 : 2048 });
    this.cameraRig = new CameraRig(this.camera, this.renderer.domElement);

    // Post-processing: MSAA HDR target → bloom → grade → tone map
    const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: mobile ? 2 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(size, 0.25, 0.6, 1.5);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());

    this.onWindowResize();
    window.addEventListener('resize', () => this.onWindowResize());
    // Mobile browsers settle their viewport a beat after the rotation event
    window.addEventListener('orientationchange', () => setTimeout(() => this.onWindowResize(), 250));
  }

  get cameraMode() {
    return this.cameraRig.mode;
  }

  setCameraMode(mode) {
    return this.cameraRig.setMode(mode);
  }

  cycleCameraMode() {
    return this.cameraRig.cycleMode();
  }

  snapCamera() {
    this.cameraRig.snap();
  }

  /** @returns resolved look settings ({ headlights, wet, night, ... }) for other systems */
  setEnvironmentPreset(timeOfDay = 'noon', weather = 'clear') {
    const look = this.environment.apply(timeOfDay, weather);
    this.renderer.toneMappingExposure = look.exposure;
    this.bloomPass.strength = look.bloom[0];
    this.bloomPass.radius = look.bloom[1];
    this.bloomPass.threshold = look.bloom[2];
    return look;
  }

  update(carGroup, physics, dt) {
    this.cameraRig.update(carGroup, physics, dt);
    this.environment.update(dt, carGroup.position);
  }

  render(dt = 1 / 60) {
    this.composer.render(dt);
    this.adaptQuality(dt);
  }

  adaptQuality(dt) {
    if (dt <= 0 || dt > 0.25) return;
    this.frameTimeAvg += (dt - this.frameTimeAvg) * 0.05;
    this.slowTime = this.frameTimeAvg > 1 / 42 ? this.slowTime + dt : 0;
    if (this.slowTime <= 2.5) return;
    this.slowTime = 0;
    this.frameTimeAvg = 1 / 60;
    if (this.ratioIndex < PIXEL_RATIO_STEPS.length - 1) {
      this.ratioIndex++;
      this.onWindowResize();
    } else if (this.qualityStage === 0) {
      // Resolution is already at the floor: shed bloom, then shadows
      this.qualityStage = 1;
      this.bloomPass.enabled = false;
    } else if (this.qualityStage === 1) {
      this.qualityStage = 2;
      this.environment.sunLight.castShadow = false;
    }
  }

  onWindowResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ratio = Math.min(PIXEL_RATIO_STEPS[this.ratioIndex], window.devicePixelRatio || 1);
    this.cameraRig.snap(); // a rotation changes the framing; don't ease into it
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
  }
}
