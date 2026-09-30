# World streaming

Status: Step 1 built (monsters far from every player sleep on the server), not pushed; the leash fix and the respawn order fix 2026-09-30, not pushed. Step 2, client side (chunked rendering, see [Step 2: client rendering by chunk](#step-2-client-rendering-by-chunk)), built 2026-09-30, not pushed. The server half of step 2 (snapshots by chunk) and steps 3 and 4 are planned.

## What it does

- **Each room's map is cut into chunks** of 1000 units (`STREAMING.chunkSize`). A chunk is awake while a player, alive or waiting to respawn, or any player's minion is within 2 chunks (2000 units, `STREAMING.awakeChunks`) of its nearest point. Every other chunk sleeps.
- **Idle monsters in sleeping chunks are skipped** by the monster systems: no AI, idle shuffle, movement, knockback drift, curse aura, cooldown or ability timers, separation or terrain settling. Their state does not change at all, so a monster resumes exactly where it stopped, with no catch-up burst.
- **Only idle monsters sleep.** A monster that is aggroed (chasing, fighting, walking home after the leash), mid-action (a wind-up, charge or leap), pinned, or still sliding from a knockback stays awake wherever it is. A chase can lead out of the awake area without freezing halfway, and a monster that walks home and goes idle falls asleep at the next recompute.
- **A leashed monster goes all the way home.** Once it is dragged more than 1300 units from home (`WILDS.leashDistance`) it walks back and takes no target for 3 s (`WILDS.leashReturnSeconds`); after that, only a target in sight within the normal aggro radius (460) or a hit turns it round. At home it goes idle, heals and can sleep. Before 2026-09-30 each step back inside the leash re-picked the target beyond it, so a monster whose target stayed alive anywhere hovered at the leash edge, awake, forever.
- **Anything that hits a sleeper wakes it on the same tick:** `dealDamage` calls `alertPack`, which aggroes it and its idle packmates, and the sleep check reads `aggro` every tick.
- **Wave maps never sleep anything:** waves (the Arena, the testground) spawn aggroed, and the sandbox's flat map is smaller than the awake radius from its middle, so builder spawns stay awake.

## Why

- One player in the Mossy Barrens had 232 monsters thinking every tick. Tick cost grew with the zone's area, not with where people are, which rules out bigger zones.
- **2000 units against an interest radius of 1100.** A player only receives entities within `NET.interestRadius` (1100). A sleeper is at least 2000 units from every player at each recompute; between recomputes (every 5 ticks, 0.25 s) a player at 220 units per second covers 55 units, so a monster never wakes inside anyone's view. Arrivals, departures and any player or minion that moved more than 250 units since the last recompute (a portal, a waypoint, a respawn, a minion teleport) force a recompute on the same tick, before the monsters run. The recompute runs after `updatePlayers`, which is what moves a respawning player to the spawn; before 2026-09-30 it ran first, so on the respawn tick 14 to 28 sleepers within 1100 units of some zones' spawns were sent in the snapshot and aggroed a tick late. `streaming.test.ts` walks a player across a zone, and respawns one at the spawn from the far corner, and checks every tick that no sleeper is within 1600 units.
- **Round, not square:** a chunk counts as near when its closest point is within 2000 units, so the corners of a 5 by 5 block stay asleep.
- **Recomputed 4 times a second, not per monster per tick.** A recompute marks the awake chunks around each anchor, then puts every idle monster in a sleeping chunk into a set. Per tick a monster costs one `aggro` read and one set lookup.
- **Sleepers still size the separation grid.** The cell size of the enemy separation hash sets the order overlapping pairs are pushed in, so it is computed over every monster; otherwise a sleeper far away could change results next to a player by a rounding error.
- **An empty simulation keeps everything awake.** The server does not tick a room without members, and tests and tools that run monsters without a player behave as before.

## How

- `packages/shared/src/sim/streaming.ts`: the chunk grid, the recompute (`updateStreaming`), `sleepingEnemies` and `isAsleep`, `chunkAwake`, `streamingStats`, and `setStreaming` to switch it off for tests and the bench. The state sits in a `WeakMap` beside the simulation, like the monster state in `enemies.ts`.
- `sim/systems.ts`: `streaming` runs after input, `nav` and `players` (portal requests, respawns) and before auras, statuses and the monsters, so this tick's positions, respawns included, decide who sleeps.
- `sim/enemies.ts`: the main monster loop, separation and terrain settling skip sleepers. The leash: `EnemyComp.homeward` (seconds since it turned for home, null otherwise) in the main loop, and `alertPack`, where a hit ends the walk home once the 3 s are past.
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
- a player respawning at the spawn from the far corner of the zone wakes the monsters around the spawn on the respawn tick;
- a hit aggroes a sleeper, which chases through sleeping chunks while awake, then walks home once its target is dead and sleeps again;
- the same seed and inputs with and without sleep give identical events and monster and player state within 1800 units of the players, in a zone fight and in a dungeon (whose boss wakes and aggroes when reached);
- the Arena and the sandbox (with a builder's spawns in the far corners) sleep nothing and match a run without streaming exactly.

`packages/shared/test/leash.test.ts`: a monster whose target stands beyond the leash turns at 1300, walks home, goes idle and stays there; it sleeps at home once the player has gone far away; it ignores a player following it home for the first 3 s and then turns on them; a chase inside the leash is unchanged.

## Step 2: client rendering by chunk

### What it does

- **The client draws the static world by chunk**, on the same 1000 unit grid as the server's sleep (`STREAMING.chunkSize`, read through `CHUNK_SIZE` in `render/chunks.ts`). Border scenery outside the map gets negative chunk coordinates. Each chunk holds its ground tile, its roads and plazas, its trees, bridges, stalls and landmarks, its grass and pebbles, its dungeon floor and walls, and one prop batch (instanced models per kind) of its own.
- **Only chunks near the camera exist as meshes.** Distances run from the camera focus to a chunk's bounds (its square grown to cover everything anchored in it, so a 420-radius mountain or a long road counts where it reaches). A chunk is built inside the build radius, drawn inside the show radius, hidden (taken out of the scene graph) past the hide radius and released (instance buffers and its own geometry disposed) past the release radius; it is rebuilt from its data when it comes back. At the game camera on a 16:9 screen the radii are 1100, 1500, 2000 and 2900 units.
- **Models load when a chunk that uses them is built**, not at zone load: a zone's first frame builds the chunks inside the show radius at once and the ring ahead of the view one chunk a frame.
- **Lights and world fires only look at what is near.** The light budget buckets the world's lights by chunk and scores only those within its 1000 unit reach of the focus (gathered again every 150 units walked); before, it walked every light every frame and silently dropped any past the 512th. The world fires project only the spots within the view's footprint plus 300.
- **The minimap draws in tiles** of 256 pixels, layout and fog each, made when first drawn. Every zone today fits the frame whole (one tile, as before, at the camera-yaw rotation). A map that would need fewer than 0.025 minimap pixels per unit (`MIN_SCALE`) shows a frame-sized window around the hero instead, turned the same way, with party members past its edge as arrows on the frame.
- **Nothing visible changes** for today's zones: same models, placements, UVs, lights and fog. Screenshots of the town square at night, a Thornwood forest, the Thornwood east gate and a torch-lit dungeon room look the same as the old renderer side by side.

### Why

- Each prop kind was one instanced mesh for the whole zone, whose bounding sphere always touched the view, so three drew every instance of every kind every frame: 1.26 to 2.48 million triangles a frame (with the shadow pass) to show a screen that needs 40 to 140 thousand. That cost, and the buffers behind it, grew with the zone's area.
- **Per-chunk batches rather than one batch per kind with draw ranges.** WebGL has no cheap way to draw several ranges of one instanced buffer in one call (that needs the multi-draw base-instance extension, which is not everywhere), and compacting visible instances into one buffer re-uploads on every border crossing. Per-chunk batches cost a draw per kind per chunk on screen, and measured fewer draw calls than before (below), because whole chunks are culled.
- **Hidden chunks leave the scene graph** instead of being set invisible: three still walks invisible objects every frame to update their matrices. Static chunk content also has its matrices computed once and frozen (`matrixAutoUpdate` and `matrixWorldAutoUpdate` off).
- **Model batches sit after all the chunks' own meshes in the scene graph.** The shadow pass draws casters in graph order through one shared depth material; every switch between a textured model and an untextured tree changes that material's program, and interleaving them chunk by chunk added about 45 KB of garbage a frame in town.
- **Trees share one material until they fade.** A tree near the hero fades on a copy of its own and goes back to the shared material once it is solid again; before, every tree had its own material from the start, and a rebuilt chunk would have made a hundred new ones.
- **The radii.** The show radius is the view footprint's corner (about 600 at 16:9, larger on wide screens and when the town editor zooms out) plus 500 for tall scenery leaning into the picture (a point h high shows up to 0.78 h past the footprint at the 52 degree pitch), and never under 1100. Hide is 400 past show, so walking along a chunk border never flickers; building 900 past show gives a hero at 220 units a second four seconds to fetch a model a chunk is the first to need; release is another 900 out, so walking back and forth over one border never rebuilds.
- **Rivers stay whole.** A river is a few hundred vertices in two draws across the whole map, so cutting it into chunks would only add draws. The void plane under the world is one quad.

### How

- `apps/client/src/render/chunks.ts` (pure): `chunkCoord`, `chunkKey` and `keyCoords`, `rectDistance`, `viewFootprint`, `streamRadii`, `chunkAction` (the build, show, hide and release rule), `ChunkBuckets` and `NearCache` (items bucketed by chunk and the near list, for lights and fires).
- `render/worldChunks.ts`: `WorldChunks`. Content is registered at load as data: `add` (a prop placement, into the chunk's `PropBatch`), `build` (a builder function run when the chunk is built), `attach` (a small landmark built once at load and kept across releases: portals, waypoints, the Arena drum, camp fires and braziers, whose lights and flames are data from the start) and `reach` (grows a chunk's bounds). `update` runs the rule over every chunk once a frame and the animations of the drawn ones. `stats` counts chunks, builds, releases and `late`: chunks drawn, or whose models arrived, while already inside the view's footprint.
- `render/props.ts`: `buildWorld` registers everything with a `WorldChunks` instead of building it; the generators (border ring, wild border forest and peaks, grass and pebbles) still run whole at load with the same random sequence, so every placement is where it was, and bucket their output by chunk. Ground tiles have UVs in world units (one repeat per 420, as the single plane had). Decor placement tests obstacles through a grid (`obstacleGrid`) instead of a scan over every obstacle for every tuft, the same answer in linear time.
- `render/propBatch.ts`: the measured meshes of each asset are cached (`assetParts`), so a rebuild does not clone and measure a model again, and see-through copies are shared per source material.
- `render/scene.ts`: `follow` passes the camera's footprint to `world.update`. `render/lights.ts` and `render/vfx/worldFires.ts`: the near lists. `render/minimap.ts`: tiles (`minimapScale`, `tilesNear`, `rotateAround`).
- The bench: the World tab in `/admin/dev/` (`#world/<town|wilds|big>`, `?time=0.75` for night; `apps/client/src/dev/world/`), the static world and the effects system (for fires and lights) with the camera walked along a path at 360 units a second, with a minimap. `big` is `scaledZoneMap('thornwood', 7, 2)` (`packages/shared/src/world/maps.ts`): Thornwood at twice the width and height, 10400 by 7200, 4x the area, which nothing in the game builds.

### Measurements

The World bench on the development Mac, Chrome, 1600 by 900, 2026-09-30, the old renderer (HEAD before this change, same bench) against the new one on the same page, the second of two runs each. "Stand" is 300 frames at the start of the walk, "walk" the whole path (446 frames in town, 832 in Thornwood, 1988 in the big zone). Render CPU is `WorldScene.follow`, `Effects.update` and `render`; heap is the mean rise of the JS heap per frame; buffers are the vertex, index and instance buffers held by the scene graph; build is the synchronous zone build, ready the first frame drawn with the models around the start (shader compiles included, models in the HTTP cache).

| | Town (home zone, 7400x3600) old / new | Thornwood (5200x3600) old / new | Big (10400x7200) old / new |
|---|---|---|---|
| Build ms | 59 / 34 | 53 / 24 | 84 / 31 |
| Ready ms | 150 / 146 | 135 / 117 | 181 / 128 |
| Draw calls, stand | 305 / 314 | 166 / 165 | 195 / 166 |
| Draw calls, walk mean (max) | 174 (303) / 162 (312) | 152 (189) / 136 (184) | 159 (215) / 107 (165) |
| Triangles, stand | 1,592,753 / 136,783 | 1,250,247 / 42,093 | 2,483,249 / 66,515 |
| Triangles, walk mean | 1,572,666 / 86,252 | 1,264,679 / 46,640 | 2,479,977 / 39,908 |
| Render CPU ms, stand | 2.62 / 2.51 | 2.12 / 2.06 | 2.53 / 2.15 |
| Render CPU ms, walk mean (p95) | 2.30 (2.8) / 2.22 (2.8) | 2.11 (2.5) / 2.03 (2.5) | 2.40 (2.8) / 1.83 (2.3) |
| Heap per frame, stand | 118 KB / 124 KB | 65 KB / 75 KB | 103 KB / 87 KB |
| Heap per frame, walk | 79 KB / 95 KB | 79 KB / 78 KB | 68 KB / 59 KB |
| Buffers held, end (max) | 3.84 MB / 2.77 MB (3.27) | 3.18 MB / 2.77 MB (2.78) | 3.94 MB / 2.54 MB (2.77) |
| Geometries (renderer.info) | 196 / 200 | 150 / 150 (max 155) | 128 / 117 (max 122) |
| Meshes in the scene | 569 / 366 | 390 / 431 | 873 / 372 |
| Chunks: total, built, drawn at the end | / 88, 32, 14 | / 72, 30, 15 | / 154, 26, 13 |
| Builds, releases, late over load and walk | / 42, 10, 0 | / 52, 22, 0 | / 84, 58, 0 |

- **Triangles drop 12 to 62 times,** and in the big zone the new renderer draws fewer than in today's town: the cost follows the view, not the zone. The GPU time behind them is not in the render CPU column.
- **Buffers held stop growing with the zone:** 2.5 to 2.8 MB whatever the zone's size, against 3.2 to 3.9 MB before, rising with area.
- **Draw calls fall** on the walk (7% in town, 33% in the big zone) and stay level standing in town, where the square has many kinds of model in view and each kind now draws once per chunk on screen.
- **Render CPU is level in today's zones and 20% lower in the big zone.** The per-frame work that grew with the zone (walking every light, every fire and every tree's fade) now covers only what is near; the rest of the CPU is three's shadow and colour passes over what is on screen.
- **Heap per frame is within noise standing** (runs of the same build vary by 20 KB). Walking in town adds about 15 KB a frame: rebuilding a chunk makes new instance buffers and meshes, 42 builds over the walk.
- **Load is faster to build** (the zone registers data instead of building every mesh) and no slower to first frame; "late" stayed 0 on every walk, so nothing popped in inside the view.

Tests: `apps/client/test/chunks.test.ts` (chunk indexing and keys, rectangle distance, the view footprint, the radii order and floor, bucketed near lists and the re-gather slack, the hysteresis rule over walks in and out and back and forth, and `WorldChunks` building, hiding, releasing and rebuilding a chunk while freeing only what it owns, and keeping a landmark across a release), `lights.test.ts` (2000 lamps over a 40000 unit zone keep their lights near the camera; emitted lights survive a changing near set), `minimap.test.ts` (whole or windowed per zone size, one tile for today's zones, the tiles a window touches, turning around the hero).

### Limits and open questions

- Landmarks (portals, waypoints, the Arena drum, fires) are built at load and never released; they are a few dozen small meshes per zone.
- The first view of a model or material in a zone still compiles its shader when it first draws, as before; a chunk built ahead of the view could warm them with `renderer.compileAsync` while it is out of sight.
- Arriving by a teleport inside a room (a waypoint in the same zone) builds the chunks around the arrival on that frame and loads their models then, like a zone load.
- The zone is still generated whole at load; step 3 makes generation per chunk, which this layout is ready for (a chunk is data plus builders).
- The server half of step 2 (a chunk index for entities, so snapshots only touch chunks near each player) is not built.

## Limits and open questions (step 1)

- A player who follows a leashed monster home and stays within 460 units of it turns it round after 3 s, so it can be pulled out and sent home again every few seconds. It stays awake while they do, which is right: they are next to it.
- A monster whose target died walks home as before (no 3 s hold), and picks a new target anywhere on the map if one appears on the way.
- The server still serialises every entity in the room every tick and filters per player afterwards. That is step 2's to fix.
- Monster packs that straddle the edge of the awake area can overlap a sleeper without being pushed apart, 2000 units from anyone. Nothing sees it.

## Planned

- **Step 2, snapshots by chunk (server):** the server keeps entities in a chunk index, so serialising and interest filtering only touch chunks near each player. The client half, rendering by chunk, is built (above).
- **Step 3, chunk-based generation:** zone generation places rivers, ridges, forests and packs per chunk from the zone seed and the chunk's coordinates, so a chunk can be built on demand and the same everywhere; the server generates monster packs for a chunk when it first wakes.
- **Step 4, bigger zones:** with cost following players, zones can grow well past 5200 by 3600 (the bench's 15600 by 10800 runs a player at 0.3 ms a tick). Open: how big, how waypoints and zone exits spread across it, and whether the flow field needs to go per chunk too.
