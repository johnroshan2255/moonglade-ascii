# Hollow Wick: authored models (boulders, stepping slabs, the gate arch). Built headlessly in
# Blender and packed into one small binary.
#
#   blender -b --factory-startup -P tools/blender/build_models.py -- public/models/glade.hwm [--preview DIR]
#   (npm run models)
#
# Why Blender: bevels, convex hulls, voxel remeshing, the skin modifier and ray-traced ambient
# occlusion give stone that looks cut and worn, moss that sits on things as a thick cushion, and
# creatures that are one faceted body instead of intersecting tubes. Everything is still
# generated from seeds, so the pack is reproducible and there are no hand-edited files.
#
# What the game gets (see src/models.js): per model, a list of parts. Each part is a triangle
# mesh with 16-bit positions, 8-bit normals and RGBA vertex colours, where RGB already contains
# the baked occlusion and A = glyph class * 32 + sway * 31 (the same packing meshes.js uses).
# Parts flagged "flat" are stored welded and un-welded by the loader (every face its own normal).
# Blender is z-up; the pack is written y-up (x, z, -y).

import bpy, bmesh, math, random, struct, json, sys, os, time
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

CLS = dict(GROUND=1, GRASS=2, FOLIAGE=3, STONE=4, WATER=5, CHAR=6, GLOW=7)
TAU = math.pi * 2
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


def clamp01(x): return max(0.0, min(1.0, x))
def mix(a, b, t): return a + (b - a) * t
def smooth(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
def mixc(a, b, t): return (mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t))
def mulc(a, k): return (a[0] * k, a[1] * k, a[2] * k)


# ------------------------------------------------------------------ geometry plumbing
class Soup:
    """A triangle mesh in Blender coordinates with per-vertex colour, glyph class and sway."""

    def __init__(self, flat=False, ao=(0.3, 1.0)):
        self.flat = flat      # un-weld in the loader: every triangle gets its own normal
        self.ao = ao          # (colour multiplier where fully occluded, exponent)
        self.v, self.n, self.c, self.cls, self.t = [], [], [], [], []

    def add(self, verts, norms, tris, colour, cls, sway=0.0):
        """colour / sway may be constants or functions of (position, normal, vertex index)."""
        base = len(self.v)
        for i, (p, nn) in enumerate(zip(verts, norms)):
            self.v.append(p.copy())
            self.n.append(nn.copy())
            self.c.append(colour(p, nn, i) if callable(colour) else colour)
            self.cls.append((cls, sway(p, nn, i) if callable(sway) else sway))
        self.t += [(a + base, b + base, c + base) for a, b, c in tris]
        return self


def evaluate(bm, mods=()):
    """bmesh -> temporary object -> modifiers -> (verts, vertex normals, triangles)."""
    me = bpy.data.meshes.new('tmp')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('tmp', me)
    bpy.context.scene.collection.objects.link(ob)
    for kind, props in mods:
        m = ob.modifiers.new(kind, kind)
        for k, val in props.items():
            setattr(m, k, val)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = ob.evaluated_get(dg)
    em = ev.to_mesh()
    em.calc_loop_triangles()
    verts = [v.co.copy() for v in em.vertices]
    norms = [v.normal.copy() for v in em.vertices]
    tris = [tuple(t.vertices) for t in em.loop_triangles]
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return verts, norms, tris


def area_normals(verts, tris, power=2.0):
    """Vertex normals weighted by face area^power: big faces stay flat, bevels carry the curve."""
    acc = [Vector((0, 0, 0)) for _ in verts]
    for a, b, c in tris:
        fn = (verts[b] - verts[a]).cross(verts[c] - verts[a])
        w = fn.length
        if w < 1e-12:
            continue
        fn = fn * (w ** (power - 1.0))
        acc[a] += fn
        acc[b] += fn
        acc[c] += fn
    return [(n.normalized() if n.length > 1e-12 else Z.copy()) for n in acc]


def islands(nverts, tris):
    """Connected-component id per vertex (one per stone block)."""
    parent = list(range(nverts))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b, c in tris:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[rc] = ra
    ids, out = {}, []
    for i in range(nverts):
        r = find(i)
        out.append(ids.setdefault(r, len(ids)))
    return out


def hemisphere(k, seed=7):
    """k cosine-weighted directions about +z."""
    r = random.Random(seed)
    out = []
    for i in range(k):
        u, v = (i + r.random()) / k, r.random()
        rad, th = math.sqrt(u), v * TAU
        out.append(Vector((rad * math.cos(th), rad * math.sin(th), math.sqrt(max(0.0, 1 - u)))))
    return out


def bake_ao(soups, dist, ground=None, rays=22):
    """Ray-traced ambient occlusion into the vertex colours of every soup (they shade each other)."""
    verts, tris = [], []
    for s in soups:
        base = len(verts)
        verts += s.v
        tris += [(a + base, b + base, c + base) for a, b, c in s.t]
    if ground is not None:
        base = len(verts)
        g = 60.0
        verts += [Vector((-g, -g, ground)), Vector((g, -g, ground)), Vector((g, g, ground)), Vector((-g, g, ground))]
        tris += [(base, base + 1, base + 2), (base, base + 2, base + 3)]
    bvh = BVHTree.FromPolygons(verts, tris)
    dirs = hemisphere(rays)
    for s in soups:
        lo, power = s.ao
        for i, (p, n) in enumerate(zip(s.v, s.n)):
            t1 = n.cross(Z if abs(n.z) < 0.9 else X).normalized()
            t2 = n.cross(t1)
            o = p + n * 0.012
            occ = 0.0
            for d in dirs:
                wd = t1 * d.x + t2 * d.y + n * d.z
                hit = bvh.ray_cast(o, wd, dist)
                if hit[0] is not None:
                    occ += 1.0 - (hit[3] / dist) * 0.6
            ao = clamp01(1.0 - occ / rays)
            k = mix(lo, 1.0, ao ** power)
            c = s.c[i]
            s.c[i] = (c[0] * k, c[1] * k, c[2] * k)


def hull(points):
    bm = bmesh.new()
    for p in points:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    junk = list({e for key in ('geom_interior', 'geom_unused') for e in res.get(key, []) if isinstance(e, bmesh.types.BMVert)})
    if junk:
        bmesh.ops.delete(bm, geom=junk, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def box_block(bm, c, ax, ay, az, hx, hy, hz, taper=0.0, r=None, jit=0.0):
    """A stone block from a centre and three axes; taper widens it along ax toward +ay (arch wedges)."""
    vs = []
    for i in (-1, 1):
        for j in (-1, 1):
            for k in (-1, 1):
                p = c + ax * (hx * (1 + taper * j) * i) + ay * (hy * j) + az * (hz * k)
                if r is not None and jit:
                    p = p + Vector((r.uniform(-jit, jit), r.uniform(-jit, jit), r.uniform(-jit, jit)))
                vs.append(bm.verts.new(p))
    for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([vs[x] for x in q])


BEVEL = lambda w, seg=1, ang=30: ('BEVEL', dict(width=w, segments=seg, limit_method='ANGLE', angle_limit=math.radians(ang)))


# ------------------------------------------------------------------ materials (vertex colour recipes)
def stone_colour(tone=0.0, warm=0.0, seed=0.0):
    def f(p, n, i):
        v = noise.noise(p * 1.7 + Vector((seed, 3.1, 0))) * 0.035 + noise.noise(p * 6.0 + Vector((0, seed, 9.0))) * 0.02
        g = 0.28 + tone + v  # the game's masonry grey
        return (g + warm, g, g + 0.015 - warm)
    return f


def moss_colour(seed=0.0, dark=1.0):
    def f(p, n, i):
        v = noise.noise(p * 3.1 + Vector((seed, 0, 5))) * 0.25 + noise.noise(p * 11.0 + Vector((2, seed, 0))) * 0.12
        k = (0.78 + 0.5 * clamp01(n.z) + v) * dark
        return (0.085 * k, 0.118 * k, 0.062 * k)  # a dull, cold moss: it sits in a moonlit palette
    return f


def cushions(target, spots, r, seed, voxel=0.05, keep=0.35, lift=0.0):
    """
    Moss as a thick cushion: flattened blobs dropped onto whatever is below each spot, fused by a
    voxel remesh into one lumpy blanket, then given a fine fuzz. target = (verts, tris) to sit on.
    spots = [(x, y, radius)].
    """
    bvh = BVHTree.FromPolygons(target[0], target[1])
    bm = bmesh.new()
    count = 0
    for sx, sy, rad in spots:
        hit = bvh.ray_cast(Vector((sx, sy, 30.0)), -Z, 60.0)
        if hit[0] is None or hit[1].z < 0.35:
            continue
        flat = 0.36 + r.random() * 0.16
        m = Matrix.Translation(hit[0] + Vector((0, 0, lift - rad * flat * 0.25))) @ Matrix.Diagonal((rad, rad * (0.85 + r.random() * 0.3), rad * flat, 1.0))
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=7, radius=1.0, matrix=m)
        count += 1
    if not count:
        bm.free()
        return None
    v, n, t = evaluate(bm, [('REMESH', dict(mode='VOXEL', voxel_size=voxel, use_smooth_shade=True)),
                            ('DECIMATE', dict(ratio=keep))])
    n = area_normals(v, t, 1.0)
    v = [p + nn * ((noise.noise(p * 9.0 + Vector((seed, 0, 0))) * 0.5 + noise.noise(p * 21.0)) * 0.012) for p, nn in zip(v, n)]
    return v, n, t


# ------------------------------------------------------------------ boulders
def rock(seed, sx, sy, sz, npts=24, zoff=0.25):
    """A boulder: the convex hull of a scatter of points, edges worn round, a moss cushion on top."""
    r = random.Random(seed)
    pts = []
    for _ in range(npts):
        d = Vector((r.gauss(0, 1), r.gauss(0, 1), r.gauss(0, 1))).normalized()
        k = 0.8 + r.random() * 0.32
        pts.append((d.x * sx * k, d.y * sy * k, d.z * sz * k + zoff))
    v, n, t = evaluate(hull(pts), [BEVEL(0.1, 2, 18)])
    n = area_normals(v, t)
    v = [p + nn * (noise.noise(p * 2.6 + Vector((seed, 0, 0))) * 0.018) for p, nn in zip(v, n)]
    body = Soup(ao=(0.45, 1.0)).add(v, n, t, stone_colour(-0.06, 0.0, seed), CLS['STONE'])  # boulders are darker than cut stone
    parts = [body]
    # the moss grows from one side over the crown and leaves bare stone on the other
    k = min(sx, sy) / 0.7
    side = r.random() * TAU
    ox, oy = math.cos(side) * 0.16 * sx, math.sin(side) * 0.16 * sy
    spots = [(ox + r.uniform(-0.32, 0.32) * sx, oy + r.uniform(-0.32, 0.32) * sy, (0.2 + r.random() * 0.14) * k) for _ in range(7)]
    spots.append((ox * 0.5, oy * 0.5, 0.27 * k))
    cap = cushions((v, t), spots, r, seed, voxel=0.045, keep=0.22)
    if cap:
        parts.append(Soup(ao=(0.45, 1.0)).add(cap[0], cap[1], cap[2], moss_colour(seed), CLS['STONE']))
    bake_ao(parts, 0.9, ground=0.15)
    return dict(parts=parts)


# ------------------------------------------------------------------ stepping slabs
def slab(seed):
    """A worn stepping slab, radius ~1, top at z = 0, 0.46 deep. Sides go dark toward the water."""
    r = random.Random(seed)
    sides = r.choice([7, 8, 9])
    a0 = r.random() * TAU
    rad = [0.86 + r.random() * 0.26 for _ in range(sides)]
    bm = bmesh.new()
    top = [bm.verts.new((math.cos(a0 + k / sides * TAU) * rad[k], math.sin(a0 + k / sides * TAU) * rad[k] * 0.94, 0.0)) for k in range(sides)]
    bot = [bm.verts.new((p.co.x * 1.06, p.co.y * 1.06, -0.46)) for p in top]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bot)))
    for k in range(sides):
        bm.faces.new((top[k], bot[k], bot[(k + 1) % sides], top[(k + 1) % sides]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    v, n, t = evaluate(bm, [BEVEL(0.06, 2, 30)])
    n = area_normals(v, t)
    # a couple of chipped corners on the rim
    for _ in range(3):
        a = r.random() * TAU
        cx, cy = math.cos(a) * 0.95, math.sin(a) * 0.9
        for i, p in enumerate(v):
            d = math.hypot(p.x - cx, p.y - cy)
            if d < 0.3 and p.z > -0.2:
                k = (1 - d / 0.3) * 0.07
                v[i] = Vector((p.x - cx * k, p.y - cy * k, p.z - k * 0.6))
    tone = r.uniform(-0.02, 0.03)
    base = stone_colour(tone, 0.006, seed)

    def col(p, nn, i):
        c = base(p, nn, i)
        return mulc(c, mix(0.5, 1.0, smooth(-0.44, -0.04, p.z)) if nn.z < 0.6 else 1.03)
    s = Soup(ao=(0.5, 1.0)).add(v, n, t, col, CLS['STONE'])
    bake_ao([s], 0.5)
    return dict(parts=[s])


# ------------------------------------------------------------------ masonry
def masonry_soup(bm, r, seed, bevel=0.034, mossy=0.4):
    """Bevels every block of a bmesh, tints each block a little differently, mosses some tops."""
    v, n, t = evaluate(bm, [BEVEL(bevel, 1, 30)])
    v = [p + Vector((noise.noise(p * 3.0 + Vector((seed, 1, 0))), noise.noise(p * 3.0 + Vector((5, seed, 0))), noise.noise(p * 3.0 + Vector((0, 9, seed)))))
         * 0.008 for p in v]
    n = area_normals(v, t)
    isl = islands(len(v), t)
    tint = {}
    for i in set(isl):
        tint[i] = (r.uniform(-0.04, 0.035), r.uniform(-0.006, 0.01), r.random() < mossy)
    base = stone_colour(0.0, 0.0, seed)
    green = moss_colour(seed, 0.95)

    def col(p, nn, i):
        tone, warm, moss = tint[isl[i]]
        c = base(p, nn, i)
        c = (c[0] + tone + warm, c[1] + tone, c[2] + tone - warm)
        if moss and nn.z > 0.45:
            c = mixc(c, green(p, nn, i), smooth(0.45, 0.8, nn.z))
        return c
    return Soup(flat=True, ao=(0.42, 1.0)).add(v, n, t, col, CLS['STONE']), (v, t)


def arch(seed, half, spring, depth, foot=0.0, stubs=False):
    """
    A round arch of rough-cut blocks: two coursed piers (single stones alternating with pairs),
    plinths, a ring of thirteen wedge stones with a proud keystone, and for the ruin the stumps
    of the wall it once stood in. Spans x, rises along z; depth is the half-thickness along y.
    """
    r = random.Random(seed)
    bm = bmesh.new()
    for sgn in (-1, 1):
        px = sgn * (half + 0.5)
        z, course = -foot, 0
        while z < spring - 0.05:
            h = min(0.5 + r.random() * 0.2, spring - z)
            w = 0.52 + r.random() * 0.04
            d = depth * (0.96 + r.random() * 0.08)
            if course % 2 == 0 or h < 0.3:
                box_block(bm, Vector((px + r.uniform(-0.03, 0.03), r.uniform(-0.03, 0.03), z + h / 2)), X, Z, Y, w, h / 2 - 0.012, d, 0, r, 0.012)
            else:
                cut = px + r.uniform(-0.16, 0.16)
                for x0, x1 in ((px - w, cut - 0.012), (cut + 0.012, px + w)):
                    box_block(bm, Vector(((x0 + x1) / 2, r.uniform(-0.04, 0.04), z + h / 2)), X, Z, Y, (x1 - x0) / 2, h / 2 - 0.012, d * (0.94 + r.random() * 0.1), 0, r, 0.012)
            z += h
            course += 1
        box_block(bm, Vector((px, 0, 0.12)), X, Z, Y, 0.66, 0.2, depth + 0.13, 0, r, 0.015)
        if stubs:
            # what is left of the wall: courses stepping down and away from the pier
            for j in range(3):
                x = sgn * (half + 1.62 + j * 1.02)
                top = spring * (0.72 - j * 0.24) + r.uniform(-0.15, 0.15)
                z = -foot
                while z < top:
                    h = 0.42 + r.random() * 0.2
                    box_block(bm, Vector((x + r.uniform(-0.06, 0.06), r.uniform(-0.05, 0.05), z + h / 2)), X, Z, Y, 0.48 + r.random() * 0.05, h / 2 - 0.012, depth * (0.8 + r.random() * 0.12), 0, r, 0.02)
                    z += h
    n, rmid = 13, half + 0.5
    for k in range(n):
        a = math.pi - (k + 0.5) * (math.pi / n)
        ca, sa = math.cos(a), math.sin(a)
        key = k == (n - 1) // 2
        hy = 0.64 if key else 0.5 + r.random() * 0.06
        box_block(bm, Vector((ca * rmid, 0, spring + sa * rmid)), Vector((-sa, 0, ca)), Vector((ca, 0, sa)), Y,
                  math.pi * rmid / n / 2 - 0.014, hy, depth + 0.09 if key else depth * (0.96 + r.random() * 0.08), hy / rmid, r, 0.012)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    stones, shell = masonry_soup(bm, r, seed)
    parts = [stones]
    # moss lies thick along the crown and on every ledge
    crown = spring + rmid + 0.55
    spots = [(math.cos(a) * (rmid + 0.2), r.uniform(-0.25, 0.25) * depth, 0.3 + r.random() * 0.22) for a in [math.pi * (0.12 + 0.76 * i / 8) for i in range(9)]]
    spots += [(sgn * (half + 0.5 + r.uniform(-0.3, 0.3)), r.uniform(-0.3, 0.3) * depth, 0.3 + r.random() * 0.15) for sgn in (-1, 1) for _ in range(2)]
    if stubs:
        spots += [(sgn * (half + 1.6 + j * 1.0 + r.uniform(-0.2, 0.2)), r.uniform(-0.2, 0.2) * depth, 0.34 + r.random() * 0.2) for sgn in (-1, 1) for j in range(3)]
    cap = cushions(shell, spots, r, seed, voxel=0.06, keep=0.17)
    if cap:
        parts.append(Soup(ao=(0.45, 1.0)).add(cap[0], cap[1], cap[2], moss_colour(seed), CLS['STONE']))
    bake_ao(parts, 1.1, ground=0.0)
    return dict(parts=parts, points=dict(crown=[0, 0, crown]))


# ------------------------------------------------------------------ pack writer
def write_pack(path, assets):
    header = dict(meshes={})
    blob = bytearray()
    total_v = total_t = 0
    for name, a in assets.items():
        parts = []
        for s in a['parts']:
            pos = [(p.x, p.z, -p.y) for p in s.v]
            nor = [(n.x, n.z, -n.y) for n in s.n]
            mn = [min(p[k] for p in pos) for k in range(3)]
            mx = [max(p[k] for p in pos) for k in range(3)]
            off = len(blob)
            for p in pos:
                q = [int(round((p[k] - mn[k]) / ((mx[k] - mn[k]) or 1.0) * 65535.0)) - 32768 for k in range(3)]
                blob += struct.pack('<4h', q[0], q[1], q[2], 0)
            for n in nor:
                blob += struct.pack('<4b', *[max(-127, min(127, int(round(c * 127)))) for c in n], 0)
            for c, (cls, sway) in zip(s.c, s.cls):
                blob += struct.pack('<4B', *[max(0, min(255, int(round(k * 255)))) for k in c], cls * 32 + int(round(clamp01(sway) * 31)))
            wide = len(pos) > 65535
            for tri in s.t:
                blob += struct.pack('<3I' if wide else '<3H', *tri)
            while len(blob) % 4:
                blob += b'\0'
            parts.append(dict(v=len(pos), i=len(s.t) * 3, off=off, flat=s.flat, wide=wide,
                              min=[round(x, 5) for x in mn], max=[round(x, 5) for x in mx]))
            total_v += len(pos)
            total_t += len(s.t)
        pts = {k: [round(p[0], 4), round(p[2], 4), round(-p[1], 4)] + [round(x, 4) for x in p[3:]] for k, p in a.get('points', {}).items()}
        header['meshes'][name] = dict(parts=parts, points=pts)
    js = json.dumps(header, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'HWM1' + struct.pack('<I', len(js)) + js + blob)
    print(f'[models] {len(assets)} models, {total_v} vertices, {total_t} triangles -> {path} ({(12 + len(js) + len(blob)) / 1024:.0f} KB)')


# ------------------------------------------------------------------ previews (contact sheet per model)
def preview(assets, folder, only=None):
    """Renders each model with its baked vertex colours so shapes can be checked without the game."""
    os.makedirs(folder, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'VERTEX'
    sc.display.shading.show_cavity = False
    sc.render.resolution_x, sc.render.resolution_y = 900, 700
    sc.render.image_settings.file_format = 'JPEG'
    world = bpy.data.worlds.new('w')
    sc.world = world
    world.color = (0.32, 0.4, 0.42)
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    for name, a in assets.items():
        if only and name not in only:
            continue
        objs = []
        lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
        for s in a['parts']:
            me = bpy.data.meshes.new(name)
            me.from_pydata([tuple(p) for p in s.v], [], s.t)
            attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
            for i, c in enumerate(s.c):
                # the game tone-maps; brighten here so the preview is readable
                attr.data[i].color = (min(1, c[0] * 2.2), min(1, c[1] * 2.2), min(1, c[2] * 2.2), 1.0)
            if not s.flat:
                for poly in me.polygons:
                    poly.use_smooth = True
            ob = bpy.data.objects.new(name, me)
            sc.collection.objects.link(ob)
            objs.append(ob)
            for p in s.v:
                lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
                hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
        centre = (lo + hi) / 2
        size = max((hi - lo).length, 0.5)
        cam.location = centre + Vector((0.75, -1.25, 0.6)).normalized() * size * 1.5
        cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(folder, f'{name}.jpg')
        bpy.ops.render.render(write_still=True)
        for ob in objs:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)


# ------------------------------------------------------------------ build
def build():
    t0 = time.time()
    assets = {}

    def make(name, fn, *args, **kw):
        t = time.time()
        assets[name] = fn(*args, **kw)
        nv = sum(len(s.v) for s in assets[name]['parts'])
        nt = sum(len(s.t) for s in assets[name]['parts'])
        print(f'[models] {name}: {nv} v, {nt} t, {time.time() - t:.1f}s')

    make('rock_a', rock, 5, 0.72, 0.72, 0.5)
    make('rock_b', rock, 23, 0.95, 0.74, 0.36, zoff=0.2)
    make('rock_c', rock, 61, 0.6, 0.56, 0.72, zoff=0.34)
    for i, seed in enumerate((11, 12, 13, 14)):
        make(f'slab_{i}', slab, seed)
    make('arch_gate', arch, 919, 2.4, 2.9, 0.6)
    print(f'[models] built in {time.time() - t0:.1f}s')
    return assets


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'public/models/glade.hwm'
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    models = build()
    write_pack(out, models)
    if '--preview' in argv:
        only = None
        if '--only' in argv:
            only = argv[argv.index('--only') + 1].split(',')
        preview(models, argv[argv.index('--preview') + 1], only)
