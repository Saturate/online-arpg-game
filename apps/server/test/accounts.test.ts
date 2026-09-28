import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSessionToken, Simulation } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi, RateLimiter } from '../src/http.js';

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

describe('AccountApi', () => {
  let server: Server;
  let base = '';
  const deleted: number[] = [];

  beforeAll(async () => {
    const api = new AccountApi(new AccountStore(':memory:'), (id) => deleted.push(id));
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
