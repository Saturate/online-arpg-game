# Decisions

Cross-cutting choices: networking, prediction, input, browser safety, rendering and look, operations and deploys. Each can be revisited; the tuning values all live in `packages/shared/src/config/` or `packages/shared/src/data/`.

Decisions about one feature live in that feature's doc under `docs/features/` ([index](docs/features/index.md)).

## Architecture

**Renderer is Three.js, not Pixi.** You asked for this after M1. The camera is orthographic and locked: it follows the player, never rotates, and sits at yaw 45 and pitch 52 for a Diablo 2 framing. Both angles and the zoom live in `apps/client/src/render/config.ts`; yaw 0 with a steeper pitch gives a RotMG style view. The simulation stays 2D on the ground plane, sim (x, y) maps to three (x, 0, y), and the server does not know about 3D at all.

**The ECS stays hand-rolled but is formalised** (`packages/shared/src/sim/ecs.ts`, `systems.ts`):
- Component stores are registered, and destroying an entity clears it from every store.
- `world.query(a, b, c)` iterates entities that have all the listed components, with typed tuples.
- One ordered `SYSTEMS` pipeline runs per tick.

Libraries (miniplex, bitECS) were considered and not chosen. The spec asks for a lightweight ECS, and the components hold rich data (sets, items, spell trees) that fits typed-array ECS libraries poorly.

**Random streams.** Each simulation derives independent streams for loot, combat and world/spawns from its seed (`Rng.stream`). Adding a roll in one system no longer shifts outcomes in another for the same seed.

**The codec is generic over its wire type** (`Codec<string>` for JSON). `packages/shared` has no DOM or Node libs, so `TextDecoder` is unavailable there. A msgpack codec would be `Codec<Uint8Array>`.

**Stack additions:** `tsx` runs the server in dev. Node 26's built-in type stripping would need `.ts` import extensions throughout. pnpm 12 blocks install scripts by default, and esbuild's is allowed in `pnpm-workspace.yaml`.

## Networking and prediction

**Input rate limiting uses tick credits.** Each input is one tick of movement. A player earns one credit per server tick, capped at `SIM.inputCreditCap` (3), and spends one per applied input. Network jitter can catch up by at most 2 ticks, but a client sending faster than 20 Hz gains nothing. The queue is capped at `SIM.inputQueueMax` (10), dropping oldest, which bounds how much latency a client can build up.

**`?lag=N` adds N ms of round-trip time**, split as N/2 each way, applied on the client to both send and receive. The acceptance test "150 ms of artificial latency" was run as `?lag=150`, which shows as about 152 ms RTT on localhost.

**Own movement ignores other entities.** Players pass through monsters and each other; only the static map blocks them. This keeps prediction exact, because the predicted step depends only on input and the map, which the client regenerates from the same descriptor. Tested: 0 px correction at 150 ms RTT. Revisit if body-blocking is wanted. Collision and movement rules are in [town.md](docs/features/town.md).

**No cosmetic local projectile.** With M1's basic attack, your own bolt was drawn locally and paired with the next server projectile, and the warrior's swing arc was drawn locally, because at 150 ms the bolt otherwise appeared about 250 ms after the click. Both went with the basic attack (commits `2c760e5`, `99ad564`); every hit now comes from a sigil, and damage was always server-side.

**Dash prediction.** Dash is not predicted at cast time. The server starts it and sends the dash state with the snapshot, and the client replays unacknowledged inputs through the same `stepPlayer`, so the rest of the dash is exact. The cost is that the dash visibly starts one RTT late. Corrections are blended out over a few frames instead of popping.

**Snapshots are full, except for spells.** Positions are rounded to 0.1 px and angles to 0.01 rad on the wire, and the socket uses permessage-deflate (level 1, messages over 1 KB). Projectiles, novas and zones are sent once per client (with velocity, or age and duration), again only if their motion changes, then listed as gone; the client's `SpellTable` carries them forward and expands each snapshot back to full state before anything else reads it. Measured with 4 mages against 30 enemies: 3.1 KB to 1.5 KB per tick deflated; a busy 8-player snapshot went from 35.6 KB to 6.0 KB with deflate.

**Interest radius.** A player receives entities and events within 1100 units, plus their own minions and bond targets wherever they are.

**Party frames.** The snapshot's `players` list sends every player's name and life regardless of distance, for the party frames.

**Socket hygiene:** a 256 KB max frame (room for a saved town layout, nothing much bigger) and 80 messages per second per client, after which the socket closes with "rate limit". Client messages are validated structurally in `parseClientMessage`, and unknown button bits are masked off. The socket's `join` carries only a session token and a character id ([accounts-admin.md](docs/features/accounts-admin.md)).

**Deferred from M1:**
- Server-side latency simulation. Only the client can add lag today.
- Interpolation of the own player's server-side attributes. Life shows the latest snapshot value without interpolation, which is fine.

## Input and controls

**Screen-relative movement.** WASD is converted through the camera's ground basis on the client, so W always moves up the screen. The server still receives a world-space `moveDir`, so it needs no camera knowledge.

**No basic attack:** every hit comes from a sigil; the server ignores the old primary button. Force is the limit ([runes.md](docs/features/runes.md), "Force").

**Mouse skills, D2 style:** left and right mouse each cast a picked skill slot. Left-click a skill slot to put it on the left button, right-click for the right, or scroll (Shift for the left). Picks are saved per character in localStorage; the default is the first two cast (not persistent) skills. Dragging a skill onto another slot swaps them, and the picks follow.

**Control schemes:** WASD plus mouse, or click-to-move (D2 style), set under Esc, Settings. Click-to-move plans 8-way A* over the nav grid, string-pulled along clear lines, and sends ordinary movement frames, so the server and prediction did not change. Pressing on a monster locks onto it and casts the left skill while held, walking into range first. Shift casts in place.

**Stations open on a click:** the stash, trader, forge and waypoints open when clicked, after the hero walks into reach, and close when you walk away, as in D2. The client asks from 10 units inside the server's reach, so latency cannot leave a request just out of range.

**Gamepad:** a standard-mapping pad works under either scheme and only takes over while in use, so a pad left plugged in does not fight the mouse.

**Key bindings** are rebindable under Esc, Settings; a clash swaps the two bindings so every action keeps a key. Escape, F1, F2 and F3 are reserved.

## Browser safety

Back, mouse side buttons and swipes do not leave the game; reload and close ask first (not in dev). One game tab at a time: a tab entering the game tells the others over a BroadcastChannel and they step aside. Stuck keys are cleared on Cmd release, when the tab hides or the window loses or regains focus, and when the leave prompt opens (macOS drops keyups while Cmd is held; native dialogs and menus swallow them). The browser context menu is blocked outside text fields, and bound keys block their default on release too, so releasing Alt on Windows cannot hand focus to the menu bar. F1 lists the keys the game thinks are held.

**Text is never HTML:** chat, names and item text are only set through React or `textContent`.

## Rendering and look

**Dark and gritty (D2 Act 1 / PoE), not cute:** sunny days under a gritty grade (see Weather), a vignette, a global canvas grade (desaturate, contrast, a little sepia) and a shared-shader grime pass (world-space blotches, soot near the ground) over the KayKit models. Dungeons are torch-lit dark. Nights must stay playable.

**Day and night:** visual only, from the wall clock so everyone sees the same sky; the admin sets day length, night brightness, the clock and the night lights. `?time=0.75` pins the time locally for testing.

**Night is lit by its lights, not by lifting the night:** torches, lanterns, fires, portals and the hero cast warm pools at night and enemies get a faint cold rim, while the global night brightness stays low, so the ground and sky away from the lights stay dark. Every light (world and spells) goes through one budget: a fixed pool of 8 real point lights for the sources that matter most and cheap ground pools for the rest, because the light count is compiled into every shader. Details in [town.md](docs/features/town.md), Lighting.

**Weather:** a clear day is sunny; the gloom comes from the colour grade, the night and overcast spells. The sky's cloud cover also follows the wall clock (a new value every 9 minutes, blended), mostly clear; cloud dims and greys the sun and flattens the light rather than making it dark. `?weather=0..1` pins it for testing.

**Minimap:** fog of war, uncovered as you walk (remembered per map for the session); party members in the same map share their vision and always show.

**Readability (SPEC):** enemy bullets are bright and outlined; player and minion projectiles are muted and semi-transparent. Walls and buildings in front of the hero turn see-through.

Map edges, dungeon meshes and lights are in [town.md](docs/features/town.md); the monster tint shader is in [monsters.md](docs/features/monsters.md).

## Operations

**Deploys:** a push to `main` builds the image in GitHub Actions and Flux rolls it out to arpg.akj.io, restarting the server (everyone is saved first and reconnects). Pushes that only change Markdown skip the image build. Hold pushes until the owner says deploy.

**Stale tabs update themselves after a deploy.** The build id is baked into the image and the client. The welcome carries the server's build; on a mismatch the client stores the character it was playing, reloads and rejoins it. A background tab reloads without resuming, and a tab that already reloaded once shows a notice instead of looping. Dev builds skip the check.

**Saves on shutdown:** SIGINT, SIGTERM and uncaught exceptions save every online character before the process ends ([accounts-admin.md](docs/features/accounts-admin.md), "Save points").

**Town in git:** see [town.md](docs/features/town.md), "The town editor".

## Parked ideas

- **Restartless tuning (partly built):** the numbers tuned most often should live on the admin page so balance changes need no deploy or restart. Built so far: XP and loot rates, the Force bar, cost, cooling and ramp ([accounts-admin.md](docs/features/accounts-admin.md)), and every monster and minion number ([monsters.md](docs/features/monsters.md)). Still in code: drop chances, rune and forge prices, affix ranges.
- **Weapon-gated skills:** see [runes.md](docs/features/runes.md), "Parked: weapon-gated skills".

## Where feature decisions went

- M1 armour, class stats, spawn and death: [characters.md](docs/features/characters.md). M1 waves: [monsters.md](docs/features/monsters.md), "Waves on test maps".
- M2 runes, the rune rework (v2), the live spell cap, the Spell Lab, Force, prebaked skills and Pulse: [runes.md](docs/features/runes.md). The forge, clamping and the bench: [forge.md](docs/features/forge.md).
- M3 items, the grid, bound items, the trader and the v1 conversion: [items.md](docs/features/items.md). Drops, pickup, gold and dungeon caches: [loot.md](docs/features/loot.md). The account stash: [stash.md](docs/features/stash.md).
- M4 spirit, auras and links: [runes.md](docs/features/runes.md), "Persistent skills: Aura and Bond".
- M5 Binder, vessels, stances and the warband: [minions.md](docs/features/minions.md).
- M6 wave scaling: [monsters.md](docs/features/monsters.md). Interest radius and party frames stay above.
- World mode, rooms, collision, zones, the walk-in town, waypoints, dungeons and the town editor: [town.md](docs/features/town.md). Pathing: [monsters.md](docs/features/monsters.md) and [minions.md](docs/features/minions.md).
- Accounts, persistence, roles, the admin page and guests: [accounts-admin.md](docs/features/accounts-admin.md).
- Replays, the loot simulator, F3 and the dev tools: [dev-tools.md](docs/features/dev-tools.md).
- Character progression: [characters.md](docs/features/characters.md).
- Monster roster, biome pools, tuning overrides and Model check: [monsters.md](docs/features/monsters.md).
- Chat and parties: [chat-and-parties.md](docs/features/chat-and-parties.md).
- The Arena and its leaderboard: [arena.md](docs/features/arena.md).
- Loot piles are built ([loot.md](docs/features/loot.md)). Planned: guilds in [guilds.md](docs/features/guilds.md), phase 4 onward of the rune plan in [runes.md](docs/features/runes.md).

Open items and the handoff for the next session are in the README.
