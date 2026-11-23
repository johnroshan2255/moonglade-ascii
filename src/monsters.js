// The wardens of the glade. Silhouette meshes + small state machines.
// Every monster reads the shared "senses" object built by gameplay.js each frame:
//   g.player {x,z,y}, g.speed, g.still (seconds), g.lightOpen, g.lightRadius, g.events (sounds
//   this frame: {x,z,r,kind}), g.time, g.lantern {x,y,z}; and calls g.hurt(), g.kill(), g.ring().
import * as pc from 'playcanvas';
import { CLS, worldMaterial } from './shaders.js';
import { MeshBuilder, rgba, addTube, addLathe, addFan, addSphere } from './meshes.js';
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
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mb.build(this.app.graphicsDevice), mat)], layers: this.layers, castShadows: false, receiveShadows: false });
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
    // hunched, hooded body: a lathe bent forward over the top third
    const hunch = (x, y, z) => { const k = Math.max(0, (y - 1.5) / 1.7); return [x, y - k * k * 0.25, z + k * k * 0.75]; };
    const body = new MeshBuilder();
    addLathe(body, [[0.72, 0], [0.84, 0.2], [0.78, 0.7], [0.64, 1.4], [0.55, 2.0], [0.52, 2.5], [0.44, 2.85], [0.26, 3.1], [0.0, 3.2]], {
      seg: 14, sz: 0.8, jitter: 0.12, rng, warp: hunch, colFn: (t) => shade(0.015 + t * 0.02, CLS.CHAR, t * 0.15),
    });
    // the drooping sack-like hood where a head should be
    addTube(body, [[0, 2.95, 0.55, 0.3], [0, 2.85, 0.85, 0.3], [0, 2.6, 1.05, 0.24], [0, 2.25, 1.1, 0.12], [0, 2.05, 1.05, 0.02]], { seg: 9, colFn: () => shade(0.025) });
    // curtains of wet moss and cobweb: dozens of hanging strands
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2 + rng() * 0.2;
      const y0 = 2.3 + rng() * 0.6;
      let [x, y, z] = hunch(Math.cos(a) * 0.55, y0, Math.sin(a) * 0.45);
      const pts = [[x, y, z, 0.06 + rng() * 0.03]];
      const drop = y0 - (0.1 + rng() * 0.6);
      for (let k = 1; k <= 5; k++) {
        x += Math.cos(a) * 0.05 + (rng() - 0.5) * 0.12;
        z += Math.sin(a) * 0.05 + (rng() - 0.5) * 0.12;
        y -= drop / 5;
        pts.push([x, y, z, (0.055 + rng() * 0.02) * (1 - k / 6)]);
      }
      addTube(body, pts, { seg: 4, subdiv: 2, colFn: (t) => shade(0.02 + t * 0.03, CLS.FOLIAGE, 0.2 + t * 0.8) });
    }
    this.part(body, this.root, Monster.matSway);
    // long jointed arms ending in cupped snuffer palms and long fingers
    this.arms = [-1, 1].map((s) => {
      const pivot = new pc.Entity('arm');
      const [sx, sy, sz] = hunch(0.5 * s, 2.75, 0.2);
      pivot.setLocalPosition(sx, sy, sz);
      this.root.addChild(pivot);
      const mb = new MeshBuilder();
      addTube(mb, [[0, 0, 0, 0.075], [0.12 * s, -0.45, 0.22, 0.06], [0.16 * s, -0.95, 0.32, 0.048], [0.12 * s, -1.45, 0.38, 0.04], [0.08 * s, -1.85, 0.42, 0.035]], { seg: 6, colFn: () => shade(0.02) });
      // the snuffer: a wide cupped palm opening downward
      addLathe(mb, [[0.04, 0.02], [0.16, -0.04], [0.3, -0.16], [0.36, -0.28], [0.35, -0.31]], { seg: 10, x: 0.08 * s, y: -1.88, z: 0.44, colFn: () => shade(0.03) });
      for (let f = 0; f < 4; f++) {
        const fa = (f / 4) * Math.PI * 2 + 0.4;
        const fx = 0.08 * s + Math.cos(fa) * 0.32, fz = 0.44 + Math.sin(fa) * 0.32;
        addTube(mb, [[fx, -2.16, fz, 0.022], [fx + Math.cos(fa) * 0.06, -2.4, fz + Math.sin(fa) * 0.06, 0.016], [fx + Math.cos(fa) * 0.02, -2.62, fz + Math.sin(fa) * 0.02, 0.004]], { seg: 4, subdiv: 2, colFn: () => shade(0.02) });
      }
      this.part(mb, pivot, Monster.matDouble);
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
    const bone = (v = 0) => shade(0.03 + v);
    const mb = new MeshBuilder();
    // arched, starved spine: tail root -> withers -> neck -> skull
    addTube(mb, [[0, 0.76, -0.6, 0.05], [0, 0.86, -0.2, 0.06], [0, 0.9, 0.25, 0.07], [0, 1.0, 0.55, 0.06], [0, 1.1, 0.74, 0.05]], { seg: 6, colFn: () => bone() });
    // long narrow skull, jaw, ears
    addTube(mb, [[0, 1.1, 0.7, 0.1], [0, 1.07, 0.88, 0.095], [0, 1.0, 1.1, 0.06], [0, 0.95, 1.26, 0.028]], { seg: 7, colFn: () => bone(0.01) });
    addTube(mb, [[0, 1.02, 0.78, 0.05], [0, 0.95, 1.0, 0.04], [0, 0.91, 1.18, 0.018]], { seg: 5, colFn: () => bone() });
    for (const s of [-1, 1]) addTube(mb, [[0.05 * s, 1.15, 0.76, 0.035], [0.09 * s, 1.26, 0.68, 0.025], [0.07 * s, 1.32, 0.58, 0.003]], { seg: 4, colFn: () => bone() });
    // hollow ribcage: curved rib hoops, deep at the chest, shallow at the waist
    for (let i = 0; i < 7; i++) {
      const z = 0.36 - i * 0.09;
      const depth = 0.45 - i * 0.035;
      const half = 0.17 - i * 0.012;
      for (const s of [-1, 1]) {
        addTube(mb, [[0, 0.88, z, 0.018], [half * s, 0.78, z + 0.02, 0.016], [(half - 0.02) * s, 0.88 - depth * 0.7, z + 0.04, 0.014], [0, 0.88 - depth, z + 0.06, 0.012]], { seg: 4, subdiv: 3, capEnd: false, colFn: () => bone(0.02) });
      }
    }
    // tucked belly line, pelvis, whip tail, wire whiskers
    addTube(mb, [[0, 0.43, 0.42, 0.02], [0, 0.5, 0.0, 0.016], [0, 0.66, -0.35, 0.014], [0, 0.74, -0.52, 0.02]], { seg: 4, colFn: () => bone() });
    addLathe(mb, [[0.0, -0.08], [0.1, -0.04], [0.12, 0.03], [0.0, 0.08]], { seg: 6, y: 0.78, z: -0.5, sx: 1.3, colFn: () => bone() });
    addTube(mb, [[0, 0.76, -0.6, 0.03], [0, 0.7, -0.85, 0.022], [0, 0.55, -1.0, 0.012], [0.05, 0.42, -1.05, 0.003]], { seg: 4, colFn: () => bone() });
    for (const s of [-1, 1]) for (let w = 0; w < 2; w++) addTube(mb, [[0.025 * s, 0.97, 1.2, 0.006], [0.18 * s, 0.98 + w * 0.04, 1.28, 0.004], [0.36 * s, 0.95 + w * 0.08, 1.33, 0.002]], { seg: 3, subdiv: 2, colFn: () => bone(0.08) });
    this.part(mb, this.body);
    // swallowed sparks glowing inside the ribcage
    const em = new MeshBuilder();
    for (let i = 0; i < 4; i++) addSphere(em, { y: 0.6 + (i % 2) * 0.12, z: 0.26 - i * 0.14, x: (i % 2 ? 0.03 : -0.03), r: 0.05, segW: 5, segH: 3, colFn: () => rgba(1.0, 0.5, 0.15, CLS.GLOW) });
    this.part(em, this.body, Monster.matEmber);
    // four jointed legs (front: straight; hind: dog hock bent backward)
    this.legs = [];
    const leg = (x, y, z, hind, phase) => {
      const pivot = new pc.Entity('leg');
      pivot.setLocalPosition(x, y, z);
      this.body.addChild(pivot);
      const lb = new MeshBuilder();
      const pts = hind
        ? [[0, 0, 0, 0.07], [0, -0.22, 0.13, 0.045], [0, -0.48, -0.1, 0.026], [0, -0.74, -0.03, 0.022], [0, -0.78, 0.06, 0.028]]
        : [[0, 0, 0, 0.05], [0, -0.26, 0.04, 0.034], [0, -0.52, -0.02, 0.024], [0, -0.74, 0.01, 0.021], [0, -0.8, 0.07, 0.028]];
      addTube(lb, pts, { seg: 5, colFn: () => bone() });
      this.part(lb, pivot);
      this.legs.push({ pivot, phase, hind });
    };
    leg(-0.1, 0.84, 0.3, false, 0); leg(0.1, 0.84, 0.3, false, 0.6);
    leg(-0.1, 0.78, -0.48, true, Math.PI); leg(0.1, 0.78, -0.48, true, Math.PI + 0.6);
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
    // segmented furry body: abdomen -> thorax -> head
    addTube(body, [[0, -0.95, -0.05, 0.03], [0, -0.7, -0.03, 0.1], [0, -0.4, 0, 0.13], [0, -0.12, 0, 0.16], [0, 0.08, 0.02, 0.15], [0, 0.2, 0.05, 0.09], [0, 0.3, 0.08, 0.1], [0, 0.4, 0.1, 0.02]], {
      seg: 8, colFn: (t) => shade(0.02 + t * 0.03),
    });
    // feathered antennae
    for (const s of [-1, 1]) {
      const ant = [[0.03 * s, 0.38, 0.12, 0.012], [0.14 * s, 0.56, 0.22, 0.01], [0.28 * s, 0.66, 0.18, 0.006]];
      addTube(body, ant, { seg: 3, colFn: () => shade(0.05) });
      for (let k = 0; k < 6; k++) {
        const t = 0.25 + k * 0.12;
        const bx = 0.03 * s + (0.25 * s) * t, by = 0.38 + 0.28 * t, bz = 0.12 + 0.08 * t;
        addTube(body, [[bx, by, bz, 0.005], [bx + 0.03 * s, by + 0.06, bz + 0.05, 0.002]], { seg: 3, subdiv: 1, colFn: () => shade(0.05) });
      }
      // dangling legs
      for (let k = 0; k < 3; k++) addTube(body, [[0.08 * s, -0.05 - k * 0.12, 0.06, 0.014], [0.2 * s, -0.25 - k * 0.12, 0.12, 0.01], [0.18 * s, -0.55 - k * 0.1, 0.1, 0.004]], { seg: 3, colFn: () => shade(0.03) });
    }
    this.part(body);
    // tattered cape-wings: ragged membranes that droop like a cloak
    this.wings = [-1, 1].map((s) => {
      const pivot = new pc.Entity('wing');
      pivot.setLocalPosition(0.1 * s, 0.05, 0);
      this.root.addChild(pivot);
      const mb = new MeshBuilder();
      const rag = (pts) => {
        const out = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
          for (let k = 0; k < 3; k++) {
            const t = k / 3;
            const notch = i > 1 && rng() < 0.35 ? 0.65 + rng() * 0.25 : 1; // torn notches
            const x = (ax + (bx - ax) * t) * notch, y = (ay + (by - ay) * t) * notch;
            out.push([x * s, y, -0.12 * x * x]);
          }
        }
        const l = pts[pts.length - 1];
        out.push([l[0] * s, l[1], -0.12 * l[0] * l[0]]);
        return out;
      };
      const fore = [[0.05, 0.12], [0.45, 0.4], [0.95, 0.48], [1.3, 0.3], [1.25, -0.02], [1.0, -0.3], [0.65, -0.5], [0.3, -0.55], [0.08, -0.25]];
      const hind = [[0.05, -0.15], [0.55, -0.3], [0.85, -0.65], [0.6, -1.0], [0.3, -0.95], [0.08, -0.45]];
      addFan(mb, [0, 0, 0], rag(fore), (t) => shade(0.015 + Math.sin(t * 9) * 0.006, CLS.CHAR, 1));
      addFan(mb, [0, -0.1, 0], rag(hind), () => shade(0.012, CLS.CHAR, 1));
      this.part(mb, pivot, Monster.matDouble);
      return { pivot, s };
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
    addTube(mb, [[0.35, 3.35, 0.47, 0.018], [0.45, 3.0, 0.55, 0.015], [0.5, 2.75, 0.63, 0.012], [0.62, 2.45, 0.72, 0.01]], { seg: 3, colFn: () => shade(-0.05) }); // the crack
    this.body = new pc.Entity('wardenBody');
    this.root.addChild(this.body);
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

export function initMonsterMaterials() {
  Monster.mat = worldMaterial({});
  Monster.matDouble = worldMaterial({ doubleSided: true });
  Monster.matSway = worldMaterial({ sway: 0.3, doubleSided: true });
  Monster.matEmber = worldMaterial({ emissive: 2.4 });
}
