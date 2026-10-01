import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAdminToken, LIVE_TAIL, TICK_HISTORY_SECONDS, type TokenScope } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { events } from '../src/eventLog.js';
import { AccountApi, isStaffChange } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { Ring, ROOM_TICK_SAMPLES, ServerStats } from '../src/tickStats.js';
import { FakeSocket } from './fakeSocket.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('not a list');
  return v;
}

function rec(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error('not an object');
  return v;
}

describe('tick timing', () => {
  it('keeps the newest samples in a ring, oldest first, without growing', () => {
    const ring = new Ring(4);
    expect(ring.mean()).toBe(0);
    expect(ring.values()).toEqual([]);
    for (const v of [1, 2, 3]) ring.push(v);
    expect(ring.values()).toEqual([1, 2, 3]);
    for (const v of [4, 5, 6]) ring.push(v);
    expect(ring.size).toBe(4);
    expect(ring.values()).toEqual([3, 4, 5, 6]);
    expect(ring.mean()).toBe(4.5);
    expect(ring.mean(2)).toBe(5.5);
    expect(ring.max()).toBe(6);
    expect(ring.max(10)).toBe(6);
  });

  it('rolls ticks into one sample per second with the mean, the worst tick and the message rates', () => {
    const stats = new ServerStats(4);
    for (const ms of [1, 1, 1, 9]) stats.recordTick(ms);
    stats.messagesIn += 40;
    stats.messagesOut += 400;
    for (const ms of [2, 2, 2, 2]) stats.recordTick(ms);
    const s = stats.snapshot();
    expect(s.tickHistory.mean).toEqual([3, 2]);
    expect(s.tickHistory.max).toEqual([9, 2]);
    expect(s.tickMs).toBe(2.5);
    expect(s.tickMaxMs).toBe(9);
    // 40 in and 400 out landed in the second bucket; the rate is the mean over both seconds.
    expect(s.messagesIn).toBe(20);
    expect(s.messagesOut).toBe(200);
    // A partial second is not a sample yet.
    stats.recordTick(50);
    expect(stats.snapshot().tickHistory.mean).toHaveLength(2);
  });

  it('keeps the sparkline to its window however long the server runs', () => {
    const stats = new ServerStats(1);
    for (let i = 0; i < TICK_HISTORY_SECONDS + 50; i++) stats.recordTick(i);
    const { tickHistory } = stats.snapshot();
    expect(tickHistory.mean).toHaveLength(TICK_HISTORY_SECONDS);
    expect(tickHistory.mean[0]).toBe(50);
  });
});

describe('the live view and search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rune-live-'));
  const store = new AccountStore(join(dir, 'rune.db'));
  const owners = new Set(['boss']);
  const rooms = new RoomManager(1, store, owners);
  const sessions: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let server: Server | undefined;
  let base = '';
  let socket: FakeSocket | undefined;

  const call = (path: string, auth: string, method = 'GET', body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${auth}` } };
    if (body !== undefined) {
      init.headers = { authorization: `Bearer ${auth}`, 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(base + path, init);
  };
  const get = async (path: string, auth: string) => {
    const res = await call(path, auth);
    expect(res.status).toBe(200);
    return rec(await res.json());
  };
  const token = async (scopes: readonly TokenScope[]) => {
    const res = await call('/api/admin/tokens', sessions.boss ?? '', 'POST', { name: `t ${scopes.join(' ')}`, scopes, days: 1 });
    const t = rec(await res.json()).token;
    if (!isAdminToken(t)) throw new Error('no token');
    return t;
  };

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['mod1', 'moderator'],
      ['build1', 'builder'],
      ['pleb1', 'player'],
      ['odd%name_1', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      ids[name] = acc.id;
      sessions[name] = store.createSession(acc.id);
    }
    const ch = store.createCharacter(ids.pleb1 ?? 0, 'Plebby', 'mage');
    if (typeof ch === 'string') throw new Error(ch);
    socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: sessions.pleb1, characterId: ch.id });
    for (let i = 0; i < 3; i++) rooms.tick();
    const api = new AccountApi(store, () => undefined, rooms, owners, { other: 100_000, token: 100_000 });
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
    events.log('error', 'live test: a room fell over');
    events.log('staff', '[admin] boss (owner): settings {"xpRate":2}');
    events.log('staff', '[admin] boss (owner) token "script": GET /api/admin/overview');
  });

  afterAll(() => {
    socket?.close();
    server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures every room tick into the room ring, bounded', () => {
    const room = rooms.roomById('i1-world');
    if (!room) throw new Error('no world room');
    expect(room.tickTimes.size).toBe(3);
    for (let i = 0; i < ROOM_TICK_SAMPLES + 5; i++) rooms.tick();
    expect(room.tickTimes.size).toBe(ROOM_TICK_SAMPLES);
  });

  it('shows who is online, where, for how long, and each room and world copy', async () => {
    const live = await get('/api/admin/live', sessions.boss ?? '');
    const [player] = list(live.players).map(rec);
    expect(player).toMatchObject({ name: 'Plebby', classId: 'mage', level: 1, account: 'pleb1', accountId: ids.pleb1, game: 'i1', roomId: 'i1-world', party: null });
    expect(typeof player?.region).toBe('string');
    expect(player?.region).not.toBe('');
    expect(player?.onlineSeconds).toBeGreaterThanOrEqual(0);
    const room = list(live.rooms).map(rec).find((r) => r.id === 'i1-world');
    expect(room).toMatchObject({ kind: 'world', game: 'i1', players: 1 });
    expect(room?.tickMs).toEqual(expect.any(Number));
    expect(room?.tickMaxMs).toBeGreaterThanOrEqual(Number(room?.tickMs));
    const [world] = list(live.worlds).map(rec);
    expect(world).toMatchObject({ game: 'i1', name: 'Public world 1' });
    expect(list(world?.dots).map(rec)[0]).toMatchObject({ name: 'Plebby', inParty: false });
    const regions = rec(world?.regions);
    expect(list(regions.cells)).toHaveLength(Number(regions.cols) * Number(regions.rows));
    expect(list(regions.names).length).toBeGreaterThan(1);
    const health = rec(live.health);
    expect(health).toMatchObject({ connections: 1, inGame: 1, build: expect.any(String) });
    expect(Number(health.messagesOut)).toBeGreaterThanOrEqual(0);
  });

  it('sends the log tails only to roles with serverLog, and never token reads in the staff tail', async () => {
    for (const who of ['boss', 'admin1']) {
      const live = await get('/api/admin/live', sessions[who] ?? '');
      const log = list(live.log).map(rec);
      const staff = list(live.staff).map(rec);
      expect(log.some((e) => e.text === 'live test: a room fell over')).toBe(true);
      expect(log.every((e) => e.kind !== 'staff')).toBe(true);
      expect(log.length).toBeLessThanOrEqual(LIVE_TAIL.log);
      expect(staff.some((e) => String(e.text).includes('settings {"xpRate":2}'))).toBe(true);
      expect(staff.some((e) => String(e.text).includes('GET /api/admin/overview'))).toBe(false);
      // Newest first.
      const ats = log.map((e) => Number(e.id));
      expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    }
    for (const who of ['mod1', 'build1']) {
      const live = await get('/api/admin/live', sessions[who] ?? '');
      expect(live.log).toBeNull();
      expect(live.staff).toBeNull();
      expect(list(live.players)).toHaveLength(1);
    }
    expect((await call('/api/admin/live', sessions.pleb1 ?? '')).status).toBe(404);
  });

  it('follows token scopes: the tails need a serverLog token, and polling stays out of the staff log', async () => {
    const plain = await token([]);
    const logs = await token(['serverLog']);
    const before = events.since(0).next;
    const a = await get('/api/admin/live', plain);
    expect(a.log).toBeNull();
    expect(a.staff).toBeNull();
    const b = await get('/api/admin/live', logs);
    expect(Array.isArray(b.log)).toBe(true);
    expect(Array.isArray(b.staff)).toBe(true);
    expect(events.since(before).entries.filter((e) => e.text.includes('/api/admin/live'))).toEqual([]);
  });

  it('tells a staff change from a token read', () => {
    const at = Date.now();
    expect(isStaffChange({ id: 1, at, kind: 'staff', text: '[admin] a (admin): kick character 3' })).toBe(true);
    expect(isStaffChange({ id: 2, at, kind: 'staff', text: '[admin] a (admin) token "x": GET /api/admin/tuning/history' })).toBe(false);
    expect(isStaffChange({ id: 3, at, kind: 'staff', text: '[admin] a (admin) token "x": PATCH /api/admin/tuning' })).toBe(true);
    expect(isStaffChange({ id: 4, at, kind: 'error', text: 'boom' })).toBe(false);
  });

  it('searches accounts by name and by character, names that start with it first', async () => {
    const byChar = await get('/api/admin/search?q=plebb', sessions.build1 ?? '');
    expect(list(byChar.accounts).map((a) => rec(a).username)).toEqual(['pleb1']);
    expect(list(rec(list(byChar.accounts)[0]).characters).map((c) => rec(c).name)).toEqual(['Plebby']);
    const prefix = await get('/api/admin/search?q=bo', sessions.build1 ?? '');
    expect(rec(list(prefix.accounts)[0])).toMatchObject({ username: 'boss', role: 'owner' });
    // LIKE wildcards in the query match themselves.
    const odd = await get(`/api/admin/search?q=${encodeURIComponent('%n')}`, sessions.build1 ?? '');
    expect(list(odd.accounts).map((a) => rec(a).username)).toEqual(['odd%name_1']);
    const under = await get('/api/admin/search?q=e_', sessions.build1 ?? '');
    expect(list(under.accounts).map((a) => rec(a).username)).toEqual(['odd%name_1']);
  });

  it('searches log lines only for serverLog, by role and by token scope', async () => {
    const owner = await get('/api/admin/search?q=fell over', sessions.boss ?? '');
    expect(list(owner.log).map((e) => rec(e).text)).toContain('live test: a room fell over');
    expect((await get('/api/admin/search?q=fell over', sessions.mod1 ?? '')).log).toBeNull();
    expect((await get('/api/admin/search?q=fell over', sessions.build1 ?? '')).log).toBeNull();
    expect((await get('/api/admin/search?q=fell over', await token([]))).log).toBeNull();
    expect(list((await get('/api/admin/search?q=fell over', await token(['serverLog']))).log)).not.toHaveLength(0);
    expect((await call('/api/admin/search?q=fell', sessions.pleb1 ?? '')).status).toBe(404);
    expect((await call('/api/admin/search?q=f', sessions.boss ?? '')).status).toBe(400);
    expect((await call(`/api/admin/search?q=${'x'.repeat(65)}`, sessions.boss ?? '')).status).toBe(400);
  });
});
