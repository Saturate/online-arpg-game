# Dev tools, replays and debugging

Status: Live. Replays, the loot simulator and the F3 panel since 2026-09-28; the dev tools moved under `/admin/dev/` for builders and up on 2026-09-29; the Spell Lab since 2026-09-29.

## What it does

- **`/admin/dev/`** (builder role or higher) has five tabs, each deep-linkable through the URL hash (`#assets/built-in/giant_scorpion`):
  - **Assets:** a gallery of every model by category (hero, monster, built-in, building, nature, prop, dungeon, graveyard). Any single model, file or built-in (the monsters built in code), exports as a `.glb` ready for Blender; see [Exporting a model to Blender](#exporting-a-model-to-blender).
  - **Spell Studio:** a live headless simulation that casts a skill at dummies (pack, line or ring; type, count and distance), with hold, interval or click casting, infinite Force, time scale 0.1x to 4x, step and reset. It shows DPS over 5 s and over the run, damage, casts and fizzles, hits per cast, Force per second, peak live entities, and a 15 s timeline. "Copy as starterSigils.ts entry" exports the skill. It compiles through the same path the game uses.
  - **Spell Lab:** reads any rune list with the v2 grammar, phase 4 runes included, with a palette, examples and context fields (multicast, max depth, live cap, plain Swift and Large). It shows the verdict, each error with its rule and rune, token highlighting, the sentence, the bracket view, the node tree and the budget. Castable spells go to the Spell Studio with one click; parts the engine cannot run yet are named, not dropped ([runes.md](runes.md)).
  - **Loot:** the loot simulator. Seed, monster level (1 to 30), normal, rare or boss, kill count (default 10,000), drop chance and share overrides, and a class for "usable weapon" counts. It runs in chunks of 2,000 kills ([loot.md](loot.md)).
  - **Replay:** plays a recorded session back through the real client.
- **F3 in game** (builders and up, not in Arena runs) opens the encounter panel: spawn monsters at the cursor (N; type, count 1 to 50, level 1 to 30, rare), kill all, clear loot, god mode, heal, teleport to the cursor or a portal, time scale (0.25x to 4x), and give a sigil, vessel, gear piece or rune by tier, level and category.
- **`/sandbox`** opens a builder's private flat room with the free forge bench and F3, no waves ([forge.md](forge.md)).
- **F1** shows the debug overlay: tick, RTT (including artificial lag), visible and room entities, FPS and draw calls, pending inputs, the keys the game thinks are held, the last prediction correction, Force, and the last fizzle with its rule.
- **F8** (or the Esc menu) records a replay.
- **Client URL options:** `?lag=150` adds 150 ms of round-trip latency (split evenly each way), `?server=ws://host:port` connects to another server, `?time=0.75` pins the time of day, `?weather=0..1` pins cloud cover.

## Exporting a model to Blender

Pick a model in the Assets tab (a category, then its name in the list) and press **Export ... as .glb**. The file is named after the asset id.

What the file holds:

- **Axes and size:** glTF +Y up, facing glTF +Z, which Blender shows as Z up, facing the Front view (numpad 1, looking along +Y at the model's face). Metres at the game's size: 30 world units to the metre, so a hero is 1.8 m, the Swamp Ogre 2.8 m, the tavern 4.3 m. Feet (the lowest point) at the origin.
- **Transforms applied:** the game's own wrappers (the fit-to-height scale, the quarter turn `build()` in `render/assets.ts` gives heroes and monsters, a procedural rig's radius scale) are baked into the parts, not left on nodes. Blender opens every mesh at scale 1 with no stray empties. The file is not turned: the game turns files by 90 degrees itself, so a file exported and imported again faces the same way.
- **Only the model:** no camera, light, ground, scale capsule, hidden parts (the weapons a KayKit hero carries but does not show) or game userData. The scene is named after the asset.
- **File models (KayKit):** the armature with its skins and every clip in the source file, under their own names. Bone names get their dots back (`handslot.r`, not the `handslotr` three uses), so Blender's left and right mirroring works; the game strips the dots again when it loads the file. A weapon the game attaches is a child of its bone (an empty named `weapon` holding the weapon mesh).
- **Colours as the game shows them:** a `tint` is in the material colour and a `glow` in the emissive colour and strength. Monsters built on hero models (Ogre, Pyromancer, Butcher and the rest) are repainted in a shader in game; the export bakes that repaint into a copy of the texture, and the material is named with the tint (`barbarian_texture (8ac060)`). The hit flash and the darker corpse are not in the file.
- **Built-in monsters:** the rig uncompiled (the game draws a compiled copy, one skinned mesh with its colours in vertex attributes, which Blender could not edit), one mesh per part under the pivots (body, neck, jaw, legs, arms, tail, and extras named by kind, like `claw_0` or `orbit_2`), which are empties, so the parts pose. Materials are merged by colour and named by it (`#6a6a72`, `#000000 glow #ffe060`); the faceted look is baked into the normals. The clips are baked from the rig driver the game uses (`render/rigs/motion.ts`): Idle, Walk and Run loop (their last key is their first; the stride is pinned to whole cycles, so it runs a little faster or slower than the game), Attack is a contact blow, Cast and Shoot a wind-up and release, Hit the flinch, Death the fall to the settled corpse, plus Dormant and Awaken for statues and chests and Spawn for burrowers. Monsters that never move (bone spire, flame totem) get no Walk or Run. Keys sit on whole frames at 30 fps. The hit flash and the darker, unlit corpse are material changes and not in the file.

Editing and bringing it back:

1. In Blender, set the frame rate to 30 fps (Output Properties, Frame Rate) **before** importing. The clips are timed at 30 fps; at Blender's default 24 fps the keys land between frames and a sampled export no longer loops cleanly. The other way round: untick Always Sample Animations when exporting.
2. File, Import, glTF 2.0. Edit. Keep the model facing the Front view with its feet on the ground, and apply transforms (Ctrl+A, All Transforms) on anything you moved.
3. File, Export, glTF 2.0: format glTF Binary (.glb), Animation mode Actions, +Y Up on (the default).
4. Drop the file on the admin Model check tab. It should pass as the export did; the checks it cannot pass on some models are listed below. Then add it as the monster docs say ([monsters.md](monsters.md)): the file under `apps/client/public/assets/monsters/` and the entry "Copy asset entry" gives.

What the Model check still says about exports, and why:

- KayKit characters: over 5,000 triangles (they are, in the source files too), and "faces -Z going by its named parts". Blender shows them facing the Front view; the source files get the same verdict, so the facing guess is wrong for the KayKit skeleton, not the export.
- Some built-in monsters use black (#000000) or near-black materials in `render/models.ts`; the check flags them as invisible at night.
- Floating and burrowing built-ins (elementals, wraiths, the sand worm) have parts well below the rest, or hover above the origin. The game stands a model file's lowest point on the ground, so an imported elemental stands on the ground unless it is edited to.
- Built-ins whose id contains "horn" (thorn_beast, horned_charger) get a wrong facing guess: the check reads the root node's name as a horn.

## Why

- **Dev tools belong to staff roles, not a server toggle.** The pages and the in-game panel check the `devTools` permission ([accounts-admin.md](accounts-admin.md)).
- **Dev items cannot leak into play:** items given with the dev tools are bound (runes inside a given sigil too), and monsters spawned with them drop nothing and give no XP. Monsters a shaman raised pay out nothing the second time.
- **Dev commands are refused in Arena runs,** since runs are scored. The room's time scale goes back to 1 when no member with dev tools is left.
- **Replays are every server message the client received, timestamped.** Snapshots carry full state apart from spells (which the client rebuilds from the spell records in earlier snapshots), so feeding them back through the normal `Game` reproduces the session from the recorder's point of view with no simulation on the client. `Game` takes a session that is either live (WebSocket) or replay (a virtual clock that sends nothing). Interpolation runs on that clock, so slow motion (0.25x) and fast forward (4x) work.
- **Recordings are gzipped JSON, capped at 10 minutes** (ten minutes of 20 Hz snapshots is roughly 10 MB gzipped; past that the tab struggles). A 5.7 s town clip was 5.9 KB. A recording started mid-room is seeded with the last welcome, inventory and antechamber state.
- **Seeking** builds a fresh client at the target time from the last room entry before it. Combat events older than 0.5 s are stripped, so a seek does not burst every past hit.
- **One drop roll:** the loot simulator calls `rollDrops`, the same function the game uses.

## How

- Dev pages: `apps/client/src/dev/` (`main.tsx` tabs and the staff gate, `deepLink.ts`, `AssetsTab.tsx`, `builtinModels.ts` (built-in rigs and their baked clips), `modelExport.ts` (the export button's work: loading, the repaint bake, writing the file), `exportPrep.ts` (the pure part: axes, units, baking transforms, cleaning, names, materials), `SpellStudioTab.tsx` with `studio/`, `SpellLabTab.tsx`, `LootTab.tsx` with `loot/lootStats.ts`, `ReplayTab.tsx` with `replay/player.ts`).
- F3 panel: `apps/client/src/ui/DevPanel.tsx`; commands parsed and applied in `packages/shared/src/sim/dev.ts`; refused by `apps/server/src/room.ts` without the permission or in an Arena run.
- Debug overlay: `apps/client/src/ui/DebugOverlay.tsx`.
- Replays: `apps/client/src/game/replay.ts` (`MAX_RECORDING_MS`, encode and decode).
- Lag and server options: `apps/client/src/net/settings.ts`.

Tests:

- `packages/shared/test/dev.test.ts`: dev command parsing and effects.
- `apps/client/test/replay.test.ts`: recording and playback.
- `apps/client/test/studio.test.ts`: studio metrics, export shape, determinism, starter pricing equals the game's.
- `apps/client/test/loot.test.ts`: the loot simulator is deterministic and chunk-invariant.
- `apps/client/test/modelExport.test.ts`: the export's axis turn and metres, every vertex staying where the game draws it (rigid and skinned, at rest and animated), transforms baked into the parts, hidden parts and userData left out, names and the GLB rewrite, materials merged, the repaint maths, and every built-in export passing the Model check's loop, role, root motion and facing checks.
- `apps/server/test/accounts.test.ts`: dev tools for builders and up, time scale reset.

## Limits and open questions

- Replays started mid-room miss spells that were already alive when recording began; spells cast after that show normally.
- Only the client can add lag; there is no server-side latency simulation.
- The loot simulator does not simulate gold or the dungeon cache.
