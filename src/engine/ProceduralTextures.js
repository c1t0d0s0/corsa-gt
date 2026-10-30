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
      // Mottled between lush and sun-dried, with bright blade tips speckled through
      const v = 0.62 + n * 0.5 + (g - 0.5) * 0.36;
      const dry = Math.max(0, n - 0.55) * 1.6;
      const tip = g > 0.93 ? 1.25 : 1;
      return [(58 + dry * 40) * v * tip, (104 + dry * 8) * v * tip, (40 + dry * 4) * v];
    }
  });
}

export function dirtTextures() {
  return surfaceSet('dirt', 512, {
    cells: 7, octaves: 5, grain: 0.45, bump: 3.2, seed: 29,
    shade: (n, g) => {
      const v = 0.7 + n * 0.45 + (g - 0.5) * 0.3;
      const pebble = g > 0.97 ? 1.35 : 1;
      return [118 * v * pebble, 96 * v * pebble, 72 * v * pebble];
    }
  });
}

/** Grey crag for hillsides: craggy noise with dark cracks. */
export function stoneTextures() {
  return surfaceSet('stone', 512, {
    cells: 6, octaves: 6, grain: 0.15, bump: 5.0, seed: 43,
    shade: (n, g) => {
      const crack = Math.abs(n - 0.5) < 0.018 ? 0.5 : 1;
      const v = (0.4 + n * 0.75 + (g - 0.5) * 0.14) * crack;
      // Lichen greens the darker hollows
      const moss = Math.max(0, 0.45 - n) * 1.4;
      return [(112 - moss * 30) * v, (108 + moss * 6) * v, (96 - moss * 30) * v];
    }
  });
}

/** Rippled water: only the normal map is used. */
export function waterTextures() {
  return surfaceSet('water', 256, {
    cells: 8, octaves: 3, grain: 0, bump: 7, seed: 83,
    shade: () => [255, 255, 255]
  });
}

/** Vertically streaked bark; v runs up the trunk. */
export function barkTextures() {
  return surfaceSet('bark', 256, {
    cells: 4, octaves: 4, grain: 0.25, bump: 4.5, seed: 71,
    shade: (n, g, x, y) => {
      // Nine furrows around the trunk, wandering with the noise; still tiles
      const ridge = 0.5 + 0.5 * Math.sin(x * (Math.PI * 2 * 9 / 256) + n * 9);
      const v = (0.5 + n * 0.5 + (g - 0.5) * 0.15) * (0.6 + ridge * 0.5);
      return [92 * v, 76 * v, 62 * v];
    }
  });
}

/**
 * Alpha-cut foliage cards. `kind`:
 *  - 'leaf'   a round spray of broad leaves on twigs (broadleaf crowns)
 *  - 'needle' a tapering conifer bough; u runs from trunk (0) to tip (1)
 *  - 'scrub'  sparse little leaves on wiry twigs (desert bushes)
 *  - 'grass'  a tuft of blades growing from the bottom edge
 * Painted in light, slightly desaturated tones so instance colours can tint them.
 */
export function foliageTexture(kind) {
  const key = `foliage-${kind}`;
  if (cache.has(key)) return cache.get(key);
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rand = mulberry32({ leaf: 101, needle: 103, scrub: 107, grass: 109 }[kind]);
  const tone = (l, a = 1) => {
    const k = l * (0.75 + rand() * 0.5);
    return `rgba(${Math.min(255, 150 * k) | 0},${Math.min(255, 205 * k) | 0},${Math.min(255, 120 * k) | 0},${a})`;
  };
  const twig = (x0, y0, x1, y1, w) => {
    ctx.strokeStyle = kind === 'scrub' ? 'rgb(150,140,118)' : 'rgb(74,58,44)';
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2 + (rand() - 0.5) * 20, (y0 + y1) / 2 + (rand() - 0.5) * 20, x1, y1);
    ctx.stroke();
  };
  const leaf = (x, y, len, wid, ang, l) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = tone(l);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -wid, len, 0);
    ctx.quadraticCurveTo(len * 0.5, wid, 0, 0);
    ctx.fill();
    // Midrib catches the light
    ctx.strokeStyle = 'rgba(255,255,230,0.25)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  };

  if (kind === 'leaf' || kind === 'scrub') {
    const scrub = kind === 'scrub';
    const cx = size / 2;
    const cy = size / 2;
    // Twigs radiate from the centre; leaves cluster along and around them
    const tips = [];
    const twigs = scrub ? 14 : 9;
    for (let i = 0; i < twigs; i++) {
      const a = (i / twigs) * Math.PI * 2 + rand() * 0.5;
      const r = size * (0.3 + rand() * 0.16);
      tips.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      twig(cx, cy, tips[i][0], tips[i][1], scrub ? 2.2 : 3);
    }
    const count = scrub ? 700 : 520;
    for (let i = 0; i < count; i++) {
      const t = tips[Math.floor(rand() * tips.length)];
      const f = Math.sqrt(rand());
      const x = cx + (t[0] - cx) * f + (rand() - 0.5) * 34;
      const y = cy + (t[1] - cy) * f + (rand() - 0.5) * 34;
      // Shade deeper towards the middle so the card has some volume
      const edge = Math.hypot(x - cx, y - cy) / (size * 0.45);
      const len = scrub ? 6 + rand() * 6 : 11 + rand() * 9;
      leaf(x, y, len, len * (scrub ? 0.28 : 0.42), rand() * Math.PI * 2, 0.62 + edge * 0.5);
    }
  } else if (kind === 'needle') {
    // Bough along +u with side shoots; outline tapers to the tip
    const mid = size / 2;
    twig(0, mid, size * 0.97, mid, 3.5);
    for (let i = 0; i < 1600; i++) {
      const u = rand();
      const reach = (1 - u) * 0.85 + 0.15;
      const side = rand() < 0.5 ? -1 : 1;
      const x = u * size * 0.95;
      const y = mid + side * rand() * reach * size * 0.42;
      const ang = side * (0.5 + rand() * 0.5);
      ctx.strokeStyle = tone(0.38 + rand() * 0.4);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
      ctx.stroke();
    }
    for (let i = 0; i < 7; i++) {
      const u = 0.12 + i * 0.12;
      for (const side of [-1, 1]) {
        twig(u * size, mid, (u + 0.12) * size, mid + side * (1 - u) * size * 0.36, 1.6);
      }
    }
  } else if (kind === 'grass') {
    for (let i = 0; i < 150; i++) {
      const x0 = size * (0.12 + rand() * 0.76);
      const h = size * (0.45 + rand() * 0.53);
      const lean = (rand() - 0.5) * size * 0.4;
      const w = 2 + rand() * 3.5;
      ctx.fillStyle = tone(0.5 + rand() * 0.55);
      ctx.beginPath();
      ctx.moveTo(x0 - w, size);
      ctx.quadraticCurveTo(x0 + lean * 0.3, size - h * 0.6, x0 + lean, size - h);
      ctx.quadraticCurveTo(x0 + lean * 0.3 + w * 0.4, size - h * 0.6, x0 + w, size);
      ctx.fill();
    }
  }
  const tex = finish(c, { repeat: false });
  cache.set(key, tex);
  return tex;
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

/**
 * Soft shadow for directly under a car: dark across the whole footprint and
 * darkest where the tyres meet the road, fading out just past the bodywork.
 * Sizes are metres; the texture spans `plane` and the body covers `body`.
 * Canvas top is the rear of the car (the plane is laid flat with -Z up).
 */
export function contactShadowTexture({ plane, body, wheels }) {
  const key = `contact:${plane}:${body}:${wheels.map((w) => w.join(',')).join(';')}`;
  if (cache.has(key)) return cache.get(key);
  const W = 128;
  const H = Math.round((W * plane[1]) / plane[0]);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const hx = body[0] / 2;
  const hz = body[1] / 2;
  const r = Math.min(hx, hz) * 0.55; // corner rounding, metres
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = ((px + 0.5) / W - 0.5) * plane[0];
      const z = (0.5 - (py + 0.5) / H) * plane[1]; // + towards the front
      // Signed distance to the rounded footprint (negative inside)
      const qx = Math.abs(x) - (hx - r);
      const qz = Math.abs(z) - (hz - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
      // Fully dark right out to the bodywork, then a soft falloff on the open road beyond it
      let a = 0.92 * (1 - smooth(-0.08, 0.48, d));
      for (const [wx, wz] of wheels) {
        const e = Math.hypot((Math.abs(x) - wx) / 0.2, (z - wz) / 0.32);
        a = Math.max(a, 1 - smooth(0.4, 1.2, e));
      }
      const i = (py * W + px) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finish(c, { repeat: false });
  cache.set(key, tex);
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
