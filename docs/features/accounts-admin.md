# Accounts, roles and the admin page

Status: Live. Accounts since 2026-09-28, the admin page, staff roles and guests since 2026-09-29. The Grant item tab, admin API tokens, the server log and backups built 2026-09-30, not pushed.

## What it does

- **Accounts:** register with a username and password, or "Play as guest". Up to 12 characters per account. One character online per account at a time.
- **Guests** get a generated name (`Guest` plus 6 hex characters) and a one-year session. The character screen offers to claim the account with a real name and password; the characters stay. Unclaimed guests are deleted after 90 days without play.
- **Roles:** player, builder, moderator, admin and owner. Staff pages live under `/admin/`; the dev tools at `/admin/dev/` need builder or higher ([dev-tools.md](dev-tools.md)).
- **The admin page** (`/admin/`) has seven tabs, nine for an admin and ten for the owner:
  - **Overview:** online count, games, rooms, memory, uptime and build; the announce form; the online players with Go to and Kick; games and rooms. Refreshes every 3 s.
  - **Players:** account search, with role, guest and banned badges, the role picker (owner only), ban and unban, and each account's characters.
  - **Arena:** the season leaderboards with a month picker ([arena.md](arena.md)).
  - **Settings:** live server settings (below). Everyone who can open the page can view them; only the `settings` permission can edit.
  - **Monsters, Minions, Model check:** tuning overrides and the model checker ([monsters.md](monsters.md)).
  - **API tokens** (owner and admin): make, list and revoke tokens for scripts and agents. See "Admin API tokens" below.
  - **Grant item** (owner only): pick an account by name and one of its characters, then an item: Brothers Creation, or a rolled vessel (any type or random), sigil or rolled rune by tier and item level, the rolls the dev tools make. The item goes onto the character as pending and lands on their next login. See "Item grants" below.
- The header links to the dev tools for builders and up, and reminds town editors that the editor is F2 in town ([town.md](town.md)).

## Why

- **HTTP for accounts, WebSocket for play:** register, login and character CRUD are plain JSON endpoints on the game server's port. The socket's `join` carries only a session token and a character id. Vite proxies `/api` in dev, so everything stays same-origin and no CORS is served.
- **Storage is SQLite via Node's built-in `node:sqlite`,** so there is no new dependency. WAL mode, `synchronous=NORMAL`, foreign keys on.
- **Passwords:** scrypt (N=2^15, r=8, p=1, 32-byte key, 16-byte salt) with a timing-safe compare. Unknown usernames still run a hash, and login failures return one message, so usernames cannot be probed that way. Passwords are 8 to 128 characters; the cap exists because scrypt cost grows with input length.
- **Sessions:** 32 random bytes, stored only as a SHA-256 hash, valid for 30 days (guests 365), revoked on logout. They are bearer tokens in localStorage (`rune.session`) rather than cookies, so cross-site requests carry nothing. Expired sessions are removed at startup.
- **Rate limits:** per IP over a sliding minute; 10 for register, login and guest, 120 for everything else. Behind the WAF, `TRUST_PROXY=x-real-ip` reads `X-Real-IP` (`cloudflare` reads `CF-Connecting-IP`); `X-Forwarded-For` is never read.
- **Characters:** 12 per account, with names unique server-wide (case-insensitive). Every query is scoped by account id.
- **One character online per account:** a second login ends the first session after saving it ("Logged in from another window"), which stops item duplication across two windows.
- **Save points:** first entry, every room change, disconnect, a 30 s autosave (all online characters in one transaction), and shutdown (SIGINT, SIGTERM and uncaught exceptions save everyone first). The character and the account stash are always written together in one transaction ([stash.md](stash.md)).
- **An unreadable save is never overwritten.** The join is refused ("This character could not be loaded. Nothing was lost; ask the server owner to look at it."), the row is kept and the server logs it. An unreadable stash refuses the join the same way. The trader shelf is the exception: a damaged shelf starts fresh after a log line.
- **Roles are fixed permission sets** in `protocol/roles.ts`, ranked by their order. Owner comes from `ADMIN_USERS` and is never stored or grantable; names in `ADMIN_USERS` cannot be registered or claimed. Only the owner hands out roles.
- **Staff act only on accounts ranked below them** for kick and ban. An owner may unban anyone. Nobody can ban themselves or change an owner's role.
- **The admin API answers 404, not 403, to non-staff,** so it does not advertise itself.
- **Guests make the first step free** and keep what they played: claiming turns the same account into a real one.

| Role | Permissions |
|---|---|
| player | none |
| builder | `viewAdmin`, `townEdit`, `devTools` |
| moderator | `viewAdmin`, `announce`, `kick`, `ban`, `teleport` |
| admin | everything except `manageRoles`, `grantItems` and `backup` |
| owner | all thirteen, including `manageRoles`, `grantItems` and `backup` |

## How

Code:

- HTTP routes: `apps/server/src/http.ts`; tuning routes in `apps/server/src/tuningRoutes.ts`.
- Admin tokens: `apps/server/src/adminTokens.ts` (table `admin_tokens`); shared rules and types in `packages/shared/src/protocol/adminTokens.ts`; the page in `apps/client/src/admin/TokensTab.tsx`; the command-line helper `scripts/admin.ts`.
- Server log buffer: `apps/server/src/eventLog.ts`.
- Storage: `apps/server/src/accounts.ts` (tables `accounts`, `sessions`, `characters`, `settings`, `arena_runs`) and `apps/server/src/tuningStore.ts` (`tuning_overrides`). The file is `DB_PATH`, default `data/rune.db` relative to the server's working directory (`apps/server/data/rune.db` in dev, `/data/rune.db` in the pod). The `settings` table holds the server settings under key `server` and the trader shelf under `trader`.
- Live sessions, kicks, announcements and `/goto`: `apps/server/src/manager.ts`.
- Guest cleanup: `apps/server/src/index.ts`, once at startup and then every 6 hours; accounts online at the time are skipped. Characters, sessions and the stash go with the account.
- Shared types and limits: `packages/shared/src/protocol/accounts.ts` (`ServerSettings`, `SETTINGS_LIMITS`, name and password rules), `packages/shared/src/protocol/roles.ts` (`ROLES`, `GRANTS`, `can`).
- Client: `apps/client/src/ui/Login.tsx`, `ui/CharacterSelect.tsx` (claim), `apps/client/src/admin/AdminApp.tsx`, `admin/access.tsx` (`StaffGate`).

Routes:

| Method | Route | Needs |
|---|---|---|
| POST | `/api/register`, `/api/login`, `/api/guest` | none (auth rate bucket; register and guest refuse when registration is closed) |
| GET | `/api/town`, `/api/arena/leaderboard?season=` | none |
| POST | `/api/logout`, `/api/claim` | session |
| GET, POST | `/api/characters` | session |
| DELETE | `/api/characters/:id` | session (ends the live session first) |
| GET | `/api/admin/overview`, `/api/admin/accounts`, `/api/admin/settings`, `/api/admin/monsters`, `/api/admin/minions` | `viewAdmin` |
| PUT | `/api/admin/settings`; PUT and DELETE `/api/admin/{monsters,minions}/:type` | `settings` |
| POST | `/api/admin/announce` | `announce` |
| POST | `/api/admin/kick` | `kick` |
| POST | `/api/admin/accounts/:id/ban` | `ban` (a ban also kicks and deletes the account's sessions) |
| POST | `/api/admin/goto` | `teleport` |
| POST | `/api/admin/accounts/:id/role` | `manageRoles` |
| POST | `/api/admin/grant` | `grantItems` (owner only) |
| GET | `/api/admin/log?since=<cursor>` | `serverLog` (admin, owner) |
| GET | `/api/admin/backup` | `backup` (owner only) |
| GET, POST | `/api/admin/tokens`; DELETE `/api/admin/tokens/:id` | `apiTokens` (admin, owner), login session only |

Every `/api/admin/*` route takes either a login session (the role decides) or an admin token (its scopes decide, never past the creator's current role). It is one API; the admin page and scripts share the routes, validation and staff log.

Bodies must be JSON and at most 4096 bytes.

Live settings (`ServerSettings`), applied without a restart:

| Field | Default | Range |
|---|---|---|
| `xpRate`, `lootRate` | 1 | 0 to 20 |
| `motd` | empty | 200 characters, cleaned like chat |
| `registrationOpen` | true | |
| `worldSeed` | 1 | 0 to 999,999 |
| `dayMinutes` | 20 | 2 to 240 |
| `nightBrightness` | 0.6 | 0 to 1 |
| `heroLight` (the hero's light at night; party members get a faint share; underground it scales the hero's torch) | 0.8 | 0 to 3 |
| `heroLightRadius` (how far the hero's night light reaches, world units) | 520 | 200 to 1600 |
| `lampLight` (torches, lanterns, fires, portals and waypoints at night, and every torch underground) | 1 | 0 to 3 |
| `timeOfDay` | `cycle` | `cycle` or `hold` |
| `clockOffset`, `heldPhase` | 0, 0.25 | 0 to 1 (phase 0 is 06:00) |
| `forceMax` (the level-1 Force bar) | 1000 | 50 to 5000 |
| `forceCostRate`, `forceCoolRate` | 1 | 0.1 to 10 |
| `forceRampMax` (cooling ramp cap) | 6 | 1 to 20 |

Force changes apply to everyone at once. The admin page's sliders are narrower than the server allows (rates to 5 on the slider, 20 in the number box; day length to 120 on the slider).

Staff actions:

- **Announce** sends an "Announcement:" system chat line and a banner to everyone.
- **Kick** ends the session with "You were removed from the game by an admin".
- **Go to** (and `/goto name` in chat) puts staff 40 units beside the player, in their world copy and room. It refuses a player in an Arena run or a sandbox, or between rooms.

**Item grants** (`POST /api/admin/grant`, body `{ username, characterId, template, tier, level, minion, rune }`):

- **Owner only.** `grantItems` is a new permission only the owner holds, like `manageRoles`: it makes real, tradeable items from nothing, so a taken-over admin account cannot mint them. Admins and moderators get 403, everyone else 404.
- **Every field is checked on the server:** unknown fields are refused; the username must be an account name; the character must belong to that account and have entered the world once (a character without a save is refused); `template` is `brothers_creation`, `vessel`, `sigil` or `rune`; `tier` a tier (Brothers Creation only `relic`); `level` a whole number from 1 to 30; `minion` only for a vessel and `rune` only for a rolled rune, each a real id or null for a random roll.
- **Offline only.** A grant to an account with any live session is refused with 409 ("is online ... ask them to log out, then try again") rather than handed to the room: the session's next save would write its own copy of the character over the grant. From the online check to the write nothing awaits, and a login loads the character synchronously, so a login cannot slip in between.
- **Exactly one item, pending.** The server reads the stored save, refuses one it cannot read or a v1 save not loaded since the rune update, and appends one item to its item list in a transaction that writes the row only if it is still the row it read. The item takes a uid above every uid in the save (runes inside sigils included), and the room reissues uids on load anyway. It is in no grid or slot, which is what pending means ([items.md](items.md)): the next login lays it out like any pending item, stash first (it is unbound), then the bag, and it stays pending if neither has room. Nothing else in the save is touched; `played_at` is not bumped.
- **Grants are never bound**, unlike dev tool items, since they are meant to be traded (the brothers' vessels).
- **Logged** as `[admin] <owner> (owner): grant "<name>" (<template>, <tier>, item level <n>, uid <uid>) to <account> / <character> (character <id>), pending until next login`.

**Staff log:** every staff action (settings, announce, kick, ban and unban, goto, role, monster and minion edits, item grants, token changes, backups) is written to stdout as `[admin] <user> (<role>): <what>`, and a token call as `[admin] <user> (<role>) token "<name>": <what>`. It is kept in the pod log and in the server log buffer below; nothing is stored in the database.

**Admin API tokens:**

- **Made on the admin page** (API tokens tab) by an owner or admin, from a login session only: a token can never list, make or revoke tokens, so a leaked one cannot mint more. Each has a name (1 to 32 letters, digits, spaces, `_ . -`), scopes and an expiry of 1, 7, 30 or 90 days (the API takes 1 to 90). At most 20 live tokens per account.
- **Scopes** are role permissions: `viewAdmin` (always included), `announce`, `kick`, `ban`, `teleport`, `settings`, `manageRoles`, `grantItems`, `serverLog`, `backup`. `townEdit` and `devTools` are left out because they gate the game socket, which a token cannot open; `apiTokens` is left out as above. The creator can only pick scopes their role has, so `manageRoles`, `grantItems` and `backup` tokens come only from the owner.
- **Checked on every call:** the token's scopes and the creator's role at that moment, both. A creator who is demoted loses those powers on their tokens at once; demoted to player, their tokens get 404 like any non-staff. A ban deletes the creator's tokens (an unban does not bring them back), and a deleted account takes its tokens with it.
- **Format and storage:** `arpg_<16 hex id>_<43 base64url>`. The server stores the id and a SHA-256 hash of the secret part, never the token; the id finds the row and the hashes are compared in constant time. The full token is shown once, when it is made. The list shows id, name, scopes, creator, created, expiry and last used time; the owner sees everyone's tokens and can revoke any, an admin only their own. Revoke deletes the row, so the next call gets 401.
- **Bearer header only:** `Authorization: Bearer <token>`, on `/api/admin/*` only. Cookies and query strings are never read, and on any other route (characters, logout, the game socket) a token is not a login.
- **Rate limit:** 60 calls a minute per token, on top of the 120 a minute per address every request has.
- **Logged:** every token call, reads included, is a staff log line with the token's name and the route (`GET /api/admin/overview`), and then the action's own line if it changes something. Polling `/api/admin/log` goes to stdout only, or a script following the log would push out the events it came for.

**Server log** (`GET /api/admin/log?since=<cursor>`): the last 4000 server events kept in memory: conversions and their reports, unreadable saves, stashes and shelves, errors (room ticks, client messages, failed API requests, uncaught exceptions), staff actions and token calls, arena results, and joins and leaves as counts every 5 minutes. Each entry has `id`, `at`, `kind` (`conversion`, `save`, `error`, `staff`, `players`, `server`) and `text`. The reply is `{ startedAt, next, missed, entries }`: pass `next` as `since` on the next call; `missed` is true when entries after `since` had already dropped out of the buffer, and a changed `startedAt` means the server restarted and the ids started again. At most 1000 entries per reply. Log lines never carry passwords, session tokens or admin tokens; as a safety net, anything shaped like either token is replaced with `[redacted]` before it is kept or printed (a token pasted into an announcement, say). A restart empties the buffer; the pod log keeps everything.

**Backups** (`GET /api/admin/backup`, owner only): `VACUUM INTO` a temp file `.backup-<random>.db` in the database's directory, sent as `rune-<time>.db` (`application/vnd.sqlite3`, attachment) and deleted when the response ends, however it ends. The copy is one consistent snapshot. It runs on the main thread, so the game pauses while it copies (1 to 6 ms for the small test databases; a few ms per MB). A second backup while one is downloading gets 409. The temp path never appears in a reply or a log line. Copies left by a crash mid-download are removed at startup. The copy holds every account's password hash and session hashes, which is why it is owner only.

**The command-line helper** (`pnpm admin`):

- `pnpm admin GET overview`, `pnpm admin GET 'log?since=120'`, `pnpm admin PUT settings '{"xpRate":2}'`, `pnpm admin backup ./rune-copy.db`. A path without a leading `/` is under `/api/admin/`. It prints the JSON reply and exits non-zero on an error.
- The token lives in `~/.config/arpg/admin-token` (one line, the full token). The helper refuses to run if the file is readable by group or others: `mkdir -p ~/.config/arpg && (umask 077; pbpaste > ~/.config/arpg/admin-token)`. Never put a token in the repo or in a command line.
- The server is `ARPG_URL`, default `https://arpg.akj.io`. Plain `http` is refused except for localhost (`ARPG_URL=http://localhost:8080` in dev), so the token never crosses the network in the clear.
- `backup` refuses a file that already exists and writes the copy with mode 600.

Tests:

- `apps/server/test/accounts.test.ts`: register and duplicate names (case-insensitive); sessions resolve and revoke; characters per account; save round trip; settings round trip, defaults and validation; closed registration; dev tools for builders and up; live role changes; the rate limiter; guest play and claim; one message for bad logins; non-JSON and oversized bodies; the admin API hidden from non-staff; bans end the session, block login and can be undone; each role does only its own part; `ADMIN_USERS` names cannot be registered; idle guest removal keeps played, online and claimed accounts.
- `apps/server/test/adminTokens.test.ts`: the full token is shown once and only a hash is in the database (the WAL included); a wrong secret, a token outside the admin routes, and tokens in a cookie or query string get 401; the overview reports players, rooms, build and uptime; each scope opens only its own routes (every admin route checked per scope), an owner token with all scopes opens all, sessions keep working by role; only owner and admin sessions make tokens, never past their role and never with a token; a demoted creator's token loses what the role lost; expiry; revoke (an admin only their own, the owner anyone); last used; a banned creator's tokens stop for good and a deleted creator's too; every token call is logged with name and route, and no secret, session token or password reaches the log; backup is owner only, is a real SQLite copy, leaves no temp file, refuses a second at the same time and never shows the path; the per-token rate limit; the ring buffer's cursor, overflow and redaction.
- `apps/server/test/grants.test.ts`: only the owner can grant (admin and moderator 403, players 404) and a refusal writes nothing; every field is validated; an online account is refused and keeps its items; a grant adds exactly one unbound item with a fresh uid, is logged once, and reaches the character on login with every other item unchanged, once; rolled vessel, sigil and rune grants.
- `apps/server/test/worlds.test.ts`: staff teleport; an unreadable stash refuses the join and keeps the row.
- `apps/server/test/convertV2.test.ts`: an unreadable v1 row is kept and the join refused.

## Limits and open questions

- Not built: password reset, account deletion, save versioning beyond the one-time rune conversion ([runes.md](runes.md)).
- TLS is terminated in front of the server (Cloudflare and the cluster gateway); the server itself speaks plain http and ws.
- No stored staff log; stdout and the in-memory buffer only, so a restart empties the buffer.
- The admin page has no tab for the server log yet; it is read with `pnpm admin GET log`.
- A backup blocks the game loop while it copies; fine at today's size, worth a worker thread if the database grows past tens of MB.
- Invalid token attempts are not logged (the per-address limit caps them).
- `/help` does not list `/goto` for staff.
- Rank checks cover kick and ban only; any moderator can `/goto` any player.
- Grants go to offline characters only, and to one that has played once; there is no grant to the account stash directly and no way to take a grant back except by hand in the database.
