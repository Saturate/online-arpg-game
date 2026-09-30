"""Shared helpers for the tools/blender scripts. Blender's bundled Python only."""
import json
import os
import sys

import bpy
from mathutils import Vector

FPS = 30
# The game draws a hero 54 units tall; KayKit heroes are about 1.8 m, so 30 units is a metre.
UNITS_PER_METRE = 30.0
HERO_UNITS = 54.0
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def argv():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def positional(args, count, usage):
    """The first `count` arguments that are not options or option values."""
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a.startswith('--'):
            skip = not a.startswith('--no-') and a not in FLAGS
        else:
            out.append(a)
    if len(out) < count:
        raise SystemExit('usage: ' + usage)
    return out[:count]


# Options that take no value.
FLAGS = {'--all', '--sheets', '--keep-uvs', '--lift'}


def option(args, name, default=None, cast=str):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise SystemExit(f'{name} needs a value')
        return cast(args[i + 1])
    return default


def flag(args, name):
    return name in args


def load_json(path):
    with open(path) as f:
        return json.load(f)


def open_blend(path):
    bpy.ops.wm.open_mainfile(filepath=path)


def save_blend(path):
    # Actions and rigs with no users would be dropped on save; later stages need them.
    for a in bpy.data.actions:
        a.use_fake_user = True
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=False)
    print('SAVED', path)


def model_object():
    """The single model mesh the pipeline works on (the largest mesh in the file)."""
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise SystemExit('no mesh in the file')
    return max(meshes, key=tris)


def rig_object():
    rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if not rigs:
        raise SystemExit('no armature: run rig_quadruped.py first')
    return rigs[0]


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# Model frame used by every JSON file: forward, left, up in metres, after orient_ground.py.
# The model faces Blender -Y (glTF +Z), so forward is -Y and its left is +X.
def P(f, s, z):
    return Vector((s, -f, z))


def F(co):
    return -co.y, co.x, co.z


def evaluated_points(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    pts = [ev.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    return pts


def lowest_z(obj):
    bpy.context.view_layer.update()
    return min(p.z for p in evaluated_points(obj))


def luminance(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
