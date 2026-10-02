import {
  can,
  checkLayout,
  cleanChat,
  createGrantItem,
  parseGrantRequest,
  Rng,
  isAssignableRole,
  isSeason,
  isSessionToken,
  isAdminToken,
  parseCredentials,
  parseNewAdminToken,
  TOKEN_RULES,
  parseNewCharacter,
  parseSettingsPatch,
  settingsConflict,
  layoutHash,
  rank,
  seasonOf,
  type AdminAccount,
  type AdminOverview,
  type AdminLive,
  type AdminSearch,
  LIVE_TAIL,
  parseLiveHave,
  SEARCH_LIMITS,
  SEARCH_QUERY,
  type ServerEvent,
  type AdminTokenInfo,
  type CharactersResponse,
  type CreatedAdminToken,
  type Permission,
  type Role,
  type ServerSettings,
  type TownLayout,
  SETTINGS_LIMITS,
  type WorldRebuildResult,
} from '@rune/shared';
import { randomInt } from 'node:crypto';
import { createReadStream, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account, AccountStore } from './accounts.js';
import type { TokenCaller } from './adminTokens.js';
import { events, redact } from './eventLog.js';
import { tuningRoute, type TuningHooks } from './tuningRoutes.js';
import { TUNABLES_BODY_BYTES, tunablesRoute, type TunablesHooks } from './tunablesRoutes.js';
import { benchRoute } from './benchRoutes.js';

/** Credentials and a character name fit many times over; anything bigger is not a real request. */
const MAX_BODY_BYTES = 4096;

/**
 * `PUT /api/admin/town` takes a whole layout. The largest valid one (every limit in TOWN_LIMITS
 * filled, full-precision coordinates, pretty-printed like `pnpm town:pull` writes it) is 1.73 MB;
 * the rest is room for wider indentation. adminTown.test.ts builds it and checks it fits. Only a
 * caller with `townEdit` gets this far, so nobody else can make the server buffer that much.
 */
export const TOWN_BODY_BYTES = 3 * 1024 * 1024;

/** Sliding one-minute window per IP. Auth is tight because every attempt costs a 32 MiB scrypt hash. */
/**
 * `tuningWrites` is per account: every live tuning change recompiles each equipped sigil in every
 * room and messages every client, so a script in a loop would stall the game thread.
 * `benchWrites` is per account too, apart from tuning so adding picks never uses up a tuning change.
 */
const LIMITS = { auth: 10, other: 120, token: TOKEN_RULES.perMinute, tuningWrites: 30, benchWrites: 20 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A backup download that sends nothing for this long is dropped: a client that stopped reading
 * would otherwise hold the one-backup lock and a full copy of the database on the data volume.
 */
const BACKUP_STALL_MS = 5 * 60_000;

/** A file sent as a download instead of a JSON body; `done` runs once, however the response ends. */
class Download {
  constructor(
    readonly file: string,
    readonly filename: string,
    readonly done: () => void,
  ) {}
}

type Reply = [number, unknown] | Download;

/** Who is calling an admin route: a logged-in staff member, or a script with an admin token. */
type Caller = { account: Account; token: null } | { account: Account; token: TokenCaller };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Drops idle keys so a scan from many addresses cannot grow the map forever. */
  sweep(): void {
    const t = this.now();
    for (const [key, list] of this.hits) if (list.every((at) => t - at >= 60_000)) this.hits.delete(key);
  }
}

/**
 * Behind Cloudflare and the WAF every request arrives from a proxy address, which would make the
 * rate limit one shared bucket for all players. TRUST_PROXY=x-real-ip uses the header the WAF sets
 * after resolving the client through Cloudflare's ranges (it overwrites any client-sent value);
 * TRUST_PROXY=cloudflare reads CF-Connecting-IP, only safe when the origin is reachable through
 * Cloudflare alone. Unset, the socket address is used, since both headers are trivially spoofed.
 */
function clientIp(req: IncomingMessage): string {
  const mode = process.env.TRUST_PROXY;
  const header = mode === 'x-real-ip' ? req.headers['x-real-ip'] : mode === 'cloudflare' ? req.headers['cf-connecting-ip'] : undefined;
  if (typeof header === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(header)) return header;
  return req.socket.remoteAddress ?? 'unknown';
}

/** A town save from the editor or the admin API: what was rebuilt, or why nothing was saved. */
export type TownSaveResult = { ok: true; rooms: number; players: number } | { ok: false; reason: 'wait' | 'failed' };

/** What the admin API needs from the running game; the room manager provides it. */
export interface AdminHooks extends TuningHooks, TunablesHooks {
  overview(): AdminOverview;
  /** The Live view without the log tails, which the API adds by permission; `have` is from parseLiveHave. */
  live(have?: ReadonlyMap<string, string>): Omit<AdminLive, 'log' | 'staff'>;
  settings(): ServerSettings;
  updateSettings(patch: Partial<ServerSettings>): ServerSettings;
  announce(text: string): number;
  /** Warns everyone online that a restart for an update comes in `seconds`; returns how many it reached. */
  restartCountdown(seconds: number): number;
  kickCharacter(characterId: number): boolean;
  kickAccount(accountId: number): void;
  /** The live town, for `pnpm town:pull`. Every player is sent it on entering town, so it is public. */
  currentTown(): TownLayout;
  /** Writes a validated layout and rebuilds the world rooms, under the editor's cooldown for this account. */
  saveTown(accountId: number, layout: TownLayout): TownSaveResult;
  /** Moves the staff member's live character next to the target; returns why not, or null. */
  gotoCharacter(staffAccountId: number, characterId: number): string | null;
  /** Applies a new role to the account's live session, if it has one. */
  roleChanged(accountId: number, role: Role): void;
  /** Whether the account has a session in the game (any character, in any room or between rooms). */
  accountOnline(accountId: number): boolean;
  /**
   * Rebuilds world copies (every one, or `game` and the copies sharing its world) with the generation
   * numbers in force now; 'wait' inside the cooldown, or why not.
   */
  rebuildWorlds(accountId: number, game: string | null): WorldRebuildResult | string;
  /** A new seed (random, or `seed`) for a world copy, rebuilt at once; 'wait' inside the cooldown, or why not. */
  rerollWorld(accountId: number, game: string, seed: number | null): WorldRebuildResult | string;
}

/** World copy ids as the Live view lists them (`i12`). */
const GAME_ID = /^[A-Za-z0-9_-]{1,32}$/;

function rebuildLine(r: WorldRebuildResult): string {
  const gen = Object.entries(r.gen).map(([k, v]) => `${k}=${v}`).join(' ') || 'code defaults';
  const copies = r.copies.map((c) => `${c.name} (${c.game}, seed ${c.seed}${c.open ? `, ${c.players} players` : ', closed'}${c.planChanged ? ', new plan, memory dropped' : ''})`).join('; ');
  const failed = r.failed.map((f) => `${f.name} (${f.game}) left as it was: ${f.reason}`).join('; ');
  return `${copies || 'no world copies'}${failed ? `; ${failed}` : ''}; numbers ${gen}`;
}

const GRANT_ERRORS = {
  no_character: [404, 'That account has no such character'],
  never_played: [409, 'That character has never entered the world; play it once first'],
  unreadable: [409, "That character's save cannot be read; nothing was changed"],
  old_format: [409, 'That character has not logged in since the rune update; log it in once first'],
} as const;

export function parseAdminUsers(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
}

/** ADMIN_USERS are owners whatever the database says, so the top role can only be granted on the server. */
export function roleOf(account: Pick<Account, 'username' | 'role'>, owners: ReadonlySet<string>): Role {
  return owners.has(account.username.toLowerCase()) ? 'owner' : account.role;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  // Requiring JSON also rules out cross-site form posts, which can only send form or text bodies.
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large');
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Only the Authorization header is read, never cookies or the query string, so no browser sends a token by itself. */
function bearerValue(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

function bearer(req: IncomingMessage): string | null {
  const token = bearerValue(req);
  return isSessionToken(token) ? token : null;
}

function sendFile(res: ServerResponse, download: Download, stallMs: number): void {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    download.done();
  };
  let size: number;
  try {
    size = statSync(download.file).size;
  } catch (err) {
    done();
    events.error('error', 'backup: the copy could not be read', err);
    send(res, 500, { error: 'Backup failed' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/vnd.sqlite3',
    'content-length': size,
    'content-disposition': `attachment; filename="${download.filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const stream = createReadStream(download.file);
  stream.on('error', () => {
    done();
    res.destroy();
  });
  // 'close' fires however the response ends, including a client that hangs up halfway.
  res.on('close', () => {
    stream.destroy();
    done();
  });
  // The socket timer restarts on every write the client takes, so only a stalled download ends here.
  res.setTimeout(stallMs, () => {
    events.warn('server', 'backup: the download stalled and was dropped');
    res.destroy();
  });
  stream.pipe(res);
}

/** Routes a page or script calls every few seconds; their token calls go to stdout, not the staff log. */
const POLLED_ROUTES: ReadonlySet<string> = new Set(['/api/admin/log', '/api/admin/live']);

/**
 * The Live view's staff tail shows changes. A token's reads are staff lines too (`... token "x": GET
 * /api/admin/overview`), and a script polling would push every change out of the tail. Matched on
 * the whole line, so an announcement quoting that text is still shown.
 */
const TOKEN_READ = /^\[admin\] \S+ \(\w+\) token "[^"]*": GET \/api\/admin\/\S+$/;

export function isStaffChange(e: ServerEvent): boolean {
  return e.kind === 'staff' && !TOKEN_READ.test(e.text);
}

const FAILED_TOKEN_WINDOW_MS = 60_000;

/**
 * Failed admin token logins, throttled so a script with a stale token or a guesser cannot flood the
 * log: the first failure per token id in a minute is a line, the rest a count once the minute is up.
 * Only the id part is ever printed, never the secret. Beyond `maxIds` distinct ids in a minute
 * (random ids from a scan) the rest are one summed line, which also keeps the map small.
 */
export class FailedTokenLog {
  private readonly open = new Map<string, { since: number; more: number; lastIp: string }>();
  private overflow = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxIds = 50,
  ) {}

  record(tokenId: string, ip: string): void {
    const t = this.now();
    const entry = this.open.get(tokenId);
    if (entry && t - entry.since < FAILED_TOKEN_WINDOW_MS) {
      entry.more++;
      entry.lastIp = ip;
      return;
    }
    if (entry) this.report(tokenId, entry);
    if (!entry && this.open.size >= this.maxIds) {
      this.overflow++;
      return;
    }
    this.open.set(tokenId, { since: t, more: 0, lastIp: ip });
    events.warn('server', `[admin] rejected token arpg_${tokenId}_... from ${ip} (unknown, wrong, expired or revoked)`);
  }

  /** Reports and forgets every minute that is up. The API calls it once a minute. */
  sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.open) {
      if (t - entry.since < FAILED_TOKEN_WINDOW_MS) continue;
      this.report(id, entry);
      this.open.delete(id);
    }
    if (this.overflow > 0) {
      events.warn('server', `[admin] rejected ${this.overflow} more token attempts with other ids`);
      this.overflow = 0;
    }
  }

  private report(tokenId: string, entry: { more: number; lastIp: string }): void {
    if (entry.more > 0) events.warn('server', `[admin] rejected token arpg_${tokenId}_... ${entry.more} more times in a minute, last from ${entry.lastIp}`);
  }
}

export class AccountApi {
  private readonly authLimit = new RateLimiter(LIMITS.auth);
  private readonly otherLimit: RateLimiter;
  private readonly tokenLimit: RateLimiter;
  private readonly tuningWriteLimit: RateLimiter;
  private readonly benchWriteLimit: RateLimiter;
  private readonly failedTokens: FailedTokenLog;
  private readonly backupStallMs: number;
  private readonly sweepTimer = setInterval(() => {
    this.authLimit.sweep();
    this.otherLimit.sweep();
    this.tokenLimit.sweep();
    this.tuningWriteLimit.sweep();
    this.benchWriteLimit.sweep();
    this.failedTokens.sweep();
  }, 60_000);
  /** One backup at a time: each is a full copy of the database on the data volume. */
  private backupRunning = false;

  constructor(
    private readonly store: AccountStore,
    /** Called when a character is deleted, so a live session on it is ended first. */
    private readonly onCharacterDeleted: (characterId: number) => void,
    private readonly admin: AdminHooks,
    /** Lower-cased owner usernames, from ADMIN_USERS. Empty means nobody. */
    private readonly owners: ReadonlySet<string> = parseAdminUsers(process.env.ADMIN_USERS),
    /** Tests lower these to reach the limits in a few calls. */
    limits: { other?: number; token?: number; tuningWrites?: number; benchWrites?: number; backupStallMs?: number; failedTokens?: FailedTokenLog } = {},
  ) {
    this.otherLimit = new RateLimiter(limits.other ?? LIMITS.other);
    this.tokenLimit = new RateLimiter(limits.token ?? LIMITS.token);
    this.tuningWriteLimit = new RateLimiter(limits.tuningWrites ?? LIMITS.tuningWrites);
    this.benchWriteLimit = new RateLimiter(limits.benchWrites ?? LIMITS.benchWrites);
    this.failedTokens = limits.failedTokens ?? new FailedTokenLog();
    this.backupStallMs = limits.backupStallMs ?? BACKUP_STALL_MS;
    this.sweepTimer.unref();
    for (const name of owners) {
      if (!store.usernameExists(name)) events.warn('server', `[admin] ADMIN_USERS lists "${name}" but no such account exists; it cannot be registered while listed`);
    }
  }

  private roleOf(account: Account): Role {
    return roleOf(account, this.owners);
  }

  /** Returns false for paths outside /api so the caller can 404 them. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    this.route(req, url.pathname, url.searchParams)
      .then((reply) => (reply instanceof Download ? sendFile(res, reply, this.backupStallMs) : send(res, reply[0], reply[1])))
      .catch((err: unknown) => {
        if (err instanceof HttpError) send(res, err.status, { error: err.message });
        else {
          events.error('error', `${req.method ?? 'GET'} ${url.pathname} failed`, err);
          send(res, 500, { error: 'Server error' });
        }
      });
    return true;
  }

  private async route(req: IncomingMessage, path: string, query: URLSearchParams): Promise<Reply> {
    const ip = clientIp(req);
    const method = req.method ?? 'GET';
    const isAuth = path === '/api/register' || path === '/api/login' || path === '/api/guest';
    if (!(isAuth ? this.authLimit : this.otherLimit).allow(ip)) throw new HttpError(429, 'Too many requests, wait a minute');

    if (method === 'POST' && path === '/api/guest') {
      if (!this.admin.settings().registrationOpen) throw new HttpError(403, 'Registration is closed on this server');
      const account = await this.store.registerGuest();
      return [201, { token: this.store.createSession(account.id), username: account.username }];
    }
    if (method === 'POST' && isAuth) {
      const creds = parseCredentials(await readJson(req));
      if (typeof creds === 'string') throw new HttpError(400, creds);
      if (path === '/api/register') {
        if (!this.admin.settings().registrationOpen) throw new HttpError(403, 'Registration is closed on this server');
        // Owner rights follow the username, so a listed name must not be claimable by a stranger.
        if (this.owners.has(creds.username.toLowerCase())) throw new HttpError(409, 'That username is taken');
        const account = await this.store.register(creds.username, creds.password);
        if (account === 'taken') throw new HttpError(409, 'That username is taken');
        return [201, { token: this.store.createSession(account.id), username: account.username }];
      }
      const account = await this.store.verify(creds.username, creds.password);
      // One message for both cases, so the endpoint does not reveal which usernames exist.
      if (!account) throw new HttpError(401, 'Wrong username or password');
      if (account === 'banned') throw new HttpError(403, 'This account is banned');
      return [200, { token: this.store.createSession(account.id), username: account.username }];
    }

    if (method === 'GET' && path === '/api/town') return [200, this.admin.currentTown()];
    // Public like the board in the Arena gate hall: it shows character names and scores, nothing else.
    if (method === 'GET' && path === '/api/arena/leaderboard') {
      const season = query.get('season') || seasonOf(Date.now());
      if (!isSeason(season)) throw new HttpError(400, 'season must be a month like 2026-09');
      return [200, this.store.leaderboard(season)];
    }

    // Admin tokens work on the admin routes only; everywhere else they are not a login.
    const raw = bearerValue(req);
    if (path.startsWith('/api/admin/') && isAdminToken(raw)) {
      const caller = this.store.adminTokens.authenticate(raw);
      if (!caller) {
        // isAdminToken matched, so the id is there; only it is logged, never the secret after it.
        this.failedTokens.record(raw.slice(5, 21), ip);
        throw new HttpError(401, 'Invalid, expired or revoked token');
      }
      if (!this.tokenLimit.allow(caller.tokenId)) throw new HttpError(429, 'Too many requests for this token, wait a minute');
      return this.tokenCall(req, method, path, query, caller);
    }
    const token = bearer(req);
    const account = token ? this.store.accountForToken(token) : null;
    if (!token || !account) throw new HttpError(401, 'Not logged in');

    if (method === 'POST' && path === '/api/logout') {
      this.store.deleteSession(token);
      return [200, { ok: true }];
    }
    if (path === '/api/characters') {
      if (method === 'GET') return [200, this.characters(account)];
      if (method === 'POST') {
        const input = parseNewCharacter(await readJson(req));
        if (typeof input === 'string') throw new HttpError(400, input);
        const made = this.store.createCharacter(account.id, input.name, input.classId);
        if (made === 'taken') throw new HttpError(409, 'That name is taken');
        if (made === 'limit') throw new HttpError(409, 'Character limit reached');
        return [201, made];
      }
    }
    if (method === 'POST' && path === '/api/claim') {
      const creds = parseCredentials(await readJson(req));
      if (typeof creds === 'string') throw new HttpError(400, creds);
      // Owner names are reserved at registration; claiming is another way to pick a name.
      if (this.owners.has(creds.username.toLowerCase())) throw new HttpError(409, 'That username is taken');
      const result = await this.store.claimGuest(account.id, creds.username, creds.password);
      if (result === 'taken') throw new HttpError(409, 'That username is taken');
      if (result === 'not_guest') throw new HttpError(400, 'This account already has a name and password');
      return [200, { username: creds.username }];
    }
    if (path.startsWith('/api/admin/')) return this.adminRoute(req, method, path, query, { account, token: null });
    const match = /^\/api\/characters\/(\d{1,9})$/.exec(path);
    if (match && method === 'DELETE') {
      const id = Number(match[1]);
      if (!this.store.loadCharacter(account.id, id)) throw new HttpError(404, 'No such character');
      this.onCharacterDeleted(id);
      this.store.deleteCharacter(account.id, id);
      return [200, { ok: true }];
    }
    throw new HttpError(404, 'Not found');
  }

  /**
   * Every token call that gets past the scope and route checks is in the staff log, reads too, after
   * the action's own line. A refused or unknown route (403, 404) goes to stdout only: those change
   * nothing, and a token sending them in a loop would otherwise push real events out of the buffer.
   * Polling the log or the live view goes to stdout only, or a script following them would do the same.
   */
  private async tokenCall(req: IncomingMessage, method: string, path: string, query: URLSearchParams, caller: TokenCaller): Promise<Reply> {
    const line = `[admin] ${caller.account.username} (${this.roleOf(caller.account)}) token "${caller.name}": ${method} ${path}`;
    let reply: Reply;
    try {
      reply = await this.adminRoute(req, method, path, query, { account: caller.account, token: caller });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 403 || status === 404) console.log(redact(`${line} -> ${status}`));
      else events.log('staff', `${line} -> ${status}`);
      throw err;
    }
    if (POLLED_ROUTES.has(path)) console.log(line);
    else events.log('staff', line);
    return reply;
  }

  private characters(account: Account): CharactersResponse {
    return { username: account.username, characters: this.store.listCharacters(account.id), role: this.roleOf(account), guest: this.store.isGuest(account.id) };
  }

  /** Admin actions are logged with who did them, since they change other players' accounts and the live server. */
  private async adminRoute(req: IncomingMessage, method: string, path: string, query: URLSearchParams, caller: Caller): Promise<Reply> {
    const { account, token } = caller;
    // The role is read on every call, so a token loses what its creator loses.
    const role = this.roleOf(account);
    // 404 rather than 403 for non-staff, so the admin API is not advertised to everyone else.
    if (!can(role, 'viewAdmin')) throw new HttpError(404, 'Not found');
    /** A token may do what both its scopes and its creator's current role allow. */
    const allowed = (permission: Permission) => can(role, permission) && (token === null || token.scopes.some((s) => s === permission));
    const need = (permission: Permission) => {
      if (!allowed(permission)) throw new HttpError(403, token ? 'This token cannot do that' : 'Your role cannot do that');
    };
    need('viewAdmin');
    /** Staff act only on accounts ranked below them, so a moderator cannot ban or kick an admin. */
    const outranks = (target: Account) => rank(role) > rank(this.roleOf(target));
    const who = token ? `${account.username} (${role}) token "${token.name}"` : `${account.username} (${role})`;
    const log = (what: string) => events.log('staff', `[admin] ${who}: ${what}`);
    if (method === 'GET' && path === '/api/admin/overview') return [200, this.admin.overview()];
    if (method === 'GET' && path === '/api/admin/live') {
      // The tails are left out, not blanked on the page: a role without serverLog never gets them.
      const logs = allowed('serverLog');
      const live: AdminLive = {
        ...this.admin.live(parseLiveHave(query.get('have'))),
        log: logs ? events.recent(LIVE_TAIL.log, (e) => e.kind !== 'staff') : null,
        staff: logs ? events.recent(LIVE_TAIL.staff, isStaffChange) : null,
      };
      return [200, live];
    }
    if (method === 'GET' && path === '/api/admin/search') {
      const q = (query.get('q') ?? '').trim();
      if (q.length < SEARCH_QUERY.min || q.length > SEARCH_QUERY.max) throw new HttpError(400, `q must be ${SEARCH_QUERY.min} to ${SEARCH_QUERY.max} characters`);
      const found: AdminSearch = {
        accounts: this.store.searchAccounts(q, SEARCH_LIMITS.accounts).map((a) => ({ ...a, role: roleOf(a, this.owners) })),
        log: allowed('serverLog') ? events.search(q, SEARCH_LIMITS.log) : null,
      };
      return [200, found];
    }
    if (path === '/api/admin/tokens' || path.startsWith('/api/admin/tokens/')) return this.tokenRoute(req, method, path, caller, role, log);
    if (method === 'GET' && path === '/api/admin/log') {
      need('serverLog');
      const since = query.get('since') ?? '0';
      if (!/^\d{1,15}$/.test(since)) throw new HttpError(400, 'since must be a whole number (the last response\'s next)');
      return [200, events.since(Number(since))];
    }
    if (method === 'GET' && path === '/api/admin/backup') {
      need('backup');
      return this.backup(log);
    }
    if (method === 'GET' && path === '/api/admin/accounts') {
      const list: AdminAccount[] = this.store.listAccounts().map((a) => ({ ...a, role: roleOf(a, this.owners) }));
      return [200, list];
    }
    if (path === '/api/admin/settings') {
      if (method === 'GET') return [200, this.admin.settings()];
      if (method === 'PUT') {
        need('settings');
        const patch = parseSettingsPatch(await readJson(req));
        if (typeof patch === 'string') throw new HttpError(400, patch);
        const conflict = settingsConflict({ ...this.admin.settings(), ...patch });
        if (conflict) throw new HttpError(400, conflict);
        log(`settings ${JSON.stringify(patch)}`);
        return [200, this.admin.updateSettings(patch)];
      }
    }
    if (method === 'PUT' && path === '/api/admin/town') {
      need('townEdit');
      // The same check as a save from the editor, unknown decor and models refused, not dropped.
      const layout = checkLayout(await readJson(req, TOWN_BODY_BYTES));
      if (typeof layout === 'string') throw new HttpError(400, layout);
      const saved = this.admin.saveTown(account.id, layout);
      if (!saved.ok) throw saved.reason === 'wait' ? new HttpError(429, 'Wait a few seconds between town saves') : new HttpError(500, 'Could not save the town on the server');
      const hash = layoutHash(layout);
      log(`town saved "${layout.name}" (${layout.props.length} props, ${layout.paths.length} paths, ${layout.decor.length} decor, hash ${hash}); ${saved.rooms} world rooms rebuilt, ${saved.players} players carried over`);
      return [200, { name: layout.name, hash, props: layout.props.length, paths: layout.paths.length, decor: layout.decor.length, rooms: saved.rooms, players: saved.players }];
    }
    const tuning = await tuningRoute({ method, path, body: () => readJson(req), canEdit: allowed('settings'), log }, this.admin);
    if (tuning) return tuning;
    const by = { account: account.username, token: token?.name ?? null };
    const tunables = await tunablesRoute({ method, path, query, body: () => readJson(req, TUNABLES_BODY_BYTES), canEdit: allowed('tuning'), allowWrite: () => this.tuningWriteLimit.allow(String(account.id)), by, log }, this.store.tunables, this.admin);
    if (tunables) return tunables;
    const bench = await benchRoute({ method, path, body: () => readJson(req), canEdit: allowed('tuning'), allowWrite: () => this.benchWriteLimit.allow(String(account.id)), by, log }, this.store.bench);
    if (bench) return bench;
    if (method === 'POST' && (path === '/api/admin/worlds/rebuild' || path === '/api/admin/worlds/reroll')) {
      const reroll = path.endsWith('/reroll');
      // A reroll of the public world sets the world seed, a setting; a rebuild applies tuned numbers.
      need(reroll ? 'settings' : 'tuning');
      const body = await readJson(req);
      const game = isRecord(body) ? body.game : undefined;
      const gameOk = typeof game === 'string' ? GAME_ID.test(game) : game === undefined && !reroll;
      if (!gameOk) throw new HttpError(400, reroll ? 'game is required: a world copy id from the Live view' : 'game must be a world copy id, or left out for every copy');
      const seed = isRecord(body) ? body.seed : undefined;
      if (seed !== undefined && (!reroll || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > SETTINGS_LIMITS.seedMax)) throw new HttpError(400, `seed must be a whole number from 0 to ${SETTINGS_LIMITS.seedMax}, on a reroll`);
      const result = reroll && typeof game === 'string' ? this.admin.rerollWorld(account.id, game, typeof seed === 'number' ? seed : null) : this.admin.rebuildWorlds(account.id, typeof game === 'string' ? game : null);
      if (result === 'wait') throw new HttpError(429, 'Wait a few seconds between world rebuilds');
      if (typeof result === 'string') throw new HttpError(404, result);
      log(`${reroll ? 'world reroll' : 'world rebuild'}: ${rebuildLine(result)}`);
      return [200, result];
    }
    if (method === 'POST' && path === '/api/admin/announce') {
      need('announce');
      const body = await readJson(req);
      const text = cleanChat(isRecord(body) ? body.text : undefined);
      if (!text) throw new HttpError(400, 'Announcement text is required');
      log(`announce "${text}"`);
      return [200, { reached: this.admin.announce(text) }];
    }
    if (method === 'POST' && path === '/api/admin/restart-countdown') {
      need('announce');
      const body = await readJson(req);
      const raw = isRecord(body) ? body.seconds : undefined;
      // A warning only; the deploy restarts the server. Ten minutes is as far ahead as anyone plans one.
      const seconds = raw === undefined ? 60 : raw;
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 10 || seconds > 600) throw new HttpError(400, 'seconds must be a whole number from 10 to 600');
      log(`restart countdown ${seconds} s`);
      return [200, { reached: this.admin.restartCountdown(seconds) }];
    }
    if (method === 'POST' && path === '/api/admin/kick') {
      need('kick');
      const body = await readJson(req);
      const id = isRecord(body) ? body.characterId : undefined;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new HttpError(400, 'characterId is required');
      const target = this.store.accountForCharacter(id);
      if (!target) throw new HttpError(404, 'No such character');
      if (!outranks(target)) throw new HttpError(403, 'You can only kick players ranked below you');
      log(`kick character ${id}`);
      return [200, { kicked: this.admin.kickCharacter(id) }];
    }
    const ban = /^\/api\/admin\/accounts\/(\d{1,9})\/ban$/.exec(path);
    if (ban && method === 'POST') {
      need('ban');
      const id = Number(ban[1]);
      const body = await readJson(req);
      const banned = isRecord(body) ? body.banned : undefined;
      if (typeof banned !== 'boolean') throw new HttpError(400, 'banned must be true or false');
      if (id === account.id) throw new HttpError(400, 'You cannot ban yourself');
      const target = this.store.accountById(id);
      if (!target) throw new HttpError(404, 'No such account');
      // Owners may unban each other, so an owner banned before being listed can still be let back in.
      if (!outranks(target) && !(role === 'owner' && !banned)) throw new HttpError(403, 'You can only ban players ranked below you');
      this.store.setBanned(id, banned);
      if (banned) this.admin.kickAccount(id);
      log(`${banned ? 'ban' : 'unban'} ${target.username}`);
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/api/admin/goto') {
      need('teleport');
      const body = await readJson(req);
      const id = isRecord(body) ? body.characterId : undefined;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new HttpError(400, 'characterId is required');
      const error = this.admin.gotoCharacter(account.id, id);
      if (error) throw new HttpError(409, error);
      log(`goto character ${id}`);
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/api/admin/grant') {
      need('grantItems');
      const grant = parseGrantRequest(await readJson(req));
      if (typeof grant === 'string') throw new HttpError(400, grant);
      // From here to the write nothing awaits, so a login cannot slip in between the check and the
      // write, and a login loads the character synchronously too.
      const target = this.store.accountByUsername(grant.username);
      if (!target) throw new HttpError(404, 'No such account');
      // A live session would save its own copy of the character over the grant, so it is refused
      // rather than handed to the room.
      if (this.admin.accountOnline(target.id)) throw new HttpError(409, `${target.username} is online; grants go to offline accounts only. Ask them to log out, then try again.`);
      const rng = new Rng(randomInt(0, 2 ** 32));
      const result = this.store.grantPendingItem(target.id, grant.characterId, (newUid) => createGrantItem(grant, newUid, rng));
      if (!result.ok) {
        const [status, message] = GRANT_ERRORS[result.error];
        throw new HttpError(status, message);
      }
      log(`grant "${result.item.name}" (${grant.template}, ${result.item.tier}, item level ${result.item.ilvl}, uid ${result.item.uid}) to ${target.username} / ${result.characterName} (character ${grant.characterId}), pending until next login`);
      return [200, { item: result.item, character: result.characterName }];
    }
    const roleRoute = /^\/api\/admin\/accounts\/(\d{1,9})\/role$/.exec(path);
    if (roleRoute && method === 'POST') {
      need('manageRoles');
      const id = Number(roleRoute[1]);
      const body = await readJson(req);
      const next = isRecord(body) ? body.role : undefined;
      if (!isAssignableRole(next)) throw new HttpError(400, 'role must be player, builder, moderator or admin');
      const target = this.store.accountById(id);
      if (!target) throw new HttpError(404, 'No such account');
      if (this.roleOf(target) === 'owner') throw new HttpError(400, 'Owners are set with ADMIN_USERS on the server');
      this.store.setRole(id, next);
      this.admin.roleChanged(id, next);
      log(`role ${target.username}: ${target.role} -> ${next}`);
      return [200, { ok: true }];
    }
    throw new HttpError(404, 'Not found');
  }

  /**
   * Token management is for a logged-in owner or admin only: a token can never list, make or revoke
   * tokens, so a leaked one cannot mint more. The owner sees and revokes everyone's; an admin their own.
   */
  private async tokenRoute(req: IncomingMessage, method: string, path: string, caller: Caller, role: Role, log: (what: string) => void): Promise<Reply> {
    if (caller.token) throw new HttpError(403, 'Tokens cannot manage tokens; use the admin page');
    if (!can(role, 'apiTokens')) throw new HttpError(403, 'Your role cannot do that');
    const { account } = caller;
    const scope = role === 'owner' ? null : account.id;
    if (path === '/api/admin/tokens') {
      if (method === 'GET') {
        const list: AdminTokenInfo[] = this.store.adminTokens.list(scope);
        return [200, list];
      }
      if (method === 'POST') {
        const input = parseNewAdminToken(await readJson(req));
        if (typeof input === 'string') throw new HttpError(400, input);
        const over = input.scopes.find((s) => !can(role, s));
        if (over) throw new HttpError(403, `Your role cannot hand out ${over}`);
        if (this.store.adminTokens.count(account.id) >= TOKEN_RULES.maxPerAccount) throw new HttpError(409, `At most ${TOKEN_RULES.maxPerAccount} tokens per account; revoke one first`);
        const expiresAt = Date.now() + input.days * DAY_MS;
        const { token, id } = this.store.adminTokens.create(account.id, input.name, input.scopes, expiresAt);
        const info = this.store.adminTokens.list(account.id).find((t) => t.id === id);
        if (!info) throw new Error('token row missing right after insert');
        log(`token "${input.name}" (${id}) created: ${input.scopes.join(', ')}; expires in ${input.days} days`);
        const created: CreatedAdminToken = { token, info };
        return [201, created];
      }
    }
    const revoke = /^\/api\/admin\/tokens\/([0-9a-f]{16})$/.exec(path);
    if (revoke?.[1] && method === 'DELETE') {
      const gone = this.store.adminTokens.revoke(revoke[1], scope);
      if (!gone) throw new HttpError(404, 'No such token');
      log(`token "${gone.name}" (${revoke[1]}) of ${gone.createdBy} revoked`);
      return [200, { ok: true }];
    }
    throw new HttpError(404, 'Not found');
  }

  /**
   * A consistent copy of the database, sent as a download and deleted afterwards. The temp file's
   * path never leaves the server: errors answer with a fixed message and the log names no path.
   */
  private backup(log: (what: string) => void): Reply {
    if (this.backupRunning) throw new HttpError(409, 'A backup is already running; try again when it is done');
    this.backupRunning = true;
    const file = this.store.backupPath();
    const cleanup = () => {
      rmSync(file, { force: true });
      this.backupRunning = false;
    };
    const started = performance.now();
    try {
      this.store.backupTo(file);
    } catch (err) {
      cleanup();
      events.error('error', `backup failed: ${err instanceof Error ? err.message.split(file).join('<temp file>') : 'unknown error'}`);
      throw new HttpError(500, 'Backup failed');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    log(`backup (${Math.round(performance.now() - started)} ms to copy)`);
    return new Download(file, `rune-${stamp}.db`, cleanup);
  }
}
