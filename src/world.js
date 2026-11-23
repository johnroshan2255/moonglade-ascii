// World generation + culling/LOD bookkeeping.
//
// Culling strategy
//  - Everything static is split into spatial clusters (terrain 32 m, props 32 m, grass 16 m).
//    Each cluster is ONE mesh instance (hardware instanced where it repeats), with a tight AABB,
//    so the engine's per-camera frustum culling rejects whole clusters at once.
//  - On top of that we do our own distance culling every frame (cheap 2D test against the
//    camera focus) so far clusters never even reach the frustum test, and the fog hides the cut.
//  - Grass LOD: instances are stored shuffled, so drawing the first N of them is a uniform
//    thinning. N shrinks with distance and with the quality level.
//  - The reflection camera only sees a dedicated layer holding props near the pond, and is
//    switched off entirely when the pond is outside the main camera frustum.

import * as pc from 'playcanvas';
import { CLS, worldMaterial, waterMaterial, instanceFormat } from './shaders.js';
import { MeshBuilder, rgba, addBox, pineMesh, roundTreeMesh, deadTreeMesh, rockMesh, grassTuftMesh, fireflyMesh, thornMesh } from './meshes.js';
import { fbm, mulberry32, smoothstep, lerp, clamp, distToSegment, hash2 } from './noise.js';
import { LAYOUT, PATHS } from './story.js';

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
    this.clusters = []; // { mi, x, z, radius, base, kind }
    this.grassDensity = 1;
    this.fireflyCount = 0;
    this.drawDistance = 80;
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

  /** Loading-screen shader warm-up: draw every cluster at full density once. */
  showEverything() {
    for (const c of this.clusters) {
      c.mi.visible = true;
      if (c.kind === 'grass') c.mi.instancingCount = c.base;
    }
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
    const size = 32;
    const step = 1;
    const chunks = (WORLD.half * 2) / size;
    const mis = [];
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const mb = new MeshBuilder();
        const x0 = -WORLD.half + cx * size, z0 = -WORLD.half + cz * size;
        const n = size / step + 1;
        for (let iz = 0; iz < n; iz++) {
          for (let ix = 0; ix < n; ix++) {
            const x = x0 + ix * step, z = z0 + iz * step;
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
        mis.push(mi);
        this.clusters.push({ mi, x: x0 + size / 2, z: z0 + size / 2, radius: size * 0.71, base: 0, kind: 'terrain' });
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
    const size = 32;
    const chunks = (WORLD.half * 2) / size;
    const meshes = { pine: pineMesh(this.device), round: roundTreeMesh(this.device), dead: deadTreeMesh(this.device, 31), dead2: deadTreeMesh(this.device, 77), rock: rockMesh(this.device) };
    const buckets = new Map();
    this.bucketAdd = (kind, x, ...rest) => {
      const z = rest[1];
      const cx = clamp(Math.floor((x + WORLD.half) / size), 0, chunks - 1);
      const cz = clamp(Math.floor((z + WORLD.half) / size), 0, chunks - 1);
      const k = cz * chunks + cx;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { pine: [], round: [], dead: [], dead2: [], rock: [], thorn: [] }));
      b[kind].push(x, ...rest);
    };
    this.propBuckets = buckets;
    this.propMeshes = meshes;
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
      this.bucketAdd('rock', x, this.hf.at(x, z) - 0.15 * s, z, s, rng() * Math.PI * 2, 0.8 + rng() * 0.4, rng(), 0);
      this.colliders.add(x, z, 0.55 * s);
      if (s > 0.8) this.rocks.push([x, z, s]);
    }
  }

  /** Bramble walls: thorn thickets + deadfall along each wall line, plus closing tree rows. */
  buildWalls() {
    const rng = mulberry32(808);
    const thorn = thornMesh(this.device);
    this.propMeshes.thorn = thorn;
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
      this.bucketAdd('rock', tx, this.hf.at(tx, tz) - 0.3, tz, s, rng() * 6.28, 0.7, rng(), 0);
      this.colliders.add(tx, tz, 0.6 * s);
    }
    this.flushProps();
  }

  flushProps() {
    const worldMis = [], reflMis = [];
    const heights = { pine: 4.6, round: 4.2, dead: 10, dead2: 10, rock: 1.0, thorn: 1.8 };
    for (const b of this.propBuckets.values()) {
      for (const kind of ['pine', 'round', 'dead', 'dead2', 'rock', 'thorn']) {
        const arr = b[kind];
        if (!arr.length) continue;
        const count = arr.length / 8;
        let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
        for (let i = 0; i < arr.length; i += 8) {
          const s = arr[i + 3], m = (kind === 'dead' || kind === 'dead2' ? 4.2 : 1.6) * s;
          minX = Math.min(minX, arr[i] - m); maxX = Math.max(maxX, arr[i] + m);
          minZ = Math.min(minZ, arr[i + 2] - m); maxZ = Math.max(maxZ, arr[i + 2] + m);
          minY = Math.min(minY, arr[i + 1]); maxY = Math.max(maxY, arr[i + 1] + heights[kind] * s);
        }
        const aabb = new pc.BoundingBox();
        aabb.setMinMax(new pc.Vec3(minX, minY, minZ), new pc.Vec3(maxX, maxY, maxZ));
        const mat = kind === 'rock' ? this.mats.rocks : this.mats.props;
        const mi = this.makeInstanced(this.propMeshes[kind], mat, new Float32Array(arr), count, aabb);
        const cxw = (minX + maxX) / 2, czw = (minZ + maxZ) / 2;
        const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2;
        this.clusters.push({ mi, x: cxw, z: czw, radius, base: count, kind });
        const nearPond = Math.hypot(cxw - WORLD.pond.x, czw - WORLD.pond.z) < radius + WORLD.pond.r + 6;
        (nearPond ? reflMis : worldMis).push(mi);
      }
    }
    this.addEntity('props', worldMis, false);
    this.addEntity('props-reflected', reflMis, true);
    this.propBuckets = null;
  }

  // --------------------------------------------------------------- tall grass patches
  buildGrass() {
    const rng = mulberry32(99);
    const size = 16;
    const chunks = (WORLD.half * 2) / size;
    const mesh = grassTuftMesh(this.device);
    const mis = [];
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
        let minY = 1e9, maxY = -1e9;
        for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1] + 1.4); }
        const aabb = new pc.BoundingBox();
        aabb.setMinMax(new pc.Vec3(x0 - 1, minY, z0 - 1), new pc.Vec3(x0 + size + 1, maxY, z0 + size + 1));
        const mi = this.makeInstanced(mesh, this.mats.grass, data, pts.length, aabb);
        mis.push(mi);
        this.clusters.push({ mi, x: x0 + size / 2, z: z0 + size / 2, radius: size * 0.71, base: pts.length, kind: 'grass' });
      }
    }
    if (mis.length) this.addEntity('grass', mis, false);
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
  }

  /** Distance culling + grass LOD. fx/fz = camera focus point. */
  update(fx, fz, camX, camZ) {
    const dd = this.drawDistance;
    let vis = 0;
    for (let i = 0; i < this.clusters.length; i++) {
      const c = this.clusters[i];
      const d = Math.min(Math.hypot(c.x - fx, c.z - fz), Math.hypot(c.x - camX, c.z - camZ)) - c.radius;
      if (c.kind === 'grass') {
        let lod = 0;
        if (d < 10) lod = 1;
        else if (d < 22) lod = 0.5;
        else if (d < 34) lod = 0.2;
        const n = Math.floor(c.base * lod * this.grassDensity);
        c.mi.visible = n > 0;
        if (n > 0) c.mi.instancingCount = n;
      } else {
        c.mi.visible = d < dd;
      }
      if (c.mi.visible) vis++;
    }
    const ff = this.fireflies;
    ff.mi.visible = this.fireflyCount > 0;
    if (ff.mi.visible) ff.mi.instancingCount = Math.min(ff.max, this.fireflyCount);
    this.visibleClusters = vis;
  }
}
