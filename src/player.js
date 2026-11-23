import * as pc from 'playcanvas';
import { CLS, worldMaterial } from './shaders.js';
import { MeshBuilder, rgba, addSphere, addTube, addLathe } from './meshes.js';
import { WORLD } from './world.js';
import { clamp, mulberry32 } from './noise.js';

function bodyMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(3);
  const cloak = (t) => rgba(0.15 - t * 0.03, 0.145 - t * 0.03, 0.15 - t * 0.03, CLS.CHAR);
  // fireproof charcoal cloak, flared at the hem, narrow at the shoulders
  addLathe(mb, [[0.44, 0.04], [0.47, 0.12], [0.4, 0.45], [0.3, 0.85], [0.22, 1.15], [0.19, 1.27], [0.1, 1.33], [0.0, 1.35]], {
    seg: 14, sz: 0.85, jitter: 0.06, rng, colFn: (t) => cloak(t),
  });
  // ragged hem
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + rng() * 0.2;
    const x = Math.cos(a) * 0.45, z = Math.sin(a) * 0.38;
    addTube(mb, [[x, 0.2, z, 0.05], [x * 1.05, 0.08, z * 1.05, 0.04], [x * 1.07, -0.02 + rng() * 0.05, z * 1.07, 0.01]], { seg: 4, colFn: () => cloak(0) });
  }
  // hollow clay skull (no face: just a dark opening where the ember glows)
  addLathe(mb, [[0.0, 1.3], [0.12, 1.34], [0.16, 1.45], [0.15, 1.56], [0.1, 1.63], [0.0, 1.66]], { seg: 10, colFn: () => rgba(0.22, 0.2, 0.18, CLS.CHAR) });
  // the soot-stained candle-shield hat
  addLathe(mb, [[0.66, 1.55], [0.64, 1.58], [0.44, 1.66], [0.22, 1.8], [0.08, 1.93], [0.0, 1.97]], { seg: 16, colFn: (t) => rgba(0.32 + t * 0.06, 0.27 + t * 0.05, 0.2, CLS.GROUND) });
  addLathe(mb, [[0.0, 1.55], [0.64, 1.55]].map(([r, y]) => [r, y]), { seg: 16, colFn: () => rgba(0.12, 0.1, 0.08, CLS.GROUND) });
  return mb.build(device);
}

/** Crooked iron poker-staff, built around the hand that holds it (pivot = hand). */
function staffMesh(device) {
  const mb = new MeshBuilder();
  const iron = () => rgba(0.2, 0.2, 0.21, CLS.STONE);
  addTube(mb, [[-0.02, -1.02, 0.01, 0.026], [-0.04, -0.4, -0.02, 0.026], [0.0, 0.2, 0.01, 0.024], [-0.03, 0.75, -0.02, 0.024], [0.01, 0.86, 0.06, 0.02], [0.04, 0.8, 0.14, 0.012]], { seg: 5, colFn: iron });
  addSphere(mb, { r: 0.07, segW: 5, segH: 4, colFn: () => rgba(0.12, 0.115, 0.12, CLS.CHAR) });
  return mb.build(device);
}

/** Signature accent: a faded rust-red scarf, wrapped at the neck, tails trailing in the wind. */
function scarfMesh(device) {
  const mb = new MeshBuilder();
  const rust = (t) => rgba(0.46 - t * 0.08, 0.13 - t * 0.02, 0.08, CLS.CHAR, t);
  const ring = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ring.push([Math.cos(a) * 0.19, 1.31 + Math.sin(a * 2) * 0.012, Math.sin(a) * 0.17, 0.055]);
  }
  addTube(mb, ring, { seg: 6, subdiv: 2, capEnd: false, colFn: () => rust(0) });
  // two tails falling down the back, the longer one lifting away
  addTube(mb, [[0.06, 1.3, -0.16, 0.05], [0.09, 1.12, -0.26, 0.048], [0.1, 0.9, -0.36, 0.044], [0.12, 0.66, -0.46, 0.04], [0.13, 0.46, -0.56, 0.03]], { seg: 5, colFn: (t) => rust(t) });
  addTube(mb, [[-0.04, 1.29, -0.16, 0.045], [-0.07, 1.12, -0.24, 0.042], [-0.08, 0.95, -0.3, 0.036], [-0.09, 0.8, -0.34, 0.028]], { seg: 5, colFn: (t) => rust(t) });
  return mb.build(device);
}

function lanternMesh(device) {
  const mb = new MeshBuilder();
  // glowing glass body
  addLathe(mb, [[0.0, -0.13], [0.09, -0.12], [0.11, -0.04], [0.11, 0.07], [0.08, 0.12], [0.0, 0.13]], { seg: 8, colFn: () => rgba(1.0, 0.72, 0.35, CLS.GLOW) });
  // iron cage + shutter cap + handle
  const iron = () => rgba(0.4, 0.3, 0.18, CLS.GLOW);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    addTube(mb, [[Math.cos(a) * 0.12, -0.13, Math.sin(a) * 0.12, 0.012], [Math.cos(a) * 0.125, 0.0, Math.sin(a) * 0.125, 0.012], [Math.cos(a) * 0.1, 0.13, Math.sin(a) * 0.1, 0.012]], { seg: 3, colFn: iron });
  }
  addLathe(mb, [[0.13, 0.12], [0.11, 0.17], [0.05, 0.21], [0.0, 0.22]], { seg: 8, colFn: iron });
  addTube(mb, [[-0.07, 0.2, 0, 0.01], [0, 0.32, 0, 0.012], [0.07, 0.2, 0, 0.01]], { seg: 3, colFn: iron });
  return mb.build(device);
}

export class Player {
  constructor(app, world, layers) {
    this.app = app;
    this.world = world;
    this.pos = new pc.Vec3(WORLD.spawn.x, 0, WORLD.spawn.z);
    this.pos.y = world.height(this.pos.x, this.pos.z);
    this.vel = new pc.Vec3();
    this.heading = Math.PI; // facing -Z towards the glade
    this.walkPhase = 0;
    this.wet = 0;
    this.speed = 0;
    this._tmp = [0, 0];

    const both = [layers.world.id, layers.reflect.id];
    this.root = new pc.Entity('player');
    this.body = new pc.Entity('body');
    this.body.addComponent('render', { meshInstances: [new pc.MeshInstance(bodyMesh(app.graphicsDevice), worldMaterial({ doubleSided: true }))], layers: both, castShadows: false, receiveShadows: false });
    this.root.addChild(this.body);

    // the coal glowing inside the hollow clay skull (no face)
    const ember = new MeshBuilder();
    addSphere(ember, { y: 1.47, z: 0.11, r: 0.06, segW: 5, segH: 3, colFn: () => rgba(1.0, 0.55, 0.2, CLS.GLOW) });
    this.faceMat = worldMaterial({ emissive: 2.0 });
    const face = new pc.Entity('ember');
    face.addComponent('render', { meshInstances: [new pc.MeshInstance(ember.build(app.graphicsDevice), this.faceMat)], layers: both, castShadows: false, receiveShadows: false });
    this.body.addChild(face);

    const scarf = new pc.Entity('scarf');
    scarf.addComponent('render', { meshInstances: [new pc.MeshInstance(scarfMesh(app.graphicsDevice), worldMaterial({ sway: 0.28, doubleSided: true }))], layers: both, castShadows: false, receiveShadows: false });
    this.body.addChild(scarf);

    // the staff is its own jointed part so it can swing, slam and crank
    this.staffPivot = new pc.Entity('staffPivot');
    this.staffPivot.setLocalPosition(-0.36, 1.0, 0.14);
    this.staffPivot.addComponent('render', { meshInstances: [new pc.MeshInstance(staffMesh(app.graphicsDevice), worldMaterial({}))], layers: both, castShadows: false, receiveShadows: false });
    this.body.addChild(this.staffPivot);
    this.shut = 0;

    this.lanternPivot = new pc.Entity('lanternPivot');
    this.lanternPivot.setLocalPosition(0.42, 1.05, 0.1);
    this.lantern = new pc.Entity('lantern');
    this.lanternMat = worldMaterial({ emissive: 2.2 });
    this.lantern.addComponent('render', { meshInstances: [new pc.MeshInstance(lanternMesh(app.graphicsDevice), this.lanternMat)], layers: both, castShadows: false, receiveShadows: false });
    this.lantern.setLocalPosition(0, -0.35, 0);
    this.lanternPivot.addChild(this.lantern);
    this.root.addChild(this.lanternPivot);
    app.root.addChild(this.root);
    this.root.setPosition(this.pos);
    this.root.setLocalScale(0.78, 0.78, 0.78); // small against an oversized world
    this.gait = 'still';
    this.stepped = false;
    this.strikeT = 0;
    this.crankT = 0;
    this.dead = 0;
  }

  teleport(x, z, heading = Math.PI) {
    this.pos.set(x, this.world.groundAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.speed = 0;
  }

  /**
   * opts: { slow: speed multiplier (Veil-Mother smother), locked: no movement (cranking / dead) }
   * Gaits: sneak (silent), walk, run (loud). Touch: a light stick tilt sneaks, full tilt runs.
   */
  update(dt, input, camYaw, t, opts = {}) {
    const ix = input.move.x, iy = input.move.y;
    const mag = Math.min(1, Math.hypot(ix, iy));
    const sneak = input.sneak || (input.touchStick && mag > 0.05 && mag < 0.45);
    const run = !sneak && (input.run || (input.analog && mag > 0.92));
    const locked = opts.locked;
    const maxSpeed = (locked ? 0 : sneak ? 1.5 : run ? 6.4 : 3.4) * (opts.slow ?? 1);
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    // a light touch tilt sneaks at full sneak speed; otherwise speed follows the tilt
    const eff = input.touchStick && sneak ? 1 : Math.min(1, mag * 1.25);
    const k = mag > 0.01 ? eff / mag : 0;
    const wx = (fx * iy + rx * ix) * k * maxSpeed;
    const wz = (fz * iy + rz * ix) * k * maxSpeed;
    const accel = 1 - Math.exp(-dt * (mag > 0.01 ? 10 : 7));
    this.vel.x += (wx - this.vel.x) * accel;
    this.vel.z += (wz - this.vel.z) * accel;

    let nx = this.pos.x + this.vel.x * dt;
    let nz = this.pos.z + this.vel.z * dt;

    // deep water blocks (unless the causeway is up); stay inside the glade
    const W = this.world;
    if (W.isDeep(nx, nz)) {
      if (!W.isDeep(nx, this.pos.z)) nz = this.pos.z;
      else if (!W.isDeep(this.pos.x, nz)) nx = this.pos.x;
      else { nx = this.pos.x; nz = this.pos.z; }
    }
    const r = Math.hypot(nx, nz);
    const pr = opts.playRadius ?? WORLD.playRadius;
    if (r > pr) { nx *= pr / r; nz *= pr / r; }
    const res = W.resolve(nx, nz, 0.38, this._tmp);
    nx = res[0];
    nz = res[1];

    const realVx = (nx - this.pos.x) / Math.max(dt, 1e-4), realVz = (nz - this.pos.z) / Math.max(dt, 1e-4);
    this.speed = Math.hypot(realVx, realVz);
    this.pos.x = nx;
    this.pos.z = nz;
    const ground = W.groundAt(nx, nz);
    this.wading = ground < WORLD.waterY && !W.onCauseway(nx, nz);
    this.pos.y = Math.max(ground, WORLD.waterY - 0.35);
    this.wet += ((this.wading || ground < WORLD.waterY + 0.15 ? 1 : 0) - this.wet) * Math.min(1, dt * 3);
    this.gait = this.speed < 0.25 ? 'still' : sneak ? 'sneak' : this.speed > 4.8 ? 'run' : 'walk';

    // turn towards motion
    if (this.speed > 0.3) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 12);
    }

    // procedural walk: bob + lean + lantern swing; footsteps on each half-cycle
    const sp = clamp(this.speed / 6.4, 0, 1);
    const prev = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += dt * (4 + sp * 7) * (this.speed > 0.2 ? 1 : 0);
    this.stepped = Math.floor(this.walkPhase / Math.PI) !== prev;
    const bob = Math.abs(Math.sin(this.walkPhase)) * 0.07 * Math.min(1, this.speed) * (sneak ? 0.4 : 1);
    this.strikeT = Math.max(0, this.strikeT - dt);
    const strike = Math.sin((1 - this.strikeT / 0.35) * Math.PI) * (this.strikeT > 0 ? 1 : 0);
    const crank = this.crankT > 0 ? Math.sin(t * 9) : 0;
    this.root.setPosition(this.pos.x, this.pos.y - this.dead * 0.25, this.pos.z);
    this.root.setEulerAngles(0, (this.heading * 180) / Math.PI, 0);
    const breathe = this.speed < 0.2 ? Math.sin(t * 1.7) * 0.012 : 0;
    this.body.setLocalPosition(0, bob - (sneak ? 0.12 : 0), 0);
    this.body.setLocalScale(1, 1 + breathe, 1);
    this.body.setLocalEulerAngles(sp * 9 + (sneak ? 14 : 0) + strike * 18 + crank * 6 + this.dead * 40, 0, Math.sin(this.walkPhase) * 3 * sp + crank * 4);
    // staff: raise back, then slam forward; circle while cranking; sway with the stride
    const ph = this.strikeT > 0 ? 1 - this.strikeT / 0.35 : 0;
    const slam = this.strikeT > 0 ? (ph < 0.45 ? -55 * (ph / 0.45) : -55 + 125 * Math.min(1, (ph - 0.45) / 0.25)) : 0;
    const cr = this.crankT > 0 ? t * 9 : 0;
    this.staffPivot.setLocalEulerAngles(
      slam + (this.crankT > 0 ? 35 + Math.sin(cr) * 22 : 0) + Math.sin(this.walkPhase) * 10 * sp + (sneak ? 12 : 0),
      0,
      (this.crankT > 0 ? Math.cos(cr) * 22 : 0) - 4,
    );
    // shutter: pull the lantern in close under the cloak
    this.shut += ((opts.shutter ? 1 : 0) - this.shut) * Math.min(1, dt * 10);
    this.lanternPivot.setLocalPosition(0.42 - this.shut * 0.2, 1.05 - this.shut * 0.1, 0.1 + this.shut * 0.12);
    this.lanternPivot.setLocalEulerAngles(Math.sin(this.walkPhase) * 18 * sp * (1 - this.shut) - sp * 14 + Math.sin(t * 1.3) * 3, 0, Math.cos(this.walkPhase * 0.5) * 6 * sp + this.shut * 20);
  }

  lanternWorldPos(out) {
    return out.copy(this.lantern.getPosition());
  }
}
