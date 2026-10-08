/**
 * Utility functions for 3D vector math, physics calculations, and interpolation.
 */

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function radToDeg(rad) {
  return rad * (180 / Math.PI);
}

export function degToRad(deg) {
  return deg * (Math.PI / 180);
}

export function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return "--:--.--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export function formatDelta(deltaSeconds) {
  if (isNaN(deltaSeconds) || Math.abs(deltaSeconds) > 99) return "+0.00";
  const sign = deltaSeconds > 0 ? "+" : "-";
  const abs = Math.abs(deltaSeconds).toFixed(2);
  return `${sign}${abs}`;
}
