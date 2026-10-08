/**
 * Circuit definitions. Control points are [x, y, z] in metres; the car starts
 * at the first point heading towards the second (+Z).
 */
export const TRACKS = {
  apex: {
    id: 'apex',
    name: 'APEX CIRCUIT',
    theme: 'apex',
    defaultTod: 'noon',
    halfWidth: 7,
    runoff: 9,
    runoffSurface: 'grass',
    kerbs: true,
    points: [
      [0, 0, 0], [0, 0, 150], [0, 0, 290], [-45, 0, 375], [-135, 0, 395],
      [-215, 0, 345], [-215, 0, 255], [-275, 0, 180], [-265, 0, 85],
      [-185, 0, 25], [-185, 0, -65], [-260, 0, -130], [-270, 0, -230],
      [-190, 0, -295], [-80, 0, -255], [20, 0, -295], [115, 0, -250],
      [130, 0, -150], [55, 0, -105], [5, 0, -60]
    ]
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
