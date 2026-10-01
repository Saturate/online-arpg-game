# Live tuning

Status: phase 1 (shapes and runes) and phase 2 (starters) built and deployed 2026-10-01. Phase 2 was replaced the same day by "no starters as a special kind" with tunable affix ranges (built on `feat/no-starters`, not deployed). The balance bench built on `feat/balance-bench` (not deployed). Phases 3 and 4 planned (owner, 2026-10-01).

"I want base damage settings for all runes, skills etc. All entities need to be able to be configured via API, deployless."

## What it does

Every gameplay number that matters for balance can be changed through the admin API and the admin page, and the change reaches running rooms and clients without a deploy or a restart. The defaults stay in code; the server stores only overrides.

## Scope (owner, 2026-10-01)

- **Shapes and runes:** base damage, speed, range, radius and duration of Bolt, Orb, Nova, Zone, Aura, Dash and Bond; each rune's Force cost, spirit and effect amounts (Split copies, Large, Concentrated, infusions and their burn, chill, shock and poison).
- **Starter skills:** each starter's own rune numbers (phase 2, replaced: kits are ordinary sigils, and balance is the rune and sigil affix ranges).
- **Monsters and minions:** monsters are tunable already (the admin Monsters tab); extend minions to everything (abilities, cooldowns, pack and Hound numbers) and add monster abilities and traits.
- **Players and loot:** class base stats, level scaling, the Force pool and its regen, drop rates, gold, affix roll ranges and prices.

## Decisions

- **No starters as a special kind** (owner, 2026-10-01): "I don't really want starters, just a basic shape with runes in a sigil; balance is the runes and sigils, not a starter weird thing." Built (below, "Kit sigils and affix ranges"):
  - A class's first skills are ordinary sigils built from ordinary runes with rolls inside the drop tables (the kit recipe only says which runes and rolls a new character gets). No hand-set rolls beyond the tables, no special casting rule (`holdsStarterRecipe`/`castingSlots`/`castingStarter` go), no Skill balance group in tuning.
  - Existing characters' starter sigils keep their stored rolls as they are (owner): every sigil casts the rolls it holds; extraction still clamps, so a strong old roll never leaves its sigil at full strength.
  - Balance moves to the runes and sigils: rune affix roll ranges per tier and sigil affix ranges become tunable (Rune balance, a new Sigil balance), next to rune effects, Force and spirit prices and the base shapes.
  - **Flame Cleave's ring is full size** with the drawback roll gone (owner, 2026-10-01: fine).
  - **Six rune tiers** (owner, 2026-10-01): T1 is the best and rare, T6 the weakest and common (numbered like Path of Exile, the reverse of today's T1 to T3). T6 to T2 cover today's ranges from low to high, gated by item level; T1 sits above today's best ("super good"), rare even at the deepest levels. Tier weights, ranges and item-level gates are tunable in Rune balance. Existing runes are re-tiered by value on load (rolls never change, only the tier label and price).
  - Several first skills get weaker with table rolls; the first balance pass is done live in Rune balance and Base shapes, measured against today's numbers.

- **Tab names** (owner, 2026-10-01): the Tuning tab opens on **Rune balance** (rune effects and every rune affix tier), then **Sigil balance** (every sigil affix tier), Force prices, Spirit prices, **Base shapes** (the numbers every spell of a shape uses), then the rest. The Skill balance group (`starter.*`) is gone with the starter rule; the live server stored no override under it, and a stored `starter.*` row would be dropped without a report on load.

- **Base numbers, not multipliers** (owner, 2026-10-01): "We don't want multipliers as much as we want just to change the base numbers." Tuning edits the real numbers (Bolt's damage 16, a rune's Force, an affix tier's range), not a factor on top. The per-starter damage multiplier was built and reverted before it shipped.
- **The damage-per-Force cap is a report, not a limit** (owner, 2026-10-01): "Why even have a balance cap? Let runes be mods and spells base." The balance test fails only above 5x the best kit skill, to catch broken combinations; below that the balance bench shows each sigil's damage per Force and marks outliers. T1 rolls are no longer held to 2x and can be "super good" (the old hand-set starter values, such as +100% orb damage or pierce 4, as a guide).
- **No balance guard** (owner): admins tune freely. The balance tests keep checking the code defaults only. The admin page may show numbers such as damage per Force for information, but never refuses a save.
- **History with rollback** (owner): every change is logged with who made it, when, the old and the new value; any change can be reverted with one click. One active set, no named profiles.
- **One registry:** a schema in `packages/shared` lists every tunable number with its path (for example `shape.bolt.damage`), category, label, default (read from the config), and a validated range. The API, the admin page and validation all come from it, so adding a number is one registry line.
- **Applied the same everywhere:** the server and every client apply the same overrides (sent with the welcome and on every change), so tooltips, the forge and prediction match the server. Replays record the overrides they ran with.
- **Monster tuning stays** as it is and is linked from the same admin page; it may move into the registry later.

## The balance bench (owner, 2026-10-01; built on `feat/balance-bench`, not deployed)

"We need an overview of prebuilt sigils and how changes affect them, Spell Studio like."

The **Balance bench** tab on the admin page, next to Tuning.

- **Rows:** every class's kit sigils (made the way a new character gets them, clamped into the live tables), the 76 hand-picked spells of the balance test (`BALANCE_SPELLS`, one list for the test and the bench), the 20 sigils most equipped in the saves, and admin picks.
- **Columns:** Force per cast (spirit for an aura or Bond), damage per Force to one target and to a pack of six as a multiple of the best kit under the same numbers (with the raw damage per Force beneath), a mark above 2x (soft, gold) and above 5x (hard, red: where the balance test fails), and while previewing the row's own largest change. Every column sorts; rows filter by source, class, rune text, "past 2x only" and "changed only".
- **Preview:** edits typed in the Tuning tab and not saved stay when the tab is switched (they live in a small store, `admin/tuningDraft.ts`, instead of the tab's state). The bench measures every row under the saved set and under the saved set plus the edits, and shows saved → with the edits and the change in percent. Nothing is sent to the server until Save in the Tuning tab. An edit that leaves an affix table out of order or overlapping (which a Save would refuse) is not previewed: that table keeps its saved numbers and a notice says why.
- **Stale drafts:** an edit equal to the saved value is no edit and is dropped. Each edit remembers the saved value it was made against; whenever the Tuning tab or the bench reads the saved values again, an edit whose saved value has changed since (another admin saved it) is dropped with a notice naming it, so a stale draft cannot put back a number someone else has saved.
- **Watch one:** a row's Watch opens two Spell Studio stages, the sigil cast at one dummy and at a pack of six, under the proposed numbers or the saved ones (a toggle). It casts at the bench's 0.35 s cadence while Force is under the bar (the studio's new "Under bar" cast mode), like the harness. Its counts are the studio's own running ones (damage from hit events, the whole run so far), so they sit near the bench's 10 s figure, not on it.
- **Admin picks:** rune text typed in, checked as typed with the same check the server runs (the grammar reads it, every number is a roll some rune item can have, inside its affix's live drop table over all tiers and on a rune that rolls it, and the compiler casts it on that class at that multicast), stored as the grammar writes it back (two spellings are one pick), shared between admins with the account that added it and when. Up to 200. Removing one asks first.
- **Most equipped:** counted on the server from every character's save, by rune text and multicast, each character counting a sigil once, measured on the class most of its holders play. Only rune text, class and a count leave the server; no player or character name, and no token name on picks.

**Why:** the owner tunes base numbers live ("base numbers, not multipliers") and the cap is a report, so the admins need to see what a change does to the spells that matter before saving it.

### How

- **One harness.** `packages/shared/src/bench/` holds the harness the parity and balance tests use (`skillDps.ts`, moved from `test/harness`), the spell list (`spells.ts`) and the bench's pieces (`bench.ts`: `measureBenchSpec`, `bestKit`, `benchMark`, `checkBenchSpell`, `mostEquipped`, `BENCH_MARKS`). `measureRate` runs only the two sustained runs of `measureSkill` (one target and pack, 10 s each), with Force read from the first cast; it is tested to give the same Force, casts, kind and damage per Force as `measureSkill` for every kit and every hand-picked spell.
- **Speed.** The harness skips the enemies' path field: its dummies are pinned with no speed, so the field moved nobody, and it was over half of every measurement (every number of every kit and hand-picked spell is unchanged, checked against a snapshot of the old harness). A row now measures in about 3 ms (2.3 to 2.6 ms in the browser), so a full bench of 117 rows takes about 0.3 s per tuning set.
- **The worker.** `applyTunables` overwrites the config in place, so the bench measures in its own worker (`admin/bench/measure.worker.ts`), where a proposed set never touches the page's numbers. Results are cached by tuning set (its sorted paths and values) and rune text, so a spell listed by two sources measures once and going back to an earlier edit costs nothing. Edits are debounced 250 ms; each new job replaces the worker's queue and runs one row per task, kits first, so a newer edit is picked up between rows. Results reach the table once per frame.
- **Watch** runs on the page itself: it applies the chosen set while open and puts the code defaults back on close; nothing else on the admin page reads those numbers.
- **Server** (`apps/server/src/benchStore.ts`, `benchRoutes.ts`): a `bench_picks` table (text, class, multicast, account, token, at; unique on the first three; the token's name is kept for the record but never sent). The most-equipped count is an in-memory tally per character (`EquippedTally` in shared): `AccountStore.saveCharacter` hands over the save it is writing and `deleteCharacter` and the idle-guest sweep remove theirs, so answering the bench parses nothing (parsing every save took 56 to 343 ms for 3000 saves on the game thread). At boot the stored saves are counted once in steps of 50 by id with a yield between steps (`seed`); a character saved or deleted meanwhile is already current and its row is skipped. Until that finishes the reply says `popularReady: false` and the page says the list is still filling in.

| Method | Route | Needs | Reply |
|---|---|---|---|
| GET | `/api/admin/bench` | `viewAdmin` | `{ picks, popular, popularAt, popularReady }` |
| POST | `/api/admin/bench/picks` | `tuning` | `{ text, classId, multicast? }`; 201 with the pick, 400 for text the grammar or compiler refuses, 409 for a duplicate or a full bench |
| DELETE | `/api/admin/bench/picks/<id>` | `tuning` | 200, or 404 |

Writes have their own limit (20 a minute per account, apart from tuning changes), spent only by a write that passed its checks, so a refused typo costs nothing; they are in the staff log. Tokens need the `tuning` scope to write.

### Tests

- `packages/shared/test/balanceBench.test.ts`: the bench's rate measurement matches the full harness for every kit and every hand-picked spell; the best kit is 2.13 single and 7.71 pack as the balance test reports; an applied override moves a row and resetting brings it back; the marks; a spell that does not cast reports rather than throws; every row measures in under 40 ms (about 3; skipped when `CI` is set, as wall-clock bounds flake on shared runners); picks normalised and bad ones refused, rolls past the drop tables refused in the grammar's words, every kit accepted (two balance-test probes faster than any roll are refused); the tally follows saves and deletes; most equipped counts each character once, most first, skips old and unreadable saves and carries no names.
- `apps/client/test/balanceBench.test.ts`: a proposed override shows in the after numbers without saving or changing the saved set; the cache by set and text; pending edits out of range left out; an edit equal to the saved value dropped; the ghost revert (an edit overtaken by another admin's save is dropped on the next read, so Save sends nothing for it); a half-set affix table kept at its saved numbers with a reason; rows from every source; the best kit and marks; sorting with unmeasured rows last and every filter; the worker message checks; only the worker's measurer and the Watch panel apply tuning sets (a source scan), the worker answering a job row by row; Watch putting the code defaults back; a full bench measures in a few ms a row (skipped on CI).
- `apps/server/test/balanceBench.test.ts`: every staff role sees the bench and a player gets 404; the most-equipped list by count without names; only the `tuning` permission and token scope add and remove picks, and picks carry no token name; grammar and drop-table checks, normalising, duplicates and sharing between admins; picks survive a restart; the tally follows saves and deletes; the boot count in steps skips characters already updated and runs once; the bench answers without parsing a save; the write limit counts only writes that pass their checks and is apart from tuning. `adminTokens.test.ts` has both routes in the per-scope check.

### Limits and open questions

- Most equipped sigils are measured on a plain sigil of their class: the holder's own sigil affixes (reduced Force cost, more damage) are not counted, only multicast. Kits on old characters keep their hand-set rolls, so an old kit shows as its own row there.
- The count follows saves, not live sessions, so a sigil equipped since the last autosave is not counted yet. A save written inside a transaction that then rolls back is still counted until that character's next save.
- The bench measures at the 0.35 s v1 cadence like the tests, not the live cast cooldown.
- An edit out of range in the Tuning tab is left out of the preview (the bench says how many).
- The multiples are against the best kit under the same numbers, so an edit that weakens the best kit moves every row's multiple; the "own change" column shows only the row's own numbers.

## How (plan)

1. **Framework and shapes and runes** (built, below): the registry, storage (an overrides table and a history table in SQLite), the API (`GET /api/admin/tuning` for schema plus current values, `PATCH` for changes, `GET .../history`, `POST .../revert`), delivery to clients, the admin page (a dark table by category, search, the code default beside each value, reset to default per field, the history list with revert), and the first category: shapes and runes.
2. **Starters** (built and deployed, then replaced the same day): every starter's own rune numbers were tunable and a whole starter cast them. Replaced by **kit sigils and affix ranges** (below): kits are ordinary sigils, and the rune and sigil affix tables are tunable.
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

## How (kit sigils and affix ranges, built)

**No starter rule.** Every sigil casts the rolls its runes store, as stored; `holdsStarterRecipe`, `castingSlots`, `castingStarter`, `liveStarterRunes`, the starter tuning check and the 28 `starter.*` numbers are gone. Each class's kit is an ordinary sigil whose recipe holds in-table rolls below T1, clamped into the live table when it is made ([runes.md](runes.md), "Kit sigils"). Old kit sigils keep their stored rolls; extraction clamps them as before. The Spell Studio opens a kit at its recipe and casts a draft as written.

**What is tunable (248 numbers).**

- **Rune balance**, after the rune effects: every rune affix tier's lowest and highest roll, and for the six-tier affixes (speed, size, duration, damage, pierce, split count, Concentrated's amount, every X s) its drop weight and least item level, one group per affix. Paths name the tier as players read it, from the best: `affix.rune_damage.t1.max`, `affix.release_every.t6.min`, `affix.rune_pierce.t3.ilvl`. The release flags (on hit, on expire, on landing) carry no number and are left out; "after X s" has its one tier.
- **Sigil balance** (new): every sigil affix tier's lowest and highest roll (reduced Force cost, split efficiency, max depth, reduced spirit, increased area, increased damage, rune slots, cast delay, multicast), three tiers each.

**Engine limits** (per number): Split copies 2 to 6 and Concentrated 40 to 60 (the grammar refuses more), "every" and "after" 0.1 to 10 s, pierce 0 to 20, reduced Force cost, reduced spirit and cast delay at most 90% (at 100% the cost or wait is gone), rune slots 0 to 10, max depth and multicast 0 to 3, weights 0 to 1000, item levels 1 to 60; anything else 0 to 10x the affix's best code roll. Whole numbers where the affix rounds to whole numbers.

**The set is checked as a whole** (`tunableSetProblem`, on every PATCH and revert): in each affix, every tier's lowest roll at most its highest, and the tiers in order from the weakest up without overlapping. Neighbours may share an end (whole-number tiers must: pierce 1 to 2 then 2), so the tier a roll counts as, and its price, is never in doubt. For "every X s" a shorter pulse is better, so its tiers run downward. A better tier may not unlock at a lower item level than a worse one, and T6 unlocks at level 1 with a weight above 0, so a Concentrated rune (always rolled) finds a roll at every level. A broken set is a 400 naming the affix and tier, and nothing changes. `applyTunables` also keeps an affix at its whole code table when a partial set (one number dropped as out of range on load or by an older client) would leave it broken, and says so; on load the store logs it and deletes that table's other stored rows, so the stored set is the one in force and no hidden value comes back with a later change (`withoutBrokenAffixTables`).

**What a change reaches.** The affix tables (`AFFIXES` in `data/affixes.ts`) are overwritten in place like every other tunable, so a change applies to new drops (`rollAffixes`), new kits (`kitRoll`) and where extraction clamps (`clampRoll` reads the live table, but never above the code table's best, so a raise for a while cannot let an old +300% roll out at the raised best for good). Tier weights only decide how often a tier drops: they move neither the clamp nor the tier a value counts as. It never changes a stored roll: items keep their values and tiers, so their prices do not move. The one-time re-tier of saves from before the six tiers reads the code's own table (`codeAffixTiers`), so a range tuned on the day a save first loads cannot move it.

**Gold.** Prices count a roll's stored tier (`runeAffixValue`), and a range change never touches stored tiers, so nothing already owned becomes worth more. The trader buys back at a third of what it sells for, the forge charges a rune's sell value to insert it, and extraction only ever lowers a tier (`Math.min` on the way out), so no order of buy, insert, retune, extract and sell gains gold. Tested under the code tables, T1 made wide, heavy and open from level 1, and tables squeezed low, including a rune bought, inserted, retuned smaller and taken out at the real forge.

**Load** drops stored paths the game does not know without a report (the retired `starter.*`, or a newer server's), and still reports a known path whose value a range now refuses.

**Tests:**

- `packages/shared/test/affixTuning.test.ts`: every rune and sigil affix tier in the registry under its category at its code value, no `starter.*` path, the Tuning tab order; engine limits; the set check (reversed, overlapping, backwards pulses, gates out of order, a shared end allowed, a whole tier moved up allowed); a partial set keeps the code table; unknown stored paths dropped silently; a range change moves new drops (runes and sigils) and the clamp but not held items or their prices; new kits clamp into a tuned table and still compile; the gold checks above.
- `apps/server/test/liveTuning.test.ts`: a PATCH that overlaps two tiers is refused with 400 naming them and stores nothing, and so is a revert into an overlap; a `starter.*` PATCH is an unknown path; a kit sigil in a running room casts its stored rolls and follows a base shape change on its next cast, with its item unchanged.
- `apps/server/test/runeRolls.test.ts`: a range tuned before an old save's first load does not move its re-tier.
- `apps/client/test/tunables.test.ts`: a kit shows its own rolls, and the Spell Studio casts a draft as written.

## Limits and open questions

- A change mid-fight applies on the next cast or spawn for what a spell stores when it spawns: a projectile's damage, speed and radius, a nova's or zone's size and duration. Nova, Zone and Dash damage, heal and shield, the ailment numbers, Impact knockback, Ward shield seconds and the aura and Bond numbers are read at hit time, so spells already alive feel those changes mid-flight.
- Tuning is global: every room and every world copy shares one set. Arena runs and dungeons in progress take a change on the next cast too.
- **Affix ranges and prices:** a tier's price is fixed per tier (`runeAffixValue`), not tunable yet; widening T1 makes the same price buy a better roll. Prices are a phase 4 number.
- **Kits after a range change:** a kit is clamped into the live table when it is made, so a range tuned down makes new kits weaker; kits already owned keep their rolls.
- The forge's gold prices, the rune drop shares and the Force bar are not tunable here yet; the cast cooldown, cost multiplier and Force bar stay on the Settings tab. Rune and sigil affix ranges are (above).
- Concentrated's rolls stay inside 40 to 60%, the grammar's range (`CONCENTRATED.minMore` to `maxMore`): its tiers are tunable inside it, and its default without a roll too.
- Rune descriptions are hand-written text ("30% less size", "half a second"); they do not follow a change. The forge sentence and Force and spirit numbers do.
- A newer server's paths are dropped by an older client (and the reverse), so a mixed deploy shows defaults for the new numbers until the client reloads.
- The balance tests check code defaults only (owner: no balance guard). The balance bench measures the saved set and unsaved edits on the admin page, for information; it never refuses a save.
- Monster tuning stays in its own Monsters tab and tables; folding it into the registry is phase 3.
