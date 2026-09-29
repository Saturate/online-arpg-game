import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  BAG,
  canPlace,
  createGear,
  createSigil,
  emptyGrid,
  findSpot,
  itemSize,
  pendingItems,
  placements,
  restoreStash,
  Simulation,
  splitStash,
  STASH,
  type Item,
} from '../src/index.js';
import { addItem, updateLoot, spawnBag } from '../src/sim/inventory.js';

function setup(desc: ConstructorParameters<typeof Simulation>[1] = { kind: 'flat' }) {
  const sim = new Simulation(5, desc);
  const pid = sim.addPlayer('c', 'warrior');
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.inventory = emptyGrid(BAG);
  return { sim, pid, p };
}

describe('item grid', () => {
  it('gives items D2-like footprints', () => {
    const { sim } = setup();
    expect(itemSize(createGear(1, sim.rand.loot, 'common', 1, { category: 'body' }))).toEqual({ w: 2, h: 3 });
    expect(itemSize(createGear(2, sim.rand.loot, 'common', 1, { category: 'helmet' }))).toEqual({ w: 2, h: 2 });
    expect(itemSize(createGear(3, sim.rand.loot, 'common', 1, { category: 'ring' }))).toEqual({ w: 1, h: 1 });
    expect(itemSize(createSigil(4, sim.rand.loot, 'common'))).toEqual({ w: 1, h: 1 });
  });

  it('fills column by column and refuses what does not fit', () => {
    const cells = emptyGrid(BAG);
    expect(findSpot(cells, BAG, { w: 2, h: 3 })).toEqual({ x: 0, y: 0 });
    expect(canPlace(cells, BAG, { w: 2, h: 3 }, 9, 0)).toBe(false);
    expect(canPlace(cells, BAG, { w: 2, h: 3 }, 8, 3)).toBe(true);
    expect(canPlace(cells, BAG, { w: 2, h: 3 }, 8, 4)).toBe(false);
  });

  it('picks up what fits from a bag and leaves big items that do not, without blocking small ones', () => {
    const { sim, pid, p } = setup();
    // Fill all but one cell with rings.
    for (let i = 0; i < BAG.w * BAG.h - 1; i++) addItem(p, createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' }));
    const armour = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'body' });
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('no pos');
    spawnBag(sim, pos.x, pos.y, [armour, ring], 20, null);
    updateLoot(sim, 0.05);
    expect(p.inventory.includes(ring.uid)).toBe(true);
    expect(p.items.has(armour.uid)).toBe(false);
    expect([...sim.world.loot.values()].some((b) => b.items.includes(armour))).toBe(true);
  });

  it('swaps equipment back into the spot the new piece came from', () => {
    const { sim, pid, p } = setup();
    const old = p.gear.weapon;
    const weapon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'weapon' });
    p.items.set(weapon.uid, weapon);
    addItem(p, createSigil(sim.newItemUid(), sim.rand.loot, 'common'));
    p.items.delete(weapon.uid);
    addItem(p, weapon);
    const at = anchorOf(p.inventory, BAG, weapon.uid);
    expect(sim.equipGear(pid, weapon.uid)).toBeNull();
    expect(p.gear.weapon).toBe(weapon.uid);
    if (old !== null) expect(anchorOf(p.inventory, BAG, old)).toEqual(at);
  });

  it('packs an old 20-slot save into the grid, spilling what does not fit into the stash', () => {
    const { sim, pid } = setup();
    const items: Item[] = Array.from({ length: 20 }, (_, i) => createGear(100 + i, sim.rand.loot, 'common', 1, { category: 'body' }));
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const old = { ...save, items: [...save.items, ...items], inventory: items.map((i) => i.uid), stash: [] };
    const sim2 = new Simulation(6, { kind: 'flat' });
    const pid2 = sim2.addPlayer('c', 'warrior', 'Old', old);
    const p2 = sim2.world.player.get(pid2);
    if (!p2) throw new Error('no player');
    const armour = (cells: readonly (number | null)[], size: typeof BAG) =>
      placements(cells, size).filter(({ uid }) => { const it = p2.items.get(uid); return it?.kind === 'gear' && it.category === 'body'; }).length;
    const inBag = armour(p2.inventory, BAG);
    const inStash = armour(p2.stash, STASH);
    // Ten 2x3 armours fill a 10x6 bag; the other ten go to the stash, so none is lost.
    expect(inBag).toBe(10);
    expect(inStash).toBe(10);
  });
});

describe('stash', () => {
  it('only moves items to or from the stash while standing at the chest', () => {
    const { sim, pid, p } = setup({ kind: 'zone', zone: 'barrens', seed: 3 });
    const stashAt = sim.mapDef.stash;
    if (!stashAt) throw new Error('no stash in the home zone');
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    addItem(p, ring);
    const pos = sim.world.position.get(pid);
    if (!pos) throw new Error('no pos');
    pos.x = stashAt.x + 2000;
    pos.y = stashAt.y;
    expect(sim.moveItem(pid, ring.uid, 'stash', 0, 0)).toBe('Stand at the stash to use it');
    pos.x = stashAt.x + 60;
    expect(sim.moveItem(pid, ring.uid, 'stash', 3, 2)).toBeNull();
    expect(anchorOf(p.stash, STASH, ring.uid)).toEqual({ x: 3, y: 2 });
    expect(p.inventory.includes(ring.uid)).toBe(false);
  });

  it('is split off a save and loaded back into another character', () => {
    const { sim, pid, p } = setup();
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 4, { category: 'ring' });
    p.items.set(ring.uid, ring);
    p.stash[STASH.w + 1] = ring.uid;
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const { character, stash } = splitStash(save);
    expect(character.items.some((i) => i.uid === ring.uid)).toBe(false);
    expect(stash.items.map((i) => i.name)).toEqual([ring.name]);

    const sim2 = new Simulation(9, { kind: 'flat' });
    const other = sim2.addPlayer('d', 'mage');
    restoreStash(sim2, other, stash);
    const p2 = sim2.world.player.get(other);
    const landed = p2 ? placements(p2.stash, STASH) : [];
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ x: 1, y: 1 });
  });

  it('never loses items when an old full bag meets a full account stash: the rest waits for room', () => {
    const { sim } = setup();
    const armour = (uid: number) => createGear(uid, sim.rand.loot, 'common', 1, { category: 'body' });
    // An account stash holding 12 armours (2x3 each) and a second character with an old 20-slot bag of armour.
    const stashCells = emptyGrid(STASH);
    const stashItems = Array.from({ length: 12 }, (_, i) => armour(500 + i));
    for (const item of stashItems) {
      const spot = findSpot(stashCells, STASH, itemSize(item));
      if (!spot) throw new Error('setup');
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 2; dx++) stashCells[(spot.y + dy) * STASH.w + spot.x + dx] = item.uid;
    }
    const bagItems = Array.from({ length: 20 }, (_, i) => armour(600 + i));
    const base = new Simulation(2, { kind: 'flat' });
    const save0 = base.exportPlayer(base.addPlayer('x', 'warrior'));
    if (!save0) throw new Error('no save');
    const old = { ...save0, items: [...save0.items, ...bagItems], inventory: bagItems.map((i) => i.uid), stash: [] };

    const sim2 = new Simulation(3, { kind: 'flat' });
    const pid = sim2.addPlayer('c', 'warrior', 'Second', old);
    restoreStash(sim2, pid, { items: stashItems, cells: stashCells });
    const p = sim2.world.player.get(pid);
    if (!p) throw new Error('no player');
    const isArmour = (uid: number) => { const it = p.items.get(uid); return it?.kind === 'gear' && it.category === 'body'; };
    const inBag = placements(p.inventory, BAG).filter(({ uid }) => isArmour(uid)).length;
    const inStash = placements(p.stash, STASH).filter(({ uid }) => isArmour(uid)).length;
    const waiting = pendingItems(p).filter(isArmour).length;
    // All 32 armours are accounted for: the account's 12 keep their cells, the rest fill up, 4 wait.
    expect(inBag + inStash + waiting).toBe(32);
    expect(waiting).toBe(4);
    const save = sim2.exportPlayer(pid);
    if (!save) throw new Error('no save');
    const { character, stash } = splitStash(save);
    // Waiting items stay with the character's save, so the next login retries them.
    expect(character.items.filter((i) => i.kind === 'gear' && i.category === 'body')).toHaveLength(10 + 4);
    expect(stash.items.filter((i) => i.kind === 'gear' && i.category === 'body')).toHaveLength(18);
  });
});
