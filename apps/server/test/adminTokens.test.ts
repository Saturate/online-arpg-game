import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SERVER_SETTINGS, ENEMY_TYPE_IDS, isAdminToken, TOKEN_SCOPES, type TokenScope } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi, FailedTokenLog } from '../src/http.js';
import { EventLog, events, redact } from '../src/eventLog.js';
import { RoomManager } from '../src/manager.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function listen(api: AccountApi): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (!api.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr: AddressInfo | string | null = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe('admin API tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rune-tokens-'));
  const dbPath = join(dir, 'rune.db');
  const store = new AccountStore(dbPath);
  const owners = new Set(['boss']);
  const rooms = new RoomManager(1, store, owners);
  const sessions: Record<string, string> = {};
  const ids: Record<string, number> = {};
  /** Every secret handed out in this file, to check none of them reaches a log line or the database. */
  const secrets: string[] = [];
  let server: Server | undefined;
  let base = '';
  let plebCharacter = 0;

  const call = (method: string, path: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (auth) h.authorization = `Bearer ${auth}`;
    const init: RequestInit = { method, headers: h };
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(base + path, init);
  };

  const json = async (res: Response): Promise<Record<string, unknown>> => {
    const v: unknown = await res.json();
    if (!isRecord(v)) throw new Error('not an object');
    return v;
  };

  /** Makes a token through the admin page's route, as `who`, and returns the full token. */
  const makeToken = async (who: string, name: string, scopes: readonly TokenScope[], days = 30): Promise<string> => {
    const session = sessions[who];
    if (!session) throw new Error(`no session for ${who}`);
    const res = await call('POST', '/api/admin/tokens', session, { name, scopes, days });
    expect(res.status).toBe(201);
    const body = await json(res);
    const token = body.token;
    if (!isAdminToken(token)) throw new Error('no token');
    secrets.push(token, token.slice(22));
    return token;
  };

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['mod1', 'moderator'],
      ['pleb1', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      ids[name] = acc.id;
      sessions[name] = store.createSession(acc.id);
      secrets.push(sessions[name]);
    }
    const c = store.createCharacter(ids.pleb1 ?? 0, 'Plebby', 'mage');
    if (typeof c === 'string') throw new Error('no character');
    plebCharacter = c.id;
    const api = new AccountApi(store, () => undefined, rooms, owners, { other: 100_000, token: 100_000 });
    ({ server, base } = await listen(api));
  });
  afterAll(() => {
    server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows the token once and stores only a hash of it', async () => {
    const token = await makeToken('boss', 'hash check', ['serverLog']);
    const [, id = '', secret = ''] = /^arpg_([0-9a-f]{16})_(.+)$/.exec(token) ?? [];
    const list = await call('GET', '/api/admin/tokens', sessions.boss ?? '');
    const text = await list.text();
    expect(text).toContain(id);
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/secret|hash"/i);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT * FROM admin_tokens WHERE id = ?').all(id);
    db.close();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    if (!isRecord(r)) throw new Error('no row');
    const stored = r.secret_hash;
    if (!(stored instanceof Uint8Array)) throw new Error('no hash');
    expect(Buffer.from(stored).equals(createHash('sha256').update(secret).digest())).toBe(true);
    for (const v of Object.values(r)) expect(String(v)).not.toContain(secret);
    // Nowhere in the database files either, the write-ahead log included.
    for (const f of [dbPath, `${dbPath}-wal`]) if (existsSync(f)) expect(readFileSync(f).includes(secret)).toBe(false);
  });

  it('rejects a wrong secret, a token outside the admin routes, and tokens sent any way but the header', async () => {
    const token = await makeToken('boss', 'where', []);
    expect((await call('GET', '/api/admin/overview', token)).status).toBe(200);
    const wrong = `${token.slice(0, 22)}${'A'.repeat(43)}`;
    expect((await call('GET', '/api/admin/overview', wrong)).status).toBe(401);
    expect((await call('GET', '/api/characters', token)).status).toBe(401);
    expect((await call('POST', '/api/logout', token, {})).status).toBe(401);
    expect((await call('GET', '/api/admin/overview', null, undefined, { cookie: `token=${token}; session=${token}` })).status).toBe(401);
    expect((await call('GET', `/api/admin/overview?token=${token}`, null)).status).toBe(401);
  });

  it('reports players online, rooms, the build and uptime in the overview', async () => {
    const token = await makeToken('boss', 'overview', []);
    const body = await json(await call('GET', '/api/admin/overview', token));
    expect(body).toMatchObject({ build: expect.any(String), uptimeSeconds: expect.any(Number), online: expect.any(Array), rooms: expect.any(Array) });
  });

  /** Every admin route with a body the route accepts, and the scope it needs. */
  const routes = (): { method: string; path: string; body?: unknown; scope: TokenScope }[] => [
    { method: 'GET', path: '/api/admin/overview', scope: 'viewAdmin' },
    { method: 'GET', path: '/api/admin/accounts', scope: 'viewAdmin' },
    { method: 'GET', path: '/api/admin/settings', scope: 'viewAdmin' },
    { method: 'GET', path: '/api/admin/monsters', scope: 'viewAdmin' },
    // The live view and search answer every token; their log parts are checked per scope in adminLive.test.ts.
    { method: 'GET', path: '/api/admin/live', scope: 'viewAdmin' },
    { method: 'GET', path: '/api/admin/search?q=pleb', scope: 'viewAdmin' },
    { method: 'PUT', path: '/api/admin/settings', body: { xpRate: 1 }, scope: 'settings' },
    { method: 'DELETE', path: `/api/admin/monsters/${ENEMY_TYPE_IDS[0]}`, scope: 'settings' },
    { method: 'POST', path: '/api/admin/announce', body: { text: 'hello' }, scope: 'announce' },
    { method: 'POST', path: '/api/admin/kick', body: { characterId: plebCharacter }, scope: 'kick' },
    { method: 'POST', path: `/api/admin/accounts/${ids.pleb1}/ban`, body: { banned: false }, scope: 'ban' },
    { method: 'POST', path: '/api/admin/goto', body: { characterId: plebCharacter }, scope: 'teleport' },
    // An empty body is refused by the layout check, so the scope is tested without saving a town.
    { method: 'PUT', path: '/api/admin/town', body: {}, scope: 'townEdit' },
    { method: 'POST', path: `/api/admin/accounts/${ids.pleb1}/role`, body: { role: 'player' }, scope: 'manageRoles' },
    { method: 'POST', path: '/api/admin/grant', body: {}, scope: 'grantItems' },
    { method: 'GET', path: '/api/admin/log', scope: 'serverLog' },
    { method: 'GET', path: '/api/admin/backup', scope: 'backup' },
  ];

  it('lets each scope through only the routes it names', async () => {
    for (const scope of TOKEN_SCOPES) {
      const token = await makeToken('boss', `only ${scope}`, [scope]);
      for (const r of routes()) {
        const res = await call(r.method, r.path, token, r.body);
        await res.arrayBuffer();
        const expected = r.scope === scope || r.scope === 'viewAdmin';
        if (expected) expect([r.path, res.status]).not.toEqual([r.path, 403]);
        else expect([r.path, res.status]).toEqual([r.path, 403]);
        expect(res.status).not.toBe(404);
      }
      // Stays under the per-account token cap for the rest of the file.
      store.adminTokens.revoke(token.slice(5, 21), null);
    }
  });

  it('gives an owner token with every scope every route, and sessions keep working by role', async () => {
    const all = await makeToken('boss', 'all', TOKEN_SCOPES);
    for (const r of routes()) {
      const res = await call(r.method, r.path, all, r.body);
      await res.arrayBuffer();
      expect([r.path, res.status]).not.toEqual([r.path, 403]);
    }
    // Sessions: the admin can read the log but not back up or grant; a moderator neither; a player sees nothing.
    expect((await call('GET', '/api/admin/log', sessions.admin1 ?? '')).status).toBe(200);
    expect((await call('GET', '/api/admin/backup', sessions.admin1 ?? '')).status).toBe(403);
    expect((await call('POST', '/api/admin/grant', sessions.admin1 ?? '', {})).status).toBe(403);
    expect((await call('GET', '/api/admin/log', sessions.mod1 ?? '')).status).toBe(403);
    expect((await call('POST', '/api/admin/announce', sessions.mod1 ?? '', { text: 'hi' })).status).toBe(200);
    expect((await call('GET', '/api/admin/log', sessions.pleb1 ?? '')).status).toBe(404);
    expect((await call('GET', '/api/admin/backup', sessions.boss ?? '')).status).toBe(200);
  });

  it('lets only owner and admin sessions make tokens, never past their own role, and never with a token', async () => {
    const admin = sessions.admin1 ?? '';
    for (const scope of ['grantItems', 'manageRoles', 'backup'] as const) {
      expect((await call('POST', '/api/admin/tokens', admin, { name: 'x', scopes: [scope], days: 30 })).status).toBe(403);
    }
    expect((await call('POST', '/api/admin/tokens', sessions.mod1 ?? '', { name: 'x', scopes: [], days: 30 })).status).toBe(403);
    expect((await call('GET', '/api/admin/tokens', sessions.mod1 ?? '')).status).toBe(403);
    expect((await call('POST', '/api/admin/tokens', sessions.pleb1 ?? '', { name: 'x', scopes: [], days: 30 })).status).toBe(404);
    // Unknown scopes and fields, bad names and expiries are refused.
    expect((await call('POST', '/api/admin/tokens', admin, { name: 'x', scopes: ['apiTokens'], days: 30 })).status).toBe(400);
    expect((await call('POST', '/api/admin/tokens', admin, { name: 'x', scopes: ['devTools'], days: 30 })).status).toBe(400);
    expect((await call('POST', '/api/admin/tokens', admin, { name: 'x', scopes: [], days: 30, extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/admin/tokens', admin, { name: '"; drop', scopes: [], days: 30 })).status).toBe(400);
    expect((await call('POST', '/api/admin/tokens', admin, { name: 'x', scopes: [], days: 91 })).status).toBe(400);

    const all = await makeToken('boss', 'all again', TOKEN_SCOPES);
    expect((await call('GET', '/api/admin/tokens', all)).status).toBe(403);
    expect((await call('POST', '/api/admin/tokens', all, { name: 'child', scopes: [], days: 30 })).status).toBe(403);
    expect((await call('DELETE', `/api/admin/tokens/${all.slice(5, 21)}`, all)).status).toBe(403);
  });

  it('drops a creator\'s tokens on any role change, so a re-promotion does not bring them back', async () => {
    const token = await makeToken('admin1', 'settings', ['settings', 'announce']);
    expect((await call('PUT', '/api/admin/settings', token, { xpRate: 1 })).status).toBe(200);
    // Setting the role it already has is not a change.
    expect(store.setRole(ids.admin1 ?? 0, 'admin')).toBe(false);
    expect((await call('PUT', '/api/admin/settings', token, { xpRate: 1 })).status).toBe(200);

    expect((await call('POST', `/api/admin/accounts/${ids.admin1}/role`, sessions.boss ?? '', { role: 'moderator' })).status).toBe(200);
    expect((await call('POST', '/api/admin/announce', token, { text: 'still a mod' })).status).toBe(401);
    expect((await call('POST', `/api/admin/accounts/${ids.admin1}/role`, sessions.boss ?? '', { role: 'admin' })).status).toBe(200);
    expect((await call('PUT', '/api/admin/settings', token, { xpRate: 1 })).status).toBe(401);
    expect(store.adminTokens.list(ids.admin1 ?? 0)).toEqual([]);

    // Promotions drop them too.
    const again = await makeToken('admin1', 'again', ['announce']);
    store.setRole(ids.admin1 ?? 0, 'moderator');
    store.setRole(ids.admin1 ?? 0, 'admin');
    expect((await call('GET', '/api/admin/overview', again)).status).toBe(401);
  });

  it('checks the creator\'s role on every call, for an owner taken off ADMIN_USERS', async () => {
    const acc = await store.register('boss2', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const liveOwners = new Set(['boss', 'boss2']);
    const api = new AccountApi(store, () => undefined, rooms, liveOwners, { other: 100_000, token: 100_000 });
    const { server: s, base: b } = await listen(api);
    try {
      const session = store.createSession(acc.id);
      secrets.push(session);
      const made = await fetch(`${b}/api/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'owner2', scopes: ['backup'], days: 1 }) });
      const token = (await json(made)).token;
      if (!isAdminToken(token)) throw new Error('no token');
      secrets.push(token, token.slice(22));
      const backup = () => fetch(`${b}/api/admin/backup`, { headers: { authorization: `Bearer ${token}` } });
      const ok = await backup();
      expect(ok.status).toBe(200);
      await ok.arrayBuffer();
      // ADMIN_USERS is read at startup; this stands in for a restart without the name.
      liveOwners.delete('boss2');
      expect((await backup()).status).toBe(404);
    } finally {
      s.close();
    }
  });

  it('expires, and revokes with one call; an admin revokes only their own, the owner anyone', async () => {
    const short = await makeToken('boss', 'short', [], 1);
    expect((await call('GET', '/api/admin/overview', short)).status).toBe(200);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
    try {
      expect((await call('GET', '/api/admin/overview', short)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }

    const bosses = await makeToken('boss', 'bosses', []);
    const admins = await makeToken('admin1', 'admins', []);
    const idOf = (t: string) => t.slice(5, 21);
    expect((await call('DELETE', `/api/admin/tokens/${idOf(bosses)}`, sessions.admin1 ?? '')).status).toBe(404);
    expect((await call('GET', '/api/admin/overview', bosses)).status).toBe(200);
    const adminList = await (await call('GET', '/api/admin/tokens', sessions.admin1 ?? '')).text();
    expect(adminList).not.toContain(idOf(bosses));
    expect(adminList).toContain(idOf(admins));
    expect((await call('DELETE', `/api/admin/tokens/${idOf(admins)}`, sessions.boss ?? '')).status).toBe(200);
    expect((await call('GET', '/api/admin/overview', admins)).status).toBe(401);
    expect((await call('DELETE', `/api/admin/tokens/${idOf(bosses)}`, sessions.boss ?? '')).status).toBe(200);
    expect((await call('GET', '/api/admin/overview', bosses)).status).toBe(401);
  });

  it('shows when a token was last used', async () => {
    const token = await makeToken('boss', 'used', []);
    const id = token.slice(5, 21);
    const before = store.adminTokens.list(null).find((t) => t.id === id);
    expect(before?.lastUsedAt).toBeNull();
    await call('GET', '/api/admin/overview', token);
    expect(store.adminTokens.list(null).find((t) => t.id === id)?.lastUsedAt).toEqual(expect.any(Number));
  });

  it('stops a banned creator\'s tokens for good, and a deleted creator\'s', async () => {
    const mod = await store.register('mod2', 'password123');
    if (mod === 'taken') throw new Error('taken');
    store.setRole(mod.id, 'admin');
    sessions.mod2 = store.createSession(mod.id);
    const token = await makeToken('mod2', 'banned', []);
    expect((await call('GET', '/api/admin/overview', token)).status).toBe(200);
    expect((await call('POST', `/api/admin/accounts/${mod.id}/ban`, sessions.boss ?? '', { banned: true })).status).toBe(200);
    expect((await call('GET', '/api/admin/overview', token)).status).toBe(401);
    expect((await call('POST', `/api/admin/accounts/${mod.id}/ban`, sessions.boss ?? '', { banned: false })).status).toBe(200);
    expect((await call('GET', '/api/admin/overview', token)).status).toBe(401);

    const guest = await store.registerGuest();
    store.setRole(guest.id, 'admin');
    sessions.guest = store.createSession(guest.id);
    const gone = await makeToken('guest', 'deleted', []);
    expect((await call('GET', '/api/admin/overview', gone)).status).toBe(200);
    expect(store.deleteIdleGuests(0, new Set(), Date.now() + 1000)).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/api/admin/overview', gone)).status).toBe(401);
  });

  it('logs every token call with the token name and route, and the log never holds a secret', async () => {
    const token = await makeToken('boss', 'logger', ['serverLog', 'announce']);
    const start = await json(await call('GET', '/api/admin/log', token));
    const cursor = start.next;
    if (typeof cursor !== 'number') throw new Error('no cursor');
    // A token pasted into an announcement is redacted too.
    expect((await call('POST', '/api/admin/announce', token, { text: `oops ${token} and ${sessions.boss ?? ''}` })).status).toBe(200);
    const after = await json(await call('GET', `/api/admin/log?since=${cursor}`, token));
    const entries = after.entries;
    if (!Array.isArray(entries)) throw new Error('no entries');
    const lines = entries.map((e: unknown) => (isRecord(e) ? String(e.text) : ''));
    expect(lines).toContain('[admin] boss (owner) token "logger": POST /api/admin/announce');
    expect(lines.some((l) => l.startsWith('[admin] boss (owner) token "logger": announce "oops [redacted] and [redacted]"'))).toBe(true);
    expect(entries.every((e: unknown) => isRecord(e) && typeof e.id === 'number' && e.id > cursor)).toBe(true);
    // Reading the log is not itself put in the log, or following it would fill it.
    expect(lines.some((l) => l.includes('GET /api/admin/log'))).toBe(false);

    const everything = JSON.stringify((await json(await call('GET', '/api/admin/log?since=0', token))).entries);
    for (const s of secrets) expect(everything).not.toContain(s);
    expect(everything).not.toContain('password123');
    expect((await call('GET', '/api/admin/log?since=-1', token)).status).toBe(400);
    expect((await call('GET', '/api/admin/log?since=abc', token)).status).toBe(400);
  });

  it('keeps refused and unknown token calls out of the staff log, and logs other failures with their status', async () => {
    const token = await makeToken('boss', 'refused', ['announce']);
    const out = vi.spyOn(console, 'log');
    const mark = events.since(0).next;
    try {
      for (let i = 0; i < 20; i++) {
        expect((await call('GET', '/api/admin/backup', token)).status).toBe(403);
        expect((await call('GET', '/api/admin/nothing-here', token)).status).toBe(404);
      }
      expect((await call('POST', '/api/admin/announce', token, {})).status).toBe(400);
      const lines = events.since(mark).entries.map((e) => e.text);
      expect(lines).toEqual(['[admin] boss (owner) token "refused": POST /api/admin/announce -> 400']);
      const printed = out.mock.calls.map((c) => String(c[0]));
      expect(printed).toContain('[admin] boss (owner) token "refused": GET /api/admin/backup -> 403');
      expect(printed).toContain('[admin] boss (owner) token "refused": GET /api/admin/nothing-here -> 404');
    } finally {
      out.mockRestore();
    }
  });

  it('logs rejected tokens by id and address, throttled, and never the secret', async () => {
    const token = await makeToken('boss', 'rejected', []);
    const id = token.slice(5, 21);
    const wrongSecret = 'B'.repeat(43);
    const wrong = `arpg_${id}_${wrongSecret}`;
    const warn = vi.spyOn(console, 'warn');
    const mark = events.since(0).next;
    try {
      for (let i = 0; i < 5; i++) expect((await call('GET', '/api/admin/overview', wrong)).status).toBe(401);
      const lines = events.since(mark).entries.map((e) => e.text);
      expect(lines).toEqual([`[admin] rejected token arpg_${id}_... from 127.0.0.1 (unknown, wrong, expired or revoked)`]);
      const printed = JSON.stringify(warn.mock.calls);
      expect(printed).toContain(`arpg_${id}_...`);
      for (const s of [wrongSecret, token.slice(22)]) {
        expect(printed).not.toContain(s);
        expect(JSON.stringify(events.since(0).entries)).not.toContain(s);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('backs up for the owner only, deletes the copy afterwards, refuses a second at the same time and never shows the path', async () => {
    const backups = () => readdirSync(dir).filter((f) => f.startsWith('.backup-'));
    // Earlier tests downloaded backups too; their copies go once those responses have closed.
    await vi.waitFor(() => expect(backups()).toEqual([]));
    const noBackup = await makeToken('boss', 'no backup', TOKEN_SCOPES.filter((s) => s !== 'backup'));
    expect((await call('GET', '/api/admin/backup', noBackup)).status).toBe(403);
    const adminAll = await makeToken('admin1', 'admin all', ['settings', 'serverLog', 'announce']);
    expect((await call('GET', '/api/admin/backup', adminAll)).status).toBe(403);

    const token = await makeToken('boss', 'backup', ['backup']);
    const res = await call('GET', '/api/admin/backup', token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="rune-[0-9T-]+Z\.db"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    const headerText = JSON.stringify([...res.headers.entries()]);
    expect(headerText).not.toContain(dir);
    expect(bytes.includes(Buffer.from(dir))).toBe(false);
    const copy = join(dir, 'check.db');
    writeFileSync(copy, bytes);
    const db = new DatabaseSync(copy, { readOnly: true });
    expect(db.prepare('SELECT username FROM accounts WHERE username = ?').get('boss')).toBeTruthy();
    db.close();
    rmSync(copy);
    await vi.waitFor(() => expect(backups()).toEqual([]));

    // A copy big enough that a client which stops reading holds the download open.
    store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, motd: 'x'.repeat(24 * 1024 * 1024) });
    const url = new URL(`${base}/api/admin/backup`);
    const first = await new Promise<IncomingMessage>((ok, fail) => {
      const r = request({ host: url.hostname, port: url.port, path: url.pathname, headers: { authorization: `Bearer ${token}` } }, ok);
      r.on('error', fail);
      r.end();
    });
    first.pause();
    expect(first.statusCode).toBe(200);
    expect(backups()).toHaveLength(1);
    const second = await call('GET', '/api/admin/backup', token);
    expect(second.status).toBe(409);
    expect(await second.text()).not.toContain(dir);
    first.destroy();
    await vi.waitFor(() => expect(backups()).toEqual([]));
    store.saveSettings(DEFAULT_SERVER_SETTINGS);
    const third = await call('GET', '/api/admin/backup', token);
    expect(third.status).toBe(200);
    await third.arrayBuffer();
    await vi.waitFor(() => expect(backups()).toEqual([]));

    const lines = events.since(0).entries.map((e) => e.text);
    expect(lines.some((l) => l.includes(dir))).toBe(false);
    expect(lines.some((l) => l.startsWith('[admin] boss (owner) token "backup": backup ('))).toBe(true);
  });

  it('drops a backup download that stalls, and frees the lock and the temp file', async () => {
    const backups = () => readdirSync(dir).filter((f) => f.startsWith('.backup-'));
    await vi.waitFor(() => expect(backups()).toEqual([]));
    const stalling = new AccountApi(store, () => undefined, rooms, owners, { other: 100_000, token: 100_000, backupStallMs: 300 });
    const { server: s, base: b } = await listen(stalling);
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const token = await makeToken('boss', 'stall', ['backup']);
      store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, motd: 'x'.repeat(24 * 1024 * 1024) });
      const url = new URL(`${b}/api/admin/backup`);
      const stalled = await new Promise<IncomingMessage>((ok, fail) => {
        const r = request({ host: url.hostname, port: url.port, path: url.pathname, headers: { authorization: `Bearer ${token}` } }, ok);
        r.on('error', fail);
        r.end();
      });
      stalled.on('error', () => undefined);
      stalled.pause();
      expect(stalled.statusCode).toBe(200);
      expect(backups()).toHaveLength(1);
      await vi.waitFor(() => expect(backups()).toEqual([]), { timeout: 5000 });
      expect(events.since(0).entries.some((e) => e.text === 'backup: the download stalled and was dropped')).toBe(true);
      store.saveSettings(DEFAULT_SERVER_SETTINGS);
      const next = await fetch(`${b}/api/admin/backup`, { headers: { authorization: `Bearer ${token}` } });
      expect(next.status).toBe(200);
      await next.arrayBuffer();
      stalled.destroy();
    } finally {
      store.saveSettings(DEFAULT_SERVER_SETTINGS);
      quiet.mockRestore();
      s.close();
    }
  });

  it('rate limits each token', async () => {
    const limited = new AccountApi(store, () => undefined, rooms, owners, { other: 100_000, token: 3 });
    const { server: s, base: b } = await listen(limited);
    try {
      const token = await makeToken('boss', 'limited', []);
      const other = await makeToken('boss', 'other', []);
      const get = (t: string) => fetch(`${b}/api/admin/overview`, { headers: { authorization: `Bearer ${t}` } });
      for (let i = 0; i < 3; i++) expect((await get(token)).status).toBe(200);
      expect((await get(token)).status).toBe(429);
      expect((await get(other)).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe('rejected token log', () => {
  it('writes one line per id a minute, then the count, and sums ids past the cap', () => {
    let t = 0;
    const log = new FailedTokenLog(() => t, 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mark = events.since(0).next;
    try {
      const a = '0123456789abcdef';
      const b = 'fedcba9876543210';
      log.record(a, '10.0.0.1');
      log.record(a, '10.0.0.2');
      log.record(a, '10.0.0.3');
      log.record(b, '10.0.0.4');
      log.record('1111111111111111', '10.0.0.5');
      log.record('2222222222222222', '10.0.0.5');
      // A sweep inside the minute reports only the ids over the cap.
      t = 30_000;
      log.sweep();
      expect(events.since(mark).entries).toHaveLength(3);
      t = 61_000;
      log.sweep();
      log.record(a, '10.0.0.6');
      expect(events.since(mark).entries.map((e) => e.text)).toEqual([
        `[admin] rejected token arpg_${a}_... from 10.0.0.1 (unknown, wrong, expired or revoked)`,
        `[admin] rejected token arpg_${b}_... from 10.0.0.4 (unknown, wrong, expired or revoked)`,
        '[admin] rejected 2 more token attempts with other ids',
        `[admin] rejected token arpg_${a}_... 2 more times in a minute, last from 10.0.0.3`,
        `[admin] rejected token arpg_${a}_... from 10.0.0.6 (unknown, wrong, expired or revoked)`,
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('server event log', () => {
  it('keeps the newest entries, pages by cursor and says when some were missed', () => {
    const log = new EventLog(3);
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (let i = 1; i <= 5; i++) log.log('server', `line ${i}`);
    quiet.mockRestore();
    const all = log.since(0);
    expect(all.entries.map((e) => e.text)).toEqual(['line 3', 'line 4', 'line 5']);
    expect(all.missed).toBe(true);
    expect(all.next).toBe(5);
    expect(log.since(3)).toMatchObject({ missed: false, entries: [{ text: 'line 4' }, { text: 'line 5' }] });
    expect(log.since(5)).toMatchObject({ missed: false, entries: [], next: 5 });
    // A cursor from before a restart points past the end; next brings the caller back.
    expect(log.since(900).next).toBe(5);
  });

  it('redacts admin and session tokens', () => {
    const session = 'A'.repeat(43);
    expect(redact(`x arpg_0123456789abcdef_${session} y ${session} z`)).toBe('x [redacted] y [redacted] z');
    expect(redact('Brothers Creation')).toBe('Brothers Creation');
  });
});
