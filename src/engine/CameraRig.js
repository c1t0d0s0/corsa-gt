import * as THREE from 'three';
import { clamp, damp } from '../utils/MathUtils.js';

const MODES = ['chase', 'hood', 'cockpit', 'orbit'];
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Camera behaviours: smoothed chase cam, hood and cockpit views locked to the
 * car body, and a draggable orbit view for the garage.
 */
export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.mode = 'chase';
    this.baseFov = 58;

    this.yaw = 0;
    this.distance = 6.4;
    this.shake = 0;
    this.time = 0;
    this.needsSnap = true;
    this.viewShift = '';
    this.panelOpen = false; // a side panel covers part of the view (garage)

    this.orbitAngle = 0.6;
    this.orbitHeight = 1.7;
    this.orbitDistance = 7.2;
    this.dragging = false;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();

    this.setupOrbitControls(domElement);
  }

  setupOrbitControls(el) {
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'orbit') return;
      this.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.orbitAngle -= (e.clientX - lastX) * 0.008;
      this.orbitHeight = clamp(this.orbitHeight + (e.clientY - lastY) * 0.015, 0.4, 5);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'orbit') return;
      this.orbitDistance = clamp(this.orbitDistance + e.deltaY * 0.005, 4.5, 14);
    }, { passive: true });
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return this.mode;
    this.mode = mode;
    this.needsSnap = true;
    return mode;
  }

  cycleMode() {
    return this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  snap() {
    this.needsSnap = true;
  }

  /**
   * @param carGroup  the car's scene node (already posed for this frame)
   * @param physics   vehicle state, for speed-dependent behaviour
   */
  update(carGroup, physics, dt) {
    const cam = this.camera;
    this.time += dt;
    carGroup.updateMatrixWorld(true);

    const heading = physics.renderHeading;
    const speed = Math.hypot(physics.vx, physics.vy);
    const pos = carGroup.position;

    let fov = this.baseFov;

    if (this.mode === 'chase') {
      // Look partly where the car is going, not just where it points, so slides stay readable
      const drift = speed > 4 && physics.vx > 0 ? clamp(Math.atan2(physics.vy, physics.vx), -0.5, 0.5) : 0;
      const targetYaw = heading + drift * 0.45;
      const targetDist = 6.2 + clamp(speed / 70, 0, 1) * 1.3 + clamp(physics.gForceLongitudinal, -1.2, 1.2) * 0.45;
      if (this.needsSnap) {
        this.yaw = targetYaw;
        this.distance = targetDist;
      } else {
        this.yaw += wrapAngle(targetYaw - this.yaw) * (1 - Math.exp(-7 * dt));
        this.distance = damp(this.distance, targetDist, 4, dt);
      }
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      this._pos.set(pos.x - sy * this.distance, pos.y + 2.55, pos.z - cy * this.distance);
      this._look.set(pos.x + Math.sin(heading) * 6, pos.y + 0.35, pos.z + Math.cos(heading) * 6);

      // Fine vibration at speed, a kick on wall contact
      this.shake = Math.max(this.shake * Math.exp(-6 * dt), clamp(physics.wallHit * 0.05, 0, 0.5));
      const buzz = clamp((speed - 35) / 50, 0, 1) * 0.012 + this.shake * 0.25;
      this._pos.x += Math.sin(this.time * 47) * buzz;
      this._pos.y += Math.sin(this.time * 61 + 1.3) * buzz;

      cam.position.copy(this._pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._look);
      fov += clamp(speed / 80, 0, 1) * 15;
    } else if (this.mode === 'hood' || this.mode === 'cockpit') {
      // Car space: +Z forward, +X left, driver sits on the right
      if (this.mode === 'hood') {
        this._pos.set(0, 1.02, 0.95);
        this._look.set(0, 0.9, 12);
      } else {
        this._pos.set(-0.36, 1.08, -0.12);
        this._look.set(-0.36, 0.98, 12);
      }
      cam.position.copy(this._pos).applyMatrix4(carGroup.matrixWorld);
      this._look.applyMatrix4(carGroup.matrixWorld);
      cam.up.set(0, 1, 0).transformDirection(carGroup.matrixWorld);
      cam.lookAt(this._look);
      fov += 8 + clamp(speed / 80, 0, 1) * 8;
    } else {
      if (!this.dragging) this.orbitAngle += 0.25 * dt;
      cam.position.set(
        pos.x + Math.sin(this.orbitAngle) * this.orbitDistance,
        pos.y + this.orbitHeight,
        pos.z + Math.cos(this.orbitAngle) * this.orbitDistance
      );
      cam.up.set(0, 1, 0);
      this._look.set(pos.x, pos.y + 0.65, pos.z);
      cam.lookAt(this._look);
      fov = 42;
    }

    // Slide the picture so the car clears the gauge cluster (chase) or the garage panel (orbit)
    const w = window.innerWidth;
    const h = window.innerHeight;
    let shiftX = 0;
    let shiftY = this.mode === 'chase' ? Math.round(h * 0.11) : 0;
    if (this.mode === 'orbit' && this.panelOpen) {
      // The panel docks to the right on desktops and landscape phones, to the bottom otherwise
      if (w > 900 || h <= 520) shiftX = Math.round(w * 0.16);
      else shiftY = Math.round(h * 0.22);
    }
    const key = `${w}x${h}:${shiftX}:${shiftY}`;
    if (key !== this.viewShift) {
      this.viewShift = key;
      if (shiftX || shiftY) cam.setViewOffset(w, h, shiftX, shiftY, w, h);
      else cam.clearViewOffset();
    }

    const newFov = this.needsSnap ? fov : damp(cam.fov, fov, 5, dt);
    if (Math.abs(newFov - cam.fov) > 0.01) {
      cam.fov = newFov;
      cam.updateProjectionMatrix();
    }
    this.needsSnap = false;
  }
}
