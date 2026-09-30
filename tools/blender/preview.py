"""
Preview renders of an exported model next to the KayKit Barbarian at game scale.

    blender -b --python preview.py -- <model.glb> <out_dir> [--game-height U] [--sheets]

Writes, for each clip, a still from the game's high three-quarter camera with the Barbarian
beside it (a hero is 54 game units; the model stands at --game-height units, by default its
height at 30 units a metre), a close-up and two night shots. --sheets adds a side and a front
contact sheet per clip (8 frames, Workbench, orthographic): the quick way to see sliding paws,
popping loops and bad bends.

Blender's night lighting here is only a rough stand-in for the game's night grade and fog; check
night readability in the game itself (?time=0.9).
"""
import array
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import FPS, HERO_UNITS, REPO, UNITS_PER_METRE, argv, flag, option, positional
from mathutils import Vector

args = argv()
MODEL, OUT = positional(args, 2, 'preview.py -- <model.glb> <out_dir> [--game-height U] [--sheets]')
BARB = os.path.join(REPO, 'apps/client/public/assets/kaykit/adventurers/Barbarian.glb')
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = FPS


def import_glb(path):
    objs, acts = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in objs]
    # The importer adds an icosphere as the bones' display shape; it is not part of the model.
    shapes = {pb.custom_shape for o in new if o.type == 'ARMATURE' for pb in o.pose.bones if pb.custom_shape}
    for o in shapes:
        o.hide_render = True
    return [o for o in new if o not in shapes], [a for a in bpy.data.actions if a not in acts]


def bounds(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type != 'MESH' or o.hide_render:
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        pts += [ev.matrix_world @ v.co for v in me.vertices]
        ev.to_mesh_clear()
    return Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))


def play(rig, act, frame):
    ad = rig.animation_data or rig.animation_data_create()
    for t in ad.nla_tracks:
        t.mute = True
    ad.action = act
    if act is not None and getattr(act, 'slots', None):
        ad.action_slot = act.slots[0]
    sc.frame_set(frame)


def clip(acts, name):
    return next((a for a in acts if a.name == name or a.name.startswith(name)), None)


objs, acts = import_glb(MODEL)
rig = next((o for o in objs if o.type == 'ARMATURE'), None)
if rig:
    play(rig, None, 0)
lo, hi = bounds(objs)
height = hi.z - lo.z
GAME_HEIGHT = option(args, '--game-height', height * UNITS_PER_METRE, float)
size = max(1.0, height / 1.15)
print(f'model height {height:.3f} in the file, {GAME_HEIGHT:.0f} game units')

barb_objs, barb_acts = import_glb(BARB)
# KayKit heroes carry every weapon; the game shows none of them on the Barbarian.
for o in barb_objs:
    if o.type == 'MESH' and any(k in o.name for k in ('Axe', 'Mug', 'Shield', 'Sword', 'Hat', 'Cape')):
        o.hide_render = True
barb_rig = next(o for o in barb_objs if o.type == 'ARMATURE')
play(barb_rig, clip(barb_acts, 'Idle'), 10)
b0, b1 = bounds(barb_objs)
s = HERO_UNITS * height / GAME_HEIGHT / (b1.z - b0.z)
barb_rig.scale = (s, s, s)
barb_rig.location = (1.35 * size, 0.75 * size, 0)
bpy.context.view_layer.update()
barb_rig.location.z -= bounds(barb_objs)[0].z

bpy.ops.mesh.primitive_plane_add(size=12 * size)
gm = bpy.data.materials.new('ground')
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.055, 0.05, 0.04, 1)
bpy.context.active_object.data.materials.append(gm)

cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
cam_data.lens = 50


def aim(loc, target):
    cam.location = Vector(loc) * size
    cam.rotation_euler = (Vector(target) * size - cam.location).to_track_quat('-Z', 'Y').to_euler()


world = bpy.data.worlds.new('w')
sc.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
sun_d, fill_d = bpy.data.lights.new('sun', 'SUN'), bpy.data.lights.new('fill', 'SUN')
sun, fill = bpy.data.objects.new('sun', sun_d), bpy.data.objects.new('fill', fill_d)
sc.collection.objects.link(sun)
sc.collection.objects.link(fill)


def day():
    bg.inputs['Color'].default_value = (0.20, 0.21, 0.23, 1)
    bg.inputs['Strength'].default_value = 0.8
    sun_d.energy, sun_d.color, sun.rotation_euler = 3.2, (1.0, 0.93, 0.82), (math.radians(50), 0, math.radians(35))
    fill_d.energy, fill_d.color, fill.rotation_euler = 0.6, (0.7, 0.8, 1.0), (math.radians(60), 0, math.radians(200))


def night():
    bg.inputs['Color'].default_value = (0.03, 0.04, 0.07, 1)
    bg.inputs['Strength'].default_value = 0.5
    sun_d.energy, sun_d.color, sun.rotation_euler = 0.35, (0.55, 0.65, 1.0), (math.radians(55), 0, math.radians(-40))
    fill_d.energy = 0.08


def shot(name):
    sc.render.filepath = os.path.join(OUT, name + '.png')
    bpy.ops.render.render(write_still=True)


sc.render.engine = 'BLENDER_EEVEE'
sc.view_settings.view_transform = 'AgX'
sc.render.resolution_x, sc.render.resolution_y = 1000, 750
GAME_CAM = ((3.6, -4.2, 4.6), (0.6, 0.2, 0.45))
clips = sorted(acts, key=lambda a: a.name) if rig else []
length = {a.name: int(round(a.frame_range[1] - a.frame_range[0])) for a in clips}

day()
aim(*GAME_CAM)
for a in clips:
    f = length[a.name] if a.name.lower().startswith('death') else round(length[a.name] * 0.4)
    play(rig, a, f)
    shot(f'{a.name.lower()}_f{f:02d}')
idle = clip(clips, 'Idle')
if rig:
    play(rig, idle, 0)
aim((1.3, -1.9, 1.35), (0.0, -0.35, 0.6))
shot('closeup')
aim(*GAME_CAM)
night()
shot('night_idle')
attack = clip(clips, 'Attack')
if attack:
    play(rig, attack, round(length[attack.name] * 0.5))
    shot('night_attack')

if flag(args, '--sheets') and rig:
    day()
    for o in barb_objs:
        o.hide_render = True
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
    sc.render.resolution_x, sc.render.resolution_y = 360, 300
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 2.4 * size
    tiles = os.path.join(OUT, 'tiles')
    os.makedirs(tiles, exist_ok=True)
    for view, loc in (('side', (3.6, 0.0, 0.7)), ('front', (1.2, -3.4, 1.2))):
        aim(loc, (0.0, 0.0, 0.45))
        for a in clips:
            n = length[a.name]
            frames = sorted({round(i * n / 7) for i in range(8)})
            imgs = []
            for f in frames:
                play(rig, a, f)
                sc.render.filepath = os.path.join(tiles, f'{view}_{a.name}_{f:02d}.png')
                bpy.ops.render.render(write_still=True)
                imgs.append(bpy.data.images.load(sc.render.filepath))
            w, h = imgs[0].size
            cols, rows = 4, math.ceil(len(imgs) / 4)
            px = array.array('f', [0.0]) * (w * cols * h * rows * 4)
            for i, im in enumerate(imgs):
                src = array.array('f', [0.0]) * (w * h * 4)
                im.pixels.foreach_get(src)
                cx, cy = i % cols, rows - 1 - i // cols
                for y in range(h):
                    o = ((cy * h + y) * w * cols + cx * w) * 4
                    px[o:o + w * 4] = src[y * w * 4:(y + 1) * w * 4]
            sheet = bpy.data.images.new(f'sheet_{view}_{a.name}', w * cols, h * rows)
            sheet.pixels.foreach_set(px)
            sheet.filepath_raw = os.path.join(OUT, f'sheet_{view}_{a.name.lower()}.png')
            sheet.file_format = 'PNG'
            sheet.save()
            print('SHEET', view, a.name, 'frames', frames)
print('PREVIEW done:', OUT)
