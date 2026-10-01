# World map

Status: Stage 1 built 2026-10-01, not pushed: the world plan, one world room per world copy, levels and density by distance, region names on the HUD and the waypoint menu. The save conversion (stage 3) built 2026-10-01, not pushed. Respawn by inactivity (stage 3) built 2026-10-01, not pushed. Minimap names, remembered fog and the world map (stage 4) built 2026-10-01, not pushed. Gate bosses (stage 2) are planned. Builds on [world-streaming.md](world-streaming.md), steps 1 to 3.

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
- **Cleared ground fills again:** once no player or minion has been within a chunk's wake range (2000 units of it, well past anyone's view) for 10 minutes, the packs killed there come back, and so do the chunk's opened chests. Region bosses and their escorts have their own timer, 20 minutes. Both are admin settings. A chunk where nothing was killed stays as it is; one where something was killed spawns its packs whole again, the survivors replaced.
- **Waypoints:** the town's (everyone has it), and on each road one at the region's entrance, one at its crossroads and one just past the gate: ten in all. The menu lists them in that order with the monster level round each; found ones travel there. Ids follow the region (`steppe-1`, `steppe-2`, `dunes-1`; `thornwood-3` for Deep Thornwood), so a town edit that moves a gate keeps the waypoints saves hold.
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
- **A town edit regenerates the world round it,** keeping the loot on the ground and the opened chests: the roads start at the town's gates (the ends of its paths that reach an edge through a gap in the fence, `townExits`), so a town whose gates move needs a new plan. A town with fewer than three gates gets roads from the middle of its north, east and south edges.
- **The town is moved, not rebuilt:** `layoutToMap` builds it in its own coordinates as before (the live town's pins `oz7hq8` and `1yv56t2` still hold), and `placeTown` shifts every shape, stall and portal to the middle of the world. The town editor works in town coordinates; the map says where the town's origin is (`WorldMap.townAt`).

## How

- **Plan:** `packages/shared/src/world/worldPlan.ts`, `WorldPlan`. Pure and seeded (`world:road:<k>`, `world:branches:<k>`, `world:spots` streams). Input: the seed, the map size, the town's rectangle and its three exits. Builds the trunks (450-unit steps aimed off the sector's middle by up to 20 degrees, turning at most 0.32 rad a step, kept inside the sector), then the branches (420-unit steps), then the spots (`boss`, `dungeon`, `rare`, `chest`, `camp`, `ruin`). Nodes carry their walking distance (`depth`), region, road and the gate they lie behind (`behind`); edges are the road segments. Lookups (`regionAt`, `distanceAt`, `levelAt`, `biomeAt`, `packWeight`, `packScale`, `forestWeight`) go through the nearest road, found from a lazy 250-unit grid of candidate edges (a cell keeps the edges within its nearest edge's distance plus a diagonal, so the answer is exact). Numbers: `WORLD` in `config/sim.ts`.
- **Map:** `world/worldMap.ts`, `worldZone(seed, layout, size?)`: roads as ground (`road` capsules, 52 wide on trunks, 40 on branches, which every generated placement keeps 34 off), rivers (`riverCourse`, `bridgesOver`: a course that would run alongside a road anywhere but at a crossing is dropped and another tried; `addPathRiver` in `gen.ts` cuts the water at each bridge), border and loose ridges, ruins at the plan's spots (`addRuin`, shared with the Wilds), the town (`placeTown`), waypoints (`WorldMap.waypoints`, portals with `waypoint` ids), chests (`WorldMap.chests`) and gates (`WorldMap.gates`), then a `ZoneWorld` with the plan in its spec.
- **Chunk generation:** `world/zoneGen.ts`: with `ZoneSpec.plan` the zone takes biome and level by position, weights each chunk's forests and packs by the plan at its middle, scales pack sizes, and places bosses, rares, dungeon entrances and camps at the plan's spots (`placePlanned`, `placePlannedEntrances`, `placeCamps(..., spots)`) on open, reachable ground within 260 to 360 units. Everything else (phases, spill, per-chunk streams, collision by chunk, spawning on first wake) is step 3's, unchanged.
- **Descriptor:** `{ kind: 'world', seed, layout? }` (`world/types.ts`), cached by `loadMap` under `world:<seed>:<layout hash>`; `freshWorld` builds one uncached for tests and benches. `waypointArrival`, `entranceArrival` and `placeName` in `maps.ts`.
- **Chests:** `sim/chests.ts`, a system after `players`: the first living player within 70 opens one (by spot, `chestKey`, so two arriving on one tick open it once); it drops a bag in front of the chest through `spawnBag`, like the dungeon cache. `reopenChests` fills them again (respawn by inactivity, below).
- **Respawn by inactivity:** `sim/streaming.ts`, in the streaming recompute (4 Hz). The recompute already marks the chunks within someone's wake range; it now stamps each with the tick (`lastNear`) and keeps the list of them, so a chunk on the old list and not the new one has just been left, and goes into a queue per kind (`packs`, `bosses`), a min-heap on that tick with at most one entry per chunk. Each recompute pops only the entries whose time is up: nothing walks all 169 chunks. An entry whose chunk was near again since is put back with the newer tick, and one whose chunk is near right now is dropped (leaving queues it again). When it is due, `refillChunk` reopens the chunk's chests (`packs` only), and if any monster the chunk spawned of that kind is dead, removes the living ones and spawns that kind's packs from `ZoneWorld.packs(cx, cy)` again with the stream `packs:<cx>,<cy>:<n>` or `bosses:<cx>,<cy>:<n>`, n counting the chunk's refills of that kind, so a refill comes out the same on every run. A survivor that is aggroed, casting, knocked back or standing in someone's wake range holds the refill up; it tries again every 10 seconds (`STREAMING.respawnRetryTicks`). The first spawn on wake is unchanged (one `packs:<cx>,<cy>` stream across the chunk's packs in order), now pack by pack to keep each chunk's spawned ids by kind (`spawnPackList` returns them). Times: `setRespawnTimes(sim, settings)` from `RoomManager.applySettings`, so a change applies to running rooms; `respawnTicks(sim)` reads them. Time is game time: ticks, which run only while someone is in the room.
- **Server:** `apps/server/src/manager.ts`: `worldRoom(inst)` (`<instance>-world`, seed from the instance seed) replaces the zone rooms; `useWaypoint` checks you stand on a waypoint, have found the destination (the town's is everyone's) and that it is in this world, then teleports within the room (`Room.placeMember`) or carries you in; the `wilds` portal (a dungeon's exit, the antechamber's way back) goes to the world room of the copy the player is in now, beside the entrance of the dungeon it came from; arrivals and region names read the room's own map (`waypointArrival(def, game, id)`, `entranceArrival`, `placeName(def, zone, x, y)`), never the map cache, which keeps the most recently used entries; `replaceTown` rebuilds the world room, carries the ground loot (`carryGroundLoot` in `sim/inventory.ts`, which empties the old room's ground) and the opened chests (`markChestsOpened`, by spot) over and puts everyone back where they stood; the town portal out in the world is a move to the spawn within the room; party frames name the region (`Room.placeName`) and say `town` only inside the town. `accounts.ts` converts a pre-world save's waypoint list on load (see "Save conversion").
- **Client:** `game/game.ts` looks the region up every 120 units walked (`updatePlaceName`) for the HUD and minimap label, and the respawn line names the town (`spawnName`); `ui/WaypointPanel.tsx` lists `def.waypoints`; `render/props.ts` tints ground tiles per vertex (`regionTint`, an 8 by 8 grid per chunk tile), grass per chunk and dead trees per region; `render/minimap.ts` fills regions in their colour; the town editor starts at the hero's spot less `def.townAt`.
- **Saves:** a save has no position or room, so every character joins in the town, as before. A save from before the world lists the old zones' waypoint ids (`barrens`, `steppe` and so on); it is converted once on load (see "Save conversion" below). Nothing else in a save changes.

### Save conversion

The old zones were a chain from the town out; each zone is now a region of the same name, so a character that had found a zone's waypoint gets that region's entrance waypoint, the first one a walk from town reaches:

| Old zone id | World waypoint |
|---|---|
| `barrens` | none: the home region has no waypoint and the town's is everyone's |
| `steppe` | `steppe-1` |
| `gloomvale` | `gloomvale-1` |
| `thornwood` | `thornwood-1` |
| `dunes` | `dunes-1` (behind `steppe-gate`) |
| `hollows` | `hollows-1` (behind `gloomvale-gate`) |

- **Runs once:** `parseSave` in `accounts.ts` converts the waypoint list of a save without `worldFormat: 1`, after the v1 rune conversion when the save is v1, and marks it; the save is written marked on its next save, and `Simulation.exportPlayer` always writes the marker. A marked save is read as it is.
- **Idempotent:** world ids pass through, repeats go, the town's id (`town`) is dropped since it is never listed. Converting twice gives the same list.
- **Ids it cannot map are kept,** with a warning in the server log (`conversion`): a kept id unlocks nothing, and a dropped one could not be given back if a later fix maps it. None exist on the live copy.
- **Gate progress is not granted.** A character that had found `dunes` or `hollows` had walked through every zone before it, so it has in effect been past the gate that region now lies behind (`ZONE_BEHIND_GATE`). Saves hold no gate progress yet; the conversion reports those gates (in the log and the check) but writes nothing for them. When stage 2 adds gate progress to saves, it needs a decision: grant those gates in this conversion (it has not shipped, so it can still change), or let the waypoint past the gate wait until the character kills the gate boss.
- **Dry run:** `pnpm world:convert-check <db>` copies the database, loads every character through `AccountStore.loadCharacter` on the copy, and checks each old zone id mapped, no old id left, no repeats, nothing but the list and the marker changed, converting again changes nothing, and a save written back loads the same. On a copy of live (`rune.db.live-pre-deploy4-20260930`, 2026-10-01): 7 characters, all converted (2 of them through the v1 rune conversion first), 11 zone ids mapped, 7 `barrens` dropped, no unknown ids, and 3 characters with a region past a gate (`dunes` twice, `hollows` once); all checks passed.
- Code: `packages/shared/src/world/convertWorld.ts` (`ZONE_WAYPOINT`, `ZONE_BEHIND_GATE`, `convertWorldWaypoints`, `isWorldFormat1`), `WORLD_WAYPOINT_IDS` in `worldPlan.ts` (the same ten ids on every seed), `scripts/world-convert-check.ts`.

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

- `packages/shared/test/worldMap.test.ts`: the plan is the same for a seed and differs between seeds; three roads from three gates, a third of the circle apart, every node in its own sector, each road with forks and dead ends; levels never fall along a road from the town to any branch end, start at 1 at the gate and reach 25 on every road, each road's second region starts above its first, packs come more often and bigger further out; every region has a boss and a dungeon and every region but the home one a waypoint, every road a gate with everything past it marked behind it; the old zone ids still read as waypoint ids; the world holds the town byte for byte, moved to the middle, its gates north, east and south; every portal, camp, chest and the middle of every road is reachable from the town on three seeds, with packs in every region; no pack near the town; mean pack level rises from the home region to each first region to each second; nobody in town can be hurt; touching a waypoint adds it to the list; waypoint arrivals are on open ground off every portal; a chest drops once.
- `packages/shared/test/respawn.test.ts`: no refill while someone stays in a chunk's wake range, for longer than both timers; a cleared chunk refills once nobody has been near for the time, not a moment before, with every new monster idle and out of view; coming back before the time starts the wait again; a chunk where nothing was killed is left alone; a half-cleared chunk refills whole, the survivors gone; a survivor still chasing holds the refill up until it settles; bosses come back on their own longer timer; two runs refill identically and each refill rolls anew; an opened chest fills again on the same rule; the settings' defaults (10 and 20), range (1 to 240 minutes) and a changed time applied to a running room.
- `packages/shared/test/zoneChunks.test.ts`, `camps.test.ts`, `streaming.test.ts`, `leash.test.ts`: as before, over the world and the standalone Wilds instead of today's zones.
- `apps/server/test/worldRoom.test.ts`: one room per world copy, the whole map one room; waypoint travel within the room once found, refused when not found or off a waypoint; a dungeon entered from its entrance and left back beside it; the Arena entrance in town and its gate back to town; admin goto across the world; a town save leaves everyone where they stood.
- `packages/shared/test/convertWorld.test.ts`: every world on three seeds has exactly `WORLD_WAYPOINT_IDS`; every old zone maps to its region's first waypoint and the gate it lies behind is the plan's; a zone save converts in order without repeats; world ids and the town's handled; idempotent; unknown ids kept with a warning. `apps/server/test/convertWorld.test.ts`: a v1-era save goes through the rune and the world conversion in order, joins in town, is written back marked and loads unchanged again; a v2 pre-world save converts and a marked one is left alone.
- `apps/server/test/partyTeleport.test.ts`: party teleport across the world within the room, and into another room (an antechamber) with a save on the way; frames name the region and carry a position in the same room; `dungeonExit.test.ts`: the exit leads back beside the entrance.

## Minimap and world map (stage 4)

Built 2026-10-01, not pushed.

- **Region names on both maps:** each region's name sits upright on one of its own roads, as near as possible to the middle of its road network and at least 500 units outside the town. Regions you have not entered are dimmed; the one you stand in wins a clash between names. The corner frame still names the region under it (stage 1), and the world map's title does too. The world map also writes the town's name; the corner map leaves it out, since in town it would sit on the hero.
- **Fog remembered per character, per browser:** explored ground, the regions entered and the waypoints found are kept in localStorage under `rune.fog.<character id>.<world seed>`, so the explored world survives a relog (the public world keeps its seed; a party world has its own and starts dark). The server keeps no fog, so another browser starts dark. One bit per 80-unit cell: the 13000 unit world is a 163 by 163 grid, 3.3 KB of bits, 4.5 KB stored (measured in the browser check). Written at most every 2 seconds while exploring and on leaving the room; the 16 most recently saved worlds are kept and older ones dropped. Storage that throws or is full only means the map is kept for the session. Party members' vision counts as explored, as before. Dungeons, the Arena and replays keep the session memory they had.
- **World map on M** (a new bindable action; Tab still hides and shows the corner map, Escape closes the world map first): the whole explored world, its roads, waypoints (filled once found, a hollow diamond when seen but not touched), dungeon entrances, gates (a bar across the road), portals, you and the party; no monsters or loot. It lets the mouse through and pauses nothing, so you can walk with it open.
- **Turned with the camera, like the corner map.** The camera never turns in play, so a turned world map always matches the screen and the corner map: up on the map is W, and a road that runs down-right on the map runs down-right when you walk it. A north-up map with a camera arrow would make you turn it in your head every time you look; the cost of turning is space, since the square world becomes a diamond and fills half the canvas (0.048 pixels per unit on an 880 pixel canvas instead of 0.068 north-up).
- **Gates:** drawn in iron until gate bosses land; `Minimap.setOpenGates(ids)` then colours a gate green once this character opened it and red while sealed. Wiring it to the snapshot's `self.gates` is one line in `game.ts` once stage 2 is committed.

How:

- `apps/client/src/render/fog.ts`: `FogGrid` (bitset, `markCircle` by cell middles, `markRect`), base64 encoding, `readFog`/`writeFog` with the index of saved worlds, `browserStorage`.
- `apps/client/src/render/mapLabels.ts`: `regionLabels` (placement from the plan's edges) and `fitLabels` (which names fit without overlapping).
- `apps/client/src/render/minimap.ts`: one `MapView` per drawing (the corner map, windowed in the world; the world map, always whole), each with its own scale and layout tiles; the fog is shared, drawn from a canvas of one pixel per cell scaled up with smoothing (so the explored edge is soft) and updated by clearing a pixel per newly seen cell. The region colours are looked up once per 250-unit cell and shared by every tile, and a tile only fills the cells under it (before, every tile filled the whole world). The world map redraws only when the fog, regions, waypoints or gates change or a marker moves a pixel.
- `apps/client/src/ui/WorldMap.tsx`, `worldmap.css`: the overlay, its own small store (`useWorldMap`) and the legend. `game/game.ts` feeds found waypoints from the waypoint menu message and the activation event, flushes the fog on leaving a room, and passes the store key for world rooms of live sessions.
- Tests: `apps/client/test/fog.test.ts` (bits, circle and rectangle marking, base64 round trip, per character and seed memory, wrong shape and corrupt records, the cap, storage that throws or is full) and `mapLabels.test.ts` (every region named once, each name in its own region and off the town, names 1200 units apart, deterministic, the nearest road point; overlapping names keep the higher priority, names past the edge are dropped).
- Browser check on a local server (2026-10-01), screenshots in the session's scratchpad: names on the corner and world maps in town, a walk out the east road through the Mossy Barrens into the Ashen Steppe with the trail and region names lighting up, a relog with the explored trail, regions and the found waypoint still there, a jump past the Ashen Steppe gate with the gate bar and the Sunscorched Dunes waypoint turning filled once touched, Escape closing the map. No console errors.

Limits:

- Found waypoints come from what this browser saw (the waypoint menu and activation events); a waypoint found on another browser shows hollow here until the menu opens once. The server already knows them; sending the list on join would fix it.
- Fog per browser, not per account: another machine starts dark. Moving it to the server would be a column per character and world seed.
- A region counts as entered when a reveal's centre lies in it (the HUD's rule), so walking along a border can light up the neighbour's name.
- The gamepad has no world map button yet.

## Seams for the stages to come

- **Stage 2, gate bosses:** `WorldPlan.gates` (id `<first region>-gate`, node, road, region, heading) and `WorldMap.gates` (id, spot, heading) mark each pass; every node past a gate has `behind` set to its id, and so does every waypoint past it (`WaypointInfo.behind`). A gate boss spawns at the gate's spot; the movement block is a line across the road at the gate (the sector border ridges already stop a walk round it beyond the home region, but rivers and the open home region do not, so the block wants a band across the whole sector, or a ridge at the gate radius). `useWaypoint` is the one place to refuse a waypoint whose `behind` the character has not passed.
- **Gate bosses and respawn:** respawn by inactivity is built (above). A boss that comes as a chunk pack with `boss: true` (the plan's packs, `ZoneWorld.planPacks`) follows the boss timer with no further work. A gate boss spawned some other way should take its respawn time from `respawnTicks(sim).bosses`, the admin's boss respawn setting, rather than a constant of its own, so one setting rules every boss.
- **Stage 4, minimap names and fog:** built (above). Still open from it: the minimap's 256-pixel tiles cover the whole world at its 0.025 pixels per unit, so drawing them generates every chunk's obstacles at load (the World bench shows all 169 generated); smaller tiles would follow the hero. The world map's tiles do the same at its own scale.

## Limits and open questions

- **The world regenerates with fresh monsters when a builder saves the town**, everywhere, and its whole plan changes if the town's gates moved. Everyone stays where they stood, with the loot on the ground and the opened chests (by spot: a save that moves a gate moves every chest, so every chest in every copy fills again, and a builder can repeat that). Bags carried over land on open ground near where they lay.
- **A town with fewer than three gates** gets roads from the middle of its north, east and south edges whether or not its fence has a gap there, so a builder could save a town nobody can walk out of. Nothing refuses such a layout yet.
- **Server and client must build the same plan:** every turn and check of a road is decided on `Math.atan2`, `cos`, `sin` and `hypot`, which browsers are not required to compute bit for bit alike. One flipped comparison would change that road's later branches and everything placed by them on that client (collision prediction would then disagree near them). The zones had the same exposure, over fewer decisions. A checksum of the plan in the welcome, reported back on a mismatch, would show whether it ever happens.
- **The town editor's preview shows the town alone** in its own coordinates, as before; other players and monsters keep drawing at their world positions, so in the editor they appear off to the side of the town.
- **Chests show no opened state:** a chest someone opened looks the same; walking up to it does nothing. Chests are still per world copy: a chest fills again on its chunk's respawn rule (nobody within its wake range for the respawn time), and every chest comes back when the room closes (5 minutes empty) and regenerates; every new party world has its own: 7 to 15 chests of two magic-or-better items each, which two accounts could farm. Chest loot does not follow the admin loot rate, like the dungeon cache. Owner's call whether chests should be per character instead.
- **Respawn time is game time:** a room nobody is in does not tick, so the time a world copy stands empty does not count (it closes after 5 minutes empty and comes back fresh anyway). A player could clear a chunk, walk 2000 units off and return 10 minutes later to a full chunk: that is the intended farming loop, and the setting is its pace.
- **A refill replaces the whole kind in its chunk,** so one monster killed out of a chunk of five brings back five fresh ones and takes the four survivors (out of everyone's view). Packs are counted by the chunk they spawned in: a monster that chased someone into the next chunk and died there still counts for its own.
- **Never visited chunks never refill,** and nor does a chunk whose packs the dev tools' "Kill all" forwent before it spawned.
- **Dungeon names repeat:** 11 entrances draw from the 6 dungeon names.
- **Regions share one ground texture;** only the colour changes. Desert dunes and caves have no terrain of their own yet (themes per road are for later).
- **Roads differ in length,** so levels climb faster per unit walked on the shorter ones (the east road on most seeds).
- **Two players in different regions share one simulation:** a busy copy of 15 (the hard cap) has not been measured; 8 spread out tick at 2.5 ms median.
- Waypoints into dungeons were read as "a waypoint leaves a dungeon's world": there are no waypoints inside dungeons; a dungeon's exits lead back to the world beside its entrance.
