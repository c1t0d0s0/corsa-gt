import { mulberry32 } from '../ProceduralTextures.js';

/**
 * Landscapes of the endless road. Every field is a number so two biomes can be
 * blended across their border; the road generator, the terrain and the
 * scenery all read the blended values, which is what makes the scenery change
 * gradually instead of switching at a line.
 *
 * Terrain:   base/amp/scale  height (m) and size of the rolling ground the road runs over;
 *            relief/sharp    hills or peaks rising away from the road (m), and how ridged they are
 * Road:      grade           steepest climb; straightP/straight/radius/turn shape the bends
 * Plants:    trees (density), bushes, tufts, cacti, rocks
 * Climate:   cold            0 warm … 1 cold; with altitude it decides conifers over broadleaf trees
 * Ground:    grass/dirt/sand/rock  splat weights; dry turns the grass to straw
 * Water:     river, sea      1 where the road runs beside a river / the sea
 * Air:       haze, warm      fog density multiplier; fog tinted towards dust (+) or sea blue (-)
 */
export const BIOMES = {
  forest: {
    haze: 1.1, warm: 0, relief: 45, sharp: 0.2, base: 40, amp: 22, scale: 520, grade: 0.07,
    straightP: 0.3, straight: [60, 260], radius: [110, 320], turn: [25, 80],
    trees: 1, cold: 0.35, bushes: 0.7, tufts: 0.35, cacti: 0, rocks: 0.08,
    grass: 1, dirt: 0.35, sand: 0, rock: 0.05, dry: 0.05, river: 0, sea: 0
  },
  riverside: {
    haze: 1.15, warm: -0.2, relief: 55, sharp: 0.2, base: 26, amp: 8, scale: 600, grade: 0.04,
    straightP: 0.25, straight: [60, 200], radius: [140, 360], turn: [20, 70],
    trees: 0.75, cold: 0.3, bushes: 0.8, tufts: 0.7, cacti: 0, rocks: 0.15,
    grass: 1, dirt: 0.3, sand: 0.1, rock: 0.05, dry: 0, river: 1, sea: 0
  },
  meadow: {
    haze: 1, warm: 0, relief: 30, sharp: 0, base: 30, amp: 24, scale: 760, grade: 0.07,
    straightP: 0.45, straight: [120, 520], radius: [260, 720], turn: [15, 60],
    trees: 0.06, cold: 0.25, bushes: 0.15, tufts: 1, cacti: 0, rocks: 0.05,
    grass: 1, dirt: 0.15, sand: 0, rock: 0.02, dry: 0.15, river: 0, sea: 0
  },
  coast: {
    haze: 0.85, warm: -0.6, relief: 25, sharp: 0, base: 9, amp: 5, scale: 420, grade: 0.06,
    straightP: 0.35, straight: [80, 320], radius: [160, 460], turn: [20, 70],
    trees: 0.03, cold: 0.1, bushes: 0.25, tufts: 0.5, cacti: 0, rocks: 0.2,
    grass: 1, dirt: 0.1, sand: 0.3, rock: 0.15, dry: 0.3, river: 0, sea: 1
  },
  steppe: {
    haze: 1.25, warm: 0.5, relief: 35, sharp: 0.1, base: 45, amp: 30, scale: 820, grade: 0.07,
    straightP: 0.5, straight: [150, 600], radius: [260, 800], turn: [15, 55],
    trees: 0.01, cold: 0.15, bushes: 0.45, tufts: 0.8, cacti: 0.02, rocks: 0.2,
    grass: 0.8, dirt: 0.5, sand: 0.3, rock: 0.1, dry: 1, river: 0, sea: 0
  },
  desert: {
    haze: 1.6, warm: 1, relief: 80, sharp: 0.7, base: 50, amp: 42, scale: 620, grade: 0.07,
    straightP: 0.5, straight: [150, 700], radius: [220, 700], turn: [15, 60],
    trees: 0, cold: 0, bushes: 0.25, tufts: 0.15, cacti: 0.45, rocks: 0.5,
    grass: 0, dirt: 0.25, sand: 1, rock: 0.35, dry: 1, river: 0, sea: 0
  },
  mountain: {
    haze: 0.9, warm: -0.2, relief: 340, sharp: 1, base: 120, amp: 110, scale: 900, grade: 0.1,
    straightP: 0.15, straight: [40, 160], radius: [62, 170], turn: [40, 120],
    trees: 0.35, cold: 0.85, bushes: 0.3, tufts: 0.4, cacti: 0, rocks: 0.4,
    grass: 0.8, dirt: 0.2, sand: 0, rock: 0.55, dry: 0.1, river: 0, sea: 0
  }
};

export const BIOME_IDS = Object.keys(BIOMES);

/**
 * Which landscapes may border each other. Anything else would be an abrupt
 * jump (forest straight into desert), so the schedule only walks this graph:
 * from the forest you reach the desert by way of meadow and dry steppe.
 */
export const NEIGHBOURS = {
  forest: ['riverside', 'mountain'],
  riverside: ['forest', 'meadow'],
  meadow: ['riverside', 'mountain', 'coast', 'steppe'],
  mountain: ['forest', 'meadow'],
  coast: ['meadow', 'steppe'],
  steppe: ['meadow', 'desert', 'coast'],
  desert: ['steppe']
};

const NUMERIC = Object.keys(BIOMES.forest).filter((k) => typeof BIOMES.forest[k] === 'number');
const RANGES = ['straight', 'radius', 'turn'];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The sequence of landscapes along the road, by distance travelled. Each
 * stretch is 2–6 km and fades into the next over 600–1200 m centred on the
 * border. Generated lazily and deterministically from the seed.
 */
export class BiomeSchedule {
  constructor(seed) {
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    const first = BIOME_IDS[Math.floor(this.rand() * BIOME_IDS.length)];
    this.segments = [this.makeSegment(first, 0, null)];
  }

  makeSegment(biome, start, prev) {
    const length = 2000 + this.rand() * 4000;
    return {
      biome,
      start,
      end: start + length,
      blend: 600 + this.rand() * 600, // fade-in width at `start`
      side: this.rand() < 0.5 ? -1 : 1, // which side the river / sea is on
      prev
    };
  }

  ensure(s) {
    let last = this.segments[this.segments.length - 1];
    while (last.end < s + 2000) {
      const options = NEIGHBOURS[last.biome];
      const next = options[Math.floor(this.rand() * options.length)];
      last = this.makeSegment(next, last.end, last.biome);
      this.segments.push(last);
    }
  }

  /** Index of the stretch containing distance `s` (binary search). */
  indexAt(s) {
    this.ensure(s);
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Stretches and weights in effect at `s`: one, or two while fading. */
  weightsAt(s) {
    const i = this.indexAt(s);
    const seg = this.segments[i];
    const next = this.segments[i + 1];
    if (i > 0 && s - seg.start < seg.blend / 2) {
      const w = smoothstep(-seg.blend / 2, seg.blend / 2, s - seg.start);
      return [[this.segments[i - 1], 1 - w], [seg, w]];
    }
    if (next && next.start - s < next.blend / 2) {
      const w = smoothstep(-next.blend / 2, next.blend / 2, s - next.start);
      return [[seg, 1 - w], [next, w]];
    }
    return [[seg, 1]];
  }

  /** Blended parameters at `s`, written into `out` (reused to avoid garbage). */
  paramsAt(s, out = {}) {
    const parts = this.weightsAt(s);
    for (const k of NUMERIC) out[k] = 0;
    for (const k of RANGES) out[k] = [0, 0];
    out.riverSide = 1;
    out.seaSide = 1;
    let dominant = parts[0];
    for (const [seg, w] of parts) {
      const b = BIOMES[seg.biome];
      for (const k of NUMERIC) out[k] += b[k] * w;
      for (const k of RANGES) { out[k][0] += b[k][0] * w; out[k][1] += b[k][1] * w; }
      if (b.river) out.riverSide = seg.side;
      if (b.sea) out.seaSide = seg.side;
      if (w > dominant[1]) dominant = [seg, w];
    }
    out.biome = dominant[0].biome;
    return out;
  }
}

/** Seed text (any string; numbers too) → uint32, FNV-1a. */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A short, typeable random seed. */
export function randomSeed() {
  const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'heath', 'isle', 'juniper', 'kelp', 'lark', 'mesa', 'north', 'oak', 'pine', 'quartz', 'ridge', 'sage', 'tide', 'vale', 'willow'];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(Math.random() * 9000 + 1000)}`;
}
