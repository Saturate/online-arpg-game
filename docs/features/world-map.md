# World map

Status: Planned (owner decisions 2026-10-01). Builds on [world-streaming.md](world-streaming.md), steps 1 to 3.

## What it does

- **One seamless world per world copy:** the town sits at the centre (0,0) and three roads leave it. There is no loading between areas; the world streams in by chunk as you walk.
- **The roads branch like a tree:** each road leads into its own region (themed later, today's zones for now), and branches split off into smaller areas: side valleys, ruins, camps, dead ends with a rare or a chest, dungeon entrances.
- **Difficulty grows with distance from town:** monster level, density and pack size rise along each road. Near town is the start, the far branch ends are the hardest.
- **Gate bosses** hold some branches: a boss guards a narrow pass, and once a character has killed it, that character can pass forever and use the waypoints beyond it. The boss respawns for others and for farming.
- **Waypoints** at each region's entrance and at major forks.
- **Quiet areas refill:** packs come back in an area no player has been near for about 10 minutes (an admin setting), never in view and never while someone is close. Bosses and gate bosses have their own, longer timer.
- **Dungeons and the Arena stay separate rooms**, entered from the world as today.

## Why

- A single map makes the world feel connected and lets roads branch freely; streaming (sleeping monsters, chunked rendering, generation by chunk) keeps its cost tied to where players are, not to its size.
- Per-character gates give a sense of progress, like Diablo 2's act bosses, without locking other players out.
- Respawning by inactivity keeps areas worth revisiting without packs popping in next to players.
- About 9x today's zone area to start: today's streaming numbers show that is comfortable; 16x to 25x needs a coarser reachability check first.

## How (plan)

1. **World plan generator:** a tree from the town: three roads, branch points, region nodes with a level range and theme (today's zone themes), gate nodes, waypoint nodes, dungeon entrances, camps. Pure and seeded, built on the chunk generator (`world/zoneGen.ts`); levels by graph distance from town.
2. **One world room per world copy:** the town and every region in one room on the server; zone gates between today's zones become roads. Dungeons and the Arena keep their own rooms.
3. **Gate bosses:** a gate is a narrow pass with a boss; a character without the gate's progress cannot pass (server-checked movement block, mirrored in client prediction from the character's own progress list); killing the boss adds it to the character's save. Waypoints past a gate need it.
4. **Respawn by inactivity:** per chunk, packs that were killed respawn when no player or minion has been within the wake range for the admin-set time; bosses on a longer timer; deterministic from the chunk stream.
5. **Save conversion:** characters stored in today's zone rooms move to the matching region's waypoint; their waypoint list maps to the new waypoint ids; checked with `pnpm runes:convert-check`-style dry run on a copy of the live database.
6. **Minimap and fog** for the big world (tiles exist from step 2), region names on the map.
7. **Measure** with the streaming benches: room creation, tick time with 1, 4, 8 players spread out, client frame time while walking.

## Limits and open questions

- Themes per road are for later.
- Party teleport and waypoints across one big room need checking.
- How many world copies one server runs with the bigger room.
