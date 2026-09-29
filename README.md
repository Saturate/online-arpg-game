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

Controls: WASD to move (screen-relative), mouse to aim. There is no basic attack: left and right mouse cast the skills you pick on the skill bar (click a slot with that button, or scroll; Shift+scroll for the left), and 1 to 4 cast directly. I inventory, C character, K sigil editor (at the forge), T minion stance, Alt loot labels, Delete drops the hovered item, F1 debug, F2 town editor and F3 sandbox (builders), Enter chat (`/help` lists commands). Click-to-move and gamepad are under Esc, Settings.

Create an account (or play as a guest) on the title screen; accounts are stored in `apps/server/data/rune.db`. Delete that file to wipe them. Dev tools live at http://localhost:5173/dev.html (Assets, Spell Studio, loot simulator) and the admin page at http://localhost:5173/admin.html.

## Layout

- `packages/shared`: simulation, data, config and protocol. Pure TypeScript with no DOM or Node APIs.
  - `config/sim.ts`: every tuning number
  - `data/`: classes, runes, combos, affixes, enemies, minions
  - `runes/compiler.ts`: rune list to `SpellNode` tree, with heat, spirit, entity cap and dud reasons
  - `items/items.ts`: the affix engine, item creation and starter kits
  - `sim/`: the ECS world and systems, with `systems.ts` giving the tick order
- `apps/server`: `ws` server running one 20 Hz simulation per room, with interest-managed snapshots.
- `apps/client`: Vite + Three.js for the world (`render/`), React + Zustand for UI panels (`ui/`), and prediction, interpolation and input in `game/`.

## Handoff (2026-09-29)

**Where things stand.** Everything through commit `6bc04ea` is live at arpg.akj.io. Later commits (docs only) are local until the next deploy. All 240 tests pass. Live accounts: `LANGSOMT` (owner, via `ADMIN_USERS` in the server repo's `k3s/apps/arpg/deployment.yaml`) and `Bho`.

**Working rules that carry over.**

- Don't push to `main` without the owner's go: every push deploys and restarts the live server.
- Commit unsigned (`git -c commit.gpgsign=false`) while 1Password is locked; SSH to `svr.akj.io` also needs 1Password approval.
- Keep the look dark and gritty (D2 Act 1, PoE). Nights must stay playable.
- Anything that moves items (bag, stash, trader, ground, forge) gets a fresh-eyes review for loss and duplication before it ships.

**Open items.**

- **Unreviewed:** click pickup, gold drops, runes and the forge went live without that review. Do it first.
- **Reported, not reproduced:** "movement can get stuck". The stuck-key fix (Cmd release, tab hide) is live; if it still happens, find out whether it's terrain, input or desync.
- **Tune live:** grime strength, the hero's light radius at night, the slower loot and level pace, Force cooling, minion strength after the buff.
- **Asked, not answered:** put the most-tuned balance numbers (minion strength, Force cost and cooling, drop chances) on the admin page, so balance changes need no deploy.
- **Parked:** weapon-gated skills (see DECISIONS.md, Parked ideas).
- **CI:** a docs-only push still rebuilds and restarts the server; a `paths-ignore` for `*.md` in `.github/workflows/image.yml` would stop that.
- **Owner chores:** rotate the Steam API key and the GHCR pull token that were pasted in chat, and decide on the overhead Postgres password rotation (restarting it also upgrades that image).

**Infrastructure.**

- **Traffic:** Cloudflare (proxied DNS, WebSockets on), then the Cilium Gateway (`https-akj`), then the Coraza WAF (nginx), then the `arpg` service. The WAF config and its ReferenceGrant entry for `arpg` live in the server repo's `coraza-waf.yaml`.
- **Manifests:** in the server repo under `k3s/apps/arpg/` (namespace, PVC `arpg-data` mounted at `/data`, deployment, service, httproute, network policy, image policy). The deployment uses the Recreate strategy, since one pod owns the SQLite file.
- **Images:** built by `.github/workflows/image.yml` as `ghcr.io/saturate/online-arpg-game:main-<sha>-<ts>`. Flux image automation commits the new tag to the server repo and rolls it out. Pulls use the `ghcr-pull` secret.
- **Data:** `/data/rune.db` holds accounts, characters, stashes, the trader shelf and settings. `/data/town-layout.json` only exists once a builder saves the town. Secrets in the server repo are SOPS/age encrypted.
- **Checking live state:** use `kubectl -n arpg ...` over `ssh akj@svr.akj.io`. To read the database, run node with `node:sqlite` inside the pod (`kubectl -n arpg exec deploy/arpg -- node -e ...`).

**Where to look.** Tuning numbers live in `packages/shared/src/config/sim.ts`, and item rules (grid, stash, trader, forge) in `packages/shared/src/sim/inventory.ts`. Admin and roles are in `apps/server/src/http.ts` and `packages/shared/src/protocol/roles.ts`. Worlds, parties and trades are in `apps/server/src/manager.ts`. The reasons behind each choice are in `DECISIONS.md`.
