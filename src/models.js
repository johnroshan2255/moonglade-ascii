// Authored models: built in Blender by tools/blender/build_models.py and shipped as one small
// binary (public/models/glade.hwm). They are the near-camera level of detail on capable devices;
// the procedural meshes in meshes.js remain the far LOD and the whole story on weak ones, so the
// game still runs (and looks the same from a distance) if the pack is missing.
//
// Pack layout: 'HWM1', uint32 header length, JSON header, then per part:
//   int16 x4 per vertex (position, quantised over the part's bounds; 4th unused)
//   int8  x4 per vertex (normal; 4th unused)
//   uint8 x4 per vertex (rgb with baked occlusion, a = glyph class * 32 + sway * 31)
//   uint16 / uint32 triangle indices
// Parts flagged "flat" are stored welded and un-welded here: every triangle its own normal.
import * as pc from 'playcanvas';

const MODELS = new Map(); // name -> { p: Float32Array, n: Float32Array, c: Uint8Array, i: Uint32Array, points }
const MESHES = new Map(); // name -> pc.Mesh (shared, kept alive across LOD swaps)

function decodePart(buf, base, part, out) {
  const { v, i, off, flat, wide, min, max } = part;
  const q = new Int16Array(buf, base + off, v * 4);
  const nb = new Int8Array(buf, base + off + v * 8, v * 4);
  const cb = new Uint8Array(buf, base + off + v * 12, v * 4);
  const idx = wide ? new Uint32Array(buf, base + off + v * 16, i) : new Uint16Array(buf, base + off + v * 16, i);
  const sx = (max[0] - min[0]) / 65535, sy = (max[1] - min[1]) / 65535, sz = (max[2] - min[2]) / 65535;
  const px = (k) => min[0] + (q[k * 4] + 32768) * sx;
  const py = (k) => min[1] + (q[k * 4 + 1] + 32768) * sy;
  const pz = (k) => min[2] + (q[k * 4 + 2] + 32768) * sz;
  const first = out.p.length / 3;
  if (!flat) {
    for (let k = 0; k < v; k++) {
      out.p.push(px(k), py(k), pz(k));
      out.n.push(nb[k * 4] / 127, nb[k * 4 + 1] / 127, nb[k * 4 + 2] / 127);
      out.c.push(cb[k * 4], cb[k * 4 + 1], cb[k * 4 + 2], cb[k * 4 + 3]);
    }
    for (let k = 0; k < i; k++) out.i.push(first + idx[k]);
    return;
  }
  for (let t = 0; t < i; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = px(a), ay = py(a), az = pz(a);
    const ux = px(b) - ax, uy = py(b) - ay, uz = pz(b) - az;
    const vx = px(c) - ax, vy = py(c) - ay, vz = pz(c) - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    const at = out.p.length / 3;
    for (const k of [a, b, c]) {
      out.p.push(px(k), py(k), pz(k));
      out.n.push(nx, ny, nz);
      out.c.push(cb[k * 4], cb[k * 4 + 1], cb[k * 4 + 2], cb[k * 4 + 3]);
    }
    out.i.push(at, at + 1, at + 2);
  }
}

/** Fetches and decodes the pack. Resolves false (never throws) if it is missing or malformed. */
export async function loadModels(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const head = new DataView(buf);
    if (head.getUint32(0, true) !== 0x314d5748) return false; // 'HWM1'
    const jl = head.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const base = 8 + jl;
    for (const [name, m] of Object.entries(header.meshes)) {
      const out = { p: [], n: [], c: [], i: [] };
      for (const part of m.parts) decodePart(buf, base, part, out);
      MODELS.set(name, { p: new Float32Array(out.p), n: new Float32Array(out.n), c: new Uint8Array(out.c), i: new Uint32Array(out.i), points: m.points || {} });
    }
    return true;
  } catch (err) {
    console.warn('models: falling back to procedural meshes', err);
    MODELS.clear();
    return false;
  }
}

export const hasModel = (name) => MODELS.has(name);

/** Named marker points of a model (e.g. where a rune or an eye sits), in model space. */
export const modelPoints = (name) => (MODELS.get(name) || { points: {} }).points;

/** A shared GPU mesh for a model (null if the pack is not loaded). Safe to swap in and out as a LOD. */
export function modelMesh(device, name) {
  if (MESHES.has(name)) return MESHES.get(name);
  const m = MODELS.get(name);
  if (!m) return null;
  const mesh = new pc.Mesh(device);
  mesh.setPositions(m.p);
  mesh.setNormals(m.n);
  mesh.setColors32(m.c);
  mesh.setIndices(m.i);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  mesh.incRefCount(); // LOD swaps drop references; never let that destroy a shared mesh
  MESHES.set(name, mesh);
  return mesh;
}

/**
 * Appends a model to a MeshBuilder: scaled (sx, sy, sz), turned about Y by rot, moved to (x, y, z).
 * tint multiplies its colour. Returns false if the model is not available.
 */
export function appendModel(mb, name, { x = 0, y = 0, z = 0, rot = 0, sx = 1, sy = 1, sz = 1, tint = 1 } = {}) {
  const m = MODELS.get(name);
  if (!m) return false;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const base = mb.count;
  const { p, n, c, i } = m;
  for (let k = 0; k < p.length / 3; k++) {
    const lx = p[k * 3] * sx, ly = p[k * 3 + 1] * sy, lz = p[k * 3 + 2] * sz;
    // normals go through the inverse scale, then the same turn
    let nx = n[k * 3] / sx, ny = n[k * 3 + 1] / sy, nz = n[k * 3 + 2] / sz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    mb.vert(x + cr * lx + sr * lz, y + ly, z - sr * lx + cr * lz, cr * nx + sr * nz, ny, -sr * nx + cr * nz,
      [Math.min(255, c[k * 4] * tint), Math.min(255, c[k * 4 + 1] * tint), Math.min(255, c[k * 4 + 2] * tint), c[k * 4 + 3]]);
  }
  for (let k = 0; k < i.length; k += 3) mb.tri(base + i[k], base + i[k + 1], base + i[k + 2]);
  return true;
}
