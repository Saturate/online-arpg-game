"""
Key Idle, Walk, Run, Attack, Hit and Death on a rig from rig_quadruped.py, at 30 fps, with the
paws planted by a small two-bone IK and the walk and run strides matched to the game speed.

    blender -b --python clips_quadruped.py -- <in.blend> <out.blend> --speed 170
        [--run-speed U] [--game-height U] [--walk-gait trot|gallop] [--walk-crouch M]
        [--walk-frames N | --walk-stride M] [--run-frames N | --run-stride M]
        [--idle-frames 72] [--attack-frames 24] [--hit-frames 9] [--death-frames 30]

Speeds are game units per second (moveSpeed in packages/shared/src/data/enemies.ts; --run-speed
defaults to the larger of --speed and 190, since the game only runs above 188). The game scales
the model to --game-height units (its AssetDef height; default the model's height at 30 units a
metre) and plays the walk at speed / 110, clamped 0.6 to 1.8 (render/characters.ts), so between
66 and 198 units a second the authored walk must cover 110 units a second; the run plays at 1 and
must cover its own speed.

Give the frames and the stride follows, give the stride and the frames follow; with neither, the
stride is the furthest the legs reach from the rest pose (worked out from the joints) and the
frames follow, at least 6. A planted paw then moves back exactly as fast as the game moves the
monster. The script prints the numbers and warns when the stride the speed needs is past the
legs' reach, which is common for small monsters with fast move speeds: switch the walk to a
gallop, raise --game-height, or accept the slide.

--walk-crouch is how far the trot lowers the body, in metres at a 0.57 m hip (default 0.025; the
gallop keeps its own 0.055). Straight legs barely reach ahead of the hip, so a lower, stalking
trot is what lets a big monster take long, slow strides instead of pattering.

Pose amounts (body bob, lunge, the fall) are authored for a hip height of 0.57 m and scale with
the rig's own hip height.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import FPS, UNITS_PER_METRE, argv, lowest_z, model_object, open_blend, option, positional, rig_object, save_blend
from mathutils import Quaternion, Vector

args = argv()
SRC, OUT = positional(args, 2, 'clips_quadruped.py -- <in.blend> <out.blend> --speed U [options]')
SPEED = option(args, '--speed', None, float) or sys.exit('--speed (game units per second) is required')
RUN_SPEED = option(args, '--run-speed', max(SPEED, 190.0), float)

open_blend(SRC)
scene = bpy.context.scene
obj = model_object()
rig = rig_object()
LAYOUT = json.loads(rig['quadruped'])
TAIL = LAYOUT['tail']
pbs = rig.pose.bones
scene.render.fps = FPS
scene.frame_start = 0

model_height = max(v.co.z for v in obj.data.vertices)
GAME_HEIGHT = option(args, '--game-height', model_height * UNITS_PER_METRE, float)
METRES_PER_UNIT = model_height / GAME_HEIGHT
HIP = sum(LAYOUT['legs'][k]['hip'][2] for k in LAYOUT['legs']) / len(LAYOUT['legs'])
K = HIP / 0.57

LEGS = {f'{kind}_{side}': (f'{kind}_upper_{side}', f'{kind}_lower_{side}', f'{kind}_paw_{side}') for kind in LAYOUT['legs'] for side in 'LR'}


def reach(crouch):
    """Furthest a planted paw can sit ahead of or behind its rest spot before the leg is straight,
    with the body lowered by `crouch`: the IK clamps past that and the paw slides or lifts."""
    out = []
    for kind, pts in LAYOUT['legs'].items():
        chain = sum((Vector(a) - Vector(b)).length for a, b in ((pts['hip'], pts['knee']), (pts['knee'], pts['ankle'])))
        drop = pts['hip'][2] - pts['ankle'][2] - crouch
        out.append(math.sqrt(max(0.0, chain * chain - drop * drop)) * 0.95)
    return min(out)


def cycle(name, ground_speed, duty, crouch, frames_opt, stride_opt, min_frames):
    """Frames and half-stride so a planted paw moves back at the clip's ground speed."""
    v = ground_speed * METRES_PER_UNIT
    max_stride = reach(crouch)
    if frames_opt:
        frames = int(frames_opt)
    else:
        frames = max(min_frames, round(2 * (stride_opt or max_stride) / (v * duty) * FPS))
    stride = v * duty * (frames / FPS) / 2
    print(f'{name.upper()} {frames} frames ({frames / FPS:.3f} s), half-stride {stride:.3f} m (legs reach {max_stride:.3f}), paws move {v:.2f} m/s in the clip')
    if stride > max_stride * 1.05:
        cure = '--walk-gait gallop, a larger --game-height' if name == 'walk' else 'a larger --game-height'
        print(f'WARN {name}: the stride this speed needs is past what the legs reach, so the paws slide {100 * (stride / max_stride - 1):.0f}%. Try {cure}, or a lower speed.')
    return frames, stride


WALK_GAIT = option(args, '--walk-gait', 'trot')
WALK_DUTY = 0.36 if WALK_GAIT == 'gallop' else 0.56
WALK_DROP = 0.055 if WALK_GAIT == 'gallop' else option(args, '--walk-crouch', 0.025, float)
WALK_CROUCH = WALK_DROP * K
walk_scale = max(0.6, min(1.8, SPEED / 110))
WALK_FRAMES, WALK_STRIDE = cycle('walk', SPEED / walk_scale, WALK_DUTY, WALK_CROUCH, option(args, '--walk-frames'), option(args, '--walk-stride', None, float), 6)
print(f'      in game it plays at {walk_scale:.2f}x: {walk_scale * FPS / WALK_FRAMES:.2f} strides a second at {SPEED:g} units/s')
RUN_FRAMES, RUN_STRIDE = cycle('run', RUN_SPEED, 0.36, 0.055 * K, option(args, '--run-frames'), option(args, '--run-stride', None, float), 6)


for pb in pbs:
    pb.rotation_mode = 'QUATERNION'


def arm_quat(pitch=0.0, yaw=0.0, roll=0.0):
    """Degrees, armature axes. pitch + tips the nose or paw down and back; yaw + turns left; roll + leans left."""
    return Quaternion((0, 1, 0), math.radians(roll)) @ Quaternion((0, 0, 1), math.radians(yaw)) @ Quaternion((1, 0, 0), math.radians(pitch))


def set_rel(pb, pitch=0.0, yaw=0.0, roll=0.0, fwd=0.0, side=0.0, up=0.0):
    M = pb.bone.matrix_local.to_3x3()
    Mi = M.inverted()
    pb.rotation_quaternion = (Mi @ arm_quat(pitch, yaw, roll).to_matrix() @ M).to_quaternion()
    pb.location = Mi @ (Vector((side, -fwd, up)) * K)


def set_arm_rot(pb, D, parent_D=None):
    """Point the bone along armature-space orientation D; parent_D stands in for the parent's pose."""
    par = pb.parent
    PD = parent_D if parent_D is not None else par.matrix.to_3x3()
    Pm = PD @ par.bone.matrix_local.to_3x3().inverted() @ pb.bone.matrix_local.to_3x3()
    pb.rotation_quaternion = (Pm.inverted() @ D).to_quaternion()


def leg_ik(key, target):
    """Two-bone IK in the leg's plane: the joint bows forward, the ankle reaches target and the
    paw keeps its rest orientation, so it stays flat on the ground."""
    up, lo, pw = LEGS[key]
    pu, pl, pp = pbs[up], pbs[lo], pbs[pw]
    H = pu.head.copy()
    L1, L2 = pu.bone.length, pl.bone.length
    v = target - H
    d = min(v.length, (L1 + L2) * 0.9995)
    dirv = v.normalized()
    fwd = Vector((0, -1, 0))
    b = (fwd - dirv * dirv.dot(fwd)).normalized()
    a = math.acos(max(-1.0, min(1.0, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))))
    knee = H + (dirv * math.cos(a) + b * math.sin(a)) * L1
    ankle = H + dirv * d
    Du = (pu.bone.matrix_local.to_3x3() @ Vector((0, 1, 0))).rotation_difference(knee - H).to_matrix() @ pu.bone.matrix_local.to_3x3()
    Dl = (pl.bone.matrix_local.to_3x3() @ Vector((0, 1, 0))).rotation_difference(ankle - knee).to_matrix() @ pl.bone.matrix_local.to_3x3()
    set_arm_rot(pu, Du)
    set_arm_rot(pl, Dl, parent_D=Du)
    set_arm_rot(pp, pp.bone.matrix_local.to_3x3(), parent_D=Dl)


# Where each ankle sits with its paw on the ground. A paw that rests above the ground in the rest
# pose (hind paws often do) is planted by that much in every clip.
REST_PAW = {}
for key, (_, _, pw) in LEGS.items():
    g = obj.vertex_groups[pw].index
    low = min(v.co.z for v in obj.data.vertices if any(x.group == g and x.weight > 0.5 for x in v.groups))
    REST_PAW[key] = pbs[pw].bone.head_local - Vector((0, 0, low))
    print('PAW', key, 'rests', round(low, 4), 'above the ground')


def reset():
    for pb in pbs:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)


def apply_pose(pose):
    """pose: {'bones': {bone: params}, 'paws': {leg: Vector} or None (legs by FK only)}."""
    reset()
    for n, kw in pose['bones'].items():
        set_rel(pbs[n], **kw)
    if pose['paws']:
        bpy.context.view_layer.update()
        for k, target in pose['paws'].items():
            leg_ik(k, target)


def split(pose):
    """Pull 'paw_<leg>' entries (offsets in metres, not scaled by K) out as IK targets."""
    bones, paws = {}, {}
    for n, kw in pose.items():
        if n.startswith('paw_'):
            paws[n[4:]] = REST_PAW[n[4:]] + Vector((kw.get('side', 0.0), -kw.get('fwd', 0.0), kw.get('up', 0.0)))
        elif n in pbs:
            bones[n] = kw
    for key in LEGS:
        paws.setdefault(key, REST_PAW[key].copy())
    return {'bones': bones, 'paws': paws}


def snapshot():
    return {pb.name: (pb.rotation_quaternion.copy(), pb.location.copy()) for pb in pbs}


def restore(snap):
    for n, (q, loc) in snap.items():
        pbs[n].rotation_quaternion = q
        pbs[n].location = loc


def linear_keys(act):
    fcurves = list(getattr(act, 'fcurves', []))
    # Blender 4.4+ keeps f-curves in layered actions.
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for cb in strip.channelbags:
                fcurves += list(cb.fcurves)
    for fc in fcurves:
        for k in fc.keyframe_points:
            k.interpolation = 'LINEAR'


rig.animation_data_create()
for t in list(rig.animation_data.nla_tracks):
    rig.animation_data.nla_tracks.remove(t)
CLIPS = []


def make_action(name, frames, pose_at, loop, grounded=False):
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data.action = act
    first = prev = None
    for f in range(frames + 1):
        if loop and f == frames:
            restore(first)
        else:
            apply_pose(pose_at(f / frames, f / FPS))
            if grounded:
                # Something always rests on the ground while it falls: no sinking in, no floating.
                for _ in range(3):
                    z = lowest_z(obj)
                    if abs(z) < 0.002:
                        break
                    pbs['body'].location += pbs['body'].bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, -z))
            if prev is not None:
                for pb in pbs:
                    pb.rotation_quaternion.make_compatible(prev[pb.name][0])
        for pb in pbs:
            pb.keyframe_insert('rotation_quaternion', frame=f, group=pb.name)
            pb.keyframe_insert('location', frame=f, group=pb.name)
        if f == 0:
            first = snapshot()
        prev = snapshot()
    linear_keys(act)
    act.use_frame_range = True
    act.frame_start, act.frame_end = 0, frames
    act.use_cyclic = loop
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    track.mute = True
    rig.animation_data.action = None
    CLIPS.append((name, frames))
    print(f'ACTION {name}: {frames} frames, {frames / FPS:.3f} s, loop={loop}')


TAU = 2 * math.pi


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def keyposes(keys, t, ease=smooth):
    """keys: [(seconds, {bone: {param: value}})]; missing params are 0; eased between neighbours."""
    for (t0, p0), (t1, p1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            x = ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
            out = {}
            for bone in set(p0) | set(p1):
                a, b = p0.get(bone, {}), p1.get(bone, {})
                out[bone] = {k: a.get(k, 0.0) + (b.get(k, 0.0) - a.get(k, 0.0)) * x for k in set(a) | set(b)}
            return out
    return keys[-1][1]


def timed(keys, frames, authored):
    """Stretch keys authored for `authored` frames to `frames`."""
    s = frames / authored
    return [(t * s, pose) for t, pose in keys]


def tail(pose, *per_bone):
    """Spread tail params over however many tail bones the rig has."""
    for i, name in enumerate(TAIL):
        pose[name] = dict(per_bone[min(i, len(per_bone) - 1)])
    return pose


def gait(p, phase, duty, stride, lift):
    """Paw offset (forward, up) from its rest spot at gait phase p: planted for `duty`, then swung."""
    x = (p - phase) % 1.0
    if x < duty:
        return stride * (1 - 2 * x / duty), 0.0
    s = (x - duty) / (1 - duty)
    return -stride + 2 * stride * (0.5 - 0.5 * math.cos(math.pi * s)), lift * math.sin(math.pi * s) ** 1.3


def idle(p, t):
    """Slow breathing, head low and watching, tail hanging with a slow sway."""
    br = math.sin(TAU * 2 * p)
    return split(tail({
        'body': {'up': -0.012 + 0.004 * br, 'pitch': 0.6 * br},
        'chest': {'pitch': -0.8 * br},
        'neck': {'pitch': 6 + 1.5 * math.sin(TAU * 2 * p + 0.8), 'yaw': 5 * math.sin(TAU * p)},
        'head': {'pitch': 4 + 2.0 * math.sin(TAU * p + 1.3), 'yaw': 4 * math.sin(TAU * p - 0.6), 'roll': 2 * math.sin(TAU * p)},
    }, {'pitch': 6, 'yaw': 4 * math.sin(TAU * p + 0.4)}, {'pitch': 4, 'yaw': 6 * math.sin(TAU * p - 0.4)}))


WALK_PHASE = {'front_L': 0.0, 'hind_R': 0.06, 'front_R': 0.5, 'hind_L': 0.56}


def walk(p, t):
    """A trot: diagonal pairs together, hinds a touch behind; low and stalking."""
    pose = {}
    for k, ph in WALK_PHASE.items():
        fw, up = gait(p, ph, WALK_DUTY, WALK_STRIDE, (0.075 if k.startswith('front') else 0.06) * K)
        pose[f'paw_{k}'] = {'fwd': fw, 'up': up}
    bob = math.cos(TAU * 2 * (p - 0.03 - WALK_DUTY / 2))
    pose.update({
        'body': {'up': -WALK_DROP + 0.009 * bob, 'roll': 1.6 * math.sin(TAU * (p - 0.06)), 'yaw': 2.0 * math.sin(TAU * (p + 0.2)), 'pitch': 0.8 * math.sin(TAU * 2 * p)},
        'chest': {'yaw': -2.5 * math.sin(TAU * (p + 0.2)), 'roll': -0.8 * math.sin(TAU * p)},
        'neck': {'pitch': 9 + 2.5 * math.cos(TAU * 2 * (p - 0.4)), 'yaw': 1.5 * math.sin(TAU * p)},
        'head': {'pitch': 3 - 1.5 * math.cos(TAU * 2 * (p - 0.4))},
    })
    return split(tail(pose, {'pitch': 8, 'yaw': 7 * math.sin(TAU * (p - 0.1))}, {'pitch': 5, 'yaw': 10 * math.sin(TAU * (p - 0.22))}))


RUN_PHASE = {'hind_R': 0.0, 'hind_L': 0.09, 'front_R': 0.42, 'front_L': 0.52}


def gallop(p, stride):
    """A rotary gallop: hinds land close together, then the fronts, then a short float."""
    pose = {}
    for k, ph in RUN_PHASE.items():
        front = k.startswith('front')
        fw, up = gait(p, ph, 0.36, stride * (1.0 if front else 0.85), (0.16 if front else 0.13) * K)
        pose[f'paw_{k}'] = {'fwd': fw, 'up': up}
    # The spine gathers while the hinds reach forward and stretches as the fronts reach.
    flex = math.sin(TAU * (p - 0.20))
    pose.update({
        'body': {'up': -0.055 + 0.022 * math.sin(TAU * (p - 0.05)), 'pitch': -4.0 * flex, 'roll': 1.0 * math.sin(TAU * p)},
        'chest': {'pitch': 6.0 * flex},
        'neck': {'pitch': 16 - 6.0 * flex},
        'head': {'pitch': -4 + 3.0 * flex},
    })
    return split(tail(pose, {'pitch': -6 + 6.0 * math.sin(TAU * (p - 0.3))}, {'pitch': -4 + 8.0 * math.sin(TAU * (p - 0.42))}))


# Authored at 24 frames: weight back and head low, lunge with the jaws reaching up, snap down, pull back.
ATTACK = [
    (0.00, {}),
    (0.30, tail({'body': {'fwd': -0.10, 'up': -0.085, 'pitch': -4}, 'chest': {'pitch': 3}, 'neck': {'pitch': 24}, 'head': {'pitch': -12}}, {'pitch': 18}, {'pitch': 10})),
    (0.40, tail({'body': {'fwd': 0.16, 'up': -0.01, 'pitch': 3}, 'chest': {'pitch': -3}, 'neck': {'pitch': -20}, 'head': {'pitch': -22},
                 'paw_front_L': {'fwd': 0.16 * K, 'up': 0.06 * K}, 'paw_front_R': {'fwd': 0.12 * K, 'up': 0.08 * K},
                 'paw_hind_L': {'fwd': 0.07 * K}, 'paw_hind_R': {'fwd': 0.07 * K}}, {'pitch': -8}, {'pitch': -4})),
    (0.47, tail({'body': {'fwd': 0.19, 'up': -0.035, 'pitch': 6}, 'chest': {'pitch': 1}, 'neck': {'pitch': 0}, 'head': {'pitch': 18, 'yaw': -5},
                 'paw_front_L': {'fwd': 0.18 * K}, 'paw_front_R': {'fwd': 0.15 * K}, 'paw_hind_L': {'fwd': 0.09 * K}, 'paw_hind_R': {'fwd': 0.09 * K}}, {'pitch': 2}, {})),
    (0.60, tail({'body': {'fwd': 0.13, 'up': -0.035, 'pitch': 3}, 'neck': {'pitch': 6, 'yaw': 6}, 'head': {'pitch': 10, 'yaw': 10, 'roll': -10},
                 'paw_front_L': {'fwd': 0.18 * K}, 'paw_front_R': {'fwd': 0.15 * K}, 'paw_hind_L': {'fwd': 0.09 * K}, 'paw_hind_R': {'fwd': 0.09 * K}}, {'pitch': 4}, {})),
    (0.80, {}),
]

# Authored at 9 frames: a sharp flinch back and to the side, then settles.
HIT = [
    (0.00, {}),
    (0.06, tail({'body': {'fwd': -0.045, 'up': -0.02, 'pitch': -4, 'roll': 5}, 'chest': {'pitch': -3, 'yaw': 4},
                 'neck': {'pitch': -12, 'yaw': 10}, 'head': {'pitch': -8, 'yaw': 8, 'roll': 6}}, {'pitch': 18}, {'pitch': 10})),
    (0.30, {}),
]


def death_keys(drop):
    """Authored at 30 frames: yelps and rears, front legs give, rolls onto its right side, stays down."""
    down = lambda extra: tail({
        'body': {'up': drop + extra, 'pitch': 0, 'roll': -92, 'side': -0.12},
        'neck': {'pitch': 4, 'yaw': -22}, 'head': {'pitch': 2, 'yaw': -15, 'roll': -8},
        'front_upper_L': {'pitch': -16}, 'front_lower_L': {'pitch': 18}, 'front_upper_R': {'pitch': -28}, 'front_lower_R': {'pitch': 30},
        'hind_upper_L': {'pitch': -10}, 'hind_lower_L': {'pitch': 15}, 'hind_upper_R': {'pitch': -20}, 'hind_lower_R': {'pitch': 26},
    }, {'pitch': -6, 'yaw': -8}, {'yaw': -10})
    return [
        (0.00, {}),
        (0.15, tail({'body': {'fwd': -0.03, 'pitch': -5, 'roll': 4}, 'neck': {'pitch': -18}, 'head': {'pitch': -10}}, {'pitch': 16}, {})),
        (0.42, tail({'body': {'up': -0.16, 'pitch': 10, 'roll': -22, 'side': -0.03}, 'neck': {'pitch': 10, 'yaw': -8}, 'head': {'pitch': 8},
                     'front_upper_L': {'pitch': -30}, 'front_lower_L': {'pitch': 60}, 'front_upper_R': {'pitch': -35}, 'front_lower_R': {'pitch': 70},
                     'hind_upper_L': {'pitch': -20}, 'hind_lower_L': {'pitch': 35}, 'hind_upper_R': {'pitch': -25}, 'hind_lower_R': {'pitch': 40}}, {'pitch': 10}, {})),
        (0.75, tail({'body': {'up': drop, 'pitch': 0, 'roll': -90, 'side': -0.12}, 'neck': {'pitch': 6, 'yaw': -16}, 'head': {'pitch': 4, 'yaw': -10, 'roll': -6},
                     'front_upper_L': {'pitch': -18}, 'front_lower_L': {'pitch': 22}, 'front_upper_R': {'pitch': -30}, 'front_lower_R': {'pitch': 35},
                     'hind_upper_L': {'pitch': -12}, 'hind_lower_L': {'pitch': 18}, 'hind_upper_R': {'pitch': -22}, 'hind_lower_R': {'pitch': 30}}, {'pitch': -4, 'yaw': -6}, {'yaw': -8})),
        (0.86, down(0.012)),
        (1.00, down(0.0)),
    ]


def fk(keys, t):
    return {'bones': {n: kw for n, kw in keyposes(keys, t).items() if n in pbs}, 'paws': None}


frames = {n: option(args, f'--{n}-frames', d, int) for n, d in (('idle', 72), ('attack', 24), ('hit', 9), ('death', 30))}

# How far the body drops for the fallen body to lie on the ground, not in it or above it.
drop = -0.40
for _ in range(6):
    apply_pose(fk(death_keys(drop), 1.0))
    drop -= lowest_z(obj) / K
DEATH = timed(death_keys(drop), frames['death'], 30)

make_action('Idle', frames['idle'], idle, True)
make_action('Walk', WALK_FRAMES, walk if WALK_GAIT == 'trot' else lambda p, t: gallop(p, WALK_STRIDE), True)
make_action('Run', RUN_FRAMES, lambda p, t: gallop(p, RUN_STRIDE), True)
attack_keys = timed(ATTACK, frames['attack'], 24)
make_action('Attack', frames['attack'], lambda p, t: split(keyposes(attack_keys, t)), False)
hit_keys = timed(HIT, frames['hit'], 9)
make_action('Hit', frames['hit'], lambda p, t: split(keyposes(hit_keys, t, ease=lambda x: 1 - (1 - x) ** 2)), False)
make_action('Death', frames['death'], lambda p, t: fk(DEATH, t), False, grounded=True)

# Rest pose with no active action, so the export's rest pose is the bind pose.
reset()
rig.animation_data.action = None
for name, n in CLIPS:
    rig.animation_data.action = bpy.data.actions[name]
    lows = []
    for f in range(n + 1):
        scene.frame_set(f)
        lows.append(lowest_z(obj))
    rig.animation_data.action = None
    flag = '' if min(lows) > -0.01 and (name != 'Idle' and not (name == 'Walk' and WALK_GAIT == 'trot') or max(lows) < 0.01) else '  WARN'
    print(f'GROUND {name}: lowest point per frame {min(lows):.4f} to {max(lows):.4f}{flag}')
scene.frame_set(0)
reset()
save_blend(OUT)
