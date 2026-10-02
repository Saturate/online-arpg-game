import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBenchPick, isBenchState, resetTunables, Simulation, type BenchState, type ClassId } from '@rune/shared';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { BenchStore } from '../src/benchStore.js';
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
    expect(added).toMatchObject({ text: 'bolt fire fire', classId: 'mage', multicast: 1, account: 'boss' });
    // Only the adding account is shown, never the token's name.
    expect(added).not.toHaveProperty('token');
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
    expect(seen).toMatchObject({ text: 'nova[+50% size] lightning', multicast: 2, account: 'admin1' });
    expect((await state('mod1')).picks.every((p) => !('token' in p))).toBe(true);
    // A roll past every tier of the drop table is refused like a grammar error.
    const res = await call('POST', '/api/admin/bench/picks', 'admin1', { text: 'bolt[+300% damage]', classId: 'mage' });
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(JSON.stringify(body)).toContain('outside what any rune rolls');
  });

  it('keeps picks across a restart', async () => {
    const again = new AccountStore(dbPath);
    expect(again.bench.picks().some((p) => p.text === 'nova[+50% size] lightning')).toBe(true);
  });
});

describe('most equipped tally', () => {
  const dbOf = (store: AccountStore): DatabaseSync => {
    const db = Reflect.get(store, 'db');
    if (!(db instanceof DatabaseSync)) throw new Error('no db');
    return db;
  };

  it('follows every save and delete as it happens, without reading the table again', async () => {
    const store = new AccountStore(':memory:');
    const a = await playedCharacter(store, 'Dana', 'warrior');
    const b = await playedCharacter(store, 'Eric', 'warrior');
    const top = () => store.bench.mostEquipped().sigils[0]?.equipped;
    expect(top()).toBe(2);
    const acc = store.accountForCharacter(b);
    if (!acc) throw new Error('no account');
    store.deleteCharacter(acc.id, b);
    expect(top()).toBe(1);
    const loaded = store.loadCharacter(store.accountForCharacter(a)?.id ?? 0, a);
    if (!loaded?.save) throw new Error('no save');
    store.saveCharacter(a, { ...loaded.save, sigils: [null, null, null, null] });
    expect(store.bench.mostEquipped().sigils).toEqual([]);
  });

  it('counts the stored saves at boot in steps, skipping characters a save or delete already updated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-seed-'));
    const path = join(dir, 'rune.db');
    const first = new AccountStore(path);
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await playedCharacter(first, `Seed${i}`, 'mage'));
    const booted = new AccountStore(path);
    const bench = new BenchStore(dbOf(booted));
    expect(bench.mostEquipped()).toMatchObject({ ready: false, sigils: [] });
    // Deleted and re-saved before the count reaches them: neither may be counted from the old row.
    bench.noteDelete(ids[0] ?? 0);
    const kept = booted.loadCharacter(booted.accountForCharacter(ids[1] ?? 0)?.id ?? 0, ids[1] ?? 0);
    if (!kept?.save) throw new Error('no save');
    bench.noteSave(ids[1] ?? 0, kept.save);
    await bench.seed();
    const after = bench.mostEquipped();
    expect(after.ready).toBe(true);
    expect(after.sigils[0]?.equipped).toBe(6);
    await bench.seed();
    expect(bench.mostEquipped().sigils[0]?.equipped).toBe(6);
  });

  it('answers the bench without parsing a save', async () => {
    const store = new AccountStore(':memory:');
    await playedCharacter(store, 'Gale', 'ranger');
    await store.bench.seed();
    const rooms = new RoomManager(1, store);
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']));
    const acc = await store.register('boss', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const token = store.createSession(acc.id);
    const server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/admin/bench`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const savesParsed = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"runeFormat"'));
      expect(savesParsed).toHaveLength(0);
    } finally {
      parse.mockRestore();
      server.close();
    }
  });
});

describe('bench write limit', () => {
  it('counts only writes that pass their checks, apart from the tuning limit', async () => {
    const store = new AccountStore(':memory:');
    const rooms = new RoomManager(1, store);
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']), { benchWrites: 2 });
    const acc = await store.register('boss', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const token = store.createSession(acc.id);
    const server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const post = (text: string) => fetch(`http://127.0.0.1:${addr.port}/api/admin/bench/picks`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, classId: 'mage' }) });
    try {
      for (let i = 0; i < 5; i++) expect((await post('blot')).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${addr.port}/api/admin/bench/picks/999`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await post('bolt fire')).status).toBe(201);
      expect((await post('bolt cold')).status).toBe(201);
      expect((await post('bolt lightning')).status).toBe(429);
      const patch = await fetch(`http://127.0.0.1:${addr.port}/api/admin/tuning`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ 'spell.bolt.damageMax': 17 }) });
      expect(patch.status).toBe(200);
    } finally {
      resetTunables();
      server.close();
    }
  });
});
