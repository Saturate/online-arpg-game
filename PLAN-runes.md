# Plan: spellcraft and styles

Status: proposal, nothing built. Decisions so far come from the owner; open points are marked **Open**.

## Goals

- Spells are built left to right, like a Noita wand. The order of the runes is the puzzle.
- Make a ball, turn it into fire, lightning or cold before it fires, split it, link the copies, release something from it. Every step is a rune.
- Triggers and tuning live on runes as affixes, so there is no Timer rune and no hidden tuning.
- Built-in skills and hand-built spells are the same thing: a sigil holding rolled runes.
- The forge costs gold. Rune affixes only come from drops and the rune trader.
- Three styles, melee, ranged and spell, replace classes. Each has its own sigils, weapons and minions, and all of them drop. Uniques bend the rules, for example binding minions of any style.

## Runes

Four kinds, read left to right.

| Kind | Applies to | Runes (first set) |
|---|---|---|
| **Shape** | starts a spell or a payload | Spell: Orb (slow, big), Bolt (fast, thin), Beam, Nova, Zone. Weapon: Arrow, Strike, Cleave, Throw, Trap. Any: Dash |
| **Infusion** | the current shape, before it fires | Fire, Cold, Lightning |
| **Shaper** | the current shape's count, motion or casting | Split, Link, Orbit, Homing, Bounce, Chain, Stack, Charge |
| **Effect** | what happens on contact | Impact, Ward, Restore |

Spell shapes scale with spell damage; weapon shapes scale with the weapon you hold. That is a soft gate: anyone can fire an Arrow rune, but it is weak without a bow.

Persistent shapes stay as today: Aura, and the ally tether, renamed **Bond** so **Link** can mean "join the copies". Later shape: Wall.

**Beam** is a channelled line from the caster toward the cursor: it costs Force every tick while held, hits what it touches on a tick interval, and turns with the aim. Runes work on it like on any shape: `Beam`, `Fire` burns; `Beam`, `Split 3` fans three beams; `Beam [every 0.5 s]`, `Nova` pulses explosions where it ends; `Beam`, `Chain 3` arcs off the first target. It needs two engine pieces the other shapes do not: a held-cast state (the skill keeps firing while the button is down, like Frozen Orb's pulse but tied to the caster), and a line hit test against enemies each tick. The client draws it from the caster's predicted position to the aim, so it never trails behind the hero.

**Charge** is a shaper that turns any shape from cast-on-press into hold-to-power-up, release-to-fire. On a Beam it replaces the sustained burn with one piercing lance; on an Orb the ball grows, on an Arrow the shot pierces further, on a Nova the ring widens. Damage and size scale with the time held, in stages up to a cap (for example three stages over 1.5 s), and the shape narrows and brightens while charging so others can read it. Release affixes still apply: `Beam [on release]`, `Charge`, `Split 3`, `Bolt` fires the lance, then sprays bolts where it ends. Charge-rune affixes tune it ("charges 40% faster", "+1 stage", "moving does not reset the charge"). Charging and channelling share the held-cast state Beam needs, so one engine piece serves both.

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

## Ground effects merge instead of stacking

Today every zone ticks on its own (`sim/spells.ts` `updateZones`), so overlapping zones all hit the same target, and `Split 6` into zones deals six times the damage. Fireball's damage comes from exactly that (see the comment in `data/skills.ts`). Payload spells make it worse.

- **Same caster, same kind (fire, cold, lightning, heal, ward): merge.** A new zone overlapping one of yours grows the existing one toward the new area and refreshes its duration, capped at **Open** twice its original area. Fewer entities, a spreading pool on screen, never more than one zone's damage.
- **Safety rule:** a target takes at most one tick per kind, per caster, per tick interval, however many of that caster's zones it stands in.
- **Stack rune:** a shaper rune that lets the current spell's zones stack up to a limit before they merge. Its number affix sets the limit (2 to 4, higher from deep zones). It takes a slot, so stacking is a build choice with a cost. Only a unique lifts the cap. Example: `Orb [on expire]`, `Fire`, `Split 4`, `Zone`, `Stack [up to 3]`.
- **Different casters still stack**, so party play pays off. Heal and ward zones follow the same rules.
- **Later, with the combo codex:** different kinds combine, such as fire on cold ground making steam.

**Shipped ahead of the rework as the lockout rule only** (no geometric merging): one tick per target, per caster, per kind, per interval. Zone damage went from 6 to 14 per tick and Fireball was retuned; see DECISIONS.md. The Stack rune will raise that one tick to its limit.

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

## Styles instead of classes

Three styles: **melee**, **ranged** and **spell**. Each has a family of sigils, weapons and minions, and every piece drops.

| | Melee | Ranged | Spell |
|---|---|---|---|
| Sigils | Warmarks: Strike, Cleave, Throw | Quivers: Arrow, Trap | Grimoires: Orb, Bolt, Nova, Zone |
| Weapons | swords, axes, maces | bows, crossbows | staves, wands, sceptres |
| Minions | warrior mates: Shieldbearer (taunts), Banner-bearer (aura), Berserker | hound (pins), hawk (marks), trapper | elementals, acolyte (heals), undead |
| Own runes | e.g. Rend, Cleave arcs | e.g. Mark, Volley | e.g. Consecrate, Corpse shapes |
| Affixes that only drop for it | e.g. "hits twice", "shockwave on kill" | e.g. ricochet, "falls from above" | e.g. "payload inherits element", "orbits caster" |

- **A character picks a starting style** (**Open**: or picks one of today's five classes, each mapped to a style). That gives a starting kit, cheaper Force on the style's shapes and runes, base stats (armour, life, spirit), and **which minion family it can bind**.
- **Sigils of every style work for everyone.** A melee character can carry a grimoire; it costs more Force and hits with spell damage, which melee gear does not raise. Hybrids are possible, just not free.
- **Minions follow style.** Each style binds its own family through vessels, so a ranged character runs a hound and a hawk, a melee one a shield wall.
- **Rare affixes may break a rule once, never freely.** A rare vessel affix, *Kindred*, lets one minion of another style join your warband; only one such minion at a time. The same principle holds for every rule-breaking affix: it permits one of a kind (one extra multicast, one foreign minion, one free rune), and the unique version is the only way to lift the limit fully.

### Minion abilities

Minions today only have a basic attack. They get abilities with cooldowns, built on the same ability data monsters already use (`data/enemies.ts`: slam, shoot, ring, blast, leap, each with a cooldown and a telegraph), so a minion ability is data, not new code, wherever a monster already does the same thing.

- **Every minion type has one or two base abilities.** A Shieldbearer taunts every 10 s, a Banner-bearer plants a banner (an aura) every 20 s, a hound leaps to pin, an elemental casts a nova, a skeleton archer fires a volley.
- **Vessels can roll ability affixes.** A magic or better vessel can roll an extra ability ("casts Frost Nova every 8 s", "leaps to the master's target", "explodes on death") or a modifier to one it has ("taunt cooldown 30% shorter", "volley fires 2 more arrows"). Rarer tiers roll stronger ones. The rule-break principle holds: one extra ability per vessel, never a list.
- **Minion abilities cost no Force** and are paced only by cooldowns, so a summoner's power comes from spirit and vessel rolls, not from spamming.
- **The minion AI decides when:** cooldown ready, a target in range, and for support abilities (heal, banner) an ally that needs it. Stance still applies: Follow never uses offensive abilities.

### Uniques

A new top item tier with fixed, hand-made affixes that bend the rules. First ideas:

- **Crown of the Many:** bind minions of any style.
- **Quiver of Embers:** spell shapes fired from it use bow damage.
- **The Open Hand:** no weapon; every weapon shape uses your spell damage instead.
- **Gravebound Warmark:** each kill with a melee shape raises a skeleton for 10 s.
- **Echoing Grimoire:** multicast +1, but every cast costs life as well as Force.

Uniques drop rarely, only from bosses and deep zones, and are the endgame chase alongside wand-stat sigils.

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
4. **New shapers and Beam:** Link, Orbit, Homing, Bounce, Chain, Charge, and the channelled Beam shape.
5. **Forge gold cost and the rune trader.**
6. **Styles:** character creation, weapon shapes and scaling, style runes, style minions, uniques.
   **Minion abilities** can come earlier, on their own: base abilities for today's three minion types plus vessel ability affixes need no other phase.
7. **Force rebalance** with numbers on the admin page, endgame affix tiers, and the combo codex.

## Open questions

1. Keep Swift and Large as plain runes as well as affixes?
2. Rune trader stock: per player or shared server-wide?
3. Existing characters: convert or wipe?
4. Character creation: pick one of three styles, or keep the five classes as starting kits mapped onto the styles (Warrior melee; Ranger ranged; Mage, Priest and Binder spell)?
