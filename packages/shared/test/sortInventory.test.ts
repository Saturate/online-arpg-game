import { describe, expect, it } from 'vitest';
import { createGear, createSigil, Simulation, type Item } from '../src/index.js';

function give(sim: Simulation, pid: number, item: Item, at: number): void {
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.items.set(item.uid, item);
  p.inventory[at] = item.uid;
}

describe('sortInventory', () => {
  it('packs the bag: gear by slot, then sigils; best tier first; equipment untouched', () => {
    const sim = new Simulation(8, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const before = { ...p.gear };
    p.inventory = p.inventory.map(() => null);
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 3, { category: 'ring' });
    const helmCommon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 3, { category: 'helmet' });
    const helmRare = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 3, { category: 'helmet' });
    const sigil = createSigil(sim.newItemUid(), sim.rand.loot, 'relic', { ilvl: 3, skill: 'random' });
    give(sim, pid, sigil, 1);
    give(sim, pid, ring, 7);
    give(sim, pid, helmCommon, 12);
    give(sim, pid, helmRare, 19);
    expect(sim.sortInventory(pid)).toBeNull();
    expect(p.inventory.slice(0, 5)).toEqual([helmRare.uid, helmCommon.uid, ring.uid, sigil.uid, null]);
    expect(p.inventory.filter((u) => u !== null)).toHaveLength(4);
    expect(p.gear).toEqual(before);
  });
});
