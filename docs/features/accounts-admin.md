# Accounts, roles and the admin page

Status: Live. Accounts since 2026-09-28, the admin page, staff roles and guests since 2026-09-29.

## What it does

- **Accounts:** register with a username and password, or "Play as guest". Up to 12 characters per account. One character online per account at a time.
- **Guests** get a generated name (`Guest` plus 6 hex characters) and a one-year session. The character screen offers to claim the account with a real name and password; the characters stay. Unclaimed guests are deleted after 90 days without play.
- **Roles:** player, builder, moderator, admin and owner. Staff pages live under `/admin/`; the dev tools at `/admin/dev/` need builder or higher ([dev-tools.md](dev-tools.md)).
- **The admin page** (`/admin/`) has seven tabs:
  - **Overview:** online count, games, rooms, memory, uptime and build; the announce form; the online players with Go to and Kick; games and rooms. Refreshes every 3 s.
  - **Players:** account search, with role, guest and banned badges, the role picker (owner only), ban and unban, and each account's characters.
  - **Arena:** the season leaderboards with a month picker ([arena.md](arena.md)).
  - **Settings:** live server settings (below). Everyone who can open the page can view them; only the `settings` permission can edit.
  - **Monsters, Minions, Model check:** tuning overrides and the model checker ([monsters.md](monsters.md)).
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
| admin | everything except `manageRoles` |
| owner | all nine, including `manageRoles` |

## How

Code:

- HTTP routes: `apps/server/src/http.ts`; tuning routes in `apps/server/src/tuningRoutes.ts`.
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
| `heroLight` (the hero's light at night; party members get a faint share; underground it scales the hero's torch) | 1 | 0 to 3 |
| `heroLightRadius` (how far the hero's night light reaches, world units) | 700 | 200 to 1600 |
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

**Staff log:** there is no stored log or admin tab for it. Every staff action (settings, announce, kick, ban and unban, goto, role, monster and minion edits) is written to the server's stdout as `[admin] <user> (<role>): <what>`, so it shows in the pod log only.

Tests:

- `apps/server/test/accounts.test.ts`: register and duplicate names (case-insensitive); sessions resolve and revoke; characters per account; save round trip; settings round trip, defaults and validation; closed registration; dev tools for builders and up; live role changes; the rate limiter; guest play and claim; one message for bad logins; non-JSON and oversized bodies; the admin API hidden from non-staff; bans end the session, block login and can be undone; each role does only its own part; `ADMIN_USERS` names cannot be registered; idle guest removal keeps played, online and claimed accounts.
- `apps/server/test/worlds.test.ts`: staff teleport; an unreadable stash refuses the join and keeps the row.
- `apps/server/test/convertV2.test.ts`: an unreadable v1 row is kept and the join refused.

## Limits and open questions

- Not built: password reset, account deletion, save versioning beyond the one-time rune conversion ([runes.md](runes.md)).
- TLS is terminated in front of the server (Cloudflare and the cluster gateway); the server itself speaks plain http and ws.
- No stored staff log; only stdout.
- `/help` does not list `/goto` for staff.
- Rank checks cover kick and ban only; any moderator can `/goto` any player.
