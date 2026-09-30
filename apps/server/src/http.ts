import {
  can,
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
  rank,
  seasonOf,
  type AdminAccount,
  type AdminOverview,
  type AdminTokenInfo,
  type CharactersResponse,
  type CreatedAdminToken,
  type Permission,
  type Role,
  type ServerSettings,
  type TownLayout,
} from '@rune/shared';
import { randomInt } from 'node:crypto';
import { createReadStream, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account, AccountStore } from './accounts.js';
import type { TokenCaller } from './adminTokens.js';
import { events } from './eventLog.js';
import { tuningRoute, type TuningHooks } from './tuningRoutes.js';

/** Credentials and a character name fit many times over; anything bigger is not a real request. */
const MAX_BODY_BYTES = 4096;

/** Sliding one-minute window per IP. Auth is tight because every attempt costs a 32 MiB scrypt hash. */
const LIMITS = { auth: 10, other: 120, token: TOKEN_RULES.perMinute } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** What the admin API needs from the running game; the room manager provides it. */
export interface AdminHooks extends TuningHooks {
  overview(): AdminOverview;
  settings(): ServerSettings;
  updateSettings(patch: Partial<ServerSettings>): ServerSettings;
  announce(text: string): number;
  kickCharacter(characterId: number): boolean;
  kickAccount(accountId: number): void;
  /** The live town, for `pnpm town:pull`. Every player is sent it on entering town, so it is public. */
  currentTown(): TownLayout;
  /** Moves the staff member's live character next to the target; returns why not, or null. */
  gotoCharacter(staffAccountId: number, characterId: number): string | null;
  /** Applies a new role to the account's live session, if it has one. */
  roleChanged(accountId: number, role: Role): void;
  /** Whether the account has a session in the game (any character, in any room or between rooms). */
  accountOnline(accountId: number): boolean;
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Requiring JSON also rules out cross-site form posts, which can only send form or text bodies.
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
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

function sendFile(res: ServerResponse, download: Download): void {
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
  stream.pipe(res);
}

export class AccountApi {
  private readonly authLimit = new RateLimiter(LIMITS.auth);
  private readonly otherLimit: RateLimiter;
  private readonly tokenLimit: RateLimiter;
  private readonly sweepTimer = setInterval(() => {
    this.authLimit.sweep();
    this.otherLimit.sweep();
    this.tokenLimit.sweep();
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
    limits: { other?: number; token?: number } = {},
  ) {
    this.otherLimit = new RateLimiter(limits.other ?? LIMITS.other);
    this.tokenLimit = new RateLimiter(limits.token ?? LIMITS.token);
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
      .then((reply) => (reply instanceof Download ? sendFile(res, reply) : send(res, reply[0], reply[1])))
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
      if (!caller) throw new HttpError(401, 'Invalid, expired or revoked token');
      if (!this.tokenLimit.allow(caller.tokenId)) throw new HttpError(429, 'Too many requests for this token, wait a minute');
      return this.adminRoute(req, method, path, query, { account: caller.account, token: caller });
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
    if (token) {
      // Every token call is in the staff log, reads too. Polling the log itself goes to stdout only,
      // or a script following it would push the events it came for out of the buffer.
      const line = `[admin] ${who}: ${method} ${path}`;
      if (path === '/api/admin/log') console.log(line);
      else events.log('staff', line);
    }
    if (method === 'GET' && path === '/api/admin/overview') return [200, this.admin.overview()];
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
        log(`settings ${JSON.stringify(patch)}`);
        return [200, this.admin.updateSettings(patch)];
      }
    }
    const tuning = await tuningRoute({ method, path, body: () => readJson(req), canEdit: allowed('settings'), log }, this.admin);
    if (tuning) return tuning;
    if (method === 'POST' && path === '/api/admin/announce') {
      need('announce');
      const body = await readJson(req);
      const text = cleanChat(isRecord(body) ? body.text : undefined);
      if (!text) throw new HttpError(400, 'Announcement text is required');
      log(`announce "${text}"`);
      return [200, { reached: this.admin.announce(text) }];
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
