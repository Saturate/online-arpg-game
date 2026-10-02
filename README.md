# Allan's ARPG

Browser ARPG demo with an authoritative server. See `SPEC.md` for the design and `DECISIONS.md` for cross-cutting choices made along the way.

**Docs:** every feature (runes, forge, items, loot, stash, monsters, minions, town, Arena, accounts and admin, and more) has its own page, listed in [`docs/features/index.md`](docs/features/index.md).

```sh
pnpm install
pnpm dev          # server (API + websocket) on :8080, client on http://localhost:5173
pnpm test
pnpm typecheck
pnpm town:pull    # copy the live town into apps/server/data/town-layout.json
pnpm town:push <file>   # save a town layout on the server through the admin API (token with townEdit)
pnpm runes:convert-check <db>   # dry-run the v1 to v2 conversion and the rune roll pass on a copy of a rune.db
pnpm world:convert-check <db>   # dry-run the seamless world's waypoint conversion on a copy of a rune.db
```

Live at https://arpg.akj.io. A push to `main` deploys it (GitHub Actions builds the image, Flux rolls it out, the server restarts), so only push when a deploy is wanted. The deployment manifests live in the separate `server` repo under `k3s/apps/arpg/`.

Client URL options:

- `?lag=150` adds 150 ms of round-trip latency, to test prediction
- `?server=ws://host:port` connects to another server
- `?time=0.75` pins the time of day (0 to 1), for looking at nights

Server env: `PORT` (default 8080), `SEED` (default 1337), `ADMIN_USERS` (comma-separated owner usernames; the dev script makes `tester` one), `DB_PATH` (default `data/rune.db`), `TOWN_LAYOUT` (where the town editor saves; default the committed `data/town-layout.json`), `TRUST_PROXY=x-real-ip` behind the WAF.

Controls: WASD to move (screen-relative), mouse to aim. There is no basic attack: left and right mouse cast the skills you pick on the skill bar (click a slot with that button, or scroll; Shift+scroll for the left), and 1 to 4 cast directly. I inventory, C character, K sigil editor (at the forge), T minion stance, Alt loot labels, Delete drops the hovered item, F1 debug, F2 town editor and F3 dev tools (builders; `/sandbox` opens a private test room with the free sigil bench), R ready in an antechamber, Enter chat (`/help` lists commands). The Arena is reached through the portal in town: ready up in the Arena gate, and the champions' stone there shows the leaderboard (also at `/api/arena/leaderboard` and on the admin page's Arena tab). Click-to-move and gamepad are under Esc, Settings.

Create an account (or play as a guest) on the title screen; accounts are stored in `apps/server/data/rune.db`. Delete that file to wipe them. Staff pages live under `/admin`: the admin page at http://localhost:5173/admin/ and the dev tools (Assets with .glb export, Spell Studio, loot simulator, replays) at http://localhost:5173/admin/dev/. Both need a staff login; the dev tools need the builder role or higher.

## Layout

- `packages/shared`: simulation, data, config and protocol. Pure TypeScript with no DOM or Node APIs.
  - `config/sim.ts`: every tuning number; `config/forge.ts` for forge prices and rolled rune drops
  - `data/`: classes, starter sigils, affixes (gear, sigil and rune), enemies, minions, monster tuning overrides
  - `runes/v2/`: the rune grammar (`parse.ts`, `rules.ts`), the compiler (`compile.ts`: runes to an engine program with Force, spirit and the entity budget), the sentence and bracket views, rune descriptions
  - `items/items.ts`: the affix engine, item creation and starter kits; `items/convertV2.ts` converts v1 saves
  - `sim/program.ts`: the spell program the engine runs
  - `sim/`: the ECS world and systems, with `systems.ts` giving the tick order
- `apps/server`: `ws` server running one 20 Hz simulation per room, with interest-managed snapshots.
- `apps/client`: Vite + Three.js for the world (`render/`), React + Zustand for UI panels (`ui/`), and prediction, interpolation and input in `game/`.

## Handoff (2026-09-30, end of session 3)

**Where things stand (2026-10-01, end of session 3).** Live at arpg.akj.io is `f82ead6`: the seamless world (one map per world copy, Emberwatch in the middle, three roads branching into six regions, levels 1 to 25 by distance, ten waypoints, three gate bosses, respawn by inactivity, the world map on M), world streaming (sleeping far monsters, chunked rendering, generation by chunk), stash tabs, the game-feel UI, night lighting, spell and world fire effects, the Hound pack and poison, the Grant item tool, admin API tokens, party frames and teleport, party-only XP, chat item links, admin camera zoom, the town editor palette. Characters convert on their first login after the deploy (waypoints to world waypoints, gate unlocks kept for those who had reached gated zones). The pre-deploy database copy is `apps/server/data/rune.db.live-pre-world-20261001` on the owner's laptop (gitignored).

**Deployed `e3073f4` (2026-10-02): loot piles and the World generation settings (force rebuild, seed reroll and pin)** (backup `rune.db.live-pre-loot-20261002`). Before it, `a37c97b` (2026-10-02): the balance bench tab** (backup `rune.db.live-pre-bench-20261002`). Before it, `df179d0` (2026-10-01): no starters as a special kind, six rune tiers (T1 best and rare), rune and sigil affix ranges in tuning, the balance cap as a report** (backup `rune.db.live-pre-tiers-20261001`; saves re-tier once on load behind `runeTiers: 6`). Before it, `3496590`: the admin Live tab, Server log tab and Ctrl+K search, and the font CSP fix** (backup `rune.db.live-pre-adminui-20261001`). Before it, `b1ffd4f`: the Charger (backup `rune.db.live-pre-charger-20261001`). Since then, deployed `878452e` (the admin town API, live tuning phase 1) and `16555a3` (live tuning phase 2, starter numbers), both 2026-10-01; backups `rune.db.live-pre-tuning-20261001` and `rune.db.live-pre-starters-20261001`. nothing else waits on a branch.** Earlier: deployed as `0859271` (2026-10-01, 14:40). Backup before it: `apps/server/data/rune.db.live-pre-batch-20261001` (owner's laptop, gitignored); both convert checks passed on a copy. Characters and stashes convert on their next load.

- Boss tuning (half life, double damage) and a gate boss respawn setting, all live admin settings ([monsters.md](docs/features/monsters.md)).
- Global cast cooldown 0.5 s as a live admin setting, with a sweep on the skill bar ([runes.md](docs/features/runes.md), "Cast cooldown").
- "First rune is free" removed; Multishot and Flame Cleave buffed; starters cast their hand-set rolls only while whole; the rune roll pass on load ([items.md](docs/features/items.md), "Rune roll pass").
- The Concentrated rune ([runes.md](docs/features/runes.md)).
- Arena: a dead member's warband is desummoned until the run ends ([minions.md](docs/features/minions.md)).
- The trader write is atomic (no duplication on a failed save; [items.md](docs/features/items.md)).
- Fences drawn on their collision line, minion and knockback sub-steps, leader leap checks walls ([town.md](docs/features/town.md)).
- Town looks restored from before the world deploy, house models stored per house with an editor picker ([town.md](docs/features/town.md)).
- Gate walls: arch across the road, a continuous ridge, rivers kept off gates ([world-map.md](docs/features/world-map.md), "Gate walls").
- Done 2026-10-02: the pen corner layout fix, pushed with `pnpm town:push` (the "claude" token got `townEdit` and `tuning` over SSH).

**How to deploy (any change that converts saves).**

1. `pnpm admin GET /api/admin/overview` (who is online), then `pnpm admin backup apps/server/data/rune.db.live-<label>`: the only rollback.
2. `pnpm runes:convert-check <copy>` and `pnpm world:convert-check <copy>`: every check must pass.
3. Gates: `pnpm typecheck`, `pnpm test`, `pnpm -r --if-present build`; then push `main` and watch `gh run watch`.
4. After the rollout: `pnpm admin GET /api/admin/overview` shows the build, `pnpm admin GET "/api/admin/log?since=0"` the conversion lines and errors. Roll back by restoring the copy and redeploying the previous image.

**Working rules** are in `CLAUDE.md`.

**Next.** Planned, each written up in its feature doc:

- **Rune damage update:** damage types, implicits on every rune, ranged per-cast rolls, no stacking, visuals by damage mix, aura payloads and a Righteous Fire bargain ([runes.md](docs/features/runes.md), "Planned: damage types...").
- **Forge redesign:** fused runes, append to open slots, smashing with a 10% survival roll, particles ([forge.md](docs/features/forge.md), "Planned: forge redesign").
- **New minions:** Shieldbearer, Banner-bearer, Hawk, three elementals, a fireball bone mage, a healing tether minion ([minions.md](docs/features/minions.md), "Planned").
- **Guilds** with a guild stash ([guilds.md](docs/features/guilds.md)). Loot piles are built on `feat/loot-piles` ([loot.md](docs/features/loot.md)).
- **World:** region terrain (dunes, caves), bigger worlds (16x to 25x needs a coarser reachability check), the server half of chunked snapshots ([world-map.md](docs/features/world-map.md), [world-streaming.md](docs/features/world-streaming.md)).
- Small requests not started: `docs/backlog.md`.

**Owner decisions (2026-10-01).** Written into their feature docs; none built yet. These are the next build, the "small fixes batch":

- Arena: a dead member's minions are desummoned at the death and come back when the run ends ([minions.md](docs/features/minions.md)).
- Gate bosses get their own respawn setting, apart from the region bosses' 20 minutes ([world-map.md](docs/features/world-map.md)).
- Chests stay shared per world copy.
- "First rune is free" is dropped from the rolls, and Multishot and Flame Cleave get the measured buffs; owned sigils convert on load (built on `fix/rune-rolls`; [runes.md](docs/features/runes.md), [items.md](docs/features/items.md) "Rune roll pass").
- Starter sigils get one open slot, with the forge redesign ([forge.md](docs/features/forge.md)).
- Bosses: half the life, double the damage, both admin settings, every boss ([monsters.md](docs/features/monsters.md)).
- A town save applies without rebuilding the world room (the full fix; [world-map.md](docs/features/world-map.md)).
- The fence corner gets fixed (the trader write duplication is fixed, merged locally 2026-10-01).

**Pen corner (done 2026-10-02):** fences are drawn on their collision line since 2026-10-01, so the pen west of the square was moved to close its corner again (fence 7 to x 696.1, fence 8 to y 1141.3) with `pnpm town:push`. The server keeps the previous layout as a `.bak`.

**Open items.**

- A town save regenerates the world for everyone in it; moving a gate refills every chest (full fix decided, above).
- Packmates or the hero can still catch on some town fence corners (`docs/backlog.md`).
- Owner chores: rotate the Steam API key and the GHCR pull token pasted in chat; the GHCR package could go public.

**Infrastructure.**

- **Traffic:** Cloudflare (proxied DNS, WebSockets on), then the Cilium Gateway (`https-akj`), then the Coraza WAF (nginx), then the `arpg` service. The WAF config and its ReferenceGrant entry for `arpg` live in the server repo's `coraza-waf.yaml`.
- **Manifests:** in the server repo under `k3s/apps/arpg/` (namespace, PVC `arpg-data` mounted at `/data`, deployment, service, httproute, network policy, image policy). The deployment uses the Recreate strategy, since one pod owns the SQLite file.
- **Images:** built by `.github/workflows/image.yml` as `ghcr.io/saturate/online-arpg-game:main-<sha>-<ts>`. Flux image automation commits the new tag to the server repo and rolls it out. Pulls use the `ghcr-pull` secret.
- **Data:** `/data/rune.db` holds accounts, characters, stashes, the trader shelf, settings and monster tuning overrides. `/data/town-layout.json` only exists once a builder saves the town. Secrets in the server repo are SOPS/age encrypted.
- **Checking live state:** use the admin API (`pnpm admin`, token in `~/.config/arpg/admin-token`): `GET /api/admin/overview`, `GET /api/admin/log`, `pnpm admin backup <file>`, and `pnpm town:push <file>` to save a town layout without the editor. Live tuning (spell shapes and rune prices, [live-tuning.md](docs/features/live-tuning.md)): `pnpm admin GET tuning`, `pnpm admin PATCH tuning '{"spell.bolt.damage":20,"force.rune.nova":null}'` (null is the code default), `pnpm admin GET tuning/history`, `pnpm admin POST tuning/revert '{"id":12}'`; the token needs the `tuning` scope. SSH and `kubectl -n arpg` over `ssh akj@svr.akj.io` are a last resort and need 1Password approval.

**Where to look.** Tuning numbers live in `packages/shared/src/config/sim.ts` and `config/forge.ts`, and item rules (grid, stash, trader, forge) in `packages/shared/src/sim/inventory.ts`. The rune grammar and compiler are in `packages/shared/src/runes/v2/`. Admin and roles are in `apps/server/src/http.ts` and `packages/shared/src/protocol/roles.ts`. Worlds, parties and trades are in `apps/server/src/manager.ts`. The reasons behind each choice are in the feature docs ([`docs/features/index.md`](docs/features/index.md)) and, for cross-cutting ones, `DECISIONS.md`.
