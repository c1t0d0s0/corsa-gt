import { RenderEngine } from './engine/Renderer.js';
import { VehiclePhysics } from './engine/Physics.js';
import { TrackBuilder } from './engine/TrackBuilder.js';
import { AudioEngine } from './engine/AudioEngine.js';
import { CarModel } from './engine/CarModel.js';
import { Effects } from './engine/Effects.js';
import { getTrackDef } from './engine/track/TrackData.js';
import { InputManager } from './utils/InputManager.js';
import { HUD } from './ui/HUD.js';
import { TelemetryUI } from './ui/Telemetry.js';
import { GarageUI } from './ui/GarageUI.js';
import { TrackSelectUI } from './ui/TrackSelectUI.js';
import { TouchControls } from './ui/TouchControls.js';

class CorsaApp {
  constructor() {
    this.container = document.getElementById('canvas-container');
    // Dev/demo switches: ?autostart=1&autopilot=1&track=city&tod=sunset&weather=rainy&cam=hood&t=20
    const params = new URLSearchParams(window.location.search);

    // 1. Core Engines
    this.physics = new VehiclePhysics();
    this.audio = new AudioEngine();
    this.input = new InputManager();
    this.touch = new TouchControls(this.input, { onRecover: () => this.recover() });
    this.renderer = new RenderEngine(this.container, { mobile: this.touch.enabled });
    this.trackBuilder = new TrackBuilder(this.renderer.scene);
    this.carModel = new CarModel();
    this.effects = new Effects(this.renderer.scene);
    this.renderer.scene.add(this.carModel.group);

    // 2. UI Subsystems
    this.hud = new HUD();
    this.telemetryUI = new TelemetryUI();

    this.garageUI = new GarageUI(
      (config) => this.carModel.updateCustomization(config),
      (hp) => {
        this.physics.setEngineTune(hp);
        return this.physics.estimateTopSpeedKmh();
      }
    );

    this.trackSelectUI = new TrackSelectUI(
      (trackId) => this.loadTrack(trackId),
      (tod, weather) => this.setEnvironment(tod, weather)
    );

    this.started = false;
    this.paused = false;
    this.cameraBeforeGarage = null;
    this.weather = params.get('weather') === 'rainy' ? 'rainy' : 'clear';
    this.timeOfDay = 'noon';
    this.lastTime = performance.now();
    this.frameError = false;

    this.setupEvents();
    this.garageUI.applyAll();
    this.physics.autopilot = params.get('autopilot') === '1';
    this.loadTrack(params.get('track') || 'apex', params.get('tod'));
    if (params.get('cam')) this.setCamera(params.get('cam'));
    if (params.get('autostart') === '1') this.start(false);

    // Fast-forward the simulation, handy for capturing a specific moment
    const skip = Math.min(600, parseFloat(params.get('t')) || 0);
    for (let i = 0; i < skip * 120; i++) this.physics.step(this.input, 1 / 120);
    if (skip > 0) {
      this.physics.prevPosition.copy(this.physics.position);
      this.physics.prevHeading = this.physics.heading;
    }

    requestAnimationFrame((t) => this.gameLoop(t));
  }

  start(withAudio = true) {
    if (withAudio) this.audio.unlock();
    if (withAudio && this.touch.enabled) this.enterLandscape();
    this.started = true;
    const overlay = document.getElementById('audio-start-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  /** Phones: go fullscreen and pin landscape where the browser allows it (Android; iOS just rotates). */
  enterLandscape() {
    const root = document.documentElement;
    if (!root.requestFullscreen) return;
    root.requestFullscreen({ navigationUI: 'hide' })
      .then(() => window.screen.orientation && window.screen.orientation.lock && window.screen.orientation.lock('landscape'))
      .catch(() => {});
  }

  setCamera(mode) {
    const applied = this.renderer.setCameraMode(mode);
    this.carModel.setInteriorVisible(applied === 'cockpit');
    const label = document.getElementById('camera-mode-label');
    if (label) label.textContent = applied.toUpperCase();
    return applied;
  }

  cycleCamera() {
    const modes = ['chase', 'hood', 'cockpit', 'orbit'];
    this.setCamera(modes[(modes.indexOf(this.renderer.cameraMode) + 1) % modes.length]);
  }

  toggleGarage() {
    this.garageUI.toggle();
    this.renderer.cameraRig.panelOpen = this.garageUI.visible;
    if (this.garageUI.visible) {
      this.cameraBeforeGarage = this.renderer.cameraMode;
      this.setCamera('orbit');
    } else if (this.cameraBeforeGarage) {
      this.setCamera(this.cameraBeforeGarage);
      this.cameraBeforeGarage = null;
    }
  }

  togglePause() {
    if (!this.started) return;
    if (this.garageUI.visible) { this.toggleGarage(); return; }
    if (this.trackSelectUI.visible) { this.trackSelectUI.toggle(); return; }
    this.paused = !this.paused;
    this.audio.setPaused(this.paused);
    const overlay = document.getElementById('pause-overlay');
    if (overlay) overlay.classList.toggle('hidden', !this.paused);
  }

  updateTransmissionLabel() {
    const label = document.getElementById('hud-trans');
    if (label) label.textContent = this.physics.transmission === 'auto' ? 'AT' : 'MT';
  }

  setupEvents() {
    const startOverlay = document.getElementById('audio-start-overlay');
    if (startOverlay) startOverlay.addEventListener('click', () => this.start());

    const on = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (e) => { handler(e); el.blur(); });
    };

    on('btn-mode', () => {
      const next = this.physics.drivingMode === 'easy' ? 'normal' : 'easy';
      this.physics.setDrivingMode(next);
      const label = document.getElementById('mode-label');
      if (label) label.textContent = next === 'easy' ? 'かんたんモード' : 'ノーマルモード';
    });
    on('btn-camera', () => this.cycleCamera());
    on('btn-garage', () => this.toggleGarage());
    on('garage-close-btn', () => this.toggleGarage());
    on('btn-track', () => this.trackSelectUI.toggle());
    on('btn-telemetry', () => this.telemetryUI.toggle());
    on('btn-audio', () => {
      this.audio.setMuted(!this.audio.muted);
      const icon = document.getElementById('audio-icon');
      if (icon) icon.textContent = this.audio.muted ? '🔇' : '🔊';
    });
    on('btn-reset', () => this.restart());
    on('pause-overlay', () => this.togglePause());

    // Hotkeys
    this.input.onCameraPress = () => this.cycleCamera();
    this.input.onResetPress = () => this.recover();
    this.input.onGarageToggle = () => this.toggleGarage();
    this.input.onTelemetryToggle = () => this.telemetryUI.toggle();
    this.input.onPause = () => this.togglePause();
    this.input.onTransmissionToggle = () => {
      this.physics.toggleTransmission();
      this.updateTransmissionLabel();
    };
    this.input.onGearUp = () => this.physics.shiftUp();
    this.input.onGearDown = () => this.physics.shiftDown();

    document.addEventListener('visibilitychange', () => {
      this.lastTime = performance.now();
      this.input.releaseAll();
    });
  }

  loadTrack(trackId, timeOfDay = null) {
    const def = getTrackDef(trackId);
    const path = this.trackBuilder.build(def.id);
    this.physics.setTrack(path);
    this.effects.clear();
    this.hud.setTrack(path);

    const badge = document.getElementById('track-name-badge');
    if (badge) badge.textContent = def.name;

    const tod = ['noon', 'sunset', 'midnight'].includes(timeOfDay) ? timeOfDay : def.defaultTod;
    this.trackSelectUI.sync(def.id, tod, this.weather);
    this.setEnvironment(tod, this.weather);
    this.carModel.update(this.physics, 0);
    this.renderer.snapCamera();
  }

  setEnvironment(timeOfDay, weather) {
    this.timeOfDay = timeOfDay;
    this.weather = weather;
    const look = this.renderer.setEnvironmentPreset(timeOfDay, weather);
    this.trackBuilder.setLook(look);
    this.carModel.setLights(look.headlights, look.night);
    this.effects.setLook(look);
    this.physics.setWeather(weather);
  }

  /** Back to the grid for a fresh run. */
  restart() {
    this.physics.reset();
    this.effects.breakSkids();
    this.renderer.snapCamera();
  }

  /** Lift the car back onto the road where it is. */
  recover() {
    this.physics.recover();
    this.effects.breakSkids();
    this.renderer.snapCamera();
  }

  gameLoop(now) {
    requestAnimationFrame((t) => this.gameLoop(t));
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    // A bad frame must never kill the loop; report it once and keep going
    try {
      this.frame(dt);
      this.frameError = false;
    } catch (err) {
      if (!this.frameError) console.error('Frame failed:', err);
      this.frameError = true;
    }
  }

  frame(dt) {
    const menuOpen = this.garageUI.visible || this.trackSelectUI.visible;
    const running = this.started && !this.paused && !menuOpen && !this.touch.portrait;
    document.body.classList.toggle('menu-open', menuOpen); // hides the on-screen driving controls

    this.input.update(dt);
    if (running) this.physics.update(this.input, dt);

    this.carModel.update(this.physics, running ? dt : 0);

    if (this.physics.shiftEvent !== 0) {
      if (running && this.physics.speedKmh > 20) this.audio.playBackfire();
      this.physics.shiftEvent = 0;
    }
    this.audio.update(
      this.physics.rpm,
      running ? this.physics.throttle : 0,
      running ? this.physics.slipAmount : 0,
      this.physics.speedKmh
    );

    this.renderer.update(this.carModel.group, this.physics, dt);
    const cam = this.renderer.camera;
    const bufferHeight = this.renderer.renderer.domElement.height;
    this.effects.update(this.physics, this.carModel.group, running ? dt : 0, bufferHeight / (2 * Math.tan((cam.fov * Math.PI) / 360)));

    this.hud.update(this.physics);
    this.telemetryUI.update(this.physics, this.input);

    this.renderer.render(dt);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.corsa = new CorsaApp();
});
