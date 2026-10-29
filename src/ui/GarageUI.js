import { getCarSpec } from '../engine/CarSpecs.js';

/**
 * Car Customizer Garage Panel Controller.
 * Allows choosing the car and modifying paint colors, finishes, wing aero, rim colors, and engine tuning specs.
 */
export class GarageUI {
  constructor(onUpdateCar, onEngineTuneChange) {
    this.panel = document.getElementById('garage-panel');
    this.visible = false;
    this.onUpdateCar = onUpdateCar;
    this.onEngineTuneChange = onEngineTuneChange;

    this.currentConfig = {
      carId: 'gt',
      bodyColor: 0xdc2626,
      paintFinish: 'metallic',
      wingStyle: 'gt3',
      rimColor: 0x18181b,
      tuneLevel: 1 // index into the car's tune presets
    };

    this.setupListeners();
  }

  toggle() {
    this.visible = !this.visible;
    if (this.panel) {
      this.panel.classList.toggle('hidden', !this.visible);
    }
  }

  setupListeners() {
    // Car
    document.querySelectorAll('.car-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectCar(btn.dataset.car));
    });

    // Body Paint Swatches
    const swatches = document.querySelectorAll('.body-swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', (e) => {
        const colorHex = parseInt(e.target.dataset.color, 16);
        this.currentConfig.bodyColor = colorHex;
        swatches.forEach(s => s.classList.remove('selected'));
        e.target.classList.add('selected');
        this.applyChanges();
      });
    });

    // Paint Finish Radio Buttons
    const finishBtns = document.querySelectorAll('.finish-btn');
    finishBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const finish = e.target.dataset.finish;
        this.currentConfig.paintFinish = finish;
        finishBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.applyChanges();
      });
    });

    // Wheel Rim Colour
    const rimSwatches = document.querySelectorAll('.rim-swatch');
    rimSwatches.forEach(swatch => {
      swatch.addEventListener('click', (e) => {
        this.currentConfig.rimColor = parseInt(e.target.dataset.color, 16);
        rimSwatches.forEach(s => s.classList.remove('selected'));
        e.target.classList.add('selected');
        this.applyChanges();
      });
    });

    // Rear Wing Selection
    const wingBtns = document.querySelectorAll('.wing-btn');
    wingBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const wing = e.target.dataset.wing;
        this.currentConfig.wingStyle = wing;
        wingBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.applyChanges();
      });
    });

    // Engine Power Preset
    const tuneBtns = document.querySelectorAll('.tune-btn');
    tuneBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentConfig.tuneLevel = parseInt(btn.dataset.level, 10);
        tuneBtns.forEach(b => b.classList.toggle('active', b === btn));
        this.applyTune();
      });
    });
  }

  /** Switch car, keeping paint and wheels; the wing and tune presets follow the car. */
  selectCar(carId) {
    const spec = getCarSpec(carId);
    this.currentConfig.carId = spec.id;
    // Each car starts on the wing that suits it; paint and wheels carry over
    this.currentConfig.wingStyle = spec.defaultWing;
    document.querySelectorAll('.wing-btn').forEach(b => b.classList.toggle('active', b.dataset.wing === spec.defaultWing));
    document.querySelectorAll('.car-btn').forEach(b => b.classList.toggle('active', b.dataset.car === spec.id));
    this.labelTunes();
    this.applyChanges();
    this.applyTune();
  }

  labelTunes() {
    const spec = getCarSpec(this.currentConfig.carId);
    document.querySelectorAll('.tune-btn').forEach(btn => {
      const level = parseInt(btn.dataset.level, 10);
      btn.textContent = `${spec.tuneNames[level]} (${spec.tunes[level]} HP)`;
    });
  }

  applyChanges() {
    if (this.onUpdateCar) {
      this.onUpdateCar(this.currentConfig);
    }
  }

  /** Push the engine preset to the car; the callback reports the resulting top speed. */
  applyTune() {
    const hp = getCarSpec(this.currentConfig.carId).tunes[this.currentConfig.tuneLevel];
    const topSpeed = this.onEngineTuneChange ? this.onEngineTuneChange(hp) : 0;
    const hpBar = document.getElementById('stat-power-bar');
    const speedBar = document.getElementById('stat-speed-bar');
    if (hpBar) hpBar.style.width = `${(hp / 850) * 100}%`;
    if (speedBar && topSpeed) speedBar.style.width = `${Math.min(100, (topSpeed / 340) * 100)}%`;
  }

  /** Apply the defaults shown in the panel so the car matches the UI from the first frame. */
  applyAll() {
    this.labelTunes();
    this.applyChanges();
    this.applyTune();
  }
}
