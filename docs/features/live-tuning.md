# Live tuning

Status: phase 1 (shapes and runes) built 2026-10-01 on `feat/live-tuning`, not deployed. Phases 2 to 4 planned (owner, 2026-10-01).

"I want base damage settings for all runes, skills etc. All entities need to be able to be configured via API, deployless."

## What it does

Every gameplay number that matters for balance can be changed through the admin API and the admin page, and the change reaches running rooms and clients without a deploy or a restart. The defaults stay in code; the server stores only overrides.

## Scope (owner, 2026-10-01)

- **Shapes and runes:** base damage, speed, range, radius and duration of Bolt, Orb, Nova, Zone, Aura, Dash and Bond; each rune's Force cost, spirit and effect amounts (Split copies, Large, Concentrated, infusions and their burn, chill, shock and poison).
- **Starter skills:** each starter's own rune numbers (phase 2).
- **Monsters and minions:** monsters are tunable already (the admin Monsters tab); extend minions to everything (abilities, cooldowns, pack and Hound numbers) and add monster abilities and traits.
- **Players and loot:** class base stats, level scaling, the Force pool and its regen, drop rates, gold, affix roll ranges and prices.

## Decisions

- **Base numbers, not multipliers** (owner, 2026-10-01): "We don't want multipliers as much as we want just to change the base numbers." Tuning edits the real numbers (Bolt's damage 16, a rune's Force, a starter's own rolls), not a factor on top. The per-starter damage multiplier was built and reverted before it shipped; phase 2 makes each starter's own numbers tunable instead.
- **No balance guard** (owner): admins tune freely. The balance tests keep checking the code defaults only. The admin page may show numbers such as damage per Force for information, but never refuses a save.
- **History with rollback** (owner): every change is logged with who made it, when, the old and the new value; any change can be reverted with one click. One active set, no named profiles.
- **One registry:** a schema in `packages/shared` lists every tunable number with its path (for example `shape.bolt.damage`), category, label, default (read from the config), and a validated range. The API, the admin page and validation all come from it, so adding a number is one registry line.
- **Applied the same everywhere:** the server and every client apply the same overrides (sent with the welcome and on every change), so tooltips, the forge and prediction match the server. Replays record the overrides they ran with.
- **Monster tuning stays** as it is and is linked from the same admin page; it may move into the registry later.

## How (plan)

1. **Framework and shapes and runes** (built, below): the registry, storage (an overrides table and a history table in SQLite), the API (`GET /api/admin/tuning` for schema plus current values, `PATCH` for changes, `GET .../history`, `POST .../revert`), delivery to clients, the admin page (a dark table by category, search, the code default beside each value, reset to default per field, the history list with revert), and the first category: shapes and runes.
2. **Starters:** every starter's own rune numbers (each roll in its recipe) are tunable. A starter sigil that holds its starter's runes in order casts the live recipe numbers rather than the rolls stored on the item, so a tweak reaches every existing copy and never clamps them; the item keeps its stored rolls for prices and extraction.
3. **Minions and monster abilities and traits.**
4. **Players and loot.**

Each phase ships on its own. Loot and prices touch the economy, so phase 4 gets a fresh-eyes review for gold minting.

## How (phase 1, built)

**What is tunable (111 numbers).** Categories on the admin page:

- **Shapes:** every number of Bolt, Orb, Nova, Zone and Dash in `SPELL` (damage, speed, range, radius, duration, heal, shield, dash distance, ticks and hit radius).
- **Spell engine:** the rest of `SPELL`: split damage conserved, fan angle and ring offset, the Timer and Pulse default seconds (moved into `SPELL` as `timerSeconds` and `pulseSeconds`, so the parser reads them there), interval spray rotation, the live spell cap and its weights, the affix price steps, Impact knockback, Ward shield seconds, Frostfire bonus, Burning Ward damage, the doubled infusion bonus (moved from `compile.ts` into `SPELL.stackedInfusionBonus`).
- **Aura** (`AURA`) and **Bond** (`LINK`): radius, regen, ward reduction, element damage, push, regen cap; Bond's ranges, cone, regen, ward and element bonus.
- **Ailments** (`AILMENTS`): burn, chill, shock and poison numbers.
- **Force prices:** every castable rune's listed Force (`RUNE_FORCE`; Aura, Bond and Split left out since their listed Force is never read), Split per copy (`RUNE_PRICE.splitForcePerCopy`), and HEAT's pricing numbers: class and off-class multipliers, the payload shares, the least Force per cast, Force per affix step and the refund share. The Force bar, cooling, misfires and the global cost multiplier stay admin settings or phase 4.
- **Spirit prices:** each rune's spirit (`RUNE_SPIRIT`) and Concentrated's share of the rest of the aura (`RUNE_PRICE.concentratedSpiritShare`).
- **Rune effects:** Swift's speed and Large's size (`PLAIN_MODIFIER_EFFECT`), Concentrated's size loss and its damage without a roll (40 to 60, the range the rule accepts), and Split's copies without a count (2 to 6).

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

## Limits and open questions

- A change mid-fight applies on the next cast or spawn for what a spell stores when it spawns: a projectile's damage, speed and radius, a nova's or zone's size and duration. Nova, Zone and Dash damage, heal and shield, the ailment numbers, Impact knockback, Ward shield seconds and the aura and Bond numbers are read at hit time, so spells already alive feel those changes mid-flight.
- Tuning is global: every room and every world copy shares one set. Arena runs and dungeons in progress take a change on the next cast too.
- The forge's gold prices, rune drop and roll tables, starter recipes and the Force bar are not in phase 1; the cast cooldown, cost multiplier and Force bar stay on the Settings tab.
- Concentrated's 40 to 60% roll range is fixed (it must match the drop table in `data/affixes.ts`); only its default inside that range is tunable.
- Rune descriptions are hand-written text ("30% less size", "half a second"); they do not follow a change. The forge sentence and Force and spirit numbers do.
- A newer server's paths are dropped by an older client (and the reverse), so a mixed deploy shows defaults for the new numbers until the client reloads.
- The balance tests check code defaults only (owner: no balance guard). Nothing measures a tuned set; the admin page shows no damage per Force yet.
- Monster tuning stays in its own Monsters tab and tables; folding it into the registry is phase 3.
