import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSessionToken, type Item } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

/** Everything about an item except its uids, which a room reissues on every load. */
function shape(item: Item): string {
  const { uid: _uid, ...rest } = item;
  return JSON.stringify(item.kind === 'sigil' ? { ...rest, slots: item.slots.map(({ uid: _u, ...r }) => r) } : rest);
}

describe('admin item grants', () => {
  const store = new AccountStore(':memory:');
  const owners = new Set(['boss']);
  const rooms = new RoomManager(1, store, owners);
  let server: Server | undefined;
  let base = '';
  const tokens: Record<string, string> = {};
  let bhoId = 0;
  let heroId = 0;
  let freshId = 0;

  /** Logs the character in, returns every item it holds (bag, gear, warband, stash, pending) and logs out. */
  const visit = (characterId: number): Item[] => {
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(bhoId), characterId });
    rooms.tick();
    const inv = socket.last('inventory');
    socket.close();
    if (!inv) throw new Error('no inventory');
    return inv.items;
  };

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['mod1', 'moderator'],
      ['pleb1', 'player'],
      ['Bho', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      tokens[name] = store.createSession(acc.id);
      if (name === 'Bho') bhoId = acc.id;
    }
    const hero = store.createCharacter(bhoId, 'Doghand', 'binder');
    const fresh = store.createCharacter(bhoId, 'Unplayed', 'mage');
    if (typeof hero === 'string' || typeof fresh === 'string') throw new Error('no character');
    heroId = hero.id;
    freshId = fresh.id;
    // Played once, so it has a save to grant into.
    visit(heroId);
    const api = new AccountApi(store, () => undefined, rooms, owners);
    const http = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    server = http;
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = http.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server?.close());

  const grant = (who: string, body: Record<string, unknown>) => {
    const token = tokens[who];
    if (!token || !isSessionToken(token)) throw new Error(`no token for ${who}`);
    return fetch(`${base}/api/admin/grant`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const brothers = (over: Record<string, unknown> = {}) => ({ username: 'bho', characterId: heroId, template: 'brothers_creation', tier: 'relic', level: 1, ...over });
  const storedItems = (): Item[] => store.loadCharacter(bhoId, heroId)?.save?.items ?? [];

  it('is for the owner only, and a refusal writes nothing', async () => {
    const before = JSON.stringify(storedItems());
    expect((await grant('admin1', brothers())).status).toBe(403);
    expect((await grant('mod1', brothers())).status).toBe(403);
    // Non-staff do not learn the admin API exists.
    expect((await grant('pleb1', brothers())).status).toBe(404);
    expect((await grant('Bho', brothers())).status).toBe(404);
    expect(JSON.stringify(storedItems())).toBe(before);
  });

  it('checks every field on the server', async () => {
    const before = JSON.stringify(storedItems());
    const bad: Record<string, unknown>[] = [
      brothers({ template: 'crown_jewels' }),
      brothers({ tier: 'rare' }),
      brothers({ level: 0 }),
      brothers({ level: 31 }),
      brothers({ level: 2.5 }),
      brothers({ characterId: '1' }),
      brothers({ username: 'x; DROP TABLE' }),
      brothers({ gold: 1_000_000 }),
      { ...brothers({ template: 'sigil', tier: 'rare' }), minion: 'hound' },
      { ...brothers({ template: 'vessel', tier: 'rare' }), minion: 'dragon' },
      { ...brothers({ template: 'rune', tier: 'rare' }), rune: 'not_a_rune' },
    ];
    for (const body of bad) expect((await grant('boss', body)).status, JSON.stringify(body)).toBe(400);
    expect((await grant('boss', brothers({ username: 'nobody' }))).status).toBe(404);
    // Another account's character, or one that does not exist.
    expect((await grant('boss', brothers({ characterId: heroId + 999 }))).status).toBe(404);
    expect((await grant('boss', brothers({ characterId: freshId }))).status).toBe(409);
    expect(JSON.stringify(storedItems())).toBe(before);
  });

  it('refuses while the account is online, so a live save cannot write over the grant', async () => {
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(bhoId), characterId: heroId });
    const before = storedItems().map(shape).sort();
    const res = await grant('boss', brothers());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/online/) });
    // The session saves on the way out with fresh uids; the items themselves are the same.
    socket.close();
    expect(storedItems().map(shape).sort()).toEqual(before);
  });

  it('adds exactly one item with a fresh uid, logs it, and it reaches the character on login with nothing else changed', async () => {
    const held = visit(heroId).map(shape).sort();
    const savedUids = new Set(storedItems().map((i) => i.uid));
    const log = vi.spyOn(console, 'log');
    const res = await grant('boss', brothers({ username: 'BHO' }));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const item = typeof body === 'object' && body !== null ? Reflect.get(body, 'item') : null;
    expect(item).toMatchObject({ kind: 'vessel', name: 'Brothers Creation', tier: 'relic', minion: 'hound', pack: 6, fixedName: true });
    const logged = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[admin] boss (owner): grant "Brothers Creation"'));
    log.mockRestore();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Bho \/ Doghand/);

    const stored = storedItems();
    const added = stored.filter((i) => !savedUids.has(i.uid));
    expect(added).toHaveLength(1);
    expect(stored).toHaveLength(savedUids.size + 1);
    expect(added[0]?.bound).toBeUndefined();

    // On login the grant is there once, and every item held before is still there.
    const after = visit(heroId);
    const brothersNow = after.filter((i) => i.name === 'Brothers Creation');
    expect(brothersNow).toHaveLength(1);
    expect(after.map(shape).filter((s) => !s.includes('Brothers Creation')).sort()).toEqual(held);
    // The login placed it; a second login does not make another.
    expect(visit(heroId).filter((i) => i.name === 'Brothers Creation')).toHaveLength(1);
  });

  it('grants rolled vessels, sigils and runes unbound, one item per grant', async () => {
    const before = storedItems().length;
    for (const body of [
      { ...brothers({ template: 'vessel', tier: 'rare', level: 10 }), minion: 'hound' },
      brothers({ template: 'sigil', tier: 'magic', level: 3 }),
      brothers({ template: 'rune', tier: 'rare', level: 5 }),
    ]) {
      const res = await grant('boss', body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    const items = storedItems();
    expect(items).toHaveLength(before + 3);
    expect(new Set(items.map((i) => i.uid)).size).toBe(items.length);
    for (const i of items.slice(-3)) expect(i.bound).toBeUndefined();
    const vessel = items.find((i) => i.kind === 'vessel' && i.tier === 'rare');
    expect(vessel?.kind === 'vessel' ? vessel.minion : null).toBe('hound');
  });
});
