/**
 * Circuit definitions. Control points are [x, y, z] in metres; the car starts
 * at the first point heading towards the second (+Z).
 */
/**
 * Build a closed circuit from straights and arcs, so curvature changes
 * smoothly instead of wherever hand-placed points happen to put it. That
 * matters at speed: a lumpy line that is fine at 150 km/h throws the car
 * about at 300.
 *
 * segments: [length] is a straight, [radius, degrees] an arc (negative
 * degrees turn right). The turns must add up to a full lap and the straights
 * be chosen so the loop meets itself; any small remainder is spread evenly.
 * Corner entries and exits are eased over `ease` metres.
 */
function layout(segments, { spacing = 40, ease = 90 } = {}) {
  const curvature = [];
  for (const seg of segments) {
    if (seg.length === 1) {
      for (let i = 0; i < Math.round(seg[0]); i++) curvature.push(0);
    } else {
      const angle = (seg[1] * Math.PI) / 180;
      const n = Math.round(Math.abs(angle) * seg[0]);
      for (let i = 0; i < n; i++) curvature.push(angle / n);
    }
  }
  const n = curvature.length;
  const half = Math.round(ease / 2);

  // Walk the line a metre at a time, steering by the moving average of the curvature
  const path = [];
  let x = 0;
  let z = 0;
  let heading = 0;
  let sum = 0;
  for (let k = -half; k <= half; k++) sum += curvature[(k + n) % n];
  for (let i = 0; i < n; i++) {
    path.push([x, z]);
    heading += sum / (2 * half + 1);
    x += Math.sin(heading);
    z += Math.cos(heading);
    sum += curvature[(i + half + 1) % n] - curvature[(i - half + n) % n];
  }

  const points = [];
  const count = Math.round(n / spacing);
  for (let j = 0; j < count; j++) {
    const i = Math.round((j * n) / count);
    points.push([path[i][0] - (x * i) / n, 0, path[i][1] - (z * i) / n]);
  }
  return points;
}

export const TRACKS = {
  apex: {
    id: 'apex',
    name: 'APEX CIRCUIT',
    theme: 'apex',
    defaultTod: 'noon',
    halfWidth: 8,
    runoff: 10,
    runoffSurface: 'grass',
    kerbs: true,
    // A power circuit: straights of 1.1 and 1.5 km joined by a fast sweeper, esses and a
    // long final corner that opens out onto the main straight.
    points: layout([
      [700], // start line to the end of the main straight
      [320, -90], // sweeper
      [169],
      [180, 35], [180, -70], [180, 35], // esses
      [170, -115],
      [1500], // back straight
      [160, -65], [280, -90], // final corner, opening out
      [395] // run to the line; with the first segment this is the main straight
    ])
  },
  city: {
    id: 'city',
    name: 'NEO CITY HIGHWAY',
    theme: 'city',
    defaultTod: 'midnight',
    halfWidth: 7.5,
    runoff: 1.2,
    runoffSurface: 'asphalt',
    kerbs: false,
    points: [
      [0, 0, 0], [0, 0, 170], [0, 0, 330], [-45, 0, 395], [-125, 0, 405],
      [-280, 0, 405], [-345, 0, 365], [-355, 0, 285], [-355, 0, 165],
      [-315, 0, 110], [-240, 0, 95], [-200, 0, 50], [-200, 0, -40],
      [-240, 0, -95], [-325, 0, -115], [-360, 0, -175], [-345, 0, -255],
      [-280, 0, -295], [-120, 0, -295], [20, 0, -295], [85, 0, -255],
      [95, 0, -175], [55, 0, -110], [8, 0, -65]
    ]
  },
  desert: {
    id: 'desert',
    name: 'DESERT CANYON',
    theme: 'desert',
    defaultTod: 'sunset',
    halfWidth: 6.5,
    runoff: 7,
    runoffSurface: 'sand',
    kerbs: true,
    points: [
      [0, 0, 0], [0, 2, 180], [-30, 6, 330], [-130, 12, 420], [-260, 10, 400],
      [-330, 4, 300], [-300, -2, 180], [-360, -8, 60], [-320, -10, -70],
      [-200, -6, -130], [-150, 0, -240], [-30, 6, -300], [100, 10, -260],
      [150, 6, -150], [80, 2, -85], [12, 0, -60]
    ]
  }
};

export function getTrackDef(id) {
  return TRACKS[id] || TRACKS.apex;
}
