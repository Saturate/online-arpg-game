"""
Key Idle, Walk, Run, Attack, Windup, Hit and Death on a rig from rig_biped.py, at 30 fps: a heavy
two-legged stride (a T-rex: body pitched forward, head low and leading, a weighty bob and sway)
with a travelling side-to-side wave down the tail (a tadpole), the feet planted by a two-bone IK
and the walk stride matched to the game speed. Made for the Charger.

    blender -b --python clips_biped.py -- <in.blend> <out.blend> --speed 72 --game-height 80
        [--run-speed 600] [--walk-crouch 0.09] [--walk-duty 0.54] [--sway 8]
        [--run-frames 10] [--idle-frames 90] [--attack-frames 18] [--windup-frames 24]
        [--hit-frames 9] [--death-frames 36]

Speeds are game units per second. The client plays the walk at speed / 110, clamped 0.6 to 1.8
(render/characters.ts), so the authored walk covers 110 units a second at --game-height; its
frames follow from the furthest the legs reach at --walk-crouch (metres the pelvis drops) plus
what the pelvis yaw (--sway, degrees) carries each hip forward. The run plays at 1 during a
charge; short legs cannot keep up with a charge, so its frames are --run-frames and the script
prints how much the feet slide against --run-speed.

Windup is the pose held through a telegraph: the game scales it to the wind-up's length, so it
ends coiled the moment the charge goes.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import FPS, argv, lowest_z, model_object, open_blend, option, positional, rig_object, save_blend
from mathutils import Quaternion, Vector

args = argv()
SRC, OUT = positional(args, 2, 'clips_biped.py -- <in.blend> <out.blend> --speed U --game-height U [options]')
SPEED = option(args, '--speed', None, float) or sys.exit('--speed (game units per second) is required')
GAME_HEIGHT = option(args, '--game-height', None, float) or sys.exit('--game-height (the AssetDef height) is required')
RUN_SPEED = option(args, '--run-speed', 600.0, float)
WALK_CROUCH = option(args, '--walk-crouch', 0.09, float)
WALK_DUTY = option(args, '--walk-duty', 0.54, float)
SWAY = option(args, '--sway', 8.0, float)

open_blend(SRC)
scene = bpy.context.scene
obj = model_object()
rig = rig_object()
LAYOUT = json.loads(rig['biped'])
TAIL = LAYOUT['tail']
LEGS = LAYOUT['legs']
pbs = rig.pose.bones
scene.render.fps = FPS
scene.frame_start = 0

model_height = max(v.co.z for v in obj.data.vertices)
METRES_PER_UNIT = model_height / GAME_HEIGHT
TAU = 2 * math.pi

for pb in pbs:
    pb.rotation_mode = 'QUATERNION'


def arm_quat(pitch=0.0, yaw=0.0, roll=0.0):
    """Degrees, armature axes. pitch + tips the nose down; yaw + turns left; roll + leans left."""
    return Quaternion((0, 1, 0), math.radians(roll)) @ Quaternion((0, 0, 1), math.radians(yaw)) @ Quaternion((1, 0, 0), math.radians(pitch))


def set_rel(pb, pitch=0.0, yaw=0.0, roll=0.0, fwd=0.0, side=0.0, up=0.0):
    M = pb.bone.matrix_local.to_3x3()
    Mi = M.inverted()
    pb.rotation_quaternion = (Mi @ arm_quat(pitch, yaw, roll).to_matrix() @ M).to_quaternion()
    pb.location = Mi @ Vector((side, -fwd, up))


def set_arm_rot(pb, D, parent_D=None):
    """Point the bone along armature-space orientation D; parent_D stands in for the parent's pose."""
    par = pb.parent
    PD = parent_D if parent_D is not None else par.matrix.to_3x3()
    Pm = PD @ par.bone.matrix_local.to_3x3().inverted() @ pb.bone.matrix_local.to_3x3()
    pb.rotation_quaternion = (Pm.inverted() @ D).to_quaternion()


CLAMPED = []


def leg_ik(side, target, foot_pitch):
    """Two-bone IK in the leg's plane: the knee bows forward, the ankle reaches target and the foot
    keeps its rest orientation (tipped by foot_pitch degrees, toe down, while it swings)."""
    up, lo, ft = LEGS[side]
    pu, pl, pf = pbs[up], pbs[lo], pbs[ft]
    H = pu.head.copy()
    L1, L2 = pu.bone.length, pl.bone.length
    v = target - H
    if v.length > (L1 + L2) * 0.9995:
        CLAMPED.append(v.length / (L1 + L2))
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
    set_arm_rot(pf, Quaternion((1, 0, 0), math.radians(-foot_pitch)).to_matrix() @ pf.bone.matrix_local.to_3x3(), parent_D=Dl)


# Where each ankle sits with its foot flat on the ground in the rest pose.
REST_FOOT = {}
for side, (_, _, ft) in LEGS.items():
    g = obj.vertex_groups[ft].index
    low = min(v.co.z for v in obj.data.vertices if any(x.group == g and x.weight > 0.4 for x in v.groups))
    REST_FOOT[side] = pbs[ft].bone.head_local - Vector((0, 0, low))
    print('FOOT', side, 'rests', round(low, 4), 'above the ground')


def chain_length(side):
    up, lo, _ = LEGS[side]
    return pbs[up].bone.length + pbs[lo].bone.length


def reach(crouch, sway):
    """Furthest a planted foot can sit ahead of or behind its rest spot with the pelvis lowered by
    `crouch`, plus what a pelvis yaw of `sway` degrees carries the hip forward or back."""
    out = []
    for side, (up, _, _) in LEGS.items():
        hip = pbs[up].bone.head_local
        drop = hip.z - REST_FOOT[side].z - crouch
        straight = math.sqrt(max(0.0, chain_length(side) ** 2 - drop * drop)) * 0.95
        out.append(straight + abs(hip.x) * math.sin(math.radians(sway)))
    return min(out)


def reset():
    for pb in pbs:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)


def apply_pose(pose):
    """pose: {'bones': {bone: params}, 'feet': {side: (Vector target, foot pitch)} or None (FK)}."""
    reset()
    for n, kw in pose['bones'].items():
        set_rel(pbs[n], **kw)
    if pose['feet']:
        bpy.context.view_layer.update()
        for side, (target, pitch) in pose['feet'].items():
            leg_ik(side, target, pitch)


def split(pose):
    """Pull 'ik_<side>' entries (fwd, side, up offsets in metres, pitch in degrees) out as IK targets."""
    bones, feet = {}, {}
    for n, kw in pose.items():
        if n.startswith('ik_'):
            feet[n[3:]] = (REST_FOOT[n[3:]] + Vector((kw.get('side', 0.0), -kw.get('fwd', 0.0), kw.get('up', 0.0))), kw.get('pitch', 0.0))
        elif n in pbs:
            bones[n] = kw
    for side in LEGS:
        feet.setdefault(side, (REST_FOOT[side].copy(), 0.0))
    return {'bones': bones, 'feet': feet}


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


FOOT_VERTS = set()
for _, _, ft in LEGS.values():
    g = obj.vertex_groups[ft].index
    FOOT_VERTS |= {v.index for v in obj.data.vertices if any(x.group == g and x.weight > 0.4 for x in v.groups)}
GUARD = {'chest': 0, 'tail_1': 0}


def lowest_body():
    """Lowest point of everything but the feet, and whether it is ahead of the hips."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    best = None
    for v in me.vertices:
        if v.index in FOOT_VERTS:
            continue
        co = ev.matrix_world @ v.co
        if best is None or co.z < best.z:
            best = co.copy()
    ev.to_mesh_clear()
    # Forward is Blender -Y.
    return best.z, best.y < pbs['pelvis'].bone.head_local.y


def clear_ground():
    """Keeps the jaw and tail off the ground: the snout sits far ahead of the hips, so body pitch
    and an open jaw push it down. Tips the front up or lifts the tail a degree at a time."""
    for _ in range(25):
        bpy.context.view_layer.update()
        z, ahead = lowest_body()
        if z > -0.002:
            return
        bone = 'chest' if ahead else 'tail_1'
        pb = pbs[bone]
        M = pb.bone.matrix_local.to_3x3()
        step = arm_quat(pitch=-1.0 if ahead else 1.0).to_matrix()
        pb.rotation_quaternion = (M.inverted() @ step @ M @ pb.rotation_quaternion.to_matrix()).to_quaternion()
        GUARD[bone] += 1


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
    CLAMPED.clear()
    GUARD.update(chest=0, tail_1=0)
    for f in range(frames + 1):
        if loop and f == frames:
            restore(first)
        else:
            apply_pose(pose_at(f / frames, f / FPS))
            if not grounded:
                clear_ground()
            if grounded:
                # Something always rests on the ground while it falls: no sinking in, no floating.
                for _ in range(4):
                    z = lowest_z(obj)
                    if abs(z) < 0.002:
                        break
                    pbs['pelvis'].location += pbs['pelvis'].bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, -z))
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
    over = f', the legs stretched {100 * (max(CLAMPED) - 1):.1f}% past straight on {len(CLAMPED)} foot frames' if CLAMPED else ''
    lifted = ''.join(f', {bone} lifted {deg} degree-frames to clear the ground' for bone, deg in GUARD.items() if deg)
    print(f'ACTION {name}: {frames} frames, {frames / FPS:.3f} s, loop={loop}{over}{lifted}')


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
    s = frames / authored
    return [(t * s, pose) for t, pose in keys]


def tail_wave(pose, p, amp, lag, cycles=1, pitch=(0.0,), offset=0.0):
    """A wave travelling from the root to the tip: each bone yaws a little later than its parent,
    and the swing grows toward the tip, so the tail undulates like a tadpole's instead of wagging
    stiffly. amp is degrees per bone at the root, growing 30% a bone."""
    for i, name in enumerate(TAIL):
        a = amp * (1 + 0.3 * i)
        kw = dict(pose.get(name, {}))
        kw['yaw'] = kw.get('yaw', 0.0) + a * math.sin(TAU * (cycles * p - offset - lag * i))
        kw['pitch'] = kw.get('pitch', 0.0) + pitch[min(i, len(pitch) - 1)]
        pose[name] = kw
    return pose


def gait(p, phase, duty, stride, lift):
    """Foot offset (forward, up) from its rest spot at gait phase p: planted for `duty`, then swung."""
    x = (p - phase) % 1.0
    if x < duty:
        return stride * (1 - 2 * x / duty), 0.0, 0.0
    s = (x - duty) / (1 - duty)
    # The heavy foot lifts late and stamps down: the lift peaks a third of the way through the swing.
    lift_shape = math.sin(math.pi * s ** 0.75) ** 1.2
    return -stride + 2 * stride * (0.5 - 0.5 * math.cos(math.pi * s)), lift * lift_shape, 8.0 * math.sin(math.pi * s) * (1 - s)


# Walk: the authored clip moves 110 units a second; the game slows or speeds it to the real speed.
walk_scale = max(0.6, min(1.8, SPEED / 110))
v_walk = (SPEED / walk_scale) * METRES_PER_UNIT
WALK_STRIDE = reach(WALK_CROUCH, SWAY)
WALK_FRAMES = max(8, round(2 * WALK_STRIDE * FPS / (v_walk * WALK_DUTY)))
WALK_STRIDE = v_walk * WALK_DUTY * (WALK_FRAMES / FPS) / 2
print(f'WALK {WALK_FRAMES} frames, half-stride {WALK_STRIDE:.3f} m (reach {reach(WALK_CROUCH, SWAY):.3f}), feet move {v_walk:.2f} m/s in the clip')
print(f'     in game it plays at {walk_scale:.2f}x: {walk_scale * FPS / WALK_FRAMES:.2f} strides ({2 * walk_scale * FPS / WALK_FRAMES:.2f} steps) a second at {SPEED:g} units/s')

RUN_FRAMES = option(args, '--run-frames', 10, int)
RUN_DUTY = 0.34
RUN_CROUCH = 0.14
RUN_STRIDE = reach(RUN_CROUCH, SWAY * 1.25)
v_run = 2 * RUN_STRIDE / (RUN_DUTY * RUN_FRAMES / FPS)
print(f'RUN {RUN_FRAMES} frames, half-stride {RUN_STRIDE:.3f} m: the feet carry {v_run / METRES_PER_UNIT:.0f} units/s against a {RUN_SPEED:g} charge, so they slide {RUN_SPEED * METRES_PER_UNIT / v_run:.1f}x')

PHASE = {'L': 0.0, 'R': 0.5}


def stride_pose(p, duty, stride, crouch, sway, pitch, bob, lift, tail_amp, tail_lag, roll):
    pose = {}
    for side, ph in PHASE.items():
        fw, up, fp = gait(p, ph, duty, stride, lift)
        pose[f'ik_{side}'] = {'fwd': fw, 'up': up, 'pitch': fp}
    # Lowest just after each footfall, highest mid-stance: the weight lands, then vaults over the leg.
    b = 0.5 * (1 + math.cos(TAU * 2 * (p - 0.07)))
    yaw = -sway * math.cos(TAU * p)
    nod = math.cos(TAU * 2 * (p - 0.1))
    pose['pelvis'] = {'up': -crouch - bob * b, 'pitch': pitch + 1.6 * nod, 'roll': roll * math.sin(TAU * p), 'yaw': yaw}
    # The front of the body and the head counter the hips, so the head leads steady and low.
    pose['chest'] = {'pitch': 2.0 - 0.8 * nod, 'yaw': -0.55 * yaw, 'roll': -0.5 * roll * math.sin(TAU * p)}
    pose['head'] = {'pitch': 1.5 - 0.6 * nod, 'yaw': -0.35 * yaw}
    pose['jaw'] = {'pitch': 2 + 3 * 0.5 * (1 + math.cos(TAU * 2 * (p - 0.2)))}
    pose['arm_L'] = {'pitch': 10 + 9 * math.sin(TAU * (p + 0.1))}
    pose['arm_R'] = {'pitch': 10 + 9 * math.sin(TAU * (p + 0.6))}
    # The tail lifts as the body dips, a counterweight; its first bone undoes most of the hips' yaw.
    tail_wave(pose, p, tail_amp, tail_lag, pitch=(-3 - 2.5 * nod, -2.0, -1.0))
    pose['tail_1']['yaw'] -= 0.7 * yaw
    return split(pose)


def walk(p, t):
    return stride_pose(p, WALK_DUTY, WALK_STRIDE, WALK_CROUCH, SWAY, 8.0, 0.055, 0.1, 9.0, 0.18, 3.0)


def run(p, t):
    # The charge: lower, pitched hard into the ram, longer strides and a lashing tail.
    # The snout sits about 1.9 m ahead of the hips, so every degree of pitch drops it 3 cm: the
    # charge leans in by thrusting forward, not by tipping further.
    pose = stride_pose(p, RUN_DUTY, RUN_STRIDE, RUN_CROUCH, SWAY * 1.25, 10.0, 0.045, 0.2, 16.0, 0.2, 4.0)
    pose['bones']['pelvis']['fwd'] = 0.1
    # A gape lifts the head as the jaw drops, or the low-slung jaw would plough the ground.
    pose['bones']['jaw'] = {'pitch': 6 + 3 * math.sin(TAU * 2 * p)}
    pose['bones']['head']['pitch'] -= 9
    pose['bones']['arm_L'] = {'pitch': -25}
    pose['bones']['arm_R'] = {'pitch': -25}
    return pose


def idle(p, t):
    """Slow heavy breathing, the head swinging round to look, jaw working, tail idly undulating."""
    br = math.sin(TAU * 3 * p)
    pose = {
        'pelvis': {'up': -0.05 + 0.012 * br, 'pitch': 3 + 0.8 * br, 'roll': 1.2 * math.sin(TAU * p)},
        'chest': {'pitch': -0.6 * br, 'yaw': 4 * math.sin(TAU * p + 0.5)},
        'head': {'pitch': 2 + 2.5 * math.sin(TAU * 2 * p + 1.0), 'yaw': 7 * math.sin(TAU * p), 'roll': 2.5 * math.sin(TAU * p - 0.7)},
        'jaw': {'pitch': -5 + 11 * max(0.0, math.sin(TAU * 2 * p - 0.6))},
        'arm_L': {'pitch': 8 + 6 * math.sin(TAU * 3 * p + 0.3)},
        'arm_R': {'pitch': 8 + 6 * math.sin(TAU * 3 * p + 1.4)},
    }
    tail_wave(pose, p, 4.0, 0.12, cycles=2, pitch=(-2.0,))
    return split(pose)


# Windup, authored at 24 frames, in two beats so the body telegraphs and not only the ground: it
# rears up with the maw wide, then drops back onto its haunches, coiled, scraping the right foot,
# with the tail raised and lashing harder and harder. It ends coiled.
def windup(p, t):
    rear = smooth(min(1.0, p / 0.25)) * (1 - smooth((p - 0.25) / 0.2))
    k = smooth((p - 0.3) / 0.3)
    scrape = max(0.0, math.sin(TAU * 2 * (p - 0.45))) if 0.45 < p < 0.95 else 0.0
    pose = {
        'pelvis': {'fwd': -0.06 * rear - 0.17 * k, 'up': -0.04 * rear - 0.13 * k, 'pitch': -9 * rear + 7 * k},
        'chest': {'pitch': -4 * rear + 4 * k},
        'head': {'pitch': -10 * rear + 2 * k, 'yaw': 2.0 * math.sin(TAU * 3 * p) * k},
        'jaw': {'pitch': 4 + 18 * rear + 12 * k},
        'arm_L': {'pitch': -35 * rear - 20 * k},
        'arm_R': {'pitch': -35 * rear - 20 * k},
        'ik_R': {'fwd': -0.08 * k - 0.2 * scrape, 'up': 0.1 * scrape, 'pitch': 12 * scrape},
    }
    # Positive pitch lifts a bone that points back, so this raises the tail.
    tail_wave(pose, p, 5 + 14 * k, 0.18, cycles=3, pitch=(6 * rear + 12 * k, 4 * k, 2 * k))
    return split(pose)


# Attack, authored at 18 frames: rears back, then steps into a ram with the head down and the
# jaws gaping, snaps them shut on impact and pulls back. The legs are nearly straight at rest, so
# the lunge needs the left foot to step forward and the right to drag after it.
ATTACK = [
    (0.00, {}),
    (0.17, {'pelvis': {'fwd': -0.12, 'up': -0.08, 'pitch': -7, 'roll': 2}, 'chest': {'pitch': -5}, 'head': {'pitch': -8}, 'jaw': {'pitch': 10},
            'arm_L': {'pitch': -30}, 'arm_R': {'pitch': -30}, 'tail_1': {'pitch': 9}, 'tail_2': {'pitch': 6}, 'tail_3': {'pitch': 4},
            'ik_L': {'fwd': 0.06, 'up': 0.1, 'pitch': 6}}),
    (0.29, {'pelvis': {'fwd': 0.3, 'up': -0.07, 'pitch': 9}, 'chest': {'pitch': 2}, 'head': {'pitch': -12}, 'jaw': {'pitch': 22},
            'arm_L': {'pitch': 35}, 'arm_R': {'pitch': 35}, 'tail_1': {'pitch': -8, 'yaw': 8}, 'tail_2': {'pitch': -5, 'yaw': -10}, 'tail_3': {'yaw': -14}, 'tail_4': {'yaw': 12},
            'ik_L': {'fwd': 0.3}, 'ik_R': {'fwd': 0.08}}),
    (0.36, {'pelvis': {'fwd': 0.32, 'up': -0.08, 'pitch': 10}, 'chest': {'pitch': 4}, 'head': {'pitch': 3}, 'jaw': {'pitch': -18},
            'arm_L': {'pitch': 30}, 'arm_R': {'pitch': 30}, 'tail_1': {'pitch': -6, 'yaw': -6}, 'tail_2': {'yaw': 8}, 'tail_3': {'yaw': 14}, 'tail_4': {'yaw': -10}, 'tail_5': {'yaw': -12},
            'ik_L': {'fwd': 0.3}, 'ik_R': {'fwd': 0.12}}),
    (0.47, {'pelvis': {'fwd': 0.16, 'up': -0.05, 'pitch': 4}, 'jaw': {'pitch': -6}, 'ik_L': {'fwd': 0.15, 'up': 0.08}, 'ik_R': {'fwd': 0.06}}),
    (0.60, {}),
]

HIT = [
    (0.00, {}),
    (0.07, {'pelvis': {'fwd': -0.06, 'up': -0.07, 'pitch': -8, 'roll': 5}, 'chest': {'pitch': -4, 'yaw': 5}, 'head': {'pitch': -10, 'yaw': 9, 'roll': 6},
            'jaw': {'pitch': 18}, 'tail_1': {'yaw': -8, 'pitch': 6}, 'tail_2': {'yaw': -10}, 'tail_3': {'yaw': 8}, 'tail_4': {'yaw': 10}}),
    (0.30, {}),
]


def death_keys(drop):
    """Authored at 36 frames: rears with the jaws wide, the legs buckle, it rolls onto its right side
    and the tail lies out long."""
    legs_folded = {'upper_L': {'pitch': -35}, 'lower_L': {'pitch': 50}, 'upper_R': {'pitch': -55}, 'lower_R': {'pitch': 70}}
    down = lambda extra, curl: {
        'pelvis': {'up': drop + extra, 'pitch': 4, 'roll': -88, 'side': -0.25},
        'chest': {'pitch': 3, 'yaw': -6}, 'head': {'pitch': 6, 'yaw': -10, 'roll': -4}, 'jaw': {'pitch': 16},
        'arm_L': {'pitch': 30}, 'arm_R': {'pitch': 10},
        # Rolled onto its side, a yaw would lift the tail into the air; a pitch lays it along the ground.
        'tail_1': {'pitch': 2 * curl}, 'tail_2': {'pitch': 3 * curl}, 'tail_3': {'pitch': 3 * curl}, 'tail_4': {'pitch': 2 * curl}, 'tail_5': {'pitch': 2 * curl},
        **legs_folded,
    }
    return [
        (0.00, {}),
        (0.18, {'pelvis': {'fwd': -0.06, 'up': 0.02, 'pitch': -12, 'roll': 4}, 'chest': {'pitch': -6}, 'head': {'pitch': -16}, 'jaw': {'pitch': 32},
                'arm_L': {'pitch': -40}, 'arm_R': {'pitch': -40}, 'tail_1': {'pitch': 12}, 'tail_2': {'pitch': 8}}),
        (0.50, {'pelvis': {'up': -0.3, 'pitch': 10, 'roll': -24, 'side': -0.06}, 'chest': {'pitch': 6}, 'head': {'pitch': 10, 'yaw': -6}, 'jaw': {'pitch': 20},
                'upper_L': {'pitch': -40}, 'lower_L': {'pitch': 70}, 'upper_R': {'pitch': -50}, 'lower_R': {'pitch': 80}, 'tail_1': {'pitch': 4}}),
        (0.85, down(0.02, 1.4)),
        (1.00, down(0.0, 1.0)),
    ]


def fk(keys, t):
    return {'bones': {n: kw for n, kw in keyposes(keys, t).items() if n in pbs}, 'feet': None}


frames = {n: option(args, f'--{n}-frames', d, int) for n, d in (('idle', 90), ('attack', 18), ('windup', 24), ('hit', 9), ('death', 36))}

# How far the pelvis drops for the fallen body to lie on the ground, not in it or above it.
drop = -0.4
for _ in range(8):
    apply_pose(fk(death_keys(drop), 1.0))
    drop -= lowest_z(obj)
DEATH = timed(death_keys(drop), frames['death'], 36)

make_action('Idle', frames['idle'], idle, True)
make_action('Walk', WALK_FRAMES, walk, True)
make_action('Run', RUN_FRAMES, run, True)
attack_keys = timed(ATTACK, frames['attack'], 18)
make_action('Attack', frames['attack'], lambda p, t: split(keyposes(attack_keys, t)), False)
make_action('Windup', frames['windup'], windup, False)
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
    print(f'GROUND {name}: lowest point per frame {min(lows):.4f} to {max(lows):.4f}{"  WARN" if min(lows) < -0.015 else ""}')
scene.frame_set(0)
reset()
save_blend(OUT)
