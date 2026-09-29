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
