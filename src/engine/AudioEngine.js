/**
 * Procedural Web Audio API Sound Engine for GT Racing Cars.
 * Synthesizes engine tones, exhaust harmonics, tire screeches, and backfire pops.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.initialized = false;
    this.muted = false;
    this.volume = 0.8;

    // Engine Nodes
    this.masterGain = null;
    this.engineGain = null;
    this.osc1 = null;
    this.osc2 = null;
    this.subOsc = null;
    this.filter = null;
    this.distortion = null;

    // Tire Screech Nodes
    this.screechGain = null;
    this.noiseBuffer = null;
    this.screechFilter = null;
    this.screechNode = null;

    // Turbo Spool Nodes
    this.turboGain = null;
    this.turboOsc = null;

    this.currentRPM = 1000;
  }

  init() {
    if (this.initialized) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      // Master Gain
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      // --- Engine Synthesizer Pipeline ---
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      // Lowpass Filter for Engine warmth & RPM cutoff modulation
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.setValueAtTime(600, this.ctx.currentTime);
      this.filter.Q.setValueAtTime(3.5, this.ctx.currentTime);

      // WaveShaper for GT Exhaust Growl/Distortion
      this.distortion = this.ctx.createWaveShaper();
      this.distortion.curve = this.makeDistortionCurve(15);

      // Oscillators (Sawtooth main, Triangle harmonic, Square sub)
      this.osc1 = this.ctx.createOscillator();
      this.osc1.type = 'sawtooth';
      this.osc1.frequency.setValueAtTime(50, this.ctx.currentTime);

      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'triangle';
      this.osc2.frequency.setValueAtTime(100, this.ctx.currentTime);

      this.subOsc = this.ctx.createOscillator();
      this.subOsc.type = 'square';
      this.subOsc.frequency.setValueAtTime(25, this.ctx.currentTime);

      const subGain = this.ctx.createGain();
      subGain.gain.setValueAtTime(0.3, this.ctx.currentTime);

      this.osc1.connect(this.filter);
      this.osc2.connect(this.filter);
      this.subOsc.connect(subGain);
      subGain.connect(this.filter);

      this.filter.connect(this.distortion);
      this.distortion.connect(this.engineGain);
      this.engineGain.connect(this.masterGain);

      this.osc1.start();
      this.osc2.start();
      this.subOsc.start();

      // --- Tire Screech Synthesizer ---
      this.setupTireScreech();

      // --- Turbo Whistle Synthesizer ---
      this.setupTurbo();

      this.initialized = true;
    } catch (e) {
      console.warn("Web Audio API not supported or blocked:", e);
    }
  }

  makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  setupTireScreech() {
    // Generate 1 second of white noise
    const bufferSize = this.ctx.sampleRate * 1.0;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.screechNode = this.ctx.createBufferSource();
    this.screechNode.buffer = this.noiseBuffer;
    this.screechNode.loop = true;

    this.screechFilter = this.ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.frequency.setValueAtTime(1400, this.ctx.currentTime);
    this.screechFilter.Q.setValueAtTime(6.0, this.ctx.currentTime);

    this.screechGain = this.ctx.createGain();
    this.screechGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.screechNode.connect(this.screechFilter);
    this.screechFilter.connect(this.screechGain);
    this.screechGain.connect(this.masterGain);

    this.screechNode.start();
  }

  setupTurbo() {
    this.turboOsc = this.ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.setValueAtTime(1200, this.ctx.currentTime);

    this.turboGain = this.ctx.createGain();
    this.turboGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.masterGain);
    this.turboOsc.start();
  }

  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    if (!this.initialized) {
      this.init();
    }
  }

  update(rpm, throttle, slipAmount, speedKmh) {
    if (!this.initialized || !this.ctx || this.muted) return;

    if (this.ctx.state === 'suspended') return;

    this.currentRPM = rpm;
    const normRPM = (rpm - 1000) / (8500 - 1000); // 0.0 to 1.0

    // Base engine fundamental pitch
    // Idle (~1000 RPM) -> ~45Hz, Redline (8500 RPM) -> ~420Hz
    const baseFreq = 40 + normRPM * 380;
    const now = this.ctx.currentTime;

    this.osc1.frequency.setTargetAtTime(baseFreq, now, 0.05);
    this.osc2.frequency.setTargetAtTime(baseFreq * 1.5, now, 0.05); // 5th harmonic
    this.subOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.05);

    // Filter cutoff scales with RPM & Throttle load
    const filterFreq = 400 + normRPM * 3500 + throttle * 1500;
    this.filter.frequency.setTargetAtTime(filterFreq, now, 0.05);

    // Engine volume scales with RPM and load
    const engineVol = 0.15 + normRPM * 0.45 + throttle * 0.25;
    this.engineGain.gain.setTargetAtTime(engineVol * this.volume, now, 0.05);

    // Tire Screech volume scaling (slipAmount ranges 0 to 1+)
    const screechVol = Math.min(1.0, Math.max(0, (slipAmount - 0.25) * 1.8)) * 0.3;
    this.screechGain.gain.setTargetAtTime(screechVol * this.volume, now, 0.05);

    // Turbo spool whistle high pitched sound at high RPM & throttle
    const turboVol = (normRPM > 0.4 ? (normRPM - 0.4) * throttle * 0.12 : 0);
    const turboFreq = 1500 + normRPM * 3000;
    this.turboGain.gain.setTargetAtTime(turboVol * this.volume, now, 0.08);
    this.turboOsc.frequency.setTargetAtTime(turboFreq, now, 0.08);
  }

  playBackfire() {
    if (!this.initialized || !this.ctx || this.muted) return;

    const now = this.ctx.currentTime;
    const popOsc = this.ctx.createOscillator();
    const popGain = this.ctx.createGain();

    popOsc.type = 'sawtooth';
    popOsc.frequency.setValueAtTime(160, now);
    popOsc.frequency.exponentialRampToValueAtTime(30, now + 0.08);

    popGain.gain.setValueAtTime(0.4 * this.volume, now);
    popGain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    popOsc.connect(popGain);
    popGain.connect(this.masterGain);

    popOsc.start(now);
    popOsc.stop(now + 0.09);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.masterGain && !this.muted && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }
}
