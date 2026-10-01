# Arena

Status: Live since 2026-09-29 (plan approved and built that day); the underground pit and the town building were pushed to `main` on 2026-09-30.

## What it does

- **Scored wave runs** in a small round underground colosseum, the pit, with a monthly leaderboard.
- **Entry:** the town's Arena entrance, a sunken stone drum with an archway, steps down and a torch either side, leads to the **Arena gate**, an antechamber with the dungeon ready check (R). At the countdown everyone inside goes into a fresh run.
- **Waves** start 3 s after the run begins and get harder: more monsters, more rares and whole packs, and monster level rising with the wave, starting at the party's average level. A 5 s breather follows each cleared wave. Every fifth wave adds the biome's boss.
- **One life per run.** The fallen stay down and watch; the run ends when everyone inside is down or has left.
- **Score:** points per kill plus a bonus per wave cleared, shown live in the party frame and on a score screen at the end.
- **Rewards:** no items and no gold; kill XP is 50%.
- **Leaderboard:** two boards per season (solo and party), shown on the champions' stone in the gate hall, the Arena gate panel, the admin page's Arena tab, and at `GET /api/arena/leaderboard?season=YYYY-MM`.

## Why

- **The Arena is a zone reached from town, not a mode.** The title screen lost its World/Arena choice: everyone enters the world, and the Arena is one of its places.
- **No latecomers:** runs are scored, so nobody joins one after it starts. The gate's pit portal only says to ready up, `/goto` refuses, and a reconnect lands in town.
- **A gate can start another run while one is live;** each run is its own room, with an id from a server-wide counter. A gate closed and reopened during a long run must not reuse a live run's id.
- **Rules are room settings, not map checks:** the server calls `startArena` on a new run's simulation, and that state switches on the Arena waves, scoring, one life, no drops and reduced XP. Other rooms carry `RoomRules` (free bench, map waves).
- **Waves only spawn inside the pit's floor** (`WorldMap.playArea`), since the rock around it has no colliders.
- **A wave still alive after 90 s is joined by the next one,** without its clear bonus, so a party cannot stall a wave to farm a summoner's adds and a stuck monster cannot freeze a run.
- **Score uses the monster's XP value before the level-gap penalty,** so outlevelling the waves does not shrink it. Monsters that pay no rewards (raised corpses) score nothing. Admin XP overrides do not change score, so a season stays comparable ([monsters.md](monsters.md)).
- **Reduced rewards:** Arena kills come fast and in bulk, so full XP would outpace the world; no loot or gold for the same reason.
- **One life:** the fallen see what lies within the interest radius (1100 units) from where they fell. A fallen Binder's minions are desummoned at the death and come back at the gate ([minions.md](minions.md)), so a dead member's warband neither fights on for the living nor idles in the pit. After 10 s on the score screen, everyone still there goes back to the gate on their feet.
- **Runs never pause and refuse dev commands.**
- **Arena runs are saved like any room:** XP earned in a run is kept, and characters move in and out through the same save-on-move path as every other room change.
- **Seasons are calendar months in UTC** (`YYYY-MM`). Solo is a party of one at the start, party is two or more. Ties go to whoever finished first.
- **Staff runs are marked, not hidden:** a run with a builder or above in the party (who can give themselves gear) shows as [staff], since the owner plays too.
- **Names are copied into each row,** so the board keeps its history when a character is deleted.
- **The leaderboard endpoint is public;** it shows names and scores only, under the normal rate limit.
- **The builders' free bench left the Arena,** where it would be cheating, and moved to the private `/sandbox` room ([forge.md](forge.md)).

## How

- Rules: `packages/shared/src/sim/arena.ts` (`startArena`, `arenaWave`, `killScore`, wave clear bonus, `arenaOver`), numbers in `ARENA` in `packages/shared/src/config/sim.ts`, seasons and boards in `packages/shared/src/protocol/arena.ts`.
- Maps: `arenaGateMap` and `colosseumMap` in `packages/shared/src/world/dungeon.ts`.
- Server: runs and results in `apps/server/src/manager.ts` and `apps/server/src/arena.ts` (`ArenaRun` keeps the party and the staff flag from the start); storage in `apps/server/src/accounts.ts` (`recordArenaRun`, `leaderboard`, table `arena_runs`).
- Client: `apps/client/src/ui/ArenaBoard.tsx`, `ui/ArenaPanels.tsx` (the champions' stone and the score screen), the admin Arena tab in `apps/client/src/admin/AdminApp.tsx`; the town building in `apps/client/src/render/props.ts`.

The pit: 44 by 44 cells (1760 units), a 17-cell radius floor, eight 2x2 pillars on a 9-cell ring for cover, 14 torches, no water; the play area is a 640-unit circle. It renders and is lit like a dungeon. The old open Arena field (river, walls, forest, 2800x2000) is kept as the `testground` map for tests.

Waves:

| | Formula (`ARENA`) |
|---|---|
| First wave | 3 s after the start |
| Monsters | `min(40, 6 + 2(n - 1))`, times `1 + 0.6` per extra living player |
| Rare chance | `min(45%, 5% + 2.5%(n - 1))` |
| Whole pack chance | `min(40%, 4%(n - 1))`, packs of 3 to 5 with a rare leader |
| Level | party average + `floor(0.5(n - 1))` |
| Boss | every 5th wave, on top of the count |
| Breather | 5 s after a cleared wave |
| Stall limit | 90 s |
| Clear bonus | 40 x n |
| XP | 50% |
| Score screen | 10 s |
| Board size | top 10 per board, plus earlier seasons' winners |

Biomes cycle by wave; the pool is Chasers, Shooters from wave 2, and the biome's pool.

`arena_runs` holds one row per finished run that reached wave 1: season, names, classes, party size, score, wave, seconds, finish time and the staff flag, indexed by `(season, party_size, score DESC)`.

Tests:

- `packages/shared/test/arena.test.ts`: waves never get easier; more living players bring more monsters and the start is at the party average; kill score is before the level penalty and 0 for rewardless monsters; UTC seasons; the first-wave delay, no loot, half XP and one life; normal rooms still respawn; the 90 s stall limit; the pit is round, underground, dry and torch-lit, and spawn points stay on its floor with 4 players.
- `apps/server/test/arena.test.ts`: town to gate to ready check to a fresh run; a fallen Binder's warband gone for the run and back at the gate; no latecomers and no staff `/goto`; no loot or gold, half XP, kills and waves scored; one life, then the run is recorded and everyone returns to the gate; a party run ends when one is dead and one has left, and goes on the party board; dev commands refused; the builders' sandbox; staff runs marked; public season boards and winners.

## Limits and open questions

- **Not in this version:** Arena-specific monster pools, modifiers per season, rewards for season winners, spectating other runs.
- **No spectator camera:** the fallen watch from where they fell, not by following a living player.
- **Level rises one step every two waves** (the half level per wave is floored).
- **The Arena gate panel** has a button that opens the champions' stone, rather than showing the top 10 itself.
