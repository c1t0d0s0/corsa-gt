import { formatTime } from '../utils/MathUtils.js';
import { t } from '../i18n.js';

/**
 * Glassmorphic Racing HUD Interface Controller.
 * Renders Speedometer, Tachometer with shift lights, Lap Timing, and Dynamic Minimap.
 */
export class HUD {
  constructor() {
    this.speedEl = document.getElementById('hud-speed-val');
    this.speedUnitEl = document.getElementById('hud-speed-unit');
    this.rpmEl = document.getElementById('hud-rpm-val');
    this.gearEl = document.getElementById('hud-gear-val');

    this.lapCurrentEl = document.getElementById('hud-lap-current');
    this.lapBestEl = document.getElementById('hud-lap-best');
    this.lapNumberEl = document.getElementById('hud-lap-num');
    this.sectorEl = document.getElementById('hud-sector');
    this.lapLabelEls = [document.getElementById('hud-lap-label-1'), document.getElementById('hud-lap-label-2')];
    this.lapBox = document.querySelector('.hud-lap-box');

    this.shiftLights = document.querySelectorAll('.shift-light');
    this.tachBar = document.getElementById('hud-tach-bar');

    this.minimapCanvas = document.getElementById('hud-minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;

    this.useMph = false;
    this.mapCanvas = document.createElement('canvas');
    this.worldToMap = null;
    this.cache = {};
    this.endless = null; // the endless road's path, when driving it
    this.mapAge = 0;
  }

  /** Write text only when it changed, to keep the DOM quiet at 60fps. */
  setText(el, key, value) {
    if (!el || this.cache[key] === value) return;
    this.cache[key] = value;
    el.textContent = value;
  }

  /** Pre-render the circuit outline once per track. */
  setTrack(path) {
    this.endless = path.endless ? path : null;
    this.cache = {};
    if (this.lapBox) this.lapBox.classList.toggle('endless', !!this.endless);
    this.setText(this.lapLabelEls[0], 'label1', this.endless ? t('hud.distance') : 'CURRENT');
    this.setText(this.lapLabelEls[1], 'label2', this.endless ? t('hud.seed') : 'BEST');
    if (this.endless) {
      this.worldToMap = null;
      return;
    }
    if (!this.minimapCanvas) return;
    const width = this.minimapCanvas.width;
    const height = this.minimapCanvas.height;
    this.mapCanvas.width = width;
    this.mapCanvas.height = height;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < path.n; i++) {
      minX = Math.min(minX, path.px[i]);
      maxX = Math.max(maxX, path.px[i]);
      minZ = Math.min(minZ, path.pz[i]);
      maxZ = Math.max(maxZ, path.pz[i]);
    }
    const margin = 16;
    const scale = Math.min((width - margin * 2) / (maxX - minX || 1), (height - margin * 2) / (maxZ - minZ || 1));
    const offX = (width - (maxX - minX) * scale) / 2;
    const offY = (height - (maxZ - minZ) * scale) / 2;
    // Top-down with +Z (the start straight) pointing up; +X is the driver's left, so it maps to screen-left
    this.worldToMap = (x, z) => ({ x: offX + (maxX - x) * scale, y: offY + (maxZ - z) * scale });

    const ctx = this.mapCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    for (let i = 0; i < path.n; i += 4) {
      const m = this.worldToMap(path.px[i], path.pz[i]);
      if (i === 0) ctx.moveTo(m.x, m.y);
      else ctx.lineTo(m.x, m.y);
    }
    ctx.closePath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.stroke();

    const startM = this.worldToMap(path.px[0], path.pz[0]);
    ctx.beginPath();
    ctx.fillStyle = '#ef4444';
    ctx.arc(startM.x, startM.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }


  update(physics) {
    // 1. Speed & Gear
    const speed = this.useMph ? physics.speedKmh * 0.621371 : physics.speedKmh;
    this.setText(this.speedEl, 'speed', Math.round(speed).toString());
    this.setText(this.speedUnitEl, 'unit', this.useMph ? 'MPH' : 'KM/H');
    this.setText(this.gearEl, 'gear', physics.currentGear === 0 ? 'R' : physics.currentGear.toString());

    // 2. Tachometer & Shift Lights
    const rpm = physics.rpm;
    this.setText(this.rpmEl, 'rpm', (Math.round(rpm / 50) * 50).toString());

    const maxRpm = physics.maxRpm;
    const rpmRatio = Math.min(1.0, Math.max(0, (rpm - 1000) / (maxRpm - 1000)));

    if (this.tachBar) {
      this.tachBar.style.width = `${(rpmRatio * 100).toFixed(1)}%`;
      const color = rpmRatio > 0.85 ? '#ef4444' : rpmRatio > 0.65 ? '#eab308' : '#22c55e';
      if (this.cache.tachColor !== color) {
        this.cache.tachColor = color;
        this.tachBar.style.backgroundColor = color;
      }
    }

    // Shift Light LED row (5 LEDs)
    if (this.shiftLights && this.shiftLights.length > 0) {
      const activeThresholds = [0.4, 0.55, 0.7, 0.82, 0.92];
      this.shiftLights.forEach((light, i) => {
        const active = rpmRatio >= activeThresholds[i];
        light.classList.toggle('active', active);
        light.classList.toggle('flash', active && i === 4 && rpmRatio >= 0.94);
      });
    }

    // 3. Lap Timing & Sector; on the endless road, distance, landscape and seed instead
    if (this.endless) {
      this.setText(this.lapCurrentEl, 'lap', `${(physics.totalDistance / 1000).toFixed(1)} km`);
      this.setText(this.lapBestEl, 'best', this.endless.seed);
      this.setText(this.lapNumberEl, 'lapNum', t(`biome.${this.endless.biomeAt(physics.q.index)}`));
      this.setText(this.sectorEl, 'sector', formatTime(physics.currentLapTime));
      if (this.minimapCtx && --this.mapAge <= 0) this.drawEndlessMap(physics);
    } else {
      this.setText(this.lapCurrentEl, 'lap', formatTime(physics.lapStarted ? physics.currentLapTime : 0));
      this.setText(this.lapBestEl, 'best', formatTime(physics.bestLapTime === null ? NaN : physics.bestLapTime));
      this.setText(this.lapNumberEl, 'lapNum', `LAP ${physics.currentLap}`);
      this.setText(this.sectorEl, 'sector', `SECTOR ${physics.currentSector}`);
    }

    // 4. Minimap Rendering
    if (this.minimapCtx && this.worldToMap) this.renderMinimap(physics);
  }

  /** The endless road around the car, redrawn every few frames since it never stops changing. */
  drawEndlessMap(physics) {
    this.mapAge = 15;
    const path = this.endless;
    const width = this.minimapCanvas.width;
    const height = this.minimapCanvas.height;
    this.mapCanvas.width = width;
    this.mapCanvas.height = height;
    const scale = width / 1800;
    const cx = physics.position.x;
    const cz = physics.position.z;
    // Same orientation as the circuit maps: +Z up, +X to the left
    this.worldToMap = (x, z) => ({ x: width / 2 - (x - cx) * scale, y: height / 2 - (z - cz) * scale });

    const ctx = this.mapCanvas.getContext('2d');
    const carAbs = path.sAbs[physics.q.index];
    ctx.beginPath();
    let first = true;
    for (let k = Math.max(path.tail, carAbs - 1000); k < Math.min(path.head, carAbs + 1600); k += 6) {
      const i = k % path.n;
      const m = this.worldToMap(path.dx[i], path.dz[i]);
      if (first) ctx.moveTo(m.x, m.y); else ctx.lineTo(m.x, m.y);
      first = false;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.stroke();
  }

  renderMinimap(physics) {
    const ctx = this.minimapCtx;
    ctx.clearRect(0, 0, this.minimapCanvas.width, this.minimapCanvas.height);
    ctx.drawImage(this.mapCanvas, 0, 0);

    const carM = this.worldToMap(physics.renderPosition.x, physics.renderPosition.z);
    ctx.save();
    ctx.translate(carM.x, carM.y);
    // Heading 0 faces +Z (up on the map); positive heading turns left (counter-clockwise on screen)
    ctx.rotate(-physics.renderHeading);

    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#0284c7';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-4, 5);
    ctx.lineTo(4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
