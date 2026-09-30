import { BAG, createGear, emptyGrid, placements, Rng, STASH, stashItemUids, type InventoryMessage, type PlayerComp } from '@rune/shared';
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

function stashRow(raw: DatabaseSync, accountId: number): Record<string, unknown> {
  const row: unknown = raw.prepare('SELECT stash_json FROM accounts WHERE id = ?').get(accountId);
  const json = isRecord(row) ? row.stash_json : undefined;
  if (typeof json !== 'string') throw new Error('no stash row');
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

/** The joined player's component, standing at the town's stash chest. */
function atStash(rooms: RoomManager, socket: FakeSocket): PlayerComp {
  const welcome = socket.last('welcome');
  const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
  const member = room ? [...room.members.values()].find((m) => m.client.socket === socket) : undefined;
  const p = member ? room?.sim.world.player.get(member.playerId) : undefined;
  const pos = member ? room?.sim.world.position.get(member.playerId) : undefined;
  const at = room?.sim.mapDef.stash;
  if (!room || !p || !pos || !at) throw new Error('not in town');
  pos.x = at.x + 50;
  pos.y = at.y;
  return p;
}

function inventoryAfter(rooms: RoomManager, socket: FakeSocket): InventoryMessage {
  const welcome = socket.last('welcome');
  const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
  room?.tick();
  const inv = socket.last('inventory');
  if (!inv) throw new Error('no inventory');
  return inv;
}

/**
 * An account stash as the v1 server stored it: a gear piece, plain Bolt and Fire stacks, a
 * hand-inscribed sigil and a Pierce stack (no v2 rune: paid in gold). It must go through the rune
 * conversion and then the tab conversion.
 */
function v1Stash(): string {
  const cells = emptyGrid(STASH);
  const put = (uid: number, x: number, y: number, w = 1, h = 1): void => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells[(y + dy) * STASH.w + x + dx] = uid;
  };
  put(1, 4, 2, 2, 3);
  put(2, 0, 0);
  put(3, 1, 0);
  put(4, 2, 0);
  put(5, 3, 0);
  return JSON.stringify({
    items: [
      { uid: 1, kind: 'gear', tier: 'rare', name: 'Grim Vest', ilvl: 5, base: 'padded_vest', category: 'body', affixes: [] },
      { uid: 2, kind: 'rune', tier: 'common', name: 'Bolt Rune', ilvl: 1, rune: 'bolt', count: 20, affixes: [] },
      { uid: 3, kind: 'rune', tier: 'common', name: 'Fire Rune', ilvl: 1, rune: 'fire', count: 4, affixes: [] },
      { uid: 4, kind: 'sigil', tier: 'magic', name: 'Old Whorl', ilvl: 3, affixes: [], runes: ['bolt', 'cold'], corrupted: false },
      { uid: 5, kind: 'rune', tier: 'magic', name: 'Pierce Rune', ilvl: 1, rune: 'pierce', count: 1, affixes: [] },
    ],
    cells,
  });
}

async function account(names: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-tabs-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('hoarder', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const characters = names.map((n) => {
    const ch = store.createCharacter(acc.id, n, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    return ch.id;
  });
  return { file, store, raw: new DatabaseSync(file), accountId: acc.id, characters };
}

describe('stash tabs on the server', () => {
  it('loads a v1-era stash row through both conversions and writes it back in the tab shape', async () => {
    const { store, raw, accountId, characters } = await account(['Keeper']);
    const [characterId] = characters;
    if (characterId === undefined) throw new Error('setup');
    raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(v1Stash(), accountId);
    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    const inv = inventoryAfter(rooms, socket);
    expect(inv.stash.general).toHaveLength(1);
    const listed = inv.stash.runes.list.map((u) => inv.items.find((i) => i.uid === u));
    expect(listed.map((i) => (i?.kind === 'rune' ? [i.rune, i.count] : null))).toEqual([['bolt', 20], ['fire', 4]]);
    expect(inv.stash.sigils.list).toHaveLength(1);
    expect(inv.stashTabPrice).toBe(250);
    rooms.saveAll();

    const row = stashRow(raw, accountId);
    expect(row).toMatchObject({ stashFormat: 2, runeFormat: 2, runes: { kind: 'runes' }, sigils: { kind: 'sigils' } });
    const items = Array.isArray(row.items) ? row.items.filter(isRecord) : [];
    expect(items.map((i) => i.kind).sort()).toEqual(['gear', 'rune', 'rune', 'sigil']);
    const runeList = isRecord(row.runes) && Array.isArray(row.runes.list) ? row.runes.list : [];
    expect(runeList.map((u) => items.find((i) => i.uid === u)).map((i) => [i?.rune, i?.count])).toEqual([['bolt', 20], ['fire', 4]]);
    expect('cells' in row).toBe(false);
    const general = Array.isArray(row.general) ? row.general.filter(isRecord) : [];
    const cells = general[0]?.cells;
    const vest = items.find((i) => i.kind === 'gear');
    // The vest keeps its cell (4, 2) in tab 1; uids are reissued per room, so it is found by name.
    expect(vest?.name).toBe('Grim Vest');
    const at = Array.isArray(cells) ? cells.findIndex((c) => c === vest?.uid) : -1;
    expect(at).toBe(2 * STASH.w + 4);
    // The Pierce stack was paid out as gold to the joining character, once.
    const gold = (): unknown => {
      const r: unknown = raw.prepare('SELECT save_json FROM characters WHERE id = ?').get(characterId);
      const j = isRecord(r) && typeof r.save_json === 'string' ? JSON.parse(r.save_json) : null;
      return isRecord(j) ? j.gold : null;
    };
    expect(gold()).toBe(12);

    // Loading again reads the new shape as it is.
    const again = new RoomManager(1, store);
    join1(again, store, accountId, characterId);
    again.saveAll();
    const again2 = stashRow(raw, accountId);
    expect(again2).toMatchObject({ stashFormat: 2 });
    expect(isRecord(again2.runes) && Array.isArray(again2.runes.list) && again2.runes.list.length).toBe(2);
    expect(gold()).toBe(12);
    raw.close();
  });

  it('refuses the join and keeps the row when a tab stash cannot be read', async () => {
    const { store, raw, accountId, characters } = await account(['Keeper']);
    const [characterId] = characters;
    if (characterId === undefined) throw new Error('setup');
    const broken = JSON.stringify({ stashFormat: 2, runeFormat: 2, items: [], general: [], runes: { kind: 'runes', list: ['lost'] }, sigils: { kind: 'sigils', list: [] } });
    raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(broken, accountId);
    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    expect(socket.sent.some((m) => m.t === 'sessionEnded' && m.reason.includes('stash could not be loaded'))).toBe(true);
    rooms.saveAll();
    expect(raw.prepare('SELECT stash_json FROM accounts WHERE id = ?').get(accountId)).toMatchObject({ stash_json: broken });
    raw.close();
  });

  it('two characters of one account cannot race a purchase or a move into a lost or doubled tab', async () => {
    const { store, raw, accountId, characters } = await account(['First', 'Second']);
    const [firstId, secondId] = characters;
    if (firstId === undefined || secondId === undefined) throw new Error('setup');
    const rooms = new RoomManager(1, store);

    // The first character buys tab 2 and puts a ring in it.
    const a = join1(rooms, store, accountId, firstId);
    const pa = atStash(rooms, a);
    pa.gold = 1000;
    const ring = createGear(77_000_001, new Rng(3), 'rare', 5, { category: 'ring' });
    pa.items.set(ring.uid, ring);
    const spot = pa.inventory.indexOf(null);
    pa.inventory[spot] = ring.uid;
    a.emit({ t: 'buyStashTab' });
    a.emit({ t: 'moveItem', uid: ring.uid, to: { at: 'tab', tab: 2, x: 0, y: 0 } });
    expect(a.sent.filter((m) => m.t === 'notice')).toEqual([]);
    expect(pa.gold).toBe(750);

    // The second joins before anything was saved: the first is saved and closed first, so the
    // second loads the tab and the ring exactly once.
    const b = join1(rooms, store, accountId, secondId);
    expect(a.sent.some((m) => m.t === 'sessionEnded')).toBe(true);
    const pb = atStash(rooms, b);
    const inv = inventoryAfter(rooms, b);
    expect(inv.stash.general.map((t) => t.id)).toEqual([1, 2]);
    const tab2 = inv.stash.general[1];
    const rings = inv.items.filter((i) => i.kind === 'gear' && i.name === ring.name);
    expect(rings).toHaveLength(1);
    expect(tab2 && placements(tab2.cells, STASH).map((c) => c.uid)).toEqual([rings[0]?.uid]);
    expect(inv.stashTabPrice).toBe(500);

    // The closed session's messages go nowhere; the live one buys the third tab.
    a.emit({ t: 'buyStashTab' });
    a.emit({ t: 'quickMove', uid: rings[0]?.uid ?? 0, tab: null });
    pb.gold = 600;
    b.emit({ t: 'buyStashTab' });
    expect(pb.stash.general.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(pb.gold).toBe(100);
    rooms.saveAll();

    const row = stashRow(raw, accountId);
    const general = Array.isArray(row.general) ? row.general.filter(isRecord) : [];
    expect(general.map((t) => t.id)).toEqual([1, 2, 3]);
    const items = Array.isArray(row.items) ? row.items.filter(isRecord) : [];
    expect(items.filter((i) => i.name === ring.name)).toHaveLength(1);
    const firstSave = store.loadCharacter(accountId, firstId)?.save;
    expect(firstSave?.gold).toBe(750);
    expect(firstSave && stashItemUids(firstSave.stash)).toEqual([]);
    expect(firstSave?.inventory).toHaveLength(BAG.w * BAG.h);
    raw.close();
  });
});
