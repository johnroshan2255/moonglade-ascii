// HOLLOW WICK: story data and map layout (single source of truth).
// Coordinates: x = east, z = south (spawn is in the south, the shrine is north-west).

export const TITLE = 'HOLLOW WICK';

export const LAYOUT = {
  waterY: 0,
  pond: { x: 12, z: 4, r: 11 },
  shrine: { x: -24, z: -44 }, // plaza centre (altar)
  spawn: { x: -4, z: 52, yaw: 0.0 },
  playRadius: 64,

  // walls that split the glade into regions (bramble + deadfall). The gaps are the puzzles.
  wallA: { z: 22, gateX: -5, gateHalf: 1.7 }, // south meadow | lake  (chime gate)
  wallB: { z: 4, westEnd: 4, eastStart: 20 }, // lake | central forest (deep water between: causeway)
  wallC: { z: -22, archX: 10, archHalf: 2.4 }, // central forest | north woods (pressure-plate arch)

  southMeadow: { x: -11, z: 34, r: 12 },
  westMeadow: { x: -30, z: -6, r: 9 },
  chimes: [ // left -> right as you face the gate; pitch rank 1 = lowest
    { x: -10.5, z: 25.6, rank: 2 },
    { x: -8.2, z: 25.0, rank: 3 },
    { x: -1.8, z: 25.0, rank: 1 },
  ],
  valveAngles: [0.45, Math.PI - 0.45], // east-south-east and west-south-west shallows
  causeway: { x: 12, z0: 15.5, z1: -7.5, half: 1.05 },
  plates: [{ x: 3.5, z: -16.5 }, { x: 16.5, z: -16.5 }],
  ironChime: { x: 31, z: -44 },
  bell: { dx: 6.4, dz: -7.2 }, // offset from shrine centre (east side, fallen bronze bell)
  exitGate: { x: -33.5, z: -53.5, rot: Math.PI / 4 }, // north-west rim
  beacons: [[-3, -3], [3, -3], [-3, 3], [3, 3]], // offsets from the altar

  checkpoints: [
    { x: -4, z: 50, yaw: 0.0 },
    { x: -6, z: 42, yaw: 0.2 }, // meadow edge
    { x: -4, z: 18.5, yaw: 0.5 },
    { x: 12, z: -9.5, yaw: 0.0 },
    { x: 10, z: -26, yaw: -0.6 },
    { x: -11.5, z: -42, yaw: -1.5 },
  ],
};

const S = LAYOUT.shrine;
LAYOUT.bell.x = S.x + LAYOUT.bell.dx;
LAYOUT.bell.z = S.z + LAYOUT.bell.dz;
LAYOUT.archEntrance = { x: S.x + 12, z: S.z + 1.5 }; // the crooked archway into the plaza

// dirt trails (terrain colour, tree clearance)
export const PATHS = [
  [[-4, 58], [-5, 46], [-9, 36], [-7, 28], [-5, 22], [1, 18], [8, 16], [12, 15.5]],
  [[12, -7.5], [12, -11], [10, -17], [10, -24], [18, -30], [27, -38], [18, -45], [2, -47], [-10, -44], [-24, -44]],
  [[-24, -44], [-33.5, -53.5]],
];

/** Which region a point is in (walls keep the player inside one at a time). */
export function regionOf(x, z) {
  if (z > LAYOUT.wallA.z) return 'south';
  if (z > LAYOUT.wallB.z) return 'lake';
  if (z > LAYOUT.wallC.z) return 'central';
  return 'north';
}

// The 12 lights. kind: 'spark' refuels the lantern, 'core' powers a shrine beacon, 'heart' = final spark.
// reveal: an item only appears once its condition is met (e.g. a lake valve has been turned).
export const ITEMS = [
  { id: 1, kind: 'spark', x: -5.5, z: 44, text: 'It is cold in the fog. Keep the ember alive.' },
  { id: 2, kind: 'core', x: -13, z: 28, text: 'One heavy ember. Three more to open the gate.' },
  { id: 3, kind: 'spark', x: 2.5, z: 17.5, text: 'Close your lantern shutter before stepping in the water.' },
  { id: 4, kind: 'core', at: 'valve0', reveal: 'valve0', text: 'Something huge is watching from beneath the ripples.' },
  { id: 5, kind: 'spark', at: 'valve1', reveal: 'valve1', text: "Don't look down at your reflection." },
  { id: 6, kind: 'spark', x: -3, z: -9, text: 'Strike stone with your iron staff to throw a sound.' },
  { id: 7, kind: 'spark', x: -30, z: -6, text: "They aren't monsters. They're trying to put you out." },
  { id: 8, kind: 'core', x: 10, z: -25.5, text: 'The fog is thinning. Harsh white light breaks through.' },
  { id: 9, kind: 'spark', x: 50, z: -30, text: 'Beyond the trees lies a scorched white desert.' },
  { id: 10, kind: 'spark', x: 29, z: -46.5, text: 'The tall one at the shrine hunts by sound alone.' },
  { id: 11, kind: 'core', x: S.x - 10.5, z: S.z + 4.5, text: 'All four embers. Light the beacons to raise the gate.' },
  { id: 12, kind: 'heart', x: S.x, z: S.z, onAltar: true, text: 'Open the gate, or let the dark keep you.' },
];

// Old standing stones with a paper tied to them: walk up to one and the note unfolds.
// Each sits beside a trail just before the puzzle it explains. `art` is an optional ASCII sketch.
export const STONES = [
  {
    id: 'chimes', x: -3.5, z: 41, title: 'The Three Chimes',
    body: [
      'Three brass chimes lock the meadow gate. Each post bears notches cut by an old hand: one, two, three.',
      'Strike them in that order. One notch, then two, then three. Low to high.',
      'The grey hounds in the grass hunt only what moves. When one growls, stand still until it leaves.',
    ],
  },
  {
    id: 'valves', x: -0.8, z: 17.2, title: 'The Drowned Valves',
    body: [
      'Two iron wheels stand in the shallows: one to the east, one to the west. Hold the staff on each to turn it.',
      'She who sleeps below wakes to light, to grinding iron, and to eyes that stare at the water.',
      'Shutter the lantern before you wade. Crank a little, then be still and let the ripples calm. Then crank again.',
      'When both wheels have turned, the old stones rise and make a road across.',
    ],
  },
  {
    id: 'arch', x: 14.5, z: -9.5, title: 'The Arch of Two Shadows',
    body: [
      'The iron arch to the north will not open for a living hand. It lifts only while BOTH stone plates before it carry weight, and the only weight in this wood belongs to the tall ones.',
      '1. Stand well back from a plate, lantern shuttered.',
      '2. Strike the iron sign on the plate\'s post with your staff. You can strike it from far away. A tall one walks to the sound and waits on the plate.',
      '3. Call the second one to the other plate the same way.',
      '4. While both stand, the arch rises. Keep your light hidden and walk between them, softly.',
    ],
    art: String.raw`
          ___________
         |  | ARCH|  |
         |  |_____|  |
            /     \
      [#]--'       '--[#]
     plate         plate
       ^             ^
   strike the    strike the
     iron          iron`,
  },
  {
    id: 'plates', x: 7.5, z: -13, title: 'Scratched Beneath',
    body: [
      'Someone has scratched more under the first note, in a shaking hand:',
      'They do not wait forever. Twenty heartbeats, perhaps. Call the second one quickly. If one wanders off, call her back.',
      'If no one comes, she may have drifted too far. Strike the iron again, or throw a sound at a stone nearer to her to walk her closer first.',
      'If she sees your flame, she leaves the plate and comes for you. Hold the shutter until she gives up.',
    ],
  },
  {
    id: 'moths', x: -24, z: -7, title: 'On Moths, and the Tall Ones',
    body: [
      'Pale moths drift through this wood. One will settle on your lantern and drink the flame blue.',
      'Shake it off: run, or hold the shutter a moment and let it go in a burst of heat.',
      'The tall ones are not monsters. Each cradles a small spark of its own. They only want your light put out.',
      'Some say that a pilgrim carrying three embers, who shuttered the light and stood beside one without moving, long enough, saw her kneel.',
    ],
  },
  {
    id: 'north', x: 13, z: -28.5, title: 'Where the Fog Thins',
    body: [
      'The fog is thinner here. Where pale shafts of white light stab down, do not stand. They burn the ember.',
      'Four embers light the shrine: one in the meadow, one the lake gives up when a valve turns, one here past the arch, and one at the shrine itself.',
      'The last hides behind the broken pillar on the shrine\'s west side.',
      'The shrine lies west of here, along the trail.',
    ],
  },
  {
    id: 'warden', x: -4, z: -47.6, title: 'The Bell-Warden',
    body: [
      'A bell-headed thing guards the shrine. It is blind and hunts by sound alone.',
      'Sneak (hold C, or tilt the stick lightly) and it will not hear your steps.',
      'A fallen bronze bell lies on the east side of the shrine. Strike it and the Warden goes to it, leaving the lanterns unguarded.',
      'Set an ember in each of the four stone lanterns around the altar. When all four burn, the north-west gate rises, and the Warden will come. RUN for the gate.',
    ],
  },
];

// Monster homes.
export const SPAWNS = {
  hounds: [{ x: -14, z: 36 }, { x: -6, z: 30 }],
  veils: [
    { x: -6, z: -12, region: 'central' },
    { x: 24, z: -10, region: 'central' },
    { x: 34, z: -36, region: 'north', mercy: true },
  ],
  moths: [
    { x: 2, z: -4, group: 'central' }, { x: 20, z: -14, group: 'central' }, { x: -12, z: -16, group: 'central' },
    { x: 24, z: -34, group: 'north' }, { x: 34, z: -40, group: 'north' }, { x: 14, z: -44, group: 'north' },
  ],
  sunbeamsNorth: [[21, -33], [30, -42], [9, -46], [38, -30], [-2, -48]],
};

export const LINES = {
  start: 'Find the four embers. Open the north gate.',
  tools: 'Hold SHUTTER to hide your light. Tap STAFF to strike.',
  toolsKeys: 'Hold Space to shutter the lantern. E / click to strike with the staff.',
  freeze: 'Something moves in the grass. Stand still.',
  chimeWrong: 'The chimes clatter. Wrong order.',
  chimeGate: 'The meadow gate drops.',
  waterWarn: 'Stop. Shutter the light. Look away from the water.',
  valveTurned: 'The valve groans open.',
  causeway: 'Old stones rise from the lake.',
  plateHint: 'Two plates. Two heavy shadows.',
  archOpen: 'The arch lifts while they stand on the stones.',
  mothShock: 'The heat-sight shakes it loose.',
  sunbeam: 'The white light burns.',
  warden: 'Something tolls at the shrine. Walk softly.',
  placeCore: 'The ember settles into the stone lantern.',
  beacons: 'The beacons roar. The gate is rising. RUN.',
  snuffed: 'The ember went out.',
  endA: 'You escaped the dark. Nothing else survived the light.',
  endB: 'The dark is cool. Rest now.',
};
