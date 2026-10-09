import * as THREE from 'three';
import { clamp, damp, lerp } from '../utils/MathUtils.js';

const G = 9.81;
const FIXED_DT = 1 / 120;
const SUBSTEPS = 2;

// Index 0 is reverse so the HUD's "gear 0 = R" convention holds
const GEAR_RATIOS = [-3.4, 3.3, 2.2, 1.62, 1.26, 1.03, 0.86];
const FINAL_DRIVE = 3.7;
const DRIVETRAIN_EFF = 0.9;
const WHEEL_RADIUS = 0.33;

const TORQUE_CURVE = [
  [1000, 0.62], [2500, 0.82], [4500, 1.0], [6200, 0.98], [7400, 0.86], [8200, 0.7]
];

const SURFACES = {
  asphalt: { grip: 1.0, drag: 0.0 },
  kerb: { grip: 0.93, drag: 0.15 },
  grass: { grip: 0.58, drag: 1.6 },
  sand: { grip: 0.52, drag: 3.2 }
};

const MAX_STEER = 0.56; // rad at the front wheels, parking speed

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function torqueShape(rpm) {
  if (rpm <= TORQUE_CURVE[0][0]) return TORQUE_CURVE[0][1];
  for (let i = 1; i < TORQUE_CURVE.length; i++) {
    const [r1, t1] = TORQUE_CURVE[i];
    if (rpm <= r1) {
      const [r0, t0] = TORQUE_CURVE[i - 1];
      return t0 + (t1 - t0) * ((rpm - r0) / (r1 - r0));
    }
  }
  return TORQUE_CURVE[TORQUE_CURVE.length - 1][1];
}

/**
 * Sim-cade vehicle dynamics: a dynamic bicycle model (tyres really do slip)
 * with driver aids layered on top. Runs at a fixed 120Hz.
 *
 * Conventions: forward = (sin h, 0, cos h), body +y is the car's left,
 * positive yaw rate / steer angle turns left.
 */
export class VehiclePhysics {
  constructor() {
    this.drivingMode = 'easy'; // 'easy' (full assists) or 'normal'
    this.transmission = 'auto'; // 'auto' or 'manual'
    this.autopilot = false;
    this.engineHp = 650;
    this.weatherGrip = 1.0;
    this.track = null;

    // Chassis
    this.mass = 1300;
    this.inertia = 1900;
    this.cgToFront = 1.25;
    this.cgToRear = 1.35;
    this.cgHeight = 0.48;
    this.wheelRadius = WHEEL_RADIUS;
    this.tyreMu = 1.3;
    this.dragArea = 0.9;
    this.liftArea = 1.5;
    this.brakeG = 1.25;

    // Dynamic state
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.vx = 0;
    this.vy = 0;
    this.yawRate = 0;

    // Interpolated pose for rendering
    this.renderPosition = new THREE.Vector3();
    this.renderHeading = 0;
    this.prevPosition = new THREE.Vector3();
    this.prevHeading = 0;
    this.accumulator = 0;

    // Readouts
    this.speed = 0;
    this.speedKmh = 0;
    this.rpm = 1000;
    this.maxRpm = 8200;
    this.idleRpm = 1000;
    this.currentGear = 1;
    this.steerRad = 0;
    this.steerAngle = 0; // -1 (left) .. +1 (right), for UI
    this.throttle = 0;
    this.brake = 0;
    this.isBraking = false;
    this.isReversing = false;
    this.slipAmount = 0;
    this.slipFront = 0;
    this.slipRear = 0;
    this.wheelSpin = 0;
    this.gForceLateral = 0;
    this.gForceLongitudinal = 0;
    this.pitch = 0;
    this.roll = 0;
    this.gradePitch = 0;
    this.surface = 'asphalt';
    this.wallHit = 0;
    this.shiftEvent = 0;
    this.wheelOmegaFront = 0;
    this.wheelOmegaRear = 0;

    this.pitchVel = 0;
    this.rollVel = 0;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.axFilt = 0;
    this.shiftTimer = 0;
    this.laneAssist = 0;
    this.steerSmoothed = 0;

    // Lap timing
    this.currentLap = 1;
    this.currentLapTime = 0;
    this.lastLapTime = null;
    this.bestLapTime = null;
    this.currentSector = 1;
    this.lapDistance = 0;
    this.lapStarted = false;

    this.q = { index: -1, s: 0, offset: 0, y: 0, heading: 0, tx: 0, tz: 1, slope: 0, curv: 0, kerb: 0 };
    this._target = new THREE.Vector3();

    this.applyTune();
  }

  // --- Configuration ---------------------------------------------------

  setTrack(trackPath) {
    this.track = trackPath;
    this.bestLapTime = null;
    this.lastLapTime = null;
    this.currentLap = 1;
    this.reset();
  }

  setWeather(weather) {
    this.weatherGrip = weather === 'rainy' ? 0.78 : 1.0;
  }

  setDrivingMode(mode) {
    this.drivingMode = mode;
    this.applyTune();
  }

  setEngineTune(hp) {
    this.engineHp = hp;
    this.applyTune();
  }

  toggleTransmission() {
    this.transmission = this.transmission === 'auto' ? 'manual' : 'auto';
    return this.transmission;
  }

  /** Single place where mode and tune combine into engine output. */
  applyTune() {
    const powerScale = this.drivingMode === 'easy' ? 0.8 : 1.0;
    const watts = this.engineHp * 745.7 * powerScale;
    this.peakTorque = watts / ((7200 * 2 * Math.PI) / 60 * 0.87);
  }

  /** Drag/gearing limited top speed in km/h, for the garage stat bars. */
  estimateTopSpeedKmh() {
    const gearLimit = ((this.maxRpm * 2 * Math.PI) / 60 / (GEAR_RATIOS[6] * FINAL_DRIVE)) * WHEEL_RADIUS;
    const watts = this.engineHp * 745.7 * DRIVETRAIN_EFF;
    const dragLimit = Math.cbrt(watts / (0.5 * 1.2 * this.dragArea));
    return Math.min(gearLimit, dragLimit) * 3.6;
  }

  // --- Placement -------------------------------------------------------

  placeOnTrack(s) {
    const t = this.track;
    this.vx = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.velocity.set(0, 0, 0);
    this.currentGear = 1;
    this.shiftTimer = 0;
    this.rpm = this.idleRpm;
    this.bodyPitch = this.bodyRoll = this.pitchVel = this.rollVel = 0;
    this.axFilt = 0;
    this.steerRad = 0;
    this.slipAmount = 0;
    this.wallHit = 0;
    this.accumulator = 0;
    if (t) {
      t.pointAt(s, 0, this.position);
      this.heading = t.headingAt(s);
      t.query(this.position.x, this.position.z, -1, this.q);
      this.position.y = this.q.y;
    } else {
      this.position.set(0, 0, 0);
      this.heading = 0;
    }
    this.prevPosition.copy(this.position);
    this.prevHeading = this.heading;
    this.renderPosition.copy(this.position);
    this.renderHeading = this.heading;
    this.updateReadouts(0, 0);
  }

  /** Back to the grid, a few metres before the start/finish line. */
  reset() {
    this.placeOnTrack(this.track ? this.track.length - 14 : 0);
    this.currentLapTime = 0;
    this.lapDistance = 0;
    this.lapStarted = false;
    this.currentSector = 1;
  }

  /** Put the car back on the centreline where it currently is. */
  recover() {
    this.placeOnTrack(this.q.s);
  }

  // --- Driver aids -----------------------------------------------------

  /** Highest speed from which every corner ahead can still be made. */
  safeSpeedAhead(mu, latFactor, brakeFactor) {
    const t = this.track;
    const aLat = mu * G * latFactor;
    const aBrk = mu * G * brakeFactor;
    const look = Math.min(700, (this.vx * this.vx) / (2 * aBrk) + 25); // far enough to stop from top speed
    const steps = Math.ceil(look / (t.ds * 3));
    let v2min = Infinity;
    for (let k = 0; k <= steps; k++) {
      const i = (this.q.index + k * 3) % t.n;
      const kappa = Math.max(Math.abs(t.curv[i]), 1e-4);
      const v2 = aLat / kappa + 2 * aBrk * k * 3 * t.ds;
      if (v2 < v2min) v2min = v2;
    }
    return Math.sqrt(v2min);
  }

  /** Pure-pursuit steer angle towards the centreline ahead. */
  lineSteer() {
    const t = this.track;
    // Look further ahead the faster we go, or the correction turns twitchy at top speed
    const ld = clamp(5 + 0.42 * this.vx + 0.002 * this.vx * this.vx, 6, 60);
    const p = t.pointAt(this.q.s + ld, 0, this._target);
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    const fwd = dx * sh + dz * ch;
    const left = dx * ch - dz * sh;
    const dist = Math.hypot(fwd, left) || 1;
    const wheelbase = this.cgToFront + this.cgToRear;
    const pursuit = Math.atan((2 * wheelbase * (left / dist)) / dist);
    // Tyres need slip angle to corner, more of it the faster the car goes; without this
    // extra lock the car drifts wide through long fast corners before the error builds up
    return pursuit + wheelbase * this.q.curv * 0.0009 * this.vx * this.vx;
  }

  // --- Simulation ------------------------------------------------------

  /** Advance by a variable frame time using fixed sub-steps, then interpolate. */
  update(input, frameDt) {
    this.accumulator += Math.min(frameDt, 0.1);
    while (this.accumulator >= FIXED_DT) {
      this.prevPosition.copy(this.position);
      this.prevHeading = this.heading;
      this.step(input, FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    const alpha = this.accumulator / FIXED_DT;
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    this.renderHeading = this.prevHeading + wrapAngle(this.heading - this.prevHeading) * alpha;
  }

  step(input, dt) {
    const t = this.track;
    if (!t) return;
    const q = this.q;
    const easy = this.drivingMode === 'easy';
    const a = this.cgToFront;
    const b = this.cgToRear;
    const L = a + b;
    const m = this.mass;

    // 1. Surface under the car
    const absOff = Math.abs(q.offset);
    let surfaceName = 'asphalt';
    if (absOff > t.halfWidth) {
      surfaceName = q.kerb && absOff < t.halfWidth + 1.3 ? 'kerb' : t.def.runoffSurface;
    }
    const surf = SURFACES[surfaceName] || SURFACES.asphalt;
    this.surface = surfaceName;
    const mu = this.tyreMu * surf.grip * this.weatherGrip;

    // 2. Driver inputs → drive / brake / steer commands
    let thr = input.throttle;
    let brk = input.brake;
    let steerIn = input.steering;
    const handbrake = this.autopilot ? 0 : input.handbrake;
    let lineDelta = 0;

    if (this.autopilot) {
      const vSafe = this.safeSpeedAhead(mu, 0.8, 0.7);
      lineDelta = this.lineSteer();
      thr = clamp((vSafe - this.vx) * 0.5, 0, 1);
      brk = clamp((this.vx - vSafe) * 0.4, 0, 1);
      steerIn = 0;
      if (this.currentGear === 0) this.currentGear = 1;
    }

    let drive = thr;
    let brake = brk;
    if (this.transmission === 'auto' || this.autopilot) {
      if (this.currentGear === 0) {
        if (thr > 0.05) {
          if (this.vx < -0.5) { drive = 0; brake = thr; } else { this.currentGear = 1; }
        } else {
          drive = this.vx > -11 ? brk : 0;
          brake = 0;
        }
      } else if (brk > 0.05 && thr < 0.05 && this.vx < 0.5) {
        this.currentGear = 0;
        drive = 0;
      }
    }

    // Easy mode: brake for the corner ahead before the driver has to think about it
    if (easy && !this.autopilot && this.currentGear > 0 && this.vx > 8) {
      const vSafe = this.safeSpeedAhead(mu, 0.62, 0.6);
      if (this.vx > vSafe - 3) drive *= clamp((vSafe - this.vx) / 3, 0, 1);
      if (this.vx > vSafe) brake = Math.max(brake, clamp((this.vx - vSafe) / 5, 0, 1));
    }

    // Steering: speed-sensitive lock so a held key never asks for more than the tyres have
    const vAbs = Math.abs(this.vx);
    const gripLock = Math.atan((L * 1.55 * mu * G) / Math.max(vAbs * vAbs, 1)) + 0.012;
    const lock = Math.min(MAX_STEER, gripLock);
    let delta = -steerIn * lock;

    if (this.autopilot) {
      delta = lineDelta;
    } else if (easy && this.vx > 2) {
      // Gentle lane keeping once the driver lets go of the wheel
      const want = Math.abs(steerIn) < 0.05 ? 1 : 0;
      this.laneAssist = damp(this.laneAssist, want, want ? 5 : 18, dt);
      if (this.laneAssist > 0.01) delta += this.lineSteer() * this.laneAssist;
    } else {
      this.laneAssist = 0;
    }

    // Counter-steer help when the rear steps out
    const rearSlipNow = this.vx > 3 ? Math.atan2(this.vy - b * this.yawRate, this.vx) : 0;
    const excess = Math.sign(rearSlipNow) * Math.max(0, Math.abs(rearSlipNow) - 0.07);
    delta += excess * (easy || this.autopilot ? 1.0 : 0.5);
    delta = clamp(delta, -MAX_STEER, MAX_STEER);
    this.steerRad = damp(this.steerRad, delta, 30, dt);
    delta = this.steerRad;

    // 3. Powertrain
    const gear = this.currentGear;
    const ratio = GEAR_RATIOS[gear] * FINAL_DRIVE;
    const wheelRpm = (vAbs / WHEEL_RADIUS) * Math.abs(ratio) * (60 / (2 * Math.PI));
    let engineRpm = Math.max(this.idleRpm, wheelRpm);
    if (gear <= 1) engineRpm = Math.max(engineRpm, this.idleRpm + drive * 2800); // clutch slip off the line
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    let driveForce = 0;
    const cut = this.shiftTimer > 0.13 || engineRpm > this.maxRpm - 60;
    if (!cut && drive > 0) {
      driveForce = (this.peakTorque * torqueShape(engineRpm) * drive * ratio * DRIVETRAIN_EFF) / WHEEL_RADIUS;
    }
    // Engine braking, fading out near standstill
    const engineBrake = (1 - drive) * (40 + 0.011 * engineRpm) * Math.abs(ratio) / WHEEL_RADIUS * smoothstep(1, 5, vAbs);

    // 4. Integrate dynamics
    const h = dt / SUBSTEPS;
    const sgn = this.vx >= 0 ? 1 : -1;
    const assisted = easy || this.autopilot;
    const tcsLimit = assisted ? 0.8 : 0.97;
    const tcsSlack = assisted ? 0.05 : 0.14;
    // Stability control works harder under braking, when the unloaded rear is easiest to upset
    const escGain = (assisted ? 3.2 : 1.3 + brake * 1.9) * (handbrake > 0.5 ? 0.15 : 1);
    let axBody = 0;
    let ayBody = 0;
    let slipF = 0;
    let slipR = 0;
    let spin = 0;

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      const vx = this.vx;
      const vy = this.vy;
      const r = this.yawRate;
      const sd = Math.sin(delta);
      const cd = Math.cos(delta);

      const down = 0.5 * 1.2 * this.liftArea * vx * vx;
      const transfer = (m * this.axFilt * this.cgHeight) / L;
      const fzF = Math.max(600, (m * G * b) / L - transfer + down * 0.42);
      const fzR = Math.max(600, (m * G * a) / L + transfer + down * 0.58);

      // Slip angle in each wheel's own frame, and how much of the tyre cornering already uses
      const vfy = vy + a * r;
      const vry = vy - b * r;
      const alphaF = Math.atan2(-vx * sd + vfy * cd, Math.max(Math.abs(vx * cd + vfy * sd), 1.5));
      const alphaR = Math.atan2(vry, Math.max(Math.abs(vx), 1.5));
      const curveF = Math.sin(1.4 * Math.atan(12 * alphaF));
      const curveR = Math.sin(1.4 * Math.atan(12 * alphaR));
      const frontCap = mu * fzF;
      const rearCap = mu * fzR;
      // Grip left over for driving/braking once cornering has taken its share (friction circle)
      const spareF = Math.sqrt(Math.max(0, 1 - curveF * curveF));
      const spareR = Math.sqrt(Math.max(0, 1 - curveR * curveR));

      // Brakes: ABS keeps each axle inside the circle so the car still steers. The rear is
      // deliberately under-braked (as load shifts forward) so it keeps its sideways grip.
      const brakeTotal = brake * this.brakeG * m * G;
      const fbF = Math.min(brakeTotal * 0.62, frontCap * 0.95 * Math.max(0.55, spareF));
      let fbR = Math.min(brakeTotal * 0.38, rearCap * 0.55 * Math.max(0.2, spareR));
      if (handbrake > 0.5) fbR = rearCap * 0.95;

      // Drive: traction control gives cornering priority; "normal" lets the rear be over-driven a little
      let fxR = driveForce - sgn * engineBrake;
      const driveLimit = rearCap * Math.min(tcsLimit, spareR * tcsLimit + tcsSlack);
      spin = tcsLimit < 0.9 ? 0 : Math.max(0, Math.abs(fxR) / rearCap - 1);
      // Engine braking (force against the selected gear's direction) gets a much smaller share
      const overrun = Math.min(driveLimit, rearCap * 0.25);
      fxR = gear === 0 ? clamp(fxR, -driveLimit, overrun) : clamp(fxR, -overrun, driveLimit);

      const usedF = fbF / frontCap;
      const usedR = Math.min(1, Math.hypot(fxR, fbR) / rearCap);
      const latF = Math.sqrt(Math.max(0.08, 1 - usedF * usedF));
      const latR = Math.sqrt(Math.max(0.08, 1 - usedR * usedR));
      const fyF = -frontCap * latF * curveF;
      const fyR = -rearCap * 1.06 * latR * curveR;
      slipF = alphaF;
      slipR = alphaR;

      const drag = 0.5 * 1.2 * this.dragArea * vx * Math.abs(vx);
      const gravity = m * G * q.slope * Math.cos(wrapAngle(this.heading - q.heading));
      const resist = fbF * cd + fbR + m * (0.12 + surf.drag);

      let fx = fxR - fyF * sd - drag - gravity;
      const fy = fyF * cd + fyR;
      let mz = a * fyF * cd - b * fyR;

      // Stability control. Mostly it calms over-rotation; it only helps the nose in a
      // little when the car is under-rotating, and it pushes back once the tail steps out.
      const blend = smoothstep(1.5, 6, Math.abs(vx));
      const rMax = (0.85 * mu * G) / Math.max(Math.abs(vx), 3);
      const rWant = clamp((vx * Math.tan(delta)) / (L * (1 + 0.0022 * vx * vx)), -rMax, rMax);
      const yawErr = rWant - r;
      const overRotating = Math.abs(r) > Math.abs(rWant) || r * rWant < 0;
      let assist = this.inertia * escGain * yawErr * (overRotating ? 1 : 0.3);
      const tailOut = Math.sign(alphaR) * Math.max(0, Math.abs(alphaR) - 0.1);
      assist += this.inertia * escGain * 2.2 * tailOut;
      mz += clamp(assist, -7000, 7000) * blend;

      // Brakes and rolling resistance can stop the car but never push it backwards
      let nvx;
      if (Math.abs(vx) < 0.25 && Math.abs(fx) <= resist) {
        nvx = 0;
      } else {
        fx -= (Math.abs(vx) < 0.25 ? Math.sign(fx) : sgn) * resist;
        nvx = vx + (fx / m + vy * r) * h;
        if (vx !== 0 && Math.sign(nvx) !== Math.sign(vx) && Math.abs(driveForce) < resist) nvx = 0;
      }
      let nvy = vy + (fy / m - vx * r) * h;
      let nr = r + (mz / this.inertia) * h;

      // Below walking pace the tyre model is ill-conditioned; fade to pure rolling
      const rKin = (nvx * Math.tan(delta)) / L;
      nr = lerp(rKin, nr, blend);
      nvy = lerp(b * rKin, nvy, blend);

      axBody = (nvx - vx) / h - vy * r;
      ayBody = (nvy - vy) / h + vx * r;
      this.vx = nvx;
      this.vy = nvy;
      this.yawRate = nr;
      this.heading += nr * h;

      const sh = Math.sin(this.heading);
      const ch = Math.cos(this.heading);
      this.position.x += (sh * nvx + ch * nvy) * h;
      this.position.z += (ch * nvx - sh * nvy) * h;
    }
    this.axFilt = damp(this.axFilt, clamp(axBody, -20, 20), 12, dt);

    // 5. Track query, walls, ride height
    const prevS = q.s;
    t.query(this.position.x, this.position.z, q.index, q);
    this.wallHit = Math.max(0, this.wallHit - dt * 20);
    const limit = t.wallOffset - 0.95;
    if (Math.abs(q.offset) > limit) {
      const side = Math.sign(q.offset);
      const nx = q.tz * side; // unit vector pointing into the wall
      const nz = -q.tx * side;
      const pen = Math.abs(q.offset) - limit;
      this.position.x -= nx * pen;
      this.position.z -= nz * pen;
      q.offset = side * limit;

      const sh = Math.sin(this.heading);
      const ch = Math.cos(this.heading);
      let wx = sh * this.vx + ch * this.vy;
      let wz = ch * this.vx - sh * this.vy;
      const vn = wx * nx + wz * nz;
      if (vn > 0) {
        wx -= nx * vn * 1.15;
        wz -= nz * vn * 1.15;
        const vt = wx * q.tx + wz * q.tz;
        const scrub = Math.min(Math.abs(vt), vn * 0.35) * Math.sign(vt);
        wx -= q.tx * scrub;
        wz -= q.tz * scrub;
        this.vx = wx * sh + wz * ch;
        this.vy = wx * ch - wz * sh;
        // Glance off the wall rather than sticking nose-first into it
        const along = this.vx >= 0 ? q.heading : q.heading + Math.PI;
        this.heading += wrapAngle(along - this.heading) * Math.min(0.5, vn * 0.04);
        this.yawRate *= 0.6;
        this.wallHit = Math.max(this.wallHit, vn);
      }
    }
    this.position.y = q.y;

    // 6. Gearbox
    if ((this.transmission === 'auto' || this.autopilot) && gear >= 1 && this.shiftTimer <= 0) {
      const load = Math.max(drive, brake * 0.8);
      if (wheelRpm > lerp(3200, 7500, drive) && gear < 6 && spin < 0.05) {
        this.changeGear(gear + 1);
      } else if (gear > 1) {
        const lowerRpm = (wheelRpm * GEAR_RATIOS[gear - 1]) / GEAR_RATIOS[gear];
        if (wheelRpm < lerp(1400, 3800, load) && lowerRpm < 7000) this.changeGear(gear - 1);
      }
    }

    // 7. Lap timing from distance travelled along the centreline
    let dS = q.s - prevS;
    if (dS > t.length / 2) dS -= t.length;
    if (dS < -t.length / 2) dS += t.length;
    this.lapDistance += dS;
    this.currentLapTime += dt;
    const crossedLine = prevS > t.length * 0.75 && q.s < t.length * 0.25;
    if (crossedLine) {
      if (this.lapStarted && this.lapDistance > t.length * 0.9) {
        this.lastLapTime = this.currentLapTime;
        if (this.bestLapTime === null || this.currentLapTime < this.bestLapTime) {
          this.bestLapTime = this.currentLapTime;
        }
        this.currentLap++;
      }
      this.lapStarted = true;
      this.currentLapTime = 0;
      this.lapDistance = q.s;
    }
    this.currentSector = Math.min(3, Math.floor((q.s / t.length) * 3) + 1);

    // 8. Readouts
    const targetRpm = clamp(spin > 0.05 ? engineRpm + spin * 1500 : engineRpm, this.idleRpm, this.maxRpm);
    this.rpm = damp(this.rpm, targetRpm, 18, dt);
    this.throttle = drive;
    this.brake = brake;
    this.isBraking = brake > 0.05 || handbrake > 0.5;
    this.isReversing = this.currentGear === 0;
    this.slipFront = slipF;
    this.slipRear = slipR;
    this.wheelSpin = spin;
    const moving = smoothstep(4, 10, Math.hypot(this.vx, this.vy));
    const lateralSlip = Math.max(0, Math.max(Math.abs(slipF), Math.abs(slipR)) - 0.12) / 0.14;
    this.slipAmount = clamp(Math.max(lateralSlip, spin * 2, handbrake > 0.5 ? 1 : 0) * moving, 0, 1.5);
    this.wheelOmegaFront = this.vx / WHEEL_RADIUS;
    this.wheelOmegaRear = handbrake > 0.5 ? 0 : (this.vx / WHEEL_RADIUS) * (1 + Math.min(spin, 1) * sgn);
    this.updateReadouts(axBody, ayBody, dt);
  }

  updateReadouts(axBody, ayBody, dt = 0) {
    this.speed = this.vx;
    this.speedKmh = Math.hypot(this.vx, this.vy) * 3.6;
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    this.velocity.set(sh * this.vx + ch * this.vy, 0, ch * this.vx - sh * this.vy);
    this.steerAngle = clamp(-this.steerRad / MAX_STEER, -1, 1);

    const longG = clamp(axBody / G, -3, 3);
    const latG = clamp(ayBody / G, -3, 3);
    if (dt > 0) {
      this.gForceLongitudinal = damp(this.gForceLongitudinal, longG, 10, dt);
      this.gForceLateral = damp(this.gForceLateral, -latG, 10, dt); // + = towards the right
      // Body attitude: a damped spring chasing the load transfer
      const pitchTarget = clamp(-longG * 0.028, -0.05, 0.05);
      const rollTarget = clamp(latG * 0.04, -0.07, 0.07);
      this.pitchVel += ((pitchTarget - this.bodyPitch) * 110 - this.pitchVel * 15) * dt;
      this.rollVel += ((rollTarget - this.bodyRoll) * 110 - this.rollVel * 15) * dt;
      this.bodyPitch += this.pitchVel * dt;
      this.bodyRoll += this.rollVel * dt;
    } else {
      this.gForceLongitudinal = 0;
      this.gForceLateral = 0;
    }
    const grade = Math.atan(this.q.slope * Math.cos(wrapAngle(this.heading - this.q.heading)));
    this.gradePitch = -grade; // rotation about the car's left axis; positive = nose down
    this.pitch = this.bodyPitch + this.gradePitch;
    this.roll = this.bodyRoll;
  }

  changeGear(gear) {
    if (gear === this.currentGear) return;
    this.shiftEvent = gear > this.currentGear ? 1 : -1;
    this.currentGear = gear;
    this.shiftTimer = 0.28;
  }

  shiftUp() {
    if (this.transmission !== 'manual') return false;
    if (this.currentGear === 0 && this.vx < -1) return false;
    if (this.currentGear >= 6) return false;
    this.changeGear(this.currentGear + 1);
    return true;
  }

  shiftDown() {
    if (this.transmission !== 'manual') return false;
    const gear = this.currentGear;
    if (gear === 0) return false;
    if (gear === 1) {
      if (this.vx > 1) return false;
      this.changeGear(0);
      return true;
    }
    // Refuse a downshift that would over-rev the engine
    const rpmAfter = (Math.abs(this.vx) / WHEEL_RADIUS) * GEAR_RATIOS[gear - 1] * FINAL_DRIVE * (60 / (2 * Math.PI));
    if (rpmAfter > this.maxRpm) return false;
    this.changeGear(gear - 1);
    return true;
  }
}
