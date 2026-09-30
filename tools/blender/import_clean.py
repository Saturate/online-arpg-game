"""
Import a .glb, keep the real model mesh, weld its split faces and drop everything else.

    blender -b --python import_clean.py -- <in.glb> <out.blend> [--name model] [--all]
        [--template NAME,NAME] [--weld 0.0001] [--keep-uvs]

The model is the largest mesh outside any template. A template is a top-level node whose tree
holds the game's procedural rig pivots (arm_l, arm_r, leg_l, leg_r): the dev tools' export of a
built-in monster, which people load as a size guide and leave in the file. --template adds more
top-level names to drop; --all merges every non-template mesh instead of only the largest.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh
import bpy
from common import argv, flag, option, positional, save_blend, tris

args = argv()
SRC, OUT = positional(args, 2, 'import_clean.py -- <in.glb> <out.blend> [options]')
NAME = option(args, '--name', 'model')
WELD = option(args, '--weld', 1e-4, float)
EXTRA = set(filter(None, option(args, '--template', '').split(',')))
RIG_PIVOTS = {'arm_l', 'arm_r', 'leg_l', 'leg_r'}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene


def root_of(o):
    while o.parent:
        o = o.parent
    return o


def subtree_names(o):
    names = {o.name.split('.')[0]}
    for c in o.children_recursive:
        names.add(c.name.split('.')[0])
    return names


roots = {root_of(o) for o in scene.objects}
templates = {r for r in roots if r.name in EXTRA or len(subtree_names(r) & RIG_PIVOTS) >= 2}
for r in templates:
    print('TEMPLATE dropped', r.name, f'({sum(1 for c in r.children_recursive if c.type == "MESH")} meshes)')

candidates = sorted((o for o in scene.objects if o.type == 'MESH' and root_of(o) not in templates), key=tris, reverse=True)
if not candidates:
    raise SystemExit('No mesh outside the templates: nothing to build from.')
print('MESHES', [(o.name, tris(o)) for o in candidates])
keep = candidates if flag(args, '--all') else candidates[:1]
print('PICKED', [o.name for o in keep])

# Bake world transforms into one fresh mesh so nothing depends on the imported hierarchy.
bm = bmesh.new()
materials = []
for o in keep:
    part = bmesh.new()
    part.from_mesh(o.data)
    part.transform(o.matrix_world)
    base = len(materials)
    for slot in o.material_slots:
        materials.append(slot.material)
    for face in part.faces:
        face.material_index += base
    tmp = bpy.data.meshes.new('tmp')
    part.to_mesh(tmp)
    part.free()
    bm.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)

verts_before = len(bm.verts)
# The glTF importer splits every face apart for flat shading; a split mesh tears when skinned.
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
print(f'WELD {verts_before} -> {len(bm.verts)} vertices (merge distance {WELD})')

for o in list(scene.objects):
    bpy.data.objects.remove(o, do_unlink=True)
mesh = bpy.data.meshes.new(NAME + '_mesh')
bm.to_mesh(mesh)
bm.free()
for m in materials:
    mesh.materials.append(m)
if not flag(args, '--keep-uvs'):
    for uv in list(mesh.uv_layers):
        mesh.uv_layers.remove(uv)
for p in mesh.polygons:
    p.use_smooth = False
obj = bpy.data.objects.new(NAME, mesh)
scene.collection.objects.link(obj)

for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.actions, bpy.data.armatures, bpy.data.images, bpy.data.cameras, bpy.data.lights):
    for d in list(coll):
        if d.users == 0:
            coll.remove(d)

xs, ys, zs = zip(*(v.co for v in mesh.vertices))
print(f'MODEL {NAME}: {tris(obj)} triangles, {len(mesh.vertices)} vertices, materials {[m.name if m else None for m in mesh.materials]}')
print(f'BOUNDS x {min(xs):.3f}..{max(xs):.3f}  y {min(ys):.3f}..{max(ys):.3f}  z {min(zs):.3f}..{max(zs):.3f}')
spans = {'X': max(xs) - min(xs), 'Y': max(ys) - min(ys)}
print('LONGEST horizontal axis', max(spans, key=spans.get), '(the head should end up at -Y; see orient_ground.py --turn)')
save_blend(OUT)
