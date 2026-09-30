# Runes and spells

Status: v2 (phases 0 to 3 of the rework) pushed to `main` on 2026-09-30 and built on 2026-09-29. v1 runes went live on 2026-09-28. Phase 4 onward is planned (see "Planned" below).

## What it does

Every skill is a sigil holding runes, read left to right like a Noita wand. The order of the runes is the puzzle. Make a ball, turn it into fire, lightning or cold before it fires, split it, release something from it: every step is a rune.

- **Shapes** start a spell or a payload: Orb (slow and big), Bolt (fast and thin), Nova, Zone, Dash, and the persistent Aura and Bond.
- **Infusions** give the current shape an element: Fire, Cold, Lightning.
- **Effects** change what happens on contact: Impact (knockback), Ward (shield), Restore (heal).
- **Shapers** change the current shape's count or motion: Split today.
- **Triggers** release a payload: On Hit, On Expire, Timer, Pulse, On Land. A **release affix** on a rolled shape rune does the same without taking a slot.
- **Swift and Large** stay as plain modifier runes (+30% speed, +50% size) that teach the system early.

Examples, in the text form the Spell Lab and the starter sigils use:

- `bolt[onhit] fire nova`: a bolt that bursts into a fire nova where it hits (Exploding Arrow).
- `orb[every 0.18s, ...] cold split(3) bolt`: a slow orb spraying three cold shards every 0.18 s (Frozen Orb).
- `orb[onhit, -15% speed, +100% damage] fire nova[after 0.5s] zone[+30% duration]`: Fireball; it bursts on hit, the nova releases burning ground half a second later.

The forge shows each spell as a sentence ("Fires a slow cold orb. Every 0.2 s: 4 small bolts."), names every rule a draft breaks, and previews it on a dummy ([forge.md](forge.md)).

### Rune kinds

| Kind | Castable today | Read by the grammar, not castable yet (phase 4) |
|---|---|---|
| shape | orb, bolt, nova, zone, dash, aura, bond | beam, arrow, strike, cleave, throw, trap |
| infusion | fire, cold, lightning | |
| shaper | split | link, orbit, homing, bounce, chain, stack, charge |
| effect | impact, ward, restore | |
| trigger | onhit, onexpire, timer, pulse, onland | |
| modifier | swift, large | |

Only castable runes drop, roll, or appear in the forge's pool. The rest are named by the compiler as "not in the game yet".

### Rolled runes

A rune drops plain or rolled. Plain runes stack 20 to a cell. Rolled runes carry rune affixes, are single items and never stack. About 20% of rune drops are rolled; a rolled rune gets 1 affix (common), 1 to 2 (magic), 2 to 3 (rare) or 3 (relic), with affix tiers gated by item level (T2 from 3, T3 from 5; magic caps at T2).

| Affix | T1 | T2 | T3 | On |
|---|---|---|---|---|
| speed | +10 to 20% | +20 to 35% | +35 to 50% | orb, bolt, dash |
| size | +10 to 20% | +20 to 35% | +35 to 50% | orb, bolt, nova, zone, aura |
| duration | +15 to 30% | +30 to 50% | +50 to 75% | orb, bolt, zone |
| damage | +10 to 20% | +20 to 35% | +35 to 55% | orb, bolt, nova, zone, dash |
| pierce | 1 | 1 to 2 | 2 to 3 | orb, bolt |
| split count | 2 to 3 | 3 to 4 | 5 to 6 | split |

Release affixes (at most one per rune, suffixes): on hit (orb, bolt, dash), on expire (orb, bolt, nova, zone), after 0.3 to 1.2 s (orb, bolt, nova, zone, dash), every X s (orb, bolt, zone; T1 0.4 to 0.6, T2 0.3 to 0.45, T3 0.2 to 0.3), on landing (dash).

### Sigils are wands

A sigil holds whole rune items in its slots. Slots: common 3, magic 4, rare 5, relic 6, plus `sigil_slots` (+1 to +3) and +1 when corrupted, capped at 10; a starter sigil always fits its runes. The sigil's affixes are its wand stats:

| Affix | Range (T1 / T2 / T3) | Effect |
|---|---|---|
| reduced Force cost | 5 to 12 / 12 to 20 / 20 to 30% | lowers the sigil's Force multiplier |
| split efficiency | +0.05 to 0.12 / 0.12 to 0.2 / 0.2 to 0.3 | added to the 1.2 split conservation |
| max depth | +1 (from T2, so magic or better at item level 3+) | one more payload level |
| reduced spirit | 8 to 15 / 15 to 25 / 25 to 35% | persistent skills reserve less |
| increased area | 8 to 15 / 15 to 25 / 25 to 40% | radius |
| increased damage | 10 to 20 / 20 to 35 / 35 to 55% | damage |
| rune slots | +1 / +1 to 2 / +2 to 3 | capacity |
| cast delay | 5 to 10 / 10 to 18 / 18 to 25% | shortens the cast cooldown |
| multicast | +1 (T3 only: rare or relic from item level 5) | shapes cast together |
| first rune is free | T3 only: rare or relic from item level 5 | waives the first rune's base cost, within limits |

Four sigils sit on keys 1 to 4; left and right mouse cast the picked skill slots.

### Starter sigils

The 20 built-in skills are common sigils holding pre-rolled runes, so their numbers are readable, copyable and improvable. A sigil only shows its starter name and description while its slots still hold the starter's runes, in order. 30% of sigil drops carry a random starter's runes, unbound.

| Class | Starter | Runes |
|---|---|---|
| Mage | Fireball | `orb[onhit, -15% speed, +100% damage] fire nova[after 0.5s] zone[+30% duration]` |
| Mage | Frozen Orb | `orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage] cold split(3) bolt` |
| Mage | Static Nova | `nova[+50% size] lightning` |
| Mage | Blink | `dash[+69% speed]` |
| Warrior | Leap Slam | `dash[onland] impact nova[+50% size]` |
| Warrior | War Cry | `nova[+50% size] impact` |
| Warrior | Flame Cleave | `bolt[-50% duration, +60% size] fire split(3)` |
| Warrior | Iron Skin | `aura ward` |
| Ranger | Multishot | `bolt[pierce 2, +60% damage] split(3) split(3)` |
| Ranger | Exploding Arrow | `bolt[onhit] fire nova` |
| Ranger | Freezing Arrow | `bolt[onhit] cold zone` |
| Ranger | Evade | `dash[+30% speed]` |
| Priest | Holy Nova | `nova[+50% size] restore` |
| Priest | Prayer | `aura restore` |
| Priest | Sanctuary | `zone[+75% duration] restore` |
| Priest | Smite | `bolt[pierce 2] lightning` |
| Binder | Soul Link | `bond ward` |
| Binder | Bone Spear | `bolt[pierce 4, +50% speed, +40% damage]` |
| Binder | Corpse Blast | `nova[+50% size] fire` |
| Binder | Frost Mire | `zone[+75% duration] cold` |

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
- **Base costs:** orb 10, bolt 8, nova 14, zone 16, dash 12; fire 4, cold 4, lightning 5; impact 5, ward 5, restore 6; triggers 2 (pulse 3); swift and large 3; Split 2 per copy. The v1 numbers carried over, except the triggers, which dropped from 4 (pulse 6) to 2 (3) so the v1 payload skills keep their hand-set prices.
- **Payloads:** a payload's base runes pay 15% for its first spawn. The v1 skills were priced by hand far below what a depth surcharge gave (Exploding Arrow 16 against 47 by formula), and this share reproduces those prices: a payload only goes off when the cast lands, and the entity cap and depth limit already bound a chain. Split is exempt, since copies multiply the cast.
- **Payload riders pay at least 50%:** a payload's number affixes and the runes that only change it (elements, effects, Swift, Large) cost at least half their listed Force. At 15%, a Bolt releasing a `nova[+50% size, +55% damage]` dealt over twice a starter's pack damage per Force.
- **Repeat spawns pay again,** scaled by the damage one spawn can land: 60% of the full price when a flying shape (bolt or orb) released it, the full price otherwise (zone, nova or dash). A ring sprayed from a moving orb is further weighted by how little of it faces one target (copies x 0.26 rad / 2 pi). At the first-spawn share alone, a Zone releasing a Nova every 0.2 s dealt about 8x a starter's damage per Force.
- **Number affixes** cost 3 per plain-rune step they stand for, on a log scale: `3 * ln(1 + v/100) / ln(step)`, with steps speed 1.5 (dash 1.3), size 1.5, duration 1.75, damage 2 and pierce 2 extra hits (the v1 Swift, Large, Linger and Pierce runes). A negative roll refunds half.
- **"First rune is free"** waives at most a Bolt's base cost (8) of the first rune, never its affixes or its release, and a cast with it still pays at least 95% of its full price. The roll is worth about 5%; anything more let one-rune spells reach 4 to 6x a starter's damage per Force.
- **Aura and Bond cost no Force** and reserve spirit per rune: aura 30, bond 25, fire, cold, lightning and impact 10, ward and restore 12, swift 5, large 8.
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
- **The cast cooldown is 0.35 s** (shortened by the cast delay affix and cast speed). That is what the old 0.3 s actually waited because of a float remainder; the remainder is fixed and every skill kept its cadence.
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

- **Every starter stays within 15% of its v1 Force and 10% of its v1 damage** (single target and pack), measured by the same harness against `test/fixtures/skill-baseline-v1.json`.
- **No spell from castable runes goes above 2x the best starter's damage per Force.** A random spell search (8000 spells per seed) found nothing above about 2.13x; a seeded 300-spell version runs in the tests.
- **Multishot and Flame Cleave kept their weak v1 numbers;** measured buffs are under "Open questions".
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
- Starters: `packages/shared/src/data/starterSigils.ts`. Affixes: `data/affixes.ts`. Sigil items and capacity: `items/items.ts` (`sigilCapacity`, `matchingStarter`, `misfireChance`). Class affinities: `data/classes.ts`.
- Numbers: `HEAT`, `SPELL`, `AURA`, `LINK`, `AILMENTS` in `packages/shared/src/config/sim.ts`; `FORGE` in `config/forge.ts`.

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

Rule ids: `empty`, `unknown-rune`, `unknown-affix`, `bad-count`, `first-rune-shape`, `affix-not-allowed`, `trailing-release`, `one-release`, `release-not-for-shape`, `onrelease-needs-hold`, `release-interval`, `multicast`, `shaper-not-for-shape`, `link-needs-split`, `split-once` (Splits multiply up to 12), `split-count`, `duplicate-shaper`, `persistent-alone`, `persistent-no-release`, `persistent-no-split`, `persistent-no-charge`, `dash-root-only`, `charge-root-only`, `max-depth`, `entity-cap`, `plain-modifier-off`, and from the compiler `over-capacity`, `rune-not-castable`, `engine-not-ready` (homing, bounce, or releasing on a held button).

Admin tunables (Settings tab, [accounts-admin.md](accounts-admin.md)): the level-1 Force bar (50 to 5000), a cost multiplier and a cooling multiplier (0.1 to 10), and the cooling ramp cap (1 to 20). They apply to everyone at once; the cost multiplier applies at cast time, not in the compiler.

Tests:

- `packages/shared/test/skillParity.test.ts`: all 20 starters within 15% Force, 10% damage (single and pack) and 5% dash distance of v1, exact spirit and cast count.
- `packages/shared/test/forcePerDamage.test.ts`: 44 hand-picked spells and 300 seeded random spells (seed 20260930) stay under 2x the best starter's damage per Force, single and pack.
- `packages/shared/test/grammarV2.test.ts`: the plan's examples, every rule, ambiguous cases, the tokenizer.
- `packages/shared/test/compile.test.ts`: castability, named engine gaps, multicast, multi-shape payloads, affixes, capacity, Force by depth, affinity and affixes, spirit, starters compile for their class.
- `packages/shared/test/spellEngine.test.ts`: the exact 0.35 s cooldown, multicast, `after` outlasting its shape, per-node speed and size, orb phasing.
- `packages/shared/test/payloadInfusion.test.ts`: inherited infusions reach the snapshot and the damage element.
- `packages/shared/test/entityBudget.test.ts`: the budget's peak equals the engine's for 12 interval spells.
- `packages/shared/test/liveCap.test.ts`, `zoneStacking.test.ts`: the weighted cap, room cap, departed players; one caster's zones do not stack.
- `packages/shared/test/runeRolls.test.ts`, `forceRates.test.ts`, `skillBaseline.test.ts`, `runeGlyphs.test.ts`, `spellSnapshots.test.ts`, and the "heat" and fixture blocks of `systems.test.ts` (cooling, overheat cap, misfire, duds at half Force, SPEC fixture spells in play).
- `apps/client/test/studio.test.ts`: the Spell Studio prices starters exactly like the game.

Dev tools ([dev-tools.md](dev-tools.md)): the **Spell Lab** reads any rune list with the full grammar (phase 4 runes included), shows the verdict, errors, sentence, tree and budget, and hands castable spells to the **Spell Studio**, which casts them at dummies and exports a `starterSigils.ts` entry.

### History: v1 runes and prebaked skills

Replaced by v2; kept so old saves, tests and numbers make sense.

- **v1 grammar (SPEC, M2):** Form, Element, Effect, Modifier (Swift, Large, Linger, Pierce), Trigger and Action (Split) runes. Orphan forms (`bolt nova`) and Split on Dash were duds. Timer fired once, after 0.5 s or when the form ended, whichever came first. Heat was charged by depth (`1 + 0.5 * depth`). v2 replaced the depth surcharge with the payload share, made two shapes in a row a multicast, and made `after X` fire at X even after its shape ended.
- **v1 misfire** ran from 0% at 100 heat to 50% at 130, with a 0.3 s global cast cooldown; the same shape now scales with the bar (1000 to 1300) and the cooldown is 0.35 s.
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
- **Rare affixes break a rule once, never freely.** A rare vessel affix, *Kindred*, lets one minion of another style join your warband; only one at a time. The same holds for every rule-breaking affix: it permits one of a kind (one extra multicast, one foreign minion, one free rune), and only the unique version lifts the limit fully. This is why multicast and "first rune is free" only reach +1 and only on rares.

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

- **Multishot and Flame Cleave** kept their weak v1 numbers (about 4 and 13 damage per cast, against 100+ for Fireball). Measured proposals, not applied:
  - Multishot: `bolt[pierce 2, +300% damage] split(5)`: Force 19.2, 430 single target, 1290 into a pack (v1: 115 / 344).
  - Flame Cleave: `bolt[-50% duration, +60% size, +200% damage] fire split(3)`: 574 / 1149, but Force 22.6 (+40%). At the v1 price, a burning ring instead: `nova[-40% size, +50% damage] fire`: Force 16.7, 650 / 3231.
- **Repeating payloads** (`every`, Pulse) now cost 60 to 250 Force per cast, since they pay for each release; players who built them will read it as a nerf. Phase 7's rebalance revisits it. Frozen Orb stays near its v1 price because its ring is weighted as mostly missing.
- **Fireball and Leap Slam** sit near the top of the 15% Force band (+13%); a retune should keep them inside it.
- **A once-off payload at its base price** can still reach about 2.1x the best starter's damage per Force.
- **"First rune is free"** is now only worth about 5% of a cast. Decide whether to keep it, drop it from the rolls or replace it.
- **Skill tooltips show the base Force,** not the admin's cost multiplier.
- **Swift and Large as plain runes** are behind a grammar flag (`plainModifierRunes`), on in the game.
- The rune trader, zone merging, the Stack rune and endgame tiers are not built.
- `SPELL.timerSeconds` duplicates `DEFAULT_TIMER_SECONDS` and only a test reads it. `runes/v2/examples.ts` still carries the plan's older Fireball text (`+30% damage`, `zone[long]`).
