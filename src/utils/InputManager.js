/**
 * Multi-device input manager supporting Keyboard, Touch UI, and Gamepad.
 * Digital inputs are ramped so a tapped key behaves like a quick, smooth
 * movement of the wheel or pedal rather than a step.
 */
const KEY_BINDINGS = {
  KeyW: 'throttle', ArrowUp: 'throttle', KeyX: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake', KeyZ: 'brake',
  KeyA: 'steerLeft', ArrowLeft: 'steerLeft',
  KeyD: 'steerRight', ArrowRight: 'steerRight',
  Space: 'handbrake'
};

const ACTION_BINDINGS = {
  KeyC: 'onCameraPress',
  KeyR: 'onResetPress',
  KeyG: 'onGarageToggle',
  KeyT: 'onTelemetryToggle',
  KeyE: 'onGearUp',
  KeyQ: 'onGearDown',
  KeyM: 'onTransmissionToggle',
  KeyP: 'onPause',
  Escape: 'onPause'
};

// Standard-mapping gamepad buttons → actions (fired on press)
const PAD_ACTIONS = { 1: 'onGearUp', 2: 'onGearDown', 3: 'onCameraPress', 8: 'onResetPress', 9: 'onPause' };

const approach = (value, target, rate, dt) => {
  const step = rate * dt;
  return Math.abs(target - value) <= step ? target : value + Math.sign(target - value) * step;
};

export class InputManager {
  constructor() {
    this.keys = { throttle: false, brake: false, steerLeft: false, steerRight: false, handbrake: false };

    // Continuous normalized values (-1 to 1 for steer, 0 to 1 for pedals)
    this.steering = 0; // -1 (left) to +1 (right)
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;

    this.touchSteer = 0;
    this.touchThrottle = 0;
    this.touchBrake = 0;

    this.onCameraPress = null;
    this.onResetPress = null;
    this.onGarageToggle = null;
    this.onTelemetryToggle = null;
    this.onTransmissionToggle = null;
    this.onGearUp = null;
    this.onGearDown = null;
    this.onPause = null;

    this.padButtons = [];
    this.setupKeyboard();
  }

  setupKeyboard() {
    const handleKey = (e, isDown) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const held = KEY_BINDINGS[e.code];
      if (held) {
        e.preventDefault();
        this.keys[held] = isDown;
        return;
      }
      const action = ACTION_BINDINGS[e.code];
      if (action && isDown && !e.repeat && this[action]) {
        e.preventDefault();
        this[action]();
      }
    };

    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));
    // Losing focus mid-press would otherwise leave the key stuck down
    window.addEventListener('blur', () => this.releaseAll());
  }

  releaseAll() {
    Object.keys(this.keys).forEach((k) => { this.keys[k] = false; });
    this.touchSteer = this.touchThrottle = this.touchBrake = 0;
  }

  update(dt = 1 / 60) {
    let steerTarget = (this.keys.steerRight ? 1 : 0) - (this.keys.steerLeft ? 1 : 0);
    if (this.touchSteer !== 0) steerTarget = this.touchSteer;
    let throttleTarget = Math.max(this.keys.throttle ? 1 : 0, this.touchThrottle);
    let brakeTarget = Math.max(this.keys.brake ? 1 : 0, this.touchBrake);
    let handbrake = this.keys.handbrake ? 1 : 0;
    let analog = false;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && Array.from(pads).find((p) => p && p.connected);
    if (gp) {
      const x = gp.axes[0] || 0;
      if (Math.abs(x) > 0.08) {
        // Dead zone, then a curve for finer control around centre
        const mag = (Math.abs(x) - 0.08) / 0.92;
        steerTarget = Math.sign(x) * Math.pow(mag, 1.6);
        analog = true;
      }
      const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
      const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      if (rt > 0.04) throttleTarget = Math.max(throttleTarget, rt);
      if (lt > 0.04) brakeTarget = Math.max(brakeTarget, lt);
      if (gp.buttons[0] && gp.buttons[0].pressed) handbrake = 1;

      for (const [index, action] of Object.entries(PAD_ACTIONS)) {
        const pressed = !!(gp.buttons[index] && gp.buttons[index].pressed);
        if (pressed && !this.padButtons[index] && this[action]) this[action]();
        this.padButtons[index] = pressed;
      }
    }

    if (analog) {
      this.steering = steerTarget;
    } else {
      // Turn in at a steady rate, unwind faster, and snap through centre when reversing lock
      const reversing = steerTarget !== 0 && Math.sign(steerTarget) !== Math.sign(this.steering) && this.steering !== 0;
      const rate = steerTarget === 0 ? 5.5 : reversing ? 9 : 3.2;
      this.steering = approach(this.steering, steerTarget, rate, dt);
    }
    this.throttle = approach(this.throttle, throttleTarget, throttleTarget > this.throttle ? 6 : 10, dt);
    this.brake = approach(this.brake, brakeTarget, brakeTarget > this.brake ? 7 : 12, dt);
    this.handbrake = handbrake;
  }
}
