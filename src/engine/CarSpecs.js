/**
 * Everything that makes one car different from another: body shape and
 * styling details, where the onboard cameras sit, how it drives, and how its
 * engine sounds. Car space is +Z forward, +X left, origin on the ground under
 * the centre of gravity; lengths are metres.
 */
export const CAR_SPECS = {
  gt: {
    id: 'gt',
    name: 'CORSA GT',
    body: {
      zf: 2.12,
      zr: -2.08,
      wheelZ: { front: 1.25, rear: -1.35 },
      wheelX: 0.8,
      wheelR: 0.33,
      archR: 0.39,
      halfWidth: 0.915,
      groundClear: 0.17,
      nose: { length: 0.55, taper: 0.3, power: 2.4, rise: 0.1 },
      tail: { length: 0.4, taper: 0.12, rise: 0.14 },
      // [z, height] pairs, front to back
      belt: [[2.12, 0.6], [1.7, 0.75], [1.25, 0.83], [0.95, 0.89], [0.2, 0.93], [-1.0, 0.96], [-1.7, 0.99], [-2.08, 0.94]],
      roof: [[0.3, 1.285], [-0.2, 1.32], [-1.05, 1.265]],
      windshield: [0.95, 0.3],
      backlight: [-1.05, -1.78],
      sideGlass: [0.72, -1.12],
      bPillar: [-0.3, -0.4],
      roofWidth: 0.6,
      shoulderInset: 0.16,
      floatingRoof: false,
      roofColor: null // same as the body
    },
    details: {
      style: 'gt',
      headlightSpot: [0.56, 0.7, -0.2], // x, y, z from the nose
      mirror: [0.99, 1.0, 0.5],
      wing: { deckZ: -1.92, deckY: 0.97, lip: { y: 1.03, z: -1.96, width: 1.5, pitch: -0.3 } },
    },
    cameras: {
      hood: { pos: [0, 1.02, 0.95], look: [0, 0.9, 12] },
      cockpit: { pos: [-0.36, 1.08, -0.12], look: [-0.36, 0.98, 12] },
      dash: { pos: [0, 0.78, 0.7], size: [1.76, 0.2, 0.7] },
      binnacle: [-0.36, 0.88, 0.56],
      wheel: [-0.36, 0.8, 0.36]
    },
    physics: {
      mass: 1300,
      inertia: 1900,
      cgToFront: 1.25,
      cgToRear: 1.35,
      cgHeight: 0.48,
      tyreMu: 1.3,
      dragArea: 0.9,
      liftArea: 1.5,
      brakeG: 1.25,
      driveAxle: 'rear',
      gearRatios: [-3.4, 3.3, 2.2, 1.62, 1.26, 1.03, 0.86], // index 0 is reverse
      finalDrive: 3.7,
      wheelRadius: 0.33,
      maxRpm: 8200,
      idleRpm: 1000
    },
    // Engine tune presets offered in the garage, in horsepower
    tunes: [500, 650, 850],
    tuneNames: ['STOCK SPEC', 'TRACK SPEC', 'HYPER GT'],
    defaultWing: 'gt3',
    audio: { cylinders: 6 }
  },

  piccola: {
    id: 'piccola',
    name: 'CORSA PICCOLA',
    body: {
      zf: 1.9,
      zr: -1.95,
      wheelZ: { front: 1.2, rear: -1.3 },
      wheelX: 0.76,
      wheelR: 0.31,
      archR: 0.37,
      halfWidth: 0.865,
      groundClear: 0.16,
      // Short overhangs with the wheels right out at the corners, and every end rounded off
      nose: { length: 0.45, taper: 0.06, power: 1.7, rise: 0.06, round: 0.26 },
      tail: { length: 0.22, taper: 0.03, rise: 0.06, round: 0.2 },
      belt: [[1.9, 0.76], [1.65, 0.84], [1.3, 0.89], [0.92, 0.92], [0.0, 0.93], [-1.6, 0.94], [-1.95, 0.91]],
      roof: [[0.44, 1.4], [-0.5, 1.43], [-1.52, 1.41]],
      windshield: [0.92, 0.44],
      backlight: [-1.52, -1.78],
      sideGlass: [0.86, -1.54],
      bPillar: [-0.38, -0.48],
      roofWidth: 0.74,
      shoulderInset: 0.15,
      // A soft, pillowy section: swelling flanks, a drawn-in shoulder, a domed roof with rounded edges
      bulge: 0.03,
      tuck: 0.045,
      roofEdge: 0.1,
      crown: 0.05,
      fender: 0.045,
      // Black pillars all round, so the white roof looks like it floats
      floatingRoof: true,
      roofColor: 0xf3f3f1
    },
    details: {
      style: 'piccola',
      headlightSpot: [0.6, 0.74, -0.1],
      mirror: [0.93, 1.06, 0.6],
      wing: { deckZ: -1.8, deckY: 1.0, lip: { y: 1.43, z: -1.62, width: 1.16, pitch: -0.15 } },
    },
    cameras: {
      hood: { pos: [0, 1.16, 0.86], look: [0, 1.02, 12] },
      cockpit: { pos: [-0.34, 1.22, -0.3], look: [-0.34, 1.12, 12] },
      dash: { pos: [0, 0.9, 0.56], size: [1.64, 0.2, 0.5] },
      binnacle: [-0.34, 1.0, 0.42],
      wheel: [-0.34, 0.93, 0.2]
    },
    physics: {
      mass: 1180,
      inertia: 1500,
      cgToFront: 1.0,
      cgToRear: 1.5,
      cgHeight: 0.5,
      tyreMu: 1.26,
      dragArea: 0.72,
      liftArea: 0.5,
      brakeG: 1.18,
      driveAxle: 'front',
      gearRatios: [-3.5, 3.6, 2.4, 1.78, 1.38, 1.12, 0.93],
      finalDrive: 4.1,
      wheelRadius: 0.31,
      maxRpm: 7600,
      idleRpm: 950
    },
    tunes: [190, 240, 320],
    tuneNames: ['STOCK SPEC', 'SPORT SPEC', 'RALLY SPEC'],
    defaultWing: 'stealth', // a roof spoiler suits it; the big wings stay available
    audio: { cylinders: 4 }
  }
};

export function getCarSpec(id) {
  return CAR_SPECS[id] || CAR_SPECS.gt;
}
