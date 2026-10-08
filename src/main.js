import { RenderEngine } from './engine/Renderer.js';
import { VehiclePhysics } from './engine/Physics.js';
import { TrackBuilder } from './engine/TrackBuilder.js';
import { AudioEngine } from './engine/AudioEngine.js';
import { CarModel } from './engine/CarModel.js';
import { InputManager } from './utils/InputManager.js';
import { HUD } from './ui/HUD.js';
import { TelemetryUI } from './ui/Telemetry.js';
import { GarageUI } from './ui/GarageUI.js';
import { TrackSelectUI } from './ui/TrackSelectUI.js';

class CorsaApp {
  constructor() {
    this.container = document.getElementById('canvas-container');

    // 1. Core Engines
    this.renderer = new RenderEngine(this.container);
    this.physics = new VehiclePhysics();
    this.audio = new AudioEngine();
    this.input = new InputManager();
    this.trackBuilder = new TrackBuilder(this.renderer.scene);
    this.carModel = new CarModel();

    // Add car to Three.js scene
    this.renderer.scene.add(this.carModel.group);

    // 2. UI Subsystems
    this.hud = new HUD();
    this.telemetryUI = new TelemetryUI();

    this.garageUI = new GarageUI(
      (config) => this.carModel.updateCustomization(config),
      (hp) => this.physics.setEngineTune(hp)
    );

    this.trackSelectUI = new TrackSelectUI(
      (trackId, weather) => this.loadTrack(trackId, weather),
      (tod, weather) => this.renderer.setEnvironmentPreset(tod, weather)
    );

    // Timing
    this.lastTime = performance.now();

    // Setup Event Listeners & Initialize
    this.setupEvents();
    this.loadTrack('apex', 'clear');

    // Start Game Loop
    requestAnimationFrame((t) => this.gameLoop(t));
  }

  setupEvents() {
    // Audio Start Overlay Unlock
    const startOverlay = document.getElementById('audio-start-overlay');
    const startBtn = document.getElementById('start-btn');

    const unlockAudio = () => {
      this.audio.unlock();
      if (startOverlay) startOverlay.classList.add('hidden');
    };

    if (startBtn) startBtn.addEventListener('click', unlockAudio);
    if (startOverlay) startOverlay.addEventListener('click', unlockAudio);

    // Navigation Buttons
    const modeBtn = document.getElementById('btn-mode');
    const modeLabel = document.getElementById('mode-label');
    if (modeBtn) {
      modeBtn.addEventListener('click', () => {
        const nextMode = this.physics.drivingMode === 'easy' ? 'normal' : 'easy';
        this.physics.setDrivingMode(nextMode);
        if (modeLabel) modeLabel.textContent = nextMode === 'easy' ? 'かんたんモード' : 'ノーマルモード';
      });
    }

    const camBtn = document.getElementById('btn-camera');
    const camLabel = document.getElementById('camera-mode-label');
    if (camBtn) {
      camBtn.addEventListener('click', () => {
        const mode = this.renderer.cycleCameraMode();
        if (camLabel) camLabel.textContent = mode.toUpperCase();
      });
    }

    const garageBtn = document.getElementById('btn-garage');
    if (garageBtn) {
      garageBtn.addEventListener('click', () => {
        this.garageUI.toggle();
        if (this.garageUI.visible) {
          this.renderer.cameraMode = 'orbit';
          if (camLabel) camLabel.textContent = 'ORBIT';
        }
      });
    }

    const trackBtn = document.getElementById('btn-track');
    if (trackBtn) {
      trackBtn.addEventListener('click', () => this.trackSelectUI.toggle());
    }

    const telemBtn = document.getElementById('btn-telemetry');
    if (telemBtn) {
      telemBtn.addEventListener('click', () => this.telemetryUI.toggle());
    }

    const audioBtn = document.getElementById('btn-audio');
    const audioIcon = document.getElementById('audio-icon');
    if (audioBtn) {
      audioBtn.addEventListener('click', () => {
        this.audio.setMuted(!this.audio.muted);
        if (audioIcon) audioIcon.textContent = this.audio.muted ? '🔇' : '🔊';
      });
    }

    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetCarPosition());
    }

    // Input Hotkey Callbacks
    this.input.onCameraPress = () => {
      const mode = this.renderer.cycleCameraMode();
      if (camLabel) camLabel.textContent = mode.toUpperCase();
    };

    this.input.onResetPress = () => this.resetCarPosition();
    this.input.onGarageToggle = () => this.garageUI.toggle();
    this.input.onTelemetryToggle = () => this.telemetryUI.toggle();

    this.input.onGearUp = () => {
      this.physics.shiftUp();
      this.audio.playBackfire();
    };

    this.input.onGearDown = () => {
      this.physics.shiftDown();
      this.audio.playBackfire();
    };

    // Touch On-Screen Controls
    const btnLeft = document.getElementById('touch-left-btn');
    const btnRight = document.getElementById('touch-right-btn');
    const btnAccel = document.getElementById('touch-accel-btn');
    const btnBrake = document.getElementById('touch-brake-btn');

    if (btnLeft) {
      btnLeft.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.touchSteer = -1; });
      btnLeft.addEventListener('touchend', (e) => { e.preventDefault(); this.input.touchSteer = 0; });
    }
    if (btnRight) {
      btnRight.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.touchSteer = 1; });
      btnRight.addEventListener('touchend', (e) => { e.preventDefault(); this.input.touchSteer = 0; });
    }
    if (btnAccel) {
      btnAccel.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.touchThrottle = 1; });
      btnAccel.addEventListener('touchend', (e) => { e.preventDefault(); this.input.touchThrottle = 0; });
    }
    if (btnBrake) {
      btnBrake.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.touchBrake = 1; });
      btnBrake.addEventListener('touchend', (e) => { e.preventDefault(); this.input.touchBrake = 0; });
    }
  }

  loadTrack(trackId, weather = 'clear') {
    this.trackSpline = this.trackBuilder.buildTrack(trackId, weather);

    // Update track name badge
    const badge = document.getElementById('track-name-badge');
    if (badge) {
      const names = { apex: 'APEX CIRCUIT', city: 'NEO CITY HIGHWAY', desert: 'DESERT CANYON' };
      badge.textContent = names[trackId] || 'CIRCUIT';
    }

    // Default Environment for track
    let defaultTod = 'noon';
    if (trackId === 'city') defaultTod = 'midnight';
    if (trackId === 'desert') defaultTod = 'sunset';

    this.renderer.setEnvironmentPreset(defaultTod, weather);
    this.resetCarPosition();
  }

  resetCarPosition() {
    // Reset vehicle to start/finish line facing track tangent
    const startPt = this.trackSpline ? this.trackSpline.getPoint(0) : { x: 0, y: 0.4, z: 0 };
    const tangent = this.trackSpline ? this.trackSpline.getTangent(0) : { x: 0, y: 0, z: 1 };
    const heading = Math.atan2(tangent.x, tangent.z);

    this.physics.reset(startPt, heading);
    this.carModel.group.position.copy(this.physics.position);
    this.carModel.group.rotation.y = -this.physics.heading;

    this.renderer.snapCamera(this.carModel.group, this.physics);
  }

  gameLoop(now) {
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // 1. Process Multi-device Input
    this.input.update();

    // 2. Step Vehicle Physics Engine & Lap Timing
    this.physics.update(this.input, dt, this.trackBuilder);

    // Update 3D Car Position & Rotation in Three.js Scene
    this.carModel.group.position.copy(this.physics.position);
    this.carModel.group.rotation.y = -this.physics.heading;
    this.carModel.group.rotation.z = this.physics.roll;
    this.carModel.group.rotation.x = this.physics.pitch;

    // Animate wheels spin, steering angle, and brake lights
    this.carModel.updateAnimation(
      this.physics.steerAngle,
      this.physics.speedKmh,
      this.physics.isBraking,
      dt
    );

    // 3. Update Audio Synthesizer
    this.audio.update(
      this.physics.rpm,
      this.input.throttle,
      this.physics.slipAmount,
      this.physics.speedKmh
    );

    // 4. Update Camera
    this.renderer.updateCamera(this.carModel.group, this.physics, dt);

    // 5. Update HUD Overlay (Speedometer, Tachometer, Shift lights, Minimap)
    this.hud.update(this.physics, this.trackSpline);

    // 6. Update Telemetry Panel
    this.telemetryUI.update(this.physics, this.input);

    // 7. Render Three.js WebGL Frame
    this.renderer.render();

    requestAnimationFrame((t) => this.gameLoop(t));
  }
}

// Instantiate Corsa App when DOM ready
window.addEventListener('DOMContentLoaded', () => {
  new CorsaApp();
});
