/**
 * Car Customizer Garage Panel Controller.
 * Allows modifying paint colors, finishes, wing aero, rim colors, and engine tuning specs.
 */
export class GarageUI {
  constructor(onUpdateCar, onEngineTuneChange) {
    this.panel = document.getElementById('garage-panel');
    this.visible = false;
    this.onUpdateCar = onUpdateCar;
    this.onEngineTuneChange = onEngineTuneChange;

    this.currentConfig = {
      bodyColor: 0xdc2626,
      paintFinish: 'metallic',
      wingStyle: 'gt3',
      rimColor: 0x111111,
      engineHp: 650
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
    // Body Paint Swatches
    const swatches = document.querySelectorAll('.color-swatch');
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
      btn.addEventListener('click', (e) => {
        const hp = parseInt(e.target.dataset.hp, 10);
        this.currentConfig.engineHp = hp;
        tuneBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        if (this.onEngineTuneChange) this.onEngineTuneChange(hp);
        this.updateStatsDisplay();
      });
    });

    // Close Garage Button
    const closeBtn = document.getElementById('garage-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggle());
    }
  }

  applyChanges() {
    if (this.onUpdateCar) {
      this.onUpdateCar(this.currentConfig);
    }
  }

  updateStatsDisplay() {
    const hp = this.currentConfig.engineHp;
    const hpBar = document.getElementById('stat-power-bar');
    const speedBar = document.getElementById('stat-speed-bar');

    if (hpBar) hpBar.style.width = `${(hp / 850) * 100}%`;
    if (speedBar) speedBar.style.width = `${(hp / 850) * 100}%`;
  }
}
