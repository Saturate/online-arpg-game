import { BAG, buyPrice, createRolledRune, createRune, createStarterSigil, emptyGrid, emptyStash, isItemShape, neutralImplicit, Rng, sellPrice, starterSigilById, type Item, type RuneItem } from '@rune/shared';
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

/** Items as a save from before implicits holds them: no rune carries one. */
function preImplicit(item: Item): Item {
  const strip = (r: RuneItem): RuneItem => {
    const { implicit: _gone, ...old } = r;
    return old;
  };
  if (item.kind === 'rune') return strip(item);
  if (item.kind === 'sigil') return { ...item, slots: item.slots.map(strip) };
  return item;
}

const runes = (items: readonly Item[]): RuneItem[] => items.flatMap((i) => (i.kind === 'rune' ? [i] : i.kind === 'sigil' ? i.slots : []));

/** A character, its stash and the shelf as the build before implicits wrote them (six tiers, no implicit marker). */
async function oldDatabase() {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-implicits-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('veteran', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Old Hand', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  let uid = 1;
  const fireball = starterSigilById('fireball');
  if (!fireball) throw new Error('fireball');
  const kit = preImplicit(createStarterSigil(() => uid++, fireball, { bound: true }));
  const stack = preImplicit(createRune(uid++, 'fire', 9));
  const rolled = preImplicit(createRolledRune(uid++, new Rng(3), 'rare', 10, 'orb'));
  const inventory = emptyGrid(BAG);
  inventory[0] = stack.uid;
  inventory[1] = rolled.uid;
  const save = {
    classId: 'mage',
    name: 'Old Hand',
    items: [kit, stack, rolled],
    inventory,
    stash: emptyStash(),
    sigils: [kit.uid, null, null, null],
    warband: [null, null, null, null, null],
    gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
    stance: 'defensive',
    waypoints: [],
    level: 4,
    xp: 0,
    gold: 50,
    runeFormat: 2,
    runeTiers: 6,
    worldFormat: 1,
    gates: [],
  };
  const stashRune = preImplicit(createRune(500, 'cold', 3));
  const stashRow = { ...emptyStash(), runeFormat: 2, runeTiers: 6, items: [stashRune], runes: { kind: 'runes', list: [500] } };
  const shelfRow = { nextId: 2, runeFormat: 2, runeTiers: 6, stock: [{ id: 1, price: 12, item: { ...preImplicit(createRune(0, 'nova', 2)), uid: 0 } }] };
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(save), ch.id);
  raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(JSON.stringify(stashRow), acc.id);
  raw.prepare("INSERT INTO settings (key, value) VALUES ('trader', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(shelfRow));
  return { store, raw, accountId: acc.id, characterId: ch.id, before: { character: save.items, stash: stashRow.items, shelf: shelfRow.stock.map((e) => e.item) } };
}

function storedRow(raw: DatabaseSync, sql: string, id: number): string {
  const row: unknown = raw.prepare(sql).get(id);
  const json = isRecord(row) ? Object.values(row)[0] : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  return json;
}

function itemsOf(json: string): Item[] {
  const v: unknown = JSON.parse(json);
  if (!isRecord(v) || !Array.isArray(v.items)) throw new Error('no items');
  return v.items.filter(isItemShape);
}

describe('implicits on the server', () => {
  it('give every rune in old characters, stashes and the shelf the neutral roll on load, and nothing else', async () => {
    const { store, raw, accountId, characterId, before } = await oldDatabase();
    const loaded = store.loadCharacter(accountId, characterId)?.save;
    if (!loaded) throw new Error('no save');
    expect(loaded.runeImplicits).toBe(1);
    const stash = store.loadStash(accountId);
    if (!stash || stash === 'unreadable') throw new Error('no stash');
    expect(stash.stash.runeImplicits).toBe(1);
    const shelf = store.loadMarket();
    for (const [got, was] of [[loaded.items, before.character], [stash.stash.items, before.stash], [shelf.stock.map((e) => e.item), before.shelf]] as const) {
      const now = runes(got);
      expect(now.map((r) => r.uid)).toEqual(runes(was).map((r) => r.uid));
      for (const [i, r] of now.entries()) {
        expect(r.implicit, `${r.rune}`).toEqual(neutralImplicit(r.rune));
        const { implicit: _i, ...rest } = r;
        expect(rest).toEqual(runes(was)[i]);
      }
      // The neutral roll moves no gold.
      expect(got.map(sellPrice)).toEqual(was.map(sellPrice));
    }
    // The shelf prices on load, and the neutral roll leaves the price where it was.
    const onShelf = before.shelf[0];
    expect(onShelf && shelf.stock[0]?.price).toBe(onShelf && buyPrice(onShelf));
    raw.close();
  });

  it('write the marker back, after which a load leaves the row exactly as stored', async () => {
    const { store, raw, accountId, characterId } = await oldDatabase();
    const rooms = new RoomManager(1, store);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    rooms.saveAll();
    const json = storedRow(raw, 'SELECT save_json FROM characters WHERE id = ?', characterId);
    const stashJson = storedRow(raw, 'SELECT stash_json FROM accounts WHERE id = ?', accountId);
    expect(json).toContain('"runeImplicits":1');
    expect(stashJson).toContain('"runeImplicits":1');
    for (const r of runes([...itemsOf(json), ...itemsOf(stashJson)])) expect(r.implicit, r.rune).toBeDefined();
    // A marked save loads as stored, even with an implicit the pass would never have given.
    const save = JSON.parse(json);
    const odd = itemsOf(json).find((i): i is RuneItem => i.kind === 'rune' && i.rune === 'fire');
    if (!odd || !isRecord(save) || !Array.isArray(save.items)) throw new Error('no fire');
    save.items = save.items.map((i: unknown) => (isRecord(i) && i.uid === odd.uid ? { ...i, implicit: { id: 'implicit_conversion', tier: 5, value: 121 } } : i));
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(save), characterId);
    const again = store.loadCharacter(accountId, characterId)?.save;
    const fire = again?.items.find((i): i is RuneItem => i.kind === 'rune' && i.rune === 'fire');
    expect(fire?.implicit).toEqual({ id: 'implicit_conversion', tier: 5, value: 121 });
    rooms.shutdown();
    raw.close();
  });

  it('a grant into an offline save from before implicits writes the save converted and marked, the grant untouched', async () => {
    const { store, raw, accountId, characterId } = await oldDatabase();
    const strong: RuneItem = { ...createRune(0, 'bolt'), implicit: { id: 'implicit_base', tier: 5, value: 124 } };
    const granted = store.grantPendingItem(accountId, characterId, (newUid) => ({ ...strong, uid: newUid() }));
    expect(granted.ok).toBe(true);
    const json = storedRow(raw, 'SELECT save_json FROM characters WHERE id = ?', characterId);
    expect(json).toContain('"runeImplicits":1');
    const items = itemsOf(json);
    expect(runes(items).every((r) => r.implicit !== undefined)).toBe(true);
    expect(items.find((i): i is RuneItem => i.kind === 'rune' && i.rune === 'bolt')?.implicit).toEqual(strong.implicit);
    raw.close();
  });
});
