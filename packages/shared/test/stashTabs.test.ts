import { describe, expect, it } from 'vitest';
import { addItem } from '../src/sim/inventory.js';
import {
  anchorOf,
  convertStashTabs,
  createGear,
  createRolledRune,
  createRune,
  createSigil,
  emptyGrid,
  emptyStash,
  findSpot,
  itemSize,
  parseClientMessage,
  pendingItems,
  place,
  restoreStash,
  Simulation,
  splitStash,
  STASH,
  STASH_TABS,
  stashItemUids,
  stashTabPrice,
  type Item,
  type ItemUid,
  type PlayerComp,
  type StashSave,
} from '../src/index.js';
import { inStash, stashOf, tab1 } from './helpers/stash.js';

function town(seed = 4) {
  const sim = new Simulation(seed, { kind: 'world', seed: 3 });
  const pid = sim.addPlayer('c', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const at = sim.mapDef.stash;
  if (!p || !pos || !at) throw new Error('setup');
  pos.x = at.x + 50;
  pos.y = at.y;
  return { sim, pid, p, pos, at };
}

function ring(sim: Simulation): Item {
  return createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
}

function state(p: PlayerComp): string {
  return JSON.stringify({ items: [...p.items.values()].sort((a, b) => a.uid - b.uid), bag: p.inventory, stash: p.stash, gold: p.gold });
}

describe('stash tab moves', () => {
  it('moves between the bag and general tabs, keeps a tab of its own per id, and refuses away from the chest', () => {
    const { sim, pid, p, pos, at } = town();
    p.gold = 1000;
    expect(sim.buyStashTab(pid)).toBeNull();
    const r = ring(sim);
    addItem(p, r);
    expect(sim.moveItem(pid, r.uid, { at: 'tab', tab: 2, x: 4, y: 5 })).toBeNull();
    const second = p.stash.general[1];
    if (!second) throw new Error('no second tab');
    expect(anchorOf(second.cells, STASH, r.uid)).toEqual({ x: 4, y: 5 });
    expect(sim.moveItem(pid, r.uid, { at: 'tab', tab: 1, x: 0, y: 0 })).toBeNull();
    expect(second.cells.includes(r.uid)).toBe(false);
    expect(anchorOf(tab1(p), STASH, r.uid)).toEqual({ x: 0, y: 0 });
    expect(sim.moveItem(pid, r.uid, { at: 'tab', tab: 7, x: 0, y: 0 })).toBe('No such stash tab');
    pos.x = at.x + 2000;
    const before = state(p);
    expect(sim.moveItem(pid, r.uid, { at: 'bag', x: 0, y: 0 })).toBe('Stand at the stash to use it');
    expect(sim.quickMove(pid, r.uid, null)).toBe('Stand at the stash to use it');
    expect(sim.buyStashTab(pid)).toBe('Stand at the stash to use it');
    expect(state(p)).toBe(before);
  });

  it('keeps bound items and sigils holding bound runes out of every tab', () => {
    const { sim, pid, p } = town();
    const bound = ring(sim);
    bound.bound = true;
    addItem(p, bound);
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'rare');
    const br = createRune(sim.newItemUid(), 'fire', 1);
    br.bound = true;
    sigil.slots = [br];
    addItem(p, sigil);
    const plainBound = createRune(sim.newItemUid(), 'bolt', 4);
    plainBound.bound = true;
    addItem(p, plainBound);
    const before = state(p);
    expect(sim.moveItem(pid, bound.uid, { at: 'tab', tab: 1, x: 0, y: 0 })).toBe('Bound items stay with this character');
    expect(sim.quickMove(pid, bound.uid, 1)).toBe('Bound items stay with this character');
    expect(sim.moveItem(pid, sigil.uid, { at: 'sigils' })).toBe('Take the bound runes out first');
    expect(sim.quickMove(pid, sigil.uid, null)).toBe('Take the bound runes out first');
    expect(sim.moveItem(pid, plainBound.uid, { at: 'runes' })).toBe('Bound items stay with this character');
    expect(state(p)).toBe(before);
  });

  it('lists plain stacks in the rune tab, topping up its stacks first, and splits them on the way out', () => {
    const { sim, pid, p } = town();
    const bolts = createRune(sim.newItemUid(), 'bolt', 17);
    addItem(p, bolts);
    expect(sim.moveItem(pid, bolts.uid, { at: 'runes' })).toBeNull();
    expect(p.stash.runes.list).toEqual([bolts.uid]);
    // Five more: three top up the listed stack to 20, two take a row of their own.
    const more = createRune(sim.newItemUid(), 'bolt', 5);
    addItem(p, more);
    expect(sim.quickMove(pid, more.uid, null)).toBeNull();
    expect(bolts.count).toBe(20);
    expect(more.count).toBe(2);
    expect(p.stash.runes.list).toEqual([bolts.uid, more.uid]);
    // Part of a stack out: into the bag, or onto a cell; the rest stays listed.
    expect(sim.takeRunes(pid, bolts.uid, 21, null)).toBe('That stack holds 20');
    expect(sim.takeRunes(pid, bolts.uid, 6, null)).toBeNull();
    expect(bolts.count).toBe(14);
    const out = [...p.items.values()].find((i) => i.kind === 'rune' && i.rune === 'bolt' && p.inventory.includes(i.uid));
    expect(out?.kind === 'rune' && out.count).toBe(6);
    expect(sim.takeRunes(pid, bolts.uid, 4, { at: 'tab', tab: 1, x: 2, y: 2 })).toBeNull();
    const cell = tab1(p)[2 * STASH.w + 2];
    const onCell = cell === null || cell === undefined ? undefined : p.items.get(cell);
    expect(onCell?.kind === 'rune' && onCell.count).toBe(4);
    // The whole stack is a plain move, which keeps its uid.
    expect(sim.takeRunes(pid, more.uid, 2, { at: 'bag', x: 11, y: 7 })).toBeNull();
    expect(p.inventory[7 * 12 + 11]).toBe(more.uid);
  });

  it('refuses a split that does not fit in the bag, leaving the stack alone', () => {
    const { sim, pid, p } = town();
    const fire = createRune(sim.newItemUid(), 'fire', 20);
    p.items.set(fire.uid, fire);
    p.stash.runes.list.push(fire.uid);
    while (addItem(p, ring(sim)));
    const before = state(p);
    expect(sim.takeRunes(pid, fire.uid, 10, null)).toBe('No room in your bag');
    expect(sim.takeRunes(pid, fire.uid, 10, { at: 'bag', x: 0, y: 0 })).toBe('No room there');
    const r = ring(sim);
    p.items.set(r.uid, r);
    tab1(p)[0] = r.uid;
    expect(sim.takeRunes(pid, r.uid, 1, null)).toBe('Only plain rune stacks can be split');
    tab1(p)[0] = null;
    p.items.delete(r.uid);
    expect(state(p)).toBe(before);
  });

  it('lists rolled runes and sigils in their tabs up to the caps', () => {
    const { sim, pid, p } = town();
    const rolled = createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 5, 'orb');
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'magic');
    addItem(p, rolled);
    addItem(p, sigil);
    expect(sim.moveItem(pid, rolled.uid, { at: 'sigils' })).toBe('Only sigils go in the sigil tab');
    expect(sim.moveItem(pid, sigil.uid, { at: 'runes' })).toBe('Only runes go in the rune tab');
    expect(sim.quickMove(pid, rolled.uid, null)).toBeNull();
    expect(sim.quickMove(pid, sigil.uid, null)).toBeNull();
    expect(p.stash.runes.list).toEqual([rolled.uid]);
    expect(p.stash.sigils.list).toEqual([sigil.uid]);
    // Back out with a ctrl+click, and between a list and a general tab by drag.
    expect(sim.quickMove(pid, sigil.uid, null)).toBeNull();
    expect(p.inventory.includes(sigil.uid)).toBe(true);
    expect(sim.moveItem(pid, rolled.uid, { at: 'tab', tab: 1, x: 0, y: 0 })).toBeNull();
    expect(p.stash.runes.list).toEqual([]);
    expect(sim.moveItem(pid, rolled.uid, { at: 'runes' })).toBeNull();
    // A full rune tab refuses a new row, but a plain stack that fits in its stacks still goes in.
    const listed = createRune(sim.newItemUid(), 'cold', 10);
    p.items.set(listed.uid, listed);
    p.stash.runes.list.push(listed.uid);
    for (let i = p.stash.runes.list.length; i < STASH_TABS.runeCap; i++) p.stash.runes.list.push(800_000 + i);
    const cold = createRune(sim.newItemUid(), 'cold', 10);
    const nova = createRune(sim.newItemUid(), 'nova', 1);
    addItem(p, cold);
    addItem(p, nova);
    const full = state(p);
    expect(sim.quickMove(pid, nova.uid, null)).toBe(`The rune tab holds ${STASH_TABS.runeCap} runes`);
    expect(state(p)).toBe(full);
    expect(sim.quickMove(pid, cold.uid, null)).toBeNull();
    expect(listed.count).toBe(20);
    expect(p.items.has(cold.uid)).toBe(false);
    // Full lists refuse.
    p.stash.sigils.list = Array.from({ length: STASH_TABS.sigilCap }, (_, i) => 900_000 + i);
    const before = state(p);
    expect(sim.quickMove(pid, sigil.uid, null)).toBe(`The sigil tab holds ${STASH_TABS.sigilCap} sigils`);
    expect(state(p)).toBe(before);
  });

  it('sends everything else to the open general tab, else the first with room', () => {
    const { sim, pid, p } = town();
    p.gold = 1000;
    sim.buyStashTab(pid);
    const a = ring(sim);
    const b = ring(sim);
    addItem(p, a);
    addItem(p, b);
    expect(sim.quickMove(pid, a.uid, 2)).toBeNull();
    expect(p.stash.general[1]?.cells.includes(a.uid)).toBe(true);
    // Tab 2 full: the next one goes to the first general tab with room.
    const second = p.stash.general[1];
    if (!second) throw new Error('no tab');
    second.cells = second.cells.map((c) => c ?? 999_999);
    expect(sim.quickMove(pid, b.uid, 2)).toBeNull();
    expect(tab1(p).includes(b.uid)).toBe(true);
  });

  it('a plain stack ctrl+clicked out of a general tab tops up bag stacks', () => {
    const { sim, pid, p } = town();
    const inBag = createRune(sim.newItemUid(), 'onhit', 12);
    addItem(p, inBag);
    const stashed = createRune(sim.newItemUid(), 'onhit', 6);
    p.items.set(stashed.uid, stashed);
    tab1(p)[0] = stashed.uid;
    expect(sim.quickMove(pid, stashed.uid, null)).toBeNull();
    expect(inBag.count).toBe(18);
    expect(p.items.has(stashed.uid)).toBe(false);
    expect(pendingItems(p)).toEqual([]);
  });

  it('sorts the rune tab by rune, kind, tier, item level and an affix value', () => {
    const { sim, pid, p } = town();
    const plainFire = createRune(sim.newItemUid(), 'fire', 3);
    const orb = createRolledRune(sim.newItemUid(), sim.rand.loot, 'magic', 2, 'orb');
    const bolt = createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 7, 'bolt');
    bolt.affixes = [{ id: 'rune_damage', tier: 1, value: 40 }];
    orb.affixes = [{ id: 'rune_damage', tier: 0, value: 20 }];
    for (const it of [plainFire, orb, bolt]) {
      p.items.set(it.uid, it);
      p.stash.runes.list.push(it.uid);
    }
    expect(sim.sortStash(pid, 'runes', 'rune', null)).toBeNull();
    expect(p.stash.runes.list).toEqual([orb.uid, bolt.uid, plainFire.uid]);
    expect(sim.sortStash(pid, 'runes', 'kind', null)).toBeNull();
    expect(p.stash.runes.list).toEqual([orb.uid, bolt.uid, plainFire.uid]);
    expect(sim.sortStash(pid, 'runes', 'ilvl', null)).toBeNull();
    expect(p.stash.runes.list[0]).toBe(bolt.uid);
    expect(sim.sortStash(pid, 'runes', 'affix', 'rune_damage')).toBeNull();
    expect(p.stash.runes.list).toEqual([bolt.uid, orb.uid, plainFire.uid]);
    expect(sim.sortStash(pid, 'runes', 'affix', null)).toBe('Pick a rune affix to sort by');
    expect(sim.sortStash(pid, 'runes', 'slots', null)).toBe('Sort runes by rune, kind, tier, item level or an affix');
  });

  it('sorts a general tab like the bag and the lists by the chosen key', () => {
    const { sim, pid, p } = town();
    const low = createSigil(sim.newItemUid(), sim.rand.loot, 'common', { ilvl: 9 });
    const high = createSigil(sim.newItemUid(), sim.rand.loot, 'relic', { ilvl: 2 });
    p.items.set(low.uid, low);
    p.items.set(high.uid, high);
    p.stash.sigils.list = [low.uid, high.uid];
    expect(sim.sortStash(pid, 'sigils', 'tier', null)).toBeNull();
    expect(p.stash.sigils.list).toEqual([high.uid, low.uid]);
    expect(sim.sortStash(pid, 'sigils', 'ilvl', null)).toBeNull();
    expect(p.stash.sigils.list).toEqual([low.uid, high.uid]);
    expect(sim.sortStash(pid, 'sigils', 'rune', null)).toBe('Sort sigils by tier, item level, slots or name');
    const r = ring(sim);
    p.items.set(r.uid, r);
    tab1(p)[STASH.w * 9 + 11] = r.uid;
    expect(sim.sortStash(pid, 1, null, null)).toBeNull();
    expect(tab1(p)[0]).toBe(r.uid);
  });
});

describe('buying stash tabs', () => {
  it('costs 250 more for each tab, needs the gold, and stops at ten general tabs', () => {
    const { sim, pid, p } = town();
    expect(stashTabPrice(1)).toBe(250);
    expect(stashTabPrice(2)).toBe(500);
    expect(stashTabPrice(9)).toBe(2250);
    expect(stashTabPrice(10)).toBeNull();
    p.gold = 249;
    expect(sim.buyStashTab(pid)).toBe('A new stash tab costs 250 gold');
    expect(p.gold).toBe(249);
    expect(p.stash.general).toHaveLength(1);
    p.gold = 250 * 45;
    for (let n = 1; n < STASH_TABS.maxGeneral; n++) expect(sim.buyStashTab(pid)).toBeNull();
    expect(p.gold).toBe(0);
    expect(p.stash.general.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    p.gold = 1_000_000;
    expect(sim.buyStashTab(pid)).toBe('You own all 10 stash tabs');
    expect(p.gold).toBe(1_000_000);
  });

  it('renames and recolours general tabs, checked on the server', () => {
    const { sim, pid, p } = town();
    expect(sim.editStashTab(pid, 1, 'Rings & Amulets', 'rust')).toBeNull();
    expect(p.stash.general[0]).toMatchObject({ name: 'Rings & Amulets', color: 'rust' });
    expect(sim.editStashTab(pid, 1, '<b>x</b>', 'rust')).toMatch(/^Tab names are/);
    expect(sim.editStashTab(pid, 1, 'x'.repeat(17), 'rust')).toMatch(/^Tab names are/);
    expect(sim.editStashTab(pid, 1, ' padded', 'rust')).toMatch(/^Tab names are/);
    expect(sim.editStashTab(pid, 2, 'Nope', 'rust')).toBe('No such stash tab');
    expect(p.stash.general[0]).toMatchObject({ name: 'Rings & Amulets', color: 'rust' });
  });
});

describe('forge draws from the rune tab', () => {
  it('takes plain runes from the bag first, then the rune tab, then general tab stacks', () => {
    const { sim, pid, p, pos } = town();
    const forge = sim.mapDef.forge;
    if (!forge) throw new Error('no forge');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    p.gold = 1000;
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'relic');
    sigil.slots = [];
    addItem(p, sigil);
    addItem(p, createRune(sim.newItemUid(), 'fire', 1));
    const listed = createRune(sim.newItemUid(), 'fire', 2);
    p.items.set(listed.uid, listed);
    p.stash.runes.list.push(listed.uid);
    const inTab = createRune(sim.newItemUid(), 'fire', 3);
    p.items.set(inTab.uid, inTab);
    tab1(p)[5] = inTab.uid;
    const fire = { from: 'plain', rune: 'fire' } as const;
    expect(sim.inscribe(pid, sigil.uid, [fire, fire, fire, fire], false, [])).toBeNull();
    expect(p.stash.runes.list).toEqual([]);
    expect(p.items.has(listed.uid)).toBe(false);
    expect(inTab.count).toBe(2);
    expect(sigil.slots).toHaveLength(4);
  });

  it('takes a rolled rune from the rune tab list or a general tab, and refuses a sigil in any tab', () => {
    const { sim, pid, p, pos } = town();
    const forge = sim.mapDef.forge;
    if (!forge) throw new Error('no forge');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    p.gold = 1000;
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'relic');
    sigil.slots = [];
    addItem(p, sigil);
    const a = createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 5, 'bolt');
    const b = createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 5, 'orb');
    p.items.set(a.uid, a);
    p.items.set(b.uid, b);
    p.stash.runes.list.push(a.uid);
    tab1(p)[0] = b.uid;
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: a.uid }, { from: 'rolled', uid: b.uid }], false, [])).toBeNull();
    expect(p.stash.runes.list).toEqual([]);
    expect(inStash(p, b.uid)).toBe(false);
    const listed = createSigil(sim.newItemUid(), sim.rand.loot, 'rare');
    p.items.set(listed.uid, listed);
    p.stash.sigils.list.push(listed.uid);
    expect(sim.inscribe(pid, listed.uid, [{ from: 'plain', rune: 'fire' }])).toBe('Take the sigil out of the stash first');
  });
});

describe('loading the stash', () => {
  it('sends pending unbound items to their tabs on load: runes and sigils to theirs, the rest to general tabs', () => {
    const { sim, pid, p } = town();
    const plain = createRune(sim.newItemUid(), 'nova', 7);
    const rolled = createRolledRune(sim.newItemUid(), sim.rand.loot, 'magic', 3, 'bolt');
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'common');
    const gear = ring(sim);
    const bound = ring(sim);
    bound.bound = true;
    for (const it of [plain, rolled, sigil, gear, bound]) p.items.set(it.uid, it);
    while (addItem(p, ring(sim)));
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const { character, stash } = splitStash(save);
    const sim2 = new Simulation(5, { kind: 'world', seed: 3 });
    const pid2 = sim2.addPlayer('c', 'mage', 'Again', character);
    restoreStash(sim2, pid2, stash);
    const p2 = sim2.world.player.get(pid2);
    if (!p2) throw new Error('no player');
    const listed = p2.stash.runes.list.map((u) => p2.items.get(u));
    expect(listed.map((i) => (i?.kind === 'rune' ? [i.rune, i.count] : null)).sort()).toEqual([['bolt', 1], ['nova', 7]]);
    expect(p2.stash.sigils.list).toHaveLength(1);
    const stashed = stashItemUids(p2.stash).map((u) => p2.items.get(u));
    expect(stashed.filter((i) => i?.kind === 'gear')).toHaveLength(1);
    // The bound ring found the bag full, so it waits with the character, never in the stash.
    const waiting = pendingItems(p2).map((u) => p2.items.get(u));
    expect(waiting.map((i) => i?.bound)).toEqual([true]);
  });

  it('keeps items past a list cap as pending, never dropped', () => {
    const { sim, pid, p } = town();
    const sigils = Array.from({ length: STASH_TABS.sigilCap + 3 }, () => createSigil(sim.newItemUid(), sim.rand.loot, 'common'));
    const stored: StashSave = { ...emptyStash(), runeFormat: 2, items: sigils };
    stored.sigils.list = sigils.map((s) => s.uid);
    // Tab 1 full, so the three past the cap cannot go there either.
    const filler = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    stored.items.push(filler);
    const first = stored.general[0];
    if (!first) throw new Error('no tab');
    first.cells = first.cells.map(() => filler.uid);
    restoreStash(sim, pid, stored);
    expect(p.stash.sigils.list).toHaveLength(STASH_TABS.sigilCap);
    const owned = [...p.items.values()].filter((i) => i.kind === 'sigil' && i.slots.length === 0).length;
    expect(owned).toBeGreaterThanOrEqual(STASH_TABS.sigilCap + 3);
  });
});

describe('converting a single-grid stash to tabs', () => {
  function v1Stash(): { raw: { items: Item[]; cells: (ItemUid | null)[]; runeFormat: 2 }; items: Item[] } {
    const sim = new Simulation(3);
    const items: Item[] = [];
    const cells = emptyGrid(STASH);
    const put = (item: Item, x: number, y: number): void => {
      items.push(item);
      place(cells, STASH, item.uid, itemSize(item), x, y);
    };
    put(createGear(sim.newItemUid(), sim.rand.loot, 'rare', 4, { category: 'body' }), 0, 0);
    put(createRune(sim.newItemUid(), 'fire', 20), 5, 5);
    put(createRune(sim.newItemUid(), 'fire', 7), 6, 5);
    put(createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 4, 'orb'), 7, 7);
    put(createSigil(sim.newItemUid(), sim.rand.loot, 'magic'), 11, 9);
    // Non-castable plain rune: the rune tab has no slot for it, so it stays.
    put(createRune(sim.newItemUid(), 'beam', 2), 3, 0);
    return { raw: { items, cells, runeFormat: 2 }, items };
  }

  it('keeps tab 1 positions, moves runes and sigils to their tabs, and is idempotent', () => {
    const { raw, items } = v1Stash();
    const { stash, report } = convertStashTabs(raw);
    const tab = stash.general[0];
    if (!tab) throw new Error('no tab');
    const gear = items[0];
    const beam = items[5];
    if (!gear || !beam) throw new Error('setup');
    expect(anchorOf(tab.cells, STASH, gear.uid)).toEqual({ x: 0, y: 0 });
    // Every rune item moves, the uncastable Beam stack too: nothing merges, so uids stay.
    expect(stash.runes.list).toEqual([items[1]?.uid, items[2]?.uid, items[3]?.uid, items[5]?.uid]);
    expect(stash.sigils.list).toEqual([items[4]?.uid]);
    expect(anchorOf(tab.cells, STASH, beam.uid)).toBeNull();
    expect(report).toMatchObject({ runesToTab: 4, runeUnitsToTab: 20 + 7 + 1 + 2, sigilsToTab: 1, stayed: [] });
    const uids = stashItemUids(stash);
    expect(new Set(uids).size).toBe(uids.length);
    expect(stash.items.map((i) => i.uid).sort()).toEqual(uids.sort());
    expect(stash.items).toEqual(items);
    const again = convertStashTabs(JSON.parse(JSON.stringify(stash)));
    expect(again.stash).toEqual(stash);
    expect(again.report.runesToTab).toBe(0);
  });

  it('moves a full grid of sigils, and leaves what is past a cap in the grid', () => {
    const sim = new Simulation(3);
    const items: Item[] = [];
    const cells = emptyGrid(STASH);
    for (let i = 0; i < STASH.w * STASH.h; i++) {
      const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'common');
      items.push(sigil);
      cells[i] = sigil.uid;
    }
    // 120 cells is below either cap, so everything moves.
    expect(convertStashTabs({ items, cells, runeFormat: 2 }).stash.sigils.list).toHaveLength(STASH.w * STASH.h);
    const bolts = [createRune(sim.newItemUid(), 'bolt', 20), createRune(sim.newItemUid(), 'bolt', 20), createRune(sim.newItemUid(), 'bolt', 5)];
    const small = emptyGrid(STASH);
    [...bolts, ...items.slice(0, 2)].forEach((it, i) => (small[i] = it.uid));
    const { stash, report } = convertStashTabs({ items: [...bolts, ...items.slice(0, 2)], cells: small, runeFormat: 2 }, { runeCap: 2, sigilCap: 1 });
    expect(stash.runes.list).toEqual([bolts[0]?.uid, bolts[1]?.uid]);
    expect(stash.sigils.list).toEqual([items[0]?.uid]);
    expect(report.stayed).toEqual([{ reason: 'over cap', count: 2 }]);
    const tab = stash.general[0];
    expect(tab && anchorOf(tab.cells, STASH, bolts[2]?.uid ?? -1)).toEqual({ x: 2, y: 0 });
    expect(tab && anchorOf(tab.cells, STASH, items[1]?.uid ?? -1)).toEqual({ x: 4, y: 0 });
    expect(stash.items).toHaveLength(5);
  });

  it('throws on data it cannot read, so the row is kept', () => {
    expect(() => convertStashTabs({ items: [{ uid: 1 }], cells: [], runeFormat: 2 })).toThrow();
    expect(() => convertStashTabs({ items: [], cells: [], runeFormat: 1 })).toThrow();
    expect(() => convertStashTabs({ ...emptyStash(), runeFormat: 2, items: [], runes: { kind: 'runes', list: ['x'] } })).toThrow();
  });
});

describe('stash messages', () => {
  it.each([
    { t: 'moveItem', uid: 1, to: { at: 'bag', x: 11, y: 7 } },
    { t: 'moveItem', uid: 1, to: { at: 'tab', tab: 10, x: 11, y: 9 } },
    { t: 'moveItem', uid: 1, to: { at: 'runes' } },
    { t: 'moveItem', uid: 1, to: { at: 'sigils' } },
    { t: 'quickMove', uid: 3, tab: null },
    { t: 'quickMove', uid: 3, tab: 2 },
    { t: 'takeRunes', uid: 4, count: 20, to: null },
    { t: 'takeRunes', uid: 4, count: 1, to: { at: 'tab', tab: 1, x: 0, y: 0 } },
    { t: 'sortStash', tab: 3, key: null, affix: null },
    { t: 'sortStash', tab: 'runes', key: 'ilvl', affix: null },
    { t: 'sortStash', tab: 'runes', key: 'kind', affix: null },
    { t: 'sortStash', tab: 'runes', key: 'affix', affix: 'rune_damage' },
    { t: 'sortStash', tab: 'sigils', key: 'slots', affix: null },
    { t: 'buyStashTab' },
    { t: 'editStashTab', tab: 1, name: 'Loot 2', color: 'verdigris' },
  ])('accepts %j', (value) => {
    expect(parseClientMessage(value)).toEqual(value);
  });

  it.each([
    { t: 'moveItem', uid: 1, to: 'stash', x: 0, y: 0 },
    { t: 'moveItem', uid: 1, to: { at: 'bag', x: 12, y: 0 } },
    { t: 'moveItem', uid: 1, to: { at: 'bag', x: 0, y: 8 } },
    { t: 'moveItem', uid: 1, to: { at: 'tab', tab: 0, x: 0, y: 0 } },
    { t: 'moveItem', uid: 1, to: { at: 'tab', tab: 11, x: 0, y: 0 } },
    { t: 'moveItem', uid: 1, to: { at: 'tab', tab: 1, x: 0, y: 10 } },
    { t: 'moveItem', uid: 1, to: { at: 'tab', tab: 1.5, x: 0, y: 0 } },
    { t: 'moveItem', uid: -1, to: { at: 'runes' } },
    { t: 'moveItem', uid: 1, to: { at: 'gear' } },
    { t: 'quickMove', uid: 1 },
    { t: 'quickMove', uid: 1, tab: 'runes' },
    { t: 'quickMove', uid: 1, tab: 11 },
    { t: 'takeRunes', uid: 4, count: 0, to: null },
    { t: 'takeRunes', uid: 4, count: 21, to: null },
    { t: 'takeRunes', uid: 4, count: 2.5, to: null },
    { t: 'takeRunes', uid: -4, count: 1, to: null },
    { t: 'takeRunes', rune: 'bolt', count: 1, to: null },
    { t: 'takeRunes', uid: 4, count: 1 },
    { t: 'takeRunes', uid: 4, count: 1, to: { at: 'runes' } },
    { t: 'sortStash', tab: 1, key: 'tier', affix: null },
    { t: 'sortStash', tab: 1, key: null },
    { t: 'sortStash', tab: 'runes', key: 'slots', affix: null },
    { t: 'sortStash', tab: 'runes', key: 'rune' },
    { t: 'sortStash', tab: 'runes', key: 'affix', affix: null },
    { t: 'sortStash', tab: 'runes', key: 'affix', affix: 'gear_armor' },
    { t: 'sortStash', tab: 'runes', key: 'affix', affix: 'nope' },
    { t: 'sortStash', tab: 'runes', key: 'tier', affix: 'rune_damage' },
    { t: 'sortStash', tab: 'sigils', key: 'rune', affix: null },
    { t: 'sortStash', tab: 'sigils', key: null, affix: null },
    { t: 'sortStash', tab: 'gear', key: null, affix: null },
    { t: 'editStashTab', tab: 1, name: '', color: 'ash' },
    { t: 'editStashTab', tab: 1, name: 'x'.repeat(17), color: 'ash' },
    { t: 'editStashTab', tab: 1, name: 'a  b', color: 'ash' },
    { t: 'editStashTab', tab: 1, name: ' a', color: 'ash' },
    { t: 'editStashTab', tab: 1, name: '<script>', color: 'ash' },
    { t: 'editStashTab', tab: 1, name: 'Tab​', color: 'ash' },
    { t: 'editStashTab', tab: 1, name: 'Ok', color: 'pink' },
    { t: 'editStashTab', tab: 'runes', name: 'Ok', color: 'ash' },
  ])('rejects %j', (value) => {
    expect(parseClientMessage(value)).toBeNull();
  });
});
