# Dev tools, replays and debugging

Status: Live. Replays, the loot simulator and the F3 panel since 2026-09-28; the dev tools moved under `/admin/dev/` for builders and up on 2026-09-29; the Spell Lab since 2026-09-29.

## What it does

- **`/admin/dev/`** (builder role or higher) has five tabs, each deep-linkable through the URL hash (`#assets/built-in/giant_scorpion`):
  - **Assets:** a gallery of every model by category (hero, monster, built-in, building, nature, prop, dungeon, graveyard). Built-in monsters, the ones built in code, can be viewed and exported as `.glb` with Idle, Walk and Attack baked in; exported models keep their facets.
  - **Spell Studio:** a live headless simulation that casts a skill at dummies (pack, line or ring; type, count and distance), with hold, interval or click casting, infinite Force, time scale 0.1x to 4x, step and reset. It shows DPS over 5 s and over the run, damage, casts and fizzles, hits per cast, Force per second, peak live entities, and a 15 s timeline. "Copy as starterSigils.ts entry" exports the skill. It compiles through the same path the game uses.
  - **Spell Lab:** reads any rune list with the v2 grammar, phase 4 runes included, with a palette, examples and context fields (multicast, max depth, live cap, plain Swift and Large). It shows the verdict, each error with its rule and rune, token highlighting, the sentence, the bracket view, the node tree and the budget. Castable spells go to the Spell Studio with one click; parts the engine cannot run yet are named, not dropped ([runes.md](runes.md)).
  - **Loot:** the loot simulator. Seed, monster level (1 to 30), normal, rare or boss, kill count (default 10,000), drop chance and share overrides, and a class for "usable weapon" counts. It runs in chunks of 2,000 kills ([loot.md](loot.md)).
  - **Replay:** plays a recorded session back through the real client.
- **F3 in game** (builders and up, not in Arena runs) opens the encounter panel: spawn monsters at the cursor (N; type, count 1 to 50, level 1 to 30, rare), kill all, clear loot, god mode, heal, teleport to the cursor or a portal, time scale (0.25x to 4x), and give a sigil, vessel, gear piece or rune by tier, level and category.
- **`/sandbox`** opens a builder's private flat room with the free forge bench and F3, no waves ([forge.md](forge.md)).
- **F1** shows the debug overlay: tick, RTT (including artificial lag), visible and room entities, FPS and draw calls, pending inputs, the keys the game thinks are held, the last prediction correction, Force, and the last fizzle with its rule.
- **F8** (or the Esc menu) records a replay.
- **Client URL options:** `?lag=150` adds 150 ms of round-trip latency (split evenly each way), `?server=ws://host:port` connects to another server, `?time=0.75` pins the time of day, `?weather=0..1` pins cloud cover.

## Why

- **Dev tools belong to staff roles, not a server toggle.** The pages and the in-game panel check the `devTools` permission ([accounts-admin.md](accounts-admin.md)).
- **Dev items cannot leak into play:** items given with the dev tools are bound (runes inside a given sigil too), and monsters spawned with them drop nothing and give no XP. Monsters a shaman raised pay out nothing the second time.
- **Dev commands are refused in Arena runs,** since runs are scored. The room's time scale goes back to 1 when no member with dev tools is left.
- **Replays are every server message the client received, timestamped.** Snapshots carry full state apart from spells (which the client rebuilds from the spell records in earlier snapshots), so feeding them back through the normal `Game` reproduces the session from the recorder's point of view with no simulation on the client. `Game` takes a session that is either live (WebSocket) or replay (a virtual clock that sends nothing). Interpolation runs on that clock, so slow motion (0.25x) and fast forward (4x) work.
- **Recordings are gzipped JSON, capped at 10 minutes** (ten minutes of 20 Hz snapshots is roughly 10 MB gzipped; past that the tab struggles). A 5.7 s town clip was 5.9 KB. A recording started mid-room is seeded with the last welcome, inventory and antechamber state.
- **Seeking** builds a fresh client at the target time from the last room entry before it. Combat events older than 0.5 s are stripped, so a seek does not burst every past hit.
- **One drop roll:** the loot simulator calls `rollDrops`, the same function the game uses.

## How

- Dev pages: `apps/client/src/dev/` (`main.tsx` tabs and the staff gate, `deepLink.ts`, `AssetsTab.tsx`, `builtinModels.ts`, `SpellStudioTab.tsx` with `studio/`, `SpellLabTab.tsx`, `LootTab.tsx` with `loot/lootStats.ts`, `ReplayTab.tsx` with `replay/player.ts`).
- F3 panel: `apps/client/src/ui/DevPanel.tsx`; commands parsed and applied in `packages/shared/src/sim/dev.ts`; refused by `apps/server/src/room.ts` without the permission or in an Arena run.
- Debug overlay: `apps/client/src/ui/DebugOverlay.tsx`.
- Replays: `apps/client/src/game/replay.ts` (`MAX_RECORDING_MS`, encode and decode).
- Lag and server options: `apps/client/src/net/settings.ts`.

Tests:

- `packages/shared/test/dev.test.ts`: dev command parsing and effects.
- `apps/client/test/replay.test.ts`: recording and playback.
- `apps/client/test/studio.test.ts`: studio metrics, export shape, determinism, starter pricing equals the game's.
- `apps/client/test/loot.test.ts`: the loot simulator is deterministic and chunk-invariant.
- `apps/server/test/accounts.test.ts`: dev tools for builders and up, time scale reset.

## Limits and open questions

- Replays started mid-room miss spells that were already alive when recording began; spells cast after that show normally.
- Only the client can add lag; there is no server-side latency simulation.
- The loot simulator does not simulate gold or the dungeon cache.
