import * as THREE from 'three';
import { damp } from '../utils/MathUtils.js';

/**
 * Three.js WebGL Scene, Camera, Lighting, and Environment Manager.
 */
export class RenderEngine {
  constructor(containerElement) {
    this.container = containerElement;

    // 1. Three.js Scene Setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a);
    this.scene.fog = new THREE.FogExp2(0x0f172a, 0.0025);

    // 2. Camera Setup
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1500
    );
    this.cameraMode = 'chase'; // 'chase', 'hood', 'cockpit', 'orbit'
    this.cameraOffset = new THREE.Vector3(0, 2.6, -6.5);

    // Orbit Camera State for Garage Mode
    this.orbitAngle = 0;
    this.orbitDistance = 8.0;
    this.orbitHeight = 2.2;

    // 3. WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.appendChild(this.renderer.domElement);

    // 4. Lighting System
    this.setupLighting();

    // 5. Window Resize Handler
    window.addEventListener('resize', () => this.onWindowResize());
  }

  setupLighting() {
    // Hemisphere Sky/Ground Light
    this.hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 0.8);
    this.hemiLight.position.set(0, 50, 0);
    this.scene.add(this.hemiLight);

    // Directional Sun Light with Shadows
    this.sunLight = new THREE.DirectionalLight(0xfff7ed, 2.0);
    this.sunLight.position.set(100, 150, 100);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 400;
    const d = 120;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;

    this.scene.add(this.sunLight);

    // Ambient Light
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.ambientLight);
  }

  setEnvironmentPreset(timeOfDay = 'noon', weather = 'clear') {
    if (timeOfDay === 'noon') {
      this.scene.background.setHex(0x38bdf8);
      this.scene.fog.color.setHex(0x38bdf8);
      this.scene.fog.density = weather === 'rainy' ? 0.006 : 0.002;

      this.sunLight.color.setHex(0xfff7ed);
      this.sunLight.intensity = weather === 'rainy' ? 1.0 : 2.2;
      this.sunLight.position.set(100, 200, 80);
      this.hemiLight.color.setHex(0xbae6fd);
    } else if (timeOfDay === 'sunset') {
      this.scene.background.setHex(0xf97316);
      this.scene.fog.color.setHex(0xca8a04);
      this.scene.fog.density = 0.0035;

      this.sunLight.color.setHex(0xfc6d26);
      this.sunLight.intensity = 2.8;
      this.sunLight.position.set(-150, 40, -100);
      this.hemiLight.color.setHex(0xfde047);
    } else if (timeOfDay === 'midnight') {
      this.scene.background.setHex(0x05050a);
      this.scene.fog.color.setHex(0x05050a);
      this.scene.fog.density = 0.004;

      this.sunLight.color.setHex(0x38bdf8);
      this.sunLight.intensity = 0.3;
      this.sunLight.position.set(0, 100, 0);
      this.hemiLight.color.setHex(0x1e1b4b);
    }
  }

  cycleCameraMode() {
    const modes = ['chase', 'hood', 'cockpit', 'orbit'];
    const nextIdx = (modes.indexOf(this.cameraMode) + 1) % modes.length;
    this.cameraMode = modes[nextIdx];
    return this.cameraMode;
  }

  snapCamera(carGroup) {
    if (!carGroup) return;
    carGroup.updateMatrixWorld(true);

    if (this.cameraMode === 'chase') {
      const localOffset = new THREE.Vector3(0, 2.5, -6.5);
      const worldOffset = localOffset.applyMatrix4(carGroup.matrixWorld);

      const localTarget = new THREE.Vector3(0, 1.1, 15.0);
      const worldTarget = localTarget.applyMatrix4(carGroup.matrixWorld);

      this.camera.position.copy(worldOffset);
      this.camera.lookAt(worldTarget);
    }
  }

  updateCamera(carGroup, vehiclePhysics, dt) {
    if (!carGroup) return;

    carGroup.updateMatrixWorld(true);

    const speedKmh = vehiclePhysics ? vehiclePhysics.speedKmh : 0;

    // FOV Speed Boost Effect
    const targetFov = 60 + (speedKmh / 280) * 18;
    this.camera.fov = damp(this.camera.fov, targetFov, 6.0, dt);
    this.camera.updateProjectionMatrix();

    if (this.cameraMode === 'chase') {
      // 3D Third Person Chase Cam - Rigidly locked using vehicle world matrix
      const localOffset = new THREE.Vector3(0, 2.5, -6.5);
      const worldOffset = localOffset.applyMatrix4(carGroup.matrixWorld);

      const localTarget = new THREE.Vector3(0, 1.1, 15.0);
      const worldTarget = localTarget.applyMatrix4(carGroup.matrixWorld);

      // Lock camera directly behind vehicle at all times without lag or side-drift
      this.camera.position.copy(worldOffset);
      this.camera.lookAt(worldTarget);
    } else if (this.cameraMode === 'hood') {
      // First Person Hood Cam
      const hoodPos = new THREE.Vector3(
        carPos.x + Math.sin(heading) * 1.3,
        carPos.y + 0.95,
        carPos.z + Math.cos(heading) * 1.3
      );
      const hoodTarget = new THREE.Vector3(
        carPos.x + Math.sin(heading) * 20.0,
        carPos.y + 0.9,
        carPos.z + Math.cos(heading) * 20.0
      );

      this.camera.position.copy(hoodPos);
      this.camera.lookAt(hoodTarget);
    } else if (this.cameraMode === 'cockpit') {
      // Driver Interior Cockpit Cam
      const cockpitPos = new THREE.Vector3(
        carPos.x + Math.sin(heading) * -0.3 - Math.cos(heading) * 0.4,
        carPos.y + 0.98,
        carPos.z + Math.cos(heading) * -0.3 + Math.sin(heading) * 0.4
      );
      const cockpitTarget = new THREE.Vector3(
        carPos.x + Math.sin(heading) * 15.0,
        carPos.y + 0.95,
        carPos.z + Math.cos(heading) * 15.0
      );

      this.camera.position.copy(cockpitPos);
      this.camera.lookAt(cockpitTarget);
    } else if (this.cameraMode === 'orbit') {
      // Orbit Cam (Rotate around vehicle)
      this.orbitAngle += 0.4 * dt;
      const x = carPos.x + Math.sin(this.orbitAngle) * this.orbitDistance;
      const z = carPos.z + Math.cos(this.orbitAngle) * this.orbitDistance;
      const y = carPos.y + this.orbitHeight;

      this.camera.position.set(x, y, z);
      this.camera.lookAt(new THREE.Vector3(carPos.x, carPos.y + 0.6, carPos.z));
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
