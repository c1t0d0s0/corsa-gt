/**
 * Multi-device input manager supporting Keyboard, Touch UI, and Gamepad.
 */
export class InputManager {
  constructor() {
    this.keys = {
      throttle: false,
      brake: false,
      steerLeft: false,
      steerRight: false,
      handbrake: false,
      gearUp: false,
      gearDown: false,
      camera: false,
      reset: false,
      toggleGarage: false,
      toggleTelemetry: false
    };

    // Continuous normalized values (-1 to 1 for steer, 0 to 1 for pedals)
    this.steering = 0; // -1 (left) to +1 (right)
    this.throttle = 0; // 0 to 1
    this.brake = 0;    // 0 to 1
    this.handbrake = 0;// 0 to 1

    this.onCameraPress = null;
    this.onResetPress = null;
    this.onGarageToggle = null;
    this.onTelemetryToggle = null;
    this.onTransmissionToggle = null;

    this.setupKeyboard();
    this.setupGamepad();
  }

  setupKeyboard() {
    const handleKey = (e, isDown) => {
      const k = e.key ? e.key.toLowerCase() : '';
      const code = e.code || '';

      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
        e.preventDefault();
      }

      if (k === 'w' || k === 'x' || k === 'arrowup' || code === 'KeyW' || code === 'KeyX' || code === 'ArrowUp') {
        this.keys.throttle = isDown;
      }
      if (k === 's' || k === 'z' || k === 'arrowdown' || code === 'KeyS' || code === 'KeyZ' || code === 'ArrowDown') {
        this.keys.brake = isDown;
      }
      if (k === 'a' || k === 'arrowleft' || code === 'KeyA' || code === 'ArrowLeft') {
        this.keys.steerLeft = isDown;
      }
      if (k === 'd' || k === 'arrowright' || code === 'KeyD' || code === 'ArrowRight') {
        this.keys.steerRight = isDown;
      }
      if (k === ' ' || code === 'Space') {
        this.keys.handbrake = isDown;
      }

      if (isDown) {
        if (k === 'c' || code === 'KeyC') { if (this.onCameraPress) this.onCameraPress(); }
        if (k === 'r' || code === 'KeyR') { if (this.onResetPress) this.onResetPress(); }
        if (k === 'g' || code === 'KeyG') { if (this.onGarageToggle) this.onGarageToggle(); }
        if (k === 't' || code === 'KeyT') { if (this.onTelemetryToggle) this.onTelemetryToggle(); }
      }
    };

    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));
  }

  setupGamepad() {
    window.addEventListener("gamepadconnected", (e) => {
      console.log("Gamepad connected:", e.gamepad.id);
    });
  }

  update() {
    // Keyboard steer calculation with smooth centering
    let targetSteer = 0;
    if (this.keys.steerLeft) targetSteer -= 1;
    if (this.keys.steerRight) targetSteer += 1;
    if (this.touchSteer !== undefined && this.touchSteer !== 0) {
      targetSteer = this.touchSteer;
    }

    let targetThrottle = this.keys.throttle ? 1 : 0;
    if (this.touchThrottle !== undefined && this.touchThrottle > 0) {
      targetThrottle = Math.max(targetThrottle, this.touchThrottle);
    }

    let targetBrake = this.keys.brake ? 1 : 0;
    if (this.touchBrake !== undefined && this.touchBrake > 0) {
      targetBrake = Math.max(targetBrake, this.touchBrake);
    }

    let targetHandbrake = this.keys.handbrake ? 1 : 0;

    // Read connected gamepads
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (gamepads && gamepads[0]) {
      const gp = gamepads[0];
      // Left stick X axis for steering
      if (Math.abs(gp.axes[0]) > 0.1) {
        targetSteer = gp.axes[0];
      }
      // Right trigger for throttle (button 7 or axis 5/2)
      if (gp.buttons[7] && gp.buttons[7].value > 0.05) {
        targetThrottle = gp.buttons[7].value;
      }
      // Left trigger for brake (button 6)
      if (gp.buttons[6] && gp.buttons[6].value > 0.05) {
        targetBrake = gp.buttons[6].value;
      }
      // Button A (0) for handbrake
      if (gp.buttons[0] && gp.buttons[0].pressed) {
        targetHandbrake = 1;
      }
    }

    this.steering = targetSteer;
    this.throttle = targetThrottle;
    this.brake = targetBrake;
    this.handbrake = targetHandbrake;
  }
}
