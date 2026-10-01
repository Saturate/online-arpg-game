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
| `zoomDefault` (camera zoom outdoors and in town; 1 is the classic view, higher is closer) | 1 | 0.6 to 2 |
| `zoomDungeon` (camera zoom in dungeons and their antechambers) | 1 | 0.6 to 2 |
| `zoomMin`, `zoomMax` (how far players may zoom out and in) | 0.8, 1.4 | 0.6 to 2 |
| `respawnMinutes` (minutes a world chunk goes with no player or minion within its wake range before its killed packs and opened chests refill) | 10 | 1 to 240 |
| `bossRespawnMinutes` (the same for region bosses and their escorts) | 20 | 1 to 240 |
| `gateRespawnMinutes` (minutes from a gate boss's death until it comes back, apart from the region bosses) | 20 | 1 to 240 |
| `bossLifeMultiplier` (every boss's life, on top of the rare 3x) | 1.5 | 0.5 to 10 |
| `bossDamageMultiplier` (everything a boss deals: contact, abilities, projectiles, pools) | 2 | 0.5 to 10 |
| `castCooldownSeconds` (seconds between any two sigil casts, before the cast delay affix and cast speed) | 0.5 | 0.1 to 3 |
| `starterDamage` (damage multiplier per starter skill id, only values off 1; a PUT replaces the whole map) | `{}` (every starter 1) | 0.5 to 3 each, starter ids only |

**Respawn times** (built 2026-10-01, not yet deployed). Applied to every running room on save (`setRespawnTimes` in `RoomManager.applySettings`); a chunk already waiting is due by the new time. Counted in game time, which stops while a room is empty. Under a minute, stepping out of a chunk's wake range and back would farm it. See [world-map.md](world-map.md) for the rule; tests in `packages/shared/test/respawn.test.ts` ("respawn settings"). The gate timer is read by `sim/gates.ts` from the boss's death, and the world copy memory's gate timers wait it out ([world-map.md](world-map.md), "Gate bosses").

**Boss tuning** (built 2026-10-01, not yet deployed). Applied to every running room on save (`setRates` in `RoomManager.applySettings`, as `bossLife` and `bossDamage`) and read when a boss spawns, so bosses alive at the change keep theirs. Below 0.5 a boss falls quicker than its pack; above 10 one big attack takes most of a geared character's life. See [monsters.md](monsters.md); tests in `packages/shared/test/monsters.test.ts` ("boss tuning") and `apps/server/test/gates.test.ts` ("boss settings", including a dungeon opened after a change, whose boss spawns as the room is built).

**Camera zoom** (built 2026-10-01, not yet deployed). Both defaults must lie between `zoomMin` and `zoomMax`; `settingsConflict` checks the merged settings on PUT (400 otherwise) and the admin page shows the problem and holds Save. A stored set that clashes goes back to the default zoom fields on load. Below 0.6 the view would reach past the 1100 units snapshots carry, so monsters would pop in at the edge. The four fields go to clients as a `zoom` message on join and on every settings change, like the night lighting, and the client checks them (`isZoomSettings`) since they clamp its camera. Before this the game had no player zoom at all (the wheel picks skills); now Ctrl+scroll or a trackpad pinch zooms, and plain scroll does too when "Scroll wheel picks the mouse skills" is off. The player's zoom is kept per browser as a factor on the area's default (`zoomScale` in the settings store), so it carries between town and dungeons and always shows inside the current limits; a tightened limit applies at once. Settings has "Reset zoom". The town editor keeps its own zoom. Code: `apps/client/src/game/zoom.ts` (`effectiveZoom`, `stepZoomScale`), applied each frame in `game.ts`; tests in `packages/shared/test/chatLinks.test.ts` ("zoom settings"), `apps/server/test/chatLinks.test.ts` and `accounts.test.ts`, and `apps/client/test/zoomAndLinks.test.ts`.

**Cast cooldown** (built 2026-10-01, not yet deployed). Applied to every running room on save through `SimRates.castCooldown`; a cooldown already running keeps its length and the next cast uses the new value. The welcome carries it and each settings change sends a `castCooldown` message, so tooltips show what the server enforces. Under 0.1 s a held key casts almost every tick. See [runes.md](runes.md) ("Cast cooldown"); tests in `apps/server/test/castCooldown.test.ts`.

**Starter damage** (built 2026-10-01, not yet deployed). A table on the Settings tab, one row per starter: the multiplier, its damage per Force to one target and a pack (an estimate: the balance harness's 1x numbers times the multiplier), and that as a share of the best starter's, with a red badge over the 2x bound player-made spells are held to. Starters that deal no damage take no multiplier and their rows are disabled. The Arena follows the live values too, so its scores across a change are not comparable (owner's call). Applied to every running room on save through `SimRates.starterDamage`, which recompiles every equipped sigil, so the next cast uses it. Only a sigil holding its starter's whole recipe gets it; damage only, so heals and shields keep theirs. The welcome carries it and each change sends a `starterDamage` message, so tooltips and the forge show the tuned numbers. A stored map keeps its good entries and drops the rest; a row from before this loads `{}`. It lives in ServerSettings rather than a table like monster tuning because it is one small map. See [runes.md](runes.md) ("Starter damage multipliers"); tests in `apps/server/test/starterDamage.test.ts`, `packages/shared/test/starterTuning.test.ts` and `apps/client/test/starterTuning.test.ts`.

**The Settings form sends only what changed** against what the page loaded (`admin/settingsDiff.ts`), and the starter table only its changed rows over the server's current table, so a stale page does not reset values changed elsewhere. The page reads a reply without `starterDamage` (a server from before it) as every starter at 1, and checks every number field of the reply.

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
- **Checked on every call:** the token's scopes and the creator's role at that moment, both. Any role change, up or down, deletes the account's tokens, so a demotion ends them at once and a later re-promotion does not bring them back; setting the role an account already has keeps them. The per-call role check still covers an owner whose name is taken off `ADMIN_USERS` (no role change is stored for that): their tokens fall back to the stored role, 404 for a player. A ban deletes the creator's tokens (an unban does not bring them back), and a deleted account takes its tokens with it.
- **Format and storage:** `arpg_<16 hex id>_<43 base64url>`. The server stores the id and a SHA-256 hash of the secret part, never the token; the id finds the row and the hashes are compared in constant time. The full token is shown once, when it is made. The list shows id, name, scopes, creator, created, expiry and last used time; the owner sees everyone's tokens and can revoke any, an admin only their own. Revoke deletes the row, so the next call gets 401.
- **Bearer header only:** `Authorization: Bearer <token>`, on `/api/admin/*` only. Cookies and query strings are never read, and on any other route (characters, logout, the game socket) a token is not a login.
- **Rate limit:** 60 calls a minute per token, on top of the 120 a minute per address every request has.
- **Logged:** every token call that passes the scope and route checks, reads included, is a staff log line with the token's name and the route (`GET /api/admin/overview`), written after the action's own line if it changes something. A call that then fails (a bad body, a 409) gets the status: `POST /api/admin/announce -> 400`. A refused or unknown call (403, 404) goes to stdout only, as `... -> 403`: it changes nothing, and a token sending them in a loop would otherwise push real events out of the 4000-entry buffer. Polling `/api/admin/log` goes to stdout only for the same reason.
- **Rejected tokens are logged, throttled:** a token-shaped header that fails (unknown id, wrong secret, expired, revoked, banned creator) logs `[admin] rejected token arpg_<id>_... from <address>` to stdout and the server log, at most once per token id a minute; further failures in that minute are one count line when the minute is up (`... 12 more times in a minute, last from <address>`). Only the id part is printed, never the secret. Past 50 distinct ids in a minute (a scan with random ids) the rest are summed into one line.

**Server log** (`GET /api/admin/log?since=<cursor>`): the last 4000 server events kept in memory: conversions and their reports, unreadable saves, stashes and shelves, errors (room ticks, client messages, failed API requests, uncaught exceptions), staff actions and token calls, arena results, and joins and leaves as counts every 5 minutes. Each entry has `id`, `at`, `kind` (`conversion`, `save`, `error`, `staff`, `players`, `server`) and `text`. The reply is `{ startedAt, next, missed, entries }`: pass `next` as `since` on the next call; `missed` is true when entries after `since` had already dropped out of the buffer, and a changed `startedAt` means the server restarted and the ids started again. At most 1000 entries per reply. Log lines never carry passwords, session tokens or admin tokens; as a safety net, anything shaped like either token is replaced with `[redacted]` before it is kept or printed (a token pasted into an announcement, say). A restart empties the buffer; the pod log keeps everything.

**Backups** (`GET /api/admin/backup`, owner only): `VACUUM INTO` a temp file `.backup-<random>.db` in the database's directory, sent as `rune-<time>.db` (`application/vnd.sqlite3`, attachment) and deleted when the response ends, however it ends. The copy is one consistent snapshot. It runs on the main thread, so the game pauses while it copies (1 to 6 ms for the small test databases; a few ms per MB). A second backup while one is downloading gets 409. A download that sends nothing for 5 minutes (a client that stopped reading) is dropped, which deletes the copy and frees the lock; it logs `backup: the download stalled and was dropped`. The temp path never appears in a reply or a log line. Copies left by a crash mid-download are removed at startup. The copy holds every account's password hash and session hashes, which is why it is owner only.

**The command-line helper** (`pnpm admin`):

- `pnpm admin GET overview`, `pnpm admin GET 'log?since=120'`, `pnpm admin PUT settings '{"xpRate":2}'`, `pnpm admin backup ./rune-copy.db`. A path without a leading `/` is under `/api/admin/`. It prints the JSON reply and exits non-zero on an error.
- **The token only goes to the admin API on `ARPG_URL`** (`scripts/adminClient.ts`, `adminUrl`). A path must end up under `/api/admin/` after `..` and `%2e` segments are resolved. Refused before parsing: `//` anywhere in the path, backslashes (`/\host` is protocol-relative to the URL parser), spaces and control characters (the parser drops tabs and newlines, so `/\t/host` would become `//host`) and anything with a scheme. After parsing, the URL's origin must equal `ARPG_URL`'s. Redirects are refused (`redirect: 'error'`), since the admin API never sends one.
- The token lives in `~/.config/arpg/admin-token` (one line, the full token). The helper refuses to run if the file is readable by group or others: `mkdir -p ~/.config/arpg && (umask 077; pbpaste > ~/.config/arpg/admin-token)`. Never put a token in the repo or in a command line.
- The server is `ARPG_URL`, default `https://arpg.akj.io`. Plain `http` is refused except for localhost (`ARPG_URL=http://localhost:8080` in dev), so the token never crosses the network in the clear.
- `backup` refuses a file that already exists and writes the copy with mode 600. A failed or cut-off download deletes the partial file; a file that appeared under that name in the meantime is left alone.

Tests:

- `apps/server/test/accounts.test.ts`: register and duplicate names (case-insensitive); sessions resolve and revoke; characters per account; save round trip; settings round trip, defaults and validation (the starter damage map included); closed registration; dev tools for builders and up; live role changes; the rate limiter; guest play and claim; one message for bad logins; non-JSON and oversized bodies; the admin API hidden from non-staff; bans end the session, block login and can be undone; each role does only its own part; `ADMIN_USERS` names cannot be registered; idle guest removal keeps played, online and claimed accounts.
- `apps/server/test/adminTokens.test.ts`: the full token is shown once and only a hash is in the database (the WAL included); a wrong secret, a token outside the admin routes, and tokens in a cookie or query string get 401; the overview reports players, rooms, build and uptime; each scope opens only its own routes (every admin route checked per scope), an owner token with all scopes opens all, sessions keep working by role; only owner and admin sessions make tokens, never past their role and never with a token; any role change deletes the creator's tokens (demotion and promotion, through the route and the store) and re-promotion does not revive them, while setting the same role keeps them; an owner taken off `ADMIN_USERS` falls back to the stored role on the next call; expiry; revoke (an admin only their own, the owner anyone); last used; a banned creator's tokens stop for good and a deleted creator's too; every token call is logged with name and route, and no secret, session token or password reaches the log; refused (403) and unknown (404) token calls stay out of the staff log and go to stdout, a 400 is logged with its status; a rejected token is logged once by id and address, never its secret, and the throttle counts repeats and sums ids past the cap; backup is owner only, is a real SQLite copy, leaves no temp file, refuses a second at the same time and never shows the path; a stalled download is dropped, deleting the copy and freeing the lock; the per-token rate limit; the ring buffer's cursor, overflow and redaction.
- `apps/server/test/adminClient.test.ts`: `pnpm admin` builds URLs only under `/api/admin/` on `ARPG_URL`, and refuses `//host`, `/\host`, tab and newline tricks, schemes, `..` and `%2e%2e` out of the admin API; a finished download is written with mode 600, a failed one leaves no file, and an existing file is never touched.
- `apps/server/test/grants.test.ts`: only the owner can grant (admin and moderator 403, players 404) and a refusal writes nothing; every field is validated; an online account is refused and keeps its items; a grant adds exactly one unbound item with a fresh uid, is logged once, and reaches the character on login with every other item unchanged, once; rolled vessel, sigil and rune grants.
- `apps/server/test/worlds.test.ts`: staff teleport; an unreadable stash refuses the join and keeps the row.
- `apps/server/test/convertV2.test.ts`: an unreadable v1 row is kept and the join refused.

## Limits and open questions

- Not built: password reset, account deletion, save versioning beyond the one-time rune conversion ([runes.md](runes.md)).
- TLS is terminated in front of the server (Cloudflare and the cluster gateway); the server itself speaks plain http and ws.
- No stored staff log; stdout and the in-memory buffer only, so a restart empties the buffer.
- The admin page has no tab for the server log yet; it is read with `pnpm admin GET log`.
- A backup blocks the game loop while it copies; fine at today's size, worth a worker thread if the database grows past tens of MB.
- `/help` does not list `/goto` for staff.
- Rank checks cover kick and ban only; any moderator can `/goto` any player.
- Grants go to offline characters only, and to one that has played once; there is no grant to the account stash directly and no way to take a grant back except by hand in the database.
