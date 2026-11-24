// World generation + culling/LOD bookkeeping.
//
// Drawing strategy
//  A frame's cost in a browser is mostly its number of draw calls (each one is validated and
//  translated by the GPU process), then its triangles. So everything that repeats is drawn as a
//  handful of BATCHES: one instanced draw per mesh, whose instance list is rebuilt on the CPU
//  when the camera has moved or turned enough to matter (not every frame).
//  - Culling: an instance is in a batch only if the fog has not swallowed it yet (its distance
//    from the camera is inside the fog's reach) AND it is inside the view cone, widened just
//    enough that small turns need no rebuild. What is not on screen is not drawn.
//  - LOD, props: every kind has a light mesh and, where one exists, a detailed one (the boulders
//    authored in Blender, the full bare tree, the full bramble). Instances near the focus go to
//    the "near" batch, the rest to the "far" batch; look-alikes share one far batch.
//  - LOD, grass: stored per 16 m chunk in shuffled order, so taking the first N of a chunk is an
//    even thinning; N shrinks with distance and with the quality level.
//  - The terrain is four big chunks, drawn last so whatever stands on it hides it first.
//  - The lake's mirror gets its own small fixed set of the light meshes round the shore.

import * as pc from 'playcanvas';
import { CLS, worldMaterial, waterMaterial, instanceFormat } from './shaders.js';
import { MeshBuilder, rgba, addBox, pineMesh, roundTreeMesh, deadTreeMesh, rockMesh, grassTuftMesh, fireflyMesh, thornMesh } from './meshes.js';
import { modelMesh } from './models.js';
import { fbm, mulberry32, smoothstep, lerp, clamp, distToSegment, hash2 } from './noise.js';
import { LAYOUT, PATHS, STONES } from './story.js';

const PROP_KINDS = ['pine', 'round', 'dead', 'dead2', 'rock', 'rock2', 'rock3', 'thorn'];

/**
 * One instanced draw call whose instance list is rebuilt on the CPU (see the notes above).
 * Instance layout: (x, y, z, scale), (rotY, tint, seed, unused): 8 floats, as instanceFormat().
 */
class Batch {
  constructor(world, name, mesh, mat, capacity, layerIds, order = 0) {
    this.name = name;
    this.cap = Math.max(1, capacity);
    this.data = new Float32Array(this.cap * 8);
    this.n = 0;
    this.vb = new pc.VertexBuffer(world.device, instanceFormat(world.device), this.cap, { usage: pc.BUFFER_DYNAMIC });
    this.mi = new pc.MeshInstance(mesh, mat);
    this.mi.setInstancing(this.vb); // no engine culling: the instance list is already culled
    this.mi.cull = false;
    this.mi.drawOrder = order;
    this.mi.visible = false;
    const e = new pc.Entity(name);
    e.addComponent('render', { meshInstances: [this.mi], castShadows: false, receiveShadows: false, layers: layerIds });
    world.root.addChild(e);
    world.batches.push(this);
  }

  reset() { this.n = 0; }

  /** Appends the instance at float offset `off` of `src`. */
  add(src, off) {
    if (this.n >= this.cap) return;
    this.data.set(src.subarray(off, off + 8), this.n * 8);
    this.n++;
  }

  /** Appends the first `count` instances of `src` in one block copy. */
  addRun(src, count) {
    const c = Math.min(count, this.cap - this.n);
    if (c <= 0) return;
    this.data.set(src.subarray(0, c * 8), this.n * 8);
    this.n += c;
  }

  flush() {
    this.mi.visible = this.n > 0;
    if (!this.n) return;
    this.vb.setData(this.data.buffer);
    this.mi.instancingCount = this.n;
  }
}

export const WORLD = {
  half: 80, // world spans -80..80
  waterY: LAYOUT.waterY,
  pond: LAYOUT.pond,
  shrine: LAYOUT.shrine,
  spawn: LAYOUT.spawn,
  playRadius: LAYOUT.playRadius,
};

function pathDist(x, z) {
  let d = 1e9;
  for (const p of PATHS) {
    for (let i = 0; i < p.length - 1; i++) {
      d = Math.min(d, distToSegment(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]));
    }
  }
  return d;
}

/** Wall polylines (x,z pairs). Gaps are where the puzzles are. */
function wallLines() {
  const { wallA, wallB, wallC } = LAYOUT;
  const R = 70;
  return [
    { id: 'A-west', a: [-R, wallA.z], b: [wallA.gateX - wallA.gateHalf, wallA.z] },
    { id: 'A-east', a: [wallA.gateX + wallA.gateHalf, wallA.z], b: [R, wallA.z] },
    { id: 'A-gate', a: [wallA.gateX - wallA.gateHalf, wallA.z], b: [wallA.gateX + wallA.gateHalf, wallA.z], gate: true },
    { id: 'B-west', a: [-R, wallB.z], b: [wallB.westEnd, wallB.z] },
    { id: 'B-east', a: [wallB.eastStart, wallB.z], b: [R, wallB.z] },
    { id: 'C-west', a: [-R, wallC.z], b: [wallC.archX - wallC.archHalf, wallC.z] },
    { id: 'C-east', a: [wallC.archX + wallC.archHalf, wallC.z], b: [R, wallC.z] },
    { id: 'C-arch', a: [wallC.archX - wallC.archHalf, wallC.z], b: [wallC.archX + wallC.archHalf, wallC.z], gate: true },
  ];
}

function rawHeight(x, z) {
  let h = fbm(x * 0.017 + 3.3, z * 0.017 - 1.7, 4) * 6.0 - 1.0;
  h += (fbm(x * 0.07 + 31, z * 0.07 - 17, 2) - 0.5) * 1.0;
  h = Math.max(h, 0.6);
  const r = Math.hypot(x, z);
  h += smoothstep(56, 80, r) * 16 * (0.7 + 0.6 * fbm(x * 0.05, z * 0.05, 2));
  return h;
}

const SHRINE_H = rawHeight(WORLD.shrine.x, WORLD.shrine.z);
export const SHRINE_Y = SHRINE_H;

function heightAt(x, z) {
  let h = rawHeight(x, z);
  // path: flatten a little towards a smoothed version
  const pd = pathDist(x, z);
  h = lerp(h, h * 0.75 + 0.3, 1 - smoothstep(1.5, 4, pd));
  // shrine plaza + the corridor out through the rim to the exit gate
  const ds = Math.hypot(x - WORLD.shrine.x, z - WORLD.shrine.z);
  h = lerp(h, SHRINE_H, 1 - smoothstep(11, 16, ds));
  const g = LAYOUT.exitGate;
  const dg = distToSegment(x, z, WORLD.shrine.x, WORLD.shrine.z, g.x - 6, g.z - 6);
  h = lerp(h, SHRINE_H, 1 - smoothstep(3.5, 6, dg));
  // pond bowl
  const dp = Math.hypot(x - WORLD.pond.x, z - WORLD.pond.z);
  const wob = (fbm(x * 0.2, z * 0.2, 2) - 0.5) * 3;
  const bowl = 1 - smoothstep(WORLD.pond.r * 0.35, WORLD.pond.r + 4 + wob, dp);
  h = lerp(h, WORLD.waterY - 1.8, bowl);
  return h;
}

/** Heightfield sampled on a 1 m grid; the collision / placement source of truth. */
class Heightfield {
  constructor() {
    this.n = WORLD.half * 2 + 1;
    this.h = new Float32Array(this.n * this.n);
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        this.h[iz * this.n + ix] = heightAt(ix - WORLD.half, iz - WORLD.half);
      }
    }
  }

  at(x, z) {
    const fx = clamp(x + WORLD.half, 0, this.n - 1.001), fz = clamp(z + WORLD.half, 0, this.n - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const n = this.n, h = this.h;
    const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
    // match the triangle split used by the terrain mesh
    if (tx + tz < 1) return a + (b - a) * tx + (c - a) * tz;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }

  normalY(x, z) {
    const e = 1;
    const dx = this.at(x + e, z) - this.at(x - e, z);
    const dz = this.at(x, z + e) - this.at(x, z - e);
    return 2 * e / Math.hypot(dx, 2 * e, dz);
  }
}

/** Uniform grid of circle colliders for the player. */
class ColliderGrid {
  constructor(cell = 8) {
    this.cell = cell;
    this.map = new Map();
  }
  key(ix, iz) { return ix * 4096 + iz; }
  add(x, z, r) {
    const c = this.cell;
    const minX = Math.floor((x - r) / c), maxX = Math.floor((x + r) / c);
    const minZ = Math.floor((z - r) / c), maxZ = Math.floor((z + r) / c);
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const k = this.key(ix, iz);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(x, z, r);
      }
    }
  }
  /** Pushes point (x,z) with radius pr out of overlapping colliders; returns [x, z]. */
  resolve(x, z, pr, out) {
    const list = this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (list) {
      for (let i = 0; i < list.length; i += 3) {
        const dx = x - list[i], dz = z - list[i + 1];
        const rr = list[i + 2] + pr;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          x = list[i] + (dx / d) * rr;
          z = list[i + 1] + (dz / d) * rr;
        }
      }
    }
    out[0] = x;
    out[1] = z;
    return out;
  }
}

export class World {
  constructor(app, layers, tier) {
    this.app = app;
    this.device = app.graphicsDevice;
    this.layers = layers; // { world, reflect }
    this.hf = null; // built by the first loading step
    this.colliders = new ColliderGrid();
    this.walls = wallLines().map((w) => ({ ...w, on: true, r: 0.9 }));
    this.causewayUp = 0; // 0..1, set by the lake-valve puzzle
    this.batches = []; // every Batch (dynamic and fixed)
    this.clusters = this.batches; // (the stats overlay counts these)
    this.propSets = []; // { kind, data, far: Batch, near: Batch|null, reach }
    this.grassSet = null; // { batch, chunks: [{ x, z, r, data, n }] }
    this.view = { x: 1e9, z: 1e9, cx: 1e9, cz: 1e9, yaw: 99, dx: 0, dz: -1, tan: 1.5 };
    this.dirty = true; // rebuild the batches on the next update
    this.camera = null; // the main camera component (for its field of view)
    this.fogEnd = 40; // metres from the camera at which the fog has swallowed everything (set per frame)
    this.builtFog = 0;
    this.grassDensity = 1;
    this.fireflyCount = 0;
    this.drawDistance = 80;
    this.lodDistance = 10; // metres: detailed meshes inside, light ones beyond (quality-driven)
    this.visibleClusters = 0;
    this.rocks = []; // [x, z, size] strike targets for the staff
    this.root = new pc.Entity('world');
    app.root.addChild(this.root);

    // Bake density for the device tier once; LOD only thins from here.
    this.maxGrassPerM2 = [0.15, 0.3, 0.55, 0.8, 1.0][tier];

    this.mats = {
      terrain: worldMaterial({}),
      props: worldMaterial({ inst: true, sway: 0.22 }),
      rocks: worldMaterial({ inst: true }),
      grass: worldMaterial({ inst: true, push: true, sway: 0.35, doubleSided: true }),
      ruins: worldMaterial({}),
      fireflies: worldMaterial({ inst: true, fly: true, emissive: 0.9 }),
      water: waterMaterial(),
    };
  }

  /** Generation split into labelled steps so the loading screen can show real progress. */
  steps() {
    return [
      ['shaping the basin', () => { this.hf = new Heightfield(); }],
      ['raising the terrain', () => this.buildTerrain()],
      ['flooding the lake', () => this.buildWater()],
      ['growing the dead forest', () => this.buildProps()],
      ['weaving the bramble walls', () => this.buildWalls()],
      ['growing tall grass', () => this.buildGrass()],
      ['restoring the shrine', () => this.buildRuins()],
      ['stirring the dust', () => this.buildFireflies()],
    ];
  }

  /** Loading-screen shader warm-up: every batch draws everything it has, once. */
  showEverything() {
    this.rebuild(true);
    this.dirty = true; // back to the real view on the next update
    this.fireflies.mi.visible = true;
    this.fireflies.mi.instancingCount = this.fireflies.max;
  }

  height(x, z) { return this.hf.at(x, z); }

  /** True if (x,z) is on the raised causeway stones. */
  onCauseway(x, z) {
    const c = LAYOUT.causeway;
    return this.causewayUp > 0.95 && Math.abs(x - c.x) < c.half && z < c.z0 + 0.5 && z > c.z1 - 0.5;
  }

  /** Standing height (terrain, or the causeway stones). */
  groundAt(x, z) {
    const h = this.hf.at(x, z);
    if (this.onCauseway(x, z)) return Math.max(h, WORLD.waterY + 0.12);
    return h;
  }

  /** Can't walk here: deep water (unless on the causeway). */
  isDeep(x, z) {
    return this.hf.at(x, z) < WORLD.waterY - 0.45 && !this.onCauseway(x, z);
  }

  /** Push a circle out of trees/rocks and out of the enabled region walls. */
  resolve(x, z, pr, out) {
    this.colliders.resolve(x, z, pr, out);
    x = out[0];
    z = out[1];
    for (const w of this.walls) {
      if (!w.on) continue;
      const ax = w.a[0], az = w.a[1], bx = w.b[0], bz = w.b[1];
      const abx = bx - ax, abz = bz - az;
      const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
      const px = ax + abx * t, pz = az + abz * t;
      const dx = x - px, dz = z - pz;
      const d = Math.hypot(dx, dz);
      const rr = w.r + pr;
      if (d < rr && d > 1e-5) {
        if (t > 0 && t < 1 && Math.abs(abz) < 1e-3) {
          // along an east-west wall: push straight back to the side we came from
          z = pz + (dz >= 0 ? 1 : -1) * rr;
        } else {
          // wall ends (gate posts): round push
          x = px + (dx / d) * rr;
          z = pz + (dz / d) * rr;
        }
      }
    }
    out[0] = x;
    out[1] = z;
    return out;
  }

  setWall(id, on) {
    const w = this.walls.find((v) => v.id === id);
    if (w) w.on = on;
  }

  // --------------------------------------------------------------- helpers
  addEntity(name, mis, inReflection) {
    const e = new pc.Entity(name);
    e.addComponent('render', {
      meshInstances: mis,
      castShadows: false,
      receiveShadows: false,
      layers: inReflection ? [this.layers.world.id, this.layers.reflect.id] : [this.layers.world.id],
    });
    // the render component resets custom AABBs when it adopts mesh instances: re-apply ours
    for (const mi of mis) if (mi.cullAabb) mi.setCustomAabb(mi.cullAabb);
    this.root.addChild(e);
    return e;
  }

  nearPond(x, z, margin) {
    return Math.hypot(x - WORLD.pond.x, z - WORLD.pond.z) < WORLD.pond.r + margin;
  }

  /** Spots that must stay clear of random trees/rocks (puzzles, paths, items). */
  clearZone(x, z) {
    const L = LAYOUT;
    const near = (p, r) => Math.hypot(x - p.x, z - p.z) < r;
    if (near(L.spawn, 6) || near(L.shrine, 17)) return true;
    if (L.chimes.some((c) => near(c, 4))) return true;
    if (L.plates.some((c) => near(c, 5))) return true;
    if (near({ x: L.wallC.archX, z: L.wallC.z }, 6) || near({ x: L.wallA.gateX, z: L.wallA.z }, 5)) return true;
    if (near(L.ironChime, 4) || near(L.exitGate, 8)) return true;
    if (STONES.some((s) => near(s, 2.6))) return true;
    if (distToSegment(x, z, L.shrine.x, L.shrine.z, L.exitGate.x - 6, L.exitGate.z - 6) < 5) return true;
    return false;
  }

  makeInstanced(mesh, mat, data, count, aabb) {
    const vb = new pc.VertexBuffer(this.device, instanceFormat(this.device), count, { data });
    const mi = new pc.MeshInstance(mesh, mat);
    mi.setInstancing(vb, true);
    mi.cullAabb = aabb;
    return mi;
  }

  /** Meadow mask 0..1: noise patches plus the two story meadows. */
  meadow(x, z) {
    let m = fbm(x * 0.07 + 40, z * 0.07 - 12, 2);
    for (const md of [LAYOUT.southMeadow, LAYOUT.westMeadow]) {
      const d = Math.hypot(x - md.x, z - md.z) / md.r;
      m = Math.max(m, 0.72 * (1 - smoothstep(0.75, 1.05, d)));
    }
    return m;
  }

  // --------------------------------------------------------------- terrain
  terrainColour(x, z, h, ny) {
    const pd = pathDist(x, z);
    const ds = Math.hypot(x - WORLD.shrine.x, z - WORLD.shrine.z);
    const v = fbm(x * 0.15, z * 0.15, 2);
    if (h < WORLD.waterY + 0.35) {
      // muddy shore / lake bed
      const t = clamp((h - WORLD.waterY + 1.8) / 2.2, 0, 1);
      return rgba(0.1 + t * 0.06, 0.09 + t * 0.05, 0.065 + t * 0.03, CLS.GROUND); // dark lake mud
    }
    if (ds < 12.5) {
      // flagstones
      const tile = hash2(Math.floor(x * 0.7), Math.floor(z * 0.7));
      const g = 0.2 + tile * 0.08;
      return rgba(g * 0.95, g, g * 0.93, CLS.STONE); // mossy flagstones
    }
    if (pd < 1.6 + v) return rgba(0.22 + v * 0.06, 0.17 + v * 0.05, 0.11, CLS.GROUND); // damp brown earth
    if (ny < 0.72) return rgba(0.17 + v * 0.06, 0.18 + v * 0.06, 0.18 + v * 0.06, CLS.STONE);
    if (this.meadow(x, z) > 0.44) return rgba(0.09 + v * 0.05, 0.13 + v * 0.07, 0.055 + v * 0.03, CLS.GRASS); // olive meadow
    return rgba(0.11 + v * 0.05, 0.12 + v * 0.06, 0.075 + v * 0.03, CLS.GROUND);
  }

  buildTerrain() {
    // four big chunks (the engine's frustum test drops the ones behind the camera)
    const size = WORLD.half;
    const mis = [];
    for (let cz = 0; cz < 2; cz++) {
      for (let cx = 0; cx < 2; cx++) {
        const mb = new MeshBuilder();
        const x0 = -WORLD.half + cx * size, z0 = -WORLD.half + cz * size;
        const n = size + 1;
        for (let iz = 0; iz < n; iz++) {
          for (let ix = 0; ix < n; ix++) {
            const x = x0 + ix, z = z0 + iz;
            const h = this.hf.at(x, z);
            const dx = this.hf.at(x + 1, z) - this.hf.at(x - 1, z);
            const dz = this.hf.at(x, z + 1) - this.hf.at(x, z - 1);
            const l = Math.hypot(dx, 2, dz);
            mb.vert(x, h, z, -dx / l, 2 / l, -dz / l, this.terrainColour(x, z, h, 2 / l));
          }
        }
        for (let iz = 0; iz < n - 1; iz++) {
          for (let ix = 0; ix < n - 1; ix++) {
            const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
            mb.tri(a, c, b);
            mb.tri(b, c, d);
          }
        }
        const mi = new pc.MeshInstance(mb.build(this.device), this.mats.terrain);
        mi.drawOrder = 100; // drawn last: whatever stands on the ground hides it first (no wasted shading)
        mis.push(mi);
      }
    }
    this.addEntity('terrain', mis, false);
  }

  buildWater() {
    const { x, z, r } = WORLD.pond;
    const mb = new MeshBuilder();
    const seg = 24;
    const R = r + 6;
    const col = rgba(0, 0, 0, CLS.WATER);
    const c = mb.vert(0, 0, 0, 0, 1, 0, col);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      mb.vert(Math.cos(a) * R, 0, Math.sin(a) * R, 0, 1, 0, col);
    }
    for (let i = 0; i < seg; i++) mb.tri(c, c + i + 2, c + i + 1);
    const mesh = new pc.Mesh(this.device);
    mesh.setPositions(mb.p);
    mesh.setIndices(mb.i);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    const mi = new pc.MeshInstance(mesh, this.mats.water);
    mi.drawOrder = 90; // before the terrain, so the lake bed under it is never shaded
    const e = this.addEntity('water', [mi], false);
    e.setPosition(x, WORLD.waterY, z);
    this.water = { mi, sphere: new pc.BoundingSphere(new pc.Vec3(x, WORLD.waterY, z), R) };
  }

  /** First ankle-deep point walking in from the shore along an angle (for valves etc.). */
  shallowPoint(angle, depth = -0.22) {
    const { x, z } = WORLD.pond;
    for (let d = 16; d > 4; d -= 0.1) {
      const px = x + Math.cos(angle) * d, pz = z + Math.sin(angle) * d;
      if (this.hf.at(px, pz) < depth) return { x: px, z: pz };
    }
    return { x: x + Math.cos(angle) * 10, z: z + Math.sin(angle) * 10 };
  }

  // --------------------------------------------------------------- trees + rocks
  buildProps() {
    const rng = mulberry32(1234);
    const dev = this.device;
    // Every kind has a light mesh (the far LOD; look-alikes share one, see flushProps) ...
    this.propMeshes = { pine: pineMesh(dev), round: roundTreeMesh(dev), dead: deadTreeMesh(dev, 31, true), rock: rockMesh(dev) };
    // ... and some a detailed one for near the camera: the boulders authored in Blender (when
    // the model pack is loaded) and the full bare trees.
    this.propMeshesHi = { dead: deadTreeMesh(dev, 31), dead2: deadTreeMesh(dev, 77), rock: modelMesh(dev, 'rock_a'), rock2: modelMesh(dev, 'rock_b'), rock3: modelMesh(dev, 'rock_c') };
    this.propInst = {};
    for (const pk of PROP_KINDS) this.propInst[pk] = [];
    this.bucketAdd = (kind, x, ...rest) => { this.propInst[kind].push(x, ...rest); };
    const pick = mulberry32(4321); // which of the three boulders (its own stream: the layout stays as it was)
    this.rockKind = () => ['rock', 'rock2', 'rock3'][Math.floor(pick() * 3)];
    const ok = (x, z, clearPath) => {
      if (Math.hypot(x, z) > 77) return false;
      if (this.nearPond(x, z, 3.5)) return false;
      if (pathDist(x, z) < clearPath) return false;
      if (this.clearZone(x, z)) return false;
      return true;
    };

    // trees: rejection-sample with a density that rises towards the rim (natural boundary)
    let placed = 0;
    for (let i = 0; i < 9000 && placed < 430; i++) {
      const x = (rng() * 2 - 1) * WORLD.half, z = (rng() * 2 - 1) * WORLD.half;
      if (!ok(x, z, 3.2)) continue;
      const r = Math.hypot(x, z);
      const density = 0.18 + smoothstep(30, 62, r) * 0.7 + (fbm(x * 0.04, z * 0.04, 2) - 0.5) * 0.6;
      if (rng() > density) continue;
      const roll = rng();
      const kind = roll < 0.34 ? 'dead' : roll < 0.68 ? 'dead2' : roll < 0.95 ? 'pine' : 'round';
      const bare = kind === 'dead' || kind === 'dead2';
      // the world is built too big for its wanderer
      const s = (1.2 + rng() * 0.8 + smoothstep(50, 75, r) * 0.6) * (bare ? 1.0 : 1.1);
      const y = this.hf.at(x, z) - 0.1;
      this.bucketAdd(kind, x, y, z, s, rng() * Math.PI * 2, 0.8 + rng() * 0.4, rng(), 0);
      this.colliders.add(x, z, 0.3 * s);
      placed++;
    }
    // rocks, a cluster on the lake's south shore (story: boulder cluster)
    for (let i = 0; i < 170; i++) {
      let x, z;
      if (i < 26) {
        const a = rng() * Math.PI * 2, d = WORLD.pond.r + 2 + rng() * 4;
        x = WORLD.pond.x + Math.cos(a) * d;
        z = WORLD.pond.z + Math.sin(a) * d;
        if (Math.abs(x - LAYOUT.causeway.x) < 3) continue;
      } else {
        x = (rng() * 2 - 1) * WORLD.half;
        z = (rng() * 2 - 1) * WORLD.half;
        if (!ok(x, z, 2.2)) continue;
      }
      if (Math.hypot(x, z) > 77) continue;
      const s = 0.5 + rng() * 1.3;
      this.bucketAdd(this.rockKind(), x, this.hf.at(x, z) - 0.15 * s, z, s, rng() * Math.PI * 2, 0.8 + rng() * 0.4, rng(), 0);
      this.colliders.add(x, z, 0.55 * s);
      if (s > 0.8) this.rocks.push([x, z, s]);
    }
  }

  /** Bramble walls: thorn thickets + deadfall along each wall line, plus closing tree rows. */
  buildWalls() {
    const rng = mulberry32(808);
    this.propMeshes.thorn = thornMesh(this.device, true);
    this.propMeshesHi.thorn = thornMesh(this.device);
    for (const w of this.walls) {
      if (w.gate) continue;
      const [ax, az] = w.a, [bx, bz] = w.b;
      const len = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < len; d += 0.9) {
        const t = d / len;
        const x = ax + (bx - ax) * t + (rng() - 0.5) * 0.8;
        const z = az + (bz - az) * t + (rng() - 0.5) * 1.4;
        if (Math.hypot(x, z) > 76) continue;
        if (this.hf.at(x, z) < WORLD.waterY - 0.3) continue; // the lake itself is the wall there
        const s = 0.9 + rng() * 0.8;
        this.bucketAdd('thorn', x, this.hf.at(x, z) - 0.1, z, s, rng() * Math.PI * 2, 0.7 + rng() * 0.5, rng(), 0);
        // every few metres a big dead tree so the wall reads from far away
        if (rng() < 0.22) {
          const tx = x + (rng() - 0.5) * 2, tz = z + (rng() - 0.5) * 2;
          this.bucketAdd(rng() < 0.5 ? 'dead' : 'dead2', tx, this.hf.at(tx, tz) - 0.1, tz, 1.3 + rng() * 0.7, rng() * Math.PI * 2, 0.8 + rng() * 0.3, rng(), 0);
        }
      }
    }
    // rim cliffs either side of the exit gate so it reads as a gate in a wall
    const g = LAYOUT.exitGate;
    for (let i = -9; i <= 9; i++) {
      if (Math.abs(i) < 3) continue;
      const tx = g.x + Math.cos(g.rot + Math.PI / 2) * i * 1.4, tz = g.z + Math.sin(g.rot + Math.PI / 2) * i * 1.4;
      const s = 2.2 + rng() * 1.4;
      this.bucketAdd(this.rockKind(), tx, this.hf.at(tx, tz) - 0.3, tz, s, rng() * 6.28, 0.7, rng(), 0);
      this.colliders.add(tx, tz, 0.6 * s);
    }
    this.flushProps();
  }

  /**
   * Turns the collected instances into batches. Each kind has its own near batch (where it has a
   * detailed mesh); the far batches are shared by look-alikes (the three boulders, the two bare trees).
   */
  flushProps() {
    const live = [this.layers.world.id];
    const { x: px, z: pz, r: pr } = WORLD.pond;
    const FAR = { rock2: 'rock', rock3: 'rock', dead2: 'dead' };
    const family = (kind) => FAR[kind] || kind;
    const byShore = (arr, i) => Math.hypot(arr[i] - px, arr[i + 2] - pz) < pr + 14;
    const counts = {}, shore = {};
    for (const kind of PROP_KINDS) {
      const arr = this.propInst[kind];
      const f = family(kind);
      counts[f] = (counts[f] || 0) + arr.length / 8;
      for (let i = 0; i < arr.length; i += 8) if (byShore(arr, i)) shore[f] = (shore[f] || 0) + 1;
    }
    const far = {}, mirror = {};
    this.farBatches = [];
    for (const kind of PROP_KINDS) {
      const arr = this.propInst[kind];
      if (!arr.length) continue;
      const f = family(kind);
      const mat = f === 'rock' ? this.mats.rocks : this.mats.props;
      if (!far[f]) {
        far[f] = new Batch(this, `${f}-far`, this.propMeshes[f], mat, counts[f], live);
        this.farBatches.push(far[f]);
        // the lake's mirror: a fixed set of the light meshes standing round the shore
        if (shore[f]) mirror[f] = new Batch(this, `${f}-mirror`, this.propMeshes[f], mat, shore[f], [this.layers.reflect.id]);
      }
      const data = new Float32Array(arr);
      const hi = this.propMeshesHi[kind] || null;
      const near = hi ? new Batch(this, `${kind}-near`, hi, mat, data.length / 8, live) : null;
      this.propSets.push({ kind, data, far: far[f], near, reach: f === 'dead' ? 4.2 : 1.6 });
      for (let i = 0; i < data.length; i += 8) if (byShore(data, i)) mirror[f].add(data, i);
    }
    for (const b of Object.values(mirror)) b.flush();
    this.propInst = null;
  }

  // --------------------------------------------------------------- tall grass patches
  buildGrass() {
    const rng = mulberry32(99);
    const size = 16;
    const chunks = (WORLD.half * 2) / size;
    const mesh = grassTuftMesh(this.device);
    const grassChunks = [];
    const max = this.maxGrassPerM2;
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const x0 = -WORLD.half + cx * size, z0 = -WORLD.half + cz * size;
        if (Math.hypot(x0 + size / 2, z0 + size / 2) > 74) continue;
        const pts = [];
        const tries = Math.round(size * size * max);
        for (let i = 0; i < tries; i++) {
          const x = x0 + rng() * size, z = z0 + rng() * size;
          const patch = this.meadow(x, z);
          if (patch < 0.48) continue;
          if (pathDist(x, z) < 1.6) continue;
          if (this.nearPond(x, z, 0.5)) continue;
          if (Math.hypot(x - WORLD.shrine.x, z - WORLD.shrine.z) < 13) continue;
          if (LAYOUT.chimes.some((c) => Math.hypot(x - c.x, z - c.z) < 1.2)) continue;
          const h = this.hf.at(x, z);
          if (h < WORLD.waterY + 0.4 || this.hf.normalY(x, z) < 0.75) continue;
          pts.push([x, h - 0.05, z, 0.8 + rng() * 0.7 * (patch - 0.3) * 2, rng() * Math.PI * 2, 0.75 + rng() * 0.5, rng(), 0]);
        }
        if (!pts.length) continue;
        // shuffle so drawing the first N instances is an even thinning (LOD)
        for (let i = pts.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pts[i], pts[j]] = [pts[j], pts[i]];
        }
        const data = new Float32Array(pts.length * 8);
        pts.forEach((p, i) => data.set(p, i * 8));
        grassChunks.push({ x: x0 + size / 2, z: z0 + size / 2, r: size * 0.71, data, n: pts.length });
      }
    }
    // one draw call for all the grass in view (the chunk lists are thinned and joined as the camera moves)
    if (grassChunks.length) {
      this.grassSet = { batch: new Batch(this, 'grass', mesh, this.mats.grass, Math.round(max * 3200) + 300, [this.layers.world.id], 10), chunks: grassChunks };
    }
  }

  // --------------------------------------------------------------- shrine ruins
  buildRuins() {
    const rng = mulberry32(7);
    const { x: sx, z: sz } = WORLD.shrine;
    const y0 = SHRINE_H;
    const mb = new MeshBuilder();
    const stone = (v) => rgba(0.27 + v, 0.29 + v, 0.26 + v, CLS.STONE); // moss-stained
    this.pillars = []; // strike targets

    // ring of pillars, some broken, two fallen; pillar 4 (west) is broken so an ember hides behind it
    const ring = 10;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + 0.2;
      const x = sx + Math.cos(a) * 8.5, z = sz + Math.sin(a) * 8.5;
      const broken = i === 4 || (i !== 6 && rng() < 0.3);
      const h = broken ? 1.4 + rng() * 1.0 : 3.4 + rng() * 0.6;
      if (i === 2 || i === 8) {
        addBox(mb, { x: x + Math.cos(a) * 1.4, y: y0 + 0.4, z: z + Math.sin(a) * 1.4, sx: 0.8, sy: 3.2, sz: 0.8, rot: -a + Math.PI / 2, tilt: Math.PI / 2 - 0.08, col: stone(-0.06) });
        this.colliders.add(x + Math.cos(a) * 1.4, z + Math.sin(a) * 1.4, 1.4);
      } else {
        addBox(mb, { x, y: y0 + h / 2 - 0.1, z, sx: 0.85, sy: h, sz: 0.85, rot: -a, col: (t) => stone(t * 0.08 - 0.04) });
        if (!broken) addBox(mb, { x, y: y0 + h + 0.12, z, sx: 1.2, sy: 0.3, sz: 1.2, rot: -a, col: stone(0.04) });
        this.colliders.add(x, z, 0.7);
        this.pillars.push([x, z]);
      }
    }
    // steps + altar
    addBox(mb, { x: sx, y: y0 + 0.15, z: sz, sx: 6, sy: 0.3, sz: 6, col: stone(-0.08) });
    addBox(mb, { x: sx, y: y0 + 0.45, z: sz, sx: 4, sy: 0.3, sz: 4, col: stone(-0.04) });
    addBox(mb, { x: sx, y: y0 + 1.0, z: sz, sx: 1.4, sy: 0.9, sz: 1.0, col: stone(0.02) });
    this.colliders.add(sx, sz, 1.0);
    // the crooked archway into the plaza, facing the path from the east
    const ae = LAYOUT.archEntrance;
    addBox(mb, { x: ae.x, y: y0 + 1.8, z: ae.z - 1.9, sx: 0.6, sy: 3.6, sz: 0.6, rot: 0.12, col: stone(0) });
    addBox(mb, { x: ae.x + 0.4, y: y0 + 1.7, z: ae.z + 1.8, sx: 0.6, sy: 3.4, sz: 0.6, rot: 0.12, col: stone(0) });
    addBox(mb, { x: ae.x + 0.2, y: y0 + 3.7, z: ae.z, sx: 0.8, sy: 0.5, sz: 4.8, rot: 0.12, tilt: 0.06, col: stone(0.05) });
    this.colliders.add(ae.x, ae.z - 1.9, 0.45);
    this.colliders.add(ae.x + 0.4, ae.z + 1.8, 0.45);
    this.addEntity('ruins', [new pc.MeshInstance(mb.build(this.device), this.mats.ruins)], false);
  }

  // --------------------------------------------------------------- dust motes (1 draw call, animated on GPU)
  buildFireflies() {
    const rng = mulberry32(55);
    const max = 400;
    const data = new Float32Array(max * 8);
    let n = 0;
    while (n < max) {
      const nearPond = rng() < 0.3;
      const a = rng() * Math.PI * 2;
      const d = nearPond ? WORLD.pond.r + rng() * 10 : 4 + rng() * 60;
      const x = nearPond ? WORLD.pond.x + Math.cos(a) * d : Math.cos(a) * d;
      const z = nearPond ? WORLD.pond.z + Math.sin(a) * d : Math.sin(a) * d;
      const y = Math.max(this.hf.at(x, z), WORLD.waterY) + 0.8 + rng() * 1.6;
      data.set([x, y, z, 0.8 + rng() * 0.6, 0, 1, rng(), 0], n * 8);
      n++;
    }
    const aabb = new pc.BoundingBox(new pc.Vec3(0, 6, 0), new pc.Vec3(WORLD.half, 12, WORLD.half));
    const mi = this.makeInstanced(fireflyMesh(this.device), this.mats.fireflies, data, max, aabb);
    this.fireflies = { mi, max };
    this.addEntity('fireflies', [mi], true);
  }

  // --------------------------------------------------------------- per-frame
  setQuality(q) {
    this.grassDensity = q.grass;
    this.fireflyCount = q.fireflies;
    this.drawDistance = q.drawDistance;
    this.lodDistance = q.lod;
    this.dirty = true;
  }

  /** In the widened view cone, or right beside the wanderer (df = distance to the focus). */
  inView(x, z, r, df) {
    if (df - r < 3) return true;
    const v = this.view;
    const vx = x - v.cx, vz = z - v.cz;
    const fwd = vx * v.dx + vz * v.dz;
    return Math.abs(vx * v.dz - vz * v.dx) < fwd * v.tan + r * 2 + 2;
  }

  /** Refills every dynamic batch for the current view. all = everything (shader warm-up). */
  rebuild(all) {
    const v = this.view;
    const lod = this.lodDistance;
    // past this the camera's far plane (set just beyond the fog) would clip it anyway
    const reach = Math.min(this.drawDistance + 14, this.fogEnd + 4);
    this.builtFog = this.fogEnd;
    for (const b of this.farBatches) b.reset();
    for (const s of this.propSets) {
      if (s.near) s.near.reset();
      const d = s.data;
      for (let i = 0; i < d.length; i += 8) {
        const x = d[i], z = d[i + 2], r = s.reach * d[i + 3];
        const df = Math.hypot(x - v.x, z - v.z);
        if (!all) {
          if (Math.hypot(x - v.cx, z - v.cz) - r > reach) continue; // swallowed by the fog: not drawn
          if (!this.inView(x, z, r, df)) continue; // off screen: not drawn
        }
        if (s.near && (all || df < lod)) s.near.add(d, i);
        if (!s.near || all || df >= lod) s.far.add(d, i);
      }
      if (s.near) s.near.flush();
    }
    for (const b of this.farBatches) b.flush();
    const g = this.grassSet;
    if (g) {
      g.batch.reset();
      for (const c of g.chunks) {
        const df = Math.hypot(c.x - v.x, c.z - v.z);
        const dc = Math.hypot(c.x - v.cx, c.z - v.cz) - c.r;
        const d = Math.min(df - c.r, dc);
        const k = all ? 1 : dc > reach ? 0 : d < 10 ? 1 : d < 22 ? 0.5 : d < 34 ? 0.2 : 0; // thinner with distance
        if (!k || (!all && !this.inView(c.x, c.z, c.r, df))) continue;
        g.batch.addRun(c.data, Math.floor(c.n * k * (all ? 1 : this.grassDensity)));
      }
      g.batch.flush();
    }
    let vis = 0;
    for (const b of this.batches) if (b.mi.visible) vis++;
    this.visibleClusters = vis;
  }

  /**
   * Called every frame. (fx, fz) = the camera focus, (camX, camZ) = the camera, yaw = its heading.
   * The batches are only refilled when the view has changed enough to matter: the cone they
   * were built for is 15 degrees wider than the screen, so small turns and steps cost nothing.
   */
  update(fx, fz, camX, camZ, yaw = 0) {
    const v = this.view;
    let turn = yaw - v.yaw;
    turn = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
    if (this.dirty || turn > 0.1 || Math.abs(this.fogEnd - this.builtFog) > 1.5 || Math.hypot(fx - v.x, fz - v.z) > 1.5 || Math.hypot(camX - v.cx, camZ - v.cz) > 1.5) {
      this.dirty = false;
      v.x = fx; v.z = fz; v.cx = camX; v.cz = camZ; v.yaw = yaw;
      v.dx = -Math.sin(yaw); v.dz = -Math.cos(yaw);
      const cam = this.camera;
      const half = cam ? Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspectRatio) : 0.55;
      v.tan = Math.tan(Math.min(1.45, half + 0.26)); // the screen's half-width plus 15 degrees
      this.rebuild(false);
    }
    const ff = this.fireflies;
    ff.mi.visible = this.fireflyCount > 0;
    if (ff.mi.visible) ff.mi.instancingCount = Math.min(ff.max, this.fireflyCount);
  }
}
