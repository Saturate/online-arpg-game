# Allan's ARPG

Browser ARPG demo with an authoritative server. See `SPEC.md` for the design and `DECISIONS.md` for choices made along the way.

```sh
pnpm install
pnpm dev          # server (API + websocket) on :8080, client on http://localhost:5173
pnpm test
pnpm typecheck
pnpm town:pull    # copy the live town into apps/server/data/town-layout.json
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
  - `config/sim.ts`: every tuning number
  - `data/`: classes, runes, combos, affixes, enemies, minions
  - `runes/compiler.ts`: rune list to `SpellNode` tree, with heat, spirit, entity cap and dud reasons
  - `items/items.ts`: the affix engine, item creation and starter kits
  - `sim/`: the ECS world and systems, with `systems.ts` giving the tick order
- `apps/server`: `ws` server running one 20 Hz simulation per room, with interest-managed snapshots.
- `apps/client`: Vite + Three.js for the world (`render/`), React + Zustand for UI panels (`ui/`), and prediction, interpolation and input in `game/`.

## Handoff (2026-09-29, end of session 2)

**Where things stand.** Live at arpg.akj.io through `fbb1097`: the Arena as a zone with scored runs and monthly leaderboards, spells sent once instead of every tick, the weighted live spell cap, the castable Spell Lab, the item-safety fixes (phase 0), Force tuning on the admin page, the zone damage lockout, zone gates, waypoint models, click-to-open stations, WebSocket compression and batched saves. Seven commits after that are **local, reviewed clean, waiting for the owner's go to deploy**: the minion walk/run stutter fix, tooltips closing with their window, sunny days with shared overcast weather (nights kept at their tuned darkness), the Arena entrance building and the underground colosseum pit, dev tools deep links, and faceted Blender exports. 334 tests pass. Live data: 7 characters on 3 accounts; `LANGSOMT` is the owner (via `ADMIN_USERS` in the server repo's `k3s/apps/arpg/deployment.yaml`).

**Working rules that carry over.**

- Don't push to `main` without the owner's go: every push deploys and restarts the live server. Use the push skill (gates, then a fresh-eyes review loop until clean).
- Do most implementation in subagents with a precise brief and file ownership; keep the main session for planning, verification and review. Agents in the same checkout stage only their own files.
- Commit unsigned (`git -c commit.gpgsign=false`) while 1Password is locked; SSH to `svr.akj.io` also needs 1Password approval. A local hook blocks `Claude-Session:` lines in commits.
- Keep the look dark and gritty (D2 Act 1, PoE). Nights must stay playable.
- Anything that moves items gets a fresh-eyes review for loss and duplication before it ships.

**Next, in the owner's order.**

1. **Deploy** the 7 local commits once the owner says so.
2. **The rune rework**, phases 2 and 3 of PLAN-runes.md, approved: the v2 grammar as the real compiler behind a switch, rolled runes as items, sigils as wands, the built-in skills rebuilt as pre-rolled starter sigils, the new forge editor (left-to-right slots, the Spell Lab's sentence and bracket view, a preview, gold per inserted rune, and runes drawn from the account stash as well as the bag: bag first, refunds to the bag or pending), save conversion tested on a copy of the live saves, and a balance pass with the Spell Studio harness. All owner decisions are in PLAN-runes.md, "Decisions". The current forge UI is poor (shows built-in skills as "Unstable", lists every rune at count 0, no description); the rework replaces it.
3. **Monster browser** on the admin page: every monster type with its model and animations, editable life, speed, size, damage, XP and ability numbers, stored in the database and applied to new spawns without a deploy, with reset and an export back to `data/enemies.ts`. Plan agreed in chat, not built.
4. **Loot piles** (parked until after the rework, since both touch item code): nearby drops merge into one pile with a header like gold, clicked open into a small window to take items or all.

**Open ideas and small items.**

- Town editor only edits the town; zones and dungeons are generated. Hand-placed set pieces on generated zones were proposed, not decided.
- Minion abilities with cooldowns and vessel ability affixes, the channelled Beam and the Charge rune, and vessels with a rolled casting sigil are in PLAN-runes.md.
- Skill tooltips show base Force cost, not the admin's cost multiplier.
- Replays started mid-room miss spells that were already alive.
- Unbound legacy items already in account stashes stay there (old data only).
- Owner chores: rotate the Steam API key and the GHCR pull token that were pasted in chat.
- CI: a docs-only push still rebuilds and restarts the server; `paths-ignore` for `*.md` in `.github/workflows/image.yml` would stop that.

**Infrastructure.**

- **Traffic:** Cloudflare (proxied DNS, WebSockets on), then the Cilium Gateway (`https-akj`), then the Coraza WAF (nginx), then the `arpg` service. The WAF config and its ReferenceGrant entry for `arpg` live in the server repo's `coraza-waf.yaml`.
- **Manifests:** in the server repo under `k3s/apps/arpg/` (namespace, PVC `arpg-data` mounted at `/data`, deployment, service, httproute, network policy, image policy). The deployment uses the Recreate strategy, since one pod owns the SQLite file.
- **Images:** built by `.github/workflows/image.yml` as `ghcr.io/saturate/online-arpg-game:main-<sha>-<ts>`. Flux image automation commits the new tag to the server repo and rolls it out. Pulls use the `ghcr-pull` secret.
- **Data:** `/data/rune.db` holds accounts, characters, stashes, the trader shelf and settings. `/data/town-layout.json` only exists once a builder saves the town. Secrets in the server repo are SOPS/age encrypted.
- **Checking live state:** use `kubectl -n arpg ...` over `ssh akj@svr.akj.io`. To read the database, run node with `node:sqlite` inside the pod (`kubectl -n arpg exec deploy/arpg -- node -e ...`).

**Where to look.** Tuning numbers live in `packages/shared/src/config/sim.ts`, and item rules (grid, stash, trader, forge) in `packages/shared/src/sim/inventory.ts`. Admin and roles are in `apps/server/src/http.ts` and `packages/shared/src/protocol/roles.ts`. Worlds, parties and trades are in `apps/server/src/manager.ts`. The reasons behind each choice are in `DECISIONS.md`.
