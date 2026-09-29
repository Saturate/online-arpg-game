import { BAG, emptyGrid, STASH } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A mage as the v1 server stored it: a bound starter Fireball, a Link and a Linger stack in the bag. */
function v1Character(): string {
  const inventory = emptyGrid(BAG);
  inventory[0] = 2;
  inventory[1] = 3;
  return JSON.stringify({
    classId: 'mage',
    name: 'Old',
    items: [
      { uid: 1, kind: 'sigil', tier: 'common', name: 'Fireball', ilvl: 1, affixes: [], runes: ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'], corrupted: false, skill: 'fireball', bound: true },
      { uid: 2, kind: 'rune', tier: 'common', name: 'Link Rune', ilvl: 1, rune: 'link', count: 2, affixes: [] },
      { uid: 3, kind: 'rune', tier: 'magic', name: 'Linger Rune', ilvl: 1, rune: 'linger', count: 2, affixes: [] },
    ],
    inventory,
    stash: emptyGrid(STASH),
    sigils: [1, null, null, null],
    warband: [null, null, null, null, null],
    gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
    stance: 'defensive',
    waypoints: ['town'],
    level: 2,
    xp: 0,
    gold: 10,
  });
}

function v1Stash(): string {
  const cells = emptyGrid(STASH);
  cells[0] = 7;
  return JSON.stringify({ items: [{ uid: 7, kind: 'rune', tier: 'magic', name: 'Pierce Rune', ilvl: 1, rune: 'pierce', count: 3, affixes: [] }], cells });
}

async function v1Database() {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-convert-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('veteran', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Old', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(v1Character(), ch.id);
  raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(v1Stash(), acc.id);
  return { file, store, raw, accountId: acc.id, characterId: ch.id };
}

function stored(raw: DatabaseSync, sql: string, id: number): Record<string, unknown> {
  const row: unknown = raw.prepare(sql).get(id);
  const json = isRecord(row) ? Object.values(row)[0] : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  const v: unknown = JSON.parse(json);
  if (!isRecord(v)) throw new Error('not an object');
  return v;
}

function join1(rooms: RoomManager, store: AccountStore, accountId: number, characterId: number): FakeSocket {
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
  return socket;
}

describe('v1 rows on the server', () => {
  it('load converted, are written back as v2, and pay the refunds once', async () => {
    const { store, raw, accountId, characterId } = await v1Database();
    // Linger x2 in the bag and Pierce x3 in the stash, 12 gold each at v1 prices.
    const loaded = store.loadCharacter(accountId, characterId);
    expect(loaded?.save?.runeFormat).toBe(2);
    expect(loaded?.save?.gold).toBe(10 + 24);

    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    rooms.saveAll();

    const character = stored(raw, 'SELECT save_json FROM characters WHERE id = ?', characterId);
    expect(character.runeFormat).toBe(2);
    expect(character.gold).toBe(10 + 24 + 36);
    const items = Array.isArray(character.items) ? character.items.filter(isRecord) : [];
    const fireball = items.find((i) => i.kind === 'sigil');
    expect(fireball?.starter).toBe('fireball');
    expect(Array.isArray(fireball?.slots) && fireball.slots.length > 0).toBe(true);
    expect(items.some((i) => 'runes' in i || 'skill' in i)).toBe(false);
    expect(items.filter((i) => i.kind === 'rune').map((i) => [i.rune, i.count])).toEqual([['bond', 2]]);
    const stash = stored(raw, 'SELECT stash_json FROM accounts WHERE id = ?', accountId);
    expect(stash.runeFormat).toBe(2);
    expect(stash.items).toEqual([]);

    // Loading again reads the v2 rows as they are: nothing is paid twice.
    const again = new RoomManager(1, store);
    join1(again, store, accountId, characterId);
    again.saveAll();
    expect(stored(raw, 'SELECT save_json FROM characters WHERE id = ?', characterId).gold).toBe(10 + 24 + 36);
    raw.close();
  });

  it('keeps a v1 row it cannot read untouched and refuses the join', async () => {
    const { store, raw, accountId, characterId } = await v1Database();
    const broken = v1Character().replace('"rune":"link"', '"rune":"mystery"');
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(broken, characterId);
    expect(store.loadCharacter(accountId, characterId)?.saveUnreadable).toBe(true);
    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    expect(socket.sent.some((m) => m.t === 'sessionEnded' && m.reason.includes('could not be loaded'))).toBe(true);
    rooms.saveAll();
    expect(raw.prepare('SELECT save_json FROM characters WHERE id = ?').get(characterId)).toMatchObject({ save_json: broken });
    raw.close();
  });

  it('converts a v1 trader shelf on load', async () => {
    const { store, raw } = await v1Database();
    const shelf = { nextId: 3, stock: [{ id: 1, item: { uid: 0, kind: 'rune', tier: 'common', name: 'Link Rune', ilvl: 1, rune: 'link', count: 1, affixes: [] }, price: 12 }, { id: 2, item: { uid: 0, kind: 'rune', tier: 'magic', name: 'Linger Rune', ilvl: 1, rune: 'linger', count: 1, affixes: [] }, price: 36 }] };
    raw.prepare("INSERT INTO settings (key, value) VALUES ('trader', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(shelf));
    const market = store.loadMarket();
    expect(market.runeFormat).toBe(2);
    expect(market.stock.map((e) => [e.id, e.item.kind === 'rune' ? e.item.rune : null])).toEqual([[1, 'bond']]);
    raw.close();
  });
});
