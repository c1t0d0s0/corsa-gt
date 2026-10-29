import { RenderEngine } from './engine/Renderer.js';
import { VehiclePhysics } from './engine/Physics.js';
import { TrackBuilder } from './engine/TrackBuilder.js';
import { AudioEngine } from './engine/AudioEngine.js';
import { CarModel } from './engine/CarModel.js';
import { getCarSpec } from './engine/CarSpecs.js';
import { Effects } from './engine/Effects.js';
import { getTrackDef } from './engine/track/TrackData.js';
import { randomSeed } from './engine/endless/Biomes.js';
import { InputManager } from './utils/InputManager.js';
import { HUD } from './ui/HUD.js';
import { TelemetryUI } from './ui/Telemetry.js';
import { GarageUI } from './ui/GarageUI.js';
import { TrackSelectUI } from './ui/TrackSelectUI.js';
import { TouchControls } from './ui/TouchControls.js';
import { t, applyTranslations } from './i18n.js';

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
    this.trackBuilder = new TrackBuilder(this.renderer.scene, { mobile: this.touch.enabled });
    this.carModel = null; // built by setCar() once the garage settings exist
    this.effects = new Effects(this.renderer.scene);

    // 2. UI Subsystems
    this.hud = new HUD();
    this.telemetryUI = new TelemetryUI();
    // Too small to show telemetry without hiding the car (phones); matches the rule in style.css
    this.smallScreen = window.matchMedia('(max-height: 520px), (max-width: 600px)');
    this.smallScreen.addEventListener('change', () => {
      if (this.smallScreen.matches && this.telemetryUI.visible) this.telemetryUI.toggle();
    });

    this.garageUI = new GarageUI(
      (config) => {
        this.setCar(config.carId);
        this.carModel.updateCustomization(config);
      },
      (hp) => {
        this.physics.setEngineTune(hp);
        return this.physics.estimateTopSpeedKmh();
      }
    );

    this.trackSelectUI = new TrackSelectUI(
      (trackId, { seed } = {}) => this.loadTrack(trackId, null, { seed }),
      (tod, weather) => this.setEnvironment(tod, weather)
    );

    this.started = false;
    this.paused = false;
    this.cameraBeforeGarage = null;
    this.recovering = false;
    this.weather = params.get('weather') === 'rainy' ? 'rainy' : 'clear';
    this.timeOfDay = 'noon';
    this.lastTime = performance.now();
    this.frameError = false;

    this.setupEvents();
    this.garageUI.currentConfig.carId = getCarSpec(params.get('car')).id;
    this.garageUI.selectCar(this.garageUI.currentConfig.carId);
    this.garageUI.applyAll();
    this.loadTrack(params.get('track') || 'apex', params.get('tod'), { seed: params.get('seed') || randomSeed() });
    if (params.get('autopilot') === '1') this.setAutopilot(true);
    this.startCamera = params.get('cam') || 'chase';
    if (params.get('autostart') === '1') {
      this.start(false);
    } else {
      // Title screen: circle the car until the driver hits the ignition
      this.renderer.cameraRig.titleView = true;
      this.setCamera('orbit');
    }

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
    if (this.started) return;
    if (withAudio) this.audio.unlock();
    if (withAudio && this.touch.enabled) this.enterLandscape();
    this.started = true;
    this.renderer.cameraRig.titleView = false;
    this.setCamera(this.startCamera);
    document.body.classList.remove('pre-start');
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

  /** Swap the car (body, handling and engine note), keeping paint and wheels. */
  setCar(id) {
    const spec = getCarSpec(id);
    if (this.carModel && this.carModel.spec.id === spec.id) return;
    const cfg = this.garageUI.currentConfig;
    const old = this.carModel;
    this.carModel = new CarModel({
      spec, bodyColor: cfg.bodyColor, paintFinish: cfg.paintFinish, rimColor: cfg.rimColor, wingStyle: cfg.wingStyle
    });
    if (old) {
      this.renderer.scene.remove(old.group);
      old.dispose();
    }
    this.renderer.scene.add(this.carModel.group);
    this.physics.setCar(spec.physics);
    this.audio.setEngine(spec.audio);
    if (this.look) this.carModel.setLights(this.look.headlights, this.look.night);
    const mode = this.renderer.cameraMode;
    this.carModel.setInteriorVisible(mode === 'cockpit');
    this.carModel.setHeadlampsVisible(mode !== 'hood' && mode !== 'cockpit');
    this.carModel.update(this.physics, 0);
  }

  setCamera(mode) {
    const applied = this.renderer.setCameraMode(mode);
    this.carModel.setInteriorVisible(applied === 'cockpit');
    this.carModel.setHeadlampsVisible(applied !== 'hood' && applied !== 'cockpit');
    this.audio.setInterior(applied === 'cockpit');
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

  toggleTelemetry() {
    if (this.smallScreen.matches) return;
    this.telemetryUI.toggle();
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
    window.addEventListener('keydown', (e) => { if (!this.started && e.code === 'Enter') this.start(); });

    const on = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (e) => { handler(e); el.blur(); });
    };

    on('btn-mode', () => {
      const next = this.physics.drivingMode === 'easy' ? 'normal' : 'easy';
      this.physics.setDrivingMode(next);
      const label = document.getElementById('mode-label');
      if (label) label.textContent = t(next === 'easy' ? 'mode.easy' : 'mode.normal');
    });
    on('btn-auto', () => this.setAutopilot(!this.physics.autopilot));
    on('btn-camera', () => this.cycleCamera());
    on('btn-garage', () => this.toggleGarage());
    on('garage-close-btn', () => this.toggleGarage());
    on('btn-track', () => this.trackSelectUI.toggle());
    on('btn-telemetry', () => this.toggleTelemetry());
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
    this.input.onTelemetryToggle = () => this.toggleTelemetry();
    this.input.onPause = () => this.togglePause();
    this.input.onAutopilotToggle = () => this.setAutopilot(!this.physics.autopilot);
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

  /** @param options.seed  endless road only: which road to generate */
  loadTrack(trackId, timeOfDay = null, { seed = null } = {}) {
    const path = this.trackBuilder.build(trackId === 'endless' ? 'endless' : getTrackDef(trackId).id, { seed: seed || randomSeed() });
    const def = path.def;
    this.physics.setTrack(path);
    this.effects.clear();
    this.hud.setTrack(path);

    const badge = document.getElementById('track-name-badge');
    if (badge) badge.textContent = def.name;

    const tod = ['noon', 'sunset', 'midnight'].includes(timeOfDay) ? timeOfDay : def.defaultTod;
    this.trackSelectUI.sync(def.id, tod, this.weather, path.endless ? path.seed : null);
    this.setEnvironment(tod, this.weather);
    this.carModel.update(this.physics, 0);
    this.renderer.snapCamera();
  }

  setEnvironment(timeOfDay, weather) {
    this.timeOfDay = timeOfDay;
    this.weather = weather;
    const look = this.renderer.setEnvironmentPreset(timeOfDay, weather);
    this.look = look;
    this.trackBuilder.setLook(look);
    this.carModel.setLights(look.headlights, look.night);
    this.effects.setLook(look);
    this.physics.setWeather(weather);
  }

  /** Back to the grid for a fresh run. */
  restart() {
    // The endless road behind the car is long gone: start the same road over from its beginning
    const track = this.physics.track;
    if (track && track.endless) {
      this.loadTrack('endless', this.timeOfDay, { seed: track.seed });
      return;
    }
    this.physics.reset();
    this.effects.breakSkids();
    this.renderer.snapCamera();
  }

  setAutopilot(on) {
    this.physics.autopilot = on;
    document.getElementById('btn-auto')?.classList.toggle('active', on);
  }

  /** Endless road: the car strayed too far or into water. Fade out, put it back, fade in. */
  autoRecover() {
    if (this.recovering) return;
    this.recovering = true;
    const fade = document.getElementById('fade-overlay');
    fade?.classList.add('show');
    setTimeout(() => {
      this.recover();
      fade?.classList.remove('show');
      this.recovering = false;
    }, 280);
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
    if (this.physics.needsRecover) this.autoRecover();

    this.carModel.update(this.physics, running ? dt : 0);

    if (this.physics.shiftEvent !== 0) {
      // Harder shifts (more revs, more throttle) bark louder
      const intensity = 0.4 + 0.6 * this.physics.throttle * (this.physics.rpm / this.physics.maxRpm);
      if (running && this.physics.speedKmh > 15) this.audio.playShift(this.physics.shiftEvent, intensity);
      this.physics.shiftEvent = 0;
    }
    this.audio.update({
      rpm: this.physics.rpm,
      maxRpm: this.physics.maxRpm,
      throttle: this.physics.throttle,
      cut: this.physics.shiftTimer > 0.13,
      slip: this.physics.slipAmount,
      speedKmh: this.physics.speedKmh,
      surface: this.physics.surface,
      wet: this.weather === 'rainy',
      wallHit: this.physics.wallHit,
      running
    }, dt);

    this.renderer.update(this.carModel.group, this.physics, dt);
    this.trackBuilder.update(this.carModel.group.position, dt);
    const world = this.trackBuilder.world;
    if (world) {
      const air = world.gen.paramsCached(world.carAbs);
      this.renderer.environment.setRegion(air.haze, air.warm);
    } else {
      this.renderer.environment.setRegion(1, 0);
    }
    const cam = this.renderer.camera;
    const bufferHeight = this.renderer.renderer.domElement.height;
    this.effects.update(this.physics, this.carModel.group, running ? dt : 0, bufferHeight / (2 * Math.tan((cam.fov * Math.PI) / 360)));

    this.hud.update(this.physics);
    this.telemetryUI.update(this.physics, this.input);

    this.renderer.render(dt);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  window.corsa = new CorsaApp();
});
