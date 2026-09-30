"""
Export the model and its rig as the game wants it: glTF binary, +Y up, one clip per action,
no cameras or lights, UVs only when the mesh kept them (import_clean.py --keep-uvs), the rest pose as the bind pose.

    blender -b --python export_glb.py -- <in.blend> <out.glb>

Then run the game's Model check on it:  pnpm model:check <out.glb> --height <game units>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy
from common import argv, model_object, open_blend, positional

args = argv()
SRC, OUT = positional(args, 2, 'export_glb.py -- <in.blend> <out.glb>')
open_blend(SRC)
obj = model_object()
rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
for pb in (rigs[0].pose.bones if rigs else []):
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.location = (0, 0, 0)
if rigs and rigs[0].animation_data:
    rigs[0].animation_data.action = None
bpy.context.scene.frame_set(0)

bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
for r in rigs:
    r.select_set(True)
bpy.context.view_layer.objects.active = rigs[0] if rigs else obj
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_yup=True,
    export_apply=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_force_sampling=True,
    export_frame_step=1,
    export_anim_single_armature=True,
    export_reset_pose_bones=True,
    export_def_bones=False,
    export_cameras=False,
    export_lights=False,
    export_materials='EXPORT',
    export_texcoords=bool(obj.data.uv_layers),
    export_skins=True,
    use_selection=True,
)
print('EXPORTED', OUT, f'{os.path.getsize(OUT) / 1024:.0f} KB')
