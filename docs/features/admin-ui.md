# Admin page: live view and search

Status: Built 2026-10-01 on `feat/admin-ui`, not pushed. Planned by the owner the same day.

"Can we make the admin interface better?" The owner's pain points: no live view of what is happening, and finding things is slow. The users are the owner and his brother (an admin), on desktops. Each sees only what their role allows: the live view, search results and jumps follow the same permissions the server checks.

## What it does

- **Live tab (the first tab, replacing Overview):** polls `GET /api/admin/live` every 3 s while the browser tab is visible, and at once when it is shown again. On a 429 it waits twice as long each time, up to 30 s, with one toast, and goes back to 3 s on the next answer; the Server log tab does the same from its 5 s.
  - Server health: players in the game, WebSocket connections, the whole-server tick (mean and worst over the last 10 s, coloured against the 50 ms budget: under 25 ms fine, up to 50 a warning, past it late), messages in and out per second, memory (resident and heap), uptime and build. A sparkline of the last 5 minutes: the mean tick per second as a line, the worst tick per second as the shade above it, the budget dashed. Its scale never drops below the budget, so a quiet server is a flat line low down.
  - Online: character, class, level, account, region (or town) and room, world copy, party ("Bob's party (3)") and time online. The name opens the account in Players. Go to and Kick for roles with `teleport` and `kick`.
  - Rooms, busiest first: name and id, kind (world copy, dungeon, antechamber, Arena run, Arena gate, sandbox), players, monsters, minions, live spells (projectiles, novas and ground zones), and the room's own tick (mean and worst over the last 5 s) with a bar against the budget.
  - World copies: a minimap per open world room, regions tinted from a 48-column grid of the world plan, the town outlined, a dot per player in the world room (gold for party members), names on hover. The grid comes once per world copy: the page sends the copies and plan checksums it holds (`have=i1:0a1b2c3d`) and the server leaves those grids out; a rebuild changes the checksum, so the new grid comes on the next poll.
  - Each copy's seed, and "older generation numbers" when it was built with numbers other than those in force (the numbers in the tooltip). "Rebuild" per copy and "Rebuild every copy" (`tuning`) rebuild on the numbers in force now; "Reroll seed" and "Pin" with a typed seed (`settings`) rebuild on a new seed; each asks first and sums up the reply, naming the copies whose plan changed and so forgot their dead bosses and opened chests (world-map.md, "Generation settings"). A public copy brings every public copy on its seed.
  - Server log and staff changes tails, newest first (60 and 40 lines), errors highlighted. Only for `serverLog` (owner, admin); the server sends nothing for other roles.
  - The announce form, for `announce`.
- **Server log tab** (`serverLog`): the whole in-memory log (up to 4000 lines), followed with the `/api/admin/log` cursor every 5 s, filtered by text and kind. A restart is noticed (`startedAt` changes) and read again from the start.
- **Search everywhere:** one box in the header, focused by Ctrl+K or Cmd+K anywhere on the page. Arrow keys, Enter and Escape; up to 12 results with their kind and tab.
  - On the page: every server setting (by label or key), every tuning number (by path, label, category or group), monsters and minions (by name, id or family), the model checker's checks and this browser's try-ons, and API tokens (by name, id, creator or scope; fetched on first use, only for `apiTokens`).
  - On the server (`GET /api/admin/search?q=`, debounced 200 ms): accounts by name, and by any of their characters' names, and log lines for `serverLog`.
  - Ranking: every query word must match the title or a term; a whole match beats a start, a word start and a match inside a word; terms count 0.7 of the title; players come first and log lines last for an equal match.
  - Enter jumps to the match in its tab (clicking a tab by hand clears the jump, so it never replays): a setting's field is focused, a tuning number is shown by its path with its field focused, a monster or minion is selected, an account row is opened, a log line is shown with the filters cleared, a token row is focused. The target flashes gold for 1.8 s. Rows that hold buttons (tokens, accounts) focus the row, not a button, so a stray key press does nothing.
- **Header:** tabs on a row of their own under the title, search and links, since eleven tabs (twelve with the balance bench) did not fit beside them.
- **Balance bench tab** (after Tuning; every staff role sees it, adding and removing admin picks needs `tuning`): every kit, the balance test's spells, the 20 most equipped sigils and admin picks, with Force and damage per Force against the best kit, outliers marked, sortable and filterable; unsaved edits in the Tuning tab are previewed as before, after and the change, and Watch opens two Spell Studio stages. The Tuning tab's edits now live in `admin/tuningDraft.ts` so they survive switching to the bench. Details, routes and tests: [live-tuning.md](live-tuning.md), "The balance bench".

## Why

- **Polling, not a socket,** so it works the same for the admin page and for scripts with a token, through the routes that already check permissions.
- **The server leaves out what a role may not see** rather than the page hiding it: the tails and log search are null without `serverLog`, for sessions by role and for tokens by scope too (a token without the `serverLog` scope gets null even from an owner).
- **The page shows only tabs the role can use** (`apps/client/src/admin/tabs.ts`, `visibleTabs`), and search drops any result whose tab the role cannot open, so a result never leads to a tab that answers 403.
- **Measuring stays cheap:** each room keeps its last 100 tick times in a `Float64Array` ring; the server's tick is summed per second into 300-sample rings, and message counts are two integers. Nothing is allocated per tick; arrays are made only when the route is read.
- **Token polling of `/api/admin/live` goes to stdout only,** like `/api/admin/log`: a script following it every few seconds would otherwise push real events out of the 4000-line buffer. The staff tail also leaves out token reads for the same reason, matched on the whole line (`^[admin] <user> (<role>) token "<name>": GET /api/admin/...$`), so an announcement quoting that text still shows.

## How

Code:

- Shared types and limits: `packages/shared/src/protocol/adminLive.ts` (`AdminLive`, `AdminSearch`, `TICK_BUDGET_MS`, `TICK_HISTORY_SECONDS`, `LIVE_TAIL`, `SEARCH_QUERY`, `SEARCH_LIMITS`).
- Tick timing: `apps/server/src/tickStats.ts` (`Ring`, `ServerStats`, `serverStats`); `RoomManager.tick` times each room and the whole tick, autosaves included; `Client.send` and `RoomManager.onMessage` count messages; `Client.joinedAt` is set on join.
- The live data: `RoomManager.live` (`apps/server/src/manager.ts`), with the region grid cached per world room.
- Routes: `apps/server/src/http.ts` (`/api/admin/live`, `/api/admin/search`, `isStaffChange`, `POLLED_ROUTES`); account search `AccountStore.searchAccounts` (LIKE with `%` and `_` escaped, names starting with the query first, 20 at most); log tails and search `EventLog.recent` and `EventLog.search`.
- Client: `apps/client/src/admin/live/` (`LiveTab.tsx` polls, `parts.tsx` draws, `liveApi.ts` checks replies, `poll.ts` has the backoff and the region grid cache), `admin/LogTab.tsx`, `admin/search/` (`searchIndex.ts` builds and ranks entries, `SearchBox.tsx`), `admin/tabs.ts`; jumps in `AdminApp.tsx` (`useJumpFocus`, elements carry `data-search-id`).

Routes:

| Method | Route | Needs | Reply |
|---|---|---|---|
| GET | `/api/admin/live?have=` | `viewAdmin` | `{ health, players, rooms, worlds, log, staff }`; `log` and `staff` need `serverLog` and are null otherwise; a world's `regions` is null when `have` names its copy and `planHash` (up to 32 `copy:hash` pairs; unreadable ones are ignored) |
| GET | `/api/admin/bench` | `viewAdmin` | `{ picks, popular, popularAt }`: admin picks with who added them, the most equipped sigils by rune text and count (no names); POST `.../bench/picks` and DELETE `.../bench/picks/<id>` need `tuning` (live-tuning.md) |
| POST | `/api/admin/worlds/rebuild` | `tuning` | `{ copies, gen }`: every copy, or `{ game }`; 404 unknown copy, 429 inside the 3 s cooldown (world-map.md, "Generation settings") |
| POST | `/api/admin/worlds/reroll` | `settings` | as rebuild; `{ game }` for a random seed or `{ game, seed }` to pin one |
| GET | `/api/admin/search?q=` | `viewAdmin` | `{ accounts, log }`; `q` 2 to 64 characters after trimming (400 otherwise); `log` needs `serverLog` |

Tests:

- `apps/server/test/adminLive.test.ts`: the ring keeps the newest samples oldest first without growing; ticks roll into one sample per second with the mean, the worst and message rates; the sparkline stays at its window; each room's ticks are measured and bounded; the live view reports players with region, party and time online, rooms with kind and tick, the world copy with dots and a region grid, connections and messages; a region grid goes only to a caller that does not hold it for that plan; the tails go to owner and admin only, newest first, without token reads (matched on the whole line), and are null for moderator and builder, 404 for a player; tokens get the tails only with the `serverLog` scope and their polling stays out of the staff log; account search by name and character, prefix first, `%` and `_` matched as themselves; log search by role and token scope; query length limits.
- `apps/server/test/adminTokens.test.ts`: both routes are in the per-scope route check.
- `apps/client/test/adminSearch.test.ts`: tabs per role (the balance bench for every staff role); every setting has a label; every tuning number is found by path, label and category; ranking order; players and settings above log lines; a character lands on its account; results for tabs the role cannot open are dropped, for every role; the Ctrl+K and Cmd+K shortcut.
- `apps/client/test/adminLive.test.ts`: the reply check; tick colours and durations; the health panel, sparkline, players (actions only when allowed), rooms, log tail and minimap render (the seed and the older numbers flag too); the 429 backoff; the region grid cache, replaced after a rebuild; the rebuild reply check and summary. The rebuild and reroll routes: `apps/server/test/worldGen.test.ts`.
- `apps/server/test/static.test.ts`: pages allow fonts from `'self'` and Google Fonts only.

Checked in a browser as the owner and as a moderator against a local server with four walking test players (screenshots kept with the build notes, not in the repo).

## Limits and open questions

- The tails are the latest lines on every poll, not a stream: a burst of more than 60 lines in 3 s scrolls some past unseen there (the Server log tab has them all).
- Search covers what the page can know: a setting's hint text and a tuning number's note are not searched, and log search sees only the in-memory buffer, so a restart empties it.
- The minimap shows players in the world room only; players in dungeons and the Arena are in the tables.
- The room tick includes sending snapshots; the whole-server tick also includes saves, party sync and staging, so it can be above the sum of the rooms.
- The Overview route (`GET /api/admin/overview`) stays for scripts; the page no longer calls it.
- Found while checking (fixed, owner decision 2026-10-01): the server's content security policy (`apps/server/src/static.ts`, every page) allowed fonts from `https://fonts.gstatic.com` only, which blocked the game's self-hosted `/fonts/AlegreyaSans-*.woff2` everywhere. `font-src` now also has `'self'`.
