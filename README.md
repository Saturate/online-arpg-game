# Allan's ARPG

Browser ARPG demo with an authoritative server. See `SPEC.md` for the design and `DECISIONS.md` for choices made along the way.

```sh
pnpm install
pnpm dev          # server (API + websocket) on :8080, client on http://localhost:5173
pnpm test
pnpm typecheck
```

Client URL options:

- `?lag=150` adds 150 ms of round-trip latency, to test prediction
- `?server=ws://host:port` connects to another server

Server env: `PORT` (default 8080) and `SEED` (default 1337).

Controls: WASD to move (screen-relative), mouse to aim, left click to attack, 1 to 4 to cast sigils, I for the inventory, K for the sigil editor, T to cycle minion stance, F1 for the debug overlay (also shows dud reasons and the fixture loader in the editor).

Create an account on the title screen; characters are stored in `apps/server/data/rune.db`. Delete that file to wipe all accounts. Dev tools live at http://localhost:5173/dev.html (Assets, Spell Studio).

## Layout

- `packages/shared`: simulation, data, config and protocol. Pure TypeScript with no DOM or Node APIs.
  - `config/sim.ts`: every tuning number
  - `data/`: classes, runes, combos, affixes, enemies, minions
  - `runes/compiler.ts`: rune list to `SpellNode` tree, with heat, spirit, entity cap and dud reasons
  - `items/items.ts`: the affix engine, item creation and starter kits
  - `sim/`: the ECS world and systems, with `systems.ts` giving the tick order
- `apps/server`: `ws` server running one 20 Hz simulation per room, with interest-managed snapshots.
- `apps/client`: Vite + Three.js for the world (`render/`), React + Zustand for UI panels (`ui/`), and prediction, interpolation and input in `game/`.
