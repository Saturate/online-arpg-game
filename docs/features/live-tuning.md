# Live tuning

Status: phase 1 (shapes and runes) built 2026-10-01 on `feat/live-tuning`, phase 2 (starters) built 2026-10-01 on `feat/tuning-starters`; neither deployed. Phases 3 and 4 planned (owner, 2026-10-01).

"I want base damage settings for all runes, skills etc. All entities need to be able to be configured via API, deployless."

## What it does

Every gameplay number that matters for balance can be changed through the admin API and the admin page, and the change reaches running rooms and clients without a deploy or a restart. The defaults stay in code; the server stores only overrides.

## Scope (owner, 2026-10-01)

- **Shapes and runes:** base damage, speed, range, radius and duration of Bolt, Orb, Nova, Zone, Aura, Dash and Bond; each rune's Force cost, spirit and effect amounts (Split copies, Large, Concentrated, infusions and their burn, chill, shock and poison).
- **Starter skills:** each starter's own rune numbers (phase 2).
- **Monsters and minions:** monsters are tunable already (the admin Monsters tab); extend minions to everything (abilities, cooldowns, pack and Hound numbers) and add monster abilities and traits.
- **Players and loot:** class base stats, level scaling, the Force pool and its regen, drop rates, gold, affix roll ranges and prices.

## Decisions

- **No starters as a special kind** (owner, 2026-10-01): "I don't really want starters, just a basic shape with runes in a sigil; balance is the runes and sigils, not a starter weird thing." Planned:
  - A class's first skills are ordinary sigils built from ordinary runes with rolls inside the drop tables (the kit recipe only says which runes and rolls a new character gets). No hand-set rolls beyond the tables, no special casting rule (`holdsStarterRecipe`/`castingSlots`/`castingStarter` go), no Skill balance group in tuning.
  - Existing characters' starter sigils keep their stored rolls as they are (owner): every sigil casts the rolls it holds; extraction still clamps, so a strong old roll never leaves its sigil at full strength.
  - Balance moves to the runes and sigils: rune affix roll ranges per tier and sigil affix ranges become tunable (Rune balance, a new Sigil balance), next to rune effects, Force and spirit prices and the base shapes.
  - **Flame Cleave's ring is full size** with the drawback roll gone (owner, 2026-10-01: fine).
  - **Six rune tiers** (owner, 2026-10-01): T1 is the best and rare, T6 the weakest and common (numbered like Path of Exile, the reverse of today's T1 to T3). T6 to T2 cover today's ranges from low to high, gated by item level; T1 sits above today's best ("super good"), rare even at the deepest levels. Tier weights, ranges and item-level gates are tunable in Rune balance. Existing runes are re-tiered by value on load (rolls never change, only the tier label and price).
  - Several first skills get weaker with table rolls; the first balance pass is done live in Rune balance and Base shapes, measured against today's numbers.

- **Tab names** (owner, 2026-10-01): the Tuning tab opens on **Skill balance** (each class skill's own numbers, paths `starter.*`), then **Rune balance**, Force prices, Spirit prices and **Base shapes** (the numbers every spell of a shape uses). Only labels and order changed; paths and stored values did not.

- **Base numbers, not multipliers** (owner, 2026-10-01): "We don't want multipliers as much as we want just to change the base numbers." Tuning edits the real numbers (Bolt's damage 16, a rune's Force, a starter's own rolls), not a factor on top. The per-starter damage multiplier was built and reverted before it shipped; phase 2 makes each starter's own numbers tunable instead.
- **The damage-per-Force cap is a report, not a limit** (owner, 2026-10-01): "Why even have a balance cap? Let runes be mods and spells base." The balance test fails only above 5x the best kit skill, to catch broken combinations; below that the balance bench shows each sigil's damage per Force and marks outliers. T1 rolls are no longer held to 2x and can be "super good" (the old hand-set starter values, such as +100% orb damage or pierce 4, as a guide).
- **No balance guard** (owner): admins tune freely. The balance tests keep checking the code defaults only. The admin page may show numbers such as damage per Force for information, but never refuses a save.
- **History with rollback** (owner): every change is logged with who made it, when, the old and the new value; any change can be reverted with one click. One active set, no named profiles.
- **One registry:** a schema in `packages/shared` lists every tunable number with its path (for example `shape.bolt.damage`), category, label, default (read from the config), and a validated range. The API, the admin page and validation all come from it, so adding a number is one registry line.
- **Applied the same everywhere:** the server and every client apply the same overrides (sent with the welcome and on every change), so tooltips, the forge and prediction match the server. Replays record the overrides they ran with.
- **Monster tuning stays** as it is and is linked from the same admin page; it may move into the registry later.

## Planned: the balance bench (owner, 2026-10-01)

"We need an overview of prebuilt sigils and how changes affect them, Spell Studio like."

- **Rows:** every class's kit skills, the hand-picked spells the balance tests measure, the 20 most-equipped sigils on live (read from saves), and admin picks (rune text typed in, saved server-side and shared between admins).
- **Columns:** Force, spirit, damage per Force single and pack, against the 2x line.
- **Preview:** while numbers are edited in the Tuning tab and not yet saved, every row shows before, after and the change in percent.
- **Watch one:** a row opens a Spell Studio view that casts the sigil at a dummy and a pack at the proposed numbers.

## How (plan)

1. **Framework and shapes and runes** (built, below): the registry, storage (an overrides table and a history table in SQLite), the API (`GET /api/admin/tuning` for schema plus current values, `PATCH` for changes, `GET .../history`, `POST .../revert`), delivery to clients, the admin page (a dark table by category, search, the code default beside each value, reset to default per field, the history list with revert), and the first category: shapes and runes.
2. **Starters** (built, below): every starter's own rune numbers (each roll in its recipe) are tunable. A starter sigil that holds its starter's runes in order casts the live recipe numbers rather than the rolls stored on the item, so a tweak reaches every existing copy and never clamps them; the item keeps its stored rolls for prices and extraction.
3. **Minions and monster abilities and traits.**
4. **Players and loot.**

Each phase ships on its own. Loot and prices touch the economy, so phase 4 gets a fresh-eyes review for gold minting.

## How (phase 1, built)

**What is tunable (111 numbers).** Categories on the admin page:

- **Base shapes:** every number of Bolt, Orb, Nova, Zone and Dash in `SPELL` (damage, speed, range, radius, duration, heal, shield, dash distance, ticks and hit radius).
- **Spell engine:** the rest of `SPELL`: split damage conserved, fan angle and ring offset, the Timer and Pulse default seconds (moved into `SPELL` as `timerSeconds` and `pulseSeconds`, so the parser reads them there), interval spray rotation, the live spell cap and its weights, the affix price steps, Impact knockback, Ward shield seconds, Frostfire bonus, Burning Ward damage, the doubled infusion bonus (moved from `compile.ts` into `SPELL.stackedInfusionBonus`).
- **Aura** (`AURA`) and **Bond** (`LINK`): radius, regen, ward reduction, element damage, push, regen cap; Bond's ranges, cone, regen, ward and element bonus.
- **Ailments** (`AILMENTS`): burn, chill, shock and poison numbers.
- **Force prices:** every castable rune's listed Force (`RUNE_FORCE`; Aura, Bond and Split left out since their listed Force is never read), Split per copy (`RUNE_PRICE.splitForcePerCopy`), and HEAT's pricing numbers: class and off-class multipliers, the payload shares, the least Force per cast, Force per affix step and the refund share. The Force bar, cooling, misfires and the global cost multiplier stay admin settings or phase 4.
- **Spirit prices:** each rune's spirit (`RUNE_SPIRIT`) and Concentrated's share of the rest of the aura (`RUNE_PRICE.concentratedSpiritShare`).
- **Rune balance** (was Rune effects): Swift's speed and Large's size (`PLAIN_MODIFIER_EFFECT`), Concentrated's size loss and its damage without a roll (40 to 60, the range the rule accepts), and Split's copies without a count (2 to 6).

**Registry** (`packages/shared/src/tuning/registry.ts`). Walks `SPELL`, `AURA`, `LINK` and `AILMENTS` for every number, so a field added later is tunable without a registry line; the Force, spirit and rune entries are listed. Each entry has a path (`spell.bolt.damage`, `force.rune.nova`, `bond.acquireRange`), category, label, the default read from the config when the module loads, min, max and an integer flag. Ranges are 0 to 10x the default (negative defaults the other way), with exceptions where a number breaks the engine: tick intervals and nova and zone durations at least one tick (0.05 s), Dash ticks 1 to 40 whole, speeds at least a tenth of the default, affix price steps above 1 (they divide a logarithm), slows and damage reductions at most 1, angles at most pi (2 pi for the spray rotation). The live spell caps guard the server rather than balance, so they are narrower: per caster 1 to 120 and per room 1 to 960 (3x), and each cap weight at least about a quarter of its default, so a room cannot be tuned into flooding the tick. No range is a balance guard.

**Mechanism: the config objects are overwritten in place.** `applyTunables(values)` sets every registered number back to its default and then writes each valid override (`Reflect.set` on the config object), so the sim, the compiler, the sentence and the tooltips read the live number where they always did, with no change to the code that reads them. Chosen over passing a tuning object through every call because the numbers are read in dozens of places across the sim, the compiler and the client, and in-place values cannot be missed by a caller that forgets to pass it. The same values always give the same numbers, whatever was applied before (reset first, then apply, in a sorted order). A value equal to the default is not kept as an override. One process holds one set, which matches the owner's "one active set"; every room on the server shares it.

**Derived values found and fixed:**

- The release affix price was a separate table (`RELEASE_FORCE`, 2 or 3 per kind); it now reads the matching trigger rune's Force (`RELEASE_RUNE` in `compile.ts`: after is Timer, every is Pulse), so the affix keeps costing what its rune costs.
- `DEFAULT_TIMER_SECONDS` and `DEFAULT_PULSE_SECONDS` duplicated `SPELL.timerSeconds` (which nothing read); the parser now reads `SPELL.timerSeconds` and `SPELL.pulseSeconds`.
- `SPLIT_FORCE_PER_COPY`, `CONCENTRATED_SPIRIT_SHARE` and `STACKED_INFUSION_BONUS` were module constants; now `RUNE_PRICE` and `SPELL.stackedInfusionBonus`.
- **Equipped sigils** hold their compiled program and Force price (`EquippedSigil.compiled`). On a change the room manager calls `recompileSigils` in every room, so the next cast pays and does the new numbers. A sigil that stops compiling (a lowered live cap, say) stays equipped as a dud, and its player gets a notice naming it and the rule it breaks.
- **The spirit pool:** lowering spirit prices, equipping more auras and raising the prices again would keep everyone over their pool. After a recompile, and when a character enters a room (`fitSpirit` in `Room.add`, for saves made before a change), persistent skills are unequipped from the last slot back until the reserved spirit fits, each with a notice. The sigil goes to the bag, or pending when the bag is full; it is never lost.
- **The entity budget's pulse peak** (`everyPeak` in `budget.ts`) counted every pair of volleys. A slow, long-lived pulsing shape (speed at its least, range at its most) has thousands of volleys, and one compile took about 580 ms on the game thread. It now walks the volleys once with a sliding window, with the same result, under 15 ms for the worst case the ranges allow.
- **The client's memoised compiles**: the skill bar slot and the forge editor memo on `useTunables().version`, the sigil tooltip subscribes to it, and the stash's sentence cache keys on `tunablesVersion()`.
- `DEFAULT_SIGIL_CONTEXT.forceMultiplier` copies `HEAT.costMultiplier` at load; that number is not tunable (the cost multiplier admin setting applies at cast time instead), so it stays.
- A test (`apps/server/test/tunableCopies.test.ts`) scans shared, server and client sources for a read of a tunable config that runs at module load (a top-level constant or destructuring, a class field, outside any function body), and fails naming the line.

**Storage** (`apps/server/src/tunablesStore.ts`): `tunable_values` (path, value, updated_at; one row per override) and `tunable_history` (id, path, old_value, new_value, account, token, at, revert_of; null means the code default). A change writes the values and its history rows in one transaction. Loading validates every row again and drops (and logs) one a range now refuses. The room manager applies the stored set in its constructor, before any room exists, so a restart keeps the overrides.

**API** (`apps/server/src/tunablesRoutes.ts`):

- `GET /api/admin/tuning`: `{ schema, values }`, the registry and the overrides in force. Any staff role.
- `PATCH /api/admin/tuning`: `{ "<path>": number | null }`. Validated all or nothing (unknown path, not a number, out of range, not whole: 400 and nothing changes). Only paths whose value changes get a history row. Logs one staff line (`tuning spell.bolt.damage 16 -> 20, force.rune.nova default -> 18`). Answers with the new state. Body up to 64 KiB, so a patch of every number fits. Needs `tuning`. If the change is stored and applied but reaching the rooms or clients fails, the reply is still 200, with a `warning`, and the error goes to the server log.
- `GET /api/admin/tuning/history?limit=`: newest first, 100 by default, at most 500.
- `POST /api/admin/tuning/revert` `{ "id": n }`: puts back the value from before that change (the default when it had none; a value equal to the default is stored as no override, as in a PATCH). Recorded as its own history row with `revertOf`. 404 for an unknown id, 409 when the value is already in place or the old value is outside today's range. Needs `tuning`.
- **Permission** `tuning` (`protocol/roles.ts`): owner and admin, and a token scope.
- **Rate limit:** 30 changes (PATCH or revert) a minute per account, since each one recompiles every equipped sigil and messages every client; past it, 429.

**Delivery.** Every welcome carries `tunables` (the overrides in force), and every change sends `{ t: 'tunables', values }` to every client in the game. The client checks the shape (`isTunableValues` in `isServerMessage`), then `receiveTunables` (`apps/client/src/game/tunables.ts`) drops unknown paths and out-of-range values and applies the rest with the same `applyTunables`, so tooltips, the forge, the stash sentences and local previews (forge preview, Spell Studio, VFX bench) match the server. A welcome without the field (an old replay) means code defaults.

**Replays** record the overrides they ran with: a recording's seed is the last welcome, then the newest tuning (from the welcome or a later change), and changes during the recording are recorded like every other message. Playing a replay applies its tuning; the next live welcome puts the server's back.

**Admin page** (`apps/client/src/admin/TunablesTab.tsx`, `tunables.css`): the Tuning tab. Categories on the left with a count of changed numbers, "Everything changed", a search over labels and paths; a compact table with the live value (editable), the code default, a `changed` badge on saved overrides, `unsaved` on edits, and reset per field; Save sends one PATCH of every edit, Discard drops them; out-of-range edits are marked and hold Save. On the right, the history with who, when, old and new, and revert per row.

**Tests:**

- `packages/shared/test/liveTuning.test.ts`: the registry covers every `SPELL`, `AURA`, `LINK` and `AILMENTS` number and every castable rune's Force, spirit and effect numbers, with unique paths and defaults equal to the config; ranges where zero would break; validation (all or nothing, null, ints, strings, NaN) and lenient parsing of stored and received values; apply and reset; determinism (the same overrides after others give identical damage); a change reaches the next cast (damage, radius, Force); derived values follow (release affix price, default Split count and Timer seconds, the live cap in the entity budget, doubled infusions, Large); `recompileSigils`; spirit fitting after a change and on load, the dud notice; a worst-case tuned compile stays under 15 ms.
- `apps/server/test/liveTuning.test.ts`: permissions per role and token scope; a bad patch changes nothing; a change reaches a running room's next cast (Fireball's orb radius and Force) and every client (the `tunables` message, and the welcome of a later join); reset returns the plain cast; history newest first with account and token; revert and its own history row, 409 and 404; overrides survive a restart and a stored value out of range is dropped; the write rate limit; a 200 with a warning when reaching the rooms fails; a revert to a default stored as a number; the notice for an aura a change unequips.
- `apps/server/test/tunableCopies.test.ts`: no module-level copy of a tunable number: constants, destructuring, class fields, and eager reads beside a function in the same statement (comments and strings ignored).
- `apps/client/test/tunables.test.ts`: the client applies a change to the numbers its tooltips compile from, drops bad entries, goes back to defaults on a welcome without tuning, and a recording carries the tuning.
- Every other test runs with no overrides and still checks the code defaults.

## How (phase 2, starters, built)

**What is tunable (28 numbers).** The Starters category, one group per starter (a heading row on the Tuning tab; `TunableSpec.group`), one row per roll in each recipe in `data/starterSigils.ts`: `starter.<id>.<rune index>.<key>`, for example `starter.bone_spear.0.damage` (Bone Spear's Bolt, +40% damage), `starter.bone_spear.0.pierce`, `starter.bone_spear.0.speed`, `starter.frozen_orb.0.every` (its 0.18 s pulse), `starter.fireball.2.after`, `starter.multishot.1.count`. Starters with no numbers (Iron Skin's `aura ward`, Exploding Arrow's `bolt[onhit] fire nova`) have no rows; an on-hit or on-land release has no number to tune. Defaults are the code recipe.

**Ranges.** Percentages (speed, size, duration, damage) from -90 to 10x the default's size (at least 100): -90 is where the engine's own floor (a tenth) sits, so a buff can be tuned into a drawback but never below what the engine runs. Pierce 0 to 10x, whole. Split copies 2 to 6, whole (the grammar's `SPLIT_COUNT_RANGE`). Release seconds from 0.1 (`MIN_RELEASE_SECONDS`) to 10x the default, at least 1. Concentrated, should a starter carry it, 40 to 60. Every starter compiles with all its numbers at their least or all at their most, with the shapes at theirs too, in under 15 ms; some mixes of ends do not, and the API refuses those (below).

**Mechanism.** `data/starterSigils.ts` keeps a live copy of each recipe (`liveStarterRunes`); the registry points each row at a number in that copy, so `applyTunables` overwrites it in place like every phase 1 number. `STARTER_SIGILS` keeps the code defaults: new starter sigils (the starter kit, drops, the v1 conversion, the rebuild of old Multishot and Flame Cleave) are always made with them, so tuning never changes what an item stores, sells for or extracts to.

**The starter rule** ([runes.md](runes.md), "The starter rule"). `holdsStarterRecipe` now matches rune ids, affix kinds and tiers, not exact values: the sigil's own `starter` names the starter, and its slots hold that starter's runes in order with the same count, each with the recipe's affix kinds for that rune and every roll at least the honest tier of the recipe's roll (`slotHoldsRecipeRune`, against the code-default recipe), no bench runes. The tooltip, skill bar, forge subtitle, stash filter and player notices name a sigil as its starter only when it holds (`castingStarter`); `matchingStarter` still compares rune ids only. The tooltip chips and the forge hover show each rune's rolls as the sigil casts them (`shownSlots`, the same as `castingSlots`): a whole starter's live numbers, or rolls clamped into the tables for an incomplete one, with the rune's own roll beside any that differ, for example `+300% damage (rune: +100% damage)` or `+55% damage (rune: +100% damage)`. Such a sigil casts the live recipe (`castingSlots` gives its slot items with the live rolls, at their honest tiers); anything else casts its stored rolls clamped, as before. The exact-roll match it replaces is why a retune used to need `OLD_STARTER_RUNES`; it no longer does, and the rebuild of the old Multishot and Flame Cleave recipes stays for saves from before.

**Where the live numbers show.** Everything that compiles a sigil goes through `castingSlots`, so the sentence, Force and cooldown follow at once in the tooltip, the forge readout and preview, the skill bar and the stash's sigil list (all already re-render on `useTunables().version` or key on `tunablesVersion()`). The rune chips in the sigil tooltip and the forge's slot hover show the live rolls for a whole starter (`shownSlots`); the forge's "taking this rune out weakens it" warning reads the stored rolls, since those are what come out. The Spell Studio opens a starter at its live recipe text, and a draft there casts its own numbers as written, so an edited roll is what the studio measures and exports (the game would cast the live recipe instead).

**Combinations that break a starter are refused.** Each number can be in range and the set still break a starter: Frozen Orb pulsing every 0.14 s with 5 shards passes the live cap. A PATCH or revert first compiles every starter at the proposed set (`starterTuningProblem` in `tuning/starterCheck.ts`) and answers 400 naming the starter and the rule, changing nothing. Of the 125 combinations of each starter's numbers at their ends, the check refuses exactly those that do not compile. This is a correctness guard, not a balance guard: a broken starter is a dud for everyone who owns it. Shape and engine numbers are checked the same way, since a change there (a lower live cap) can break a starter too; a non-starter player spell that stops compiling is still a dud with a notice, as in phase 1.

**Reaching play.** A change goes through the phase 1 path: `recompileSigils` in every room (the next cast), and the `tunables` message to every client.

**Exploits checked.**

- A sigil without that `starter` never gets starter numbers, even holding the same runes with the same rolls: a player-made `bolt[pierce 4, +50% speed, +40% damage]` casts clamped (pierce 3). `starter` is only set when a sigil is made as a starter; the forge keeps it on the sigil it edits and never sets it.
- A starter sigil names only its own starter, so it cannot borrow another's numbers by holding its runes.
- A starter with a rune appended, swapped, missing or reordered casts clamped and is untouched by a tweak. The forge redesign's appending rule is not built.
- Bench runes are free, so a starter refilled from the builders' bench casts them plain.
- **Swapping a starter's runes for cheaper ones casts clamped.** A starter's runes come out clamped but keep their tier (Static Nova's +50% size is T3), so if the sigil kept its numbers with any rune of the same affix kinds, a cheap `nova[+10% size]` would buy back the +50% one while the sigil kept casting; 12 of the 17 starters with rolls need only one-affix runes. Each slot's roll must be at least the honest tier of the recipe's roll, so a plain or lower-tier refill casts as itself, clamped, and a swap can at most move a roll within its tier. Every kit, drop and converted copy still matches, since they hold the recipe's own rolls.

**Tests:**

- `packages/shared/test/starterTuning.test.ts`: every roll of every starter recipe is in the registry under Starters, grouped by starter, at its code default, with the ranges above; every starter casts its stored rolls exactly at the defaults; every starter compiles fast at the ends of its ranges; a Bone Spear damage tweak reaches every copy without changing its stored rolls or its extraction, and shows in `shownSlots`; a copy made with other values in the same tiers casts the recipe; every starter refilled with plain runes casts them clamped; a refill with a found Bolt carrying pierce, speed and damage in their T3 ranges casts the recipe, and one a tier lower or an affix short does not; through the real forge (`sim.inscribe`), a Static Nova swapped for a +10% Nova casts clamped and gives back its +50% one, and a +40% Nova restores it; a tuned Bone Spear taken apart at the forge gives back its stored rolls clamped, not the live numbers; sell, buy and forge prices of every starter and its runes are the same at the top of every range; Frozen Orb's every 0.14 s with 5 shards is refused by name, and the check agrees with the compiler on all 125 end combinations and puts the overrides back; bench runes cast plain; a Bone Spear with a rune appended, a player-made Bolt with Bone Spear's rolls and a sigil naming another starter are untouched by the tweak; in a running simulation, after `recompileSigils`, the next Bone Spear hits for the tuned damage and a player-made Bolt for the same as before; old Multishot and Flame Cleave recipes still convert and then cast the live recipe; a roll on a shared tier end counts at its stored tier; `starterRunesOffRecipe` flags a bound Bone Spear rune of the recipe's kinds a tier low, and not a kit Nova moved from Static Nova into Fireball or an unbound find; an incomplete Fireball shows its Orb at the clamped +55% it casts.
- `apps/server/test/liveTuning.test.ts`: a PATCH of `starter.bone_spear.0.damage` changes a binder's next Bone Spear in a running room; a PATCH that breaks Frozen Orb is refused with 400 naming it and stores nothing, and so is a revert that would.
- `apps/client/test/tunables.test.ts`: a received starter change shows in the compiled Force, damage and sentence, in `shownSlots`, and in the Spell Studio's text and price, while the item keeps its rolls; an edited studio draft casts what it says; a chip shows the live roll with the rune's own beside it.
- `pnpm runes:convert-check` on a fresh copy of `rune.db.live-pre-batch-20261001` (no tuning stored): all checks passed; 87 starter sigils cast their live recipe, none clamped. The same on a fresh copy of `rune.db.live-pre-tuning-20261001`: no overrides stored, 127 sigils, 87 cast their live recipe, none clamped, no WARN, all checks passed.
- The balance tests (`skillParity`, `forcePerDamage` and the rest) are unchanged and pass at the code defaults.

## Limits and open questions

- A change mid-fight applies on the next cast or spawn for what a spell stores when it spawns: a projectile's damage, speed and radius, a nova's or zone's size and duration. Nova, Zone and Dash damage, heal and shield, the ailment numbers, Impact knockback, Ward shield seconds and the aura and Bond numbers are read at hit time, so spells already alive feel those changes mid-flight.
- Tuning is global: every room and every world copy shares one set. Arena runs and dungeons in progress take a change on the next cast too.
- Starters: a tuned starter's numbers are not checked against the balance tests (no balance guard); its Force still comes from the formula, so a stronger roll costs more Force. The admin page shows no damage per Force for a starter yet.
- Starters: overrides already stored are checked against the ranges on load, not compiled against the starters; a set stored before the starter check existed could still hold a broken mix. `pnpm runes:convert-check` compiles every starter at the database's stored overrides and fails on one.
- Starters: which runes a recipe holds is not tunable, only its numbers; a change to the runes is a code change with an `OLD_STARTER_RUNES` entry.
- Starters: rune and sigil prices follow the stored rolls (the code defaults), not the live numbers, by design.
- The forge's gold prices, rune drop and roll tables and the Force bar are not in phase 1 or 2; the cast cooldown, cost multiplier and Force bar stay on the Settings tab.
- Concentrated's 40 to 60% roll range is fixed (it must match the drop table in `data/affixes.ts`); only its default inside that range is tunable.
- Rune descriptions are hand-written text ("30% less size", "half a second"); they do not follow a change. The forge sentence and Force and spirit numbers do.
- A newer server's paths are dropped by an older client (and the reverse), so a mixed deploy shows defaults for the new numbers until the client reloads.
- The balance tests check code defaults only (owner: no balance guard). Nothing measures a tuned set; the admin page shows no damage per Force yet.
- Monster tuning stays in its own Monsters tab and tables; folding it into the registry is phase 3.
