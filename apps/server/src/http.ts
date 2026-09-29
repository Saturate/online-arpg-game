import {
  can,
  cleanChat,
  isAssignableRole,
  isSessionToken,
  parseCredentials,
  parseNewCharacter,
  parseSettingsPatch,
  rank,
  type AdminAccount,
  type AdminOverview,
  type CharactersResponse,
  type Permission,
  type Role,
  type ServerSettings,
  type TownLayout,
} from '@rune/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account, AccountStore } from './accounts.js';

/** Credentials and a character name fit many times over; anything bigger is not a real request. */
const MAX_BODY_BYTES = 4096;

/** Sliding one-minute window per IP. Auth is tight because every attempt costs a 32 MiB scrypt hash. */
const LIMITS = { auth: 10, other: 120 } as const;

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
export interface AdminHooks {
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
}

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

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  return isSessionToken(token) ? token : null;
}

export class AccountApi {
  private readonly authLimit = new RateLimiter(LIMITS.auth);
  private readonly otherLimit = new RateLimiter(LIMITS.other);
  private readonly sweepTimer = setInterval(() => {
    this.authLimit.sweep();
    this.otherLimit.sweep();
  }, 60_000);

  constructor(
    private readonly store: AccountStore,
    /** Called when a character is deleted, so a live session on it is ended first. */
    private readonly onCharacterDeleted: (characterId: number) => void,
    private readonly admin: AdminHooks,
    /** Lower-cased owner usernames, from ADMIN_USERS. Empty means nobody. */
    private readonly owners: ReadonlySet<string> = parseAdminUsers(process.env.ADMIN_USERS),
  ) {
    this.sweepTimer.unref();
    for (const name of owners) {
      if (!store.usernameExists(name)) console.warn(`[admin] ADMIN_USERS lists "${name}" but no such account exists; it cannot be registered while listed`);
    }
  }

  private roleOf(account: Account): Role {
    return roleOf(account, this.owners);
  }

  /** Returns false for paths outside /api so the caller can 404 them. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    this.route(req, url.pathname)
      .then(([status, body]) => send(res, status, body))
      .catch((err: unknown) => {
        if (err instanceof HttpError) send(res, err.status, { error: err.message });
        else {
          console.error(err);
          send(res, 500, { error: 'Server error' });
        }
      });
    return true;
  }

  private async route(req: IncomingMessage, path: string): Promise<[number, unknown]> {
    const ip = clientIp(req);
    const method = req.method ?? 'GET';
    const isAuth = path === '/api/register' || path === '/api/login';
    if (!(isAuth ? this.authLimit : this.otherLimit).allow(ip)) throw new HttpError(429, 'Too many requests, wait a minute');

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
    if (path.startsWith('/api/admin/')) return this.adminRoute(req, method, path, account);
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
    return { username: account.username, characters: this.store.listCharacters(account.id), role: this.roleOf(account) };
  }

  /** Admin actions are logged with who did them, since they change other players' accounts and the live server. */
  private async adminRoute(req: IncomingMessage, method: string, path: string, account: Account): Promise<[number, unknown]> {
    const role = this.roleOf(account);
    // 404 rather than 403 for non-staff, so the admin API is not advertised to everyone else.
    if (!can(role, 'viewAdmin')) throw new HttpError(404, 'Not found');
    const need = (permission: Permission) => {
      if (!can(role, permission)) throw new HttpError(403, 'Your role cannot do that');
    };
    /** Staff act only on accounts ranked below them, so a moderator cannot ban or kick an admin. */
    const outranks = (target: Account) => rank(role) > rank(this.roleOf(target));
    const log = (what: string) => console.log(`[admin] ${account.username} (${role}): ${what}`);
    if (method === 'GET' && path === '/api/admin/overview') return [200, this.admin.overview()];
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
}
