"""
Build a two-legged skeleton (with a jaw, little arms and a tail chain) from a joints file and skin
the model to it: rigid blocks by region rules, and a smooth blend along the trunk and tail so the
body can bend and the tail can carry a wave.

    blender -b --python rig_biped.py -- <in.blend> <out.blend> --joints joints.json

joints.json, positions in metres in the orient_ground.py frame ([forward, left, up]):

    {
      "name": "charger",
      "bones": [                                     head, tail, parent; "_L" bones are mirrored to "_R"
        ["pelvis", [-0.8, 0, 0.7], [0.0, 0, 0.9], "root"],
        ["upper_L", [-0.86, 0.53, 0.66], [-0.74, 0.53, 0.4], "pelvis"], ...
      ],
      "legs": {"L": ["upper_L", "lower_L", "foot_L"]},
      "tail": ["tail_1", "tail_2", ...],
      "chain": [["tail_5", -3.0], ["tail_4", -2.6], ..., ["pelvis", -0.55], ["chest", 0.3], ["head", 0.95]],
      "regions": [
        {"bones": {"foot_L": 1}, "up": [null, 0.09], "abs_left": [0.18, null], "forward": [-1.25, -0.2]},
        ...
      ]
    }

Each vertex takes the first region whose ranges all hold (forward, left, abs_left, up; [min, max],
null for open). A region's bones may name "_L" bones; on the right side they become "_R". A region
with "chain": true, or a vertex no region matches, is weighted along "chain" instead: by its
forward position, blended linearly between the two chain bones whose centres bracket it, so the
trunk bends smoothly and a tail wave travels along it instead of breaking into blocks.

The bone layout goes on the rig as a custom property for clips_biped.py.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import F, P, argv, load_json, model_object, open_blend, option, positional, save_blend

args = argv()
SRC, OUT = positional(args, 2, 'rig_biped.py -- <in.blend> <out.blend> --joints joints.json')
J = load_json(option(args, '--joints') or sys.exit('--joints is required'))
NAME = J.get('name', 'model')

open_blend(SRC)
scene = bpy.context.scene
obj = model_object()
mesh = obj.data


def mirror(name):
    return name[:-2] + '_R' if name.endswith('_L') else name


BONES = [('root', (0, 0, 0), (0.25, 0, 0), None, False)]
for name, h, t, parent in J['bones']:
    BONES.append((name, tuple(h), tuple(t), parent, True))
    if name.endswith('_L'):
        BONES.append((mirror(name), (h[0], -h[1], h[2]), (t[0], -t[1], t[2]), mirror(parent), True))

for o in [o for o in scene.objects if o.type == 'ARMATURE']:
    bpy.data.objects.remove(o, do_unlink=True)
arm = bpy.data.armatures.new(NAME + '_rig')
rig = bpy.data.objects.new(NAME + '_rig', arm)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = {}
for name, h, t, parent, deform in BONES:
    b = arm.edit_bones.new(name)
    b.head, b.tail = P(*h), P(*t)
    b.roll = 0
    b.use_deform = deform
    if parent:
        b.parent = eb[parent]
        b.use_connect = False
    eb[name] = b
bpy.ops.object.mode_set(mode='OBJECT')
legs = {}
for side, chain in J['legs'].items():
    legs[side] = chain
    if side == 'L':
        legs['R'] = [mirror(n) for n in chain]
rig['biped'] = json.dumps({'legs': legs, 'tail': J.get('tail', []), 'bones': [b[0] for b in BONES]})

CHAIN = sorted(J['chain'], key=lambda c: c[1])


def in_range(v, r):
    lo, hi = r
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def chain_weights(f):
    if f <= CHAIN[0][1]:
        return {CHAIN[0][0]: 1.0}
    if f >= CHAIN[-1][1]:
        return {CHAIN[-1][0]: 1.0}
    for (a, fa), (b, fb) in zip(CHAIN, CHAIN[1:]):
        if fa <= f <= fb:
            x = (f - fa) / (fb - fa)
            return {a: 1 - x, b: x} if a != b else {a: 1.0}
    return {CHAIN[-1][0]: 1.0}


def weights_for(co):
    f, s, z = F(co)
    vals = {'forward': f, 'left': s, 'abs_left': abs(s), 'up': z}
    for rule in J['regions']:
        if all(in_range(vals[k], rule[k]) for k in vals if k in rule):
            if rule.get('chain'):
                return chain_weights(f)
            return {(n if s >= 0 else mirror(n)): w for n, w in rule['bones'].items()}
    return chain_weights(f)


obj.vertex_groups.clear()
groups = {n: obj.vertex_groups.new(name=n) for n, _, _, _, deform in BONES if deform}
used = {}
for v in mesh.vertices:
    w = weights_for(v.co)
    tot = sum(w.values())
    for n, x in w.items():
        if x <= 0:
            continue
        if n not in groups:
            raise SystemExit(f'region names an unknown bone {n}')
        groups[n].add([v.index], x / tot, 'REPLACE')
        used[n] = used.get(n, 0) + 1

for m in list(obj.modifiers):
    obj.modifiers.remove(m)
obj.parent = rig
mod = obj.modifiers.new('Armature', 'ARMATURE')
mod.object = rig
print('BONES', len(BONES), 'deforming', len(groups))
print('VERTICES per bone', {n: used.get(n, 0) for n in groups})
empty = [n for n in groups if not used.get(n)]
if empty:
    print('WARN bones with no vertices (check the joints and regions):', empty)
save_blend(OUT)
