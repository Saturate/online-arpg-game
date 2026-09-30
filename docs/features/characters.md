# Characters, classes and progression

Status: Live. Classes since the first build (2026-09-28), levels and XP since 2026-09-28, slowed on 2026-09-29.

## What it does

- **Five classes:** Warrior, Ranger, Mage, Priest and Binder. A class sets base life, armour, move speed, spirit, a starter kit, and which runes it casts for less Force.
- **Levels 1 to 50.** Killing monsters gives XP; each level grows life, Force, spirit and damage automatically. There is no passive tree or attribute points yet.
- **Gear needs a level:** an item can be equipped from its item level minus 2.
- **Death** leaves you down for 3 s, then you respawn with full life at the best of 12 random points, away from enemies.

| Class | Life | Armour | Move speed | Spirit | Cheaper runes |
|---|---|---|---|---|---|
| Warrior | 140 | heavy (60) | 190 | 100 | Impact |
| Ranger | 100 | light (25) | 220 | 100 | Bolt, Swift |
| Mage | 90 | robe (10) | 200 | 100 | Fire, Cold, Lightning |
| Priest | 95 | robe (10) | 200 | 150 | Ward, Restore |
| Binder | 95 | robe (10) | 200 | 120 | Bond |

Each class starts with its four starter sigils, bound ([runes.md](runes.md), "Starter sigils"). Binders also start with one minion, a Zombie Brute ([minions.md](minions.md)).

## Why

- **Affinity is a stand-in for rune knowledge** (SPEC): runes in the class's list cost 0.8x Force, every other rune 1.2x. The plan is to replace classes with styles later ([runes.md](runes.md), "Planned").
- **Armour is a flat divisor:** damage taken is `raw * 100 / (100 + armor)`. Heavy 60, light 25, robe 10 are the class bases; gear adds armour on top.
- **XP curve:** XP from level L to L+1 is `90 * L^1.9`: 90 for the first level, about 7.1k at 10, about 99k at 40. It was slowed from `60 * L^1.75` so level requirements on gear gate longer.
- **Monster XP:** a level-m monster is worth `6 * m^1.35`, times 4 for rares and 18 for bosses. Summoned adds (necromancer and shaman raises) give a quarter, so they cannot be farmed.
- **Low-level penalty, D2 style:** monsters more than 5 levels below you lose 15% of their XP per extra level, down to a 5% floor, so farming the first zone at level 30 pays almost nothing.
- **Party XP:** every living player within 1500 units shares a kill. The pool grows 35% per extra member, so a group levels faster than the same players alone.
- **Level growth:** per level, +6% of the class's base life, +12 Force, +1 spirit and +1.5% damage. Level damage adds to gear's "increased damage", as in PoE. Level-up refills life and Force.
- **Item requirements:** item level minus 2, so drops are usable a little early. The server checks it when equipping. Gear worn from before levels existed stays on, but cannot be re-equipped until the character reaches its level. Saves from before levels start at level 1.
- **Spawn:** the best of 12 random points, picked by distance from enemies. It started at the arena centre, which caused a respawn-death loop when enemies camped the corpse.
- **Death:** the player entity stays, drawn faded, for 3 s. Enemies ignore it and inputs are acknowledged but not applied. In the Arena the fallen stay down instead ([arena.md](arena.md)).

## How

- Classes: `packages/shared/src/data/classes.ts` (`CLASSES`, `ClassDef`). Each class still carries a `primary` attack definition from before the basic attack was removed; the simulation ignores the primary button (`sim/simulation.ts`). An `ascendancies` field is reserved and empty.
- Stats: `packages/shared/src/sim/stats.ts`. `baseStats` is class base plus level growth; `computeStats` adds equipped gear.

```ts
heatMax: forceMax + PROGRESSION.forcePerLevel * (level - 1)  // forceMax is the admin's level-1 bar
damageMult: 1 + PROGRESSION.damagePerLevel * (level - 1) + gearDamage / 100
```

- Numbers: `PROGRESSION`, `ARMOR` and `SIM` (`playerRespawnSeconds` 3, `playerSpawnCandidates` 12) in `packages/shared/src/config/sim.ts`.
- Admin tunables ([accounts-admin.md](accounts-admin.md)): the XP rate multiplies kill XP; the level-1 Force bar (`forceMax`, 50 to 5000) replaces `HEAT.max` in `baseStats`.
- Characters are saved per account, 12 per account, with names unique server-wide ([accounts-admin.md](accounts-admin.md)).

Tests:

- `packages/shared/test/progression.test.ts`: level-ups grow life and Force and refill them; party XP sharing and the bonus; the server XP rate; the low-level penalty; gear refused above your level; level and progress survive a save.
- `packages/shared/test/simulation.test.ts`: players die and respawn with full life; respawn away from enemies camping the previous spawn; no basic attack.

## Limits and open questions

- No passive tree or attribute points; levels only grow stats automatically.
- Class move speeds and life are starting values, not tuned against the current monsters.
- Classes are planned to become starting kits for three styles (melee, ranged, spell); see [runes.md](runes.md), "Planned".
