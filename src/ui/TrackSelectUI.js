/**
 * Track Circuit & Environment Settings Selection Modal.
 */
export class TrackSelectUI {
  constructor(onChangeTrack, onChangeEnv) {
    this.modal = document.getElementById('track-select-modal');
    this.onChangeTrack = onChangeTrack;
    this.onChangeEnv = onChangeEnv;

    this.currentTrack = 'apex';
    this.currentTOD = 'noon';
    this.currentWeather = 'clear';
    this.visible = false;

    this.setupListeners();
  }

  toggle() {
    this.visible = !this.visible;
    if (this.modal) {
      this.modal.classList.toggle('hidden', !this.visible);
    }
  }

  /** Reflect the state the game actually loaded (e.g. a circuit's default time of day). */
  sync(trackId, timeOfDay, weather) {
    this.currentTrack = trackId;
    this.currentTOD = timeOfDay;
    this.currentWeather = weather;
    document.querySelectorAll('.track-card').forEach(c => c.classList.toggle('selected', c.dataset.track === trackId));
    document.querySelectorAll('.tod-btn').forEach(b => b.classList.toggle('active', b.dataset.tod === timeOfDay));
    document.querySelectorAll('.weather-btn').forEach(b => b.classList.toggle('active', b.dataset.weather === weather));
  }

  setupListeners() {
    // Track Buttons
    const trackBtns = document.querySelectorAll('.track-card');
    trackBtns.forEach(card => {
      card.addEventListener('click', (e) => {
        if (card.dataset.track === this.currentTrack) return;
        // The game calls sync() back with the circuit's default time of day
        if (this.onChangeTrack) this.onChangeTrack(card.dataset.track);
      });
    });

    // Time of Day Buttons
    const todBtns = document.querySelectorAll('.tod-btn');
    todBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.currentTOD = btn.dataset.tod;
        todBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (this.onChangeEnv) {
          this.onChangeEnv(this.currentTOD, this.currentWeather);
        }
      });
    });

    // Weather Buttons
    const weatherBtns = document.querySelectorAll('.weather-btn');
    weatherBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.currentWeather = btn.dataset.weather;
        weatherBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (this.onChangeEnv) {
          this.onChangeEnv(this.currentTOD, this.currentWeather);
        }
      });
    });

    // Close Modal Button
    const closeBtn = document.getElementById('track-select-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggle());
    }
  }
}
