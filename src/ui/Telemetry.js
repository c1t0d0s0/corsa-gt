/**
 * Live Telemetry & Dynamics Analytics Overlay.
 * Visualizes G-Force matrix, pedal loads, steering angle, and tire slip.
 */
export class TelemetryUI {
  constructor() {
    this.panel = document.getElementById('telemetry-panel');
    this.gCanvas = document.getElementById('telemetry-gforce-canvas');
    this.gCtx = this.gCanvas ? this.gCanvas.getContext('2d') : null;

    this.throttleBar = document.getElementById('telemetry-throttle');
    this.brakeBar = document.getElementById('telemetry-brake');
    this.steerBar = document.getElementById('telemetry-steer');

    this.tires = {
      fl: document.getElementById('tire-fl'),
      fr: document.getElementById('tire-fr'),
      rl: document.getElementById('tire-rl'),
      rr: document.getElementById('tire-rr')
    };

    this.visible = false;
  }

  toggle() {
    this.visible = !this.visible;
    if (this.panel) {
      this.panel.classList.toggle('hidden', !this.visible);
    }
  }

  update(physics, input) {
    if (!this.visible) return;

    // 1. Pedal Bars
    if (this.throttleBar) this.throttleBar.style.height = `${input.throttle * 100}%`;
    if (this.brakeBar) this.brakeBar.style.height = `${input.brake * 100}%`;
    if (this.steerBar) {
      const steerPct = (physics.steerAngle + 1) / 2 * 100; // 0% (full left) to 100% (full right)
      this.steerBar.style.left = `${steerPct}%`;
    }

    // 2. G-Force Matrix Rendering
    if (this.gCtx) {
      this.renderGForceMatrix(physics.gForceLateral, physics.gForceLongitudinal);
    }

    // 3. Tire Slip Heat Colors
    const slip = physics.slipAmount;
    let color = '#22c55e'; // Green
    if (slip > 0.8) color = '#ef4444'; // Red (Heavy drift)
    else if (slip > 0.3) color = '#f97316'; // Orange (Minor slip)

    Object.values(this.tires).forEach(tireEl => {
      if (tireEl) tireEl.style.backgroundColor = color;
    });
  }

  renderGForceMatrix(latG, longG) {
    const ctx = this.gCtx;
    const w = this.gCanvas.width;
    const h = this.gCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxG = 2.0;

    ctx.clearRect(0, 0, w, h);

    // Target Concentric Circles (0.5G, 1.0G, 1.5G, 2.0G)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach(rRatio => {
      ctx.beginPath();
      ctx.arc(cx, cy, (w / 2 - 8) * rRatio, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Crosshair Lines
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.stroke();

    // G-Force Ball Marker
    const px = cx + (latG / maxG) * (w / 2 - 8);
    const py = cy - (longG / maxG) * (h / 2 - 8);

    ctx.beginPath();
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#0284c7';
    ctx.shadowBlur = 10;
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}
