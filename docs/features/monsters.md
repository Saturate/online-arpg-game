# Monsters

Status: Live. The roster since 2026-09-28 (two batches); the admin Monsters, Minions and Model check tabs were pushed to `main` on 2026-09-30 (merged as `feat/monster-browser` on 2026-09-29). The Charger and the `windup` clip role were built on 2026-10-01 (`feat/charger`), not yet deployed.

## What it does

- **70 monster types:** 3 originals with their own AI (Chaser, Shooter, Spinner) and 67 built on one generic AI: 60 regular monsters in 21 families and 7 bosses.
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

- **Two monsters are drawn from hand-made model files**, both the owner's brother's and rebuilt with `tools/blender/`: the **Grave Hound** (`grave_hound`, beast, flank; his dog) and the **Charger** (`charger`, charger, melee; a two-legged tadpole with a gaping maw). See their sections below.
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
- **Sleep:** idle monsters more than about 2000 units from every player and minion are not simulated at all until someone comes near ([world-streaming.md](world-streaming.md)).
- **Leash:** outside wave maps, a monster dragged more than 1300 units from home gives up, walks all the way home and heals fully. It takes no target for the first 3 s of the walk; after that a target in sight within its aggro radius, or a hit, turns it round ([world-streaming.md](world-streaming.md)).
- **Pathing:** a monster that sees its target walks straight at it. Otherwise it follows a flow field, a multi-source BFS from every targetable player and minion, rebuilt every 5 ticks.
- **Safe zone:** `isTargetable` is the one check both aggro and damage go through, so monsters lose their target at the town gate.
- **Rare and boss numbers:** bosses always roll 3 affixes, are 1.885x size (1.45 x 1.3) and get 4.5x base life (3x rare, 1.5x boss) and 2x damage, both boss factors admin settings (below). Monster life grows 28% per level and damage 14% per level above 1.
- **Low-level fairness:** below level 5, spread shots fire one projectile and rares cannot roll Multishot. A fan of bullets from the first monsters a new character meets felt unfair.
- **Boss tuning** (owner, 2026-10-01, built 2026-10-01, not yet deployed): "Bosses need less HP but more damage, so they are dangerous and you have to dodge attacks." Boss life is half what it was (4.5x base instead of 9x) and boss damage twice, as two admin settings, `bossLifeMultiplier` (1.5, on top of the rare 3x) and `bossDamageMultiplier` (2), each 0.5 to 10 ([accounts-admin.md](accounts-admin.md)). Every boss spawns through `spawnEnemy` with `boss: true` (region, gate, dungeon, Arena and the sandbox waves' every fifth wave), which reads them from `sim.rates.bossLife` and `sim.rates.bossDamage`. The rates go into the `Simulation` constructor (`new Room(..., tuning, rates)` in `RoomManager.createRoom`), since a map built whole, a dungeon above all, spawns its packs and its boss there, before `applySettings` runs. The damage factor is folded into the boss's `damageMult`, which every hit it deals already goes through: contact, slams, blasts, charges, leaps, projectiles, pools and poison from those hits, the death burst and the pool an exploder leaves (that pool was a flat 12 per second; it now scales with `damageMult` like the death burst's, so an exploder's pool also grows 14% a level). Its summons are not bosses and keep normal numbers. A change applies to bosses that spawn after it; a boss already alive keeps its life and damage, as monster tuning does. The client shows the life the snapshot carries, so nothing there computes it. The telegraphs stay as they are, since every big attack can already be dodged; a review in play should check that the doubled hits read in time, at night too.
- **Bosses never roll Regenerates.** Affixes are filtered after the roll, so a rare can end up with none.
- **Reflected projectiles** are capped at 12 damage and live 1.5 s; the reflect chance is the affix value (20% to 60% by tier). The cap applies to the shot's total, keeping the spell's mix of damage types.
- **Damage packets** (built 2026-10-02 on `feat/damage-packets`, not deployed; [runes.md](runes.md), "Damage packets"): every monster hit is a packet of damage types. The data keeps one number per attack; a hit is physical unless the attack, contact (`contactElement`) or death burst names an element, which then is the packet's type and still brings its ailment. Hazards deal their kind (fire, cold for frost ground, poison), poison stacks tick poison and burns tick fire. Nothing resists a type yet, so every number is as before; floating numbers on frost ground now read cold.
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
- Model files: `tools/blender/` is a headless Blender pipeline for fixing, rigging and animating a quadruped `.glb` (order, worked example and lessons in `tools/blender/README.md`); `pnpm model:check <file.glb> [--height N] [--static] [--floats]` runs the Model check on a local file from the terminal (`scripts/model-check.ts`, through `admin/monsters/checkGlb.ts`) and exits non-zero on a warning.
- Rendering: model registry and the tint shader (`corruptMaterial`) in `apps/client/src/render/assets.ts`; procedural models in `render/models.ts`; corpses in `render/entities.ts`.
- Scenery models (buildings, props, lights, graveyard and dungeon pieces) share the same registry; what was imported, what was left out and how they load is in [town.md](town.md#scenery-assets).

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

- Life: `base * (rare or boss ? 3 : 1) * (boss ? bossLifeMultiplier : 1) * (1 + 0.28 * (level - 1)) * (1 + armored%)`, the boss factor 1.5 by default.
- Damage: `(1 + 0.14 * (level - 1)) * (boss ? bossDamageMultiplier : 1)`, the boss factor 2 by default.
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
| facing | not +Z (guessed from the skeleton when there is one: toe bones point forward from the foot, or a head bone sits ahead of the hips; then parts named with a whole head word such as head, eye, jaw or horn, measured from the hips when there are any; then small glowing parts that are not sparks (`orbit`, `spark`, `ember` and the like); then body shape) |
| feet | a part (a mesh node, whatever its materials) reaches more than 3% of the height below the rest, unless it holds most of the triangles or the model is marked as floating |
| colours | an untextured, non-emissive material is near black (luminance under 0.01) |
| loops | idle, walk or run do not loop (position within 0.0005 of height, rotation within 0.5 degrees) |
| materials | a primitive has no material |
| roles | missing idle, walk or run (not for a model marked as never moving), an attack, hit or death clip |
| rootMotion | walk or run travel more than 10% of the height |
| rig | no animations (otherwise it reports skinned or rigid) |

Two flags say what the file cannot: **never moves** (`--static`; towers and totems need no walk or run) and **floats or burrows** (`--floats`; a wraith's hem or a worm's buried segments may hang below the rest, and the game stands that lowest part on the ground). The admin tab has them as checkboxes, cleared for each new file.

Try on stores the file in the browser's IndexedDB and tells an open game tab over a BroadcastChannel; nothing reaches the server.

### Grave Hound

- **Numbers:** life 95, move speed 115, radius 17, contact 10 every 0.9 s, colour `0x6a6e66`, XP by the level formula. One ability, a pounce (`leap`): cooldown 4.5 s, 140 to 400 units, 0.55 s telegraph, lands in a 58 radius for 22 damage over 0.55 s. Its bite and pounce poison (trait `poisonBite`, below). It sits between the Ghoul (85 life, leap 20) and the Hellhound (80 life, from level 5).
- **Why contact 10:** it bit 12 before the poison. At 10 every 0.9 s (11.1 DPS) plus three held poison stacks (3.6 DPS) it does 14.7, between the Dire Wolf's bite (12.9) and the Hellhound's bite plus burn (16), where 12 plus poison would have made it the hardest biter.
- **Where:** crypts and ruins from monster level 3 (`HABITATS`), so the Ashen Steppe (ruins, levels 4 to 6) and crypt dungeons. Beasts come in packs of 1.3x.
- **Model:** `apps/client/public/assets/monsters/grave_hound.glb`, asset `mon_grave_hound`, height 50 (93% of a hero, about 1 m at the shoulder), 394 triangles, 186 KB, clips Idle, Walk, Run, Attack, Hit and Death; `pnpm model:check --height 50` passes all 11 checks. It is the owner's brother's "Dog thing", made for this game only: it is not licensed for reuse, and no licence file goes with it.
- **Why 50 tall at 115:** the client plays the walk at speed / 110, so the authored walk must cover 110 units a second. At the 34 units of the pipeline's dog example (Dire Wolf size) that is 3.7 m/s for a 0.57 m leg, which only a gallop reaches. At 50 units and a trot lowered by 7.5 cm (`--walk-crouch 0.075`), a planted paw covers 0.47 m of model per step and the walk plays at 1.05x: 3.1 strides a second, a steady trot. The stock trot at the same size capped at 5.7 strides a second. The Run (190 units a second, a gallop) only shows mid-pounce, since the game runs only above 188 and even a Hasted rare tops out at 184.
- **Colours:** ashen grey coat (luminance 0.16), a paler bone-grey chest and muzzle (0.30 to 0.33) and green glowing eyes, so it reads as a grey shape by the hero's light at night. The first pass at 0.12 read as a black blot at night and was lifted.
- **While the file streams in** it draws as the procedural wolf at 1.2x bulk, so it never pops from a humanoid.
- **Rebuild:** the commands are in `tools/blender/README.md` ("The same dog as the Grave Hound"), with its palette and joints in `tools/blender/examples/grave_hound/`.

### Charger

Built 2026-10-01 on the owner's brother's `Charger.blend` / `Charger.glb` (delivered 2026-10-01; the originals stay outside the repo, untouched). Like the Grave Hound it is made for this game only: it is not licensed for reuse, and no licence file goes with it.

- **Numbers:** life 160, move speed 72, radius 26, contact 12 every 1.1 s, colour `0x5a5a48`, knockback immune, XP by the level formula. One ability, a line charge (`charge`): cooldown 5 s, used within 420 units (the dash's own length, so it never charges at someone it cannot reach) with the target in sight, 0.9 s telegraph, then 600 units a second for 0.7 s (a 420-unit line, 30 wide plus its body), 28 damage to everything it runs through once. Among the chargers it sits between the Horned Charger (150 life, 32 charge, from level 4) and the Hellspawn (170 life, 30 charge, from level 8); at level 6 it has 384 life.
- **Why so slow on foot:** its legs are short (hip to ankle about 0.5 m on a 2.2 m body). The client plays the walk at speed / 110, so the authored walk must cover 110 units a second; a heavy stride on those legs only gets there with a deep T-rex crouch, a pelvis yaw that swings each hip forward with its leg, and a big body (80 units, 1.48 heroes, near the Ogre's 84). At 72 the walk plays at 0.65x: 1.5 strides (3 heavy steps) a second. The slow approach is also the point: it lumbers in and the telegraphed charge is the threat.
- **Where:** marsh, ruins and forest from monster level 6 (`HABITATS`): the first regions out of town, Gloomvale, the Ashen Steppe and Thornwood, from about where they start (their bands begin at 5 to 6 on the reference seed). Not in crypts, caves, deserts or the meadow. Chargers come in packs of 0.5x.
- **Model:** `apps/client/public/assets/monsters/charger.glb`, asset `mon_charger`, height 80, 682 triangles, 241 KB, a skinned 17-bone rig, clips Idle, Walk, Run, Attack, Windup, Hit and Death; `pnpm model:check --height 80` passes all 11 checks.
- **What was fixed in the file:** the `.glb` held three things: the dev tools' export of the procedural `dire_wolf` (all 13 materials, 8 of them near black, and the Attack, Idle and Walk clips belonged to it), the earlier dog mesh, and the Charger itself (`Cube.001`, one mesh with a mirror modifier, no material, no animation). The template and the dog are dropped; the Charger mesh is kept as he made it (shape and proportions unchanged), welded, turned to face +Z, coloured and rigged, and every clip is new.
- **Colours:** an olive-brown hide (luminance 0.18) with a darker saddle along the back (0.12), a pale bone-yellow throat and belly (0.33) that wraps up the sides of the jaw, darker legs and feet, bone claws, a dark meat-red mouth and his own eye parts glowing ember orange (emission strength 0.35, rough and without specular). The game camera looks down on the back, so the back sets how it reads: a first pass at 0.09 read as a black blot even by day, a neutral grey read as the boulders around it, and eyes at strength 2.4 blew out to white dots: the game's ACES tone mapping at an exposure of about 1.5 turns a bright saturated glow white, so a coloured glow has to stay low.
- **Long body:** the collider (radius 26) covers only the head; four more hurt circles along the spine (`traits.body`: 45, 78, 104 and 126 units behind the centre, radius 32 down to 9, measured off the model) cover the trunk and tail. Projectiles, novas, zones, the dash spell, minion bites and the Hound Leader's pounce hit any of them, and an on-hit payload from a body hit goes off where the shot or the dasher struck, not at the far-off collider. Hovering or clicking the flank or tail picks it, and a melee hero walks to and swings at the nearest hurt circle (`sizeBody`, `withinHurt`, `hurtGap`, `bodyGap`, `nearestHurt` in `sim/body.ts`; `enemyBody` in the client's `render/characters.ts`). Movement, pathing and separation keep the single collider. Each Charger gets its body sized once at spawn (`EnemyComp.body`, null for every other type, so hit tests on them never look further than the collider): scaled by its radius over the code radius (a rare's is 1.45x) and by an admin height override over the 80 it was measured at, as the model is; an admin model override that replaces the Charger's file drops the body. Auras and death bursts still measure to the centre.
- **Turning:** the model turns about its middle (`traits.body.pivot`, 50 units behind the centre), not its collider: the drawn middle moves with the monster, holds while it only turns and eases back onto the sim's middle at 12 per second (the gap halves in about 0.06 s); a turn past 90 degrees, such as the reversal after a charge, snaps instead, so the drawn body and its hit circles never disagree for more than a few frames (`placeAboutPivot` in `render/entities.ts`). Turning about the collider swept the tail through walls. Only the model moves; the collider, bars and hit tests stay where the sim has them.
- **Collider centre:** its bulk and jaws reach far ahead of its legs, so the origin (where the collider sits) is 1.25 m ahead of the feet: the snout ends 28 units ahead of it, so at contact with a hero (26 + 14 = 40) it stops at the hero's front. Centred on the feet, and still at 0.95 m, the maw covered the hero in melee and through the telegraph.
- **Review:** a visual review by day and night (2026-10-01) found the first wind-up too close to idle, the maw covering the hero, white-hot eyes, a stride and tail wave too small to read from above, and a hide the grey of the rocks; all fixed as described here. Its size (about four hero lengths nose to tail) can read as tougher than its 160 life; left for the owner.
- **Movement** (owner: "Should move like a T-rex plus a tadpole"): the walk is a heavy two-legged stride, body pitched 8 degrees nose down with the head low and steady (chest and head counter the hips), a bob that bottoms out just after each footfall, roll toward the standing leg and an 8 degree pelvis yaw; the tail carries a wave that travels from the rump to the tip, each of its five bones a little later than the one before and swinging more toward the tip. The run is the charge: lower, thrust forward, longer strides with a flight phase and the tail lashing harder. The feet cannot keep up with a 600 charge (they carry about 270 units a second, so they slide about 2x); the run only shows during the last part of a dash, after the ram.
- **Telegraph pose:** a new optional clip role, `windup`, plays when the `tele` event arrives and is stretched to the telegraph's length, in two beats so the body telegraphs and not only the ground: it rears up with the maw wide, then drops back onto its haunches, coiled, head down, the tail raised and lashing and a foot scraping, and ends coiled as the charge goes (`windupCharacter` in `render/characters.ts`; the attack fades it out). Before, file models stood idle through a telegraph; models without a `Windup` clip still do. The Model check guesses the role from clip names containing "windup" or "telegraph".
- **Attack:** a ram: it rears back, steps in with the head down and the jaws gaping, snaps them shut and pulls back. It plays for contact bites and at the start of the charge (the `attack` event fires when the dash begins).
- **Death:** it rears with the jaws wide, the legs buckle and it rolls onto its right side, the tail lying out long; the clip keeps its lowest point on the ground every frame. The clips keep the jaw and tail off the ground too: the snout is far ahead of the hips, so where pitch and an open jaw would push it into the ground, `clips_biped.py` tips the chest up a degree at a time.
- **While the file streams in** it draws as a heavy hornless procedural quadruped (`quadruped`, bulk 1.4), so it never pops from a humanoid.
- **Rebuild:** `tools/blender/README.md` ("The Charger": `rig_biped.py`, `clips_biped.py`), with its palette and joints in `tools/blender/examples/charger/`.

### Poison

- **Poisoned** is a stacking damage over time (`AILMENTS.poison` in `config/sim.ts`): each bite adds a stack worth 12% of the hit per second and resets every stack to 4 s; at 3 stacks a new bite replaces the weakest stack if it is stronger. Stacks tick quietly (no numbers), each crediting its own source. It works the same on players, minions and monsters; a hit that does no damage (god mode, a shield soaking all of it) poisons nothing.
- **Who poisons:** the Grave Hound's bite and pounce, the Hound pack's packmates' bites and the pack Leader's pounce ([minions.md](minions.md)). The bite is physical and its stacks tick as poison damage, one of the damage packet's types; nothing resists it yet.
- **On the wire and on screen:** status flag `STATUS.poison` (256) in every entity snapshot, like burn, chill and shock. Medium and High draw bile green drops running off the body (0x7c9436 fading to 0x3a4a18) and a low murky mist (0x4a5a2c); the tint is a slow sickly pulse at the chill tint's weight, the only cue on Low (`vfx.status`, `applyTint` in `render/entities.ts`, [vfx.md](vfx.md)).
- Tests: `packages/shared/test/poison.test.ts` (stacking, refresh, the weakest giving way, ticking and wearing off on a monster, a player and a minion, the snapshot flag, the Grave Hound's bite).

### Procedural models

52 monster types (and the wraith minion) have no model file and are built from primitives in `apps/client/src/render/models.ts`, one builder per type. The KayKit types also fall back to them while their file loads.

**How a rig is built.** A builder places meshes (`G` geometry, `mat()` materials, from `render/rigs/parts.ts`) facing +x, feet at y = 0, at radius 1; entities scale it by the collision radius. Anything that moves hangs off a pivot group: `body`, `head`, `jaw`, `armL`/`armR`, `legL`/`legR` (limbs from `limb()`, which records their length), `tail`, and `extras` tagged with `extra(rig, node, kind)` (`leg`, `wing`, `tentacle`, `strand`, `flame`, `orbit`, `claw`, `segment`, `tongue`). Each builder passes a motion profile: `motion(gait, contact strike, death, weight, { ability, cast, shoot, dormant, burrows })`.

**How it is drawn.** `compiledRig()` (`render/rigs/compile.ts`) builds each type once and compiles it: every pivot becomes a bone, every part is bound rigidly to its bone, and colour, roughness, metalness and glow move into vertex attributes, so a monster draws as one skinned mesh (two when it has see-through parts). Copies share geometry and materials and own only their skeleton. The hit flash, ailment tints, rare glow and corpse darkening still work through the material (`entities.ts`), since the vertex glow adds on top of the material's emissive and goes out with a corpse's zero intensity.

**How it moves.** `driveRig()` (`render/rigs/motion.ts`) plays the KayKit roles from the same inputs, and `locomotionRole()` in `characters.ts` gives both the same walk and run thresholds:

- Base layer, crossfaded by weight (0.2 s, longer for heavy types): idle (breathing, looking around; hovering or flapping for fliers), walk and run, and dormant (a brooding head-down idle; the gargoyle crouches as a statue, the mimic sits shut).
- Legs cycle at the rate that carries the body at its actual ground speed: a stiff leg swung by `a` covers `4 L sin(a)` per cycle (for splayed insect legs, `L` is the foot's horizontal reach from the hip times the cosine of its fan angle), and a planted foot moves back at a constant speed through its stance. Each gait has a cycle cap so legs never blur; past it the swing grows up to 0.9 rad, then the stance shortens and the body flies between steps (a bound for bipeds, a gallop for quads), lifted by 0.08 L. Hoppers keep each foot down 12.5% of the cycle (25% for both). The hip height follows the least upright planted leg, a more upright planted leg and every swinging leg shorten (a knee bend from afar), legs undo the body's lean, and quadrupeds pitch so front and back feet are both down. The body pivots at its origin, so each hip's height is taken where the lean puts it (`hipShift`): a hip set back or ahead of the middle rises or sinks with the pitch. `apps/client/test/rigCover.test.ts` checks every fast walker and hopper: planted feet move at 0.8 to 1.2 of the ground speed, rise or sink less than 12% of the leg through the stance, and sit within 4% of a leg of the ground.
- The bog lurker does not walk: it slides on its belly with its legs splayed and paddling.
- One-shots on top: a telegraphed ability holds its wind-up pose from the `tele` event until the `attack` event releases the strike; an attack with no telegraph plays a quick 0.08 s cock-back. Strike styles: bite, claw, slam, spit, cast, scream, shoot, charge, leap, sting, burst, pulse, chomp, ram. Awaken plays when a dormant monster notices you, spawn when a burrower surfaces.
- Hit is a 0.34 s additive flinch from the damage event: 0.22 rad back and a 0.12 knockback. Death is per type (topple, roll, curl, collapse, crumble, dissolve, splat, fall, slump, tip); the body is raised just enough that its rotated rest box stays above the ground, and it stays down until the corpse goes. Ghosts and totems leave no body, so they dissolve for 1.2 s and are removed.

Gaits: biped, quad (trot, gallop at run), hop, scurry, skitter (alternating leg sets), crawl (belly slide), fly, hover, float, slither (a wave down the segments), bounce (squash and stretch) and still.

Death details: roll deaths turn about the body's middle, not the feet, so the corpse lands on its side where it stood, legs drawn in toward the belly; topple and collapse arm targets are absolute, so an arm held out at rest (the mummy's) falls like the other.

Model conventions:

- **No high metalness.** There is no environment map, so metal above about 0.2 renders near black even by day. Iron, bands and blades use metal 0.2 and roughness 0.45 to 0.65.
- **Insect legs** splay about x with `-side` outward and use Euler order `YXZ`, so the fan and the stride both turn about the vertical and a planted foot keeps its height. Spider legs have a knee (`userData.foot` marks the tip). Bones copy the node's Euler order, since the animator adds Euler offsets.
- **Every group compiles to a bone.** Static bends (the mummy's elbows, spider knees, feather fans) are placed as rotated meshes (`strut`, `tri` in `rigs/parts.ts`) rather than on their own groups.
- **Colours per type** can differ from the data colour (`packages/shared/src/data/enemies.ts` stays the minimap and UI colour): slimes, imps, volatiles, the harpy, the cultist, the hellhound and the iron golem set their own muted colours in `models.ts`. Minions are tinted green like the other bound minions, so the minion wraith never reads as the blue enemy wraith.
- The capsule geometry is its length plus two radii long; the wolf's body was three times the intended length and swallowed the head.

**Adding one.** Write a builder in `models.ts` that returns a `Rig` from `emptyRig(motion(...))`, put moving parts on pivots and register extras with their kind, set `rig.legLength` if it walks, and add it to the `buildEnemy` switch. Check it in the dev tools' Monsters tab (`/admin/dev/#monsters/gallery/walk/day/<type>`), with `?raw` to compare against the uncompiled build; The gallery's night uses the game's night numbers at the admin defaults, the hero's light radius and the enemy moonlight rim, and a death view follows the middle of the fallen body. `window.rigGallery.seek(s)` freezes a moment for screenshots (the hit flinch peaks at about 0.15 s, 0.05 s after the hit event at 0.1 s); `apps/client/test/rigs.test.ts` covers every type automatically.

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

After the 2026-09-30 model review (wings, knees, cracks, the gallop), 120 monsters still draw in 248 calls, the same as before it, with 1.49 M triangles (+1%). A node micro-bench of `driveRig` over the same 120 rigs measured the same CPU before and after within noise (0.23 to 0.50 ms a frame, other work running on the machine).

### Waves on test maps

The testground and sandbox-style maps keep the old wave spawner (`WAVES`), when the room's rules turn waves on (the builders' sandbox turns them off): the first wave 2 s after a player arrives, `min(36, 5 + 2(n-1))` monsters times `1 + 0.5` per extra player, the next wave 4 s after the last dies, spawning 380 to 900 units from players, rare chance 8% plus 2% a wave up to 35%, shooters from wave 2, spinners and the biome pools (cycling by wave) from wave 3, and monster level `1 + floor((n - 1) / 2)`. Every fifth wave adds the biome's boss. Waves do not reset when all players leave. The Arena uses its own numbers ([arena.md](arena.md)).

Tests:

- `packages/shared/test/damagePackets.test.ts`: monster contact is physical, an elemental monster's touch is its element with its ailment, death bursts and the hazards they leave deal their element, reflected spells keep their mix capped on the total.
- `packages/shared/test/monsters.test.ts`: every type runs 15 s without errors and deterministically; summon caps, splitting, wind-ups, dodging a slam, burrowed monsters cannot be hit, shielders block from the front, a shaman raises a corpse once, poison pools, boss enrage; boss tuning (4.5x base life and 2x damage by default against a rare's 3x and 1x, changed rates reach bosses that spawn after and not the living, a boss's first hit is twice the same rare's, the settings' range); every biome has monsters at levels 1 to 30, families appear by level.
- `packages/shared/test/poison.test.ts`: poison stacks, ticks and wears off on every kind of target; the Grave Hound's bite poisons.
- `packages/shared/test/monsters2.test.ts`: the second roster, 8 or more types per biome, the Grave Hound's zones and pounce, the Charger's zones, a deterministic 15 s fight, its charge as a telegraphed line that hits a hero who stands for one charge hit and misses one who steps aside, its range equal to its dash, bolts at its flank and tail hitting on whichever side its body lies, and its body growing with a rare, biome bosses, blink, dormancy, mimics wake when hit, the mummy curse, flyers over water, one projectile below level 5, bosses never regenerate.
- `packages/shared/test/tuning.test.ts`: override validation, stale kinds dropped, overrides at spawn, XP scaled but Arena score untouched, living monsters unchanged, export format and round trip.
- `apps/server/test/tuning.test.ts`: permissions, validation, reset, live rooms pick up new spawns, `models` before `welcome`, overrides survive a restart.
- `packages/shared/test/longBody.test.ts`: a long body grows with a rare and a height override and goes with another model; the nearest hurt circle; a bolt's on-hit nova goes off where it struck the tail.
- `apps/client/test/windup.test.ts`: the wind-up stretches to the telegraph, holds its coiled frame until the attack (and lets go after a grace if none comes); a model without one is left alone. `apps/server/test/static.test.ts`: monster files revalidate by ETag and date with 304s, hashed bundles stay immutable, judged on the file served.
- `apps/client/test/modelChecks.test.ts`, `modelOverrides.test.ts`: the checks flag a bad export; feet in their own material are not a stray part; a textured file checks in Node; head parts match whole words (no horn in thorn_beast); a glowing body or sparks are not eyes; the static and floats flags; every KayKit hero and skeleton in `public/assets/kaykit/` faces +Z; a height-only override keeps the model swap.

## Limits and open questions

- The browser tuner cannot edit traits (enrage, burrow, curse) or non-number ability fields.
- **Model files under fixed names now revalidate.** The static server marked all of `/assets/` immutable for a year, which suits Vite's hashed bundles but not `assets/monsters/` (or `assets/kaykit/`, already excluded), which keep their names: a fixed model would never reach a browser that had the old one. `/assets/monsters/` is now `no-cache` too, with a weak ETag from size and modification time and a Last-Modified date, so an unchanged file costs a 304 and no body (`hashedAsset`, `weakEtag`, `notModified` in `apps/server/src/static.ts`; the rule is judged on the file served, after `..` and doubled slashes are resolved). A browser that cached a monster file before this deploy keeps that copy until it clears its cache; only the Grave Hound shipped before it.
- Poison drops are small at game zoom: by day the tint reads, at night mostly the mist; a visual review may want them larger.
- The Grave Hound's walk still slides about 1% (half-stride 0.235 m against a 0.232 m reach) and its run about 3%.
- A Charger keeps the body it spawned with when an admin changes its model or height, while clients size it from the current override; they agree again for every Charger that spawns after.
- The nav grid plans for a 14-unit agent, so the Charger (radius 26) (`NAV.agentRadius`) can be routed into gaps it cannot fit, where the collision against the walls holds it. Its long body can also stand partly inside scenery when it turns in a tight spot, since only the collider is kept out of walls.
- Like every charger, the dash checks walls only at its own centre each half step, so the 30-wide line (plus its body) reaches past thin walls and fence corners that the centre slips beside.
- The Charger's walk stretches its legs about 3% past straight on 2 of 13 frames (a centimetre of slide), and its run slides about 2x against a 600 charge; it shows only for the end of a dash.
- Only the Charger has a `windup` clip; the KayKit models and the Grave Hound still stand idle through their telegraphs. File models never play their Hit clip in game (only procedural rigs flinch); the clip is there for the Model check and the viewers.
- "Past the first gate" in the plan read as the first regions out of town, since the gates themselves sit at levels 12 to 17; if the owner meant the regions behind the gates (the Hollows, the Dunes, Deep Thornwood), the Charger's `HABITATS` entry needs `cave` and `desert` and a higher level.
- Dungeon and zone monsters do not scale with party size; only waves do.
