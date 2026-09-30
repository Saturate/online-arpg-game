# World streaming

Status: Step 1 built (monsters far from every player sleep on the server), not pushed. Steps 2 to 4 are planned.

## What it does

- **Each room's map is cut into chunks** of 1000 units (`STREAMING.chunkSize`). A chunk is awake while a player, alive or waiting to respawn, or any player's minion is within 2 chunks (2000 units, `STREAMING.awakeChunks`) of its nearest point. Every other chunk sleeps.
- **Idle monsters in sleeping chunks are skipped** by the monster systems: no AI, idle shuffle, movement, knockback drift, curse aura, cooldown or ability timers, separation or terrain settling. Their state does not change at all, so a monster resumes exactly where it stopped, with no catch-up burst.
- **Only idle monsters sleep.** A monster that is aggroed (chasing, fighting, walking home after the leash), mid-action (a wind-up, charge or leap), pinned, or still sliding from a knockback stays awake wherever it is. A chase can lead out of the awake area without freezing halfway, and a monster that walks home and goes idle falls asleep at the next recompute.
- **Anything that hits a sleeper wakes it on the same tick:** `dealDamage` calls `alertPack`, which aggroes it and its idle packmates, and the sleep check reads `aggro` every tick.
- **Wave maps never sleep anything:** waves (the Arena, the testground) spawn aggroed, and the sandbox's flat map is smaller than the awake radius from its middle, so builder spawns stay awake.

## Why

- One player in the Mossy Barrens had 232 monsters thinking every tick. Tick cost grew with the zone's area, not with where people are, which rules out bigger zones.
- **2000 units against an interest radius of 1100.** A player only receives entities within `NET.interestRadius` (1100). A sleeper is at least 2000 units from every player at each recompute; between recomputes (every 5 ticks, 0.25 s) a player at 220 units per second covers 55 units, so a monster never wakes inside anyone's view. Arrivals, departures and any player or minion that moved more than 250 units since the last recompute (a portal, a waypoint, a minion teleport) force a recompute on the same tick, before the monsters run. `streaming.test.ts` walks a player across a zone and checks every tick that no sleeper is within 1600 units.
- **Round, not square:** a chunk counts as near when its closest point is within 2000 units, so the corners of a 5 by 5 block stay asleep.
- **Recomputed 4 times a second, not per monster per tick.** A recompute marks the awake chunks around each anchor, then puts every idle monster in a sleeping chunk into a set. Per tick a monster costs one `aggro` read and one set lookup.
- **Sleepers still size the separation grid.** The cell size of the enemy separation hash sets the order overlapping pairs are pushed in, so it is computed over every monster; otherwise a sleeper far away could change results next to a player by a rounding error.
- **An empty simulation keeps everything awake.** The server does not tick a room without members, and tests and tools that run monsters without a player behave as before.

## How

- `packages/shared/src/sim/streaming.ts`: the chunk grid, the recompute (`updateStreaming`), `sleepingEnemies` and `isAsleep`, `chunkAwake`, `streamingStats`, and `setStreaming` to switch it off for tests and the bench. The state sits in a `WeakMap` beside the simulation, like the monster state in `enemies.ts`.
- `sim/systems.ts`: `streaming` runs first in the tick, after input, so this tick's positions decide who sleeps.
- `sim/enemies.ts`: the main monster loop, separation and terrain settling skip sleepers.
- Numbers: `STREAMING` in `packages/shared/src/config/sim.ts`.

What still runs for sleepers, and why:

- Ground hazards, pending spawns (summons, splits, raises), homing shots, corpse timers and projectiles run as before: they are not the sleeper's own AI, and a hazard already on the ground must finish.
- Statuses (burn, poison, ailment timers) and rare regeneration still loop over every monster in `updateStatuses`. A sleeper cannot have an ailment (it would have been hit and aggroed), and an idle monster is at full life (it heals on getting home), so both are no-ops for sleepers.
- The flow field (`updateNav`), wave counting and the server's snapshot serialisation still see every monster.

### Measurements

`pnpm bench:streaming` (`scripts/streaming-bench.ts`): players in god mode walk small circles without casting, so monsters near them wake and fight the whole time; 600 measured ticks after 60 of warm-up. "Step" is `Simulation.step`; "room" adds serialising entities and one interest-filtered snapshot per player, as the server does every tick. Milliseconds on the development Mac, 2026-09-30.

Today's zones, one player at the zone's spawn:

| Zone | Monsters | Asleep | Step median off / on | Step p95 off / on | Room median off / on |
|---|---|---|---|---|---|
| barrens | 197 | 116 | 0.091 / 0.048 | 0.152 / 0.066 | 0.106 / 0.061 |
| steppe | 169 | 82 | 0.135 / 0.075 | 0.426 / 0.332 | 0.189 / 0.119 |
| gloomvale | 201 | 109 | 0.094 / 0.057 | 0.342 / 0.306 | 0.111 / 0.070 |
| thornwood | 220 | 106 | 0.137 / 0.087 | 0.378 / 0.339 | 0.158 / 0.109 |
| dunes | 221 | 117 | 0.108 / 0.064 | 0.353 / 0.313 | 0.123 / 0.079 |
| hollows | 255 | 125 | 0.141 / 0.091 | 0.383 / 0.344 | 0.162 / 0.107 |

A big zone (the Ashen Steppe generator at 3x the width and height, 15600 by 10800, packs scaled to the area), players spread over a grid:

| Players | Monsters | Asleep | Step median off / on | Step p95 off / on | Room median off / on | Room p95 off / on |
|---|---|---|---|---|---|---|
| 1 | 1442 | 1233 | 0.855 / 0.293 | 1.773 / 1.237 | 0.963 / 0.399 | 1.884 / 1.346 |
| 4 | 1476 | 695 | 1.100 / 0.742 | 3.724 / 3.375 | 1.287 / 0.904 | 3.914 / 3.547 |
| 8 | 1441 | 249 | 1.343 / 1.199 | 4.346 / 4.138 | 1.781 / 1.591 | 4.846 / 4.559 |

- The median falls by 35 to 50% in today's zones and by 66% in the big zone with one player. Today's zones are 5200 to 7400 units wide, so a 2000 unit radius wakes about half of them.
- With 8 players spread over the big zone their awake circles cover most of it (249 of 1441 asleep), so the gain is small: sleep only helps where nobody is.
- **The p95 is the flow field, not the monsters.** `updateNav` rebuilds a multi-source search from every player and minion every 5th tick (0.9 ms with one player, 2.9 ms with 8 in the big zone), which lands in the top 20% of ticks. Its reach is capped at 90 nav cells per target, so it grows with players, not zone area.
- Per system with one player in the big zone: monsters 0.82 ms a tick without sleep, 0.25 ms with it; the recompute itself is 0.01 ms averaged over ticks (0.05 ms when it runs).

Tests: `packages/shared/test/streaming.test.ts`

- the awake radius clears the interest radius with margin;
- sleepers do not change at all over 100 ticks, while the same monsters shuffle with streaming off;
- walking across a zone wakes monsters ahead and never leaves a sleeper within 1600 units;
- a player arriving next to a sleeper wakes it on that tick;
- a hit aggroes a sleeper, which chases through sleeping chunks while awake, then walks home once its target is dead and sleeps again;
- the same seed and inputs with and without sleep give identical events and monster and player state within 1800 units of the players, in a zone fight and in a dungeon (whose boss wakes and aggroes when reached);
- the Arena and the sandbox (with a builder's spawns in the far corners) sleep nothing and match a run without streaming exactly.

## Limits and open questions

- **An aggroed monster whose target stays alive beyond the leash never goes home.** Once it steps back inside the leash distance it picks its target again, walks out, is leashed, and so on, so it hovers at the leash edge and stays awake as long as its target lives anywhere on the map. This was already so before streaming; a leash with some hysteresis (go home until back within, say, 300 units of home) would fix both.
- The server still serialises every entity in the room every tick and filters per player afterwards. That is step 2's to fix.
- Monster packs that straddle the edge of the awake area can overlap a sleeper without being pushed apart, 2000 units from anyone. Nothing sees it.

## Planned

- **Step 2, client chunked rendering and snapshots:** the client builds and draws terrain, scenery and ground by chunk around the camera instead of the whole map, and the server keeps entities in a chunk index, so serialising and interest filtering only touch chunks near each player.
- **Step 3, chunk-based generation:** zone generation places rivers, ridges, forests and packs per chunk from the zone seed and the chunk's coordinates, so a chunk can be built on demand and the same everywhere; the server generates monster packs for a chunk when it first wakes.
- **Step 4, bigger zones:** with cost following players, zones can grow well past 5200 by 3600 (the bench's 15600 by 10800 runs a player at 0.3 ms a tick). Open: how big, how waypoints and zone exits spread across it, and whether the flow field needs to go per chunk too.
