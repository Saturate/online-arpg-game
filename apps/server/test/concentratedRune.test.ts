import { BAG, compileSigilItem, createRune, createSigil, emptyGrid, emptyStash, isItemShape, Rng, type Item, type ItemUid, type RuneItem, type SigilItem } from '@rune/shared';
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

function concentrated(value: number, tier: number): RuneItem {
  return { ...createRune(next(), 'concentrated'), tier: 'rare', ilvl: 8, name: 'Dense Concentrated Rune', affixes: [{ id: 'rune_concentrated', tier, value }] };
}

function storedItems(raw: DatabaseSync, sql: string, id: number): Item[] {
  const row: unknown = raw.prepare(sql).get(id);
  const json = isRecord(row) ? Object.values(row)[0] : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  const v: unknown = JSON.parse(json);
  if (!isRecord(v) || !Array.isArray(v.items)) throw new Error('no items');
  return v.items.filter(isItemShape);
}

const concRolls = (items: readonly Item[]): number[] =>
  items
    .flatMap((i) => (i.kind === 'sigil' ? i.slots : i.kind === 'rune' ? [i] : []))
    .filter((r) => r.rune === 'concentrated')
    .map((r) => r.affixes[0]?.value ?? 0)
    .sort((a, b) => a - b);

describe('Concentrated runes in saves', () => {
  it('load from the character save, the bag, an equipped sigil and the stash rune tab, and save back unchanged', async () => {
    const bagRune = concentrated(44, 0);
    const sigil: SigilItem = { ...createSigil(next(), new Rng(4), 'magic', { ilvl: 5 }), slots: [createRune(next(), 'nova'), concentrated(58, 2)] };
    const stashed = concentrated(51, 1);
    const inventory = emptyGrid(BAG);
    inventory[0] = bagRune.uid;
    inventory[1] = sigil.uid;
    const save = {
      classId: 'mage',
      name: 'Focus',
      items: [bagRune, sigil],
      inventory,
      stash: emptyStash(),
      sigils: [sigil.uid, null, null, null],
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
    const layout = emptyStash();
    const stashRow = { ...layout, runeFormat: 2, items: [stashed], runes: { kind: 'runes', list: [stashed.uid] } };

    const file = join(mkdtempSync(join(tmpdir(), 'conc-rune-')), 'rune.db');
    const store = new AccountStore(file);
    const acc = await store.register('focused', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, 'Focus', 'mage');
    if (typeof ch === 'string') throw new Error(ch);
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(save), ch.id);
    raw.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(JSON.stringify(stashRow), acc.id);

    const loaded = store.loadCharacter(acc.id, ch.id)?.save;
    if (!loaded) throw new Error('no save');
    expect(concRolls(loaded.items)).toEqual([44, 58]);
    const equipped = loaded.items.find((i) => i.uid === loaded.sigils[0]);
    if (equipped?.kind !== 'sigil') throw new Error('no sigil');
    const c = compileSigilItem(equipped, 'mage');
    expect(c.ok && c.tree.roots[0]?.stats.concentration).toBe(58);
    const stash = store.loadStash(acc.id);
    if (!stash || stash === 'unreadable') throw new Error('no stash');
    expect(concRolls(stash.stash.items)).toEqual([51]);
    expect(stash.stash.runes.list).toHaveLength(1);

    const rooms = new RoomManager(1, store);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    rooms.saveAll();
    expect(concRolls(storedItems(raw, 'SELECT save_json FROM characters WHERE id = ?', ch.id))).toEqual([44, 58]);
    expect(concRolls(storedItems(raw, 'SELECT stash_json FROM accounts WHERE id = ?', acc.id))).toEqual([51]);
    raw.close();
  });
});
