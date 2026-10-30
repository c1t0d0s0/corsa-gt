/**
 * Procedural Web Audio sound for the car. Nothing is sampled.
 *
 * The engine is built the way a real one makes noise: a periodic pressure
 * wave locked to the crankshaft (strong at the firing frequency and its
 * multiples, with weaker half-orders for the uneven burble), pushed through
 * an "exhaust" of fixed resonances so the tone changes as the revs sweep
 * past them. Combustion rasp, intake roar, turbo whistle, overrun crackle,
 * wind, road and tyre noise are layered on top.
 *
 * In EV mode the engine falls silent and an electric drive takes over: the
 * motor's tone and the reduction gear's hum, both locked to road speed, plus
 * the soft warning tone EVs play at walking pace. Wind, road and tyres stay.
 */
const HARMONICS = 40;

/**
 * Pitch of the electric motor's tone for a road speed. It climbs quickly away
 * from rest so acceleration is easy to hear, then levels off: about 280 Hz at
 * 50 km/h, 600 Hz at 200 km/h and never much past 750 Hz, which keeps it in the
 * warm middle of the range instead of a thin whistle at speed.
 */
export function motorHz(kmh) {
  const v = Math.abs(kmh);
  return 85 + 420 * (1 - Math.exp(-v / 110)) + v * 0.8;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * One engine cycle (two crank turns) as a set of harmonics. Harmonic n sits
 * at engine order n/2, so the firing frequency is harmonic `cylinders`.
 * `brightness` 0 = closed throttle (soft, bassy), 1 = wide open (hard-edged).
 */
function engineWave(ctx, brightness, cylinders) {
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  const rolloff = lerp(1.25, 0.62, brightness);
  for (let n = 1; n <= HARMONICS; n++) {
    let weight;
    if (n % cylinders === 0) weight = 1; // every cylinder firing in turn
    else if (n % (cylinders / 2) === 0) weight = lerp(0.3, 0.5, brightness); // bank-to-bank imbalance
    else weight = lerp(0.1, 0.2, brightness); // cylinder-to-cylinder variation: the burble
    const amp = weight / Math.pow(n / cylinders + 0.35, rolloff);
    // Fixed scattered phases keep the waveform from collapsing into one sharp spike
    const phase = (n * 2.399963) % (Math.PI * 2);
    real[n] = amp * Math.cos(phase);
    imag[n] = amp * Math.sin(phase);
  }
  return ctx.createPeriodicWave(real, imag);
}

function softClipCurve(drive) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

export class AudioEngine {
  constructor() {
    this.cylinders = 6;
    this.ctx = null;
    this.initialized = false;
    this.muted = false;
    this.volume = 0.8;

    this.load = 0;
    this.boost = 0;
    this.throttlePeak = 0;
    this.crackleTime = 0;
    this.nextCrackle = 0;
    this.lastWallHit = 0;
    this.interior = false;
    this.offline = false;
    this.ev = false; // electric drive sound instead of the engine
    this.regen = 0;
  }

  /** Build the graph. A context can be passed in for offline rendering in tests. */
  init(context = null) {
    if (this.initialized) return;
    try {
      const ctx = context || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      this.offline = !!context;
      const now = ctx.currentTime;
      const gain = (value) => {
        const g = ctx.createGain();
        g.gain.setValueAtTime(value, now);
        return g;
      };
      const filter = (type, freq, q = 0.7, gainDb = 0) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.setValueAtTime(freq, now);
        f.Q.setValueAtTime(q, now);
        f.gain.setValueAtTime(gainDb, now);
        return f;
      };
      const chain = (...nodes) => nodes.reduce((a, b) => (a.connect(b), b));

      // --- Output: cabin filter → compressor → master ---
      this.masterGain = gain(this.muted ? 0 : this.volume);
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-16, now);
      compressor.knee.setValueAtTime(12, now);
      compressor.ratio.setValueAtTime(5, now);
      compressor.attack.setValueAtTime(0.004, now);
      compressor.release.setValueAtTime(0.18, now);
      this.cabinFilter = filter('lowpass', this.interior ? 2600 : 18000, 0.5);
      chain(this.cabinFilter, compressor, this.masterGain, ctx.destination);
      const out = this.cabinFilter;

      // Two seconds of white noise shared by every noisy layer
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = () => {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        src.start(now, Math.random() * 2);
        return src;
      };

      // --- Engine core: crank-locked waves, cross-faded by load ---
      const engineBus = gain(1);
      this.engineOscs = [];
      this.offGain = gain(1);
      this.onGain = gain(0);
      const layers = [[engineWave(ctx, 0, this.cylinders), this.offGain], [engineWave(ctx, 1, this.cylinders), this.onGain]];
      for (const [wave, target] of layers) {
        // A slightly detuned twin thickens the note
        for (const cents of [0, 7]) {
          const osc = ctx.createOscillator();
          osc.setPeriodicWave(wave);
          osc.detune.setValueAtTime(cents, now);
          osc.frequency.setValueAtTime(1000 / 120, now);
          osc.connect(target);
          osc.start();
          this.engineOscs.push(osc);
        }
        target.connect(engineBus);
      }

      // Combustion rasp: noise chopped at the firing frequency
      this.raspFilter = filter('bandpass', 1200, 0.8);
      const raspChop = gain(0);
      this.firingOsc = ctx.createOscillator();
      this.firingOsc.type = 'sawtooth';
      this.firingOsc.frequency.setValueAtTime(50, now);
      this.firingOsc.connect(raspChop.gain);
      this.firingOsc.start();
      this.raspGain = gain(0);
      chain(noise(), this.raspFilter, raspChop, this.raspGain, engineBus);

      // Drive stage, then the exhaust: fixed resonances plus a load-dependent top end
      this.drive = gain(0.5);
      const shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve(2.6);
      shaper.oversample = '2x';
      this.exhaustTone = filter('lowpass', 900, 0.9);
      this.engineGain = gain(0);
      this.limiterGain = gain(1); // rev-limiter stutter
      chain(
        engineBus, this.drive, shaper,
        filter('highpass', 28, 0.7),
        filter('peaking', 150, 1.1, 5), // body
        filter('peaking', 480, 1.4, 6), // bark
        filter('peaking', 1150, 1.8, 5), // snarl
        filter('peaking', 2500, 2.0, 3), // edge
        this.exhaustTone, this.engineGain, this.limiterGain, out
      );

      // --- Intake roar under load ---
      this.intakeFilter = filter('bandpass', 420, 0.9);
      this.intakeGain = gain(0);
      chain(noise(), this.intakeFilter, this.intakeGain, out);

      // --- Turbo: spooling whistle plus compressor hiss ---
      this.turboOsc = ctx.createOscillator();
      this.turboOsc.type = 'sine';
      this.turboOsc.frequency.setValueAtTime(2000, now);
      this.turboOsc.start();
      this.turboGain = gain(0);
      chain(this.turboOsc, this.turboGain, out);
      this.turboNoiseFilter = filter('bandpass', 5000, 5);
      this.turboNoiseGain = gain(0);
      chain(noise(), this.turboNoiseFilter, this.turboNoiseGain, out);

      // --- Electric drive: motor whine, reduction-gear hum, low-speed warning tone ---
      const evBus = gain(1);
      // Trim the very bottom and everything above the upper midrange, where tones turn shrill
      chain(evBus, filter('highpass', 70, 0.7), filter('lowpass', 2200, 0.6), out);
      this.motorOsc = ctx.createOscillator();
      this.motorOsc.type = 'sine';
      this.motorOsc.frequency.setValueAtTime(100, now);
      this.motorOsc.start();
      this.motorGain = gain(0);
      chain(this.motorOsc, this.motorGain, evBus);
      // Under hard acceleration a second voice a fifth above joins in: a chord, not a shriek
      this.motorOsc2 = ctx.createOscillator();
      this.motorOsc2.type = 'sine';
      this.motorOsc2.frequency.setValueAtTime(150, now);
      this.motorOsc2.start();
      this.motorGain2 = gain(0);
      chain(this.motorOsc2, this.motorGain2, evBus);
      this.gearOsc = ctx.createOscillator();
      this.gearOsc.type = 'sine';
      this.gearOsc.frequency.setValueAtTime(40, now);
      this.gearOsc.start();
      this.gearGain = gain(0);
      chain(this.gearOsc, this.gearGain, evBus);
      // Warning tone: two slightly detuned soft voices, gone by 30 km/h
      this.avasGain = gain(0);
      const avasTone = filter('lowpass', 1100, 0.7);
      chain(avasTone, this.avasGain, evBus);
      this.avasOscs = [0, 9].map((cents) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.detune.setValueAtTime(cents, now);
        osc.frequency.setValueAtTime(330, now);
        osc.connect(avasTone);
        osc.start();
        return osc;
      });

      // --- Wind and road ---
      this.windFilter = filter('bandpass', 700, 0.5);
      this.windGain = gain(0);
      // A broad band of noise with its top rolled off: a rush of air rather than a hiss
      chain(noise(), this.windFilter, filter('lowpass', 1400, 0.5), this.windGain, out);
      this.roadFilter = filter('lowpass', 160, 0.7);
      this.roadGain = gain(0);
      chain(noise(), this.roadFilter, this.roadGain, out);

      // --- Tyres: two squeal resonances that drop in pitch as the slide deepens ---
      this.squealA = filter('bandpass', 950, 9);
      this.squealB = filter('bandpass', 1650, 12);
      this.squealGain = gain(0);
      const squealSrc = noise();
      chain(squealSrc, this.squealA, this.squealGain, out);
      chain(squealSrc, this.squealB, this.squealGain);

      this.initialized = true;
    } catch (e) {
      console.warn('Web Audio API not supported or blocked:', e);
    }
  }

  /** Switch engine character, e.g. when changing car. Safe to call before init. */
  setEngine({ cylinders }) {
    this.cylinders = cylinders;
    if (!this.initialized) return;
    const waves = [engineWave(this.ctx, 0, cylinders), engineWave(this.ctx, 1, cylinders)];
    // Oscillators were created off-load pair first, then on-load pair
    this.engineOscs.forEach((osc, i) => osc.setPeriodicWave(waves[i < 2 ? 0 : 1]));
  }

  unlock() {
    if (!this.initialized) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * Per-frame update.
   * @param s  { rpm, maxRpm, throttle, cut, slip, speedKmh, surface, wet, wallHit, running }
   * @param dt frame time in seconds
   */
  update(s, dt = 1 / 60) {
    if (!this.initialized || !this.ctx || (this.ctx.state === 'suspended' && !this.offline)) return;
    const now = this.ctx.currentTime;
    const set = (param, value, tc = 0.04) => param.setTargetAtTime(value, now, tc);

    const maxRpm = s.maxRpm || 8200;
    const rpm = clamp(s.rpm, 800, maxRpm + 200);
    const norm = clamp((rpm - 1000) / (maxRpm - 1000), 0, 1);
    const throttle = s.running === false || s.cut ? 0 : clamp(s.throttle, 0, 1);

    // Load lags the pedal slightly on the way up, drops quickly on lift
    this.load += (throttle - this.load) * Math.min(1, (throttle > this.load ? 14 : 22) * dt);

    if (this.ev) {
      this.updateElectric(s, throttle, set, dt);
    } else {
      this.updateEngine(s, rpm, maxRpm, norm, throttle, now, set, dt);
    }
    this.updateSurroundings(s, set);
  }

  /** Mute one sound set and fade up the other when switching power train. */
  setElectric(on) {
    this.ev = on;
    if (!this.initialized) return;
    const now = this.ctx.currentTime;
    const off = (param) => param.setTargetAtTime(0, now, 0.08);
    if (on) {
      [this.engineGain.gain, this.intakeGain.gain, this.turboGain.gain, this.turboNoiseGain.gain].forEach(off);
      this.crackleTime = 0;
      this.boost = 0;
    } else {
      [this.motorGain.gain, this.motorGain2.gain, this.gearGain.gain, this.avasGain.gain].forEach(off);
    }
  }

  /**
   * Electric drive. The motor turns at a fixed ratio to the wheels, so its
   * whine rises with road speed, not revs: louder when it pulls or recovers
   * energy, faint when coasting. Everything is kept well below the engine.
   */
  updateElectric(s, throttle, set, dt) {
    const kmh = Math.abs(s.speedKmh);
    const moving = clamp(kmh / 25, 0, 1);
    // Lifting off or braking above walking pace: the motor regenerates and keeps singing, more softly
    const regenTarget = s.running === false ? 0 : clamp((1 - throttle * 3) * clamp((kmh - 8) / 30, 0, 1), 0, 1) * (0.5 + clamp(s.brake || 0, 0, 1) * 0.5);
    this.regen += (regenTarget - this.regen) * Math.min(1, 6 * dt);
    const hz = motorHz(kmh);
    set(this.motorOsc.frequency, hz, 0.05);
    set(this.motorOsc2.frequency, hz * 1.5, 0.05);
    set(this.gearOsc.frequency, 30 + kmh * 2.6, 0.05);
    const effort = Math.sqrt(this.load);
    set(this.motorGain.gain, moving * (0.008 + effort * 0.03 + this.regen * 0.014), 0.06);
    set(this.motorGain2.gain, moving * effort * 0.012, 0.06);
    set(this.gearGain.gain, moving * (0.03 + effort * 0.03), 0.08);
    // Warning tone at walking pace (and a faint hum at a standstill), rising a little with speed
    const avas = s.running === false ? 0 : (1 - clamp(kmh / 30, 0, 1)) * (kmh < 1 ? 0.25 : 1);
    this.avasOscs.forEach((osc) => set(osc.frequency, 300 + kmh * 9, 0.08));
    set(this.avasGain.gain, avas * 0.035, 0.15);
  }

  updateEngine(s, rpm, maxRpm, norm, throttle, now, set, dt) {
    const load = this.load;
    // Engine core
    const cycleHz = rpm / 120;
    this.engineOscs.forEach((osc) => set(osc.frequency, cycleHz, 0.03));
    set(this.firingOsc.frequency, cycleHz * this.cylinders, 0.03);
    set(this.onGain.gain, Math.sqrt(load) * 0.95);
    set(this.offGain.gain, Math.sqrt(1 - load) * 0.8);
    set(this.drive.gain, 0.4 + load * 0.75 + norm * 0.2);
    set(this.exhaustTone.frequency, 650 + norm * 2600 + load * (1400 + norm * 3200));
    set(this.raspFilter.frequency, 700 + norm * 2300);
    set(this.raspGain.gain, load * (0.08 + norm * 0.34));
    // Louder with revs and much louder on throttle; coasting sits well back
    const engineLevel = (0.2 + norm * 0.3) * (0.42 + load * 0.58) * (s.cut ? 0.35 : 1);
    set(this.engineGain.gain, engineLevel, s.cut ? 0.015 : 0.04);

    // Rev limiter: a hard on/off flutter when held against the stop
    const onLimiter = rpm > maxRpm - 120 && throttle > 0.5;
    set(this.limiterGain.gain, onLimiter && Math.floor(now * 28) % 2 === 0 ? 0.25 : 1, 0.004);

    // Intake
    set(this.intakeFilter.frequency, 260 + norm * 650);
    set(this.intakeGain.gain, load * (0.03 + norm * 0.1));

    // Turbo: boost builds with load and revs, and dumps when the throttle snaps shut
    const boostTarget = load * clamp((norm - 0.18) / 0.45, 0, 1);
    this.boost += (boostTarget - this.boost) * Math.min(1, (boostTarget > this.boost ? 2.4 : 3.5) * dt);
    set(this.turboOsc.frequency, 2400 + this.boost * 5200, 0.08);
    set(this.turboGain.gain, this.boost * this.boost * 0.012, 0.08);
    set(this.turboNoiseFilter.frequency, 3500 + this.boost * 4500, 0.08);
    set(this.turboNoiseGain.gain, this.boost * 0.035, 0.08);

    // Lift-off. The pedal takes a few frames to come up, so compare against how hard it
    // was pressed recently rather than on the previous frame.
    this.throttlePeak = Math.max(throttle, this.throttlePeak - dt * 2.5);
    if (throttle < 0.15 && this.throttlePeak > 0.6) {
      this.throttlePeak = 0;
      if (this.boost > 0.3) this.playBlowOff(this.boost); // turbo dumps its boost
      if (norm > 0.5) {
        // Overrun: unburnt fuel popping in the exhaust
        this.crackleTime = 0.5 + norm * 0.9;
        this.nextCrackle = 0.04;
      }
    }
    if (this.crackleTime > 0) {
      this.crackleTime -= dt;
      this.nextCrackle -= dt;
      if (throttle > 0.3 || norm < 0.22) {
        this.crackleTime = 0;
      } else if (this.nextCrackle <= 0) {
        this.playPop(0.1 + Math.random() * 0.16, 0.5 + Math.random());
        this.nextCrackle = 0.05 + Math.random() * 0.2;
      }
    }

  }

  /** Wind, road, tyres and barrier knocks, whatever drives the car. */
  updateSurroundings(s, set) {
    // Wind and road
    const speed = clamp(s.speedKmh / 250, 0, 1.2);
    const offRoad = s.surface === 'grass' || s.surface === 'sand';
    set(this.windFilter.frequency, 350 + speed * 650, 0.2);
    set(this.windGain.gain, speed * speed * 0.16, 0.2);
    set(this.roadFilter.frequency, offRoad ? 420 : s.wet ? 900 : 190, 0.15);
    const roadLevel = offRoad ? 0.4 : s.surface === 'kerb' ? 0.3 : s.wet ? 0.14 : 0.11;
    set(this.roadGain.gain, Math.min(1, speed * 2.2) * roadLevel, 0.1);

    // Tyres: squeal on dry tarmac, a hiss in the wet, nothing on grass
    const slip = s.running === false ? 0 : clamp((s.slip - 0.2) / 0.9, 0, 1);
    set(this.squealA.frequency, (s.wet ? 2600 : 1050) - slip * 260, 0.06);
    set(this.squealB.frequency, (s.wet ? 4200 : 1750) - slip * 380, 0.06);
    set(this.squealA.Q, s.wet ? 1.2 : 9, 0.1);
    set(this.squealB.Q, s.wet ? 1.2 : 12, 0.1);
    set(this.squealGain.gain, offRoad ? 0 : slip * (s.wet ? 0.12 : 0.8), 0.05);

    // Barrier contact
    if (s.wallHit > 1.5 && this.lastWallHit <= 1.5) this.playImpact(clamp(s.wallHit / 12, 0.2, 1));
    this.lastWallHit = s.wallHit || 0;
  }

  /** Short filtered noise burst: the building block for pops, bangs and thumps. */
  burst({ freq, q, level, decay, type = 'bandpass', thump = 0 }) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, now);
    f.Q.setValueAtTime(q, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.cabinFilter);
    src.start(now, Math.random());
    src.stop(now + decay + 0.02);

    if (thump > 0) {
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.frequency.setValueAtTime(freq * 0.4, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.12), now + decay);
      og.gain.setValueAtTime(thump, now);
      og.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      osc.connect(og);
      og.connect(this.cabinFilter);
      osc.start(now);
      osc.stop(now + decay + 0.02);
    }
  }

  ready() {
    return this.initialized && !this.muted && this.ctx.state === 'running';
  }

  playPop(level, tone = 1) {
    if (!this.ready()) return;
    this.burst({ freq: 260 * tone, q: 1.4, level, decay: 0.07, thump: level * 0.6 });
  }

  /** Gear change: a flat bang out of the exhaust on upshifts, a throttle blip coming down. */
  playShift(direction, intensity = 1) {
    if (!this.ready() || this.ev) return;
    if (direction > 0) {
      this.burst({ freq: 190, q: 1.0, level: 0.3 * intensity, decay: 0.1, thump: 0.3 * intensity });
    } else {
      this.load = Math.max(this.load, 0.8); // rev-matching blip
      this.crackleTime = Math.max(this.crackleTime, 0.35);
    }
  }

  playBlowOff(amount) {
    this.boost = 0;
    if (!this.ready()) return;
    this.burst({ freq: 3200, q: 0.9, level: 0.1 * amount, decay: 0.28 });
  }

  playImpact(strength) {
    if (!this.ready()) return;
    this.burst({ freq: 140, q: 0.7, level: 0.7 * strength, decay: 0.22, type: 'lowpass', thump: 0.6 * strength });
    this.burst({ freq: 2200, q: 0.8, level: 0.14 * strength, decay: 0.12 });
  }

  /** Inside the car the top end is absorbed and everything sounds closer and duller. */
  setInterior(inside) {
    this.interior = inside;
    if (!this.initialized) return;
    this.cabinFilter.frequency.setTargetAtTime(inside ? 2600 : 18000, this.ctx.currentTime, 0.08);
  }

  /** Silence everything while the game is paused. */
  setPaused(paused) {
    if (!this.ctx) return;
    if (paused) this.ctx.suspend();
    else this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.masterGain && !this.muted && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }
}
