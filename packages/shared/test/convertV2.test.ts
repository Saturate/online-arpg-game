import { describe, expect, it } from 'vitest';
import { convertCharacterSave, convertStash, convertTraderShelf, v1RuneValue } from '../src/items/convertV2.js';
import { BAG, emptyGrid, STASH } from '../src/items/grid.js';
import type { Item, RuneItem, SigilItem } from '../src/items/items.js';
import { starterSigilById } from '../src/data/starterSigils.js';
import { compileSigilItem } from '../src/runes/v2/compile.js';
import { restoreStash } from '../src/sim/inventory.js';
import { Simulation } from '../src/sim/simulation.js';
import { convertStashTabs, emptyStash } from '../src/items/stash.js';
import { inStash } from './helpers/stash.js';

/** v1 items and saves, written the way the v1 server stored them. */
function v1Sigil(uid: number, runes: string[], skill: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid, kind: 'sigil', tier: 'common', name: skill ?? 'Sigil', ilvl: 1, affixes: [], runes, corrupted: false, skill, ...extra };
}

function v1Rune(uid: number, rune: string, count: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid, kind: 'rune', tier: 'common', name: `${rune} Rune`, ilvl: 1, rune, count, affixes: [], ...extra };
}

function v1Gear(uid: number): Record<string, unknown> {
  return { uid, kind: 'gear', tier: 'rare', name: 'Ash Scar Leather Cap', ilvl: 1, base: 'leather_cap', category: 'helmet', affixes: [{ id: 'gear_armor', tier: 0, value: 6 }] };
}

function v1Save(items: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const inventory = emptyGrid(BAG);
  items.forEach((it, i) => {
    const uid = it.uid;
    if (typeof uid === 'number') inventory[i] = uid;
  });
  return {
    classId: 'mage',
    name: 'Old',
    items,
    inventory,
    stash: emptyGrid(STASH),
    sigils: [null, null, null, null],
    warband: [null, null, null, null, null],
    gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
    stance: 'defensive',
    waypoints: ['town'],
    level: 3,
    xp: 10,
    gold: 5,
    ...extra,
  };
}

function everyUid(items: readonly Item[]): number[] {
  return items.flatMap((i) => [i.uid, ...(i.kind === 'sigil' ? i.slots.map((r) => r.uid) : [])]);
}

function sigil(items: readonly Item[], uid: number): SigilItem {
  const s = items.find((i) => i.uid === uid);
  if (s?.kind !== 'sigil') throw new Error(`no sigil ${uid}`);
  return s;
}

function runes(items: readonly Item[]): RuneItem[] {
  return items.filter((i): i is RuneItem => i.kind === 'rune');
}

function cellsOf(grid: readonly (number | null)[]): Set<number> {
  return new Set(grid.filter((u): u is number => u !== null));
}

describe('v1 character conversion', () => {
  it('rebuilds a bound built-in skill sigil as a bound starter sigil under the same uid', () => {
    const { save, report } = convertCharacterSave(v1Save([v1Sigil(7, ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'], 'fireball', { bound: true })], { sigils: [7, null, null, null] }));
    const s = sigil(save.items, 7);
    expect(s.starter).toBe('fireball');
    expect(s.bound).toBe(true);
    expect(s.slots.map((r) => r.rune)).toEqual(starterSigilById('fireball')?.runes.map((r) => r.id));
    expect(s.slots.every((r) => r.bound === true && r.count === 1)).toBe(true);
    expect(save.sigils[0]).toBe(7);
    expect(report.starterSigils).toEqual(['fireball']);
    // The old sigil's own runes are replaced, not refunded: its Linger pays nothing.
    expect(report.runesRefunded).toEqual([]);
    expect(save.gold).toBe(5);
    expect(compileSigilItem(s, 'mage').ok).toBe(true);
  });

  it('keeps a dropped skill sigil unbound, with its tier, name, level, affixes and corruption', () => {
    const raw = v1Sigil(3, ['nova', 'impact', 'large'], 'war_cry', {
      tier: 'rare',
      name: 'Viper Veil',
      ilvl: 4,
      corrupted: true,
      affixes: [
        { id: 'damage_increased', tier: 0, value: 11 },
        { id: 'heat_reduced', tier: 0, value: 10 },
        { id: 'gone_affix', tier: 0, value: 3 },
      ],
    });
    const { save, report } = convertCharacterSave(v1Save([raw]));
    const s = sigil(save.items, 3);
    expect(s).toMatchObject({ starter: 'war_cry', tier: 'rare', name: 'Viper Veil', ilvl: 4, corrupted: true });
    expect(s.bound).toBeUndefined();
    expect(s.slots.some((r) => r.bound === true)).toBe(false);
    expect(s.affixes.map((a) => a.id)).toEqual(['damage_increased', 'heat_reduced']);
    expect(report.warnings.some((w) => w.includes('gone_affix'))).toBe(true);
  });

  it('carries loose runes over one to one, Link as Bond, and pays Linger and Pierce in gold', () => {
    const items = [v1Rune(1, 'link', 2, { bound: true }), v1Rune(2, 'fire', 5), v1Rune(3, 'linger', 3, { tier: 'magic' }), v1Rune(4, 'pierce', 1, { tier: 'magic', bound: true }), v1Gear(5)];
    const { save, report } = convertCharacterSave(v1Save(items));
    const out = runes(save.items);
    expect(out.map((r) => [r.uid, r.rune, r.count, r.bound === true])).toEqual([
      [1, 'bond', 2, true],
      [2, 'fire', 5, false],
    ]);
    expect(out.every((r) => r.affixes.length === 0)).toBe(true);
    const value = v1RuneValue('linger');
    expect(value).toBe(12);
    // A bound rune is paid too: it is being taken away, not sold.
    expect(report.gold).toBe(4 * value);
    expect(save.gold).toBe(5 + 4 * value);
    expect(report.runesRefunded).toEqual([
      { from: 'linger', count: 3, gold: 3 * value },
      { from: 'pierce', count: 1, gold: value },
    ]);
    // Gone from every grid, and the gear is untouched.
    expect(cellsOf(save.inventory)).toEqual(new Set([1, 2, 5]));
    expect(save.items.find((i) => i.uid === 5)).toEqual(v1Gear(5));
  });

  it('keeps a hand-inscribed sigil in order with per-slot binding, and hands back what it cannot hold, to pending when the bag is full', () => {
    const hand = v1Sigil(1, ['bolt', 'fire', 'linger', 'link', 'split', 'onhit'], null, { boundSlots: [true, false, true, false, true, false] });
    // 96 one-cell items fill the bag.
    const filler = Array.from({ length: BAG.w * BAG.h - 1 }, (_, i) => v1Rune(100 + i, 'cold', 20));
    const { save, report } = convertCharacterSave(v1Save([hand, ...filler]));
    const s = sigil(save.items, 1);
    // Common: three slots. Linger is paid out, so bolt, fire and bond stay, split and onhit come back.
    expect(s.slots.map((r) => [r.rune, r.bound === true])).toEqual([
      ['bolt', true],
      ['fire', false],
      ['bond', false],
    ]);
    expect(s.starter).toBeUndefined();
    expect(report.runesReturned).toBe(2);
    expect(report.runesPending).toBe(2);
    expect(report.gold).toBe(12);
    const back = runes(save.items).filter((r) => r.rune !== 'cold');
    expect(back.map((r) => [r.rune, r.bound === true, r.count])).toEqual([
      ['split', true, 1],
      ['onhit', false, 1],
    ]);
    const placed = new Set([...cellsOf(save.inventory), ...save.stash.general.flatMap((t) => [...cellsOf(t.cells)])]);
    for (const r of back) expect(placed.has(r.uid)).toBe(false);
  });

  it('puts returned runes in the bag when there is room, on top of matching stacks', () => {
    const hand = v1Sigil(1, ['bolt', 'fire', 'cold', 'cold', 'cold'], null);
    const { save, report } = convertCharacterSave(v1Save([hand, v1Rune(2, 'cold', 19)]));
    expect(report.runesReturned).toBe(2);
    expect(report.runesPending).toBe(0);
    const cold = runes(save.items).filter((r) => r.rune === 'cold');
    expect(cold.map((r) => r.count).sort()).toEqual([1, 20]);
    for (const r of cold) expect(cellsOf(save.inventory).has(r.uid)).toBe(true);
  });

  it('repacks an old 20-slot bag when runes have to go into it', () => {
    const hand = v1Sigil(1, ['bolt', 'fire', 'cold', 'nova'], null);
    const raw = v1Save([hand, v1Gear(2)], { inventory: [1, 2, ...new Array<null>(18).fill(null)], stash: undefined, gold: undefined, level: undefined, xp: undefined, waypoints: undefined });
    const { save } = convertCharacterSave(raw);
    expect(save.inventory.length).toBe(BAG.w * BAG.h);
    const nova = runes(save.items).find((r) => r.rune === 'nova');
    expect(nova && cellsOf(save.inventory).has(nova.uid)).toBe(true);
    expect(cellsOf(save.inventory).has(1) && cellsOf(save.inventory).has(2)).toBe(true);
    expect(save).toMatchObject({ gold: 0, level: 1, xp: 0, waypoints: [], stash: emptyStash(), runeFormat: 2 });
  });

  it('takes an old Test Sigil apart, its runes kept bound unless a slot says otherwise', () => {
    const test = v1Sigil(9, ['bolt', 'bolt', 'pierce', 'split'], null, { tier: 'relic', name: 'Test Sigil', corrupted: true, affixes: [{ id: 'damage_increased', tier: 0, value: 13 }] });
    const flagged = v1Sigil(10, ['nova', 'nova'], null, { tier: 'relic', name: 'Test Sigil', corrupted: true, boundSlots: [false, true] });
    const empty = v1Sigil(11, [], null, { tier: 'relic', name: 'Test Sigil', corrupted: true });
    const { save, report } = convertCharacterSave(v1Save([test, flagged, empty], { sigils: [9, null, null, 11] }));
    expect(save.items.some((i) => i.kind === 'sigil')).toBe(false);
    expect(save.sigils).toEqual([null, null, null, null]);
    expect(report.testSigilsUnpacked).toBe(3);
    expect(runes(save.items).map((r) => [r.rune, r.count, r.bound === true])).toEqual([
      ['bolt', 2, true],
      ['split', 1, true],
      ['nova', 1, false],
      ['nova', 1, true],
    ]);
    for (const r of runes(save.items)) expect(cellsOf(save.inventory).has(r.uid)).toBe(true);
    for (const u of [9, 10, 11]) expect(cellsOf(save.inventory).has(u)).toBe(false);
    expect(report.gold).toBe(12);
  });

  it('gives every uid exactly one place, fresh ones above everything already there', () => {
    const items = [
      v1Sigil(50, ['bolt', 'cold', 'pulse', 'split'], 'frozen_orb', { bound: true }),
      v1Sigil(51, ['link', 'ward'], 'soul_link'),
      v1Sigil(52, ['bolt', 'fire', 'split', 'onhit', 'nova'], null),
      v1Sigil(53, ['zone', 'zone'], null, { tier: 'relic', name: 'Test Sigil', corrupted: true }),
      v1Rune(54, 'link', 1),
    ];
    const { save } = convertCharacterSave(v1Save(items));
    const uids = everyUid(save.items);
    expect(new Set(uids).size).toBe(uids.length);
    const fresh = uids.filter((u) => u < 50 || u > 54);
    expect(fresh.every((u) => u > 54)).toBe(true);
    // Slot runes live only inside their sigil.
    const top = new Set(save.items.map((i) => i.uid));
    for (const s of save.items) if (s.kind === 'sigil') for (const r of s.slots) expect(top.has(r.uid)).toBe(false);
  });

  it('returns a save already marked runeFormat 2 unchanged, and converts the same v1 save the same way twice', () => {
    const raw = v1Save([v1Sigil(1, ['aura', 'ward'], 'iron_skin', { bound: true }), v1Rune(2, 'linger', 1)]);
    const first = convertCharacterSave(raw);
    const again = convertCharacterSave(first.save);
    expect(again.save).toEqual(first.save);
    expect(again.report.gold).toBe(0);
    expect(again.report.starterSigils).toEqual([]);
    expect(convertCharacterSave(JSON.parse(JSON.stringify(raw))).save).toEqual(first.save);
  });

  it('refuses data it cannot read instead of guessing', () => {
    expect(() => convertCharacterSave(v1Save([v1Rune(1, 'mystery', 1)]))).toThrow(/mystery/);
    expect(() => convertCharacterSave(v1Save([v1Sigil(1, ['bolt', 'nope'], null)]))).toThrow(/nope/);
    expect(() => convertCharacterSave({ ...v1Save([]), classId: 'bard' })).toThrow(/class/);
    expect(() => convertCharacterSave(null)).toThrow();
  });

  it('loads into a simulation with working starter sigils and the refund in gold', () => {
    const items = [v1Sigil(1, ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'], 'fireball', { bound: true }), v1Rune(2, 'linger', 2, { tier: 'magic' })];
    const { save } = convertCharacterSave(v1Save(items, { sigils: [1, null, null, null] }));
    const sim = new Simulation(4);
    const pid = sim.addPlayer('a', 'mage', 'Old', { ...save, worldFormat: 1, runeTiers: 6 });
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    expect(p.gold).toBe(5 + 24);
    expect(p.sigils[0]?.compiled.ok).toBe(true);
  });
});

describe('v1 stash conversion', () => {
  it('converts loose runes in place, pays refunds as gold owed, and never puts bound runes in the stash grid', () => {
    const cells = emptyGrid(STASH);
    cells[0] = 1;
    cells[1] = 2;
    cells[2] = 3;
    cells[3] = 4;
    const raw = {
      items: [v1Rune(1, 'link', 4), v1Rune(2, 'pierce', 2, { tier: 'magic' }), v1Sigil(3, ['cold', 'restore'], null, { tier: 'relic', name: 'Test Sigil', corrupted: true, boundSlots: [false, true] }), v1Gear(4)],
      cells,
    };
    const { stash, report } = convertStash(raw);
    expect(stash.runeFormat).toBe(2);
    expect(report.gold).toBe(24);
    expect(stash.items.some((i) => i.uid === 2 || i.uid === 3)).toBe(false);
    const inGrid = cellsOf(stash.cells);
    const out = runes(stash.items);
    expect(out.map((r) => [r.rune, r.count, r.bound === true, inGrid.has(r.uid)])).toEqual([
      ['bond', 4, false, true],
      ['cold', 1, false, true],
      ['restore', 1, true, false],
    ]);
    const uids = everyUid(stash.items);
    expect(new Set(uids).size).toBe(uids.length);
    expect(convertStash(stash).stash).toBe(stash);
  });

  it('hands a bound rune from the stash to the joining character, never back into the stash', () => {
    const raw = { items: [v1Sigil(3, ['restore'], null, { tier: 'relic', name: 'Test Sigil', corrupted: true })], cells: [3, ...new Array<null>(STASH.w * STASH.h - 1).fill(null)] };
    const { stash } = convertStash(raw);
    const sim = new Simulation(5);
    const pid = sim.addPlayer('a', 'mage');
    restoreStash(sim, pid, { ...convertStashTabs(stash).stash, runeTiers: 6 });
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    const restore = [...p.items.values()].find((i) => i.kind === 'rune' && i.rune === 'restore');
    expect(restore?.bound).toBe(true);
    expect(restore && inStash(p, restore.uid)).toBe(false);
    expect(restore && p.inventory.includes(restore.uid)).toBe(true);
  });
});

describe('v1 trader shelf conversion', () => {
  it('converts shelf items, drops refunded runes without paying anyone, and lists returned runes as new entries', () => {
    const raw = {
      nextId: 5,
      stock: [
        { id: 1, item: { ...v1Sigil(0, ['bolt', 'lightning', 'pierce'], 'smite'), tier: 'magic' }, price: 36 },
        { id: 2, item: v1Rune(0, 'link', 3), price: 36 },
        { id: 3, item: v1Rune(0, 'linger', 1, { tier: 'magic' }), price: 36 },
        { id: 4, item: v1Sigil(0, ['bolt', 'fire', 'split', 'nova', 'zone'], null), price: 12 },
        { id: 6, item: v1Gear(0), price: 120 },
      ],
    };
    const { shelf, report } = convertTraderShelf(raw);
    expect(shelf.runeFormat).toBe(2);
    expect(report.gold).toBe(0);
    expect(report.runesRefunded).toEqual([{ from: 'linger', count: 1, gold: 0 }]);
    expect(shelf.stock.map((e) => e.id)).toEqual([1, 2, 4, 6, 7, 8]);
    expect(shelf.nextId).toBe(9);
    const smite = shelf.stock[0]?.item;
    expect(smite?.kind === 'sigil' && smite.starter).toBe('smite');
    expect(smite?.bound).toBeUndefined();
    const extra = shelf.stock.slice(4).map((e) => e.item);
    expect(extra.map((i) => (i.kind === 'rune' ? [i.rune, i.count, i.uid] : null))).toEqual([
      ['nova', 1, 0],
      ['zone', 1, 0],
    ]);
    // Shelf items carry uid 0; the runes inside sigils still need their own.
    const slotUids = shelf.stock.flatMap((e) => (e.item.kind === 'sigil' ? e.item.slots.map((r) => r.uid) : []));
    expect(new Set(slotUids).size).toBe(slotUids.length);
    expect(convertTraderShelf(shelf).shelf).toBe(shelf);
  });
});
