import { describe, expect, it } from 'vitest';
import { createGear, inventoryMessage, Simulation, type GearItem, type InventoryMessage } from '@rune/shared';
import { compareGear, dropAction, parseDrag, quickAction, replacedBy } from '../src/ui/itemActions.js';

function setup(): { sim: Simulation; pid: number; inv: () => InventoryMessage } {
  const sim = new Simulation(4, { kind: 'flat' });
  const pid = sim.addPlayer('c', 'mage');
  return {
    sim,
    pid,
    inv: () => {
      const m = inventoryMessage(sim, pid);
      if (!m) throw new Error('no inventory');
      return m;
    },
  };
}

function give(sim: Simulation, pid: number, item: GearItem): void {
  const p = sim.world.player.get(pid);
  if (!p) throw new Error('no player');
  p.items.set(item.uid, item);
  p.inventory[p.inventory.indexOf(null)] = item.uid;
}

describe('item actions', () => {
  it('right-click equips from the bag and removes from slots', () => {
    const { sim, pid, inv } = setup();
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 5, { category: 'ring' });
    give(sim, pid, ring);
    expect(quickAction(inv(), ring, { at: 'bag' }, 'mage')).toEqual({ t: 'equipGear', uid: ring.uid, slot: null });
    expect(quickAction(inv(), ring, { at: 'gear', slot: 'ring2' }, 'mage')).toEqual({ t: 'unequipGear', slot: 'ring2' });
  });

  it('never replaces a sigil on right-click when every slot is full', () => {
    const { sim, pid, inv } = setup();
    const p = sim.world.player.get(pid);
    const spare = [...(p?.items.values() ?? [])].find((i) => i.kind === 'sigil');
    if (!spare) throw new Error('no sigil');
    // Mages start with four equipped skills.
    expect(inv().sigils.every((s) => s !== null)).toBe(true);
    expect(quickAction(inv(), spare, { at: 'bag' }, 'mage')).toBeNull();
  });

  it('only accepts drops that fit the slot', () => {
    const { sim, pid, inv } = setup();
    const boots = createGear(sim.newItemUid(), sim.rand.loot, 'magic', 5, { category: 'boots' });
    give(sim, pid, boots);
    const drag = { uid: boots.uid, from: { at: 'bag' as const } };
    expect(dropAction(inv(), boots, drag, { at: 'gear', slot: 'boots' }, 'mage')).toEqual({ t: 'equipGear', uid: boots.uid, slot: 'boots' });
    expect(dropAction(inv(), boots, drag, { at: 'gear', slot: 'helmet' }, 'mage')).toBeNull();
    expect(dropAction(inv(), boots, drag, { at: 'sigil', slot: 0 }, 'mage')).toBeNull();
  });

  it('compares against the item it would replace', () => {
    const { sim, pid, inv } = setup();
    const weapon = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 5, { category: 'weapon', classId: 'mage' });
    give(sim, pid, weapon);
    const current = replacedBy(inv(), weapon);
    // Mages start with a staff equipped, so a new weapon is compared against it.
    expect(current?.category).toBe('weapon');
    expect(compareGear(weapon, weapon)).toEqual([]);
  });

  it('rejects drag data it did not create', () => {
    expect(parseDrag('not json')).toBeNull();
    expect(parseDrag(JSON.stringify({ uid: 1, from: { at: 'gear', slot: 'tail' } }))).toBeNull();
    expect(parseDrag(JSON.stringify({ uid: 1, from: { at: 'sigil', slot: 9 } }))).toBeNull();
    expect(parseDrag(JSON.stringify({ uid: 1, from: { at: 'bag' } }))).toEqual({ uid: 1, from: { at: 'bag' } });
  });
});
