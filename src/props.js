// Interactive story props. Each returns entities + small animation handles; gameplay.js drives them.
import * as pc from 'playcanvas';
import { CLS, worldMaterial } from './shaders.js';
import { MeshBuilder, rgba, addBox, addCylinder, addSphere, emberCoreMesh } from './meshes.js';
import { LAYOUT } from './story.js';
import { WORLD, SHRINE_Y } from './world.js';
import { mulberry32 } from './noise.js';

const wood = (v = 0) => rgba(0.16 + v, 0.13 + v, 0.1 + v, CLS.GROUND);
const stone = (v = 0) => rgba(0.28 + v, 0.28 + v, 0.29 + v, CLS.STONE);
const iron = (v = 0) => rgba(0.17 + v, 0.17 + v, 0.18 + v, CLS.STONE);
const brass = (v = 0) => rgba(0.55 + v, 0.42 + v, 0.2 + v, CLS.STONE);

export class Props {
  constructor(app, world, layers) {
    this.app = app;
    this.world = world;
    this.device = app.graphicsDevice;
    this.layers = layers;
    this.mat = worldMaterial({});
    this.targets = []; // things the staff can strike: { x, z, kind, ref }
    this.root = new pc.Entity('props');
    app.root.addChild(this.root);

    this.buildChimes();
    this.buildMeadowGate();
    this.buildValves();
    this.buildCauseway();
    this.buildPlates();
    this.buildArch();
    this.buildIronChime();
    this.buildBell();
    this.buildBeacons();
    this.buildExitGate();
    this.buildSunbeams();
    for (const r of world.rocks) this.targets.push({ x: r[0], z: r[1], kind: 'rock' });
    for (const p of world.pillars) this.targets.push({ x: p[0], z: p[1], kind: 'rock' });
  }

  // --------------------------------------------------------------- helpers
  ent(name, mb, { parent = this.root, mat = this.mat, reflect = false } = {}) {
    const e = new pc.Entity(name);
    e.addComponent('render', {
      meshInstances: [new pc.MeshInstance(mb.build(this.device), mat)],
      castShadows: false,
      receiveShadows: false,
      layers: reflect ? [this.layers.world.id, this.layers.reflect.id] : [this.layers.world.id],
    });
    parent.addChild(e);
    return e;
  }

  y(x, z) { return this.world.height(x, z); }

  // --------------------------------------------------------------- puzzle 1: three chimes + meadow gate
  buildChimes() {
    this.chimes = [];
    for (const c of LAYOUT.chimes) {
      const base = new pc.Entity('chimePost');
      base.setPosition(c.x, this.y(c.x, c.z) - 0.05, c.z);
      this.root.addChild(base);
      const mb = new MeshBuilder();
      addBox(mb, { y: 1.15, sx: 0.16, sy: 2.3, sz: 0.16, col: wood() });
      addBox(mb, { x: 0.32, y: 2.2, sx: 0.8, sy: 0.1, sz: 0.1, col: wood(0.02) });
      // tally notches: one, two or three pale cuts (pitch rank)
      for (let i = 0; i < c.rank; i++) addBox(mb, { x: 0.0, y: 1.35 + i * 0.16, z: 0.085, sx: 0.12, sy: 0.035, sz: 0.02, col: rgba(0.55, 0.52, 0.46, CLS.STONE) });
      this.ent('post', mb, { parent: base });
      // the hanging brass tube (swings when struck)
      const pivot = new pc.Entity('chimePivot');
      pivot.setLocalPosition(0.55, 2.15, 0);
      base.addChild(pivot);
      const tb = new MeshBuilder();
      addCylinder(tb, { y: -0.95, r0: 0.06, r1: 0.06, h: 0.85, seg: 6, colFn: () => brass(), capBottom: true });
      addBox(tb, { y: -0.05, sx: 0.015, sy: 0.12, sz: 0.015, col: iron() });
      this.ent('tube', tb, { parent: pivot });
      const freq = [0, 262, 349, 466][c.rank];
      const chime = { ...c, pivot, freq, swing: 0, x: c.x + 0.55, z: c.z };
      this.chimes.push(chime);
      this.targets.push({ x: chime.x, z: chime.z, kind: 'chime', ref: chime });
    }
  }

  buildMeadowGate() {
    const { gateX, z, gateHalf } = LAYOUT.wallA;
    const g = new pc.Entity('meadowGate');
    g.setPosition(gateX, this.y(gateX, z), z);
    this.root.addChild(g);
    const posts = new MeshBuilder();
    addBox(posts, { x: -gateHalf - 0.1, y: 1.3, sx: 0.3, sy: 2.6, sz: 0.3, col: wood(-0.02) });
    addBox(posts, { x: gateHalf + 0.1, y: 1.3, sx: 0.3, sy: 2.6, sz: 0.3, col: wood(-0.02) });
    this.ent('gatePosts', posts, { parent: g });
    const door = new pc.Entity('gateDoor');
    g.addChild(door);
    const pb = new MeshBuilder();
    for (let i = 0; i < 7; i++) {
      const x = -gateHalf + 0.25 + i * ((gateHalf * 2 - 0.5) / 6);
      addBox(pb, { x, y: 1.05 + (i % 2) * 0.12, sx: 0.16, sy: 2.0 + (i % 3) * 0.15, sz: 0.08, col: wood(0.01 * (i % 3)) });
    }
    addBox(pb, { y: 0.55, sx: gateHalf * 2, sy: 0.14, sz: 0.1, col: wood(0.03) });
    addBox(pb, { y: 1.65, sx: gateHalf * 2, sy: 0.14, sz: 0.1, col: wood(0.03) });
    addBox(pb, { y: 1.1, sx: 0.12, sy: 2.4, sz: 0.1, rot: 0, tilt: 0, col: wood(0.02) });
    this.ent('planks', pb, { parent: door });
    this.meadowGate = { door, open: 0 };
  }

  // --------------------------------------------------------------- puzzle 2: lake valves + causeway
  buildValves() {
    this.valves = LAYOUT.valveAngles.map((a, i) => {
      const p = this.world.shallowPoint(a);
      const base = new pc.Entity('valve');
      base.setPosition(p.x, Math.min(this.y(p.x, p.z), WORLD.waterY - 0.1), p.z);
      this.root.addChild(base);
      const mb = new MeshBuilder();
      addCylinder(mb, { r0: 0.12, r1: 0.1, h: 1.05, seg: 6, colFn: () => iron(-0.03) });
      this.ent('stem', mb, { parent: base, reflect: true });
      const wheel = new pc.Entity('wheel');
      wheel.setLocalPosition(0, 1.05, 0);
      base.addChild(wheel);
      const wb = new MeshBuilder();
      const R = 0.5;
      for (let k = 0; k < 10; k++) {
        const t = (k / 10) * Math.PI * 2;
        addBox(wb, { x: Math.cos(t) * R, z: Math.sin(t) * R, sx: 0.08, sy: 0.08, sz: 0.34, rot: -t, col: iron(0.04) });
      }
      for (let k = 0; k < 3; k++) addBox(wb, { sx: R * 2, sy: 0.06, sz: 0.06, rot: (k / 3) * Math.PI, col: iron(0.02) });
      this.ent('wheelMesh', wb, { parent: wheel, reflect: true });
      const v = { i, x: p.x, z: p.z, wheel, progress: 0, done: false };
      return v;
    });
  }

  buildCauseway() {
    const c = LAYOUT.causeway;
    const rng = mulberry32(61);
    const group = new pc.Entity('causeway');
    group.setPosition(0, -1.0, 0);
    this.root.addChild(group);
    const mb = new MeshBuilder();
    const n = 15;
    for (let i = 0; i < n; i++) {
      const z = c.z0 + ((c.z1 - c.z0) * i) / (n - 1);
      const x = c.x + (rng() - 0.5) * 0.35;
      addCylinder(mb, { x, y: 0.5, z, r0: 0.95, r1: 0.85, h: 0.42, seg: 7, jitter: 0.12, rng, colFn: (t) => stone(-0.06 + t * 0.06) });
    }
    this.ent('stones', mb, { parent: group, reflect: true });
    this.causeway = { group, up: 0 };
  }

  // --------------------------------------------------------------- puzzle 3: pressure plates + arch
  buildPlates() {
    this.plates = LAYOUT.plates.map((p, i) => {
      const y = this.y(p.x, p.z);
      const mb = new MeshBuilder();
      addBox(mb, { y: 0.05, sx: 2.4, sy: 0.14, sz: 2.4, col: stone(-0.04) });
      // carved channels
      for (let k = -1; k <= 1; k++) addBox(mb, { x: k * 0.6, y: 0.125, sx: 0.06, sy: 0.02, sz: 2.0, col: stone(0.08) });
      // listening stone: a short post with a hanging iron plate (strike it)
      addBox(mb, { x: 0, y: 0.75, z: 0, sx: 0.3, sy: 1.3, sz: 0.3, col: stone(0.02) });
      addBox(mb, { x: 0, y: 1.45, z: 0.22, sx: 0.5, sy: 0.4, sz: 0.04, col: iron(0.05) });
      const e = this.ent('plate', mb);
      e.setPosition(p.x, y - 0.03, p.z);
      const plate = { ...p, i, e, y, pressed: 0 };
      this.targets.push({ x: p.x, z: p.z, kind: 'metal', ref: plate });
      return plate;
    });
  }

  buildArch() {
    const { archX, z, archHalf } = LAYOUT.wallC;
    const y = this.y(archX, z);
    const base = new pc.Entity('arch');
    base.setPosition(archX, y, z);
    this.root.addChild(base);
    const mb = new MeshBuilder();
    addBox(mb, { x: -archHalf - 0.45, y: 2.4, sx: 0.9, sy: 4.8, sz: 1.0, col: stone(0) });
    addBox(mb, { x: archHalf + 0.45, y: 2.3, sx: 0.9, sy: 4.6, sz: 1.0, col: stone(-0.02) });
    addBox(mb, { x: 0.1, y: 5.0, sx: archHalf * 2 + 2.4, sy: 0.8, sz: 1.2, tilt: 0.04, col: stone(0.04) });
    this.ent('archStones', mb, { parent: base });
    const port = new pc.Entity('portcullis');
    base.addChild(port);
    const pb = new MeshBuilder();
    for (let i = 0; i < 7; i++) addBox(pb, { x: -archHalf + 0.3 + i * ((archHalf * 2 - 0.6) / 6), y: 2.2, sx: 0.12, sy: 4.4, sz: 0.12, col: iron() });
    for (let k = 0; k < 4; k++) addBox(pb, { y: 0.5 + k * 1.2, sx: archHalf * 2, sy: 0.1, sz: 0.12, col: iron(0.02) });
    this.ent('bars', pb, { parent: port });
    this.world.colliders.add(archX - archHalf - 0.45, z, 0.7);
    this.world.colliders.add(archX + archHalf + 0.45, z, 0.7);
    this.arch = { port, open: 0 };
  }

  buildIronChime() {
    const p = LAYOUT.ironChime;
    const mb = new MeshBuilder();
    addBox(mb, { y: 1.2, sx: 0.16, sy: 2.4, sz: 0.16, col: wood(-0.03) });
    addBox(mb, { x: 0.35, y: 2.3, sx: 0.8, sy: 0.1, sz: 0.1, col: wood() });
    addBox(mb, { x: 0.6, y: 1.7, sx: 0.08, sy: 0.9, sz: 0.3, col: iron(0.06) });
    const e = this.ent('ironChime', mb);
    e.setPosition(p.x, this.y(p.x, p.z) - 0.05, p.z);
    this.targets.push({ x: p.x + 0.6, z: p.z, kind: 'metal' });
  }

  buildBell() {
    const b = LAYOUT.bell;
    const mb = new MeshBuilder();
    // a cracked bronze bell lying on its side
    const bellMb = new MeshBuilder();
    addCylinder(bellMb, { r0: 0.95, r1: 0.55, h: 1.5, seg: 12, colFn: (t) => rgba(0.36 - t * 0.08, 0.27 - t * 0.06, 0.15, CLS.STONE), capTop: true });
    const e = this.ent('bell', bellMb);
    e.setPosition(b.x, SHRINE_Y + 0.85, b.z);
    e.setEulerAngles(90, 35, 0);
    addBox(mb, { sx: 1.6, sy: 0.3, sz: 0.6, col: wood(-0.04) });
    const beam = this.ent('bellBeam', mb);
    beam.setPosition(b.x + 1.2, SHRINE_Y + 0.15, b.z - 0.8);
    beam.setEulerAngles(0, 20, 8);
    this.world.colliders.add(b.x, b.z, 1.0);
    this.targets.push({ x: b.x, z: b.z, kind: 'bell' });
  }

  // --------------------------------------------------------------- puzzle 4: beacons + exit gate
  buildBeacons() {
    const S = LAYOUT.shrine;
    const coreMesh = emberCoreMesh(this.device);
    this.beacons = LAYOUT.beacons.map(([dx, dz], i) => {
      const x = S.x + dx, z = S.z + dz;
      const mb = new MeshBuilder();
      addBox(mb, { y: 0.75, sx: 0.4, sy: 1.5, sz: 0.4, col: stone(0) });
      addBox(mb, { y: 1.55, sx: 0.85, sy: 0.12, sz: 0.85, col: stone(0.04) });
      for (const [px, pz] of [[-0.33, -0.33], [0.33, -0.33], [-0.33, 0.33], [0.33, 0.33]]) addBox(mb, { x: px, y: 1.95, z: pz, sx: 0.1, sy: 0.7, sz: 0.1, col: stone(0.02) });
      addBox(mb, { y: 2.35, sx: 1.0, sy: 0.14, sz: 1.0, col: stone(0.05) });
      const e = this.ent('beacon', mb);
      e.setPosition(x, SHRINE_Y, z);
      this.world.colliders.add(x, z, 0.5);
      // the ember core sits in the cage once placed; a flame tongue appears when lit
      const coreMat = worldMaterial({ emissive: 0 });
      const core = new pc.Entity('beaconCore');
      core.addComponent('render', { meshInstances: [new pc.MeshInstance(coreMesh, coreMat)], layers: [this.layers.world.id], castShadows: false, receiveShadows: false });
      core.setLocalPosition(0, 1.9, 0);
      core.enabled = false;
      e.addChild(core);
      const fm = new MeshBuilder();
      addCylinder(fm, { r0: 0.3, r1: 0.0, h: 0.9, seg: 6, colFn: (t) => rgba(1.0, 0.6 - t * 0.2, 0.2, CLS.GLOW) });
      const flameMat = worldMaterial({ emissive: 2.8 });
      const flame = new pc.Entity('beaconFlame');
      flame.addComponent('render', { meshInstances: [new pc.MeshInstance(fm.build(this.device), flameMat)], layers: [this.layers.world.id], castShadows: false, receiveShadows: false });
      flame.setLocalPosition(0, 1.65, 0);
      flame.enabled = false;
      e.addChild(flame);
      return { i, x, z, e, core, coreMat, flame, placed: false, lit: false };
    });
  }

  buildExitGate() {
    const g = LAYOUT.exitGate;
    const base = new pc.Entity('exitGate');
    base.setPosition(g.x, SHRINE_Y, g.z);
    base.setEulerAngles(0, -(g.rot * 180) / Math.PI + 90, 0);
    this.root.addChild(base);
    const mb = new MeshBuilder();
    addBox(mb, { x: -3.0, y: 3.6, sx: 1.6, sy: 7.2, sz: 1.6, col: stone(-0.02) });
    addBox(mb, { x: 3.0, y: 3.4, sx: 1.6, sy: 6.8, sz: 1.6, col: stone(-0.04) });
    addBox(mb, { x: 0, y: 7.4, sx: 8.4, sy: 1.2, sz: 1.8, tilt: 0.03, col: stone(0.02) });
    // carved sun-disc, shattered
    addCylinder(mb, { x: 0, y: 8.2, z: 0.0, r0: 1.0, r1: 1.0, h: 0.3, seg: 10, colFn: () => stone(0.08) });
    this.ent('gateFrame', mb, { parent: base });
    const slab = new pc.Entity('gateSlab');
    base.addChild(slab);
    const sb = new MeshBuilder();
    addBox(sb, { y: 3.4, sx: 4.6, sy: 6.8, sz: 0.5, col: stone(-0.08) });
    for (let k = 0; k < 5; k++) addBox(sb, { y: 0.8 + k * 1.3, z: 0.27, sx: 4.2, sy: 0.08, sz: 0.06, col: stone(0.02) });
    this.ent('slab', sb, { parent: slab });
    // gate posts block, the slab is a wall segment we toggle
    const nx = Math.cos(g.rot + Math.PI / 2), nz = Math.sin(g.rot + Math.PI / 2);
    this.world.colliders.add(g.x + nx * 3, g.z + nz * 3, 1.0);
    this.world.colliders.add(g.x - nx * 3, g.z - nz * 3, 1.0);
    this.world.walls.push({ id: 'exit', a: [g.x - nx * 2.4, g.z - nz * 2.4], b: [g.x + nx * 2.4, g.z + nz * 2.4], on: true, r: 0.6 });
    this.exitGate = { slab, open: 0, x: g.x, z: g.z };
  }

  // --------------------------------------------------------------- the white light
  buildSunbeams() {
    const mat = worldMaterial({ emissive: 0.32 });
    // additive light shafts that leave the glyph-class alpha untouched
    mat.blendState = new pc.BlendState(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_ONE, pc.BLENDMODE_ONE, pc.BLENDEQUATION_ADD, pc.BLENDMODE_ZERO, pc.BLENDMODE_ONE);
    mat.depthWrite = false;
    mat.cull = pc.CULLFACE_NONE;
    mat.update();
    const mb = new MeshBuilder();
    addCylinder(mb, { r0: 0.8, r1: 1.6, h: 34, seg: 10, capTop: false, colFn: (t) => rgba(0.26 * (1 - t * 0.8), 0.27 * (1 - t * 0.8), 0.29 * (1 - t * 0.8), CLS.GLOW) });
    const mesh = mb.build(this.device);
    this.beamMat = mat;
    this.beams = [];
    this.makeBeam = (x, z, group) => {
      const e = new pc.Entity('sunbeam');
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], layers: [this.layers.world.id], castShadows: false, receiveShadows: false });
      e.setPosition(x, this.y(x, z) - 0.5, z);
      e.enabled = false;
      this.root.addChild(e);
      const b = { e, x, z, group, on: 0, bx: x, bz: z, phase: Math.random() * 6 };
      this.beams.push(b);
      return b;
    };
  }
}

/** Small helper so other modules can make glowing collectibles. */
export function glowSphere(device, r, col) {
  const mb = new MeshBuilder();
  addSphere(mb, { r, segW: 6, segH: 4, colFn: () => col });
  return mb.build(device);
}
