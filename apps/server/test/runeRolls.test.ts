import { BAG, convertRuneRolls, createSigil, createStarterSigil, emptyGrid, emptyStash, isItemShape, oldStarterRunes, Rng, starterSigilById, toRuneInstance, type Item, type ItemUid, type SigilItem } from '@rune/shared';
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

let uid = 1;
const next = (): ItemUid => uid++;

function oldStarter(id: string, bound: boolean): SigilItem {
  const def = starterSigilById(id);
  const runes = oldStarterRunes(id);
  if (!def || !runes) throw new Error(id);
  // Saves from before 2026-10-01 hold starter rolls at tier 0.
  const s = createStarterSigil(next, { ...def, runes }, { bound });
  return { ...s, slots: s.slots.map((r) => ({ ...r, affixes: r.affixes.map((a) => ({ ...a, tier: 0 })) })) };
}

/** JSON for a rare sigil that rolled "first rune is free" before the affix was retired. */
function primed(seed: number): Record<string, unknown> {
  const s = createSigil(next(), new Rng(seed), 'rare', { ilvl: 10 });
  return { ...s, affixes: [...s.affixes, { id: 'first_rune_free', tier: 3, value: 1 }] };
}

/** A ranger with an old Multishot equipped, an old Flame Cleave in the bag and a primed sigil pending. */
function rangerSave(): Record<string, unknown> {
  const multishot = oldStarter('multishot', true);
  const cleave = oldStarter('flame_cleave', false);
  const pending = primed(1);
  const inventory = emptyGrid(BAG);
  inventory[0] = cleave.uid;
  return {
    classId: 'ranger',
    name: 'Archer',
    items: [multishot, cleave, pending],
    inventory,
    stash: emptyStash(),
    sigils: [multishot.uid, null, null, null],
    warband: [null, null, null, null, null],
    gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
    stance: 'defensive',
    waypoints: [],
    level: 6,
    xp: 0,
    gold: 10,
    runeFormat: 2,
    worldFormat: 1,
    gates: [],
  };
}

function stashRow(): Record<string, unknown> {
  const multishot = oldStarter('multishot', false);
  const p = primed(2);
  const layout = emptyStash();
  return { ...layout, runeFormat: 2, items: [multishot, p], sigils: { kind: 'sigils', list: [multishot.uid, p.uid] } };
}

function shelfRow(): Record<string, unknown> {
  return { nextId: 3, runeFormat: 2, stock: [{ id: 1, price: 10, item: { ...oldStarter('flame_cleave', false), uid: 0 } }, { id: 2, price: 100, item: { ...primed(3), uid: 0 } }] };
}

async function database() {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-rolls-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('veteran', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Archer', 'ranger');
  if (typeof ch === 'string') throw new Error(ch);
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(rangerSave()), ch.id);
  raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(JSON.stringify(stashRow()), acc.id);
  raw.prepare("INSERT INTO settings (key, value) VALUES ('trader', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(shelfRow()));
  return { store, raw, accountId: acc.id, characterId: ch.id };
}

const recipe = (s: SigilItem): string => JSON.stringify(s.slots.map(toRuneInstance));

function newRecipe(id: string): string {
  const def = starterSigilById(id);
  if (!def) throw new Error(id);
  return recipe(createStarterSigil(() => 0, def, { bound: false }));
}

function sigils(items: readonly Item[]): SigilItem[] {
  return items.flatMap((i) => (i.kind === 'sigil' ? [i] : []));
}

/** Every sigil holds a new recipe or no starter at all, and none carries the retired affix. */
function allConverted(items: readonly Item[]): void {
  for (const s of sigils(items)) {
    const ids: string[] = s.affixes.map((a) => a.id);
    expect(ids).not.toContain('first_rune_free');
    if (s.starter) expect(recipe(s), s.starter).toBe(newRecipe(s.starter));
  }
}

function storedItems(raw: DatabaseSync, sql: string, id: number): Item[] {
  const row: unknown = raw.prepare(sql).get(id);
  const json = isRecord(row) ? Object.values(row)[0] : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  const v: unknown = JSON.parse(json);
  if (!isRecord(v) || !Array.isArray(v.items)) throw new Error('no items');
  return v.items.filter(isItemShape);
}

describe('rune roll decisions on the server', () => {
  it('load a shelf whose items carry an affix id the game no longer has', async () => {
    const { store, raw } = await database();
    const smite = starterSigilById('smite');
    if (!smite) throw new Error('smite');
    const odd = { ...createStarterSigil(next, smite, { bound: false }), uid: 0 };
    const rune = { uid: 0, kind: 'rune', tier: 'magic', name: 'Bolt Rune', ilvl: 4, rune: 'bolt', count: 1, affixes: [{ id: 'retired_someday', tier: 2, value: 1 }] };
    const shelf = { nextId: 3, runeFormat: 2, stock: [{ id: 1, price: 10, item: rune }, { id: 2, price: 10, item: { ...odd, slots: odd.slots.map((s) => ({ ...s, affixes: [...s.affixes, { id: 'retired_someday', tier: 0, value: 1 }] })) } }] };
    raw.prepare("INSERT INTO settings (key, value) VALUES ('trader', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(shelf));
    const market = store.loadMarket();
    expect(market.stock.map((e) => e.id)).toEqual([1, 2]);
    expect(market.stock[0]?.item.affixes).toEqual([{ id: 'retired_someday', tier: 2, value: 1 }]);
    raw.close();
  });

  it('convert characters, pending items, stashes and the shelf on load, and write them back converted', async () => {
    const { store, raw, accountId, characterId } = await database();
    const loaded = store.loadCharacter(accountId, characterId)?.save;
    if (!loaded) throw new Error('no save');
    // The bound Multishot's extra Split goes; the unbound Flame Cleave's comes back into the bag.
    expect(loaded.items).toHaveLength(4);
    const back = loaded.items.find((i) => i.kind === 'rune');
    expect(back?.kind === 'rune' && back.rune === 'split' && back.bound !== true).toBe(true);
    expect(back && loaded.inventory.includes(back.uid)).toBe(true);
    allConverted(loaded.items);
    const multishot = loaded.items.find((i) => i.kind === 'sigil' && i.starter === 'multishot');
    expect(multishot?.uid).toBe(loaded.sigils[0]);
    const stash = store.loadStash(accountId);
    if (!stash || stash === 'unreadable') throw new Error('no stash');
    expect(stash.stash.items).toHaveLength(3);
    const stashed0 = stash.stash.items.find((i) => i.kind === 'rune');
    expect(stashed0 && stash.stash.runes.list.includes(stashed0.uid)).toBe(true);
    allConverted(stash.stash.items);
    const shelf = store.loadMarket();
    expect(shelf.stock.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(shelf.stock[2]?.item).toMatchObject({ kind: 'rune', rune: 'split', uid: 0 });
    allConverted(shelf.stock.map((e) => e.item));

    const rooms = new RoomManager(1, store);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    rooms.saveAll();
    // The pending sigil moves to the stash on join, so the seven items are counted across both rows.
    const character = storedItems(raw, 'SELECT save_json FROM characters WHERE id = ?', characterId);
    const stashed = storedItems(raw, 'SELECT stash_json FROM accounts WHERE id = ?', accountId);
    expect(character.length + stashed.length).toBe(7);
    expect([...character, ...stashed].filter((i) => i.kind === 'rune')).toHaveLength(2);
    expect(sigils([...character, ...stashed]).map((s) => s.starter ?? 'none').sort()).toEqual(['flame_cleave', 'multishot', 'multishot', 'none', 'none']);
    allConverted([...character, ...stashed]);

    // A second load finds nothing left to change.
    const again = store.loadCharacter(accountId, characterId)?.save;
    if (!again) throw new Error('no save');
    expect(convertRuneRolls(again.items).report).toEqual({ affixesRemoved: [], renamed: [], startersRebuilt: [], runesRetiered: [] });
    raw.close();
  });
});
