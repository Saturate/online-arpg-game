"""
Give the model flat Principled BSDF colours from a palette file, and optionally glowing eyes.

    blender -b --python recolour.py -- <in.blend> <out.blend> --palette palette.json

Palette file (colours are linear RGB, as Blender's Base Color field shows them):

    {
      "colours":   {"coat": [0.15, 0.128, 0.108], "eye": [0.3, 0.12, 0.02]},
      "emission":  {"eye": {"colour": [1.0, 0.42, 0.06], "strength": 2.5}},
      "roughness": 0.92,
      "materials": {"Material.001": "coat"},
      "default":   "coat",
      "regions":   [{"colour": "nose", "forward": [0.76, null]}, {"colour": "coat"}],
      "eyes":      {"colour": "eye", "radius": 0.024, "from": [0.78, 0.24, 0.94], "to": [0.59, 0.085, 0.925]}
    }

Without "regions", each existing material takes the colour its name maps to in "materials" (or
the colour of the same name), and faces without one take "default". With "regions", faces are
painted by position instead: the first rule whose ranges all hold wins. A range is [min, max]
(null for open) on forward, left, abs_left, up (the face centre in metres, in the frame of
orient_ground.py), normal_forward, normal_left, normal_up (the face normal, -1 to 1) or
part_verts (how many vertices the face's loose part has: a modelled eye is a small part of its own).
"eyes" casts from "from" towards "to" (left side; mirrored for the right) and sets a small
icosphere into the surface where it lands.

Guard: a non-glowing colour darker than luminance 0.01 is refused, since the game's night grade
turns it pure black (the Model check's own limit); under 0.03 it only warns.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh
import bpy
from common import F, P, argv, load_json, luminance, model_object, open_blend, option, positional, save_blend
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

args = argv()
SRC, OUT = positional(args, 2, 'recolour.py -- <in.blend> <out.blend> --palette palette.json')
PAL = load_json(option(args, '--palette') or sys.exit('--palette is required'))
COLOURS = PAL['colours']
EMISSION = PAL.get('emission', {})

problems = []
for name, rgb in COLOURS.items():
    lum = luminance(rgb)
    if name in EMISSION:
        continue
    if lum < 0.01:
        problems.append(f'"{name}" {rgb} has luminance {lum:.4f}: black at night. Lift it to 0.01 or more (about #333333 in sRGB is safe).')
    elif lum < 0.03:
        print(f'WARN "{name}" luminance {lum:.3f} is close to black; keep it for small parts only.')
if problems:
    raise SystemExit('\n'.join(problems))

open_blend(SRC)
obj = model_object()
mesh = obj.data


def make_material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes['Principled BSDF']
    n.inputs['Base Color'].default_value = (*COLOURS[name], 1)
    n.inputs['Roughness'].default_value = PAL.get('roughness', 0.9) if name not in EMISSION else 0.5
    n.inputs['Metallic'].default_value = 0.0
    n.inputs['Specular IOR Level'].default_value = 0.3
    if name in EMISSION:
        n.inputs['Emission Color'].default_value = (*EMISSION[name]['colour'], 1)
        n.inputs['Emission Strength'].default_value = EMISSION[name]['strength']
    return m


def in_range(value, rng):
    lo, hi = rng
    return (lo is None or value > lo) and (hi is None or value < hi)


def part_sizes(bm):
    """Vertex count of each vertex's loose part."""
    size, seen = {}, set()
    for v in bm.verts:
        if v.index in seen:
            continue
        part, stack = [], [v]
        seen.add(v.index)
        while stack:
            x = stack.pop()
            part.append(x.index)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y.index not in seen:
                    seen.add(y.index)
                    stack.append(y)
        for i in part:
            size[i] = len(part)
    return size


def region_for(face):
    f, s, z = F(face.calc_center_median())
    n = face.normal
    values = {'forward': f, 'left': s, 'abs_left': abs(s), 'up': z, 'normal_forward': -n.y, 'normal_left': n.x, 'normal_up': n.z, 'part_verts': PART[face.verts[0].index]}
    for rule in PAL['regions']:
        if all(in_range(values[k], v) for k, v in rule.items() if k != 'colour'):
            return rule['colour']
    return PAL.get('default')


names = list(COLOURS)
bm = bmesh.new()
bm.from_mesh(mesh)
bm.verts.ensure_lookup_table()
PART = part_sizes(bm)
if 'regions' in PAL:
    counts = {}
    for face in bm.faces:
        name = region_for(face)
        if name is None:
            raise SystemExit('a face matches no region and there is no "default"')
        face.material_index = names.index(name)
        counts[name] = counts.get(name, 0) + 1
    print('REGIONS', counts)
else:
    old = [m.name if m else None for m in mesh.materials]
    mapping = PAL.get('materials', {})
    target = []
    for o in old:
        name = mapping.get(o) or (o if o in COLOURS else PAL.get('default'))
        if name is None:
            raise SystemExit(f'material "{o}" has no colour: add it to "materials" or set "default"')
        target.append(name)
        print(f'MATERIAL "{o}" -> {name}')
    fallback = names.index(PAL['default']) if 'default' in PAL else 0
    for face in bm.faces:
        face.material_index = names.index(target[face.material_index]) if face.material_index < len(target) else fallback

if 'eyes' in PAL:
    e = PAL['eyes']
    bm.faces.ensure_lookup_table()
    bvh = BVHTree.FromBMesh(bm)
    idx = names.index(e['colour'])
    r = e['radius']
    for sgn in (1, -1):
        (f0, s0, z0), (f1, s1, z1) = e['from'], e['to']
        origin, target = P(f0, s0 * sgn, z0), P(f1, s1 * sgn, z1)
        hit, normal, _, _ = bvh.ray_cast(origin, (target - origin).normalized())
        if hit is None:
            raise SystemExit('the eye ray missed the head: move "from" or "to"')
        # Sunk a third of its radius so it reads as set into the brow, not stuck on.
        centre = hit - normal * (r * 0.35)
        res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r, matrix=Matrix.Translation(centre) @ Matrix.Diagonal((1.0, 1.0, 0.8, 1.0)))
        for v in res['verts']:
            for fc in v.link_faces:
                fc.material_index = idx
        print('EYE', 'left' if sgn > 0 else 'right', [round(c, 3) for c in F(centre)])

# Slots first: to_mesh clamps face material indices to the slots the mesh already has.
mesh.materials.clear()
for name in names:
    mesh.materials.append(make_material(name))
bm.to_mesh(mesh)
bm.free()
for p in mesh.polygons:
    p.use_smooth = False
for m in list(bpy.data.materials):
    if m.users == 0:
        bpy.data.materials.remove(m)
print('TRIANGLES', sum(len(p.vertices) - 2 for p in mesh.polygons))
save_blend(OUT)
