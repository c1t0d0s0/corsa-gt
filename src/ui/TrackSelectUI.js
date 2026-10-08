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

    this.setupListeners();
  }

  toggle() {
    if (this.modal) {
      this.modal.classList.toggle('hidden');
    }
  }

  setupListeners() {
    // Track Buttons
    const trackBtns = document.querySelectorAll('.track-card');
    trackBtns.forEach(card => {
      card.addEventListener('click', (e) => {
        const trackId = card.dataset.track;
        this.currentTrack = trackId;
        trackBtns.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        if (this.onChangeTrack) {
          this.onChangeTrack(this.currentTrack, this.currentWeather);
        }
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
