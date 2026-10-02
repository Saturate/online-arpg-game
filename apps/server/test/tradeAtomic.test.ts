import { buyPrice, createRune, createSigil, emptyStash, Rng, sellPrice, type Item, type PlayerComp, type StashSave } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountStore, type Market } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

const START_GOLD = 1000;

function named(item: Item, name: string): Item {
  return { ...item, name };
}

/**
 * A saved character with 1000 gold, a "Witness Sigil" and 10 Fire runes in the bag, and a shelf
 * holding a "Shelf Sigil" and 5 Fire runes (which top up the bag's stack when bought).
 */
async function world() {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-trade-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('trader', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Haggler', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  // The first join makes the starter kit; leaving saves it.
  const first = new RoomManager(1, store);
  const s = new FakeSocket();
  first.connect(s);
  s.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  s.close();
  const stored = store.loadCharacter(acc.id, ch.id)?.save;
  if (!stored) throw new Error('no save');
  const rng = new Rng(7);
  const witness = named(createSigil(90_001, rng, 'rare'), 'Witness Sigil');
  const fire = createRune(90_002, 'fire', 10);
  const inventory = [...stored.inventory];
  for (const it of [witness, fire]) inventory[inventory.indexOf(null)] = it.uid;
  const save = { ...stored, items: [...stored.items, witness, fire], inventory, gold: START_GOLD };
  const shelfSigil = named(createSigil(0, rng, 'magic'), 'Shelf Sigil');
  const shelfFire = createRune(0, 'fire', 5);
  const market: Market = {
    nextId: 3,
    stock: [
      { id: 1, price: buyPrice(shelfSigil), item: shelfSigil },
      { id: 2, price: buyPrice(shelfFire), item: shelfFire },
    ],
    runeFormat: 2,
    runeTiers: 6,
    runeImplicits: 1,
  };
  const stash: StashSave = { ...emptyStash(), items: [], runeFormat: 2, runeTiers: 6, runeImplicits: 1 };
  store.saveCharacterAndStash(ch.id, save, acc.id, stash, market);
  return { file, store, raw: new DatabaseSync(file), accountId: acc.id, characterId: ch.id, witness, shelfSigil };
}

/** Joins a fresh server and stands the hero at the trader. */
function atTrader(store: AccountStore, accountId: number, characterId: number) {
  const rooms = new RoomManager(1, store);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
  const welcome = socket.last('welcome');
  const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
  const member = room ? [...room.members.values()].find((m) => m.client.socket === socket) : undefined;
  const p = member ? room?.sim.world.player.get(member.playerId) : undefined;
  const pos = member ? room?.sim.world.position.get(member.playerId) : undefined;
  const at = room?.sim.mapDef.trader;
  if (!room || !p || !pos || !at) throw new Error('not in town');
  pos.x = at.x + 50;
  pos.y = at.y;
  return { rooms, socket, p };
}

/** The SQLite write of the shelf fails, inside the trade's transaction, after the character row was written. */
function breakShelfWrites(raw: DatabaseSync): () => void {
  raw.exec(`
    CREATE TRIGGER shelf_insert_fails BEFORE INSERT ON settings WHEN NEW.key = 'trader' BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;
    CREATE TRIGGER shelf_update_fails BEFORE UPDATE ON settings WHEN NEW.key = 'trader' BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;
  `);
  return () => raw.exec('DROP TRIGGER shelf_insert_fails; DROP TRIGGER shelf_update_fails;');
}

/** What a restarted server would read back: every item by name with where it is, and the gold. */
function afterRestart(file: string, accountId: number, characterId: number) {
  const store = new AccountStore(file);
  const save = store.loadCharacter(accountId, characterId)?.save;
  const stash = store.loadStash(accountId);
  const market = store.loadMarket();
  store.close();
  if (!save || stash === 'unreadable') throw new Error('unreadable');
  const where = (name: string): string[] => [
    ...save.items.filter((i) => i.name === name).map(() => 'character'),
    ...(stash?.stash.items ?? []).filter((i) => i.name === name).map(() => 'stash'),
    ...market.stock.filter((e) => e.item.name === name).map(() => 'shelf'),
  ];
  const fireCount = (list: readonly Item[]): number => list.reduce((n, i) => n + (i.kind === 'rune' && i.rune === 'fire' ? i.count : 0), 0);
  return {
    gold: save.gold,
    where,
    fire: { character: fireCount(save.items), shelf: fireCount(market.stock.map((e) => e.item)) },
    shelf: market.stock.map((e) => e.item.name),
  };
}

function bagNames(p: PlayerComp): string[] {
  return p.inventory.flatMap((u, i) => (u !== null && p.inventory.indexOf(u) === i ? [p.items.get(u)?.name ?? '?'] : [])).sort();
}

function bagFire(p: PlayerComp): number {
  let n = 0;
  for (const u of new Set(p.inventory)) {
    const it = u === null ? undefined : p.items.get(u);
    if (it?.kind === 'rune' && it.rune === 'fire') n += it.count;
  }
  return n;
}

function uidOf(p: PlayerComp, name: string): number {
  const it = [...p.items.values()].find((i) => i.name === name);
  if (!it) throw new Error(`no ${name}`);
  return it.uid;
}

describe('trades are atomic', () => {
  it('a buy whose write fails changes nothing, and a later save cannot make the item exist twice', async () => {
    const { file, store, raw, accountId, characterId } = await world();
    const { rooms, socket, p } = atTrader(store, accountId, characterId);
    const bagBefore = bagNames(p);
    const repair = breakShelfWrites(raw);
    socket.emit({ t: 'buy', id: 1 });
    expect(socket.last('notice')?.text).toMatch(/could not be saved/);
    expect(p.gold).toBe(START_GOLD);
    expect(bagNames(p)).toEqual(bagBefore);
    socket.emit({ t: 'traderList' });
    expect(socket.last('trader')?.stock.map((e) => e.item.name)).toContain('Shelf Sigil');
    // The disk recovers and the autosave goes through before the restart.
    repair();
    rooms.saveAll();
    const after = afterRestart(file, accountId, characterId);
    expect(after.where('Shelf Sigil')).toEqual(['shelf']);
    expect(after.where('Witness Sigil')).toEqual(['character']);
    expect(after.gold).toBe(START_GOLD);
    raw.close();
  });

  it('a rune buy that topped up a stack before its write failed puts the stack back exactly', async () => {
    const { file, store, raw, accountId, characterId } = await world();
    const { rooms, socket, p } = atTrader(store, accountId, characterId);
    expect(bagFire(p)).toBe(10);
    const repair = breakShelfWrites(raw);
    socket.emit({ t: 'buy', id: 2 });
    expect(socket.last('notice')?.text).toMatch(/could not be saved/);
    expect(bagFire(p)).toBe(10);
    expect(p.gold).toBe(START_GOLD);
    repair();
    rooms.saveAll();
    const after = afterRestart(file, accountId, characterId);
    expect(after.fire).toEqual({ character: 10, shelf: 5 });
    expect(after.gold).toBe(START_GOLD);
    raw.close();
  });

  it('a sale whose write fails keeps the item and the gold where they were', async () => {
    const { file, store, raw, accountId, characterId } = await world();
    const { rooms, socket, p } = atTrader(store, accountId, characterId);
    const bagBefore = bagNames(p);
    const repair = breakShelfWrites(raw);
    socket.emit({ t: 'sell', uid: uidOf(p, 'Witness Sigil') });
    expect(socket.last('notice')?.text).toMatch(/could not be saved/);
    expect(p.gold).toBe(START_GOLD);
    expect(bagNames(p)).toEqual(bagBefore);
    socket.emit({ t: 'traderList' });
    expect(socket.last('trader')?.stock.map((e) => e.item.name)).not.toContain('Witness Sigil');
    repair();
    rooms.saveAll();
    const after = afterRestart(file, accountId, characterId);
    expect(after.where('Witness Sigil')).toEqual(['character']);
    expect(after.shelf).toEqual(['Shelf Sigil', 'Fire Rune']);
    expect(after.gold).toBe(START_GOLD);
    raw.close();
  });

  it('a trade after a failed one goes through normally', async () => {
    const { file, store, raw, accountId, characterId, shelfSigil } = await world();
    const { socket, p } = atTrader(store, accountId, characterId);
    const repair = breakShelfWrites(raw);
    socket.emit({ t: 'buy', id: 1 });
    repair();
    socket.emit({ t: 'buy', id: 1 });
    expect(p.gold).toBe(START_GOLD - buyPrice(shelfSigil));
    // Straight to the restart, with no autosave: the trade's own write is enough.
    const after = afterRestart(file, accountId, characterId);
    expect(after.where('Shelf Sigil')).toEqual(['character']);
    expect(after.gold).toBe(START_GOLD - buyPrice(shelfSigil));
    raw.close();
  });

  it('successful buys and sales conserve every item and coin across a restart', async () => {
    const { file, store, raw, accountId, characterId, witness, shelfSigil } = await world();
    const { rooms, socket, p } = atTrader(store, accountId, characterId);
    socket.emit({ t: 'buy', id: 1 });
    socket.emit({ t: 'buy', id: 2 });
    socket.emit({ t: 'sell', uid: uidOf(p, 'Witness Sigil') });
    const gold = START_GOLD - buyPrice(shelfSigil) - buyPrice(createRune(0, 'fire', 5)) + sellPrice(witness);
    expect(p.gold).toBe(gold);
    expect(bagFire(p)).toBe(15);
    // The trades' own writes, before any autosave.
    const before = afterRestart(file, accountId, characterId);
    expect(before.where('Shelf Sigil')).toEqual(['character']);
    expect(before.where('Witness Sigil')).toEqual(['shelf']);
    expect(before.fire).toEqual({ character: 15, shelf: 0 });
    expect(before.gold).toBe(gold);
    rooms.saveAll();
    const after = afterRestart(file, accountId, characterId);
    expect(after).toEqual({ ...before, where: after.where });
    expect(after.where('Shelf Sigil')).toEqual(['character']);
    expect(after.where('Witness Sigil')).toEqual(['shelf']);
    raw.close();
  });

  it('a sale writes the shelf marked six tiers, so a restart leaves a roll on a shared tier end at its tier', async () => {
    const { file, store, raw, accountId, characterId } = await world();
    const { rooms, socket, p } = atTrader(store, accountId, characterId);
    // Pierce 2 can be a T5 (1 to 2) or a T4 (2) roll; this one dropped as T4. A re-tier by value would make it T5.
    const rune: Item = { ...createRune(95_001, 'bolt'), name: 'Edge Bolt', tier: 'rare', affixes: [{ id: 'rune_pierce', tier: 2, value: 2 }] };
    p.items.set(rune.uid, rune);
    p.inventory[p.inventory.indexOf(null)] = rune.uid;
    const price = buyPrice(rune);
    socket.emit({ t: 'sell', uid: rune.uid });
    rooms.saveAll();
    const row: unknown = raw.prepare("SELECT value FROM settings WHERE key = 'trader'").get();
    const json = typeof row === 'object' && row !== null ? Reflect.get(row, 'value') : undefined;
    expect(typeof json === 'string' && JSON.parse(json).runeTiers).toBe(6);
    for (let restart = 0; restart < 2; restart++) {
      const again = new AccountStore(file);
      const entry = again.loadMarket().stock.find((e) => e.item.name === 'Edge Bolt');
      again.close();
      expect(entry?.item.affixes).toEqual([{ id: 'rune_pierce', tier: 2, value: 2 }]);
      expect(entry?.price).toBe(price);
    }
    raw.close();
  });
});
