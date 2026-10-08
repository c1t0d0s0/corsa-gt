import { formatTime, formatDelta } from '../utils/MathUtils.js';

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

    this.shiftLights = document.querySelectorAll('.shift-light');
    this.tachBar = document.getElementById('hud-tach-bar');

    this.minimapCanvas = document.getElementById('hud-minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;

    this.useMph = false;
  }

  update(physics, trackSpline) {
    // 1. Speed & Gear
    const speed = this.useMph ? physics.speedKmh * 0.621371 : physics.speedKmh;
    if (this.speedEl) this.speedEl.textContent = Math.round(speed).toString();
    if (this.speedUnitEl) this.speedUnitEl.textContent = this.useMph ? 'MPH' : 'KM/H';

    let gearText = physics.currentGear.toString();
    if (physics.currentGear === 0) gearText = 'R';
    if (this.gearEl) this.gearEl.textContent = gearText;

    // 2. Tachometer & Shift Lights
    const rpm = physics.rpm;
    if (this.rpmEl) this.rpmEl.textContent = Math.round(rpm).toString();

    const maxRpm = physics.maxRpm;
    const rpmRatio = Math.min(1.0, Math.max(0, (rpm - 1000) / (maxRpm - 1000)));

    if (this.tachBar) {
      this.tachBar.style.width = `${rpmRatio * 100}%`;
      if (rpmRatio > 0.85) {
        this.tachBar.style.backgroundColor = '#ef4444'; // Redline
      } else if (rpmRatio > 0.65) {
        this.tachBar.style.backgroundColor = '#eab308'; // Warning yellow
      } else {
        this.tachBar.style.backgroundColor = '#22c55e'; // Green
      }
    }

    // Shift Light LED row (5 LEDs)
    if (this.shiftLights && this.shiftLights.length > 0) {
      const activeThresholds = [0.4, 0.55, 0.7, 0.82, 0.92];
      this.shiftLights.forEach((light, i) => {
        if (rpmRatio >= activeThresholds[i]) {
          light.classList.add('active');
          if (i === 4 && rpmRatio >= 0.94) {
            light.classList.add('flash');
          } else {
            light.classList.remove('flash');
          }
        } else {
          light.classList.remove('active', 'flash');
        }
      });
    }

    // 3. Lap Timing & Sector
    if (this.lapCurrentEl) this.lapCurrentEl.textContent = formatTime(physics.currentLapTime);
    if (this.lapBestEl) this.lapBestEl.textContent = formatTime(physics.bestLapTime);
    if (this.lapNumberEl) this.lapNumberEl.textContent = `LAP ${physics.currentLap}`;
    if (this.sectorEl) this.sectorEl.textContent = `SECTOR ${physics.currentSector}`;

    // 4. Minimap Rendering
    if (this.minimapCtx && trackSpline) {
      this.renderMinimap(physics, trackSpline);
    }
  }

  renderMinimap(physics, trackSpline) {
    const ctx = this.minimapCtx;
    const width = this.minimapCanvas.width;
    const height = this.minimapCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Get 100 points on spline to draw track outline
    const numPts = 100;
    const points = trackSpline.getSpacedPoints(numPts);

    // Compute bounds to fit map nicely in canvas
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    points.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    });

    const margin = 20;
    const mapW = maxX - minX || 1;
    const mapH = maxZ - minZ || 1;
    const scale = Math.min((width - margin * 2) / mapW, (height - margin * 2) / mapH);

    const worldToMap = (x, z) => {
      const mx = margin + (x - minX) * scale;
      const my = margin + (z - minZ) * scale;
      return { x: mx, y: my };
    };

    // Draw Track Path
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    points.forEach((p, idx) => {
      const m = worldToMap(p.x, p.z);
      if (idx === 0) ctx.moveTo(m.x, m.y);
      else ctx.lineTo(m.x, m.y);
    });
    ctx.closePath();
    ctx.stroke();

    // Draw Inner Track Highlight
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.stroke();

    // Draw Start / Finish Line
    const startM = worldToMap(points[0].x, points[0].z);
    ctx.beginPath();
    ctx.fillStyle = '#ef4444';
    ctx.arc(startM.x, startM.y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Draw Player Car Icon & Direction Cone
    const carM = worldToMap(physics.position.x, physics.position.z);

    ctx.save();
    ctx.translate(carM.x, carM.y);
    ctx.rotate(-physics.heading);

    // Car Direction Triangle
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
