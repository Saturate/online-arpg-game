import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBenchPick, isBenchState, Simulation, type BenchState, type ClassId } from '@rune/shared';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { BenchStore, POPULAR_TTL_MS } from '../src/benchStore.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';

/** Writes a fresh character's save, as the game would after a first session. */
async function playedCharacter(store: AccountStore, name: string, classId: ClassId): Promise<number> {
  const acc = await store.register(name, 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, `${name}Hero`, classId);
  if (typeof ch === 'string') throw new Error(ch);
  const sim = new Simulation(1, { kind: 'flat' });
  const save = sim.exportPlayer(sim.addPlayer(name, classId, `${name}Hero`));
  if (!save) throw new Error('no save');
  store.saveCharacter(ch.id, save);
  return ch.id;
}

describe('balance bench API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  const dbPath = join(dir, 'rune.db');
  const store = new AccountStore(dbPath);
  const rooms = new RoomManager(1, store);
  let server: Server;
  let base = '';
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['mod1', 'moderator'],
      ['build1', 'builder'],
      ['pleb1', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      tokens[name] = store.createSession(acc.id);
    }
    const boss = store.accountByUsername('boss');
    if (!boss) throw new Error('no boss');
    tokens.scoped = store.adminTokens.create(boss.id, 'tuner', ['viewAdmin', 'tuning'], Date.now() + 60_000).token;
    tokens.unscoped = store.adminTokens.create(boss.id, 'reader', ['viewAdmin', 'settings'], Date.now() + 60_000).token;
    for (const [name, classId] of [
      ['Alma', 'mage'],
      ['Borg', 'mage'],
      ['Cass', 'ranger'],
    ] as const)
      await playedCharacter(store, name, classId);
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']));
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const call = (method: string, path: string, who: string, body?: unknown) => {
    const token = tokens[who];
    if (!token) throw new Error(`no token for ${who}`);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(base + path, init);
  };

  const state = async (who = 'build1'): Promise<BenchState> => {
    const res = await call('GET', '/api/admin/bench', who);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (!isBenchState(body)) throw new Error('not a bench state');
    return body;
  };

  it('shows every staff role the bench, and hides it from players', async () => {
    for (const who of ['build1', 'mod1', 'admin1', 'boss', 'scoped', 'unscoped']) await state(who);
    expect((await call('GET', '/api/admin/bench', 'pleb1')).status).toBe(404);
  });

  it('lists the most equipped sigils by rune text and count, with no player or character names', async () => {
    const s = await state();
    expect(s.popular.length).toBeGreaterThan(0);
    expect(s.popular.length).toBeLessThanOrEqual(20);
    // Both mages hold the same kit; the ranger's kit is counted on the ranger.
    expect(s.popular[0]?.equipped).toBe(2);
    expect(s.popular[0]?.classId).toBe('mage');
    expect(s.popular.some((p) => p.classId === 'ranger' && p.equipped === 1)).toBe(true);
    const json = JSON.stringify(s.popular);
    for (const n of ['Alma', 'Borg', 'Cass', 'Hero', 'boss']) expect(json).not.toContain(n);
  });

  it('lets only the tuning permission add and remove picks, sessions and tokens alike', async () => {
    const pick = { text: 'bolt fire fire', classId: 'mage' };
    for (const who of ['build1', 'mod1', 'unscoped']) expect((await call('POST', '/api/admin/bench/picks', who, pick)).status, who).toBe(403);
    const res = await call('POST', '/api/admin/bench/picks', 'scoped', pick);
    expect(res.status).toBe(201);
    const added: unknown = await res.json();
    if (!isBenchPick(added)) throw new Error('not a pick');
    expect(added).toMatchObject({ text: 'bolt fire fire', classId: 'mage', multicast: 1, account: 'boss', token: 'tuner' });
    for (const who of ['build1', 'mod1', 'unscoped']) expect((await call('DELETE', `/api/admin/bench/picks/${added.id}`, who)).status, who).toBe(403);
    expect((await call('DELETE', `/api/admin/bench/picks/${added.id}`, 'admin1')).status).toBe(200);
    expect((await call('DELETE', `/api/admin/bench/picks/${added.id}`, 'admin1')).status).toBe(404);
  });

  it('checks picks with the grammar, stores them as it writes them, and shares them between admins', async () => {
    expect((await call('POST', '/api/admin/bench/picks', 'admin1', { text: 'blot fire', classId: 'mage' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bench/picks', 'admin1', { text: 'fire', classId: 'mage' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bench/picks', 'admin1', { text: 'nova', classId: 'pirate' })).status).toBe(400);
    expect((await call('POST', '/api/admin/bench/picks', 'admin1', { text: 'nova[+50%  size]  lightning', classId: 'priest', multicast: 2 })).status).toBe(201);
    expect((await call('POST', '/api/admin/bench/picks', 'boss', { text: 'nova[+50% size] lightning', classId: 'priest', multicast: 2 })).status).toBe(409);
    const seen = (await state('mod1')).picks.find((p) => p.classId === 'priest');
    expect(seen).toMatchObject({ text: 'nova[+50% size] lightning', multicast: 2, account: 'admin1', token: null });
  });

  it('keeps picks across a restart', async () => {
    const again = new AccountStore(dbPath);
    expect(again.bench.picks().some((p) => p.text === 'nova[+50% size] lightning')).toBe(true);
  });
});

describe('most equipped cache', () => {
  it('counts the saves again only after the cache runs out', async () => {
    const store = new AccountStore(':memory:');
    await playedCharacter(store, 'Dana', 'warrior');
    let now = 1_000_000;
    const db = Reflect.get(store, 'db');
    if (!(db instanceof DatabaseSync)) throw new Error('no db');
    const bench = new BenchStore(db, () => now);
    const first = bench.mostEquipped();
    expect(first.sigils.every((s) => s.equipped === 1)).toBe(true);
    await playedCharacter(store, 'Eric', 'warrior');
    now += POPULAR_TTL_MS - 1;
    expect(bench.mostEquipped()).toBe(first);
    now += 1;
    const next = bench.mostEquipped();
    expect(next.at).toBe(now);
    expect(next.sigils[0]?.equipped).toBe(2);
  });
});
