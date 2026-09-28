import { isSessionToken, parseCredentials, parseNewCharacter, type CharactersResponse } from '@rune/shared';
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
 * rate limit one shared bucket for all players. Only trusted when the deploy says the origin is
 * reachable through Cloudflare alone, since the header is otherwise trivially spoofed.
 */
function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === 'cloudflare') {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(cf)) return cf;
  }
  return req.socket.remoteAddress ?? 'unknown';
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
  ) {
    this.sweepTimer.unref();
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
        const account = await this.store.register(creds.username, creds.password);
        if (account === 'taken') throw new HttpError(409, 'That username is taken');
        return [201, { token: this.store.createSession(account.id), username: account.username }];
      }
      const account = await this.store.verify(creds.username, creds.password);
      // One message for both cases, so the endpoint does not reveal which usernames exist.
      if (!account) throw new HttpError(401, 'Wrong username or password');
      return [200, { token: this.store.createSession(account.id), username: account.username }];
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
    return { username: account.username, characters: this.store.listCharacters(account.id) };
  }
}
