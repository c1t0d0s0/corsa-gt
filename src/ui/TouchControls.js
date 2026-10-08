/**
 * On-screen driving controls for phones and tablets: an analog steering pad
 * under the left thumb, pedals under the right.
 *
 * Everything uses pointer events with capture, so each finger is tracked
 * independently and a finger that slides off a control still releases it.
 */
export class TouchControls {
  constructor(input, { onRecover } = {}) {
    this.input = input;
    this.enabled = false;
    this.portraitQuery = window.matchMedia('(orientation: portrait)');

    this.pad = document.getElementById('touch-steer');
    this.knob = document.getElementById('touch-steer-knob');
    this.setupSteering();

    this.hold('touch-accel-btn', (on) => { input.touchThrottle = on ? 1 : 0; });
    this.hold('touch-brake-btn', (on) => { input.touchBrake = on ? 1 : 0; });
    this.hold('touch-handbrake-btn', (on) => { input.touchHandbrake = on ? 1 : 0; });

    const recover = document.getElementById('touch-recover-btn');
    if (recover) {
      recover.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (onRecover) onRecover();
      });
    }

    // Phones first; a hybrid laptop switches over the moment its screen is actually touched
    const params = new URLSearchParams(window.location.search);
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (coarse || params.get('touch') === '1') this.enable();
    else window.addEventListener('touchstart', () => this.enable(), { once: true, passive: true });

    // Safari pinch gesture; everything else is covered by touch-action in CSS
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  enable() {
    this.enabled = true;
    document.body.classList.add('touch');
  }

  /** True when a touch device is being held upright; the game waits for landscape. */
  get portrait() {
    return this.enabled && this.portraitQuery.matches;
  }

  /**
   * Steering is relative to where the thumb lands, so the driver never has to
   * look down to find the centre.
   */
  setupSteering() {
    const pad = this.pad;
    if (!pad) return;
    let pointerId = null;
    let originX = 0;

    const set = (value) => {
      this.input.touchSteer = value;
      this.input.touchSteerActive = pointerId !== null;
      if (this.knob) {
        const travel = (pad.clientWidth - this.knob.offsetWidth) / 2;
        this.knob.style.transform = `translate(calc(-50% + ${(value * travel).toFixed(1)}px), -50%)`;
      }
      pad.classList.toggle('active', pointerId !== null);
    };

    pad.addEventListener('pointerdown', (e) => {
      if (pointerId !== null) return;
      e.preventDefault();
      pointerId = e.pointerId;
      originX = e.clientX;
      pad.setPointerCapture(pointerId);
      set(0);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      const range = pad.clientWidth * 0.36;
      const raw = Math.max(-1, Math.min(1, (e.clientX - originX) / range));
      // A touch of curve gives finer control around straight ahead
      set(Math.sign(raw) * Math.pow(Math.abs(raw), 1.25));
    });
    const release = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      set(0);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(type, release);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  hold(id, onChange) {
    const el = document.getElementById(id);
    if (!el) return;
    const set = (on) => {
      el.classList.toggle('active', on);
      onChange(on);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, () => set(false));
    }
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
