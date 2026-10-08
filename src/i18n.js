/**
 * UI language: Japanese for Japanese browsers, English for everyone else.
 * `?lang=ja` / `?lang=en` overrides the browser setting.
 *
 * Markup opts in with data-i18n (content, may contain markup),
 * data-i18n-title and data-i18n-aria.
 */
const STRINGS = {
  en: {
    'start.button': 'ENGINE START',
    'title.tagline': '3D GT racing, right in your browser',
    'key.throttle': 'Throttle',
    'key.brake': 'Brake, reverse',
    'key.steer': 'Steer',
    'key.handbrake': 'Handbrake',
    'key.gearbox': 'Auto / manual',
    'key.shift': 'Shift up / down',
    'key.camera': 'Camera',
    'key.recover': 'Back on track',
    'key.pause': 'Pause',
    'key.garage': 'Garage',
    'key.telemetry': 'Telemetry',
    'touch.steer': 'Slide to steer',
    'touch.landscape': 'Hold in landscape',
    'rotate.prompt': 'Rotate your device to landscape',
    'pause.resume': 'Click or press <kbd>P</kbd> to resume',
    'mode.easy': 'Easy mode',
    'mode.normal': 'Normal mode',
    'mode.title': 'Switch driving assists',
    'nav.camera.title': 'Change camera [C]',
    'nav.garage': 'Garage',
    'nav.garage.title': 'Customise the car [G]',
    'nav.track': 'Tracks',
    'nav.track.title': 'Choose a circuit',
    'nav.telemetry': 'Telemetry',
    'nav.telemetry.title': 'Telemetry [T]',
    'nav.audio.title': 'Mute / unmute sound',
    'nav.restart': 'Restart',
    'nav.restart.title': 'Start again from the grid ([R] recovers where you are)',
    'hud.trans.title': 'Transmission [M]',
    'touch.recover.label': 'Recover to track',
    'touch.handbrake.label': 'Handbrake'
  },
  ja: {
    'start.button': 'ENGINE START',
    'title.tagline': 'ブラウザで走る 3D GT レーシング',
    'key.throttle': 'アクセル',
    'key.brake': 'ブレーキ・バック',
    'key.steer': 'ステアリング',
    'key.handbrake': 'ハンドブレーキ',
    'key.gearbox': 'AT / MT 切替',
    'key.shift': 'シフトアップ / ダウン',
    'key.camera': 'カメラ',
    'key.recover': 'コース復帰',
    'key.pause': 'ポーズ',
    'key.garage': 'ガレージ',
    'key.telemetry': 'テレメトリ',
    'touch.steer': 'スライドでステアリング',
    'touch.landscape': '端末を横向きに',
    'rotate.prompt': '端末を横向きにしてください',
    'pause.resume': 'クリックまたは <kbd>P</kbd> で再開',
    'mode.easy': 'かんたんモード',
    'mode.normal': 'ノーマルモード',
    'mode.title': 'アシストモード切替',
    'nav.camera.title': 'カメラ切替 [C]',
    'nav.garage': 'ガレージ',
    'nav.garage.title': '車両カスタマイズ [G]',
    'nav.track': 'コース選択',
    'nav.track.title': 'コース選択',
    'nav.telemetry': 'テレメトリ',
    'nav.telemetry.title': 'テレメトリ [T]',
    'nav.audio.title': 'サウンド ミュート切替',
    'nav.restart': 'リスタート',
    'nav.restart.title': 'スタート地点からやり直す ([R] はその場でコース復帰)',
    'hud.trans.title': 'トランスミッション [M]',
    'touch.recover.label': 'コース復帰',
    'touch.handbrake.label': 'ハンドブレーキ'
  }
};

function detectLanguage() {
  const forced = new URLSearchParams(window.location.search).get('lang');
  if (forced === 'ja' || forced === 'en') return forced;
  const preferred = navigator.language || (navigator.languages && navigator.languages[0]) || 'en';
  return preferred.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export const lang = detectLanguage();

export function t(key) {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}

/** Fill in every marked element under `root` and reveal the page. */
export function applyTranslations(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.documentElement.dataset.i18nReady = '';
}
