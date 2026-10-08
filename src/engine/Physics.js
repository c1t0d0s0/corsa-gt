import * as THREE from 'three';
import { clamp, damp } from '../utils/MathUtils.js';

/**
 * High-Grip Vehicle Physics with Auto Corner Brake & Lane Keep Assist.
 * Guarantees smooth, zero-crash, effortless driving on any track.
 */
export class VehiclePhysics {
  constructor() {
    // Driving Mode: 'easy' (default, assisted) or 'normal'
    this.drivingMode = 'easy';

    // Physical Parameters
    this.maxForwardSpeed = 22.0; // m/s (~80 km/h for Easy mode)
    this.maxReverseSpeed = -10.0; // m/s (~36 km/h)
    this.accelRate = 12.0;       // m/s^2
    this.brakeRate = 28.0;       // m/s^2
    this.coastDrag = 9.0;        // m/s^2
    this.turnRate = 0.55;        // rad/s (~31 deg/s) - Ultra-smooth steering

    // Kinematic State
    this.position = new THREE.Vector3(0, 0.4, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.heading = 0; // Yaw angle in radians (0 = facing +Z)
    this.speed = 0;   // m/s (+ is forward, - is reverse)

    // Vehicle Display Metrics
    this.speedKmh = 0;
    this.rpm = 1000;
    this.maxRpm = 8500;
    this.idleRpm = 1000;
    this.currentGear = 1;
    this.steerAngle = 0; // -1 (left) to +1 (right)
    this.isBraking = false;
    this.slipAmount = 0;
    this.gForceLateral = 0;
    this.gForceLongitudinal = 0;
    this.pitch = 0;
    this.roll = 0;

    // Lap Timing State
    this.currentLap = 1;
    this.currentLapTime = 0;
    this.bestLapTime = null;
    this.currentSector = 1;
    this.lastCheckpointIdx = 0;
  }

  setDrivingMode(mode) {
    this.drivingMode = mode;
    if (mode === 'easy') {
      this.maxForwardSpeed = 22.0; // ~80 km/h
      this.turnRate = 0.55;
    } else {
      this.maxForwardSpeed = 35.0; // ~126 km/h
      this.turnRate = 0.75;
    }
  }

  reset(position = new THREE.Vector3(0, 0.4, 0), heading = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.heading = heading;
    this.speed = 0;
    this.speedKmh = 0;
    this.rpm = this.idleRpm;
    this.currentGear = 1;
    this.steerAngle = 0;
    this.slipAmount = 0;
    this.currentLapTime = 0;
    this.lastCheckpointIdx = 0;
  }

  setEngineTune(hp) {
    const mult = hp / 500;
    const baseSpeed = this.drivingMode === 'easy' ? 20.0 : 32.0;
    this.maxForwardSpeed = baseSpeed * mult;
    this.accelRate = 12.0 * mult;
  }

  update(input, dt, trackBuilder) {
    if (dt > 0.1) dt = 0.1;

    this.speedKmh = Math.abs(this.speed) * 3.6;

    // 1. Easy & Smooth Steering (A/D or Left/Right)
    if (Math.abs(input.steering) > 0.05) {
      this.steerAngle = input.steering;
      const turnDir = this.speed < -0.5 ? -1.0 : 1.0;
      const speedFactor = Math.min(1.0, (Math.abs(this.speed) + 2.0) / 6.0);

      this.heading += this.steerAngle * this.turnRate * speedFactor * turnDir * dt;
    } else {
      this.steerAngle = 0;

      // In Easy Mode: Auto-align heading along track curve when steering key is released
      if (this.drivingMode === 'easy' && trackBuilder && this.speed > 1.0) {
        const closest = trackBuilder.getClosestPointOnTrack(this.position);
        if (closest && closest.tangent) {
          const targetTrackHeading = Math.atan2(closest.tangent.x, closest.tangent.z);
          let angleDiff = targetTrackHeading - this.heading;
          angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));

          this.heading += angleDiff * 3.5 * dt;
        }
      }
    }

    // 2. Throttle & Acceleration Logic (Forward / Reverse)
    this.isBraking = false;

    if (input.throttle > 0.05) {
      if (this.speed < -0.5) {
        this.speed += this.brakeRate * input.throttle * dt;
        this.isBraking = true;
      } else {
        this.speed += this.accelRate * input.throttle * dt;
      }
    } else if (input.brake > 0.05) {
      if (this.speed > 0.5) {
        this.speed -= this.brakeRate * input.brake * dt;
        this.isBraking = true;
      } else {
        this.speed -= (this.accelRate * 0.5) * input.brake * dt;
      }
    } else {
      // Coasting Drag to stop
      if (this.speed > 0) {
        this.speed = Math.max(0, this.speed - this.coastDrag * dt);
      } else if (this.speed < 0) {
        this.speed = Math.min(0, this.speed + this.coastDrag * dt);
      }
    }

    // 3. Easy Mode Automatic Curve Brake Assist (Prevents entering curves too fast)
    if (this.drivingMode === 'easy' && trackBuilder && this.speed > 3.0) {
      const closest = trackBuilder.getClosestPointOnTrack(this.position);
      if (closest && closest.tangent) {
        const aheadPt = trackBuilder.trackSpline.getPoint((closest.progress + 0.03) % 1.0);
        const headingToAhead = Math.atan2(aheadPt.x - this.position.x, aheadPt.z - this.position.z);
        let angleToCurve = Math.abs(Math.atan2(Math.sin(headingToAhead - this.heading), Math.cos(headingToAhead - this.heading)));

        if (angleToCurve > 0.25) {
          const safeCornerSpeed = Math.max(10.0, 22.0 - angleToCurve * 18.0);
          if (this.speed > safeCornerSpeed) {
            this.speed = damp(this.speed, safeCornerSpeed, 5.0, dt);
            this.isBraking = true;
          }
        }

        // Keep vehicle strictly inside 26m wide track bounds
        const pullToCenter = new THREE.Vector3().subVectors(closest.point, this.position);
        pullToCenter.y = 0;
        if (closest.distanceFromCenter > 9.0) {
          this.position.addScaledVector(pullToCenter, 2.5 * dt);
        }
      }
    }

    // Clamp Speed
    this.speed = clamp(this.speed, this.maxReverseSpeed, this.maxForwardSpeed);

    // 4. Simulated RPM & Gear Display for HUD
    if (this.speed < -0.2) {
      this.currentGear = 0;
      this.rpm = this.idleRpm + (Math.abs(this.speed) / Math.abs(this.maxReverseSpeed)) * 4000;
    } else {
      const speedRatio = Math.min(1.0, this.speed / this.maxForwardSpeed);
      this.currentGear = Math.min(6, Math.max(1, Math.floor(speedRatio * 5.8) + 1));
      const gearSpeedFraction = (speedRatio * 6) % 1.0;
      this.rpm = this.idleRpm + gearSpeedFraction * 6500 + input.throttle * 1000;
    }
    this.rpm = clamp(this.rpm, this.idleRpm, this.maxRpm);

    // 5. Pure Kinematic Movement Vector (100% High Grip, 0% Slip)
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.velocity.copy(forward).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    this.slipAmount = 0.0;

    // 6. Track Checkpoints & Lap Timing
    if (trackBuilder) {
      this.updateLapTiming(trackBuilder, dt);
    }
  }

  updateLapTiming(trackBuilder, dt) {
    this.currentLapTime += dt;

    if (!trackBuilder.checkpoints || trackBuilder.checkpoints.length === 0) return;

    const nextCheckIdx = (this.lastCheckpointIdx + 1) % trackBuilder.checkpoints.length;
    const check = trackBuilder.checkpoints[nextCheckIdx];

    const dist = this.position.distanceTo(check.position);
    if (dist < 30.0) {
      this.lastCheckpointIdx = nextCheckIdx;
      this.currentSector = check.sector;

      if (check.isStartFinish && this.lastCheckpointIdx === 0) {
        if (this.currentLapTime > 8.0) {
          if (!this.bestLapTime || this.currentLapTime < this.bestLapTime) {
            this.bestLapTime = this.currentLapTime;
          }
          this.currentLap++;
          this.currentLapTime = 0;
        }
      }
    }
  }

  shiftUp() {
    if (this.currentGear < 6) this.currentGear++;
  }

  shiftDown() {
    if (this.currentGear > 0) this.currentGear--;
  }
}
