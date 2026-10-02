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

function storedItems(raw: DatabaseSync, id: number): Item[] {
  const row: unknown = raw.prepare('SELECT save_json FROM characters WHERE id = ?').get(id);
  const json = isRecord(row) ? Object.values(row)[0] : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  const v: unknown = JSON.parse(json);
  if (!isRecord(v) || !Array.isArray(v.items)) throw new Error('no items');
  return v.items.filter(isItemShape);
}

function adds(rune: 'bolt' | 'nova', id: 'rune_added_fire' | 'rune_added_cold', value: number, tier: number): RuneItem {
  return { ...createRune(next(), rune), tier: 'magic', ilvl: 9, name: 'Smouldering Rune', affixes: [{ id, tier, value }] };
}

/** Every rune in the items with its rolls, in a stable order, to compare a save before and after. */
const runeRolls = (items: readonly Item[]): string[] =>
  items
    .flatMap((i) => (i.kind === 'sigil' ? i.slots : i.kind === 'rune' ? [i] : []))
    .map((r) => `${r.rune}:${r.affixes.map((a) => `${a.id}=${a.value}@${a.tier}`).join(',')}`)
    .sort();

describe('saves and damage packets', () => {
  it('old runes and runes with added damage load, cast and save back unchanged', async () => {
    const plainOld: RuneItem = { ...createRune(next(), 'orb'), tier: 'magic', ilvl: 4, name: 'Honed Orb Rune', affixes: [{ id: 'rune_damage', tier: 2, value: 30 }] };
    const bagAdds = adds('bolt', 'rune_added_fire', 4, 3);
    const sigil: SigilItem = { ...createSigil(next(), new Rng(4), 'magic', { ilvl: 5 }), slots: [adds('nova', 'rune_added_cold', 7, 5), createRune(next(), 'fire')] };
    const inventory = emptyGrid(BAG);
    inventory[0] = bagAdds.uid;
    inventory[1] = sigil.uid;
    inventory[2] = plainOld.uid;
    const save = {
      classId: 'mage',
      name: 'Packets',
      items: [bagAdds, sigil, plainOld],
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
      runeTiers: 6,
      worldFormat: 1,
      gates: [],
    };
    const before = runeRolls(save.items);

    const file = join(mkdtempSync(join(tmpdir(), 'added-rune-')), 'rune.db');
    const store = new AccountStore(file);
    const acc = await store.register('packets', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, 'Packets', 'mage');
    if (typeof ch === 'string') throw new Error(ch);
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(save), ch.id);

    const loaded = store.loadCharacter(acc.id, ch.id)?.save;
    if (!loaded) throw new Error('no save');
    expect(runeRolls(loaded.items)).toEqual(before);
    const equipped = loaded.items.find((i) => i.uid === loaded.sigils[0]);
    if (equipped?.kind !== 'sigil') throw new Error('no sigil');
    const c = compileSigilItem(equipped, 'mage');
    expect(c.ok && c.program.roots[0]?.added.cold).toEqual({ min: 7, max: 14 });

    const rooms = new RoomManager(1, store);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    rooms.saveAll();
    expect(runeRolls(storedItems(raw, ch.id))).toEqual(before);
    raw.close();
  });
});
