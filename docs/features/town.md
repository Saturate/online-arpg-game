# Town, zones and dungeons

Status: Live. Wilds maps, the town editor and dungeons since 2026-09-28; public worlds, the walk-in town, zones and waypoints since 2026-09-28 and 2026-09-29; gates on the map edge since 2026-09-29.

## What it does

- **Everyone enters the world in the town, Emberwatch,** a shared safe area with no damage and no monsters. Its fenced gates open straight onto the first zone, so leaving town is a walk with no load.
- **Town stations:** the stash chest, the trader stall and the forge (the weapon rack) nearest the spawn, a waypoint, and the Arena entrance, a sunken stone drum with an archway ([stash.md](stash.md), [items.md](items.md), [forge.md](forge.md), [arena.md](arena.md)). Stations open on a click after the hero walks into reach, and close when you walk away.
- **Six zones in a chain,** each with a rising level band:

| Zone | Levels | Biome |
|---|---|---|
| Mossy Barrens (home, holds the town) | 1 to 3 | meadow |
| Ashen Steppe | 4 to 6 | ruins |
| Gloomvale | 7 to 10 | marsh |
| Thornwood | 11 to 14 | forest |
| Sunscorched Dunes | 15 to 19 | desert |
| The Hollows | 20 to 25 | cave |

- **Gates, not portals, join zones:** each exit is a stone arch on the map edge with lanterns and a dirt road that runs on into a gap in the border forest. Walk through it to change zone; you arrive just inside the matching gate of the next zone.
- **Waypoints:** touching one activates it for that character; click it to open the menu and travel to any zone whose waypoint you have. Everyone starts with the town's.
- **Dungeons:** each zone map has 2 entrances. An entrance leads to an antechamber, a small safe hall with a ready check (R); when everyone inside is ready, a 3 s countdown sends them into a fresh run together. Killing the boss clears the run and opens a cache ([loot.md](loot.md)).
- **Worlds:** everyone lands in a shared public copy of the world, up to 8 players; a party can open its own party world ([chat-and-parties.md](chat-and-parties.md)).
- **The town editor (F2 in town, builders and up)** edits the town layout live.

## Why

### Worlds and instances

- **No global town, but no private games by default either.** Everyone lands in a public copy of the world on the owner's world seed (admin Settings), up to 8 players (`INSTANCE_CAPACITY`); when all are full a new copy opens. Players never pick seeds. A party world gets a seed the server picks from a counter, and only the party can enter it.
- **Rooms:** the server's `RoomManager` hosts every room inside a world instance: zones, dungeon and Arena antechambers and their runs, and builders' sandboxes. Portals, gates and waypoints move a character (class, name, items, equipment, stance) between rooms in memory, saving on every move.
- **Zone rooms are created when someone first enters them** and closed after 5 minutes empty. An instance goes once it has no rooms and no members. Seeds come from the instance seed, so a zone regenerates identically with fresh monsters, like re-entering a D2 area.
- **Maps travel as descriptors, not geometry.** The welcome message carries `{ kind: 'zone', zone, seed }`, plus the town layout for the home zone. The client regenerates the identical map with the shared generator, so collision prediction stays exact.
- **Join and reconnect** land in the home zone of your party world if it has room, otherwise the public world.

### The town inside the home zone

- **The town layout sits at the origin of the home zone's map** and is marked as a safe zone. The layout stays at the origin so the town editor keeps working in town coordinates.
- **The safe zone rule lives in `isTargetable`,** the one check both monster aggro and damage go through. Monsters lose their target at the gate and leash home. Packs and dungeon entrances keep outside aggro range of the town.
- **The Arena entrance sits off the roads,** so walking out of town never drops you into it.
- **The home zone never pauses.** Esc pauses a room only when you are alone in it, it is not shared and it is not an Arena run (`Room.canPause`). The town is where everyone arrives, so the home zone room counts as shared even when one player is in it; other zones, antechambers and dungeons pause when you are alone.

### Waypoints and gates

- **The server re-checks** that you are standing on a waypoint (its radius plus 120) and that you have activated the destination. Saves from before waypoints existed are given the town's on load.
- **The menu opens when the waypoint is clicked** and closes when you walk off.
- **Waypoints** are drawn as a raised stone slab with four rune stones and a dim rune circle, not as a portal.
- **Arriving never triggers the way back:** you land the gate's radius plus 70 units inside the map. The road into a gate is cleared of obstacles.

### Zone content

- **Rivers with bridges** (1 or 2 rivers, 3 bridges each), rock ridges with gaps, forests, ruins (plazas with pillar rings), loose rocks and a road running east from the spawn.
- **Packs** are placed only on cells reachable from the spawn and never within 750 units of it, or within aggro range of the town. Monster level rises with distance, and a boss pack sits at the farthest point with an escort. The standard 5600x4200 Wilds map has 30 packs; zone maps scale the counts by area (about 34 in the home zone, 24 in the others).
- **Monsters come from the biome's pool** by level ([monsters.md](monsters.md)).
- **Dungeon entrances:** 2 per map, on reachable ground at least 1400 units from the spawn, away from packs and other portals. Monster level comes from the entrance's distance, plus 1. The dungeon seed comes from the map seed, so everyone in one instance shares the same antechamber.

### Dungeons

- **The antechamber** is safe. A ready check (R or the panel button) starts a 3 s countdown once everyone inside is ready; anyone arriving or un-readying cancels it. While a run is live the gate lets latecomers straight in. The antechamber only closes once no run is live.
- **Killing the boss marks the run cleared once:** it opens the cache ([loot.md](loot.md)), everyone inside gets a banner, and the antechamber shows "Last run cleared".
- **Each run is its own room** with a fresh layout, seeded from the dungeon seed, the run number and the level.
- **Generation:** rooms sit in a 4 by 3 slot grid, joined by a randomised DFS spanning tree plus 3 extra corridors, so there are loops without a maze. Carving uses the 40-unit nav cell, so walls line up exactly with pathfinding. Only rock cells touching floor become wall boxes, merged into rectangles, which keeps collision in the hundreds of shapes. Packs get harder with graph depth (up to +2 levels), and the boss room is the deepest room and holds the exit. Dungeons are crypts (even seeds) or caves (odd).
- **Rendering:** floors and walls are each one merged mesh with world-space UVs. Walls are drawn 44 units tall rather than 70, so a south wall does not hide the hero. Torches are lit by the shared light budget (see Lighting below); underground it is always night for them.

### Collision and pathing

- **Collision is static per map:** circles, capsules and rotated boxes in a spatial hash. Water blocks walking but not shots.
- **Movement is sub-stepped** (at most 20 units per step), so dashes cannot tunnel. When a step makes less than 30% of its intended progress, the mover tries the direction turned 45 degrees each way, which stops head-on sticking against round obstacles.
- **Players pass through monsters and each other;** only map obstacles block them. This keeps prediction exact, because the predicted step depends only on input and the static map.
- **Roads give +10% movement speed** to players, minions and monsters, computed in shared movement so prediction stays exact.
- **Map edges:** grass runs 1500 units past the edge under an instanced forest with rocks and mountain rings, so the camera never sees void.

### Lighting

- **Every flame and lamp casts light at night:** lamp posts, zone-gate lanterns, dungeon torches, candles, standing and post lanterns and shrine candles from decor, the forge fire, the camp fire, the Arena building's torches, portals (in their own colour) and waypoints (a low cold light). Each gets a pool of light on the ground with a slow two-sine flicker (never a strobe). They fade in at dusk and out at dawn with the night factor; by day outdoors they cast nothing, so the day look is unchanged. Underground they are always lit.
- **The light budget** (`apps/client/src/render/lights.ts`) is shared by world lights and spells. A fixed pool of 8 real point lights goes to the sources that score highest (priority first, then brightness and distance to the camera focus); every other visible source is drawn as a ground pool, one instanced draw call for all of them. A source that wins or loses its real light fades over 0.45 s, and its ground pool fades the other way, so nothing pops. The pool size never changes because the light count is compiled into every material's shader; switching lights on and off as you walk would recompile shaders mid-fight. No shadows: they would cost a shadow map per light.
- **Why pools of light and not flat discs:** real lights fall off with height^1.2 scaled into the intensity, so a source's `intensity` is the light straight below it and it thins out over its radius. The old per-lamp lights used physical decay at these distances (hundreds of units), which left a lamp contributing about 0.1% of its intensity at its own base: the lamps outdoors lit nothing.
- **Crowding:** when many lights pile up where the hero stands (a volley of spells, a ring of torches), every light is scaled down together so the total near the hero stays at about 4 (a single torch is 3). The ground pools use screen blending, so overlapping pools saturate softly instead of burning white. In a test with 64 spell lights around the hero the scale settles near 0.2.
- **The hero's light** at night is a warm pool around them (decay 1.4, 120 units up, 2.2 at their feet at the default), reaching `heroLightRadius`. Party members carry a faint one (0.55 of the hero's setting, priority 1). By day the hero's light is as before; underground only the admin multiplier applies.
- **Enemies at night:** a cold moonlight rim on enemies only (`nightRim.ts`), `0.28 * nightFactor()` on the procedural rigs and 0.8 of that on KayKit monsters (their materials are cached apart for the enemy copy of a def, so a minion on the same model stays unrimmed). Heroes and minions get no rim. Procedural rig parts darker than sRGB 0x30 (non-glowing) are lifted to it, keeping their hue. Before this, 23 of 53 procedural monster types showed only their eyes at night.
- **Keeping the mood:** the global night brightness is untouched, so the ground and sky away from lights stay as dark as before. Measured on the town square at `?time=0.9` (mean 0 to 255 luminance): the 300 px round the hero went from 9.5 to 60, the screen edges from 1.5 to 8; day (`?time=0.3`) differs by 0.15 on average (the flames' flicker).
- **Admin settings:** `heroLight`, `heroLightRadius` and `lampLight` ([accounts-admin.md](accounts-admin.md)), sent to clients with the rest of the lighting.

Light API, for torches and spells alike. Allocation-free per frame; emits are read by the next frame's budget update (in `WorldScene.follow`) and then cleared, so a source that stops emitting fades out:

```ts
import { emitLight, entityLightKey, lightKey } from '../render/lights.js';

const key = lightKey(); // once per source (a projectile, a zone); never reused
// or entityLightKey(entityId, channel 0..7): the same key from any client, no table needed

// Every frame the source is alive: ground x/y, height above ground, 0xRRGGBB, intensity (the light
// straight below; a torch is 3), radius (world units), priority (0 world, 1 party, higher for big
// spells), day (0 night only, 1 as bright by day; spells mostly 0.2 to 0.4).
emitLight(key, x, y, height, color, intensity, radius, priority, day);
```

World lights are `StaticLight` records that `buildWorld` returns in `BuiltWorld.lights`; `sceneLights.stats` has `{ real, pools, sources, crowd }` for the last frame.

Performance (headless Chrome on the dev Mac, 1280x720, GPU time from `EXT_disjoint_timer_query`, 5 s samples, noisy to about 1 ms): town square at night 9.45 ms mean before and 8.63 ms after, 275 draw calls both; a dungeon corridor 3.65 ms before and 4.32 ms after (54 to 55 draw calls: 6 real torch lights became 8); the town with 64 extra spell lights 6.29 ms and 276 draw calls. CPU per frame stays 1 to 2 ms.

### The town editor

- **F2 in town opens it** for roles with the `townEdit` permission (builders, admins, the owner); the admin page points to it.
- **Tools:** select and move, place prop, path brush, plaza brush, erase (keys 1 to 5). Q/E rotate, [ and ] scale (or line length, plaza radius or brush width), G snaps to 20 units, Ctrl+Z undoes (80 steps), Delete removes, WASD pans and the wheel zooms.
- **Save sends the layout to the server,** which validates every field, writes `TOWN_LAYOUT` (default `apps/server/data/town-layout.json`, `/data/town-layout.json` in production) atomically, and rebuilds the home zone room in every world instance with everyone in it carried over.
- **Portals and the spawn point can be moved but not deleted** in the editor, and a layout without a Wilds portal is rejected by the server.
- **Town in git:** `GET /api/town` serves the live town; `pnpm town:pull` writes it to `apps/server/data/town-layout.json`, which is bundled as the starting town. The daily `town-sync` workflow pushes a `town/live` branch when the live town changed (Actions cannot open PRs in this repo).

## How

Code:

- Maps: `packages/shared/src/world/` (`town.ts` layout, stations, `validateLayout`; `maps.ts` `zoneMap`, `generateWilds`, `placePacks`, `placeEntrances`, gates, `loadMap`; `dungeon.ts` dungeons, the antechamber, the Arena gate and pit; `gamemap.ts` collision; `nav.ts` flow field; `gen.ts` rivers and obstacles; `types.ts` map descriptors). Zones: `packages/shared/src/data/zones.ts`.
- Movement: `packages/shared/src/sim/movement.ts` (shared with client prediction).
- Server: `apps/server/src/manager.ts` (instances, rooms, portals, waypoints, `replaceTown`, idle closing), `room.ts`, `staging.ts` (ready check), `townStore.ts`.
- Client: `apps/client/src/game/townEditor.ts`; rendering in `apps/client/src/render/props.ts` (town, gates, the Arena building, the wild border, `addUnderground` for dungeons, the world's light sources); lighting in `scene.ts` (sun, moon, hero light), `lights.ts` (the light budget), `nightRim.ts` and `rigs/compile.ts` (enemy rim, albedo floor).
- Numbers: `WILDS`, `ZONE_SIZE`, `DUNGEON`, `NAV`, `GROUND` in `packages/shared/src/config/sim.ts`.

```ts
type MapDesc =
  | { kind: 'zone'; zone; seed; layout? } | { kind: 'staging'; seed; level } | { kind: 'dungeon'; seed; level; run }
  | { kind: 'arenaGate' } | { kind: 'arena' } | { kind: 'flat' } | { kind: 'testground' } | { kind: 'town'; layout? } | { kind: 'wilds'; seed };
```

`loadMap` is deterministic and cached (32 entries; the home zone's key includes the layout hash).

Town layout limits (`validateLayout`): at most 600 props, 80 paths of 200 points, 20 plazas, 20 portals, 800 decor; size 800 to 6000; prop scale 0.3 to 3. Town saves are limited to one per 3 s per client.

Tests:

- `packages/shared/test/zones.test.ts`: every zone has a waypoint and connected gates; the home zone holds a safe town with no packs near it; nobody in town is targetable; waypoints persist in the save; gates sit on map edges; arrivals land on open ground.
- `packages/shared/test/world.test.ts`: no ending up inside rocks, no dash tunnelling, water blocks walking but not shots; Wilds is deterministic per seed with packs away from camp and a boss; packs wake together; items survive room changes; sliding around the well.
- `packages/shared/test/dungeon.test.ts`: deterministic per seed and run; every pack and portal reachable, one boss; the antechamber is safe with a gate and a way back; the boss clears the run once and opens the cache; every bridge can be crossed.
- `packages/shared/test/town.test.ts`: layout validation round trip, hostile layouts rejected, the map key changes with the layout, roads are faster.
- `apps/server/test/worlds.test.ts`, `staging.test.ts`: public worlds fill to capacity; old seed messages ignored; the ready-check countdown.
- `apps/server/test/pause.test.ts`: a player alone in the home zone cannot pause it; alone in the Arena antechamber they can.
- `apps/client/test/lights.test.ts`: the nearest sources get the real lights and the rest ground pools; dark by day unless a source asks to glow; a light fades out over frames instead of popping; priority wins a slot; off-screen sources cost nothing; a crowd of lights is scaled down and a lone torch is not.
- `apps/client/test/nightLook.test.ts`: the albedo floor lifts near-black parts to 0x30 and keeps hue; the rim goes into enemy rigs after the emissive include and not into heroes or minions; it follows the night; KayKit rims keep their own program key.

## Limits and open questions

- **Pause is per room, not per spot:** a player alone in Mossy Barrens outside the town fence cannot pause either, since the town and the zone share one room. Pausing by position would need `canPause` in the snapshot rather than the welcome.
- **The town editor has no decor tool,** although comments in `town.ts` mention one; decor such as the forge's weapon rack cannot be moved in game.
- **The server does not stop deleting portals or the spawn;** only the editor does. A layout without a Wilds portal is rejected, but the home zone drops that portal from the town anyway.
- **An invalid town save is dropped without a notice** to the builder.
- **The standalone `wildsMap` and the `testground` map** are only used by tests and tools.
- **Lighting:** party lights were only checked in code, not with two players on screen. The town has only 4 lamp posts, so the square is lit mostly by the hero, the forge and the Arena torches; houses have no light of their own (windows or door lanterns would need a spot per building model). Ground pools draw over the ground only at a fixed height, so a pool under a torch on a wall does not climb the wall. The sandbox (`flat` theme) has no night. `?time=0.75` is already full night; dusk is about 0.55 to 0.65.
