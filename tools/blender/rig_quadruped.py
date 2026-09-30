"""
Build a quadruped skeleton from joint positions and skin the model to it with near-rigid weights.

    blender -b --python rig_quadruped.py -- <in.blend> <out.blend> --joints joints.json

joints.json holds positions in metres in the orient_ground.py frame (forward, left, up):

    {
      "name": "dire_wolf",
      "trunk": {                                  centre line, [forward, up] head to tail
        "body": [[-0.35, 0.62], [-0.05, 0.64]],   hips to mid back; parent of hind legs and tail
        "chest": [[-0.05, 0.64], [0.24, 0.66]],   parent of front legs
        "neck": [[0.26, 0.70], [0.45, 0.87]],
        "head": [[0.45, 0.87], [0.80, 0.88]],
        "tail": [[-0.44, 0.70], [-0.62, 0.635], [-0.82, 0.604]]   any number of points
      },
      "legs": {                                   left side, [forward, left, up]; mirrored
        "front": {"hip": [..], "knee": [..], "ankle": [..], "toe": [..]},
        "hind":  {"hip": [..], "knee": [..], "ankle": [..], "toe": [..]}
      },
      "skin": {"leg_top": 0.5, "leg_inner": 0.05, "ring_top": 0.56, "ring_side": 0.12,
               "ring_half": 0.14, "front_from": -0.04, "head_above": 0.98}
    }

Bones: root, body, chest, neck, head, tail_1..n, and per leg {front,hind}_{upper,lower,paw}_{L,R}.
"knee" is the joint that bends (elbow on the front leg, hock on the hind), "ankle" the ring above
the paw, "toe" the paw's tip on the ground.

Skinning is rigid on purpose: low-poly parts should move as blocks. Each vertex follows its
nearest bone; only vertices near two bones' segments blend (falloff 0.02 m), and the ring where
each leg leaves the body is split half leg, half trunk, so the shoulder rolls with the leg.
skin: below leg_top and further out than leg_inner from the centre line is leg; front legs from
forward front_from on; ring_top / ring_side / ring_half bound the shoulder ring around each hip;
above head_above everything is head (ears), as are eye-coloured faces.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import F, P, argv, load_json, model_object, open_blend, option, positional, save_blend
from mathutils import Vector

args = argv()
SRC, OUT = positional(args, 2, 'rig_quadruped.py -- <in.blend> <out.blend> --joints joints.json')
J = load_json(option(args, '--joints') or sys.exit('--joints is required'))
NAME = J.get('name', 'model')
SKIN = {'leg_top': 0.5, 'leg_inner': 0.05, 'ring_top': 0.56, 'ring_side': 0.12, 'ring_half': 0.14, 'front_from': 0.0, 'head_above': 10.0, 'falloff': 0.02, **J.get('skin', {})}

open_blend(SRC)
scene = bpy.context.scene
obj = model_object()
mesh = obj.data

T = J['trunk']
c = lambda fz: (fz[0], 0.0, fz[1])
BONES = [('root', (0, 0, 0), (0.25, 0, 0), None, False)]
for name, parent in (('body', 'root'), ('chest', 'body'), ('neck', 'chest'), ('head', 'neck')):
    BONES.append((name, c(T[name][0]), c(T[name][1]), parent, True))
TAIL = []
for i, (a, b) in enumerate(zip(T.get('tail', []), T.get('tail', [])[1:])):
    TAIL.append(f'tail_{i + 1}')
    BONES.append((TAIL[-1], c(a), c(b), TAIL[-2] if i else 'body', True))
LEGS = {}
for kind, pts in J['legs'].items():
    for side, sgn in (('L', 1), ('R', -1)):
        h, k, a, t = [(p[0], p[1] * sgn, p[2]) for p in (pts['hip'], pts['knee'], pts['ankle'], pts['toe'])]
        up, lo, pw = f'{kind}_upper_{side}', f'{kind}_lower_{side}', f'{kind}_paw_{side}'
        BONES += [(up, h, k, 'chest' if kind == 'front' else 'body', True), (lo, k, a, up, True), (pw, a, t, lo, True)]
        LEGS[f'{kind}_{side}'] = (up, lo, pw)

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
        b.use_connect = (Vector(b.head) - Vector(eb[parent].tail)).length < 1e-5
    eb[name] = b
bpy.ops.object.mode_set(mode='OBJECT')
# The clip script reads the layout back from here.
rig['quadruped'] = json.dumps({'legs': J['legs'], 'tail': TAIL})


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


seg = {n: (P(*h), P(*t)) for n, h, t, _, _ in BONES}
TRUNK = ['body', 'chest', 'neck', 'head'] + TAIL
S = SKIN


def weights_for(co, is_eye):
    f, s, z = F(co)
    if is_eye or z > S['head_above']:
        return {'head': 1.0}
    kind = 'front' if f > S['front_from'] else 'hind'
    up, lo, pw = LEGS[f'{kind}_{"L" if s > 0 else "R"}']
    if z < S['leg_top'] and abs(s) > S['leg_inner']:
        cands = [up, lo, pw]
    elif z < S['ring_top'] and abs(s) > S['ring_side'] and abs(f - J['legs'][kind]['hip'][0]) < S['ring_half']:
        return {up: 0.5, 'chest' if kind == 'front' else 'body': 0.5}
    else:
        cands = TRUNK
    d = {n: seg_dist(co, *seg[n]) for n in cands}
    dmin = min(d.values())
    w = {n: math.exp(-(dv - dmin) / S['falloff']) for n, dv in d.items()}
    top = [(n, x) for n, x in sorted(w.items(), key=lambda kv: -kv[1])[:2] if x > 0.12]
    tot = sum(x for _, x in top)
    return {n: x / tot for n, x in top}


obj.vertex_groups.clear()
groups = {n: obj.vertex_groups.new(name=n) for n, _, _, _, deform in BONES if deform}
eye_mats = {i for i, m in enumerate(mesh.materials) if m and 'eye' in m.name.lower()}
eye_verts = {vi for p in mesh.polygons if p.material_index in eye_mats for vi in p.vertices}
used = {}
for v in mesh.vertices:
    for n, w in weights_for(v.co, v.index in eye_verts).items():
        groups[n].add([v.index], w, 'REPLACE')
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
    print('WARN bones with no vertices (check the joints and skin bounds):', empty)
save_blend(OUT)
