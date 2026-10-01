# Runes and spells

Status: v2 (phases 0 to 3 of the rework) pushed to `main` on 2026-09-30 and built on 2026-09-29. v1 runes went live on 2026-09-28. Phase 4 onward is planned (see "Planned" below). On 2026-10-01 Multishot and Flame Cleave were buffed and "first rune is free" was dropped, with a save pass on load (built on `fix/rune-rolls`, not deployed yet). The Concentrated rune was built the same day on `feat/concentrated-rune` (not deployed yet). Kit sigils became ordinary sigils with in-table rolls and rune affixes got six tiers on 2026-10-01 (`feat/no-starters`, not deployed).

## What it does

Every skill is a sigil holding runes, read left to right like a Noita wand. The order of the runes is the puzzle. Make a ball, turn it into fire, lightning or cold before it fires, split it, release something from it: every step is a rune.

- **Shapes** start a spell or a payload: Orb (slow and big), Bolt (fast and thin), Nova, Zone, Dash, and the persistent Aura and Bond.
- **Infusions** give the current shape an element: Fire, Cold, Lightning.
- **Effects** change what happens on contact: Impact (knockback), Ward (shield), Restore (heal).
- **Shapers** change the current shape's count or motion: Split today.
- **Triggers** release a payload: On Hit, On Expire, Timer, Pulse, On Land. A **release affix** on a rolled shape rune does the same without taking a slot.
- **Swift and Large** stay as plain modifier runes (+30% speed, +50% size) that teach the system early.
- **Concentrated** is Large's opposite: 40 to 60% more damage (rolled per rune; damage only, not healing or shielding) and 30% less size, once per shape with an area.

Examples, in the text form the Spell Lab and the kit sigils use:

- `bolt[onhit] fire nova`: a bolt that bursts into a fire nova where it hits (Exploding Arrow).
- `orb[every 0.2s, +10% size] cold split(3) bolt`: an orb spraying three cold shards every 0.2 s (Frozen Orb).
- `orb[onhit, +55% damage] fire nova[after 0.5s] zone[+30% duration]`: Fireball; it bursts on hit, the nova releases burning ground half a second later.

The forge shows each spell as a sentence ("Fires a slow cold orb. Every 0.2 s: 4 small bolts."), names every rule a draft breaks, and previews it on a dummy ([forge.md](forge.md)).

### Rune kinds

| Kind | Castable today | Read by the grammar, not castable yet (phase 4) |
|---|---|---|
| shape | orb, bolt, nova, zone, dash, aura, bond | beam, arrow, strike, cleave, throw, trap |
| infusion | fire, cold, lightning | |
| shaper | split | link, orbit, homing, bounce, chain, stack, charge |
| effect | impact, ward, restore | |
| trigger | onhit, onexpire, timer, pulse, onland | |
| modifier | swift, large, concentrated | |

Only castable runes drop, roll, or appear in the forge's pool. The rest are named by the compiler as "not in the game yet".

### Rolled runes

A rune drops plain or rolled. Plain runes stack 20 to a cell. Rolled runes carry rune affixes, are single items and never stack. About 20% of rune drops are rolled; a rolled rune gets 1 affix (common), 1 to 2 (magic), 2 to 3 (rare) or 3 (relic).

**Six rune tiers** (owner, 2026-10-01). Tiers are numbered from the best, as in Path of Exile: T1 is the best and rare, T6 the weakest and common. T6 to T2 split the old three tiers' ranges from low to high; T1 sits above them. Each tier has its own least item level, and common and magic runes stop at T4 (as magic once stopped at the old middle tier). Stored rolls keep a tier index from the weakest (0 is T6, 5 is T1), so every comparison that says "higher is better" still holds; only the label counts from the top (`affixTierLabel`).

| Affix | T6 | T5 | T4 | T3 | T2 | T1 | On |
|---|---|---|---|---|---|---|---|
| speed | +10 to 17% | +18 to 25% | +26 to 33% | +34 to 41% | +42 to 50% | +51 to 70% | orb, bolt, dash |
| size | +10 to 17% | +18 to 25% | +26 to 33% | +34 to 41% | +42 to 50% | +51 to 75% | orb, bolt, nova, zone, aura |
| duration | +15 to 26% | +27 to 38% | +39 to 50% | +51 to 62% | +63 to 75% | +76 to 100% | orb, bolt, zone |
| damage | +10 to 18% | +19 to 27% | +28 to 36% | +37 to 45% | +46 to 55% | +56 to 100% | orb, bolt, nova, zone, dash |
| pierce | 1 | 1 to 2 | 2 | 2 to 3 | 3 | 4 | orb, bolt |
| split count | 2 | 2 to 3 | 3 to 4 | 4 to 5 | 5 to 6 | 6 | split |
| more damage | 40 to 43% | 44 to 47% | 48 to 51% | 52 to 55% | 56 to 60% | 60% | concentrated (every drop rolls it) |
| every X s | 0.52 to 0.6 | 0.44 to 0.51 | 0.36 to 0.43 | 0.28 to 0.35 | 0.2 to 0.27 | 0.15 to 0.19 | orb, bolt, zone |
| weight | 100 | 35 | 25 | 15 | 8 | 2 | |
| least item level | 1 | 2 | 3 | 5 | 8 | 12 | |

- **Weights** keep each affix's total weight at every item level what the old three tiers had (100 at level 1, 160 from level 3, 185 at the top), so number affixes and release affixes roll in the same mix as before. At the top a number affix is T1 about one roll in 90.
- **T1 is "super good"** (owner, 2026-10-01): it reaches the old kits' hand-set rolls (Fireball's +100% damage Orb, Blink's +69% speed, Bone Spear's pierce 4, Frozen Orb's 0.18 s pulse) and stays rare (weight 2, from item level 12). The damage-per-Force cap is a report, not a limit (below, "Balance"). With T1 rolls the worst hand-picked spells measure (pack damage per Force against the best kit's): `nova[onexpire] zone[after 0.3s, +100% damage] fire cold concentrated(60) nova[+100% damage, +75% size] lightning concentrated(60)` 2.32x, the same without Concentrated and with +50% size 2.31x, `bolt[onhit] nova[+75% size, +100% damage] lightning lightning concentrated(60) large` 2.18x, `bolt[after 0.3s] nova[+75% size, +100% damage]` 2.08x, `zone[after 0.7s, +38% duration] nova[+14% size, +100% damage] lightning lightning concentrated(60)` 2.06x. The random searches found at most 2.00x (with Concentrated) and 1.86x (T1 rolls only).
- **Split and Concentrated** cannot go past the grammar's limits (6 copies, 60%), so their T1 is T2's best.
- **Neighbouring tiers share an end** where whole numbers leave no room (pierce, split); a value on a shared end counts as the lower tier when old saves are re-tiered.
- Release affixes (at most one per rune, suffixes) keep one tier: on hit (orb, bolt, dash), on expire (orb, bolt, nova, zone), after 0.3 to 1.2 s (orb, bolt, nova, zone, dash), on landing (dash). Every X s has the six tiers above.
- **Prices:** each rune affix adds 4, 6, 9, 13, 20 or 60 gold of sell value from T6 to T1 (release affixes the first); the old three tiers were 4, 10 and 25. Old saves are re-tiered once by value ([items.md](items.md), "Rune roll pass").
- Every range, weight and item-level gate is tunable on the admin Tuning tab under Rune balance ([live-tuning.md](live-tuning.md)).

### Sigils are wands

A sigil holds whole rune items in its slots. Slots: common 3, magic 4, rare 5, relic 6, plus `sigil_slots` (+1 to +3) and +1 when corrupted, capped at 10; a sigil made from a kit always fits that kit's runes (Fireball and Frozen Orb hold 4 on a common sigil). The sigil's affixes are its wand stats, three tiers each, numbered from the best (T1) like rune tiers and tunable under Sigil balance:

| Affix | Range (T3 / T2 / T1) | Effect |
|---|---|---|
| reduced Force cost | 5 to 12 / 12 to 20 / 20 to 30% | lowers the sigil's Force multiplier |
| split efficiency | +0.05 to 0.12 / 0.12 to 0.2 / 0.2 to 0.3 | added to the 1.2 split conservation |
| max depth | +1 (T2 or T1, so magic or better at item level 3+) | one more payload level |
| reduced spirit | 8 to 15 / 15 to 25 / 25 to 35% | persistent skills reserve less |
| increased area | 8 to 15 / 15 to 25 / 25 to 40% | radius |
| increased damage | 10 to 20 / 20 to 35 / 35 to 55% | damage |
| rune slots | +1 / +1 to 2 / +2 to 3 | capacity |
| cast delay | 5 to 10 / 10 to 18 / 18 to 25% | shortens the cast cooldown |
| multicast | +1 (T1 only: rare or relic from item level 5) | shapes cast together |

"First rune is free" was a sigil affix until 2026-10-01. The owner dropped it ("nothing is free"): no drop rolls it, and sigils that had it lose it on load (see "Rune roll pass" in [items.md](items.md)).

Four sigils sit on keys 1 to 4; left and right mouse cast the picked skill slots. While the shared cast cooldown runs, a dark sweep covers the skill slots and recedes as it recharges (Aura and Bond slots stay clear). The skill slot popup, the sigil tooltip, the stash's sigil list and the forge show "Cooldown N s" for that sigil and character.

### Kit sigils

The 20 built-in skills (each class's first skills, the kit) are ordinary common sigils holding ordinary rolled runes (owner, 2026-10-01: "I don't really want starters, just a basic shape with runes in a sigil; balance is the runes and sigils"). A recipe in `data/starterSigils.ts` only says which runes and rolls a new character gets; every roll lies inside the drop tables below T1, at the tier its value falls in, and a new kit is clamped into the live tables when it is made (`createStarterSigil`, `kitRoll`), so a range tuned down never hands out a roll above it. A sigil casts, prices and comes apart the same whether it came from a kit or not. Its `starter` id only names it: the tooltip, skill bar, forge, stash filter and notices call it by the kit's name and description while its slots hold that kit's runes in order (`matchingStarter`), and nothing else depends on it, apart from the slot count above.

**Every sigil casts the rolls it stores, as stored** (`compileSigilItem` reads the slots directly). The starter rule that cast a whole starter at its live recipe numbers, and pieces of one clamped, is gone, with its live recipe copy and the Skill balance tuning group (`holdsStarterRecipe`, `castingSlots`, `castingStarter`, `liveStarterRunes`). Kit sigils made before 2026-10-01 keep their hand-set rolls (owner): an old Multishot still casts its +300% Bolt. Extraction still clamps, so a strong old roll never leaves its sigil at full strength ([forge.md](forge.md), "Rolls clamp on the way out"). 30% of sigil drops carry a random kit's runes, unbound.

| Class | Kit | Runes (until 2026-10-01, where changed) |
|---|---|---|
| Mage | Fireball | `orb[onhit, +55% damage] fire nova[after 0.5s] zone[+30% duration]` (`orb[onhit, -15% speed, +100% damage] ...`) |
| Mage | Frozen Orb | `orb[every 0.2s, +10% size] cold split(3) bolt` (`orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage] ...`) |
| Mage | Static Nova | `nova[+50% size] lightning` |
| Mage | Blink | `dash[+50% speed]` (`dash[+69% speed]`) |
| Warrior | Leap Slam | `dash[onland] impact nova[+50% size]` |
| Warrior | War Cry | `nova[+50% size] impact` |
| Warrior | Flame Cleave | `nova[+50% damage] fire` (`nova[-40% size, +50% damage] fire`; before the buff `bolt[-50% duration, +60% size] fire split(3)`) |
| Warrior | Iron Skin | `aura ward` |
| Ranger | Multishot | `bolt[pierce 2, +55% damage] split(5)` (`bolt[pierce 2, +300% damage] split(5)`; before the buff `bolt[pierce 2, +60% damage] split(3) split(3)`) |
| Ranger | Exploding Arrow | `bolt[onhit] fire nova` |
| Ranger | Freezing Arrow | `bolt[onhit] cold zone` |
| Ranger | Evade | `dash[+30% speed]` |
| Priest | Holy Nova | `nova[+50% size] restore` |
| Priest | Prayer | `aura restore` |
| Priest | Sanctuary | `zone[+75% duration] restore` |
| Priest | Smite | `bolt[pierce 2] lightning` |
| Binder | Soul Link | `bond ward` |
| Binder | Bone Spear | `bolt[pierce 3, +50% speed, +40% damage]` (`bolt[pierce 4, ...]`) |
| Binder | Corpse Blast | `nova[+50% size] fire` |
| Binder | Frost Mire | `zone[+75% duration] cold` |

Each hand-set roll was clamped to the best value its affix rolls below T1 (the top of today's ranges), and drawbacks no drop rolls (negative speed, size, duration or damage) were dropped rather than turned into the weakest positive roll, since no roll is nearer to them than none. How much each kit lost is under "Kit sigils at table rolls" below.

## Why

### Reading rules

These are the owner's rules (2026-09-29), as the parser implements them:

1. **The first rune must be a shape.**
2. **Infusions, effects and shapers attach to the nearest shape on their left.**
3. **A trigger rune or release affix makes everything from the next shape onward that shape's payload,** spawned where and when it releases. Payloads nest at most 3 levels below the cast (more with the max depth affix).
4. **A Split right after a trigger splits the payload,** not the parent. The plan's own examples need this (`orb[every 0.2s] cold split(4) bolt` sprays four bolts).
5. **Two shapes in a row with no release between them are cast together,** up to the sigil's multicast (1 by default). This counts per group, so a payload of Nova and Zone needs multicast 2 as well.
6. **A payload inherits its parent's infusions unless it has its own;** the sentence does not repeat an inherited infusion.
7. **Aura and Bond must be the only shape,** and cannot have a release, a Split or a Charge. Dash cannot be a payload (it moves the caster). Charge will only work on a root shape (it needs a held button).
8. **Edge cases allowed for now:** a split Nova makes several rings, and doubled runes stack (two Splits multiply up to 12 copies; a doubled infusion adds +25% damage). Link and Orbit go on a shape once. Limit them later if testing shows they are too strong.
9. **Limits stay:** depth, the entity budget (the most entities one cast has alive at once, at most 40) and Force. When a spell breaks a rule, the editor names the rule and the rune that broke it. No hidden reasons.

Each shape accepts only some release kinds and some shapers (`TRIGGERS_FOR_SHAPE`, `SHAPERS_FOR_SHAPE`); "every" and "after" need at least 0.1 s; Split makes 2 to 6 copies.

**Triggers stay common plain runes;** release affixes on shapes are the rare upgrade that saves a slot. A release affix costs the same Force as its trigger rune, so the affix saves a slot, not Force.

**v2 replaced v1 outright:** no switch and no fallback, because only a handful of characters existed and the conversion is one-way either way ([items.md](items.md), "Conversion from v1").

### Force

The casting resource is shown to players as "Force"; internally it keeps the spec's name, heat. (The v1 knockback rune was renamed from Force to Impact to avoid the clash.)

- **Price per cast:** the sum of each rune's cost times affinity (0.8 for the class's runes, 1.2 otherwise), times the sigil's multiplier (0.75, less its Force affix), never below 0 per rune and never below 4 per cast.
- **Base costs:** orb 10, bolt 8, nova 14, zone 16, dash 12; fire 4, cold 4, lightning 5; impact 5, ward 5, restore 6; triggers 2 (pulse 3); swift and large 3; concentrated 5 plus its damage (below); Split 2 per copy. The v1 numbers carried over, except the triggers, which dropped from 4 (pulse 6) to 2 (3) so the v1 payload skills keep their hand-set prices.
- **Payloads:** a payload's base runes pay 15% for its first spawn. The v1 skills were priced by hand far below what a depth surcharge gave (Exploding Arrow 16 against 47 by formula), and this share reproduces those prices: a payload only goes off when the cast lands, and the entity cap and depth limit already bound a chain. Split is exempt, since copies multiply the cast.
- **Payload riders pay at least 50%:** a payload's number affixes and the runes that only change it (elements, effects, Swift, Large) cost at least half their listed Force. At 15%, a Bolt releasing a `nova[+50% size, +55% damage]` dealt over twice a starter's pack damage per Force.
- **Repeat spawns pay again,** scaled by the damage one spawn can land: 60% of the full price when a flying shape (bolt or orb) released it, the full price otherwise (zone, nova or dash). A ring sprayed from a moving orb is further weighted by how little of it faces one target (copies x 0.26 rad / 2 pi). At the first-spawn share alone, a Zone releasing a Nova every 0.2 s dealt about 8x a starter's damage per Force.
- **Number affixes** cost 3 per plain-rune step they stand for, on a log scale: `3 * ln(1 + v/100) / ln(step)`, with steps speed 1.5 (dash 1.3), size 1.5, duration 1.75, damage 2 and pierce 2 extra hits (the v1 Swift, Large, Linger and Pierce runes). A negative roll refunds half.
- **Nothing is free:** every rune pays its own price. The "first rune is free" affix and its pricing (`HEAT.minWaivedForceShare`, the waiver in `runeForce`) are gone; at the end it was capped at a Bolt's base cost and 95% of the full price, worth about 5% of a cast, because anything more let one-rune spells reach 4 to 6x a starter's damage per Force.
- **Concentrated** pays its base 5 plus its damage priced like a damage roll of the same size (`3 * ln(1 + v/100) / ln 2`, 1.5 at 40% and 2 at 60%). Its area loss refunds nothing, because on a Bolt or a lone target it costs the spell almost nothing. It is a rider, so on a payload it pays at least 50%.
- **Aura and Bond cost no Force** and reserve spirit per rune: aura 30, bond 25, fire, cold, lightning and impact 10, ward and restore 12, swift 5, large 8; concentrated 35% of the rest of the aura, at least 10.
- **Cast rules:** skills cost 75% of their listed Force (`costMultiplier`). The bar cools at 30/s after a 0.5 s pause, ramping up by the base rate every second you hold off, up to 6x, so a full 1000 bar clears in about 8 s. A cast is blocked when it would pass 1.3x the bar. Above the bar each cast can misfire: the chance grows from 0 at the bar to 50% at 1.3x, times 1.5 on corrupted sigils; a misfire still costs the Force and deals 10% of max life, ignoring armour.
- **Duds:** a spell that breaks a rule fizzles only on a fresh key press (not while held) and costs 50% of its computed Force. A fizzling draft can still be inscribed.
- **The cap is 1000,** so it effectively never limits play while skills are tuned (see "Planned: Force has to bite again").

### Engine

- **Every node has its own release timing, speed, size, duration, damage and pierce.**
- **An `after X` release outlasting its shape still fires at X,** where the shape ended.
- **The Orb is its own shape:** slow and big (speed 286, range 728, radius 16 against the Bolt's 520, 560, 8), it rolls through everything unless it has an on-hit release.
- **Multicast and payloads of several shapes work.** Split copies of a bolt or orb fan out 0.26 rad (15 degrees) apart; copies of other shapes sit in a ring 70 units out. Copies inherit the parent's hit list, so they do not re-hit the same target at once. Split conserves damage: each copy gets `1.2 / n` of it (plus the sigil's split efficiency).
- **Pulse and "every X":** each release gets a fresh hit list; a split payload released on an interval sprays a full ring, rotating 0.7 rad each time.
- **On hit** fires once per enemy a piercing projectile hits; on a Dash it fires on the first enemy only. **On expire** fires when the shape ends, hits a wall or is spent.
- **The cast cooldown is a live admin setting,** default 0.5 s (see "Cast cooldown" below). The cast delay affix and cast speed shorten it. It was 0.35 s from v2 until 2026-10-01, which is what the old 0.3 s actually waited because of a float remainder; the remainder is fixed, so the cooldown waits exactly its seconds in 0.05 s ticks.
- **Live spell cap:** a projectile or nova counts 1 and a zone 0.35 (they cost the server about 6 and 0.8 microseconds per tick), 40 per player and 320 per room. Past it, the caster's oldest spent piece ends first and pieces still carrying a payload last; past the room cap, the heaviest caster gives way first. Spells of a player who leaves the room are removed. The grammar's entity budget counts unweighted. When the cap came in (before v2, with a nova weighted 0.35), Frozen Orb lost about 3% of its damage.
- **Zones do not stack per caster:** a target takes at most one tick per caster, per kind (elements and effects), per tick interval, however many of that caster's zones it stands in. Different casters still stack, so party play pays. Zone damage rose from 6 to 14 per tick to match, and Fireball was retuned.
- **Offensive or support:** a node is offensive if it has an element or Impact, or has neither Restore nor Ward. So `nova restore` only heals, and `nova ward fire` damages enemies and shields allies. Heals and shields hit allies, including the caster for areas.
- **Hidden combos**, matched when both runes are on one shape (inherited infusions count): **Frostfire** (fire and cold) carries both elements and ailments and deals +25% damage; **Burning Ward** (ward and fire) shields deal 8 fire damage to enemies that touch them.

### Persistent skills: Aura and Bond

- **Aura strength** is the node's damage scale, so sigil damage affixes strengthen auras. The strongest aura per type applies per target, where the type is Restore, Ward, Fire, Cold, Lightning or Impact.
- **Elemental auras** damage enemies in range (170) each tick; Cold also chills and Lightning also shocks.
- **The regen cap** (8 per second) covers aura and bond regeneration combined. Burst heals from Nova and Zone are not capped.
- **Bond targeting:** a Bond targets the nearest ally player or own minion within 380 units and a 45 degree cone of the aim. It retargets on key press and when equipped, breaks beyond 480, and reconnects inside 380. A bond whose target dies is cleared, because a respawned minion is a new entity.
- **Bond effects** add to an ally's buffs rather than following the aura stacking rule: Ward gives 30% damage reduction and Restore gives regen (6 per second). Each element on the bond gives the target +15% spell damage.
- **Total damage reduction** from wards and bonds is capped at 60%.

### Balance

- **Every kit stays within 15% of its v1 Force and 10% of its v1 damage** (single target and pack), measured by the same harness against `test/fixtures/skill-baseline-v1.json`. Kits whose rolls were clamped into the tables (Fireball, Frozen Orb, Blink, Flame Cleave, Multishot) are held to the numbers measured at their table rolls instead (`TABLE_ROLLS` in `skillParity.test.ts`), within the same bands.
- **Damage per Force is a report against the best kit skill, not a limit** (owner, 2026-10-01: "Let runes be mods and spells base"). The reference is the best kit at its table rolls: Freezing Arrow to one target (2.13 per Force) and Exploding Arrow to a pack (7.71), the same two and the same numbers as before the kits were clamped. The test fails only above 5x, to catch a broken combination, and prints every hand-picked spell past 2x (only T1 spells today, up to 2.32x). Until 2026-10-01 it failed above 2x; a random search (8000 spells per seed) then found nothing above about 2.13x.
- **Multishot and Flame Cleave were buffed** (owner, 2026-10-01). In v1 they dealt about 4 and 13 damage per cast against 100+ for Fireball. Measured with the parity harness (single target / pack over the run, Force per cast):

  | Starter | Before | After | v1 |
  |---|---|---|---|
  | Multishot | 114.7 / 344.1, Force 18.6 | 430.1 / 1290.2, Force 19.2 | 114.7 / 344.1, Force 19.8 |
  | Flame Cleave | 191.4 / 382.9, Force 18.4 | 650.4 / 3230.6, Force 16.7 | 191.4 / 382.9, Force 16.2 |

  Both stayed inside the 15% Force band (-3.0% and +3.1% against v1) and below the best starters' damage per Force (2.13 single, 7.71 pack, unchanged), so the 2x bound of the damage-per-Force tests did not move. Flame Cleave became a burning ring close around the warrior instead of three short waves in a cone: the waves with +200% damage reached 574 / 1149 but cost 22.6 Force (+40% on v1). Sigils already owned get the new runes on load ([items.md](items.md), "Rune roll pass"). The same day the kits' rolls were clamped into the tables (below), which took most of Multishot's buff back.
- Fireball is the plan's Fireball, not a copy of v1: the orb carries v1's 2x hit, since the burst and the burning ground only add to it. Frozen Orb's v1 skill exceeded the entity cap (48); it now peaks under 40.

### Spell budgets (measured)

Benchmarked with 8 players casting endgame-sized spells into 60 and 120 enemies (Frozen Orb, and a synthetic spell bursting into 6 homing sub-bolts that each leave a zone):

- **Bandwidth is the limit, not server CPU.** Each visible spell entity costs about 14 B per client per tick after compression; the enemies alone take about 1.4 Mbit/s per client in a 120-enemy fight.
- **At 40 per player,** a 120-enemy fight averages 2.1 Mbit/s per client, and 10 busy rooms on one thread peak at 22.7 ms of the 50 ms tick.
- **Spells are sent once, not every tick** (spawn records, then only removals), which cut snapshot bytes 30 to 76%. After that the cap stops mattering for bandwidth and could rise to 60 to 80 once projectile hits use a spatial grid.

## How

Code:

- Grammar: `packages/shared/src/runes/v2/` (`runes.ts` rune data, `rules.ts` every rule by id and `DEFAULT_CONTEXT`, `tokenize.ts` the text form, `parse.ts` the tree, `budget.ts` the entity budget, `compile.ts` the program and its Force or spirit, `sentence.ts` the sentence and bracket views, `descriptions.ts` tooltips and glyphs, `examples.ts` shared examples).
- Engine contract: `packages/shared/src/sim/program.ts`. Engine: `sim/spells.ts` (casting, releases, live cap, zone lockout), `sim/auras.ts` (Aura and Bond), `sim/players.ts` (Force cooling).
- Kits: `packages/shared/src/data/starterSigils.ts` (`createStarterSigil`, which clamps each roll with `kitRoll` in `items/runeRolls.ts`); the one-time pass that brings owned sigils and runes up to date: `items/convertRuneRolls.ts`. Affixes and their six rune tiers: `data/affixes.ts` (`AFFIXES`, the live table; `codeAffixTiers`, the code's own; `affixTierLabel`). Sigil items and capacity: `items/items.ts` (`sigilCapacity`, `matchingStarter`, `misfireChance`). Class affinities: `data/classes.ts`.
- Numbers: `HEAT`, `SPELL`, `AURA`, `LINK`, `AILMENTS` in `packages/shared/src/config/sim.ts`; `FORGE` in `config/forge.ts`. Shape, rune Force, spirit and effect numbers are live-tunable from the admin Tuning tab, which overwrites them in place ([live-tuning.md](live-tuning.md)); read them where they are used, never copy one into a module constant.

```ts
interface SpellNode {            // sim/program.ts
  form: 'orb' | 'bolt' | 'nova' | 'zone' | 'dash' | 'aura' | 'bond';
  elements; effects; copies: number; pierce: number;
  release: { kind: 'onhit' | 'onexpire' | 'after' | 'every' | 'onland'; seconds: number } | null;
  payload: SpellNode[]; depth; combos: string[];
  damageScale: number; areaScale: number;
  tuning: { speed; range; damage; radius; phase };   // multipliers of the form's base values
}
interface SpellProgram { roots: SpellNode[]; form: FormId }
```

`compileSigilItem(item, classId)` returns either `{ ok: true, tree, program, force, spirit, persistent, peakEntities, notes }` or `{ ok: false, errors, force }`, where every error names a rule id and the rune index. The client compiles locally with the same code for instant feedback; the server recompiles on inscribe.

Rule ids: `empty`, `unknown-rune`, `unknown-affix`, `bad-count`, `first-rune-shape`, `affix-not-allowed`, `trailing-release`, `one-release`, `release-not-for-shape`, `onrelease-needs-hold`, `release-interval`, `multicast`, `shaper-not-for-shape`, `link-needs-split`, `split-once` (Splits multiply up to 12), `split-count`, `duplicate-shaper`, `persistent-alone`, `persistent-no-release`, `persistent-no-split`, `persistent-no-charge`, `dash-root-only`, `charge-root-only`, `max-depth`, `entity-cap`, `plain-modifier-off`, `concentrated-needs-area`, `concentrated-amount`, `concentrated-once`, and from the compiler `over-capacity`, `rune-not-castable`, `engine-not-ready` (homing, bounce, or releasing on a held button).

Admin tunables (Settings tab, [accounts-admin.md](accounts-admin.md)): the level-1 Force bar (50 to 5000), a cost multiplier and a cooling multiplier (0.1 to 10), the cooling ramp cap (1 to 20) and the global cast cooldown (0.1 to 3 s). They apply to everyone at once; the cost multiplier and the cooldown apply at cast time, not in the compiler.

Tests:

- `packages/shared/test/skillParity.test.ts`: all 20 kits within 15% Force, 10% damage (single and pack) and 5% dash distance of v1, exact spirit and cast count. The harness (`test/harness/skillDps.ts`) casts at the v1 cadence of 0.35 s (`HARNESS_DEFAULTS.castCooldown`), not the live setting, so it compares strength per cast against the fixed baseline; the five kits clamped into the tables against their table-roll numbers (`TABLE_ROLLS`).
- `apps/server/test/castCooldown.test.ts`: the setting's default and range, storage, the welcome and `castCooldown` message, and the server enforcing a changed value live.
- `apps/client/test/castTiming.test.ts`: the client takes the server's value, ignores bad ones, and shows the same cooldown the server counts.
- `packages/shared/test/convertRuneRolls.test.ts`, `apps/server/test/runeRolls.test.ts`: the rune roll pass ([items.md](items.md), "Rune roll pass").
- `packages/shared/test/affixTuning.test.ts`: the six rune tiers (counts, labels, ranges against the old ones, item-level gates, drops inside their tier), the one-time re-tier (by value, from the code's table, never worth 3x the old price), and the affix ranges in live tuning ([live-tuning.md](live-tuning.md)).
- `packages/shared/test/runeRolls.test.ts`: no kit rune is past the table; old kit sigils are, and clamp on the way out.
- `packages/shared/test/forcePerDamage.test.ts`: 77 hand-picked spells (24 with Concentrated, 11 with T1 rolls), 300 seeded random spells (seed 20260930), 300 more with Concentrated and Large (seed 20261001), 300 of T1 rolls only (seed 20261002), all drawn from the live drop tables, and every kit piece (prefixes in place and single runes, alone and with infusions added) stay under 5x the best kit's damage per Force, single and pack; spells past 2x are printed.
- `packages/shared/test/concentrated.test.ts`: the Concentrated grammar, compile, Force, spirit, drops, rolls, prices, the rune tab sort, grants and the forge; every aura type and element mix (three different, three the same), with and without Large, at no more than 1.2x the damage per spirit with it and the same strength for Ward, Restore and Impact; a damage affix refused on Aura and Bond; and heals and shields per cast unchanged by it (less per Force); `apps/server/test/concentratedRune.test.ts`: saves holding it load and save back.
- `packages/shared/test/grammarV2.test.ts`: the plan's examples, every rule, ambiguous cases, the tokenizer.
- `packages/shared/test/compile.test.ts`: castability, named engine gaps, multicast, multi-shape payloads, affixes, capacity, Force by depth, affinity and affixes, spirit, starters compile for their class.
- `packages/shared/test/spellEngine.test.ts`: the cooldown waits exactly the setting's seconds (0.3, 0.35 and the default), the cast delay share and cast speed shorten it, a changed setting applies from the next cast, multicast, `after` outlasting its shape, per-node speed and size, orb phasing.
- `packages/shared/test/payloadInfusion.test.ts`: inherited infusions reach the snapshot and the damage element.
- `packages/shared/test/entityBudget.test.ts`: the budget's peak equals the engine's for 12 interval spells.
- `packages/shared/test/liveCap.test.ts`, `zoneStacking.test.ts`: the weighted cap, room cap, departed players; one caster's zones do not stack.
- `packages/shared/test/runeRolls.test.ts`, `forceRates.test.ts`, `skillBaseline.test.ts`, `runeGlyphs.test.ts`, `spellSnapshots.test.ts`, and the "heat" and fixture blocks of `systems.test.ts` (cooling, overheat cap, misfire, duds at half Force, SPEC fixture spells in play).
- `apps/client/test/studio.test.ts`: the Spell Studio prices kits exactly like the game.

Dev tools ([dev-tools.md](dev-tools.md)): the **Spell Lab** reads any rune list with the full grammar (phase 4 runes included), shows the verdict, errors, sentence, tree and budget, and hands castable spells to the **Spell Studio**, which casts them at dummies and exports a `starterSigils.ts` entry.

### History: v1 runes and prebaked skills

Replaced by v2; kept so old saves, tests and numbers make sense.

- **v1 grammar (SPEC, M2):** Form, Element, Effect, Modifier (Swift, Large, Linger, Pierce), Trigger and Action (Split) runes. Orphan forms (`bolt nova`) and Split on Dash were duds. Timer fired once, after 0.5 s or when the form ended, whichever came first. Heat was charged by depth (`1 + 0.5 * depth`). v2 replaced the depth surcharge with the payload share, made two shapes in a row a multicast, and made `after X` fire at X even after its shape ended.
- **v1 misfire** ran from 0% at 100 heat to 50% at 130, with a 0.3 s global cast cooldown; the same shape now scales with the bar (1000 to 1300) and the cooldown is an admin setting (default 0.5 s).
- **Prebaked skills (after M6):** each class had four fixed skills in `data/skills.ts`, compiled by the rune engine. Hand tuning (speed, range, damage, radius, pass-through) applied to the root node only, and a skill could set its heat cost by hand because the depth formula made deep programs expensive (Fireball was 96). Sigil drops carried a random skill; hand-inscribing a sigil cleared it. These became the starter sigils.
- **Pulse** was added then as a trigger for Bolt and Zone, firing every 0.18 s; Pulse plus Split sprayed a rotating ring, which is Frozen Orb. Prebaked skills could raise the entity cap (Frozen Orb allowed 48). The Pulse rune's default interval in v2 is 0.25 s; Frozen Orb carries its 0.18 s as a roll.
- **The v1 editor** said "Unstable" without a reason, and only the debug overlay showed it. v2 names every rule in the forge.
- **The Test Sigil** every character started with, and the F1 fixture loader, are gone; saves that held one lost it and got its runes back, bound.

## Planned

Phase 4 onward of the rework. Build order, each phase shipping on its own with an item review before deploy:

4. **New shapers and Beam:** Link, Orbit, Homing, Bounce, Chain, Charge, and the channelled Beam shape.
5. **The rune trader** (the forge's gold cost is built; see [forge.md](forge.md)).
6. **Styles:** character creation, weapon shapes and scaling, style runes, style minions, uniques. **Minion abilities** can come earlier, on their own ([minions.md](minions.md)).
7. **Force rebalance** with numbers on the admin page, endgame affix tiers, and the combo codex.

### New shapes and shapers

- **Beam** is a channelled line from the caster toward the cursor: it costs Force every tick while held, hits what it touches on a tick interval, and turns with the aim. Runes work on it like on any shape: `beam fire` burns; `beam split(3)` fans three beams; `beam[every 0.5s] nova` pulses explosions where it ends; `beam chain(3)` arcs off the first target. It needs two engine pieces the other shapes do not: a held-cast state (the skill keeps firing while the button is down), and a line hit test against enemies each tick. The client draws it from the caster's predicted position to the aim, so it never trails behind the hero.
- **Charge** turns any shape from cast-on-press into hold to power up, release to fire. On a Beam it replaces the sustained burn with one piercing lance; on an Orb the ball grows, on an Arrow the shot pierces further, on a Nova the ring widens. Damage and size scale with the time held, in stages up to a cap (for example three stages over 1.5 s), and the shape narrows and brightens while charging so others can read it. Release affixes still apply: `beam[on release] charge split(3) bolt` fires the lance, then sprays bolts where it ends. Charge affixes tune it ("charges 40% faster", "+1 stage", "moving does not reset the charge"). Charging slows the hero to about half speed; a rare affix lifts that. Charging and channelling share the held-cast state.
- **Link** after a Split joins the copies with beams that hit whatever crosses them. **Orbit** makes copies circle the caster, or their parent if they are a payload. Homing, Bounce and Chain as named.
- **Weapon shapes:** Arrow, Strike, Cleave, Throw, Trap. Spell shapes scale with spell damage; weapon shapes scale with the weapon you hold. That is a soft gate: anyone can fire an Arrow rune, but it is weak without a bow.
- **Later shape:** Wall. **Shape-changing sigils (idea):** a sigil affix that turns one shape into another, an Orb into Arrows or an Arrow into a Nova.
- **More number affixes:** bounce N, homing strength, Split spread, Link beam damage. **Deep endgame tiers** add things like "releases twice" or "copies keep full damage".

Examples from the plan:

- **Linked balls:** `orb lightning split(3) link`. Three orbs fan out with lightning between them. Swap Link for Orbit plus Link and they circle you as a shield.
- **Endgame:** `orb[onexpire] fire split(6) orb[onhit, homing] nova zone[long]`. A fireball bursts into six homing embers, each exploding and leaving burning ground.

### Ground effects merge instead of stacking

Shipped ahead of the rework as the lockout rule only (one tick per target, per caster, per kind, per interval). The rest is planned:

- **Same caster, same kind: merge.** A new zone overlapping one of yours grows the existing one toward the new area and refreshes its duration, capped at (open) twice its original area. Fewer entities, a spreading pool on screen, never more than one zone's damage.
- **Stack rune:** lets the current spell's zones stack up to a limit before they merge. Its number affix sets the limit (2 to 4, higher from deep zones). It takes a slot, so stacking is a build choice with a cost. Only a unique lifts the cap. Example: `orb[onexpire] fire split(4) zone stack(3)`.
- **Later, with the combo codex:** different kinds combine, such as fire on cold ground making steam.

### Styles instead of classes

Three styles, **melee**, **ranged** and **spell**, each with a family of sigils, weapons and minions, and every piece drops.

| | Melee | Ranged | Spell |
|---|---|---|---|
| Sigils | Warmarks: Strike, Cleave, Throw | Quivers: Arrow, Trap | Grimoires: Orb, Bolt, Nova, Zone |
| Weapons | swords, axes, maces | bows, crossbows | staves, wands, sceptres |
| Minions | Shieldbearer (taunts), Banner-bearer (aura), Berserker | hound (pins), hawk (marks), trapper | elementals, acolyte (heals), undead |
| Own runes | e.g. Rend, Cleave arcs | e.g. Mark, Volley | e.g. Consecrate, Corpse shapes |
| Affixes only it drops | e.g. "hits twice", "shockwave on kill" | e.g. ricochet, "falls from above" | e.g. "payload inherits element", "orbits caster" |

- **Character creation keeps the five classes as starting kits** mapped onto the styles: Warrior melee; Ranger ranged; Mage, Priest and Binder spell. A style gives a starting kit, cheaper Force on its shapes and runes, base stats (armour, life, spirit), and which minion family it can bind.
- **Sigils of every style work for everyone.** A melee character can carry a grimoire; it costs more Force and hits with spell damage, which melee gear does not raise. Hybrids are possible, just not free.
- **Minions follow style:** a ranged character runs a hound and a hawk, a melee one a shield wall.
- **Rare affixes break a rule once, never freely.** A rare vessel affix, *Kindred*, lets one minion of another style join your warband; only one at a time. The same holds for every rule-breaking affix: it permits one of a kind (one extra multicast, one foreign minion), and only the unique version lifts the limit fully. This is why multicast only reaches +1 and only on rares. ("First rune is free" was one of these until the owner dropped it on 2026-10-01: nothing is free.)

### Uniques

A new top item tier with fixed, hand-made affixes that bend the rules. They drop rarely, only from bosses and deep zones, and are the endgame chase alongside wand-stat sigils. First ideas:

- **Crown of the Many:** bind minions of any style.
- **Quiver of Embers:** spell shapes fired from it use bow damage.
- **The Open Hand:** no weapon; every weapon shape uses your spell damage instead.
- **Gravebound Warmark:** each kill with a melee shape raises a skeleton for 10 s.
- **Echoing Grimoire:** multicast +1, but every cast costs life as well as Force.

### Force has to bite again

The cap is 1000 today, so nothing limits a big spell. It comes back down to roughly 100 to 150, with overheat and misfire as the spec intended. Every skill needs a tuning pass after that, which is the strongest reason to put balance numbers on the admin page first.

### Parked: weapon-gated skills

Not decided. Sigils could need a weapon family (arrows a bow, strikes an axe, spells a staff or wand) and minions a wand or sceptre, so the Binder trades weapon power for its army. Parked because it may make classes redundant: if weapons and sigils decide what you can do, classes could shrink to starting kits and stat leanings, all in config. Revisit alongside class balance and the styles.

## Limits and open questions

- **Multishot and Flame Cleave** were buffed on 2026-10-01 (see "Balance"). A starter sigil changed at the forge keeps what it holds; only sigils still holding the old recipe exactly were rebuilt. The rune the shorter recipe has no room for goes back to the player when unbound and is removed when bound ([items.md](items.md), "Rune roll pass"). Flame Cleave's ring is close around the hero: whether it reads as a cleave in play is for the owner to judge.
- **Old kit sigils keep their hand-set rolls** (owner) and cast them as stored, also rearranged or beside other runes at the forge: the runes never leave the sigil, so nothing clamps them. Before 2026-10-01 a piece of a kit cast clamped, because Multishot's +300% Bolt alone dealt 2.85x the best kit's damage per Force; that rule is gone with the starter rule, so a player who kept an old Multishot can build that Bolt into another spell in the same sigil. Only characters made before the change have such sigils, and taking the rune out clamps it. Whether to clamp kept runes on re-inscribe is open.
- **Kit sigils keep a slot count of their own:** a sigil made from a kit always has room for that kit's runes (Fireball and Frozen Orb put 4 on a common sigil of 3). It is the only thing the `starter` id still changes.
- **Appending after a kit (owner, 2026-10-01)** for the forge redesign's open slot: with every sigil casting its own rolls this needs no special rule any more; the appended cases are ordinary in-table spells, which the 2x search covers ([forge.md](forge.md), "Planned: forge redesign").
- **Repeating payloads** (`every`, Pulse) now cost 60 to 250 Force per cast, since they pay for each release; players who built them will read it as a nerf. Phase 7's rebalance revisits it. Frozen Orb stays near its v1 price because its ring is weighted as mostly missing.
- **Fireball and Leap Slam** sit near the top of the 15% Force band (+13%); a retune should keep them inside it.
- **A once-off payload at its base price** can reach about 2.1x the best kit's damage per Force with T2 rolls, and 2.3x with T1 damage; both are reported, not refused.
- **"First rune is free"** was dropped on 2026-10-01 ("nothing is free"): pricing is per rune, and sigils that had it lose it on load. The copy of live from 2026-10-01 had none.
- **Skill tooltips show the base Force,** not the admin's cost multiplier.
- **Swift and Large as plain runes** are behind a grammar flag (`plainModifierRunes`), on in the game. Concentrated is not.
- **No damage affix on Aura or Bond:** elemental auras read the damage tuning since Concentrated goes there, so the grammar refuses a damage affix on a persistent shape (`affix-not-allowed`), as the drop table already did; spirit does not price damage.
- **Rolling back past Concentrated:** a build from before it does not know the rune, and a stash holding one fails its shape check (`isItemShape`) on load. Roll back only with the database copy from before the deploy. Clients from the old build reload on the build check, so no old client sees the new id.
- The rune trader, zone merging, the Stack rune and endgame tiers are not built.
- `SPELL.timerSeconds` duplicates `DEFAULT_TIMER_SECONDS` and only a test reads it. `runes/v2/examples.ts` still carries the plan's older Fireball text (`+30% damage`, `zone[long]`).

## Cast cooldown (owner, 2026-10-01; built 2026-10-01, not yet deployed)

"My brother has a spell like an orb that does some novas, pretty cool, but needs more cooldown; base cooldown needs to be higher."

- **Force is the magazine, the cooldown is the fire rate** (owner). Casting should not feel spammy: Force says how much you can cast before you run hot, the cooldown says how fast.
- **One global cast cooldown, a live admin setting:** `castCooldownSeconds` in ServerSettings, default 0.5 s (up from 0.35 s), 0.1 to 3 s, on the admin Settings tab. It applies to every room on save, without a restart. It stays one number for every spell: the owner chose this over a cast delay per rune and over a cooldown by Force cost.
- **Cast delay and cast speed still shorten it:** a cast waits `setting x (1 - cast delay %) / cast speed`, rounded up to whole 0.05 s ticks because the server only casts on a tick (0.43 s waits and reads 0.45 s). `castCooldownSeconds` in `items/items.ts` does both and is used by the sim and every tooltip. An equipped sigil carries its cast delay as a share of the setting (`EquippedSigil.castDelayShare`), so a change reaches sigils already equipped.
- **A change mid-session:** a cooldown already running keeps its length; the next cast uses the new value. The server is the only one that enforces it (casts are not predicted on the client; the client sends held buttons and the server ignores them during the cooldown), so a client cannot cast faster than the server allows. The skill bar sweep runs on the snapshot's `castCooldown` and `castCooldownFull`, so it always shows the server's cooldown.
- **The client's copy, for tooltips:** the welcome carries `castCooldown` and every settings change sends `{ t: 'castCooldown', seconds }`. The client checks it against the limits (`isCastCooldown`; a bad value is ignored and the last good one kept) and keeps it in `useCastTiming` (`apps/client/src/game/castTiming.ts`). Tooltips read it with the character's cast speed (`useSigilCooldown`), so they follow a change at once. Aura and Bond sigils show no cooldown, since they never wait for it. The forge preview follows the client's copy and the character's cast speed live; the Spell Studio and the VFX bench use the default.
- **Skill bar:** a dark sweep (near-black with a faint inset shadow, no colour) over the slot while it recharges, eased between the 20 Hz snapshot steps with a registered `--cd` property (`.skill-cd` in `styles.css`). Only the sweep (`CooldownSweep` in `Hud.tsx`) re-renders on each tick; the slot's compile is memoised.
- **Trade-off accepted:** starters and basic attacks slow down by the same share as payload spells (about 30% fewer casts a second at 0.5 s).
- **Balance tests stay on the v1 cadence.** The parity and damage-per-Force harness casts every 0.35 s, as the v1 baseline was recorded and Force pricing was balanced. Measured at 0.5 s, the parity test fails by design (Fireball 20 casts in 10 s instead of 29) and the damage-per-Force search finds one spell above the 2x cap: `nova[onexpire] zone[after 0.3s, +55% damage] fire cold nova[+55% damage, +50% size] lightning` reaches about 2.15x in the pack, because a slower cadence wastes less of its lingering zone to the no-stacking rule. Open question: retune that spell class, or measure the cap at the live cooldown.

## Concentrated rune (owner, 2026-10-01; built 2026-10-01, not yet deployed)

"We also need a new rune, conc effect, more damage but smaller area."

- **What it does:** a modifier rune, the opposite of Large. The shape on its left deals 40 to 60% more damage and has 30% less size (the `[small]` step; size is radius here, as with Large and the sigil's increased area). The bonus multiplies the shape's damage roll, its Splits and the sigil's damage. It is damage only: it goes on the node's damage tuning, not on `damageScale`, so heals, shields and the strength of Ward, Restore and Impact auras do not change. Elemental auras deal it as damage. A shape that deals no damage (`nova restore`, `aura ward`) gets a forge note that it only shrinks. Text form: `nova concentrated(55)`, or `conc`; without a number it reads the lowest roll, 40.
- **Which shape:** like an infusion, it goes on the nearest shape to its left, even across a trigger or a Split: `orb[onhit] split concentrated nova` concentrates the Orb, not the Nova. The tooltip says so.
- **Where it works:** every shape with an area: Orb, Bolt, Nova, Zone and Aura (and the phase 4 shapes). On a Dash (its hit reach is fixed) or a Bond (no area) the grammar refuses it with `concentrated-needs-area`, naming the rune and the shape, because there it would be damage with nothing given up. Large is silently useless on those shapes; Concentrated is not, so it gets an error. It needs no flag: `plainModifierRunes` only exists because Swift and Large have affix forms.
- **Once per shape** (`concentrated-once`), like Link and Orbit. Stacked, the bonuses added up while each took another 30% of size, and past the size floor (a tenth) every further one was free damage. Multiplied instead, four on a Bolt had dealt 3.08x the best starter's damage per Force.
- **Amounts outside 40 to 60%** (the table; the bench's plain rune casts at 40, the minimum) are `concentrated-amount`, so the Spell Lab cannot write `concentrated(1000000)`. The sentence shows a fractional bonus as written (40.5%).
- **The roll:** every Concentrated drop carries the `rune_concentrated` rune affix ("51% more damage") in the six rune tiers: T6 40 to 43, T5 44 to 47, T4 48 to 51, T3 52 to 55, T2 56 to 60, T1 60 (the grammar stops at 60), gated by item level and drop tier like every rune affix. So it never drops plain and never stacks. Monster drops, rolled drops and admin grants all roll it (`dropsRolled`, `ALWAYS_ROLLED_RUNES` in `items/items.ts`). A plain one only comes from the builders' bench and casts at 40%. It sells and prices at the forge by its roll's tier like other rolled runes, and clamps to 60 outside a sigil.
- **Look:** name Concentrated, glyph `Ct`, a dried-blood tint (`0xb0584a`) on the carved stone icon, darker than the bone white of Swift and Large. It sorts with the modifiers in the stash rune tab and can be sorted by its roll.
- **Force and spirit:** base 5 plus its damage (see "Force" above). At base 3, like Large, a payload Nova with it reached 2.09x the best starter's pack damage per Force; at 5 the worst hand-picked spell is the same one without Concentrated, 1.97x. On an aura it reserves 35% of the spirit of the rest of the aura, at least 10, since it multiplies every element at once. A flat 10 let `aura fire large concentrated(60)` deal 1.32x the damage per spirit of `aura fire large`, and a flat 15 still let `aura fire cold lightning concentrated(60)` reach 1.31x. As a share, a 60% roll gives 1.6 / 1.35, about 1.18x for any mix: `aura fire` 40 to 54 spirit, `aura fire cold lightning large` 68 to 92. Ward, Restore and Impact auras keep their strength and so lose per spirit (Ward 42 to 57, 0.74x).

Measured with the parity harness at base 5 (per Force as a share of the best starter's, single / pack; best starter 2.13 / 7.71):

| Spell | Force | Single / pack | x best |
|---|---|---|---|
| `nova` (mage) | 12.6 | 406 / 2422 | 0.52 / 0.86 |
| `nova concentrated(40)` | 18.4 | 568 / 3371 | 0.50 / 0.82 |
| `nova concentrated(60)` | 18.9 | 650 / 3853 | 0.56 / 0.91 |
| `nova[+55% damage]` (warrior) | 14.3 | 629 / 3754 | 0.71 / 1.17 |
| `nova[+55% damage] concentrated(60)` (warrior) | 20.6 | 1007 / 5972 | 0.79 / 1.30 |
| `nova[+55% damage, +50% size] concentrated(60) large` (warrior) | 26.0 | 1007 / 6041 | 0.63 / 1.04 |
| `bolt` (ranger) | 4.8 | 448 / 448 | 1.51 / 0.42 |
| `bolt concentrated(60)` (ranger) | 11.1 | 717 / 717 | 1.05 / 0.29 |
| `bolt[+55% damage, pierce 3] lightning lightning concentrated(60)` (ranger) | 23.6 | 1657 / 3313 | 1.14 / 0.63 |
| `orb[+55% damage, +50% size] lightning concentrated(60)` | 22.7 | 1278 / 5111 | 0.91 / 1.01 |
| `nova[+55% damage] lightning lightning concentrated(60)` | 26.6 | 1502 / 8906 | 0.92 / 1.50 |
| `bolt[onhit] nova[+55% damage, +50% size] lightning lightning` (ranger) | 14.6 | 448 / 4978 | 0.50 / 1.52 |
| the same with `concentrated(60) large` on the Nova | 19.1 | 448 / 7696 | 0.38 / 1.80 |
| `nova[onexpire] zone[after 0.3s, +55% damage] fire cold concentrated(60) nova[+55% damage, +50% size] lightning concentrated(60)` | 32.0 | 2733 / 14114 | 1.38 / 1.97 |

A Concentrated Nova buys damage at about the plain Nova's rate per Force, and on a Bolt at a worse one, so it is a way to put more damage in one cast for more Force and a slot, not a cheaper way to deal damage. The random search with Concentrated, one per shape (206 of 300 compiled), found nothing above 1.67x (`zone[after 0.7s, +31% duration] nova[+12% size, +55% damage] lightning lightning concentrated(54)`). The harness packs stand close together, so the smaller area costs less there than it will in play.

## Kit sigils at table rolls (owner, 2026-10-01; built 2026-10-01 on `feat/no-starters`, not deployed)

The kits' hand-set rolls were clamped into the drop tables, and the per-kit numbers on the Tuning tab (live tuning phase 2, the Skill balance group) went with the starter rule. Balance is done on the runes and sigils instead: rune affix ranges per tier in Rune balance, sigil affix ranges in Sigil balance, and the base shapes.

Measured with the parity harness (29 casts at the 0.35 s v1 cadence, damage per Force over the run, single target / pack; "before" is the kit as it was on `main` before the change):

| Kit | Class | Force before / after | Per Force before (single / pack) | Per Force after | Change single / pack |
|---|---|---|---|---|---|
| Multishot | Ranger | 19.2 / 16.7 | 0.77 / 2.32 | 0.34 / 1.03 | -55% / -55% |
| Fireball | Mage | 20.4 / 19.9 | 1.98 / 7.10 | 1.68 / 6.92 | -16% / -3% |
| Frozen Orb | Mage | 21.6 / 23.6 | 1.49 / 5.72 | 1.39 / 4.73 | -7% / -17% |
| Blink | Mage | 16.2 / 15.0 | 0.74 / 2.94 | 0.80 / 2.40 | +8% / -18% (dash 285 units, v1 321) |
| Flame Cleave | Warrior | 16.7 / 17.8 | 1.34 / 6.67 | 1.26 / 7.52 | -6% / +13% |
| Bone Spear | Binder | 15.5 / 14.8 | 1.40 / 2.79 | 1.46 / 2.92 | +5% / +5% |

Damage per cast: Multishot 430 / 1290 to 167 / 500, Fireball 1174 / 4202 to 967 / 3996, Frozen Orb 934 / 3584 to 950 / 3235, Blink 348 / 1380 to 348 / 1044, Flame Cleave 650 / 3231 to 651 / 3882, Bone Spear unchanged (627 / 1254; the harness measures no difference between pierce 3 and 4). The other 14 kits held only in-table rolls and did not change.

- **Multishot** lost the owner's buff almost entirely (+300% damage became +55%): it is back to about 1.5x its v1 damage. The first live pass would raise it with rune or shape numbers.
- **Fireball** hits a single target 18% softer (+100% became +55% on the Orb), and the Orb is a little faster without its -15% speed.
- **Frozen Orb** lost its slowed, shortened, weaker orb (no drop rolls a drawback) and pulses every 0.2 s instead of 0.18 s: the orb itself hits harder, the shards come less often, it costs 2 Force more, and it peaks at 40 entities, the cap.
- **Blink** dashes 11% shorter (+69% speed became +50%).
- **Flame Cleave** lost its -40% size, so the ring is the full Nova size: more pack damage, and no longer close around the warrior.
- **Bone Spear** pierces 3 instead of 4 and costs less.
- The best kit to one target (Freezing Arrow, 2.13) and to a pack (Exploding Arrow, 7.71) did not change, so the damage-per-Force report of `forcePerDamage.test.ts` measures against the same numbers.

## Planned: damage types, implicits, ranged rolls, aura payloads (owner, 2026-09-30)

- **Damage packets:** every hit carries physical, fire, cold and lightning amounts instead of one number plus an element tag.
- **Shapes** get a base damage range as an implicit ("Deals 8 to 14 physical damage").
- **Infusions** (Fire, Cold, Lightning) convert the shape's physical damage to their element and bring burn, chill or shock. New affixes "Adds X to Y fire / cold / lightning damage" add damage on top without converting. Poison (built with the Hound) joins as a type.
- **Resistances later:** build the per-type packets now; monster resistances and defence affixes are a follow-up.
- **Every rune has an implicit** rolled at drop (Large: +20 to 40% area; Swift: speed; Split: a copy range; Timer: a delay; infusions: conversion and status chance; shapes: base damage), plus affixes; tiers by item level lift the implicit range. No two runes alike.
- **Ranged per-cast rolls:** an affix rolls a range at drop ("Splits into 1 to 4", "+20 to 60% damage", "Pierces 0 to 3"); the server rolls inside it on every cast. Force priced at the average; the live cap and entity budget use the maximum. Starter sigils keep fixed values so the v1 parity tests hold.
- **No stacking:** every rune is a single item; the stash rune tab (a sortable, filterable list) handles bulk. Conversion splits plain stacks into single runes with a middle implicit roll; rune prices by rolls. Bag: nothing special for now.
- **Visuals follow the damage mix:** lightning sparks, fire flames and embers, cold spiky ice crystals, physical a dark iron shimmer; mixed spells show both. Damage a hotter core and more sparks, duration longer trails, pierce a sharper streak, impact a shockwave ring, doubled infusions a denser shell, two infusions a two-tone swirl, release kinds a small glyph on the parent (ticking ring for "every", a fuse for "after"), rolled runes a faint rune-script sheen. Built on the VFX system ([vfx.md](vfx.md)).
- **Aura payloads:** Aura and Bond may carry releases (the rule against releases on persistent shapes goes): `Aura [on hit], Fire, Orb` throws a fireball at the enemy the aura just burned; `Aura [every 1 s], Cold, Nova` pulses around the caster. Two triggers: "on hit" (the aura damages an enemy; payload aimed at it) and a new "when struck" (the caster is hit; payload aimed at the attacker), as trigger runes and release affixes. An internal cooldown per aura release (about 0.5 s, config); the aura keeps reserving spirit; each payload costs Force when it fires, as if cast.
- **Righteous Fire bargain:** a rare aura affix, "Burns you for X% of its damage; deals Y% more damage" (for example 20% / 60%); plain fire auras stay safe.
- **Balance:** Force pricing and the damage-per-Force search tests cover the new types, ranges and aura payloads.
- **Order:** before the forge redesign (which then shows implicits and ranges). Item-moving parts (no stacking, conversion) get the loss and duplication review.
