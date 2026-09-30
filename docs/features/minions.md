# Minions

Status: Live. Vessels and minions since the first build (M5, 2026-09-28); the warband limited by spirit and the stronger minions since 2026-09-29. The Hound pack built 2026-09-30, not pushed.

## What it does

- **The Binder keeps a warband of minions.** Each minion comes from a **vessel**, an item holding one minion: its type, level and affixes. Equip a vessel and its minion appears; unequip it and the minion goes.
- **Four minion types:**

| Type | Life | Speed | Damage | Cooldown | Range | Style |
|---|---|---|---|---|---|---|
| Zombie Brute | 220 | 150 | 14 | 1 s | 30 | melee tank |
| Skeleton Archer | 90 | 180 | 10 | 0.9 s | 330 | ranged, keeps 170 units away |
| Wraith | 110 | 265 | 12 | 0.5 s | 26 | fast melee, hunts |
| Hound (a pack) | 130 | 205 | 11 | 0.8 s | 24 | a Leader and 1 to 6 packmates, hunts; see "The Hound pack" |

  These are the data values; every minion also gets 1.5x damage and 1.4x life on top, plus 10% per vessel level.
- **Stances** on T, cycling Aggressive, Defensive, Follow:
  - Aggressive (the default): engages within 520 of the minion, leash 900.
  - Defensive: engages within 260 of the master, leash 320.
  - Follow: never engages.
- **A dead minion respawns after 10 s** (shorter with the Faster Respawn affix).
- **Binders start with one minion,** a common, bound Zombie Brute vessel.
- A Bond (the Soul Link starter) can target your own minions as well as allies ([runes.md](runes.md)).

### The Hound pack

One Hound vessel binds a whole pack: a **Leader** and **1 to 6 packmates**, drawn with the Grave Hound's model (the owner's brother's dog) in the bound minions' green; the Leader is 1.25x the size and a darker green, packmates 0.78x.

- **Pack size is a vessel roll by tier** (packmates beside the Leader, stored as `pack` on the vessel):

| Tier | Packmates |
|---|---|
| common | 1 to 2 |
| magic | 1 to 3 |
| rare | 2 to 4 |
| relic | 3 to 6 |

- **The Leader:** 1.35x life and 1.15x damage of the hound numbers. It pounces with the monster `leap` ability data (the Grave Hound's pounce with a longer reach): cooldown 6 s, 110 to 480 units (the monster's is 400), a 0.25 s crouch with no telegraph since it is an ally, 0.5 s in the air, 24 damage in a 60 radius. The landing pins every enemy under it for 1 s (not bosses or knockback-immune monsters) and poisons them. Every 14 s while it fights it howls: the whole pack moves 25% faster and bites 20% harder for 6 s. Its bite is plain.
- **Packmates:** each has `0.55 / sqrt(n)` of a hound's life and damage (n packmates), moves 1.15x faster and bites 1.15x as often. Every bite poisons ([monsters.md](monsters.md), "Poison"). They take their Leader's target and circle it to their own angle (1.25, -1.25, 2.2, -2.2, pi and 0.6 rad from the Leader's side), so the pack flanks. Out of a fight they trot in a loose ring behind the Leader.
- **Why those numbers:** the packmates together are worth 0.55 of a hound with one, 0.78 with two, 1.1 with four and 1.35 with six, so a whole pack is 1.55 to 2.35 hounds rather than up to 7. A relic pack is clearly the better find, but it pays in fragile bodies (41 life each at level 1 with six packmates) that area damage hits all at once.
- **One vessel's spirit:** the pack reserves exactly what the vessel reserves (15 to 30 by tier plus 5 per affix), however many dogs it has.
- **At most 12 dogs per player.** Every Leader counts; the packmates share what is left of 12 in warband order, so two relic packs of six field 6 and 4. A pack vessel is refused once 12 Leaders are bound. When a pack is unbound the others fill up at once.
- **When the Leader dies** the pack fights on without it: packmates pick their own targets, bite at 0.7x and lose the howl until it is back. Dead packmates wait for the Leader: they return when it respawns, or when it howls if they have been down at least the respawn time (10 s, less with Faster Respawn). Nothing else brings them back.
- **Stances apply:** Follow never engages, so the Leader never pounces or howls in Follow.
- **Drops:** the Hound is one of the four types a vessel drop picks from. The unique **Brothers Creation** ([items.md](items.md)) is a relic Hound vessel with the full six.

## Why

- **Spirit is the real limit, not slots.** The warband has 24 slots, a ceiling no build reaches, so saves and the protocol keep a fixed size. Each vessel reserves 15, 20, 25 or 30 spirit by tier, plus 5 per affix, and the server refuses an equip past maximum spirit. There is no separate army cap any more: M5's cap of 6 per player, with 4 warband slots, went when the warband grew to 24.
- **One starting minion:** the Binder started with a Zombie Brute and a Skeleton Archer, and two free minions on top of the class made it clearly ahead.
- **Minions hit 50% harder and have 40% more life** than their data: they died too fast and hit too softly to be worth their spirit.
- **Vessels are Binder-only.** Other classes are refused when equipping.
- **Behaviour affixes, at most one per vessel** (they share an affix group):
  - **Bodyguard:** takes the front of the formation, 60 units out (plus 26 per row), engages only within 180 of the master with a 240 leash, steps into bullets aimed at the master within 260, and gets a +14 hitbox against enemy bullets. Minions are checked before players, so it intercepts.
  - **Hunter:** multiplies its engage radius and leash by 1.6, and scores rares as closer (their squared distance times 0.1, about 3.2x closer). Wraiths hunt by default at 1.25x; the two do not stack.
  - **Coward:** retreats below 30% life, heals 5% of its life per second while retreating, and returns at 80%.
- **Other vessel affixes:** hasted, extra projectiles (an archer volley, 0.15 rad spread), armored, regenerating, attack speed, explodes on death (40 fire damage times the roll, radius 95), taunts (a pulse every 1 s that holds enemies for 1.5 s), leech for master (10% of damage heals the master), faster respawn.
- **Movement without pathfinding:** a minion walks straight when it can, and otherwise follows the newest crumb of its master's breadcrumb trail that it can see. One more than 700 units from its master is pulled back beside them and drops its target, as most ARPGs do. Beyond 400 it catches up at 1.6x speed.
- **Focus:** minions chase what their master hit within the last 60 ticks, and drop a target out of sight for 40 ticks.

## How

- Data: `packages/shared/src/data/minions.ts` (types, `STANCES`); vessel affixes and `BEHAVIOUR_AFFIXES` in `data/affixes.ts`.
- AI: `packages/shared/src/sim/minions.ts` (`engageRules`, `navigate`, formation, intercept, coward and taunt logic, `updateMinionRespawns`). Death, explosion and leech in `sim/combat.ts`. Bodyguard interception in `sim/spells.ts`.
- Vessels: `VesselItem`, `createVessel`, `vesselSpirit`, `STARTER_VESSELS` in `packages/shared/src/items/items.ts`; spirit summed by `spiritReservedFor` in `sim/auras.ts`; equip checks in `sim/inventory.ts`.
- Numbers: `MINIONS`, `HOUND_PACK`, `SPIRIT` and `NAV.minionTeleportDistance` in `packages/shared/src/config/sim.ts`.
- The pack: `packmateCounts`, `packVesselCount`, `fillPack`, `howl`, `startLeap`, `flankPoint` in `sim/minions.ts`; `PlayerComp.packs` (live packmates and when dead ones fell, per warband slot) and `MinionComp.pack` in `sim/ecs.ts`; death hooks `onPackmateDeath` and `onPackLeaderDeath`, called from `kill` in `sim/combat.ts`; the pack roll and `vesselPackmates` in `items/items.ts`. The snapshot marks each dog `pack: 'leader' | 'mate'`; the client draws the Leader with `minion_hound_leader` and packmates with `minion_hound` (`render/assets.ts`, `render/characters.ts`), and the `howl` and `pounce` events as a dark ring of dust (`render/fxEvents.ts`).
- Rendering: the Brute and Archer use model files; the Wraith is a procedural model (`apps/client/src/render/models.ts`, `minionModel`).
- Tuning: all eight numbers per type, and the model and height of the Brute and Archer, can be overridden on the admin page's Minions tab and apply to new spawns ([monsters.md](monsters.md), "Tuning overrides").

```ts
interface VesselItem { uid; kind: 'vessel'; tier; name; ilvl; affixes: AffixRoll[]; minion: MinionTypeId; level: number; bound? }
// level = max(1, ilvl) + tier index + a roll of 0 or 1
```

Invariants:

- Spirit reserved by vessels and persistent skills never exceeds the character's maximum.
- Saves from the old 4-slot warband are padded to 24.
- A minion link target that dies is cleared, because a respawned minion is a new entity.

Tests:

- `packages/shared/test/minions.test.ts`: minions focus the master's last hit, follow the breadcrumb trail around a wall, and archers do not fire without line of sight.
- `packages/shared/test/systems.test.ts`: one minion per equipped vessel, respawn after the cooldown, vessels refused for other classes, follow stance never engages, refusing to equip past maximum spirit, interest management sends your own minions.
- `packages/shared/test/tuning.test.ts`: minion overrides at spawn; minion shots always expire.
- `packages/shared/test/houndPack.test.ts`: pack size by tier from the table, a Leader and packmates for one vessel of spirit, packmate scaling (six together about sqrt(6) times one, under 1.2 Leaders), the 12-dog cap and refill when a pack is unbound, the refusal at 12 Leaders, Leader death (survivors fight on without the howl, the dead return with the Leader), packmates take the Leader's target and poison, the pounce and howl, and Follow using neither; Brothers Creation fields the full pack.

## Limits and open questions

- The Hound pack pathfinds like every minion: along its master's trail. After a dev teleport (no trail) packmates behind a wall or fence stay stuck until the master is 700 units away and pulls them over; seen in the browser check at the Mossy Barrens town fence.
- The Leader's pounce has no telegraph and minion tuning cannot edit its numbers (the admin tuner edits the eight stat numbers only).
- Minions other than the Hound only have a basic attack. Planned: abilities with cooldowns, built on the monster ability data (slam, shoot, ring, blast, leap), so a minion ability is data wherever a monster already does the same thing. Every type gets one or two base abilities (a Shieldbearer taunts every 10 s, a Banner-bearer plants a banner aura every 20 s, a hound leaps to pin, an elemental casts a nova, a skeleton archer fires a volley). Magic or better vessels can roll one extra ability or a modifier to one they have, never a list. Minion abilities cost no Force and are paced by cooldowns; the AI uses one when it is ready, a target is in range, and for support abilities an ally needs it. Follow never uses offensive abilities. A vessel can come with a rolled special ability such as a random sigil its minion casts on a cooldown. This can ship on its own, before the style work ([runes.md](runes.md), "Planned").
- The data's `guard` and `kite` default behaviours are not read by the code; only `hunt` is. Kiting comes from `ranged` and `kiteDistance`.
- The systems test for "refuses vessels over spirit" only asserts the class refusal.
