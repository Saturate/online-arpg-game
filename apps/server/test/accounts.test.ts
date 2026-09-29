import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SERVER_SETTINGS, isSessionToken, Simulation, type ServerSettings } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../src/accounts.js';
import { AccountApi, RateLimiter, type AdminHooks } from '../src/http.js';
import { Client, type ClientSocket } from '../src/client.js';
import { Room } from '../src/room.js';

describe('AccountStore', () => {
  const store = new AccountStore(':memory:');

  it('registers, rejects duplicates case-insensitively, and verifies passwords', async () => {
    const acc = await store.register('Alice', 'correct horse');
    expect(acc).not.toBe('taken');
    expect(await store.register('alice', 'something else')).toBe('taken');
    expect(await store.verify('ALICE', 'correct horse')).toMatchObject({ username: 'Alice' });
    expect(await store.verify('alice', 'wrong password')).toBeNull();
    expect(await store.verify('nobody', 'correct horse')).toBeNull();
  });

  it('issues sessions that resolve to the account and can be revoked', async () => {
    const acc = await store.register('bob', 'hunter2hunter2');
    if (acc === 'taken') throw new Error('unexpected');
    const token = store.createSession(acc.id);
    expect(store.accountForToken(token)?.id).toBe(acc.id);
    store.deleteSession(token);
    expect(store.accountForToken(token)).toBeNull();
  });

  it('keeps characters per account and round-trips saves', async () => {
    const a = await store.register('carol', 'password123');
    const b = await store.register('dave', 'password123');
    if (a === 'taken' || b === 'taken') throw new Error('unexpected');
    const made = store.createCharacter(a.id, 'Ember', 'mage');
    if (typeof made === 'string') throw new Error(made);
    expect(store.createCharacter(b.id, 'ember', 'warrior')).toBe('taken');
    // Another account can neither load nor delete it.
    expect(store.loadCharacter(b.id, made.id)).toBeNull();
    expect(store.deleteCharacter(b.id, made.id)).toBe(false);

    const sim = new Simulation(1);
    const pid = sim.addPlayer('c1', 'mage', 'Ember');
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    store.saveCharacter(made.id, save);
    const loaded = store.loadCharacter(a.id, made.id);
    expect(loaded?.save?.items.length).toBe(save.items.length);
    expect(store.listCharacters(a.id)[0]?.playedAt).toBeGreaterThan(0);
  });
});

describe('server settings', () => {
  it('round-trip through the store, and fall back to defaults when missing or corrupt', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rune-settings-')), 'rune.db');
    const store = new AccountStore(file);
    expect(store.loadSettings()).toEqual(DEFAULT_SERVER_SETTINGS);
    store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, xpRate: 3, motd: 'hi' });
    expect(store.loadSettings()).toMatchObject({ xpRate: 3, motd: 'hi' });
    store.close();
    const raw = new DatabaseSync(file);
    raw.prepare(`UPDATE settings SET value = '{"xpRate":999,"motd":"kept","registrationOpen":false}' WHERE key = 'server'`).run();
    const reopened = new AccountStore(file);
    // A stored value out of range drops only that field.
    expect(reopened.loadSettings()).toEqual({ ...DEFAULT_SERVER_SETTINGS, motd: 'kept', registrationOpen: false });
    raw.prepare("UPDATE settings SET value = '{not json' WHERE key = 'server'").run();
    raw.close();
    expect(reopened.loadSettings()).toEqual(DEFAULT_SERVER_SETTINGS);
    reopened.close();
  });

  it('gives dev tools to admins only, and resets time scale when the last admin leaves', () => {
    const sent = new Map<string, string[]>();
    const client = (id: string, admin: boolean): Client => {
      const out: string[] = [];
      sent.set(id, out);
      const socket: ClientSocket = { readyState: 1, OPEN: 1, send: (data) => out.push(String(data)), close: () => undefined };
      const c = new Client(id, socket);
      c.admin = admin;
      return c;
    };
    const room = new Room('t', { kind: 'flat' }, 1);
    const admin = client('a', true);
    const player = client('p', false);
    room.add(admin, 'mage', 'Boss');
    room.add(player, 'warrior', 'Pleb');
    const welcomes = (id: string) => (sent.get(id) ?? []).filter((m) => m.includes('"t":"welcome"'));
    expect(welcomes('a').at(-1)).toContain('"devTools":true');
    expect(welcomes('p').at(-1)).toContain('"devTools":false');

    room.handle(player, { t: 'dev', cmd: { c: 'timeScale', scale: 4 } });
    expect(room.timeScale).toBe(1);
    expect(sent.get('p')?.some((m) => m.includes('admins only'))).toBe(true);

    room.handle(admin, { t: 'dev', cmd: { c: 'timeScale', scale: 4 } });
    expect(room.timeScale).toBe(4);
    room.remove(admin);
    expect(room.timeScale).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('allows the limit per minute per key, then recovers', () => {
    let now = 0;
    const rl = new RateLimiter(2, () => now);
    expect([rl.allow('ip'), rl.allow('ip'), rl.allow('ip')]).toEqual([true, true, false]);
    expect(rl.allow('other')).toBe(true);
    now = 61_000;
    expect(rl.allow('ip')).toBe(true);
  });
});

function fakeHooks(): AdminHooks & { kicked: number[]; state: ServerSettings } {
  const state: ServerSettings = { ...DEFAULT_SERVER_SETTINGS };
  const kicked: number[] = [];
  return {
    kicked,
    state,
    overview: () => ({ build: 'test', uptimeSeconds: 1, memoryMb: 1, online: [], games: [], rooms: [] }),
    settings: () => ({ ...state }),
    updateSettings: (patch) => Object.assign(state, patch),
    announce: () => 0,
    kickCharacter: () => false,
    kickAccount: (id) => kicked.push(id),
  };
}

describe('AccountApi', () => {
  let server: Server;
  let base = '';
  const deleted: number[] = [];

  beforeAll(async () => {
    const api = new AccountApi(new AccountStore(':memory:'), (id) => deleted.push(id), fakeHooks(), new Set());
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it('runs the register, character and logout flow', async () => {
    const reg = await post('/api/register', { username: 'erin', password: 'longenough' });
    expect(reg.status).toBe(201);
    const regBody: unknown = await reg.json();
    const token = typeof regBody === 'object' && regBody !== null && 'token' in regBody ? regBody.token : null;
    if (!isSessionToken(token)) throw new Error('no token');

    expect((await post('/api/characters', { name: 'Brakk', classId: 'warrior' }, token)).status).toBe(201);
    expect((await post('/api/characters', { name: '1bad', classId: 'warrior' }, token)).status).toBe(400);
    const list = await fetch(`${base}/api/characters`, { headers: { authorization: `Bearer ${token}` } });
    expect(await list.json()).toMatchObject({ username: 'erin', characters: [{ name: 'Brakk', classId: 'warrior' }] });
    const id = 1;
    const del = await fetch(`${base}/api/characters/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(deleted).toEqual([id]);

    expect((await post('/api/logout', {}, token)).status).toBe(200);
    expect((await fetch(`${base}/api/characters`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('rejects bad logins with one message, non-JSON bodies, and oversized bodies', async () => {
    const bad = await post('/api/login', { username: 'nobody', password: 'whatever1' });
    expect(bad.status).toBe(401);
    const form = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(form.status).toBe(415);
    const huge = await post('/api/login', { username: 'x'.repeat(10_000), password: 'y' });
    expect(huge.status).toBe(413);
  });
});

describe('admin API', () => {
  let server: Server;
  let base = '';
  const hooks = fakeHooks();

  beforeAll(async () => {
    // Listed admin names cannot be registered through the API, so their accounts exist up front.
    const store = new AccountStore(':memory:');
    await store.register('Boss', 'password123');
    await store.register('mod', 'password123');
    const api = new AccountApi(store, () => undefined, hooks, new Set(['boss', 'mod', 'ghost']));
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const call = (method: string, path: string, token: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(base + path, init);
  };
  const register = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) });
    const body: unknown = await res.json();
    const token = typeof body === 'object' && body !== null && 'token' in body ? body.token : null;
    if (!isSessionToken(token)) throw new Error(`no token for ${username}`);
    return token;
  };
  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) });
    const body: unknown = await res.json();
    const token = typeof body === 'object' && body !== null && 'token' in body ? body.token : null;
    if (!isSessionToken(token)) throw new Error(`no token for ${username}`);
    return token;
  };
  const accountId = async (adminToken: string, username: string): Promise<number> => {
    const accounts: unknown = await (await call('GET', '/api/admin/accounts', adminToken)).json();
    const found = Array.isArray(accounts) ? accounts.find((a: unknown) => typeof a === 'object' && a !== null && Reflect.get(a, 'username') === username) : undefined;
    const id: unknown = found ? Reflect.get(found, 'id') : undefined;
    if (typeof id !== 'number') throw new Error(`no id for ${username}`);
    return id;
  };

  it('hides the admin API from everyone but admins', async () => {
    const player = await register('player1');
    expect((await call('GET', '/api/admin/accounts', player)).status).toBe(404);
    const boss = await login('Boss');
    const res = await call('GET', '/api/admin/accounts', boss);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.arrayContaining([expect.objectContaining({ username: 'Boss', admin: true }), expect.objectContaining({ username: 'player1', admin: false })]));
    const chars: unknown = await (await call('GET', '/api/characters', boss)).json();
    expect(chars).toMatchObject({ admin: true });
  });

  it('bans end the session, block login, and can be undone', async () => {
    const victim = await register('griefer');
    const adminToken = await login('Boss');
    const griefId = await accountId(adminToken, 'griefer');
    expect((await call('POST', `/api/admin/accounts/${griefId}/ban`, adminToken, { banned: true })).status).toBe(200);
    expect(hooks.kicked).toContain(griefId);
    expect((await call('GET', '/api/characters', victim)).status).toBe(401);
    const bannedLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'griefer', password: 'password123' }) });
    expect(bannedLogin.status).toBe(403);
    expect((await call('POST', `/api/admin/accounts/${griefId}/ban`, adminToken, { banned: false })).status).toBe(200);
    expect((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'griefer', password: 'password123' }) })).status).toBe(200);
    // The ban deleted the old session, so unbanning does not revive it.
    expect((await call('GET', '/api/characters', victim)).status).toBe(401);
    // Admins cannot lock themselves or each other out.
    expect((await call('POST', `/api/admin/accounts/${await accountId(adminToken, 'Boss')}/ban`, adminToken, { banned: true })).status).toBe(400);
    expect((await call('POST', `/api/admin/accounts/${await accountId(adminToken, 'mod')}/ban`, adminToken, { banned: true })).status).toBe(400);
  });

  it('will not let anyone register a name listed as admin', async () => {
    const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Ghost', password: 'password123' }) });
    expect(res.status).toBe(409);
  });

  it('validates settings and enforces closed registration', async () => {
    const token = await login('Boss');
    expect((await call('PUT', '/api/admin/settings', token, { xpRate: 999 })).status).toBe(400);
    expect((await call('PUT', '/api/admin/settings', token, { xpRate: 2, registrationOpen: false })).status).toBe(200);
    expect(hooks.state.xpRate).toBe(2);
    const reg = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'latecomer', password: 'password123' }) });
    expect(reg.status).toBe(403);
  });
});
