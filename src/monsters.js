// The wardens of the glade. Silhouette meshes + small state machines.
// Every monster reads the shared "senses" object built by gameplay.js each frame:
//   g.player {x,z,y}, g.speed, g.still (seconds), g.lightOpen, g.lightRadius, g.events (sounds
//   this frame: {x,z,r,kind}), g.time, g.lantern {x,y,z}; and calls g.hurt(), g.kill(), g.ring().
import * as pc from 'playcanvas';
import { CLS, worldMaterial } from './shaders.js';
import { MeshBuilder, rgba, addTube, addLathe, addFan, addSphere, addBox, faceted } from './meshes.js';
import { LAYOUT, regionOf } from './story.js';
import { SHRINE_Y } from './world.js';
import * as sfx from './audio.js';

const shade = (v, cls = CLS.CHAR, sway = 0) => rgba(0.07 + v, 0.075 + v, 0.07 + v, cls, sway);
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const angTo = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);
function turn(cur, target, rate) {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + d * Math.min(1, rate);
}

class Monster {
  constructor(app, layers, name) {
    this.app = app;
    this.root = new pc.Entity(name);
    app.root.addChild(this.root);
    this.layers = [layers.world.id, layers.reflect.id];
    this.x = 0; this.z = 0; this.yaw = 0;
    this.state = 'idle';
    this.t = 0; // time in state
  }
  part(mb, parent = this.root, mat = Monster.mat) {
    const e = new pc.Entity('part');
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(faceted(mb, 0.2, Monster.rng).build(this.app.graphicsDevice), mat)], layers: this.layers, castShadows: false, receiveShadows: false });
    parent.addChild(e);
    return e;
  }
  set(state) { if (this.state !== state) { this.state = state; this.t = 0; } }
  moveTo(tx, tz, speed, dt) {
    const d = dist(this.x, this.z, tx, tz);
    if (d < 0.05) return d;
    const step = Math.min(d, speed * dt);
    this.x += ((tx - this.x) / d) * step;
    this.z += ((tz - this.z) / d) * step;
    this.yaw = turn(this.yaw, angTo(this.x, this.z, tx, tz), dt * 6);
    return d - step;
  }
  place(world, lift = 0) {
    this.root.setPosition(this.x, world.groundAt(this.x, this.z) + lift, this.z);
    this.root.setEulerAngles(0, (this.yaw * 180) / Math.PI, 0);
  }
}

// ============================================================ VEIL-MOTHER (the Snuffers)
export class VeilMother extends Monster {
  constructor(app, layers, home) {
    super(app, layers, 'veilMother');
    this.home = home;
    this.region = home.region;
    this.mercy = !!home.mercy;
    const rng = mulberry(17 + Math.round(home.x));
    // a tall hooded wraith, stooping a little at the top
    const hunch = (x, y, z) => { const k = Math.max(0, (y - 1.8) / 1.6); return [x, y - k * k * 0.15, z + k * k * 0.42]; };
    const robe = (v = 0, sw = 0) => shade(0.03 + v, CLS.CHAR, sw);
    const body = new MeshBuilder();
    // the long robe: narrow shoulders flaring to a wide skirt
    addLathe(body, [[0.64, 0.12], [0.56, 0.6], [0.45, 1.3], [0.39, 1.9], [0.42, 2.42], [0.36, 2.7], [0.18, 2.84], [0.0, 2.88]], {
      seg: 9, sz: 0.74, jitter: 0.16, rng, warp: hunch, colFn: (t) => robe(t * 0.03),
    });
    // ragged hem: pointed tatters, the back ones trailing along the ground
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * Math.PI * 2 + rng() * 0.2;
      const x = Math.cos(a) * 0.6, z = Math.sin(a) * 0.45;
      const tail = z < -0.15 ? -(0.4 + rng() * 0.7) : 0;
      addTube(body, [[x, 0.6, z, 0.13], [x * 1.12, 0.25, z * 1.12 + tail * 0.3, 0.09], [x * 1.22 + (rng() - 0.5) * 0.15, 0.02, z * 1.2 + tail, 0.0]], {
        seg: 4, subdiv: 2, colFn: (t) => robe(-0.005, t),
      });
    }
    // the deep peaked cowl and the black hollow where a face should be
    addTube(body, [[0, 2.58, 0.05, 0.3], [0, 2.84, 0.1, 0.36], [0, 3.1, 0.02, 0.32], [0, 3.32, -0.12, 0.2], [0, 3.46, -0.3, 0.02]].map(([x, y, z, r]) => [...hunch(x, y, z), r]), { seg: 7, colFn: () => robe(0.015) });
    const fc = hunch(0, 2.9, 0.34);
    addSphere(body, { x: fc[0], y: fc[1], z: fc[2], r: 0.22, sy: 1.2, segW: 7, segH: 5, colFn: () => rgba(0.012, 0.012, 0.016, CLS.CHAR) });
    // a heavy mantle over the shoulders, its edge hanging in torn points
    addLathe(body, [[0.74, 2.02], [0.7, 2.25], [0.56, 2.5], [0.4, 2.68], [0.3, 2.78]], { seg: 9, sz: 0.8, jitter: 0.14, rng, warp: hunch, colFn: (t) => robe(0.012 + t * 0.02) });
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + rng() * 0.3;
      const x = Math.cos(a) * 0.72, z = Math.sin(a) * 0.58;
      const drop = 0.28 + rng() * 0.4;
      addTube(body, [[x, 2.1, z, 0.12], [x * 1.05, 2.1 - drop * 0.55, z * 1.05, 0.07], [x * 1.02, 2.1 - drop, z * 1.02, 0.0]].map(([px, py, pz, r]) => [...hunch(px, py, pz), r]), { seg: 4, subdiv: 2, colFn: (t) => robe(0.0, t * 0.8) });
    }
    // the gape under the eyes: a ring of long pale fangs
    for (let i = 0; i < 6; i++) {
      const fx = (i - 2.5) * 0.045;
      const up = i % 2 === 0;
      addTube(body, [[fc[0] + fx, fc[1] - (up ? 0.1 : 0.3), fc[2] + 0.17, 0.014], [fc[0] + fx, fc[1] - (up ? 0.22 : 0.19), fc[2] + 0.19, 0.0]], { seg: 3, subdiv: 1, colFn: () => rgba(0.5, 0.48, 0.42, CLS.CHAR) });
    }
    // a ribcage glimpsed through the open robe
    for (let i = 0; i < 4; i++) {
      const y = 2.3 - i * 0.15;
      for (const sg of [-1, 1]) {
        addTube(body, [[0, y, 0.37], [0.13 * sg, y - 0.03, 0.36], [0.23 * sg, y - 0.09, 0.27]].map(([x, yy, z]) => [...hunch(x, yy, z), 0.024]), { seg: 4, subdiv: 2, colFn: () => shade(0.16) });
      }
    }
    addTube(body, [[0, 2.38, 0.38], [0, 1.85, 0.36]].map(([x, y, z]) => [...hunch(x, y, z), 0.025]), { seg: 4, colFn: () => shade(0.14) });
    // four ember eyes in the dark of the hood
    const em = new MeshBuilder();
    for (const [ex, ey, er] of [[-0.075, 0.1, 0.024], [0.075, 0.1, 0.024], [-0.04, 0.025, 0.02], [0.04, 0.025, 0.02], [0, 0.155, 0.015]]) {
      addSphere(em, { x: fc[0] + ex, y: fc[1] + ey, z: fc[2] + 0.2, r: er, segW: 5, segH: 3, colFn: () => rgba(1.0, 0.66, 0.2, CLS.GLOW) });
    }
    // (eyes ride in the body mesh as self-lit vertices: one draw call for the whole figure)
    body.append(em.selfLit());
    this.part(body, this.root, Monster.matSway);
    // long thin arms ending in long, hooked claws, with shards of something crumbling around the hands
    this.arms = [-1, 1].map((sg) => {
      const pivot = new pc.Entity('arm');
      const [sx, sy, sz] = hunch(0.42 * sg, 2.58, 0.18);
      pivot.setLocalPosition(sx, sy, sz);
      this.root.addChild(pivot);
      const mb = new MeshBuilder();
      // skeletal: the elbow juts out and back, the forearm reaches forward
      addTube(mb, [[0, 0, 0, 0.085], [0.2 * sg, -0.42, -0.08, 0.06], [0.3 * sg, -0.82, 0.02, 0.05], [0.24 * sg, -1.12, 0.3, 0.042], [0.16 * sg, -1.36, 0.5, 0.038]], { seg: 5, colFn: () => robe(0.01) });
      addSphere(mb, { x: 0.3 * sg, y: -0.82, z: 0.0, r: 0.075, segW: 5, segH: 3, colFn: () => robe(0.02) });
      for (let f = 0; f < 5; f++) {
        const fa = -0.9 + (f / 4) * 1.8;
        const hx = 0.16 * sg, hy = -1.36, hz = 0.5;
        addTube(mb, [[hx, hy, hz, 0.025], [hx + Math.sin(fa) * 0.14 * sg, hy - 0.22, hz + 0.08 + Math.cos(fa) * 0.06, 0.018], [hx + Math.sin(fa) * 0.2 * sg, hy - 0.5, hz + 0.16 + Math.cos(fa) * 0.05, 0.008], [hx + Math.sin(fa) * 0.18 * sg, hy - 0.66, hz + 0.26, 0.0]], {
          seg: 4, subdiv: 2, colFn: () => shade(0.0),
        });
      }
      const shards = new MeshBuilder();
      for (let k = 0; k < 10; k++) {
        const r = 0.035 + rng() * 0.06;
        addBox(shards, { x: 0.16 * sg + (rng() - 0.5) * 0.7, y: -1.4 + (rng() - 0.5) * 0.9, z: 0.5 + (rng() - 0.5) * 0.5, sx: r, sy: r * 1.6, sz: r * 0.6, rot: rng() * 6, tilt: rng() * 3, col: shade(0.0, CLS.CHAR, 1) });
      }
      mb.append(shards);
      this.part(mb, pivot, Monster.matSway);
      return pivot;
    });
    this.reset();
  }

  reset() {
    this.x = this.home.x; this.z = this.home.z;
    this.tx = this.x; this.tz = this.z;
    this.set('idle');
    this.arm = 0;
    this.kneel = 0;
    this.lingerFor = 0;
    this.onPlate = -1;
  }

  /** Mercy ending: kneel and cup the lantern. */
  setKneel(v) { this.kneel = v; }

  update(dt, g, world, plateFree) {
    this.t += dt;
    const p = g.player;
    const dp = dist(this.x, this.z, p.x, p.z);
    const inRegion = regionOf(p.x, p.z) === this.region;
    let targetArm = 0;

    // hearing: walk to sounds (lingering on a plate she only answers sounds right next to her)
    for (const ev of g.events) {
      const de = dist(this.x, this.z, ev.x, ev.z);
      if (de > ev.r || regionOf(ev.x, ev.z) !== this.region) continue;
      if (this.state === 'smother') continue;
      if (this.state === 'linger' && this.onPlate >= 0 && de > 5) continue;
      this.tx = ev.x; this.tz = ev.z;
      this.set('investigate');
    }
    // the light draws her
    const sees = g.lightOpen && inRegion && dp < 8 + g.lightRadius * 0.5;
    if (sees && (this.state === 'idle' || (this.state === 'linger' && (this.onPlate < 0 || dp < 3)))) {
      if (this.state !== 'hunt') sfx.play('sigh', { x: this.x, z: this.z }, { vol: 0.9 });
      this.set('hunt');
    }

    switch (this.state) {
      case 'idle':
        if (this.t > 5 || dist(this.x, this.z, this.tx, this.tz) < 0.3) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * 8;
          this.tx = this.home.x + Math.cos(a) * r; this.tz = this.home.z + Math.sin(a) * r;
          this.t = 0;
        }
        this.moveTo(this.tx, this.tz, 0.55, dt);
        break;
      case 'investigate': {
        const left = this.moveTo(this.tx, this.tz, 1.5, dt);
        if (left < 0.4) {
          const plate = plateFree(this);
          this.onPlate = plate;
          this.lingerFor = plate >= 0 ? 20 : 3;
          this.set('linger');
        }
        break;
      }
      case 'linger':
        if (this.t > this.lingerFor) { this.onPlate = -1; this.set('idle'); }
        break;
      case 'hunt':
        this.moveTo(p.x, p.z, 1.45, dt);
        targetArm = 0.5;
        // she hunts the light: hide it and she loses you, even if you keep creeping away
        this.dark = g.lightOpen ? 0 : (this.dark || 0) + dt;
        if (this.dark > 1.5 && !this.mercyWatch) this.set('idle');
        if (!inRegion && dp > 4) this.set('idle');
        if (dp < 1.8) this.set('smother');
        break;
      case 'smother':
        this.yaw = turn(this.yaw, angTo(this.x, this.z, p.x, p.z), dt * 4);
        targetArm = 1;
        if (this.kneel <= 0) {
          if (g.lightOpen) g.hurt(0.42 * dt, 'veil');
          g.slow = Math.min(g.slow, 0.4);
        }
        if (dp > 2.8) this.set('hunt');
        else if (!g.lightOpen && this.t > 2 && this.kneel <= 0 && !this.mercyWatch) this.set('idle');
        break;
    }
    // lantern shadow: just being near her chills the flame
    if (dp < 3.2 && g.lightOpen && this.kneel <= 0) g.hurt(0.05 * dt, 'veil');
    if (dp < 6) g.tension = Math.max(g.tension, 1 - dp / 6);

    // keep to her region
    if (this.region === 'central') this.z = Math.max(LAYOUT.wallC.z + 1.5, Math.min(LAYOUT.wallB.z - 1.5, this.z));
    if (this.region === 'north') this.z = Math.min(LAYOUT.wallC.z - 1.5, this.z);

    // pose
    this.arm += (Math.max(targetArm, this.kneel) - this.arm) * Math.min(1, dt * 3);
    for (const a of this.arms) a.setLocalEulerAngles(-this.arm * 75, 0, 0);
    const bob = Math.sin(g.time * 0.9 + this.home.x) * 0.06;
    this.place(world, bob - this.kneel * 0.9);
    this.root.setLocalScale(1, 1 - this.kneel * 0.25, 1);
  }

  chest() { return { x: this.x + Math.sin(this.yaw) * 0.2, y: this.root.getPosition().y + 1.8, z: this.z + Math.cos(this.yaw) * 0.2 }; }
}

// ============================================================ ASH-HOUND (the Ember-Eaters)
export class AshHound extends Monster {
  constructor(app, layers, home) {
    super(app, layers, 'ashHound');
    this.home = home;
    this.meadow = LAYOUT.southMeadow;
    this.body = new pc.Entity('houndBody');
    this.root.addChild(this.body);
    const rng = mulberry(400 + Math.round(home.x * 7));
    const fur = (v = 0, sw = 0) => shade(0.01 + v, CLS.CHAR, sw);
    const mb = new MeshBuilder();
    // a lean, deep-chested wolf: torso, brisket, lowered neck and long head
    addTube(mb, [[0, 0.8, -0.55, 0.17], [0, 0.84, -0.25, 0.2], [0, 0.88, 0.1, 0.25], [0, 0.9, 0.34, 0.25], [0, 0.98, 0.55, 0.18]], { seg: 6, subdiv: 2, colFn: () => fur() });
    addTube(mb, [[0, 0.64, 0.02, 0.12], [0, 0.6, 0.28, 0.17], [0, 0.7, 0.5, 0.13]], { seg: 6, colFn: () => fur(0.005) });
    addTube(mb, [[0, 0.98, 0.5, 0.17], [0, 0.93, 0.72, 0.15], [0, 0.87, 0.88, 0.14], [0, 0.81, 1.05, 0.1], [0, 0.76, 1.22, 0.06], [0, 0.74, 1.31, 0.03]], { seg: 6, colFn: () => fur(0.012) });
    // a snarling, open jaw with pale fangs
    addTube(mb, [[0, 0.76, 0.9, 0.08], [0, 0.65, 1.08, 0.06], [0, 0.6, 1.22, 0.025]], { seg: 5, colFn: () => fur() });
    for (const sg of [-1, 1]) {
      addTube(mb, [[0.035 * sg, 0.74, 1.2, 0.014], [0.035 * sg, 0.67, 1.21, 0.0]], { seg: 3, subdiv: 1, colFn: () => rgba(0.6, 0.57, 0.5, CLS.CHAR) });
      // tall pointed ears laid back
      addTube(mb, [[0.08 * sg, 0.96, 0.84, 0.055], [0.11 * sg, 1.09, 0.79, 0.035], [0.12 * sg, 1.22, 0.72, 0.0]], { seg: 4, colFn: () => fur(0.01) });
    }
    // a hackled mane: long spikes over the neck and shoulders, shortening to bristles along the back
    for (let i = 0; i < 13; i++) {
      const z = 0.82 - i * 0.11;
      const y = 0.8 + (Math.min(Math.max(z, -0.55), 0.55) + 0.55) / 1.1 * 0.18 + 0.17;
      const big = Math.max(0.12, 1 - Math.abs(i - 3) / 4.5); // tallest at the shoulders
      const bx = (rng() - 0.5) * 0.12;
      const tip = [bx * 1.6 + (rng() - 0.5) * 0.1, y + 0.06 + big * 0.36 + rng() * 0.06, z - 0.18 - big * 0.08];
      addTube(mb, [[bx, y - 0.04, z, 0.06 + big * 0.045], [(bx + tip[0]) / 2, (y + tip[1]) / 2, z - 0.09, 0.035 + big * 0.015], [tip[0], tip[1], tip[2], 0.0]], { seg: 4, subdiv: 1, colFn: () => fur(0.015) });
      if (i > 0 && i < 7) for (const sg of [-1, 1]) {
        // the ruff fans out round the neck and chest
        addTube(mb, [[0.16 * sg, y - 0.12, z, 0.06], [0.3 * sg, y + 0.02 + big * 0.14, z - 0.18, 0.0]], { seg: 4, subdiv: 1, colFn: () => fur(0.01) });
        addTube(mb, [[0.18 * sg, y - 0.3, z + 0.02, 0.05], [0.31 * sg, y - 0.3 + big * 0.05, z - 0.2, 0.0]], { seg: 4, subdiv: 1, colFn: () => fur(0.006) });
      }
    }
    // a heavy brush of a tail
    addTube(mb, [[0, 0.82, -0.58, 0.08], [0, 0.8, -0.82, 0.15], [0, 0.7, -1.08, 0.14], [0, 0.6, -1.3, 0.07], [0, 0.55, -1.42, 0.0]], { seg: 6, colFn: () => fur() });
    for (let k = 0; k < 7; k++) {
      const z = -0.72 - k * 0.1, y = 0.82 - k * 0.04, a = rng() * 6.28;
      addTube(mb, [[Math.cos(a) * 0.08, y + Math.sin(a) * 0.08, z, 0.05], [Math.cos(a) * 0.2, y + Math.sin(a) * 0.2, z - 0.16, 0.0]], { seg: 4, subdiv: 1, colFn: () => fur(0.008) });
    }
    // burning amber eyes
    const em = new MeshBuilder();
    for (const sg of [-1, 1]) addSphere(em, { x: 0.082 * sg, y: 0.885, z: 1.0, r: 0.042, sy: 0.7, segW: 6, segH: 4, colFn: () => rgba(1.0, 0.68, 0.2, CLS.GLOW) });
    mb.append(em.selfLit());
    // ash smoking off its back
    const ash = new MeshBuilder();
    // a plume of fine ash: dense over the shoulders, thinning as it rises and trails back
    for (let k = 0; k < 40; k++) {
      const up = rng() * rng();
      const r = 0.022 + rng() * 0.05 * (1 - up * 0.5);
      addBox(ash, { x: (rng() - 0.5) * (0.3 + up * 0.5), y: 1.12 + up * 1.1, z: 0.35 - rng() * 0.7 - up * 0.6, sx: r, sy: r, sz: r, rot: rng() * 6, tilt: rng() * 3, col: shade(0.01 + rng() * 0.05, CLS.CHAR, 1) });
    }
    mb.append(ash);
    this.part(mb, this.body, Monster.matSway); // body, eyes and ash: one draw call
    // four jointed legs (front: straight; hind: dog hock bent backward) with clawed paws
    this.legs = [];
    const leg = (x, y, z, hind, phase) => {
      const pivot = new pc.Entity('leg');
      pivot.setLocalPosition(x, y, z);
      this.body.addChild(pivot);
      const lb = new MeshBuilder();
      const pts = hind
        ? [[0, 0, 0, 0.13], [0, -0.25, 0.15, 0.09], [0, -0.5, -0.12, 0.05], [0, -0.76, -0.04, 0.045], [0, -0.8, 0.07, 0.05]]
        : [[0, 0, 0, 0.1], [0, -0.28, 0.04, 0.075], [0, -0.55, -0.02, 0.05], [0, -0.77, 0.02, 0.045], [0, -0.81, 0.1, 0.05]];
      addTube(lb, pts, { seg: 5, colFn: () => fur() });
      for (let c = -1; c <= 1; c++) addTube(lb, [[c * 0.03, -0.8, 0.12, 0.016], [c * 0.04, -0.83, 0.2, 0.0]], { seg: 3, subdiv: 1, colFn: () => fur(-0.005) });
      this.part(lb, pivot);
      this.legs.push({ pivot, phase, hind });
    };
    leg(-0.13, 0.82, 0.36, false, 0); leg(0.13, 0.82, 0.36, false, 0.6);
    leg(-0.13, 0.8, -0.45, true, Math.PI); leg(0.13, 0.8, -0.45, true, Math.PI + 0.6);
    this.gaitT = 0;
    this.reset();
  }

  reset() {
    this.x = this.home.x; this.z = this.home.z;
    this.ang = Math.atan2(this.z - this.meadow.z, this.x - this.meadow.x);
    this.set('prowl');
    this.cool = 0;
  }

  update(dt, g, world) {
    this.t += dt;
    this.cool -= dt;
    const p = g.player;
    const M = this.meadow;
    const dp = dist(this.x, this.z, p.x, p.z);
    const inMeadow = dist(p.x, p.z, M.x, M.z) < M.r;
    const moving = g.speed > 0.3;
    // sneaking through the grass is only noticed up close
    const seen = moving && (g.gait !== 'sneak' || dp < 5);
    let gait = 0;

    switch (this.state) {
      case 'prowl': {
        this.ang += dt * 0.35;
        const r = M.r * 0.65 + Math.sin(this.ang * 1.7 + this.home.x) * 2.5;
        this.moveTo(M.x + Math.cos(this.ang) * r, M.z + Math.sin(this.ang) * r, 2.2, dt);
        gait = 0.4;
        if (inMeadow && seen && dp < 16 && this.cool <= 0) {
          sfx.play('growl', { x: this.x, z: this.z }, { vol: 1 });
          this.set('notice');
        }
        break;
      }
      case 'notice':
        // it freezes and turns its long skull toward you: the window to stand still
        this.yaw = turn(this.yaw, angTo(this.x, this.z, p.x, p.z), dt * 4);
        gait = 0.1;
        g.tension = Math.max(g.tension, 0.8);
        if (!moving && this.t > 0.4) { this.cool = 2; this.set('prowl'); }
        else if (this.t > 1.4) { sfx.play('skitter', { x: this.x, z: this.z }, { vol: 1 }); this.set('hunt'); }
        break;
      case 'hunt':
        gait = 1;
        this.moveTo(p.x + Math.sin(g.time * 3 + this.home.z) * 0.6, p.z, 6.6, dt);
        if (!inMeadow && dp > 3) this.set('retreat');
        else if (!moving) this.set('sniff');
        else if (dp < 1.25) {
          g.hurt(0.34, 'hound');
          sfx.play('bite', { x: this.x, z: this.z });
          this.cool = 5;
          this.set('retreat');
        }
        break;
      case 'sniff':
        gait = 0.15;
        if (dp > 1.0) this.moveTo(p.x, p.z, 1.1, dt);
        else this.yaw = turn(this.yaw, angTo(this.x, this.z, p.x, p.z), dt * 3);
        if (this.t < 0.1) sfx.play('growl', { x: this.x, z: this.z }, { vol: 0.7 });
        if (seen && dp < 2.2 && g.gait !== 'sneak') {
          g.hurt(0.34, 'hound');
          sfx.play('bite', { x: this.x, z: this.z });
          this.cool = 5;
          this.set('retreat');
        } else if (seen && dp >= 2.2) this.set('hunt');
        else if (this.t > 2.6) { this.cool = 6; g.text('stillWorks'); this.set('retreat'); }
        break;
      case 'retreat': {
        gait = 0.9;
        if (this.t < 0.05) { const a = Math.random() * Math.PI * 2; this.rx = M.x + Math.cos(a) * M.r * 0.8; this.rz = M.z + Math.sin(a) * M.r * 0.8; }
        const left = this.moveTo(this.rx, this.rz, 6.0, dt);
        if (left < 0.5 || this.t > 4) { this.ang = Math.atan2(this.z - M.z, this.x - M.x); this.set('prowl'); }
        break;
      }
    }
    if (dp < 7) g.tension = Math.max(g.tension, 1 - dp / 7);
    this.gaitT += dt * (3 + gait * 11);
    const bob = Math.abs(Math.sin(this.gaitT)) * 0.1 * gait;
    this.body.setLocalPosition(0, bob, 0);
    this.body.setLocalEulerAngles(Math.sin(this.gaitT) * 5 * gait + (this.state === 'sniff' ? 12 : 0), 0, 0);
    for (const L of this.legs) L.pivot.setLocalEulerAngles(Math.sin(this.gaitT + L.phase) * (8 + gait * 34), 0, 0);
    this.place(world);
  }
}

// ============================================================ GLOOM-MOTH (the Flame Thieves)
export class GloomMoth extends Monster {
  constructor(app, layers, perch, world) {
    super(app, layers, 'gloomMoth');
    this.perch = { x: perch.x, z: perch.z, y: world.height(perch.x, perch.z) + 6.5 };
    this.group = perch.group;
    const rng = mulberry(91 + Math.round(perch.x * 3));
    const body = new MeshBuilder();
    const chit = (v = 0, sw = 0) => shade(0.02 + v, CLS.CHAR, sw);
    // head, thorax and a long hanging abdomen
    addSphere(body, { y: 0.3, z: 0.16, r: 0.12, segW: 6, segH: 4, jitter: 0.2, rng, colFn: () => chit(0.01) });
    addSphere(body, { y: 0.1, z: 0.0, r: 0.16, sy: 1.15, segW: 6, segH: 4, jitter: 0.15, rng, colFn: () => chit() });
    addTube(body, [[0, -0.02, -0.06, 0.13], [0, -0.3, -0.13, 0.17], [0, -0.6, -0.16, 0.15], [0, -0.86, -0.13, 0.08], [0, -0.98, -0.1, 0.0]], { seg: 6, colFn: () => chit(0.005) });
    // whip antennae
    for (const sg of [-1, 1]) addTube(body, [[0.04 * sg, 0.38, 0.2, 0.012], [0.14 * sg, 0.62, 0.3, 0.008], [0.3 * sg, 0.76, 0.22, 0.0]], { seg: 3, colFn: () => chit(0.03) });
    // six long, jointed, dangling legs
    for (const sg of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const z = 0.1 - k * 0.1;
        const kx = 0.35 + k * 0.08, ky = 0.22 - k * 0.05;
        addTube(body, [[0.08 * sg, 0.05, z, 0.022], [kx * sg, ky, z + 0.12 - k * 0.12, 0.016], [(kx + 0.12) * sg, -0.45 - k * 0.1, z + 0.18 - k * 0.2, 0.012], [(kx + 0.08) * sg, -1.15 - k * 0.12, z + 0.12 - k * 0.22, 0.0]], { seg: 4, subdiv: 2, colFn: () => chit(0.0) });
      }
    }
    // clusters of ember eyes on the head and glowing pocks on the abdomen
    const em = new MeshBuilder();
    for (const [ex, ey, ez, er] of [[-0.06, 0.34, 0.27, 0.03], [0.06, 0.34, 0.27, 0.03], [-0.03, 0.27, 0.27, 0.02], [0.03, 0.27, 0.27, 0.02], [-0.07, -0.34, 0.03, 0.035], [0.06, -0.48, 0.0, 0.03], [-0.01, -0.62, 0.0, 0.025], [0.07, -0.26, 0.02, 0.02]]) {
      addSphere(em, { x: ex, y: ey, z: ez, r: er, segW: 5, segH: 3, colFn: () => rgba(1.0, 0.66, 0.2, CLS.GLOW) });
    }
    body.append(em.selfLit());
    // motes of darkness drifting round it
    const motes = new MeshBuilder();
    for (let k = 0; k < 10; k++) {
      const r = 0.04 + rng() * 0.06;
      const a = rng() * Math.PI * 2, d = 0.7 + rng() * 0.7;
      addBox(motes, { x: Math.cos(a) * d, y: -0.6 + rng() * 1.4, z: Math.sin(a) * d, sx: r, sy: r, sz: r, rot: rng() * 6, tilt: rng() * 3, col: shade(0.0, CLS.CHAR, 1) });
    }
    body.append(motes);
    this.part(body, this.root, Monster.matSway);
    // torn, angular wings: two pairs of ragged membranes with dark veins
    this.wings = [-1, 1].map((sg) => {
      const pivot = new pc.Entity('wing');
      pivot.setLocalPosition(0.1 * sg, 0.12, 0);
      this.root.addChild(pivot);
      const mb = new MeshBuilder();
      const rag = (pts) => {
        const out = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
          for (let k = 0; k < 3; k++) {
            const t = k / 3;
            const notch = i > 1 && rng() < 0.4 ? 0.55 + rng() * 0.3 : 1; // torn notches
            const x = (ax + (bx - ax) * t) * notch, y = (ay + (by - ay) * t) * notch;
            out.push([x * sg, y, -0.1 * x * x]);
          }
        }
        const l = pts[pts.length - 1];
        out.push([l[0] * sg, l[1], -0.1 * l[0] * l[0]]);
        return out;
      };
      const fore = [[0.05, 0.15], [0.5, 0.75], [1.05, 1.2], [1.45, 1.05], [1.2, 0.55], [0.95, 0.1], [0.55, -0.05], [0.1, -0.02]];
      const hind = [[0.05, -0.05], [0.6, -0.15], [1.15, -0.05], [1.0, -0.45], [0.55, -0.7], [0.12, -0.3]];
      addFan(mb, [0, 0, 0], rag(fore), (t) => shade(0.05 + Math.sin(t * 11) * 0.015, CLS.CHAR, 1));
      addFan(mb, [0, -0.05, 0], rag(hind), () => shade(0.045, CLS.CHAR, 1));
      for (const [vx, vy] of [[1.3, 1.1], [1.0, 0.55], [1.05, -0.3]]) addTube(mb, [[0, 0, 0.01, 0.014], [vx * sg * 0.6, vy * 0.6, 0.01, 0.01], [vx * sg, vy, -0.08, 0.0]], { seg: 3, subdiv: 1, colFn: () => shade(0.0) });
      this.part(mb, pivot, Monster.matDouble);
      return { pivot, s: sg };
    });
    this.reset();
  }

  reset() {
    this.x = this.perch.x; this.z = this.perch.z; this.y = this.perch.y;
    this.set('perch');
    this.cool = 0;
  }

  update(dt, g, active) {
    this.t += dt;
    this.cool -= dt;
    const L = g.lantern;
    const dp = dist(this.x, this.z, g.player.x, g.player.z);
    let flap = 0.2;
    switch (this.state) {
      case 'perch':
        this.x += (this.perch.x - this.x) * dt; this.z += (this.perch.z - this.z) * dt; this.y += (this.perch.y - this.y) * dt;
        if (active && g.lightOpen && this.cool <= 0 && dp < 7.5) {
          sfx.play('flutter', { x: this.x, z: this.z }, { vol: 1 });
          this.set('drop');
        }
        break;
      case 'drop': {
        flap = 1;
        const d = Math.hypot(L.x - this.x, L.y - this.y, L.z - this.z);
        const sp = Math.min(d, 7 * dt);
        this.x += ((L.x - this.x) / d) * sp; this.y += ((L.y - this.y) / d) * sp; this.z += ((L.z - this.z) / d) * sp;
        if (!g.lightOpen && this.t > 0.3) this.set('flee');
        if (d < 0.5) { this.set('latched'); g.text('mothFirst'); }
        break;
      }
      case 'latched':
        flap = 1.4;
        this.x = L.x + Math.sin(g.time * 9) * 0.08; this.y = L.y + 0.15; this.z = L.z + Math.cos(g.time * 7) * 0.08;
        g.latched++;
        g.hurt(0.1 * dt, 'moth');
        if (this.t % 0.9 < dt) sfx.play('flutter', { x: this.x, z: this.z }, { vol: 0.6 });
        if (g.shock || g.sprint > 1.4) { if (g.shock) g.text('mothShock'); this.set('flee'); }
        // sated: a moth weakens the flame but never drinks it to nothing on its own
        else if (g.flame < 0.22 || this.t > 8) this.set('flee');
        break;
      case 'flee': {
        flap = 1;
        this.cool = 12;
        this.x += (this.perch.x - this.x) * dt * 1.5; this.z += (this.perch.z - this.z) * dt * 1.5; this.y += (this.perch.y + 1 - this.y) * dt * 1.5;
        if (this.t > 2.5) this.set('perch');
        break;
      }
    }
    if (dp < 5 && this.state !== 'perch') g.tension = Math.max(g.tension, 0.6);
    const beat = Math.sin(g.time * (8 + flap * 14)) * (20 + flap * 45);
    for (const w of this.wings) w.pivot.setLocalEulerAngles(0, 0, beat * w.s);
    this.root.setPosition(this.x, this.y, this.z);
    this.root.setEulerAngles(0, (g.time * 40) % 360, 0);
  }
}

// ============================================================ BELL-WARDEN (the Blind Executioner)
export class BellWarden extends Monster {
  constructor(app, layers) {
    super(app, layers, 'bellWarden');
    const S = LAYOUT.shrine;
    this.centre = { x: S.x, z: S.z };
    const rng = mulberry(5150);
    const mb = new MeshBuilder();
    // hulking robed body with broad, sloping shoulders
    addLathe(mb, [[0.92, 0], [1.0, 0.25], [0.88, 0.9], [0.84, 1.5], [0.95, 2.05], [1.06, 2.45], [0.75, 2.75], [0.35, 2.95], [0.0, 3.0]], {
      seg: 16, sx: 1.25, sz: 0.78, jitter: 0.08, rng, colFn: (t) => shade(0.01 + t * 0.02, CLS.CHAR, (1 - t) * 0.4),
    });
    // tattered hem strips
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const x = Math.cos(a) * 1.18, z = Math.sin(a) * 0.74;
      addTube(mb, [[x, 0.75, z, 0.09], [x * 1.04 + (rng() - 0.5) * 0.1, 0.4, z * 1.04, 0.07], [x * 1.06, 0.06 + rng() * 0.12, z * 1.06, 0.02]], { seg: 4, colFn: (t) => shade(0.012, CLS.CHAR, 0.5 + t * 0.5) });
    }
    // heavy arms; the right one drags the chain and the iron censer-hook
    for (const s of [-1, 1]) addTube(mb, [[1.05 * s, 2.5, 0.0, 0.24], [1.22 * s, 1.95, 0.1, 0.2], [1.25 * s, 1.4, 0.2, 0.17], [1.18 * s, 1.05, 0.22, 0.14], [1.15 * s, 0.92, 0.24, 0.06]], { seg: 8, colFn: () => shade(0.02) });
    const iron = () => rgba(0.1, 0.1, 0.11, CLS.STONE);
    addTube(mb, [[1.15, 0.95, 0.24, 0.035], [1.22, 0.6, -0.3, 0.035], [1.2, 0.28, -0.95, 0.035], [1.14, 0.1, -1.6, 0.035]], { seg: 4, colFn: iron });
    addTube(mb, [[1.14, 0.1, -1.6, 0.07], [1.1, 0.08, -2.1, 0.07], [1.04, 0.3, -2.45, 0.06], [0.98, 0.58, -2.32, 0.05], [0.97, 0.62, -2.08, 0.02]], { seg: 6, colFn: iron });
    // the massive cracked bronze bell worn over the head
    addLathe(mb, [[0.0, 3.62], [0.3, 3.6], [0.5, 3.5], [0.58, 3.25], [0.62, 2.95], [0.72, 2.6], [0.9, 2.38], [0.95, 2.3], [0.9, 2.27]].reverse().map(([r, y]) => [r, y]), {
      seg: 18, colFn: (t) => rgba(0.25 - t * 0.04, 0.18 - t * 0.03, 0.1, CLS.STONE),
    });
    addTube(mb, [[0, 3.6, 0, 0.0], [0, 3.72, 0, 0.12], [0, 3.86, 0, 0.0]], { seg: 6, colFn: () => rgba(0.2, 0.15, 0.09, CLS.STONE) });
    this.body = new pc.Entity('wardenBody');
    this.root.addChild(this.body);
    // ember light leaking through the crack in the bell
    const crack = new MeshBuilder();
    addTube(crack, [[0.35, 3.35, 0.49, 0.028], [0.45, 3.0, 0.57, 0.024], [0.5, 2.75, 0.65, 0.02], [0.62, 2.45, 0.74, 0.014]], { seg: 4, colFn: () => rgba(1.0, 0.6, 0.18, CLS.GLOW) });
    mb.append(crack.selfLit());
    this.part(mb, this.body, Monster.matSway);
    this.reset();
  }

  reset() {
    this.x = this.centre.x + 6; this.z = this.centre.z;
    this.ang = 0;
    this.set('patrol');
    this.stepT = 0;
    this.leash = 17;
  }

  update(dt, g, world) {
    this.t += dt;
    const p = g.player;
    const dp = dist(this.x, this.z, p.x, p.z);
    let speed = 0;
    // blind: hunts purely by sound
    for (const ev of g.events) {
      const de = dist(this.x, this.z, ev.x, ev.z);
      if (de > ev.r) continue;
      if (dist(ev.x, ev.z, this.centre.x, this.centre.z) > this.leash + 4) continue;
      this.tx = ev.x; this.tz = ev.z;
      const charge = de < 7 || ev.kind === 'gate';
      if (this.state !== 'charge' || charge) {
        if (charge && this.state !== 'charge') sfx.play('toll', { x: this.x, z: this.z }, { vol: 1.2, maxDist: 70 });
        this.set(charge ? 'charge' : 'investigate');
      }
    }
    switch (this.state) {
      case 'patrol': {
        this.ang += dt * 0.12;
        const r = 6.2;
        this.moveTo(this.centre.x + Math.cos(this.ang) * r, this.centre.z + Math.sin(this.ang) * r, 1.2, dt);
        speed = 1.2;
        break;
      }
      case 'investigate': {
        const left = this.moveTo(this.tx, this.tz, 2.3, dt);
        speed = 2.3;
        if (left < 0.6) this.set('listen');
        break;
      }
      case 'charge': {
        if (this.t < (this.chargeDelay || 0)) break; // the bell tolls before it moves
        const left = this.moveTo(this.tx, this.tz, 5.2, dt);
        speed = 5.2;
        if (left < 0.6) { this.chargeDelay = 0; this.set('listen'); }
        break;
      }
      case 'listen':
        if (this.t > 6) { this.ang = Math.atan2(this.z - this.centre.z, this.x - this.centre.x); this.set('patrol'); }
        break;
    }
    // leash to the plaza
    const dc = dist(this.x, this.z, this.centre.x, this.centre.z);
    if (dc > this.leash) {
      this.x = this.centre.x + ((this.x - this.centre.x) / dc) * this.leash;
      this.z = this.centre.z + ((this.z - this.centre.z) / dc) * this.leash;
    }
    if (dp < 1.7) g.kill('warden');
    if (dp < 9) g.tension = Math.max(g.tension, 1 - dp / 9);
    // heavy footfalls: heard, and seen as rings in the scorched sight
    if (speed > 0) {
      this.stepT -= dt * (0.6 + speed * 0.35);
      if (this.stepT <= 0) {
        this.stepT = 1;
        sfx.play('wardenStep', { x: this.x, z: this.z }, { vol: 0.8 });
        if (speed > 3 && Math.random() < 0.3) sfx.play('scrape', { x: this.x, z: this.z }, { vol: 0.6 });
        g.ring(this.x, this.z, 4, 0.6);
      }
    }
    const sway = Math.sin(g.time * (1.5 + speed)) * (3 + speed);
    this.body.setLocalEulerAngles(0, 0, sway);
    this.root.setPosition(this.x, SHRINE_Y + Math.abs(Math.sin(g.time * (1.5 + speed))) * 0.05, this.z);
    this.root.setEulerAngles(0, (this.yaw * 180) / Math.PI, 0);
  }
}

// tiny deterministic rng for mesh variety
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// a fixed stream for the facet shading, so every load cuts the same slate
Monster.rng = mulberry(90210);

export function initMonsterMaterials() {
  Monster.mat = worldMaterial({});
  Monster.matDouble = worldMaterial({ doubleSided: true });
  Monster.matSway = worldMaterial({ sway: 0.3, doubleSided: true });
  Monster.matEmber = worldMaterial({ emissive: 2.4 });
}
