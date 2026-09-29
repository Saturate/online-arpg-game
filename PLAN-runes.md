# Plan: spellcraft and affinities

Status: proposal, nothing built. Decisions so far come from the owner; open points are marked **Open**.

## Goals

- Spells are built left to right, like a Noita wand. The order of the runes is the puzzle.
- Make a ball, turn it into fire, lightning or cold before it fires, split it, link the copies, release something from it. Every step is a rune.
- Triggers and tuning live on runes as affixes, so there is no Timer rune and no hidden tuning.
- Built-in skills and hand-built spells are the same thing: a sigil holding rolled runes.
- The forge costs gold. Rune affixes only come from drops and the rune trader.
- Classes become affinities: everyone can cast anything and bind minions; an affinity makes some things cheaper and unlocks its own runes and minions.

## Runes

Four kinds, read left to right.

| Kind | Applies to | Runes (first set) |
|---|---|---|
| **Shape** | starts a spell or a payload | Orb (slow, big), Bolt (fast, thin), Nova, Zone, Dash |
| **Infusion** | the current shape, before it fires | Fire, Cold, Lightning |
| **Shaper** | the current shape's count or motion | Split, Link, Orbit, Homing, Bounce, Chain |
| **Effect** | what happens on contact | Impact, Ward, Restore |

Persistent shapes stay as today: Aura, and the ally tether, renamed **Bond** so **Link** can mean "join the copies". Later shapes: Beam, Wall.

The modifier runes (Swift, Large, Linger, Pierce) and the trigger runes (Timer, On Hit, On Expire, On Land, Pulse) go away and become affixes. **Open:** keep Swift and Large as runes too, for players who have no rolled runes yet.

### Rune affixes

A rune drops plain or rolled. Plain runes stack 20 to a cell as today. Rolled runes are single items.

- **Release affix** (shapes only, at most one): releases the payload *on hit*, *on expire*, *after X s* (X rolls 0.3 to 1.2), *every X s* (the old Pulse), or *on landing* (Dash). A shape with a release affix carries everything after it as its payload.
- **Number affixes:** speed, size, duration, damage, pierce N, bounce N, homing strength; on Split, the copy count (2 to 6) and spread; on Link, beam damage.
- **Tiers** come from item level, like gear affixes today. Deep endgame tiers add things like "releases twice" or "copies keep full damage".

## Reading rules

1. The first rune must be a shape.
2. Infusions, effects and shapers apply to the most recent shape.
3. If a shape has a release affix, everything after it is its payload, spawned where and when it releases. The payload inherits the parent's infusion unless it has its own.
4. Two shapes in a row with no release between them are cast together, up to the sigil's **multicast**. Beyond that, the editor says so.
5. **Split N** replaces the current shape with N copies. **Link** after a Split joins those copies with beams that hit whatever crosses them. **Orbit** makes copies circle the caster, or their parent if they are a payload.
6. Limits stay: depth, the entity cap and Force. When a spell breaks a rule, the editor names the rule and the rune that broke it. No hidden reasons.

### Your examples

- **Winter orb:** `Orb [slow, every 0.2 s]` then `Cold`, `Split 4`, `Bolt [small]`. A slow cold orb spraying four shards on every pulse.
- **Linked balls:** `Orb`, `Lightning`, `Split 3`, `Link`. Three orbs fan out with lightning between them. Swap Link for Orbit plus Link and they circle you as a shield.
- **Endgame:** `Orb [on expire]`, `Fire`, `Split 6`, `Orb [on hit, homing]`, `Nova`, `Zone [long]`. A fireball bursts into six homing embers, each exploding and leaving burning ground.

## Sigils are wands

A sigil's affixes are its wand stats:

- rune slots (3 to 10)
- Force cost multiplier
- cast delay
- multicast (shapes cast together)
- rare rolls: "payloads inherit the parent's element", "copies orbit you", "+1 depth", "first rune is free"

The built-in skills become starter sigils holding pre-rolled runes. Fireball is `Orb [on hit, -15% speed, +30% damage]`, `Fire`, `Nova [after 0.5 s]`, `Zone [long]`. Its numbers become readable, copyable and improvable.

## Forge and rune trader

- **Forge:** each saved change costs gold, scaled by the rune count and tier. Runes taken out come back to the bag, or go to pending when it's full, never lost. The free test bench for builders stays.
- **Rune trader** (new town NPC): the stock refreshes every **Open** 30 minutes. Mostly plain common runes at low prices. Now and then one rolled rare rune at a high price. **Open:** stock per player, or shared server-wide like the trader shelf, where a rare shows up for everyone and the first buyer gets it (with a chat line when one appears).

Both are gold sinks, which the economy needs once selling stacks is priced by count.

## Affinities instead of classes

The five classes become affinities picked at character creation: Might (Warrior), Hunt (Ranger), Arcane (Mage), Faith (Priest), Death (Binder). An affinity gives:

- a starting kit (sigils, runes, one minion)
- cheaper Force for its runes (affinity cost is visible in the editor once Force matters again)
- affinity-only runes, such as Faith's Consecrate or Death's Corpse shapes
- affinity minions with unique abilities. Everyone can bind minions, but only Might binds warrior mates: a Shieldbearer that taunts, a Banner-bearer with an aura. Hunt gets a hound and a hawk, Arcane gets elementals, Faith gets an acolyte that heals, Death keeps the undead.
- Death stays the best summoner: minions reserve less spirit and the army cap is higher.

Base stats (armour type, life, spirit) stay per affinity, as class stats are today.

## Force has to bite again

The cap is 1000 today, so nothing limits a big spell. It comes back down to roughly 100 to 150, with overheat and misfire as the spec intended. Every skill needs a tuning pass after that, which is the strongest reason to put balance numbers on the admin page first.

## Existing characters

**Open.** Two live accounts. Options: convert (starter sigils rebuilt as the new starter kits, loose runes converted one to one where the rune still exists, trigger and modifier runes refunded as gold) or wipe sigils and runes.

## Build order

Each phase ships on its own and gets the item review before deploy.

0. **Item bugs from the review:** the trader stack dup, bound runes, runes lost with a full bag, stack prices. The rune item changes build on these.
1. **Prototype in Spell Studio** (dev tools only): the new rules and affixes in the shared compiler behind a flag, so spells can be felt before saves change.
2. **Rolled runes:** rune affixes on items, drops, and the forge editor rebuilt around left to right with a live sentence ("Fires a slow cold orb. Every 0.2 s: 4 small bolts.") and a preview on training dummies.
3. **Sigils as wands:** wand-stat affixes, built-in skills converted to rolled runes, save conversion.
4. **New shapers:** Link, Orbit, Homing, Bounce, Chain.
5. **Forge gold cost and the rune trader.**
6. **Affinities:** character creation, affinity runes, affinity minions.
7. **Force rebalance** with numbers on the admin page, endgame affix tiers, and the combo codex.

## Open questions

1. Keep Swift and Large as plain runes as well as affixes?
2. Rune trader stock: per player or shared server-wide?
3. Existing characters: convert or wipe?
4. Affinity names: keep Warrior, Ranger and so on, or rename (Might, Hunt, Arcane, Faith, Death)?
