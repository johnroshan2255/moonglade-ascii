// HOLLOW WICK: rules of the glade. Owns the flame, the lights, puzzles, monsters, sound events,
// checkpoints / save, death and the two endings. game.js calls update() once per frame.
import * as pc from 'playcanvas';
import { worldMaterial } from './shaders.js';
import { wispMesh, emberCoreMesh, heartMesh } from './meshes.js';
import { LAYOUT, ITEMS, SPAWNS, LINES, regionOf } from './story.js';
import { WORLD, SHRINE_Y } from './world.js';
import { VeilMother, AshHound, GloomMoth, BellWarden, initMonsterMaterials } from './monsters.js';
import * as sfx from './audio.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'hollowwick.save.v1';
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

const ONCE_LINES = {
  chimeHint: 'Low to high. Count the notches cut into each post.',
  followEmber: 'Your ember knows the way. Follow its spark.',
  stillWorks: 'It cannot see you when you are still.',
  mothFirst: 'A moth drinks your flame. Sprint, or shutter the lantern and let it flare.',
};

export class Gameplay {
  constructor({ app, world, player, props, layers, cam, ascii, toast, isTouch }) {
    this.app = app;
    this.world = world;
    this.player = player;
    this.props = props;
    this.cam = cam;
    this.ascii = ascii;
    this.toast = toast;
    this.isTouch = isTouch;
    this.time = 0;

    // ------------------------------------------------ state (saved)
    this.s = {
      cp: 0, items: [], chimes: false, valves: [false, false], arch: false,
      beacons: [false, false, false, false], carried: 0, read: [],
    };
    // ------------------------------------------------ transient
    this.flame = 1;
    this.lastHurt = -10;
    this.shutterT = 0;
    this.flashT = 0;
    this.sprint = 0;
    this.still = 0;
    this.dying = 0;
    this.ending = null;
    this.chimeSeq = [];
    this.archHold = 0;
    this.mire = { x: WORLD.pond.x, z: WORLD.pond.z, alert: 0, warned: false, churn: 0 };
    this.mercyT = 0;
    this.ignite = -1; // time since the 4th core went in
    this.events = [];
    this.rings = [0, 0, 0].map(() => ({ x: 0, z: 0, r: 0, a: 0, max: 0, speed: 0 }));
    this.ringI = 0;
    this.said = new Set();
    this.paused = false;
    this.fogScale = 1;
    this.haze = new Float32Array([0.3, 0.355, 0.36]); // cold teal-grey
    this.ringGain = 1;
    this.deathCount = {};
    this.hintCount = {};
    this.progressT = 0; // seconds since the player last made progress
    this.wrongChimes = 0;
    this.guideT = -1;
    this.lastObjective = '';
    this.lastRegion = '';
    this.lightRadius = 7;
    this.lightWarm = 1;
    this.slow = 1;
    this._lp = new pc.Vec3();

    // senses shared with the monsters (reused object)
    this.g = {
      player: player.pos, lantern: { x: 0, y: 0, z: 0 }, events: this.events,
      speed: 0, still: 0, lightOpen: true, lightRadius: 7, time: 0, tension: 0,
      latched: 0, shock: false, sprint: 0, slow: 1, archHeld: false,
      hurt: (a, why) => this.hurt(a, why),
      kill: (why) => this.kill(why),
      ring: (x, z, max, a) => this.ring(x, z, max, a, 7),
      text: (k) => this.say(k),
    };

    initMonsterMaterials();
    this.buildItems(layers);
    // the guiding spark: flies from the lantern toward the next goal
    this.guide = new pc.Entity('guide');
    this.guide.addComponent('render', { meshInstances: [new pc.MeshInstance(wispMesh(app.graphicsDevice), worldMaterial({ emissive: 3.2 }))], layers: [layers.world.id], castShadows: false, receiveShadows: false });
    this.guide.enabled = false;
    app.root.addChild(this.guide);
    // faint amber spark over whatever the staff would strike
    this.aimMark = new pc.Entity('aim');
    this.aimMark.addComponent('render', { meshInstances: [new pc.MeshInstance(emberCoreMesh(app.graphicsDevice), worldMaterial({ emissive: 1.6 }))], layers: [layers.world.id], castShadows: false, receiveShadows: false });
    this.aimMark.enabled = false;
    app.root.addChild(this.aimMark);
    this.veils = SPAWNS.veils.map((h) => new VeilMother(app, layers, h));
    this.hounds = SPAWNS.hounds.map((h) => new AshHound(app, layers, h));
    this.moths = SPAWNS.moths.map((m) => new GloomMoth(app, layers, m, world));
    this.warden = new BellWarden(app, layers);
    for (const [x, z] of SPAWNS.sunbeamsNorth) props.makeBeam(x, z, 'north');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      props.makeBeam(LAYOUT.shrine.x + Math.cos(a) * 9, LAYOUT.shrine.z + Math.sin(a) * 9, 'plaza');
    }

    this.ui = {
      objective: $('objective'),
      embers: $('embers'), flame: $('flameBar'), prompt: $('prompt'), fade: $('fade'),
      marks: $('marks'), ending: $('ending'), endText: $('endText'), endArt: $('endArt'),
    };
    this.marks = this.ui.marks.getContext('2d');
    this.setupNotes();
    this.load();
  }

  // ================================================================ lights (items)
  buildItems(layers) {
    const dev = this.app.graphicsDevice;
    const meshes = { spark: wispMesh(dev), core: emberCoreMesh(dev), heart: heartMesh(dev) };
    const mats = { spark: worldMaterial({ emissive: 2.4 }), core: worldMaterial({ emissive: 2.8 }), heart: worldMaterial({ emissive: 2.6 }) };
    this.items = ITEMS.map((def) => {
      let { x, z } = def;
      if (def.at) {
        const v = this.props.valves[Number(def.at.slice(-1))];
        // float just shoreward of the valve
        const ax = WORLD.pond.x - v.x, az = WORLD.pond.z - v.z, l = Math.hypot(ax, az);
        x = v.x - (ax / l) * 1.6; z = v.z - (az / l) * 1.6;
      }
      const e = new pc.Entity(`light-${def.id}`);
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(meshes[def.kind], mats[def.kind])], layers: [layers.world.id, layers.reflect.id], castShadows: false, receiveShadows: false });
      this.app.root.addChild(e);
      const y = def.onAltar ? SHRINE_Y + 1.85 : Math.max(this.world.height(x, z), WORLD.waterY) + 1.2;
      return { ...def, x, z, y, e, taken: false, t: 0, phase: def.id * 1.7 };
    });
  }

  itemVisible(it) {
    if (it.taken) return false;
    if (it.reveal === 'valve0') return this.s.valves[0];
    if (it.reveal === 'valve1') return this.s.valves[1];
    return true;
  }

  get coresCollected() { return this.items.filter((i) => i.kind === 'core' && i.taken).length; }
  get lightsCollected() { return this.items.filter((i) => i.taken).length; }

  // ================================================================ save / load
  save() {
    this.s.items = this.items.filter((i) => i.taken).map((i) => i.id);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.s)); } catch { /* private mode */ }
  }

  load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { /* corrupt */ }
    if (s && s.items) Object.assign(this.s, s);
    for (const it of this.items) if (this.s.items.includes(it.id)) { it.taken = true; it.e.enabled = false; }
    // re-apply finished puzzles instantly
    if (this.s.chimes) { this.props.meadowGate.open = 1; this.world.setWall('A-gate', false); }
    this.s.valves.forEach((d, i) => { if (d) { this.props.valves[i].done = true; this.props.valves[i].progress = 1; } });
    if (this.s.valves[0] && this.s.valves[1]) { this.props.causeway.up = 1; this.world.causewayUp = 1; }
    this.s.beacons.forEach((b, i) => { if (b) this.placeCore(i, true); });
    if (!Array.isArray(this.s.read)) this.s.read = [];
    for (const st of this.props.stones) if (this.s.read.includes(st.id)) this.markRead(st);
    const cp = LAYOUT.checkpoints[this.s.cp] || LAYOUT.checkpoints[0];
    this.player.teleport(cp.x, cp.z, Math.PI + cp.yaw);
    this.cam.yaw = cp.yaw;
    this.hasSave = !!s && (s.items?.length > 0 || s.cp > 0);
  }

  static clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* */ }
  }

  // ================================================================ feedback helpers
  say(key, secs = 3.2) {
    if (this.said.has(key)) return;
    this.said.add(key);
    const line = LINES[key] || ONCE_LINES[key] || key;
    this.toast(line, secs);
  }

  /** A sound monsters can hear. r = how far it carries. */
  sound(x, z, r, kind, visible = true) {
    this.events.push({ x, z, r, kind });
    if (visible) this.ring(x, z, Math.min(r, 14), 1, 9);
  }

  ring(x, z, max, a = 1, speed = 9) {
    const R = this.rings[this.ringI];
    this.ringI = (this.ringI + 1) % this.rings.length;
    R.x = x; R.z = z; R.r = 0.2; R.a = a; R.max = max; R.speed = speed;
  }

  hurt(amount, why) {
    if (this.dying || this.ending) return;
    // quiet assist: after repeated recent deaths to the same thing, it hurts less
    const recent = (this.recentDeaths || []).filter((d) => d[1] === why && this.time - d[0] < 150).length;
    if (recent >= 2) amount *= recent >= 4 ? 0.4 : 0.65;
    this.flame -= amount;
    this.lastHurt = this.time;
    if (why === 'hound' || amount > 0.2) {
      try { navigator.vibrate?.(60); } catch { /* */ }
      document.body.classList.add('hit');
      setTimeout(() => document.body.classList.remove('hit'), 180);
    }
    if (this.flame <= 0) this.kill(why);
  }

  kill(why) {
    if (this.dying || this.ending) return;
    this.flame = 0;
    this.dying = 0.001;
    this.deathWhy = why;
    (this.recentDeaths = this.recentDeaths || []).push([this.time, why]);
    try { navigator.vibrate?.([90, 60, 220]); } catch { /* */ }
    sfx.play(why === 'warden' ? 'toll' : 'snuff');
    sfx.play('death');
    this.toast(LINES.snuffed, 2.4);
  }

  /** What to tell the player after a death, more explicit each time it repeats. */
  deathAdvice(why) {
    const t = this.isTouch;
    const SH = t ? 'hold SHUTTER' : 'hold Space';
    const ST = t ? 'tap STAFF' : 'press E';
    const cap = (str) => str[0].toUpperCase() + str.slice(1);
    const n = (this.deathCount[why] = (this.deathCount[why] || 0) + 1);
    const A = {
      hound: ['They hunt what moves in the grass.', 'When one freezes and growls, stop. Do not move until it leaves.'],
      mire: ['She rises to light and noise in the water.', `In the lake: ${SH}, crank a little, then stop and stay still until the water calms.`],
      veil: ['The tall ones smother any light they see.', `${SH} to hide from them, or ${ST} at a stone to send them away.`],
      warden: ['The bell-headed one is blind. It hears your steps.', `Sneak (${t ? 'tilt the stick lightly' : 'hold C'}), and ${ST} at the fallen bell to lure it away.`],
      moth: ['A moth drank the flame.', `Sprint, or ${SH} for a moment and let go: the flare shakes it off.`],
      sun: ['The white light burns the ember.', 'Keep out of the pale shafts of light.'],
    };
    const lines = A[why];
    if (!lines) return;
    setTimeout(() => this.toast(cap(n >= 2 ? lines[1] : lines[0]), n >= 2 ? 6 : 4), 400);
  }

  respawn() {
    this.deathAdvice(this.deathWhy);
    const cp = LAYOUT.checkpoints[this.s.cp];
    this.player.teleport(cp.x, cp.z, Math.PI + cp.yaw);
    this.cam.yaw = cp.yaw;
    this.player.dead = 0;
    this.flame = 1;
    this.dying = 0;
    this.mire.alert = 0;
    this.mercyT = 0;
    for (const m of [...this.veils, ...this.hounds, ...this.moths, this.warden]) m.reset();
    this.props.valves.forEach((v) => { if (!v.done) v.progress = 0; });
    if (!this.s.arch) { this.props.arch.open = 0; this.world.setWall('C-arch', true); }
    this.chimeSeq.length = 0;
  }

  // ================================================================ interactions
  nearestTarget(maxD, cone) {
    const p = this.player.pos;
    // aim: camera forward (where the player is looking on screen)
    const fx = -Math.sin(this.cam.yaw), fz = -Math.cos(this.cam.yaw);
    let best = null, bestScore = 1e9;
    for (const t of this.props.targets) {
      const dx = t.x - p.x, dz = t.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > maxD + (t.kind === 'rock' ? 0 : 4) || d < 0.01) continue; // a struck bell carries further
      const dot = (dx * fx + dz * fz) / d;
      if (cone && dot < 0.35 && d > 2.6) continue;
      // iron plates, bells and chimes are what players mean to hit: they win over plain rocks
      const score = d - dot * 3 - (t.kind === 'rock' ? 0 : 12); // any faced iron target beats every rock
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /** What the staff would hit right now: { chime } | { target } | null. */
  aim() {
    const p = this.player.pos;
    const fx = -Math.sin(this.cam.yaw), fz = -Math.cos(this.cam.yaw);
    let chime = null, best = 1e9;
    for (const c of this.props.chimes) {
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
      if (d > 2.6) continue;
      const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      const score = d - facing * 1.2;
      if (score < best) { best = score; chime = c; }
    }
    if (chime) return { chime };
    const t = this.nearestTarget(11, true);
    return t ? { target: t } : null;
  }

  strike() {
    const p = this.player.pos;
    this.player.strikeT = 0.35;
    // chimes need to be in reach
    const a = this.aim(); // same rule as the on-screen aim marker
    if (a && a.chime) return this.hitChime(a.chime);
    const t = a && a.target;
    if (!t) {
      // nothing to throw the sound against: it rings out right here
      sfx.play('staff', p, { vol: 0.9 });
      this.sound(p.x, p.z, 8, 'staff');
      return;
    }
    const metal = t.kind === 'metal' || t.kind === 'bell';
    sfx.play(t.kind === 'bell' ? 'toll' : metal ? 'staffMetal' : 'staff', t, { vol: 1.1, maxDist: 50 });
    sfx.play('staff', p, { vol: 0.25 });
    this.sound(t.x, t.z, t.kind === 'bell' ? 30 : t.kind === 'metal' ? 24 : 16, 'staff');
  }

  hitChime(c) {
    c.swing = 1;
    sfx.play('chime', c, { freq: c.freq, vol: 1, maxDist: 45 });
    this.sound(c.x, c.z, 16, 'chime');
    if (this.s.chimes) return;
    const expect = this.chimeSeq.length + 1;
    if (c.rank === expect) {
      this.chimeSeq.push(c.rank);
      if (this.chimeSeq.length === 3) {
        this.progressT = 0;
        this.s.chimes = true;
        this.world.setWall('A-gate', false);
        sfx.play('gate', { x: LAYOUT.wallA.gateX, z: LAYOUT.wallA.z }, { vol: 0.6 });
        this.say('chimeGate');
        this.save();
      }
    } else {
      this.chimeSeq.length = 0;
      setTimeout(() => sfx.play('chimeWrong', c), 350);
      if (++this.wrongChimes >= 2) this.say('chimeHint', 4.5); else this.toast(LINES.chimeWrong, 2);
    }
  }

  placeCore(i, silent = false) {
    const b = this.props.beacons[i];
    if (b.placed) return;
    b.placed = true;
    b.core.enabled = true;
    b.coreMat.setParameter('uEmissive', 1.2);
    if (!silent) {
      this.s.beacons[i] = true;
      this.s.carried--;
      sfx.play('pickupCore', b, { vol: 0.8 });
      this.say('placeCore', 2.5);
      this.save();
    }
  }

  // ================================================================ guidance
  /** Where the story wants the player next (never shown as a marker, only hinted). */
  objective() {
    const s = this.s, pr = this.props, p = this.player.pos;
    const reg = regionOf(p.x, p.z);
    // an ember waiting in the region you are in comes first
    const core = this.items.find((i) => i.kind === 'core' && !i.taken && this.itemVisible(i) && regionOf(i.x, i.z) === reg);
    if (core) return { key: `core${core.id}`, x: core.x, z: core.z, label: 'an ember in the fog', hint: 'An ember still glows somewhere close.' };
    if (!s.chimes) return { key: 'chimes', x: -6.5, z: 26, label: 'the three chimes', hint: 'Three chimes lock the meadow gate. Strike them, low to high.' };
    if (reg === 'south') return { key: 'gate', x: LAYOUT.wallA.gateX, z: LAYOUT.wallA.z - 2, label: 'through the meadow gate', hint: 'The meadow gate is open. Go north, to the lake.' };
    const v = pr.valves.find((x) => !x.done);
    if (v) return { key: `valve${v.i}`, x: v.x, z: v.z, label: 'the valves in the shallows', hint: 'Two iron valves stand in the shallows. Hide your light before you wade in.' };
    if (reg === 'lake') return { key: 'cross', x: LAYOUT.causeway.x, z: LAYOUT.causeway.z0, label: 'the risen stones', hint: 'The old stones have risen. Cross the lake.' };
    if (!s.arch) return { key: 'arch', x: LAYOUT.wallC.archX, z: LAYOUT.wallC.z + 5, label: 'the sealed arch', hint: 'Two plates hold the arch. Strike the iron, hide your light, and let the tall ones come.' };
    const left = this.items.find((i) => i.kind === 'core' && !i.taken && this.itemVisible(i));
    if (left && regionOf(left.x, left.z) === 'north') return { key: `core${left.id}`, x: left.x, z: left.z, label: 'the last ember', hint: 'One more ember waits near the shrine.' };
    if (pr.beacons.some((b) => !b.placed)) return { key: 'shrine', x: LAYOUT.shrine.x, z: LAYOUT.shrine.z, label: 'the stone lanterns', hint: 'Bring the embers to the four stone lanterns. The tall one hunts by sound.' };
    return { key: 'exit', x: LAYOUT.exitGate.x, z: LAYOUT.exitGate.z, label: 'the north gate', hint: 'The gate is open. Run.' };
  }

  /** Send the guiding spark from the lantern toward the objective. */
  showGuide() {
    if (this.guideT >= 0) return;
    this.guideT = 0;
    this.guide.enabled = true;
    sfx.play('pickupSpark', undefined, { vol: 0.25 });
  }

  updateGuide(dt) {
    const o = this.objective();
    if (o.key !== this.lastObjective) {
      this.lastObjective = o.key;
      this.progressT = 0;
      if (this.ui.objective.textContent !== o.label) this.ui.objective.textContent = o.label;
    }
    const p = this.player.pos;
    const reg = regionOf(p.x, p.z);
    if (reg !== this.lastRegion) { this.lastRegion = reg; this.progressT = 0; }
    this.progressT += dt;
    // first steps: show the way once; afterwards whenever the player seems lost
    if (this.time > 9 && !this.said.has('followEmber')) { this.say('followEmber', 4); this.showGuide(); }
    if (this.progressT > 40 && dist(o.x, o.z, p.x, p.z) > 6) {
      this.progressT = 15;
      this.showGuide();
      // each hint at most twice; after that only the spark shows the way
      const n = (this.hintCount[o.key] = (this.hintCount[o.key] || 0) + 1);
      if (n <= 2) this.toast(o.hint, 5);
    }
    if (this.guideT >= 0) {
      this.guideT += dt;
      const L = this.lanternPos;
      const dx = o.x - L.x, dz = o.z - L.z, d = Math.hypot(dx, dz) || 1;
      const k = Math.min(1, this.guideT / 2.6);
      const reach = Math.min(d, 11) * (1 - (1 - k) * (1 - k));
      const gx = L.x + (dx / d) * reach, gz = L.z + (dz / d) * reach;
      const gy = this.world.groundAt(gx, gz) + 1.0 + Math.sin(k * Math.PI) * 1.2;
      this.guide.setPosition(gx, gy, gz);
      const sc = 0.45 * (1 - Math.max(0, (k - 0.75) / 0.25));
      this.guide.setLocalScale(sc, sc, sc);
      if (this.guideT > 2.8) { this.guideT = -1; this.guide.enabled = false; }
    }
  }

  // ================================================================ per frame
  update(dt, input, asciiOn) {
    const P = this.player;
    const p = P.pos;
    const g = this.g;
    this.time += dt;
    this.events.length = 0;
    g.time = this.time;
    g.tension = 0;
    g.latched = 0;
    g.slow = 1;
    g.shock = false;

    // ---------------- dying / ending sequences
    if (this.dying) {
      this.dying += dt;
      P.dead = Math.min(1, this.dying);
      this.ui.fade.style.opacity = String(Math.min(1, this.dying / 1.6));
      if (this.dying > 2.6) {
        this.respawn();
        this.ui.fade.style.opacity = '0';
      }
      return this.lockedFrame(dt);
    }
    if (this.ending) return this.endingFrame(dt);

    // ---------------- lantern (shutter / flash)
    const shut = input.shutter;
    if (shut) {
      if (this.shutterT === 0) sfx.play('shutter');
      this.shutterT += dt;
    } else if (this.shutterT > 0) {
      if (this.shutterT > 0.25) { this.flashT = 0.45; sfx.play('flash'); g.shock = this.nearLanternMoth(); }
      sfx.play('shutter', undefined, { vol: 0.6 });
      this.shutterT = 0;
    }
    this.flashT = Math.max(0, this.flashT - dt);
    g.lightOpen = !shut;
    if (input.sightPressed || this.sightToggled) { g.shock = true; this.sightToggled = false; }

    // ---------------- movement state
    this.still = P.gait === 'still' ? this.still + dt : 0;
    this.sprint = P.gait === 'run' ? this.sprint + dt : 0;
    g.speed = P.speed;
    g.gait = P.gait;
    g.flame = this.flame;
    g.still = this.still;
    g.sprint = this.sprint;
    if (P.stepped) {
      const r = { run: 13, walk: 5.5, sneak: 1.2 }[P.gait] || 0;
      if (r) this.sound(p.x, p.z, r, 'step', P.gait === 'run');
      if (P.gait !== 'sneak') sfx.play(P.wading ? 'splash' : 'step', undefined, { vol: P.gait === 'run' ? 0.7 : 0.35, wet: 0.1 });
    }

    // ---------------- staff: crank valves (hold), place cores (near beacons), else strike
    const valve = this.props.valves.find((v) => !v.done && dist(v.x, v.z, p.x, p.z) < 1.9);
    let cranking = false;
    if (valve && input.staffHeld) {
      cranking = true;
      valve.progress = Math.min(1, valve.progress + dt / 4.5);
      valve.wheel.setLocalEulerAngles(0, valve.progress * 720, 0);
      P.crankT = 0.1;
      this.crankSnd = (this.crankSnd || 0) - dt;
      if (this.crankSnd <= 0) { this.crankSnd = 0.5; sfx.play('valve', valve, { vol: 0.9 }); this.sound(valve.x, valve.z, 9, 'crank'); }
      if (valve.progress >= 1) {
        valve.done = true;
        this.s.valves[valve.i] = true;
        this.say('valveTurned', 2.2);
        sfx.play('gate', valve, { vol: 0.4 });
        this.save();
      }
    } else P.crankT = 0;
    const stone = this.updateStones(p);
    if (stone && !valve && input.staffPressed) this.openNote(stone);
    else if (input.staffPressed && !cranking && !valve) this.strike();
    this.nearStone = stone;
    // aim marker for the staff
    const aim = valve || this.dying ? null : this.aim();
    const at = aim && (aim.chime || aim.target);
    this.aimKind = aim ? (aim.chime ? 'chime' : at.kind) : null;
    this.aimMark.enabled = !!at;
    if (at) {
      const s = 0.22 + Math.sin(this.time * 6) * 0.04;
      this.aimMark.setPosition(at.x, this.world.groundAt(at.x, at.z) + (aim.chime ? 2.55 : at.kind === 'bell' ? 2.1 : 1.6), at.z);
      this.aimMark.setLocalScale(s, s, s);
    }
    const beacon = this.props.beacons.find((b) => !b.placed && dist(b.x, b.z, p.x, p.z) < 2.0);
    if (beacon && this.s.carried > 0) this.placeCore(beacon.i);

    // ---------------- lights
    for (const it of this.items) {
      const vis = this.itemVisible(it);
      if (it.taken) {
        if (it.t < 1) {
          it.t = Math.min(1, it.t + dt * 2.5);
          it.e.setLocalScale(1 - it.t, 1 - it.t, 1 - it.t);
          if (it.t >= 1) it.e.enabled = false;
        }
        continue;
      }
      it.e.enabled = vis;
      if (!vis) continue;
      const bob = Math.sin(this.time * 2 + it.phase) * 0.22;
      it.e.setPosition(it.x, it.y + bob, it.z);
      it.e.setEulerAngles(0, this.time * 50 + it.phase * 30, 0);
      if (dist(it.x, it.z, p.x, p.z) < 1.5) this.collect(it);
    }

    // ---------------- puzzles + guidance
    this.updatePuzzles(dt, p);
    this.updateGuide(dt);
    if (input.guidePressed) this.showGuide();

    // ---------------- monsters
    g.lantern.x = this.lanternPos.x; g.lantern.y = this.lanternPos.y; g.lantern.z = this.lanternPos.z;
    g.lightRadius = this.lightRadius;
    const reg = regionOf(p.x, p.z);
    const plateFree = (veil) => {
      for (const pl of this.props.plates) {
        if (dist(veil.x, veil.z, pl.x, pl.z) > 1.7) continue;
        if (this.veils.some((o) => o !== veil && o.onPlate === pl.i && o.state === 'linger')) return -1;
        return pl.i;
      }
      return -1;
    };
    for (const v of this.veils) v.update(dt, g, this.world, plateFree);
    if (reg === 'south' || this.hounds.some((h) => h.state !== 'prowl')) for (const h of this.hounds) h.update(dt, g, this.world);
    const north = this.lightsCollected >= 6;
    for (const m of this.moths) m.update(dt, g, m.group === 'central' || north);
    if (reg === 'north') this.warden.update(dt, g, this.world);
    // creatures the fog has swallowed are not drawn at all (a perched moth is too small to see from far off)
    const eye = this.ascii.sceneCam.getPosition();
    const reach = this.ascii.sceneCam.camera.farClip;
    const seen = (o, k) => { o.root.enabled = Math.hypot(o.x - eye.x, o.z - eye.z) < reach * k; };
    for (const v of this.veils) seen(v, 1);
    for (const h of this.hounds) seen(h, 1);
    for (const m of this.moths) seen(m, m.state === 'perch' ? 0.5 : 1);
    seen(this.warden, 1);
    if (this.hounds.some((h) => h.state === 'hunt' && reg === 'south')) this.say('freeze');
    this.updateMire(dt, cranking, input);
    this.updateMercy(dt, input);

    // ---------------- sunbeams + thinning fog (the white sky breaking through)
    const prog = this.lightsCollected / 12;
    for (const b of this.props.beams) {
      const want = (b.group === 'north' && north) || (b.group === 'plaza' && this.ignite >= 0) ? 1 : 0;
      b.on += (want - b.on) * Math.min(1, dt * (want ? 0.6 : 2));
      b.e.enabled = b.on > 0.02;
      if (!b.e.enabled) continue;
      if (b.group === 'plaza') {
        const a = Math.atan2(b.bz - LAYOUT.shrine.z, b.bx - LAYOUT.shrine.x) + this.time * 0.12;
        b.x = LAYOUT.shrine.x + Math.cos(a) * (7 + Math.sin(this.time * 0.7 + b.phase) * 2.5);
        b.z = LAYOUT.shrine.z + Math.sin(a) * (7 + Math.sin(this.time * 0.7 + b.phase) * 2.5);
      }
      b.e.setPosition(b.x, this.world.height(b.x, b.z) - 0.5, b.z);
      b.e.setLocalScale(b.on, 1, b.on);
      if (b.on > 0.6 && dist(b.x, b.z, p.x, p.z) < 1.0) { this.hurt(0.5 * dt, 'sun'); this.say('sunbeam', 2); }
    }
    const tear = this.ignite >= 0 ? Math.min(1, this.ignite / 6) : 0;
    this.fogScale = 1 + prog * 0.45 + tear * 0.9;
    // the fog pales (and loses its teal) as the white sky breaks through
    const hz = prog * 0.08 + tear * 0.28;
    this.haze[0] = 0.3 + hz * 1.15; this.haze[1] = 0.355 + hz; this.haze[2] = 0.36 + hz;

    // ---------------- flame: regen, light radius, colour
    if (this.time - this.lastHurt > 3 && this.flame < 1) this.flame = Math.min(1, this.flame + dt * 0.05);
    const latched = g.latched > 0;
    this.lightRadius = shut ? 0.6 : (2.6 + 4.6 * this.flame) * (latched ? 0.35 : 1);
    if (this.flashT > 0) this.lightRadius = Math.max(this.lightRadius, 9 * (this.flashT / 0.45));
    this.lightWarm = latched ? 0 : 1;

    // ---------------- checkpoints
    LAYOUT.checkpoints.forEach((c, i) => {
      if (i > this.s.cp && dist(c.x, c.z, p.x, p.z) < 4) { this.s.cp = i; this.save(); }
    });
    if (!this.s.arch && p.z < LAYOUT.wallC.z - 1.5) { this.s.arch = true; this.save(); }
    if (reg === 'north' && dist(p.x, p.z, LAYOUT.shrine.x, LAYOUT.shrine.z) < 22) this.say('warden', 3.5);

    // ---------------- audio tension (+ a heartbeat that quickens as danger closes in), rings, HUD
    sfx.setTension(g.tension);
    if (g.tension > 0.45) {
      this.beatT = (this.beatT || 0) - dt;
      if (this.beatT <= 0) { this.beatT = 1.15 - g.tension * 0.6; sfx.play('heartbeat', undefined, { vol: 0.35 + g.tension * 0.5, wet: 0 }); }
    }
    for (const R of this.rings) {
      if (R.a <= 0) continue;
      R.r += R.speed * dt;
      R.a = Math.max(0, R.a * (1 - R.r / Math.max(R.max, 0.1)) * 0.995);
      if (R.r > R.max) R.a = 0;
    }
    this.slow = g.slow;
    this.ringGain = asciiOn ? 1.3 : 0.35;
    this.updateHud(valve, beacon);
    this.drawMarks(asciiOn);
  }

  /** Frame while dead: keep the world ticking quietly. */
  lockedFrame() {
    this.slow = 0;
    this.lightRadius = 0.01;
    this.updateHud();
    this.drawMarks(false);
  }

  collect(it) {
    if (it.taken) return;
    this.progressT = 0;
    it.taken = true;
    it.t = 0;
    if (it.kind === 'core') { this.s.carried++; sfx.play('pickupCore', it); }
    else { this.flame = Math.min(1, this.flame + 0.4); sfx.play('pickupSpark', it); }
    this.toast(it.text, 4);
    this.said.add(`item${it.id}`);
    this.save();
  }

  nearLanternMoth() {
    return this.moths.some((m) => m.state === 'latched' || dist(m.x, m.z, this.player.pos.x, this.player.pos.z) < 4);
  }

  updatePuzzles(dt, p) {
    const pr = this.props;
    // chimes swing
    for (const c of pr.chimes) {
      c.swing *= Math.exp(-dt * 2.2);
      c.pivot.setLocalEulerAngles(Math.sin(this.time * 9) * 25 * c.swing, 0, 0);
    }
    // meadow gate sinks into the ground
    const mg = pr.meadowGate;
    mg.open += ((this.s.chimes ? 1 : 0) - mg.open) * Math.min(1, dt * 1.2);
    mg.door.setLocalPosition(0, -2.6 * mg.open, 0);
    // causeway rises once both valves are open
    const cw = pr.causeway;
    const wantUp = this.s.valves[0] && this.s.valves[1] ? 1 : 0;
    if (wantUp && cw.up < 1) {
      if (cw.up === 0) { this.say('causeway'); sfx.play('gate', { x: LAYOUT.causeway.x, z: 4 }, { vol: 0.8 }); }
      cw.up = Math.min(1, cw.up + dt / 3.5);
    }
    cw.group.setLocalPosition(0, -1.5 + cw.up * 0.72, 0);
    this.world.causewayUp = cw.up;
    // pressure plates hold the arch open
    let pressed = 0;
    for (const pl of pr.plates) {
      pl.pressed = this.veils.some((v) => v.onPlate === pl.i && v.state === 'linger') ? 1 : 0;
      pressed += pl.pressed;
      if (dist(pl.x, pl.z, p.x, p.z) < 6) this.say('plateHint');
    }
    this.g.archHeld = pressed === 2 && !this.s.arch;
    const a = pr.arch;
    // never drop the arch on the pilgrim: while they stand in the gateway it stays up
    const W = LAYOUT.wallC;
    const inGate = Math.abs(p.x - W.archX) < W.archHalf + 1.2 && Math.abs(p.z - W.z) < 2.6;
    if (pressed === 2 || this.s.arch || (inGate && a.open > 0.2)) this.archHold = 4; else this.archHold -= dt;
    const prev = a.open;
    a.open += ((this.archHold > 0 ? 1 : 0) - a.open) * Math.min(1, dt * (this.archHold > 0 ? 1.3 : 2.5));
    if (prev < 0.1 && a.open >= 0.1) { this.say('archOpen'); sfx.play('gate', { x: LAYOUT.wallC.archX, z: LAYOUT.wallC.z }, { vol: 0.7 }); }
    a.port.setLocalPosition(0, a.open * 4.2, 0);
    this.world.setWall('C-arch', a.open < 0.75);
    // beacons: all four placed -> ignite, the exit gate rises, the warden charges
    const placed = pr.beacons.filter((b) => b.placed).length;
    if (placed === 4 && this.ignite < 0) this.ignite = 0;
    if (this.ignite >= 0) {
      const was = this.ignite;
      this.ignite += dt;
      // a beat after the 4th ember: the beacons roar, the gate grinds up and the Warden comes
      // (in the frame, not a timer, so the Warden hears it and a pause holds it back)
      if (was < 1.2 && this.ignite >= 1.2) {
        for (const b of pr.beacons) { b.lit = true; b.flame.enabled = true; b.coreMat.setParameter('uEmissive', 3); }
        sfx.play('ignite', LAYOUT.shrine, { vol: 1.2, maxDist: 80 });
        sfx.play('gate', LAYOUT.exitGate, { vol: 1.3, maxDist: 90 });
        sfx.play('sting');
        this.warden.chargeDelay = 1.3;
        this.sound(LAYOUT.shrine.x, LAYOUT.shrine.z, 40, 'gate');
        this.toast(LINES.beacons, 4);
      }
    }
    const eg = pr.exitGate;
    const gateWant = this.ignite > 1.2 ? 1 : 0;
    eg.open += (gateWant - eg.open) * Math.min(1, dt * 0.9);
    eg.slab.setLocalPosition(0, eg.open * 6.6, 0);
    const wall = this.world.walls.find((w) => w.id === 'exit');
    wall.on = eg.open < 0.5;
    // through the gate -> the White Burn
    if (eg.open > 0.5) {
      const nx = -Math.SQRT1_2, nz = -Math.SQRT1_2; // outward (north-west)
      if ((p.x - eg.x) * nx + (p.z - eg.z) * nz > 0.4) this.startEnding('A');
    }
  }

  updateMire(dt, cranking, input) {
    const P = this.player, m = this.mire;
    const p = P.pos;
    const pondD = dist(p.x, p.z, WORLD.pond.x, WORLD.pond.z);
    const inWater = P.wading && pondD < WORLD.pond.r + 3;
    // "looking at the water": camera facing the lake
    const fx = -Math.sin(this.cam.yaw), fz = -Math.cos(this.cam.yaw);
    const tx = WORLD.pond.x - p.x, tz = WORLD.pond.z - p.z, tl = Math.hypot(tx, tz) || 1;
    const looking = (fx * tx + fz * tz) / tl > 0.3;
    if (inWater) {
      // she wakes to warm light, cranking noise, splashing and being watched
      let rate = 0;
      if (this.g.lightOpen) rate += 0.2;
      if (cranking) rate += 0.2;
      if (looking) rate += 0.07;
      if (P.gait === 'walk') rate += 0.06;
      if (P.gait === 'run') rate += 0.2;
      // ...and settles when the light is shut, the cranking stops and you keep still
      const calm = !this.g.lightOpen && !cranking && (P.gait === 'still' || P.gait === 'sneak');
      m.alert += (rate - (calm ? 0.4 : 0)) * dt;
      if (m.alert > 0.35) this.say('waterWarn', 4);
    } else {
      m.alert -= 0.3 * dt;
    }
    m.alert = Math.max(0, Math.min(1.05, m.alert));
    // she glides beneath the player
    const sp = 1.5 + m.alert * 5;
    const ddx = p.x - m.x, ddz = p.z - m.z, dd = Math.hypot(ddx, ddz);
    if (dd > 0.1) { m.x += (ddx / dd) * Math.min(dd, sp * dt); m.z += (ddz / dd) * Math.min(dd, sp * dt); }
    const md = dist(m.x, m.z, WORLD.pond.x, WORLD.pond.z);
    if (md > 8.5) { m.x = WORLD.pond.x + ((m.x - WORLD.pond.x) / md) * 8.5; m.z = WORLD.pond.z + ((m.z - WORLD.pond.z) / md) * 8.5; }
    if (m.alert > 0.3 && m.churn <= 0) { sfx.play('churn', m, { vol: 0.6 + m.alert }); m.churn = 2.2; }
    m.churn -= dt;
    if (inWater) this.g.tension = Math.max(this.g.tension, m.alert);
    if (m.alert >= 1 && inWater) {
      sfx.play('churn', m, { vol: 1.6 });
      if (!this.mireTaught) {
        // the first lunge is a lesson, not a death: she surges, the flame gutters, you are thrown back
        this.mireTaught = true;
        this.flame = Math.max(0.15, this.flame - 0.5); // never lethal the first time
        this.lastHurt = this.time;
        m.alert = 0.3;
        const dx = P.pos.x - WORLD.pond.x, dz = P.pos.z - WORLD.pond.z, dl = Math.hypot(dx, dz) || 1;
        this.player.vel.set((dx / dl) * 9, 0, (dz / dl) * 9);
        this.ring(P.pos.x, P.pos.z, 8, 1, 12);
        this.toast('Get out of the light. Shutter it before you wade in.', 4.5);
      } else this.kill('mire');
    }
    void input;
  }

  updateMercy(dt, input) {
    if (this.coresCollected < 3) return;
    const p = this.player.pos;
    const v = this.veils.find((o) => dist(o.x, o.z, p.x, p.z) < 2.8);
    const ok = v && input.shutter && this.player.gait === 'still';
    for (const o of this.veils) o.mercyWatch = false;
    if (ok) {
      this.mercyT += dt;
      v.mercyWatch = true;
      v.set('smother');
      v.setKneel(Math.max(0, Math.min(1, (this.mercyT - 5) / 7)));
      if (this.mercyT >= 12) this.startEnding('B', v);
    } else {
      this.mercyT = Math.max(0, this.mercyT - dt * 3);
      for (const o of this.veils) if (o.kneel > 0) o.setKneel(Math.max(0, o.kneel - dt));
    }
  }

  // ================================================================ endings
  startEnding(kind, veil) {
    if (this.ending) return;
    this.ending = { kind, t: 0, veil };
    Gameplay.clearSave();
    if (kind === 'A') {
      sfx.play('gate', this.player.pos, { vol: 1.2 });
      document.body.classList.add('whiteout');
    } else {
      sfx.play('snuff', undefined, { vol: 1.2 });
    }
  }

  endingFrame(dt) {
    const e = this.ending;
    e.t += dt;
    this.slow = 0;
    if (e.kind === 'A') {
      this.lightRadius = 7;
      this.fogScale = 3;
      const w = Math.min(1, e.t / 2.5);
      this.haze[0] = this.haze[1] = this.haze[2] = 0.5 + w * 0.5;
      this.ui.fade.style.background = '#f3f1ea';
      this.ui.fade.style.opacity = String(w);
    } else {
      this.lightRadius = Math.max(0.01, 0.6 - e.t);
      this.fogScale = 0.7;
      this.haze[0] = 0.3; this.haze[1] = 0.32; this.haze[2] = 0.34;
      if (e.veil) e.veil.setKneel(1);
      this.ui.fade.style.background = '#050505';
      this.ui.fade.style.opacity = String(Math.min(0.55, e.t / 6));
    }
    if (e.t > 3 && !e.shown) {
      e.shown = true;
      const u = this.ui;
      u.ending.hidden = false;
      u.ending.classList.toggle('light', e.kind === 'A');
      u.endArt.textContent = e.kind === 'A' ? END_ART_A : END_ART_B;
      u.endText.textContent = e.kind === 'A' ? LINES.endA : LINES.endB;
    }
    this.updateHud();
    this.drawMarks(false);
  }

  // ================================================================ HUD + Scorched Sight marks
  updateHud(valve, beacon) {
    const u = this.ui;
    const placed = this.props.beacons.filter((b) => b.placed).length;
    const cores = placed + this.s.carried;
    const embersText = `EMBERS ${cores}/4`;
    if (u.embers.textContent !== embersText) u.embers.textContent = embersText;
    const n = 12, f = Math.max(0, Math.round(this.flame * n));
    const bar = `[${'#'.repeat(f)}${'.'.repeat(n - f)}]`;
    if (u.flame.textContent !== bar) u.flame.textContent = bar;
    u.flame.classList.toggle('low', this.flame < 0.35);
    let prompt = '';
    if (!this.dying && !this.ending) {
      if (valve) prompt = this.isTouch ? 'HOLD STAFF: crank the valve' : 'HOLD E: crank the valve';
      else if (this.nearStone) prompt = this.isTouch ? 'STAFF: read the old note' : 'E: read the old note';
      else if (beacon && this.s.carried === 0) prompt = 'An empty stone lantern';
      else if (this.aimKind === 'chime' && !this.s.chimes) prompt = this.isTouch ? 'STAFF: strike the chime' : 'E: strike the chime';
      else if (this.aimKind && this.aimKind !== 'chime') prompt = (this.isTouch ? 'STAFF' : 'E') + (this.aimKind === 'bell' ? ': ring the fallen bell' : this.aimKind === 'metal' ? ': strike the iron' : ': throw a sound at the stone');
      else if (this.mercyT > 2) prompt = '...';
    }
    if (u.prompt.textContent !== prompt) { u.prompt.textContent = prompt; u.prompt.hidden = !prompt; }
  }

  drawMarks(asciiOn) {
    const cv = this.ui.marks;
    const ctx = this.marks;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!asciiOn) return;
    const cam = this.ascii.sceneCam.camera;
    const v = this._v || (this._v = new pc.Vec3());
    const s = this._s || (this._s = new pc.Vec3());
    const cell = 10;
    const put = (x, y, z, ch, col = '#f0a24a', size = 13) => {
      v.set(x, y, z);
      cam.worldToScreen(v, s);
      if (s.z < 0 || s.x < -20 || s.y < -20 || s.x > W + 20 || s.y > H + 20) return;
      ctx.font = `bold ${size}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = col;
      ctx.fillText(ch, Math.round(s.x / cell) * cell, Math.round(s.y / cell) * cell);
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const p = this.player.pos;
    const near = (x, z, r = 30) => dist(x, z, p.x, p.z) < r;
    // chime order revealed
    if (!this.s.chimes) for (const c of this.props.chimes) if (near(c.x, c.z)) put(c.x, this.world.height(c.x, c.z) + 2.6, c.z, String(c.rank), '#f0a24a', 16);
    // valves
    for (const vv of this.props.valves) if (!vv.done && near(vv.x, vv.z, 35)) put(vv.x, 1.5, vv.z, '@', '#f0a24a', 16);
    // glowing wire-lines from the plates to the arch
    if (!this.s.arch) {
      const A = { x: LAYOUT.wallC.archX, z: LAYOUT.wallC.z };
      for (const pl of this.props.plates) {
        if (!near(pl.x, pl.z, 30)) continue;
        for (let t = 0.1; t < 0.95; t += 0.12) {
          const x = pl.x + (A.x - pl.x) * t, z = pl.z + (A.z - pl.z) * t;
          put(x, this.world.height(x, z) + 0.2, z, '-', pl.pressed ? '#f0a24a' : '#8d8a83', 12);
        }
      }
    }
    // the Veil-Mothers cradle fragile sparks in their chests
    for (const vm of this.veils) if (near(vm.x, vm.z, 26)) { const c = vm.chest(); put(c.x, c.y, c.z, 'o', '#f6d9a8', 14); }
    // sound rings
    for (const R of this.rings) {
      if (R.a < 0.08) continue;
      const y = this.world.height(R.x, R.z) + 0.3;
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        put(R.x + Math.cos(a) * R.r, y, R.z + Math.sin(a) * R.r, Math.cos(a) < -0.3 ? '(' : Math.cos(a) > 0.3 ? ')' : '-', `rgba(240,162,74,${Math.min(1, R.a).toFixed(2)})`, 12);
      }
    }
    // beacons: empty (+) / placed (*)
    for (const b of this.props.beacons) if (near(b.x, b.z)) put(b.x, SHRINE_Y + 2.9, b.z, b.placed ? '*' : '+', '#f0a24a', 15);
  }

  // ================================================================ old notes on the standing stones
  setupNotes() {
    this.reading = null; // the stone whose note is open (the world pauses while it is)
    this.readT = 0;
    const n = this.ui.note = $('note');
    this.ui.noteTitle = $('noteTitle');
    this.ui.noteBody = $('noteBody');
    this.ui.noteArt = $('noteArt');
    $('noteFold').textContent = this.isTouch ? 'tap to fold the paper' : 'E / Esc / click: fold the paper';
    n.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closeNote(); });
    // registered before the settings key, so Esc folds the paper instead of opening the menu
    window.addEventListener('keydown', (e) => {
      if (!this.reading) return;
      if (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.closeNote();
      }
    }, true);
  }

  openNote(st) {
    if (this.reading || this.dying || this.ending) return;
    this.reading = st;
    this.readT = 0;
    const u = this.ui;
    u.noteTitle.textContent = st.title;
    u.noteBody.replaceChildren(...st.body.map((line) => {
      const el = document.createElement('p');
      el.textContent = line;
      if (/^\d\./.test(line)) el.className = 'step';
      return el;
    }));
    u.noteArt.textContent = st.art ? st.art.replace(/^\r?\n/, '') : '';
    u.noteArt.hidden = !st.art;
    u.note.hidden = false;
    u.note.classList.remove('open');
    void u.note.offsetWidth; // restart the unfold animation
    u.note.classList.add('open');
    u.prompt.hidden = true;
    sfx.play('paper', undefined, { vol: 0.9, wet: 0.1 });
    if (!st.read) { this.markRead(st); this.s.read.push(st.id); this.save(); }
  }

  closeNote() {
    if (!this.reading || this.readT < 0.35) return;
    this.reading = null;
    this.ui.note.hidden = true;
    sfx.play('paper', undefined, { vol: 0.5, wet: 0.1 });
  }

  /** Called by game.js every frame while a note is open (the world is paused). */
  readingFrame(dt, input) {
    this.readT += dt;
    if (input.staffPressed || input.guidePressed) this.closeNote();
  }

  markRead(st) {
    st.read = true;
    st.runeMat.setParameter('uEmissive', 0.8); // the rune dims once its note is read
  }

  /** Unread notes open as you walk up; read ones open again with the staff. */
  updateStones(p) {
    let near = null;
    for (const st of this.props.stones) {
      const d = dist(st.x, st.z, p.x, p.z);
      if (d < 2.3) {
        near = st;
        if (!st.inside) { st.inside = true; if (!st.read) this.openNote(st); }
      } else if (d > 3.4) st.inside = false;
    }
    return near;
  }

  /** Called by game.js when the ASCII view is toggled (Scorched Sight shocks the moths). */
  onSight() { this.sightToggled = true; }

  /** Uniform/light outputs for game.js. */
  get lanternPos() { return this._lp; }
  set lanternPos(v) { this._lp = v; }
}

const END_ART_A = String.raw`
                                                    .
                         .                                     .
      _______________________________________________________________
                                   o
                                  /|\  *
                                  / \
  ''.  ' . ''   .   '' .  '.  ''  .   ' '' .   '.  ''  .  ' '' .  '.
`;

const END_ART_B = String.raw`
             .  ~   .        ~       .        ~     .
          ~      .      ~        .        ~      .     ~
                    ____
                   /####\        ()
                  |######|      /||\
                  |#(__)#|      /  \
             ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                   ~    .   (  o  )   .    ~
`;
