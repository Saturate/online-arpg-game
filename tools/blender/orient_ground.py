"""
Turn the model to face Blender -Y (glTF +Z, the way the game expects), stand its feet on z = 0 and
centre it over its feet, with every transform applied into the mesh.

    blender -b --python orient_ground.py -- <in.blend> <out.blend> [--turn DEGREES] [--feet 0.05]

--turn rotates about Blender Z first (the Model check's facing warning names the turn it needs:
+X facing takes -90, -X takes 90, -Z takes 180). Forward is centred on the mean of the vertices
within --feet of the lowest point, so the model turns about its feet, not its bounding box.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import argv, model_object, open_blend, option, positional, save_blend
from mathutils import Matrix

args = argv()
SRC, OUT = positional(args, 2, 'orient_ground.py -- <in.blend> <out.blend> [--turn DEG]')
TURN = option(args, '--turn', 0.0, float)
FEET = option(args, '--feet', 0.05, float)

open_blend(SRC)
obj = model_object()
me = obj.data
me.transform(obj.matrix_world)
obj.matrix_world = Matrix.Identity(4)
me.transform(Matrix.Rotation(math.radians(TURN), 4, 'Z'))

zmin = min(v.co.z for v in me.vertices)
feet = [v.co for v in me.vertices if v.co.z < zmin + FEET]
cy = sum(c.y for c in feet) / len(feet)
xs = [v.co.x for v in me.vertices]
cx = (min(xs) + max(xs)) / 2
me.transform(Matrix.Translation((-cx, -cy, -zmin)))
me.update()

xs, ys, zs = zip(*(v.co for v in me.vertices))
print(f'TURN {TURN} degrees; moved by ({-cx:.4f}, {-cy:.4f}, {-zmin:.4f})')
print(f'SIZE width {max(xs) - min(xs):.3f}, length {max(ys) - min(ys):.3f}, height {max(zs):.3f}')
print(f'FORWARD reach {-min(ys):.3f} ahead of the feet centre, {max(ys):.3f} behind')
save_blend(OUT)
