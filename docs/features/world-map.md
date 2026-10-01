# World map

Status: Stage 1 built 2026-10-01, not pushed: the world plan, one world room per world copy, levels and density by distance, region names on the HUD and the waypoint menu. Stages 2 to 4 (gate bosses, respawn by inactivity, save conversion, minimap names and fog) are planned. Builds on [world-streaming.md](world-streaming.md), steps 1 to 3.

## What it does

- **One seamless world per world copy:** a 13000 by 13000 map, 9 times a zone of before (5200 by 3600). The town, Emberwatch, sits in the middle, and three roads leave its north, east and south gates. There is no loading between areas; the world streams in by chunk as you walk.
- **Each road has a third of the circle to itself** and runs out to the map edge through the home region round the town (Mossy Barrens), its own region and, on two roads, a second region past a gate:

| Road | First region | Past its gate |
|---|---|---|
| North gate, bending north-west | Gloomvale (marsh) | The Hollows (cave) |
| East gate | Ashen Steppe (ruins) | Sunscorched Dunes (desert) |
| South gate, bending south-west | Thornwood (forest) | Deep Thornwood (forest) |

- **The roads branch like a tree:** spurs in the home region, branches at the region's entrance, at its crossroads, between the crossroads and the gate, and past the gate, and side valleys off the longer branches. The world a local server opened (seed 904226) has 166 road segments.
- **Dead ends hold something:** each region's deepest dead end its boss (the biome boss with an escort, over a pack), two dead ends per region a dungeon entrance (one in the home region), and the rest a rare pack (a rare leader a level up, a quarter more monsters) or a chest that drops two items, magic or better, once per world copy.
- **Side valleys hold camps and ruins:** up to five camps in the home region and four in each other, and one or two ruins, set 300 to 700 units off the road.
- **Difficulty grows with distance from town:** monster level runs from 1 at the gates to 25 at each road's farthest branch end, on a curve that starts slow (`1 + 24 t^1.3`, t the distance over that road's farthest end's). On seed 904226 the regions' bands are Mossy Barrens 1 to 7, Gloomvale 6 to 22, The Hollows 15 to 25, Ashen Steppe 5 to 21, Sunscorched Dunes 10 to 25, Thornwood 5 to 25 (a region's band runs from its nearest road point to its farthest branch end, so bands overlap where branches of the first region reach further than the second region's start). Packs come more often further out (0.7 to 1.4 times, and fewer far from any road) and are bigger (0.85 to 1.35 times).
- **Regions keep their zone's look:** ground colour (blended over a few hundred units at the borders, on the ground, the grass and the minimap), monster pool and boss, more forest in Thornwood and less in the Dunes, more dead trees in the bleak ones. Ridges along the borders between the three sectors keep each road's regions apart beyond the home region; most sectors have a river bending round them past the home region, bridged wherever a road crosses it.
- **Waypoints:** the town's (everyone has it), and on each road one at the region's entrance, one at its crossroads and one just past the gate: ten in all. The menu lists them in that order with the monster level round each; found ones travel there.
- **Gates:** each road's trunk has a gate node halfway out from the home region, where the second region starts. It is marked in the plan and the map (`WorldMap.gates`) and everything past it knows it lies behind it; it is passable until stage 2.
- **Dungeons and the Arena stay separate rooms.** A dungeon is entered from its entrance in the world and left back beside that entrance. The Arena is entered from the town as before.
- **The HUD and the party frames name the region** you stand in (the town's name in town).

## Why

- **One map, one room:** the world feels connected, roads can branch freely, and a party can split over the world and still see each other on the minimap. Streaming (sleeping monsters, chunked rendering, generation by chunk) keeps the cost tied to where players are: one player out on a road ticks at 0.3 ms median.
- **Sectors and border ridges:** a tree only reads as a tree if the branches do not run into each other. Each road owns a third of the circle; branches stay 6 degrees inside its edges and 760 units from roads they do not belong to; the ridge along each border makes the next road's region a walk back through the home region, which is what a gate boss will need to mean anything.
- **Distance along the roads, not as the crow flies:** a branch end beside the trunk's far end is as hard as the trunk's far end only if it is as far to walk. A spot off the road counts 0.6 of its distance to the road on top of the road's.
- **The curve:** a straight line from 1 to 25 over 7000 to 8000 units of road would put level 6 at the edge of the home region; the 1.3 power keeps the first region's entrance at about 5.
- **Per road, not per world:** the east gate faces the map's east edge 6500 out, where the other two bend toward corners, so the east road is the shortest. Scaled to the world's deepest end it topped out at level 15 on one seed; scaled to its own, every road ends at 25 and climbs a little faster per unit walked where it is short.
- **Waypoints a step off the road** (140 units to the side): walking the road does not trigger the menu offer at every crossroads; you touch a waypoint by going to it, as in D2.
- **A town edit regenerates the world round it:** the roads start at the town's gates (the ends of its paths that reach an edge through a gap in the fence, `townExits`), so a town whose gates move needs a new plan. A town with fewer than three gates gets roads from the middle of its north, east and south edges.
- **The town is moved, not rebuilt:** `layoutToMap` builds it in its own coordinates as before (the live town's pins `oz7hq8` and `1yv56t2` still hold), and `placeTown` shifts every shape, stall and portal to the middle of the world. The town editor works in town coordinates; the map says where the town's origin is (`WorldMap.townAt`).

## How

- **Plan:** `packages/shared/src/world/worldPlan.ts`, `WorldPlan`. Pure and seeded (`world:road:<k>`, `world:branches:<k>`, `world:spots` streams). Input: the seed, the map size, the town's rectangle and its three exits. Builds the trunks (450-unit steps aimed off the sector's middle by up to 20 degrees, turning at most 0.32 rad a step, kept inside the sector), then the branches (420-unit steps), then the spots (`boss`, `dungeon`, `rare`, `chest`, `camp`, `ruin`). Nodes carry their walking distance (`depth`), region, road and the gate they lie behind (`behind`); edges are the road segments. Lookups (`regionAt`, `distanceAt`, `levelAt`, `biomeAt`, `packWeight`, `packScale`, `forestWeight`) go through the nearest road, found from a lazy 250-unit grid of candidate edges (a cell keeps the edges within its nearest edge's distance plus a diagonal, so the answer is exact). Numbers: `WORLD` in `config/sim.ts`.
- **Map:** `world/worldMap.ts`, `worldZone(seed, layout, size?)`: roads as ground (`road` capsules, 52 wide on trunks, 40 on branches, which every generated placement keeps 34 off), rivers (`riverCourse`, `bridgesOver`: a course that would run alongside a road anywhere but at a crossing is dropped and another tried; `addPathRiver` in `gen.ts` cuts the water at each bridge), border and loose ridges, ruins at the plan's spots (`addRuin`, shared with the Wilds), the town (`placeTown`), waypoints (`WorldMap.waypoints`, portals with `waypoint` ids), chests (`WorldMap.chests`) and gates (`WorldMap.gates`), then a `ZoneWorld` with the plan in its spec.
- **Chunk generation:** `world/zoneGen.ts`: with `ZoneSpec.plan` the zone takes biome and level by position, weights each chunk's forests and packs by the plan at its middle, scales pack sizes, and places bosses, rares, dungeon entrances and camps at the plan's spots (`placePlanned`, `placePlannedEntrances`, `placeCamps(..., spots)`) on open, reachable ground within 260 to 360 units. Everything else (phases, spill, per-chunk streams, collision by chunk, spawning on first wake) is step 3's, unchanged.
- **Descriptor:** `{ kind: 'world', seed, layout? }` (`world/types.ts`), cached by `loadMap` under `world:<seed>:<layout hash>`; `freshWorld` builds one uncached for tests and benches. `waypointArrival`, `entranceArrival` and `placeName` in `maps.ts`.
- **Chests:** `sim/chests.ts`, a system after `players`: the first living player within 70 opens one; it drops a bag in front of the chest through `spawnBag`, like the dungeon cache.
- **Server:** `apps/server/src/manager.ts`: `worldRoom(inst)` (`<instance>-world`, seed from the instance seed) replaces the zone rooms; `useWaypoint` checks you stand on a waypoint, have found the destination (the town's is everyone's) and that it is in this world, then teleports within the room (`Room.placeMember`) or carries you in; the `wilds` portal (a dungeon's exit, the antechamber's way back) goes back to the world room beside the entrance of the dungeon it came from; `replaceTown` rebuilds the world room and puts everyone back where they stood; party frames name the region (`Room.placeName`) and say `town` only inside the town. `accounts.ts` keeps every waypoint id in a save (`isWaypointId`), the old zones' included.
- **Client:** `game/game.ts` looks the region up every 120 units walked (`updatePlaceName`) for the HUD and minimap label, and the respawn line names the town (`spawnName`); `ui/WaypointPanel.tsx` lists `def.waypoints`; `render/props.ts` tints ground tiles per vertex (`regionTint`, an 8 by 8 grid per chunk tile), grass per chunk and dead trees per region; `render/minimap.ts` fills regions in their colour; the town editor starts at the hero's spot less `def.townAt`.
- **Saves (temporary, until stage 3):** a save has no position or room, so every character joins in the town, as before. Its waypoint list keeps the old zones' ids (`barrens`, `steppe` and so on) untouched; they unlock nothing in the world and are not offered in the menu, and new world waypoints are added beside them. Nothing else in a save changes.

### Measurements

`NODE_OPTIONS=--expose-gc pnpm bench:streaming` (`scripts/streaming-bench.ts`), development Mac, 2026-10-01. "Whole" builds every chunk and spawns every pack at creation; "chunks" is the live behaviour.

Room creation, mean of 4 rooms, then a player arriving in town and 20 ticks:

| Map | Mode | Create ms | Heap MB | Arrive + 20 ticks ms | Heap MB after | Monsters | Chunks built / generated |
|---|---|---|---|---|---|---|---|
| World 13000x13000 | whole | 27.8 | 4.86 | 12.7 | 5.18 | 2031 | 169 / 169 |
| World | chunks | 16.7 | 1.62 | 7.2 | 2.30 | 126 | 24 / 117 |
| Wilds 5600x4200 | chunks | 2.2 | 0.28 | 6.7 | 0.73 | 77 | 20 / 30 |

Players walking from the town out along the roads to branch ends at 220 units a second (god mode, monsters chasing them), chunks building and packs spawning as they go:

| Players | Ticks | Step median / p95 / max ms | Room median / p95 / max ms | Monsters at the end | Chunks built |
|---|---|---|---|---|---|
| 1 | 727 | 0.30 / 1.47 / 6.0 | 0.37 / 1.54 / 6.0 | 723 | 96 |
| 4 | 862 | 1.32 / 4.30 / 5.2 | 1.58 / 4.60 / 5.5 | 1948 | 160 |
| 8 | 727 | 1.51 / 5.33 / 6.6 | 1.89 / 5.78 / 7.3 | 2024 | 166 |

Players standing apart over the world (at waypoints and branch ends, 2500 or more apart), walking small circles, sleep on, 600 ticks:

| Players | Monsters | Awake | Asleep | Step median / p95 ms | Room median / p95 ms |
|---|---|---|---|---|---|
| 1 | 243 | 199 | 44 | 0.15 / 1.33 | 0.17 / 1.35 |
| 4 | 1041 | 878 | 163 | 0.75 / 3.82 | 0.90 / 3.98 |
| 8 | 1975 | 1832 | 143 | 2.09 / 6.30 | 2.49 / 6.72 |

- **A room's tick stays under 8 ms** at worst with 8 players fighting in different corners, against a 50 ms tick. The p95 is still the flow field's rebuild every 5th tick (world-streaming.md, step 1).
- **Creating the world room takes 17 ms** in the bench (10 ms for the map alone once warm), against 10.5 for step 3's 9x zone. The tree of roads itself is 0.7 ms; the rest (the map's layout, the reach flood over 105,625 nav cells, the per-chunk quotas with their nearest-road lookups) was not timed apart. Room memory after the first player arrives is 2.3 MB.
- **Monsters grow with ground covered,** not with the map: a walk to one branch end spawns about 700, and 8 players spread over the world wake almost all of it (2000 monsters).

The World bench (`/admin/dev/#world/<town|road0|road1|road2>`, Chrome, 1600 by 900, the live town), the camera walked from the town spawn to a road's deepest branch end at 360 units a second:

| Scene | Build ms | Ready ms | Frames | Draw calls mean (max) | Triangles | Render CPU ms mean (p95) | Buffers MB end (max) | Late chunks |
|---|---|---|---|---|---|---|---|---|
| North road (road0) | 75 | 268 | 1472 | 110 (274) | 50,308 | 0.77 (1.2) | 2.8 (3.4) | 0 |
| East road (road1) | 34 | 205 | 1339 | 101 (218) | 36,511 | 0.87 (1.3) | 1.4 (2.9) | 0 |
| East road at night (`?time=0.85`) | 80 | 258 | 1339 | 106 (264) | 47,111 | 0.80 (1.2) | 1.3 (3.3) | 0 |
| South road (road2) | 79 | 300 | 1199 | 114 (263) | 40,953 | 0.83 (1.2) | 2.4 (3.4) | 0 |

The build includes generating the plan and the border scenery round the 13000 square edge. The first east road row ran on the shipped default town (before the road scenes fetched the live one, as they do now) and builds in 34 ms; the rows on the live town take 75 to 80. In the game, walking each road out in 300-unit hops at hero speed held 60 fps (16.7 ms frames, p95 16.8) with 171 to 244 draw calls on average and up to 574 in the thick of a fight.

A browser check on a local server (2026-10-01), screenshots in the session's scratchpad: the town square by day, the east road to the Sunscorched Dunes' end (the Sand Wyrm), back to town by waypoint, the waypoint menu, the north road to the Hollows' end (the Frost Giant, level 26) at night, into the Wormwood Tunnels' antechamber and out beside its entrance, a run started and left by town portal, the south road at night over a bridge by the Thornwood Crossroads waypoint and on to the Treant King. No console or server errors.

Tests:

- `packages/shared/test/worldMap.test.ts`: the plan is the same for a seed and differs between seeds; three roads from three gates, a third of the circle apart, every node in its own sector, each road with forks and dead ends; levels never fall along a road from the town to any branch end, start at 1 at the gate and reach 25 on every road, each road's second region starts above its first, packs come more often and bigger further out; every region has a boss and a dungeon and every region but the home one a waypoint, every road a gate with everything past it marked behind it; the old zone ids still read as waypoint ids; the world holds the town byte for byte, moved to the middle, its gates north, east and south; every portal, camp, chest and the middle of every road is reachable from the town on three seeds, with packs in every region; no pack near the town; mean pack level rises from the home region to each first region to each second; nobody in town can be hurt; touching a waypoint adds it to a save that keeps old zone ids; waypoint arrivals are on open ground off every portal; a chest drops once.
- `packages/shared/test/zoneChunks.test.ts`, `camps.test.ts`, `streaming.test.ts`, `leash.test.ts`: as before, over the world and the standalone Wilds instead of today's zones.
- `apps/server/test/worldRoom.test.ts`: one room per world copy, the whole map one room; waypoint travel within the room once found, refused when not found or off a waypoint; an old save's zone waypoints kept and the character loaded in town; a dungeon entered from its entrance and left back beside it; the Arena entrance in town and its gate back to town; admin goto across the world; a town save leaves everyone where they stood.
- `apps/server/test/partyTeleport.test.ts`: party teleport across the world within the room, and into another room (an antechamber) with a save on the way; frames name the region and carry a position in the same room; `dungeonExit.test.ts`: the exit leads back beside the entrance.

## Seams for the stages to come

- **Stage 2, gate bosses:** `WorldPlan.gates` (id, node, road, region, heading) and `WorldMap.gates` (id, spot, heading) mark each pass; every node past a gate has `behind` set to its id, and so does every waypoint past it (`WaypointInfo.behind`). A gate boss spawns at the gate's spot; the movement block is a line across the road at the gate (the sector border ridges already stop a walk round it beyond the home region, but rivers and the open home region do not, so the block wants a band across the whole sector, or a ridge at the gate radius). `useWaypoint` is the one place to refuse a waypoint whose `behind` the character has not passed.
- **Stage 3, respawn by inactivity:** packs spawn per chunk on first wake (`wakeChunks` in `sim/streaming.ts`, `spawned` per chunk); a chunk's packs come from `ZoneWorld.packs(cx, cy)` and a stream of its own (`packs:<cx>,<cy>`), so a respawn is that chunk spawning again with a stream that counts respawns. Chests reopen by clearing their index in `sim/chests.ts` (`opened`).
- **Stage 3, save conversion:** a save's `waypoints` keeps the old zone ids; a natural map is `barrens` to `town`, `steppe` to `east-1`, `dunes` to `east-3`, `gloomvale` to `north-1`, `hollows` to `north-3`, `thornwood` to `south-1`. `isWaypointId` accepts both.
- **Stage 4, minimap names and fog:** `WorldPlan.regionAt` gives a spot's region and `regionTable` its level range; the minimap already colours regions (`render/minimap.ts`, `drawBase`). The minimap's 256-pixel tiles cover the whole world at its 0.025 pixels per unit, so drawing them generates every chunk's obstacles at load (the World bench shows all 169 generated); smaller tiles would follow the hero.

## Limits and open questions

- **The world regenerates with fresh monsters when a builder saves the town**, everywhere, and its whole plan changes if the town's gates moved. Everyone stays where they stood.
- **The town editor's preview shows the town alone** in its own coordinates, as before; other players and monsters keep drawing at their world positions, so in the editor they appear off to the side of the town.
- **Chests show no opened state:** a chest someone opened looks the same; walking up to it does nothing. A world copy's chests come back when its room closes (5 minutes empty) and regenerates.
- **Dungeon names repeat:** 11 entrances draw from the 6 dungeon names.
- **Regions share one ground texture;** only the colour changes. Desert dunes and caves have no terrain of their own yet (themes per road are for later).
- **Roads differ in length,** so levels climb faster per unit walked on the shorter ones (the east road on most seeds).
- **Two players in different regions share one simulation:** a busy copy of 15 (the hard cap) has not been measured; 8 spread out tick at 2.5 ms median.
- Waypoints into dungeons were read as "a waypoint leaves a dungeon's world": there are no waypoints inside dungeons; a dungeon's exits lead back to the world beside its entrance.
