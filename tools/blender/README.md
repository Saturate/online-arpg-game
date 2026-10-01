# Blender model pipeline

Small scripts that take a hand-made `.glb` to one the game can load: cleaned, facing the right way, coloured, rigged, animated, exported and checked. They run in headless Blender (`blender -b --python script.py -- args`) with Blender's bundled Python and nothing else, so no Blender MCP or GUI is needed. Tested with Blender 5.2.2 (`/opt/homebrew/bin/blender`).

Each step reads the previous step's `.blend` and saves a new one, so a step can be rerun on its own after a tweak. Keep the work files outside the repo (a scratch folder); only the finished `.glb` goes under `apps/client/public/assets/monsters/`. The scripts never write to their input.

## Order

| Step | Script | What it does |
|---|---|---|
| 1 | `import_clean.py <in.glb> <out.blend>` | Imports, keeps the largest mesh outside any template (a dev-tools export of a built-in monster, recognised by its `arm_l`/`leg_l` pivots), bakes transforms, welds the faces the glTF importer split apart, deletes everything else, prints what it kept. `--all` keeps every non-template mesh, `--template NAME` drops more roots, `--keep-uvs` for textured models. |
| 2 | `orient_ground.py <in> <out> --turn DEG` | Turns about Blender Z so the head points at -Y (glTF +Z), puts the lowest point on z = 0 and centres forward on the feet (`--centre-forward M` puts the origin, the game's collider centre, M metres ahead of them). |
| 3 | `recolour.py <in> <out> --palette p.json` | Flat Principled BSDF colours from a palette, by material name or by face region (a region can pick small loose parts, such as modelled eyes, by `part_verts`), plus optional glowing eyes. Refuses colours darker than luminance 0.01. |
| 4 | `rig_quadruped.py <in> <out> --joints j.json` | Quadruped skeleton from joint positions, rigid skinning. |
| 4b | `rig_biped.py <in> <out> --joints j.json` | Two legs, jaw, arms and a tail chain from a bone list; rigid blocks by region rules, a smooth blend along the trunk and tail so it can bend and carry a wave. |
| 5 | `clips_quadruped.py <in> <out> --speed U` | Idle, Walk, Run, Attack, Hit, Death with paw IK, stride matched to the move speed. |
| 5b | `clips_biped.py <in> <out> --speed U --game-height H` | Idle, Walk, Run, Attack, Windup, Hit, Death for a heavy two-legged walker with a tail wave (the Charger), foot IK, walk stride matched to the move speed. |
| 6 | `export_glb.py <in> <out.glb>` | glTF binary the way the game wants it. |
| 7 | `pnpm model:check <out.glb> --height N` | The admin Model check in the terminal; exits 1 on any warning. |
| 8 | `preview.py <out.glb> <dir> --sheets` | Stills per clip next to the KayKit Barbarian at game scale, night shots, side and front contact sheets. |

Every script's docstring lists all its options.

## Model frame

All JSON positions are metres in the frame `orient_ground.py` leaves: **forward** (towards the head, Blender -Y), **left** (the model's own left, Blender +X), **up** (Blender Z, 0 at the feet). Read positions off the model in Blender after step 2: forward = -Y, left = X, up = Z.

## Joints file

```json
{
  "name": "dire_wolf",
  "trunk": {
    "body":  [[-0.353, 0.62], [-0.053, 0.64]],
    "chest": [[-0.053, 0.64], [0.237, 0.66]],
    "neck":  [[0.257, 0.70], [0.447, 0.87]],
    "head":  [[0.447, 0.87], [0.797, 0.88]],
    "tail":  [[-0.443, 0.70], [-0.623, 0.635], [-0.823, 0.604]]
  },
  "legs": {
    "front": {"hip": [0.212, 0.12, 0.56], "knee": [0.212, 0.12, 0.335], "ankle": [0.207, 0.12, 0.124], "toe": [0.277, 0.12, 0.0]},
    "hind":  {"hip": [-0.293, 0.135, 0.58], "knee": [-0.303, 0.135, 0.355], "ankle": [-0.453, 0.135, 0.10], "toe": [-0.393, 0.135, 0.035]}
  },
  "skin": {"leg_top": 0.50, "leg_inner": 0.05, "ring_top": 0.56, "ring_side": 0.12, "ring_half": 0.14, "front_from": -0.043, "head_above": 0.98}
}
```

Trunk bones are `[forward, up]` on the centre line; the tail takes any number of points. Legs are the left side as `[forward, left, up]`, mirrored for the right. `knee` is the joint that bends, `ankle` the ring above the paw, `toe` the tip of the paw. The `skin` bounds say which vertices are leg (below `leg_top`, further out than `leg_inner`, front legs from `front_from` forward), where the shoulder ring is, and above what height everything follows the head (ears). The dog's files are in `examples/dog/`.

## Worked example: the dog

The owner's brother's "Dog thing" (`~/Downloads/Dog thing.glb`, 354 triangles) faces +X, has no material and sits next to the dev tools' own export of the procedural `dire_wolf`. From the repo root, with `S` a scratch folder:

```sh
b() { /opt/homebrew/bin/blender -b --python "$@"; }
T=tools/blender
S=/tmp/dog; mkdir -p $S
b $T/import_clean.py -- "$HOME/Downloads/Dog thing.glb" $S/1_clean.blend --name dire_wolf
b $T/orient_ground.py -- $S/1_clean.blend $S/2_oriented.blend --turn -90
b $T/recolour.py -- $S/2_oriented.blend $S/3_coloured.blend --palette $T/examples/dog/palette.json
b $T/rig_quadruped.py -- $S/3_coloured.blend $S/4_rigged.blend --joints $T/examples/dog/joints.json
b $T/clips_quadruped.py -- $S/4_rigged.blend $S/5_animated.blend --speed 170 --walk-gait gallop
b $T/export_glb.py -- $S/5_animated.blend $S/dire_wolf.glb
pnpm model:check $S/dire_wolf.glb --height 34
b $T/preview.py -- $S/dire_wolf.glb $S/renders --sheets
```

What it prints: the template dropped (12 meshes), 722 vertices welded to 179, 394 triangles with the eyes, 13 materials, 19 bones. Clips: Idle 72 frames, Walk 9 frames as a gallop (half-stride 0.198 m, the legs reach 0.201 m), Run 6 frames with a 13% slide warning (190 units a second is past what these legs reach at 34 units tall; the dire wolf moves at 170 and never runs), Attack 24, Hit 9, Death 30. The Model check passes all 10 checks.

The speed of 170 is `dire_wolf`'s `moveSpeed` in `packages/shared/src/data/enemies.ts`; 34 is the model's 1.143 m at 30 units a metre, about 63% of a hero.

### The same dog as the Grave Hound

The `grave_hound` monster (`apps/client/public/assets/monsters/grave_hound.glb`) is the same dog, rebuilt bigger and slower so it trots: an ashen coat and green eyes (`examples/grave_hound/`), 50 units tall, moving at 115 with a low stalking trot.

```sh
b $T/import_clean.py -- "$HOME/Downloads/Dog thing.glb" $S/1_clean.blend --name grave_hound
b $T/orient_ground.py -- $S/1_clean.blend $S/2_oriented.blend --turn -90
b $T/recolour.py -- $S/2_oriented.blend $S/3_coloured.blend --palette $T/examples/grave_hound/palette.json
b $T/rig_quadruped.py -- $S/3_coloured.blend $S/4_rigged.blend --joints $T/examples/grave_hound/joints.json
b $T/clips_quadruped.py -- $S/4_rigged.blend $S/5_animated.blend --speed 115 --game-height 50 --walk-crouch 0.075
b $T/export_glb.py -- $S/5_animated.blend $S/grave_hound.glb
pnpm model:check $S/grave_hound.glb --height 50
```

Walk 10 frames, half-stride 0.235 m (the legs reach 0.232), 3.14 strides a second in game at 115; Run 8 frames for 190 (about 3% past the reach; rarely seen, since the game runs only above 188 and even a Hasted rare tops out at 184). With the default crouch the same trot needs a 6-frame cycle, 5.7 strides a second.

### The Charger

The owner's brother's `Charger.glb` (`~/Downloads/Charger.glb`, copied to the scratch folder first; never work on the original) holds the dev tools' `dire_wolf` export, his earlier dog and the Charger: one 682-triangle mesh with no material and no animation, facing +X. It walks on two legs, so it has its own rig and clip scripts. Shot by shot, with the files in `examples/charger/`:

```sh
cp ~/Downloads/Charger.glb $S/source_charger.glb
b $T/import_clean.py -- $S/source_charger.glb $S/1_clean.blend --name charger
b $T/orient_ground.py -- $S/1_clean.blend $S/2_oriented.blend --turn -90 --centre-forward 1.25
b $T/recolour.py -- $S/2_oriented.blend $S/3_coloured.blend --palette $T/examples/charger/palette.json
b $T/rig_biped.py -- $S/3_coloured.blend $S/4_rigged.blend --joints $T/examples/charger/joints.json
b $T/clips_biped.py -- $S/4_rigged.blend $S/5_animated.blend --speed 72 --game-height 80
b $T/export_glb.py -- $S/5_animated.blend $S/out/charger.glb
pnpm model:check $S/out/charger.glb --height 80
```

What it prints: the template dropped (12 meshes), the Charger picked over the dog, 1444 vertices welded to 353, 9 colours by region, 18 bones (17 deforming). Walk 13 frames, half-stride 0.356 m against a 0.351 m reach, 1.5 strides a second in game at 72; Run 10 frames, sliding about 2x against the 600 charge; Idle 90, Attack 18, Windup 24, Hit 9, Death 36; every clip on the ground every frame. The Model check passes all 11 checks.

## Lessons

- Headless Blender with scripts works without the Blender MCP, and every step can be rerun.
- The glTF importer splits faces for flat shading; weld (merge by distance) before rigging or the skin tears at every edge.
- People load the game's exported procedural template (`dev/builtinModels.ts`) as a size guide and leave it in the file: pick the largest mesh outside it.
- Low-poly parts should move as blocks: one bone per vertex, two-bone blends only on the rings where joints bend.
- Paw bones plus a small two-bone IK keep paws planted in every clip; paws that rest above the ground in the rest pose (hind paws often do) must be planted by the clips.
- Game scale is about 30 units a metre (a hero is 54 units); the model is scaled to its AssetDef height.
- The walk must match the move speed or the feet slide: the client plays the walk at speed / 110, clamped 0.6 to 1.8 (`render/characters.ts`), so between 66 and 198 units a second the authored walk covers 110 units a second. The run plays at 1 and must cover the run speed.
- Small monsters with fast move speeds cannot trot that fast: 110 units a second is 3.7 m/s at game scale, past a 0.57 m leg's trot reach. Use `--walk-gait gallop`, a larger game height, or accept the slide.
- The legs of this rig are nearly straight at rest, so how far a planted paw reaches ahead depends on how low the body goes. For a big monster that should trot rather than patter, lower the trot with `--walk-crouch` (0.075 m takes the dog's trot reach from 0.138 to 0.232 m against the default 0.025).
- Side and front Workbench contact sheets per clip are the quickest check on motion: sliding paws, popping loops, bad bends.
- Blender's night lighting is not the game's night grade; check night readability in the game (`?time=0.9`).
- Feet with their own material used to trip the Model check's stray-part warning; it now judges parts by mesh node.
- A brother's file can be all template: the Charger's materials and clips all belonged to the `dire_wolf` export, and the model itself had neither. Check which mesh the warnings are about before fixing them.
- macOS file names ignore case: exporting `charger.glb` next to a copied `Charger.glb` overwrites the copy. Give working files distinct names.
- A model whose bulk reaches far ahead of its legs needs its origin moved forward (`--centre-forward`), or it bites from outside the circle that hits and its head covers the hero in melee.
- A snout far ahead of the hips drops about 3 cm per degree of body pitch; lean a charge in by thrusting forward, and lift the head as the jaw opens, or it ploughs the ground. `clips_biped.py` prints each clip's lowest point per frame for this.
- Short legs bent at a knee in the middle of long faces shear into shards. Putting the knee on the ring under the belly lets the visible leg swing as one block.
- When checking a rebuilt model in the game, make sure the browser loads the new file (`fetch(url, {cache: 'reload'})` once, or the Network panel): an old copy in the HTTP cache looks exactly like a fix that did nothing.
- A glowing colour stays coloured only at a low strength: the game's ACES tone mapping turns a bright saturated glow white (the Charger's ember eyes read white at 2.4 and amber at 0.35). Small faceted eyes also want high roughness and no specular, or a white highlight hides the glow.
- Check a model's colours from the game camera: it looks down on the back, so the colour of the back decides how it reads, by day as much as at night.

## Limits

- Quadrupeds and heavy bipeds with a tail (`rig_biped.py`, `clips_biped.py`, authored on the Charger) have rig and clip templates. A flyer, or a biped built differently, needs its own; `import_clean`, `orient_ground`, `recolour`, `export_glb` and `preview` work for any model.
- The region rules in the palette are per model; move them if the proportions change.
- Pose amounts are authored for a 0.57 m hip height and scale with the rig; a very different body shape needs its keys tuned.
