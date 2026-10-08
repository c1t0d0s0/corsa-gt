import * as THREE from 'three';

/** Deterministic PRNG so scenery and textures look the same every load. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise; `period` is the lattice size it wraps at. */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (n) => ((n % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in 0..1. Non-tiling when `period` is large. */
export function fbm(x, y, octaves = 4, seed = 1, period = 1 << 20) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, period, seed + o * 17) * amp;
    norm += amp;
    x *= 2;
    y *= 2;
    period *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

const cache = new Map();

function finish(canvas, { srgb = true, repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Build a tiling colour map and matching normal map from a height function.
 * `shade(height, grain, x, y)` returns [r, g, b] in 0..255.
 */
function surfaceSet(key, size, { cells, octaves, grain, bump, shade, seed }) {
  if (cache.has(key)) return cache.get(key);
  const rand = mulberry32(seed);
  const height = new Float32Array(size * size);
  const color = document.createElement('canvas');
  color.width = color.height = size;
  const cctx = color.getContext('2d');
  const cimg = cctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * cells, (y / size) * cells, octaves, seed, cells);
      const g = rand();
      const hgt = n * (1 - grain) + g * grain;
      height[y * size + x] = hgt;
      const [r, gg, b] = shade(n, g, x, y);
      const i = (y * size + x) * 4;
      cimg.data[i] = r;
      cimg.data[i + 1] = gg;
      cimg.data[i + 2] = b;
      cimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);

  const normal = document.createElement('canvas');
  normal.width = normal.height = size;
  const nctx = normal.getContext('2d');
  const nimg = nctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * bump;
      const dy = (at(x, y + 1) - at(x, y - 1)) * bump;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const set = { map: finish(color), normalMap: finish(normal, { srgb: false }) };
  cache.set(key, set);
  return set;
}

export function asphaltTextures() {
  return surfaceSet('asphalt', 512, {
    cells: 6, octaves: 4, grain: 0.55, bump: 2.2, seed: 11,
    shade: (n, g) => {
      const v = 72 + n * 26 + (g - 0.5) * 30 + (g > 0.965 ? 40 : 0);
      return [v, v, v * 1.03];
    }
  });
}

export function grassTextures() {
  return surfaceSet('grass', 512, {
    cells: 8, octaves: 4, grain: 0.5, bump: 2.5, seed: 23,
    shade: (n, g) => {
      const v = 0.62 + n * 0.5 + (g - 0.5) * 0.36;
      return [58 * v, 104 * v, 40 * v];
    }
  });
}

export function sandTextures() {
  return surfaceSet('sand', 512, {
    cells: 6, octaves: 5, grain: 0.3, bump: 3.0, seed: 37,
    shade: (n, g) => {
      const v = 0.78 + n * 0.34 + (g - 0.5) * 0.14;
      return [196 * v, 150 * v, 104 * v];
    }
  });
}

export function concreteTextures() {
  return surfaceSet('concrete', 256, {
    cells: 5, octaves: 4, grain: 0.35, bump: 1.4, seed: 51,
    shade: (n, g) => {
      const v = 128 + n * 46 + (g - 0.5) * 24;
      return [v, v, v * 0.98];
    }
  });
}

export function rockTextures() {
  return surfaceSet('rock', 512, {
    cells: 5, octaves: 5, grain: 0.2, bump: 4.0, seed: 67,
    shade: (n, g, x, y) => {
      // Horizontal strata give the canyon walls their layered look
      const band = 0.5 + 0.5 * Math.sin(y * 0.11 + n * 5);
      const v = 0.7 + n * 0.4 + (g - 0.5) * 0.1;
      return [(168 + band * 40) * v, (96 + band * 30) * v, (62 + band * 18) * v];
    }
  });
}

/** Red/white kerb stripes, tiled along the track. */
export function kerbTexture() {
  if (cache.has('kerb')) return cache.get('kerb');
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d42a2a';
  ctx.fillRect(0, 0, 8, 32);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 32, 8, 32);
  const tex = finish(c);
  cache.set('kerb', tex);
  return tex;
}

/** Office-tower facade: colour map plus an emissive map of lit windows. */
export function buildingTextures() {
  if (cache.has('building')) return cache.get('building');
  const rand = mulberry32(91);
  const cols = 8;
  const rows = 16;
  const cell = 32;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = cols * cell;
    c.height = rows * cell;
    return c;
  };
  const color = make();
  const glow = make();
  const cc = color.getContext('2d');
  const gc = glow.getContext('2d');
  cc.fillStyle = '#20232b';
  cc.fillRect(0, 0, color.width, color.height);
  gc.fillStyle = '#000';
  gc.fillRect(0, 0, glow.width, glow.height);
  const warm = ['#ffd9a0', '#ffe9c4', '#fff4e0', '#bfe3ff', '#9fd0ff'];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * cell + 5;
      const py = y * cell + 6;
      const w = cell - 10;
      const h = cell - 13;
      cc.fillStyle = rand() > 0.5 ? '#2c3442' : '#333c4c';
      cc.fillRect(px, py, w, h);
      if (rand() > 0.58) {
        gc.globalAlpha = 0.35 + rand() * 0.65;
        gc.fillStyle = warm[Math.floor(rand() * warm.length)];
        gc.fillRect(px, py, w, h);
      }
    }
  }
  const set = { map: finish(color), emissiveMap: finish(glow) };
  cache.set('building', set);
  return set;
}

/** Soft radial falloff used for particles, light pools and contact shadows. */
export function radialTexture() {
  if (cache.has('radial')) return cache.get('radial');
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = finish(c, { repeat: false });
  cache.set('radial', tex);
  return tex;
}

/** Trackside advertising board with a few fictional sponsors. */
export function bannerTexture(index) {
  const key = `banner${index}`;
  if (cache.has(key)) return cache.get(key);
  const designs = [
    ['CORSA GT', '#c81e1e', '#ffffff'],
    ['APEX OIL', '#f5c400', '#151515'],
    ['VELOCE', '#0e5fd8', '#ffffff'],
    ['TURBO+', '#111111', '#35e0c2'],
    ['MONZA TYRES', '#f2f2f2', '#c81e1e']
  ];
  const [text, bg, fg] = designs[index % designs.length];
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = fg;
  ctx.font = 'italic 900 58px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 52);
  const tex = finish(c);
  cache.set(key, tex);
  return tex;
}

/** Start/finish chequered strip. */
export function checkerTexture() {
  if (cache.has('checker')) return cache.get('checker');
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillRect(8, 8, 8, 8);
  const tex = finish(c);
  tex.magFilter = THREE.NearestFilter;
  cache.set('checker', tex);
  return tex;
}
