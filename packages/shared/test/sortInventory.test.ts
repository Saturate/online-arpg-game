import { describe, expect, it } from 'vitest';
import { anchorOf, BAG, createGear, createSigil, emptyGrid, itemSize, place, placements, Simulation, type Item } from '../src/index.js';

function give(sim: Simulation, pid: number, item: Item, x: number, y: number): void {
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.items.set(item.uid, item);
  place(p.inventory, BAG, item.uid, itemSize(item), x, y);
}

describe('sortInventory', () => {
  it('packs the bag column by column: gear by slot, then sigils; best tier first; equipment untouched', () => {
    const sim = new Simulation(8, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const before = { ...p.gear };
    p.inventory = emptyGrid(BAG);
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 3, { category: 'ring' });
    const helmCommon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 3, { category: 'helmet' });
    const helmRare = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 3, { category: 'helmet' });
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'relic', { ilvl: 3, skill: 'random' });
    give(sim, pid, sigil, 9, 5);
    give(sim, pid, ring, 4, 1);
    give(sim, pid, helmCommon, 6, 0);
    give(sim, pid, helmRare, 2, 3);
    expect(sim.sortInventory(pid)).toBeNull();
    expect(anchorOf(p.inventory, BAG, helmRare.uid)).toEqual({ x: 0, y: 0 });
    expect(anchorOf(p.inventory, BAG, helmCommon.uid)).toEqual({ x: 0, y: 2 });
    expect(anchorOf(p.inventory, BAG, ring.uid)).toEqual({ x: 0, y: 4 });
    expect(anchorOf(p.inventory, BAG, sigil.uid)).toEqual({ x: 0, y: 5 });
    expect(placements(p.inventory, BAG)).toHaveLength(4);
    expect(p.gear).toEqual(before);
  });
});
