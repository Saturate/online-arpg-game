# Monsters

Status: Live. The roster since 2026-09-28 (two batches); the admin Monsters, Minions and Model check tabs were pushed to `main` on 2026-09-30 (merged as `feat/monster-browser` on 2026-09-29).

## What it does

- **68 monster types:** 3 originals with their own AI (Chaser, Shooter, Spinner) and 65 built on one generic AI: 58 regular monsters in 21 families and 7 bosses.
- **Families:** swarm, brute, archer, caster, summoner, charger, exploder, shielder, shaman, leaper, burrower, totem, ghost, poisoner, splitter, beast, elemental, golem, flyer, lurker and boss (plus `fallen`, used only to label the Chaser).
- **Bosses**, one per biome, each with an enraged phase:

| Boss | Biome | Life (base) | Enrages at | Enraged |
|---|---|---|---|---|
| The Butcher | meadow | 1400 | 50% | self slam |
| The Pale Lich | crypt | 1100 | 50% | summons wraiths |
| The Broodmother | marsh | 1200 | 40% | summons venom spiders |
| The Infernal | ruins | 1300 | 40% | fire pool, summons volatiles; bursts on death |
| The Sand Wyrm | desert | 1500 | 50% | blasts, summons sand worms |
| The Treant King | forest | 1600 | 50% | poison pool |
| The Frost Giant | cave | 1700 | 50% | summons an ice wraith, self slam |

- **Every big attack is telegraphed:** a circle or line fills up while the monster stands still, then lands, so it can always be dodged.
- **Rares** have 3x life, 1.45x size and 1 to 3 affixes: Extra Fast (hasted), Multishot (extra projectiles), Reflects Projectiles, Extra Strong (armored, more life) and Regenerates. Names follow D2 style, built from the affixes.
- **Corpses** stay 20 s (at most 60), and a necromancer or shaman can raise them. Raised monsters, bosses, totems and ghosts leave no corpse.
- **Admin tabs** (`/admin/`, [accounts-admin.md](accounts-admin.md)):
  - **Monsters and Minions:** every type's numbers (stats and ability numbers), model and height, editable live, with Export back to source.
  - **Model check:** load a local `.glb` and see whether it is ready to commit; "Try on" swaps it in for one monster or minion type in your own browser.

## Why

- **Telegraphs on everything big** keep the action layer fair: skill decides whether you get hit, not reaction to an instant attack.
- **Pools by biome and level:** zones draw packs from `monsterPool(biome, level)`, and harder families appear deeper in (from level 1 for rats and boars to level 8 for iron golems and hellspawn). Pack size scales by family (swarms 2.2x, golems 0.45x, bosses 0.2x). Each zone's far end is its biome boss with an escort. Dungeons are crypts or caves, picked by seed ([town.md](town.md)).
- **Waking:** packs idle until a target is within 460 units in line of sight, or one of them is hit; a hit also wakes idle monsters within 320. Burrowers aggro without line of sight; dormant types (gargoyle, mimic) stay still until something comes within their wake range.
- **Leash:** outside wave maps, a monster dragged more than 1300 units from home gives up, walks home and heals fully.
- **Pathing:** a monster that sees its target walks straight at it. Otherwise it follows a flow field, a multi-source BFS from every targetable player and minion, rebuilt every 5 ticks.
- **Safe zone:** `isTargetable` is the one check both aggro and damage go through, so monsters lose their target at the town gate.
- **Rare and boss numbers:** bosses always roll 3 affixes, are 1.885x size (1.45 x 1.3) and get 9x base life (3x rare, 3x boss). Monster life grows 28% per level and damage 14% per level above 1.
- **Low-level fairness:** below level 5, spread shots fire one projectile and rares cannot roll Multishot. A fan of bullets from the first monsters a new character meets felt unfair.
- **Bosses never roll Regenerates.** Affixes are filtered after the roll, so a rare can end up with none.
- **Reflected projectiles** are capped at 12 damage and live 1.5 s; the reflect chance is the affix value (20% to 60% by tier).
- **Summons do not pay:** anything a monster summons drops no loot and gives a quarter of the XP. A shaman's raised corpse gives nothing at all (no XP, no loot, no Arena score), so a monster raised a second time cannot be farmed. Monsters split from a splitter pay in full.
- **Hero-model monsters** (ogre, bandit archer, pyromancer, tomb guard, grave priest, Butcher) are drawn through a shader that desaturates the texture and repaints it in the monster's tint. A plain colour multiply kept the texture's hue, so a Pyromancer looked exactly like a player Mage.

### Tuning overrides

- **Overrides are stored in SQLite and apply to new spawns in every room without a deploy.** Monsters already alive keep the numbers they spawned with. Values equal to the code default are dropped.
- **Export writes the changed types in the source format** of `data/enemies.ts` and `data/minions.ts` (plus model registry lines), ending with a reminder to reset them on the admin page once committed.
- **Editing needs the `settings` permission;** every staff role can look.
- **Ability patches store the ability's kind with its index,** so a later reorder in code drops a stale patch instead of applying it to the wrong ability.
- **XP overrides change XP only.** Arena score keeps the code value, so scores in a season stay comparable.
- **Models:** each type's model and height can be overridden. Clients get them in a small `models` message on join and when they change.
- **Model check reads a local `.glb` in the browser and never uploads it.** Real models are still committed to the repo.

## How

Code:

- Data: `packages/shared/src/data/enemies.ts` (`ENEMY_TYPE_IDS`, `MonsterDef`, the `monster()` helper, `ENEMY_AFFIX_TAGS`), pools and bosses in `data/monsterPools.ts` (`BIOMES`, `HABITATS`, `monsterPool`, `BOSSES`, `bossFor`, `packScale`, `rollPack`), enemy affixes in `data/affixes.ts`.
- AI: `packages/shared/src/sim/enemies.ts` (`spawnEnemy`, `pickTarget`, `alertPack`, `startAbility`, `updateWaves`), damage and `isTargetable` in `sim/combat.ts`, XP in `sim/progression.ts`.
- Numbers: `ENEMY_LEVEL`, `WILDS` (aggro, alert, leash), `NAV`, `WAVES`, `CURSE` in `packages/shared/src/config/sim.ts`.
- Tuning: `packages/shared/src/data/tuning.ts` (editable keys and limits, `normalizeEnemyOverride`, `MonsterTuning`), `apps/server/src/tuningStore.ts` (table `tuning_overrides`), `tuningRoutes.ts`, `liveTuning.ts`, and `retune` in `manager.ts`.
- Admin UI: `apps/client/src/admin/monsters/` (`TuningTab.tsx`, `exportText.ts`, `ModelCheckTab.tsx`, `modelChecks.ts`, `ModelStage.tsx`, `monsterViewer.ts`); try-ons in `apps/client/src/render/tryOn.ts`.
- Model files: `tools/blender/` is a headless Blender pipeline for fixing, rigging and animating a quadruped `.glb` (order, worked example and lessons in `tools/blender/README.md`); `pnpm model:check <file.glb> [--height N]` runs the Model check on a local file from the terminal (`scripts/model-check.ts`, through `admin/monsters/checkGlb.ts`) and exits non-zero on a warning.
- Rendering: model registry and the tint shader (`corruptMaterial`) in `apps/client/src/render/assets.ts`; procedural models in `render/models.ts`; corpses in `render/entities.ts`.

The ability and monster shapes:

```ts
interface AbilityBase { cooldown: number; range: number; windup: number; enragedOnly?: boolean }
// Ability kinds: slam, shoot, ring, blast, summon, charge, leap, explode, heal, raise, pool, blink
interface MonsterDef extends EnemyBase {
  behaviour: 'monster'; family: MonsterFamily; movement: Movement;
  preferredRange: number; abilities: readonly Ability[]; traits: MonsterTraits;
}
```

Movement kinds: melee, flank, ranged, kite, stationary, ghost, erratic, burrow, fly. Traits: frontal block, split into, death burst, enrage, burrow, knockback immune, contact element, dormant, curse (the mummy's aura cuts damage by 30% and lingers 0.6 s).

Formulas:

- Life: `base * (rare or boss ? 3 : 1) * (boss ? 3 : 1) * (1 + 0.28 * (level - 1)) * (1 + armored%)`.
- Damage: `1 + 0.14 * (level - 1)`.
- XP: `6 * level^1.35`, x4 rare, x18 boss, x0.25 summoned, times the type's `xp` override ([characters.md](characters.md)).

Invariants:

- The windup is the telegraph; an ability with windup 0 resolves at once.
- `monsterPool` never returns an empty list (it falls back to the Chaser).
- A tuning change builds a new `MonsterTuning`; live entities keep their definition.
- A stored override is validated again on load; one bad type is skipped, not all.

The browser tuner cannot edit traits, ability kinds, elements, summon targets, hazards, the enraged-only flag, or add, remove or reorder abilities; only numbers.

Model check runs 10 checks, all pass or warn:

| Check | Warns when |
|---|---|
| triangles | over 5000 |
| size | file over 3 MB |
| facing | not +Z (guessed from head-like part names, then glowing parts, then body shape) |
| feet | a part (a mesh node, whatever its materials) reaches more than 3% of the height below the rest, unless it holds most of the triangles |
| colours | an untextured, non-emissive material is near black (luminance under 0.01) |
| loops | idle, walk or run do not loop (position within 0.0005 of height, rotation within 0.5 degrees) |
| materials | a primitive has no material |
| roles | missing idle/walk/run, an attack, hit or death clip |
| rootMotion | walk or run travel more than 10% of the height |
| rig | no animations (otherwise it reports skinned or rigid) |

Try on stores the file in the browser's IndexedDB and tells an open game tab over a BroadcastChannel; nothing reaches the server.

### Procedural models

52 monster types (and the wraith minion) have no model file and are built from primitives in `apps/client/src/render/models.ts`, one builder per type. The KayKit types also fall back to them while their file loads.

**How a rig is built.** A builder places meshes (`G` geometry, `mat()` materials, from `render/rigs/parts.ts`) facing +x, feet at y = 0, at radius 1; entities scale it by the collision radius. Anything that moves hangs off a pivot group: `body`, `head`, `jaw`, `armL`/`armR`, `legL`/`legR` (limbs from `limb()`, which records their length), `tail`, and `extras` tagged with `extra(rig, node, kind)` (`leg`, `wing`, `tentacle`, `strand`, `flame`, `orbit`, `claw`, `segment`, `tongue`). Each builder passes a motion profile: `motion(gait, contact strike, death, weight, { ability, cast, shoot, dormant, burrows })`.

**How it is drawn.** `compiledRig()` (`render/rigs/compile.ts`) builds each type once and compiles it: every pivot becomes a bone, every part is bound rigidly to its bone, and colour, roughness, metalness and glow move into vertex attributes, so a monster draws as one skinned mesh (two when it has see-through parts). Copies share geometry and materials and own only their skeleton. The hit flash, ailment tints, rare glow and corpse darkening still work through the material (`entities.ts`), since the vertex glow adds on top of the material's emissive and goes out with a corpse's zero intensity.

**How it moves.** `driveRig()` (`render/rigs/motion.ts`) plays the KayKit roles from the same inputs, and `locomotionRole()` in `characters.ts` gives both the same walk and run thresholds:

- Base layer, crossfaded by weight (0.2 s, longer for heavy types): idle (breathing, looking around; hovering or flapping for fliers), walk and run, and dormant (a brooding head-down idle; the gargoyle crouches as a statue, the mimic sits shut).
- Legs cycle at the rate that carries the body at its actual ground speed: a stiff leg swung by `a` covers `4 L sin(a)` per cycle (0.6 of that for splayed insect legs), capped per gait so small legs slide rather than blur. The hip drops by `L (1 - cos)` so the planted foot stays on the ground.
- One-shots on top: a telegraphed ability holds its wind-up pose from the `tele` event until the `attack` event releases the strike; an attack with no telegraph plays a quick 0.08 s cock-back. Strike styles: bite, claw, slam, spit, cast, scream, shoot, charge, leap, sting, burst, pulse, chomp, ram. Awaken plays when a dormant monster notices you, spawn when a burrower surfaces.
- Hit is a 0.34 s additive flinch from the damage event. Death is per type (topple, roll, curl, collapse, crumble, dissolve, splat, fall, slump, tip); the body is raised just enough that its rotated rest box stays above the ground, and it stays down until the corpse goes. Ghosts and totems leave no body, so they dissolve for 1.2 s and are removed.

Gaits: biped, quad (trot, gallop at run), hop, scurry, skitter (alternating leg sets), crawl, fly, hover, float, slither (a wave down the segments), bounce (squash and stretch) and still.

**Adding one.** Write a builder in `models.ts` that returns a `Rig` from `emptyRig(motion(...))`, put moving parts on pivots and register extras with their kind, set `rig.legLength` if it walks, and add it to the `buildEnemy` switch. Check it in the dev tools' Monsters tab (`/admin/dev/#monsters/gallery/walk/day/<type>`), with `?raw` to compare against the uncompiled build; `apps/client/test/rigs.test.ts` covers every type automatically.

**Performance rules.**

- Never create geometry or materials per copy; builders use the shared `G` and `mat()`, and `compiledRig()` caches by type and colour.
- Nothing in `driveRig()` allocates: channels, weights and orbit angles are preallocated on the rig; pass a reused `RigDrive`.
- Off-screen rigs skip posing (`beginRigFrame(camera)` once per frame); their clocks still run. A corpse stops posing 3 s after it settles.
- Transparent parts use single-pass double-sided materials: the two-pass path sets `needsUpdate` twice per draw and rebuilt program parameters every frame.

Measured on the Monsters tab's bench (the game's `EntityRenderer` and `WorldScene` on a wilds map, 600-frame averages in headless Chrome on the development Mac, vsync at 60 Hz):

| 120 monsters | Before | After |
|---|---|---|
| Draw calls (world alone: 105) | 1560 | 250 |
| Render CPU per frame | 14.2 ms | 1.6 ms |
| EntityRenderer CPU per frame | 0.60 ms | 0.30 ms |
| JS heap growth per frame (world alone: about 45 KB) | 1.25 MB | 177 KB |
| Triangles | 1.48 M | 1.48 M |

With 240 monsters: 309 draw calls and 2.3 ms render CPU. With half of 120 off screen: 179 draw calls, 1.3 ms.

### Waves on test maps

The testground and sandbox-style maps keep the old wave spawner (`WAVES`), when the room's rules turn waves on (the builders' sandbox turns them off): the first wave 2 s after a player arrives, `min(36, 5 + 2(n-1))` monsters times `1 + 0.5` per extra player, the next wave 4 s after the last dies, spawning 380 to 900 units from players, rare chance 8% plus 2% a wave up to 35%, shooters from wave 2, spinners and the biome pools (cycling by wave) from wave 3, and monster level `1 + floor((n - 1) / 2)`. Every fifth wave adds the biome's boss. Waves do not reset when all players leave. The Arena uses its own numbers ([arena.md](arena.md)).

Tests:

- `packages/shared/test/monsters.test.ts`: every type runs 15 s without errors and deterministically; summon caps, splitting, wind-ups, dodging a slam, burrowed monsters cannot be hit, shielders block from the front, a shaman raises a corpse once, poison pools, boss enrage; every biome has monsters at levels 1 to 30, families appear by level.
- `packages/shared/test/monsters2.test.ts`: the second roster, 8 or more types per biome, biome bosses, blink, dormancy, mimics wake when hit, the mummy curse, flyers over water, one projectile below level 5, bosses never regenerate.
- `packages/shared/test/tuning.test.ts`: override validation, stale kinds dropped, overrides at spawn, XP scaled but Arena score untouched, living monsters unchanged, export format and round trip.
- `apps/server/test/tuning.test.ts`: permissions, validation, reset, live rooms pick up new spawns, `models` before `welcome`, overrides survive a restart.
- `apps/client/test/modelChecks.test.ts`, `modelOverrides.test.ts`: the checks flag a bad export; feet in their own material are not a stray part; a textured file checks in Node; a height-only override keeps the model swap.

## Limits and open questions

- The browser tuner cannot edit traits (enrage, burrow, curse) or non-number ability fields.
- The owner's brother's monster models: the dog needs facing, colours, loops and hit and death clips before it can be committed.
- Dungeon and zone monsters do not scale with party size; only waves do.
