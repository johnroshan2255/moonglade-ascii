// Procedural low-poly mesh building. Everything is vertex-coloured; colour alpha packs the
// glyph class + sway weight (see shaders.js) so a whole prop is a single draw call.
import * as pc from 'playcanvas';
import { CLS } from './shaders.js';
import { mulberry32 } from './noise.js';

export function rgba(r, g, b, cls, sway = 0) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [c(r), c(g), c(b), cls * 32 + Math.round(Math.max(0, Math.min(1, sway)) * 31)];
}

export class MeshBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }

  get count() { return this.p.length / 3; }

  vert(x, y, z, nx, ny, nz, col) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(col[0], col[1], col[2], col[3]);
    return this.count - 1;
  }

  tri(a, b, c) { this.i.push(a, b, c); }

  build(device) {
    const mesh = new pc.Mesh(device);
    mesh.setPositions(this.p);
    mesh.setNormals(this.n);
    mesh.setColors32(this.c);
    mesh.setIndices(this.i);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
  }
}

/**
 * Cylinder / cone / frustum along +Y with smooth sides.
 * colFn(t) -> rgba, t = 0 at base, 1 at top.
 */
export function addCylinder(mb, { x = 0, y = 0, z = 0, r0, r1, h, seg = 8, colFn, capTop = true, capBottom = false, jitter = 0, rng = Math.random }) {
  const base = mb.count;
  const slope = (r0 - r1) / h;
  const rows = 2;
  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1);
    const r = r0 + (r1 - r0) * t;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const j = jitter ? 1 + (rng() - 0.5) * jitter : 1;
      const len = Math.hypot(1, slope);
      mb.vert(x + ca * r * j, y + t * h, z + sa * r * j, ca / len, slope / len, sa / len, colFn(t));
    }
  }
  for (let s = 0; s < seg; s++) {
    const a = base + s, b = a + 1, c = a + seg + 1, d = c + 1;
    mb.tri(a, c, b);
    mb.tri(b, c, d);
  }
  if (capTop && r1 > 0.001) {
    const centre = mb.vert(x, y + h, z, 0, 1, 0, colFn(1));
    const ring = mb.count;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      mb.vert(x + Math.cos(a) * r1, y + h, z + Math.sin(a) * r1, 0, 1, 0, colFn(1));
    }
    for (let s = 0; s < seg; s++) mb.tri(centre, ring + s + 1, ring + s);
  }
  if (capBottom && r0 > 0.001) {
    const centre = mb.vert(x, y, z, 0, -1, 0, colFn(0));
    const ring = mb.count;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      mb.vert(x + Math.cos(a) * r0, y, z + Math.sin(a) * r0, 0, -1, 0, colFn(0));
    }
    for (let s = 0; s < seg; s++) mb.tri(centre, ring + s, ring + s + 1);
  }
}

/** UV-sphere; colFn(ny) where ny is -1..1 local height. */
export function addSphere(mb, { x = 0, y = 0, z = 0, r, sy = 1, segW = 8, segH = 6, colFn, jitter = 0, rng = Math.random }) {
  const base = mb.count;
  for (let iy = 0; iy <= segH; iy++) {
    const v = iy / segH;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= segW; ix++) {
      const th = (ix / segW) * Math.PI * 2;
      let nx = Math.sin(phi) * Math.cos(th);
      const ny = Math.cos(phi);
      let nz = Math.sin(phi) * Math.sin(th);
      // keep the seam welded when jittering
      const j = jitter && ix < segW && iy > 0 && iy < segH ? 1 + (rng() - 0.5) * jitter : 1;
      mb.vert(x + nx * r * j, y + ny * r * sy * j, z + nz * r * j, nx, ny, nz, colFn(ny));
    }
  }
  if (jitter) {
    // weld seam: copy column 0 to column segW
    for (let iy = 0; iy <= segH; iy++) {
      const a = (base + iy * (segW + 1)) * 3, b = (base + iy * (segW + 1) + segW) * 3;
      mb.p[b] = mb.p[a]; mb.p[b + 1] = mb.p[a + 1]; mb.p[b + 2] = mb.p[a + 2];
    }
  }
  for (let iy = 0; iy < segH; iy++) {
    for (let ix = 0; ix < segW; ix++) {
      const a = base + iy * (segW + 1) + ix;
      const b = a + 1, c = a + segW + 1, d = c + 1;
      mb.tri(a, b, c);
      mb.tri(b, d, c);
    }
  }
}

/** Box with flat faces, rotated around Y then optionally tilted around its local X. */
export function addBox(mb, { x = 0, y = 0, z = 0, sx, sy, sz, rot = 0, tilt = 0, col }) {
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const xf = (px, py, pz) => {
    // tilt around X
    const ty = py * ct - pz * st, tz = py * st + pz * ct;
    // rotate around Y
    return [x + cr * px + sr * tz, y + ty, z - sr * px + cr * tz];
  };
  const nf = (nx, ny, nz) => {
    const ty = ny * ct - nz * st, tz = ny * st + nz * ct;
    return [cr * nx + sr * tz, ty, -sr * nx + cr * tz];
  };
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
  ];
  for (const [n, quad] of faces) {
    const [nx, ny, nz] = nf(...n);
    const b = mb.count;
    for (const q of quad) {
      const [px, py, pz] = xf(...q);
      mb.vert(px, py, pz, nx, ny, nz, typeof col === 'function' ? col(q[1] / sy + 0.5) : col);
    }
    mb.tri(b, b + 1, b + 2);
    mb.tri(b, b + 2, b + 3);
  }
}

// ---------------------------------------------------------------- organic primitives

/** Catmull-Rom resample of [[x,y,z,r], ...] control points. */
function spline(pts, subdiv) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
    for (let s = 0; s < subdiv; s++) {
      const t = s / subdiv, t2 = t * t, t3 = t2 * t;
      const c = (k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([c(0), c(1), c(2), p1[3] + (p2[3] - p1[3]) * (t * t * (3 - 2 * t))]);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

/**
 * Smooth tapered tube along a curve: limbs, tails, ribs, branches, moss strands, chains...
 * pts: [[x, y, z, radius], ...]; colFn(t) -> rgba, t = 0..1 along the tube.
 */
export function addTube(mb, pts, { seg = 6, subdiv = 3, colFn, capEnd = true, capStart = false }) {
  const S = spline(pts, subdiv);
  const n = S.length;
  const base = mb.count;
  let N = null;
  let len = 0;
  const lens = [0];
  for (let i = 1; i < n; i++) { len += Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1], S[i][2] - S[i - 1][2]); lens.push(len); }
  for (let i = 0; i < n; i++) {
    const a = S[Math.max(i - 1, 0)], b = S[Math.min(i + 1, n - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    if (!N) {
      // any vector perpendicular to the first tangent
      let ux = 0, uy = 1, uz = 0;
      if (Math.abs(ty) > 0.9) { ux = 1; uy = 0; }
      N = [uy * tz - uz * ty, uz * tx - ux * tz, ux * ty - uy * tx];
    }
    // parallel transport: remove the tangent component
    const d = N[0] * tx + N[1] * ty + N[2] * tz;
    N = [N[0] - tx * d, N[1] - ty * d, N[2] - tz * d];
    const nl = Math.hypot(N[0], N[1], N[2]) || 1;
    N = [N[0] / nl, N[1] / nl, N[2] / nl];
    const B = [ty * N[2] - tz * N[1], tz * N[0] - tx * N[2], tx * N[1] - ty * N[0]];
    const t = len > 0 ? lens[i] / len : 0;
    const col = colFn(t);
    const r = S[i][3];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const nx = N[0] * c + B[0] * s, ny = N[1] * c + B[1] * s, nz = N[2] * c + B[2] * s;
      mb.vert(S[i][0] + nx * r, S[i][1] + ny * r, S[i][2] + nz * r, nx, ny, nz, col);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = base + i * seg + k, b = base + i * seg + ((k + 1) % seg), c = a + seg, d = b + seg;
      mb.tri(a, b, c);
      mb.tri(b, d, c);
    }
  }
  const cap = (i, flip) => {
    if (S[i][3] < 0.004) return;
    const p = S[i];
    const q = S[flip ? 1 : n - 2];
    let tx = p[0] - q[0], ty = p[1] - q[1], tz = p[2] - q[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const c = mb.vert(p[0], p[1], p[2], tx / tl, ty / tl, tz / tl, colFn(flip ? 0 : 1));
    const r0 = base + i * seg;
    for (let k = 0; k < seg; k++) {
      const a = r0 + k, b = r0 + ((k + 1) % seg);
      if (flip) mb.tri(c, b, a); else mb.tri(c, a, b);
    }
  };
  if (capEnd) cap(n - 1, false);
  if (capStart) cap(0, true);
}

/**
 * Surface of revolution around +Y: bodies, robes, bells, skulls, hats.
 * profile: [[radius, y], ...] bottom -> top. sx/sz squash the cross-section.
 * warp(x, y, z) -> [x, y, z] optionally bends the result (hunches, leans).
 */
export function addLathe(mb, profile, { seg = 12, x = 0, y = 0, z = 0, sx = 1, sz = 1, colFn, jitter = 0, rng = Math.random, warp }) {
  const base = mb.count;
  const n = profile.length;
  for (let j = 0; j < n; j++) {
    const [r, py] = profile[j];
    const a = profile[Math.max(j - 1, 0)], b = profile[Math.min(j + 1, n - 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    const nr = dy / l, ny = -dr / l; // outward normal in the (radial, y) plane
    const t = (py - profile[0][1]) / ((profile[n - 1][1] - profile[0][1]) || 1);
    const col = colFn(t, py);
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const j2 = jitter && k < seg && r > 0.001 ? 1 + (rng() - 0.5) * jitter : 1;
      let px = c * r * sx * j2, pz = s * r * sz * j2, pyy = py;
      let nx = c * nr / sx, nyy = ny, nz = s * nr / sz;
      const nl = Math.hypot(nx, nyy, nz) || 1;
      if (warp) [px, pyy, pz] = warp(px, pyy, pz);
      mb.vert(x + px, y + pyy, z + pz, nx / nl, nyy / nl, nz / nl, col);
    }
    if (jitter) { // weld the seam
      const i0 = (base + j * (seg + 1)) * 3, i1 = (base + j * (seg + 1) + seg) * 3;
      mb.p[i1] = mb.p[i0]; mb.p[i1 + 1] = mb.p[i0 + 1]; mb.p[i1 + 2] = mb.p[i0 + 2];
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const a = base + j * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
      mb.tri(a, c, b);
      mb.tri(b, c, d);
    }
  }
}

/** Flat membrane (wings, cloth): fan from a root point to an outline. Use a double-sided material. */
export function addFan(mb, root, outline, colFn) {
  // true plane normal from the outline (two-sided lighting flips it per view)
  const p0 = outline[0], p1 = outline[outline.length >> 1];
  const ux = p0[0] - root[0], uy = p0[1] - root[1], uz = p0[2] - root[2];
  const vx = p1[0] - root[0], vy = p1[1] - root[1], vz = p1[2] - root[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const c = mb.vert(root[0], root[1], root[2], nx, ny, nz, colFn(0));
  const b = mb.count;
  outline.forEach((p, i) => mb.vert(p[0], p[1], p[2], nx, ny, nz, colFn(i / (outline.length - 1))));
  for (let i = 0; i < outline.length - 1; i++) mb.tri(c, b + i, b + i + 1);
}

// ---------------------------------------------------------------- props

export function pineMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(11);
  addCylinder(mb, { r0: 0.2, r1: 0.12, h: 1.4, seg: 6, colFn: () => rgba(0.08, 0.07, 0.06, CLS.GROUND, 0), capTop: false });
  const tiers = [[0.9, 1.45, 1.9], [1.9, 1.1, 1.6], [2.8, 0.75, 1.4]];
  for (const [y, r, h] of tiers) {
    addCylinder(mb, {
      y, r0: r, r1: 0, h, seg: 7, jitter: 0.25, rng,
      colFn: (t) => rgba(0.05 + t * 0.03, 0.09 + t * 0.06, 0.07 + t * 0.03, CLS.FOLIAGE, (y + t * h) / 4.4),
      capBottom: true,
    });
  }
  return mb.build(device);
}

export function roundTreeMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(23);
  addCylinder(mb, { r0: 0.22, r1: 0.14, h: 1.9, seg: 6, colFn: () => rgba(0.08, 0.07, 0.06, CLS.GROUND, 0), capTop: false });
  const blobs = [[0, 2.6, 0, 1.25], [0.6, 2.2, 0.3, 0.85], [-0.5, 2.3, -0.4, 0.9], [0.1, 3.3, -0.1, 0.8]];
  for (const [x, y, z, r] of blobs) {
    addSphere(mb, {
      x, y, z, r, segW: 8, segH: 6, jitter: 0.22, rng,
      colFn: (ny) => rgba(0.08 + ny * 0.03, 0.11 + ny * 0.05, 0.09, CLS.FOLIAGE, (y + ny * r) / 4.0),
    });
  }
  return mb.build(device);
}

/** Gnarled leafless tree: a recursively branching, tapering silhouette against the haze. */
export function deadTreeMesh(device, seed = 31) {
  const mb = new MeshBuilder();
  const rng = mulberry32(seed);
  const H = 9;
  const bark = (y) => rgba(0.055 + y * 0.015, 0.05 + y * 0.013, 0.045 + y * 0.012, CLS.FOLIAGE, Math.min(1, Math.max(0, (y - 1.5) / 7)) * 0.8);
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  function branch(p, dir, len, r, depth) {
    const pts = [[p[0], p[1], p[2], r]];
    const steps = depth === 0 ? 6 : 4;
    let d = dir.slice(), q = p.slice();
    for (let i = 1; i <= steps; i++) {
      // kinks + a slight upward pull, like a tree fighting for light that never comes
      d = norm([d[0] + (rng() - 0.5) * 0.5, d[1] + (rng() - 0.35) * 0.3 + (depth ? 0.08 : 0), d[2] + (rng() - 0.5) * 0.5]);
      const sl = len / steps;
      q = [q[0] + d[0] * sl, q[1] + d[1] * sl, q[2] + d[2] * sl];
      pts.push([q[0], q[1], q[2], r * (1 - (i / steps) * 0.72)]);
    }
    const sp = pts;
    addTube(mb, sp, { seg: depth === 0 ? 8 : depth === 1 ? 5 : 4, subdiv: depth === 0 ? 3 : 2, colFn: (t) => bark(sp[0][1] + (sp[sp.length - 1][1] - sp[0][1]) * t) });
    if (depth >= 3) return;
    const kids = depth === 0 ? 4 : 2 + Math.floor(rng() * 2);
    for (let k = 0; k < kids; k++) {
      const at = depth === 0 ? 0.35 + (k / kids) * 0.6 : 0.4 + rng() * 0.55;
      const idx = Math.min(sp.length - 1, Math.round(at * (sp.length - 1)));
      const o = sp[idx];
      const ang = rng() * Math.PI * 2;
      const out = 0.55 + rng() * 0.5;
      const nd = norm([Math.cos(ang) * out + dir[0] * 0.3, 0.55 + rng() * 0.5, Math.sin(ang) * out + dir[2] * 0.3]);
      branch([o[0], o[1], o[2]], nd, len * (0.42 + rng() * 0.2), o[3] * 0.62, depth + 1);
    }
  }
  // flared, root-gripped base
  addLathe(mb, [[0.62, -0.2], [0.5, 0.1], [0.36, 0.45], [0.3, 0.9]], { seg: 8, jitter: 0.35, rng, colFn: () => bark(0) });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng();
    addTube(mb, [[0, 0.5, 0, 0.16], [Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6, 0.12], [Math.cos(a) * 1.1, -0.15, Math.sin(a) * 1.1, 0.05]], { seg: 5, colFn: () => bark(0) });
  }
  branch([0, 0.4, 0], [0.08, 1, 0.04], H * 0.82, 0.3, 0);
  return mb.build(device);
}

/** Bramble: arching thorny vines that knot together into a wall. */
export function thornMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(404);
  const col = (t) => rgba(0.045 + t * 0.02, 0.042 + t * 0.018, 0.038 + t * 0.015, CLS.FOLIAGE, t * 0.6);
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const reach = 0.8 + rng() * 1.0;
    const h = 0.7 + rng() * 1.0;
    const ox = (rng() - 0.5) * 0.6, oz = (rng() - 0.5) * 0.6;
    const pts = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push([ox + Math.cos(a) * reach * t + (rng() - 0.5) * 0.15, Math.sin(t * Math.PI) * h, oz + Math.sin(a) * reach * t + (rng() - 0.5) * 0.15, 0.045 * (1 - t * 0.6)]);
    }
    addTube(mb, pts, { seg: 4, subdiv: 2, colFn: col });
    for (let k = 1; k < 5; k++) {
      const p = pts[k];
      const ta = rng() * Math.PI * 2;
      addTube(mb, [[p[0], p[1], p[2], 0.02], [p[0] + Math.cos(ta) * 0.14, p[1] + 0.05, p[2] + Math.sin(ta) * 0.14, 0.0]], { seg: 3, subdiv: 1, colFn: () => col(0.8) });
    }
  }
  return mb.build(device);
}

export function rockMesh(device, seed = 5) {
  const mb = new MeshBuilder();
  const rng = mulberry32(seed);
  addSphere(mb, {
    r: 0.7, sy: 0.62, segW: 7, segH: 5, jitter: 0.45, rng,
    colFn: (ny) => rgba(0.19 + ny * 0.05, 0.2 + ny * 0.05, 0.19 + ny * 0.05, CLS.STONE, 0),
  });
  return mb.build(device);
}

/** Tall grass tuft: a handful of thin blades. Tip sway = 1, base = 0. */
export function grassTuftMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(77);
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rng() * 0.6;
    const ox = Math.cos(a) * 0.12, oz = Math.sin(a) * 0.12;
    const h = 0.55 + rng() * 0.35;
    const lean = 0.15 + rng() * 0.2;
    const w = 0.07;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const tx = ox + Math.cos(a) * lean, tz = oz + Math.sin(a) * lean;
    const base = rgba(0.03, 0.035, 0.02, CLS.GRASS, 0);
    const tip = rgba(0.15, 0.2, 0.09, CLS.GRASS, 1);
    const nx = Math.cos(a) * 0.3, nz = Math.sin(a) * 0.3;
    const b0 = mb.vert(ox - px, 0, oz - pz, nx, 1, nz, base);
    const b1 = mb.vert(ox + px, 0, oz + pz, nx, 1, nz, base);
    const t0 = mb.vert(tx, h, tz, nx, 1, nz, tip);
    mb.tri(b0, b1, t0);
  }
  return mb.build(device);
}

export function fireflyMesh(device) {
  const mb = new MeshBuilder();
  addSphere(mb, { r: 0.06, segW: 4, segH: 2, colFn: () => rgba(0.8, 0.8, 0.76, CLS.GLOW, 0) });
  return mb.build(device);
}

export function wispMesh(device) {
  const mb = new MeshBuilder();
  addSphere(mb, { r: 0.3, segW: 6, segH: 4, colFn: (ny) => rgba(0.55 + ny * 0.1, 0.9, 1.0, CLS.GLOW, 0) });
  // trailing tail
  addCylinder(mb, { y: -0.75, r0: 0.0, r1: 0.18, h: 0.6, seg: 5, colFn: (t) => rgba(0.3 + t * 0.3, 0.6 + t * 0.3, 0.9, CLS.GLOW, 0), capTop: false });
  return mb.build(device);
}

/** Ember core: a heavy faceted amber stone with a glowing heart. */
export function emberCoreMesh(device) {
  const mb = new MeshBuilder();
  const rng = mulberry32(9);
  addSphere(mb, { r: 0.32, segW: 6, segH: 4, jitter: 0.3, rng, colFn: (ny) => rgba(1.0, 0.55 + ny * 0.1, 0.18, CLS.GLOW, 0) });
  return mb.build(device);
}

/** The heart-spore: a pale seed with spines. */
export function heartMesh(device) {
  const mb = new MeshBuilder();
  addSphere(mb, { r: 0.24, segW: 7, segH: 5, colFn: () => rgba(1.0, 0.82, 0.55, CLS.GLOW, 0) });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addBox(mb, { x: Math.cos(a) * 0.3, y: 0, z: Math.sin(a) * 0.3, sx: 0.04, sy: 0.32, sz: 0.04, rot: -a, tilt: Math.PI / 2, col: rgba(0.9, 0.7, 0.45, CLS.GLOW, 0) });
  }
  return mb.build(device);
}

/** Full-screen quad in NDC. */
export function quadMesh(device) {
  const mesh = new pc.Mesh(device);
  mesh.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}
