# Allan's ARPG

Browser ARPG demo with an authoritative server. See `SPEC.md` for the design and `DECISIONS.md` for cross-cutting choices made along the way.

**Docs:** every feature (runes, forge, items, loot, stash, monsters, minions, town, Arena, accounts and admin, and more) has its own page, listed in [`docs/features/index.md`](docs/features/index.md).

```sh
pnpm install
pnpm dev          # server (API + websocket) on :8080, client on http://localhost:5173
pnpm test
pnpm typecheck
pnpm town:pull    # copy the live town into apps/server/data/town-layout.json
pnpm runes:convert-check <db>   # dry-run the v1 to v2 save conversion on a copy of a rune.db
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

**Where things stand.** Live at arpg.akj.io is `632b418` (deployed 2026-09-30): the rune rework, the monster browser and the 7 commits from session 2. Characters convert to v2 on their first join after the deploy; the pre-deploy database is at `/data/rune.db.pre-v2-20260930` on the volume. Local commits after that are not deployed. The repo is public on GitHub; docs-only pushes no longer rebuild the image.

**Built this session.**

- **The rune rework, phases 2 and 3 of the rune plan.** v2 is the only rune system, with no switch; rolled runes as items; sigils as wands; the 20 built-in skills rebuilt as starter sigils within 15% of their v1 Force and 10% of their v1 damage (held by `skillParity.test.ts` against `test/fixtures/skill-baseline-v1.json`); the new forge editor (slots left to right, the sentence and bracket view, named errors, a dummy preview, gold per inserted rune, runes from bag and stash); the one-time save conversion. Every rule is in [runes.md](docs/features/runes.md), [forge.md](docs/features/forge.md) and [items.md](docs/features/items.md), "Conversion from v1".
- **Monster and minion browser** on the admin page: Monsters, Minions and Model check tabs, overrides applied to new spawns without a deploy, export back to `data/*.ts`. See [monsters.md](docs/features/monsters.md), "Tuning overrides".
- **Reviews:** three rounds of fresh-eyes review on items (loss and duplication) and on the compiler, engine and UI, plus a browser QA pass; all findings fixed. A random spell search (8000 spells per seed) now finds nothing above about 2.13x the best starter's damage per Force; a seeded 300-spell version runs in the tests. The melee swing code left from the old basic attack is removed.

**How the rework was deployed (repeat for any change that converts saves).**

1. Take a copy of `/data/rune.db` first; it is the only rollback, since conversion is one-way. For example: `ssh akj@svr.akj.io 'kubectl -n arpg exec deploy/arpg -- node -e "..."'` with `VACUUM INTO`, as done this session, then copy it off the pod.
2. Run `pnpm runes:convert-check <copy>` on it. On the 2026-09-29 copy: 7 characters, 2 stashes and the 50-item shelf convert; 95 starter sigils, 3 runes to 36 gold, all checks passed. One hand-inscribed sigil ("Wraith Song", a lone Cold rune) fizzles, as it did in v1.
3. Push `main` (the push skill runs the gates and a review loop). The server converts each character on its first join after the deploy and logs it.
4. Check the pod log for conversion lines and any "unreadable" character. To roll back: restore the copy and redeploy the previous image.

**Working rules that carry over.**

- Don't push to `main` without the owner's go: every push deploys and restarts the live server.
- Do most implementation in subagents with a precise brief and file ownership; keep the main session for planning, verification and review. Agents in the same checkout stage only their own files.
- Commit unsigned (`git -c commit.gpgsign=false`) while 1Password is locked; SSH to `svr.akj.io` also needs 1Password approval. A local hook blocks `Claude-Session:` lines in commits.
- Keep the look dark and gritty (D2 Act 1, PoE). Nights must stay playable.
- Anything that moves items gets a fresh-eyes review for loss and duplication before it ships.

**Next, in the owner's order.**

1. **In progress:** stash tabs, the game-feel UI pass with movable panels, then loot piles, guilds and the forge redesign (fused runes, smashing). Plans are in the feature docs.
2. **Loot piles** (parked until after the rework): nearby drops merge into one pile with a header like gold, clicked open into a small window to take items or all ([loot.md](docs/features/loot.md), "Planned: loot piles").
3. **Phase 4 of the rune plan:** Link, Orbit, Homing, Bounce, Chain, Charge and the channelled Beam ([runes.md](docs/features/runes.md), "Planned").

**Open items.**

- Multishot and Flame Cleave kept their weak v1 numbers; measured buffs are in [runes.md](docs/features/runes.md), "Limits and open questions".
- Repeating payloads now cost 60 to 250 Force per cast, which players who built them will read as a nerf. The Force items here are tracked in [runes.md](docs/features/runes.md).
- Fireball and Leap Slam sit near the top of the 15% Force band (+13%); a retune should keep them inside it.
- A once-off payload at its base price can still reach about 2.1x the best starter's damage per Force.
- The "first rune is free" sigil roll is now only worth about 5% of a cast (anything stronger broke the Force budget). Decide whether to keep it, drop it from the rolls or replace it.
- The monster browser cannot edit traits (enrage, burrow, curse) or non-number ability fields ([monsters.md](docs/features/monsters.md)).
- Your brother's monster models: the Model check tab checks a `.glb`; the dog needs facing, colours, loops and hit/death clips first.
- If the SQLite write in a trade throws after a buy and a later save succeeds, the item can exist twice after a restart (older than the rework; [items.md](docs/features/items.md)).
- Replays started mid-room miss spells that were already alive ([dev-tools.md](docs/features/dev-tools.md)). Skill tooltips show base Force, not the admin's cost multiplier.
- Owner chores: rotate the Steam API key and the GHCR pull token that were pasted in chat. The GHCR package could go public too, which would make the pull token unnecessary.

**Infrastructure.**

- **Traffic:** Cloudflare (proxied DNS, WebSockets on), then the Cilium Gateway (`https-akj`), then the Coraza WAF (nginx), then the `arpg` service. The WAF config and its ReferenceGrant entry for `arpg` live in the server repo's `coraza-waf.yaml`.
- **Manifests:** in the server repo under `k3s/apps/arpg/` (namespace, PVC `arpg-data` mounted at `/data`, deployment, service, httproute, network policy, image policy). The deployment uses the Recreate strategy, since one pod owns the SQLite file.
- **Images:** built by `.github/workflows/image.yml` as `ghcr.io/saturate/online-arpg-game:main-<sha>-<ts>`. Flux image automation commits the new tag to the server repo and rolls it out. Pulls use the `ghcr-pull` secret.
- **Data:** `/data/rune.db` holds accounts, characters, stashes, the trader shelf, settings and monster tuning overrides. `/data/town-layout.json` only exists once a builder saves the town. Secrets in the server repo are SOPS/age encrypted.
- **Checking live state:** use `kubectl -n arpg ...` over `ssh akj@svr.akj.io`. To read the database, run node with `node:sqlite` inside the pod (`kubectl -n arpg exec deploy/arpg -- node -e ...`).

**Where to look.** Tuning numbers live in `packages/shared/src/config/sim.ts` and `config/forge.ts`, and item rules (grid, stash, trader, forge) in `packages/shared/src/sim/inventory.ts`. The rune grammar and compiler are in `packages/shared/src/runes/v2/`. Admin and roles are in `apps/server/src/http.ts` and `packages/shared/src/protocol/roles.ts`. Worlds, parties and trades are in `apps/server/src/manager.ts`. The reasons behind each choice are in the feature docs ([`docs/features/index.md`](docs/features/index.md)) and, for cross-cutting ones, `DECISIONS.md`.
