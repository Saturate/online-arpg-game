import { describe, expect, it } from 'vitest';
import { buyItem, buyPrice, createGear, sellItem, sellPrice, Simulation } from '../src/index.js';
import { addItem } from '../src/sim/inventory.js';

function atTrader() {
  const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
  const pid = sim.addPlayer('c', 'warrior');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  const trader = sim.mapDef.trader;
  if (!p || !pos || !trader) throw new Error('setup');
  pos.x = trader.x + 60;
  pos.y = trader.y;
  return { sim, pid, p, pos, trader };
}

describe('trader', () => {
  it('sells a bag item for gold and hands it over for the shared stock', () => {
    const { sim, pid, p } = atTrader();
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'rare', 5, { category: 'ring' });
    addItem(p, ring);
    const sold = sellItem(sim, pid, ring.uid);
    expect(typeof sold).toBe('object');
    expect(p.gold).toBe(sellPrice(ring));
    expect(p.inventory.includes(ring.uid)).toBe(false);
    expect(p.items.has(ring.uid)).toBe(false);
  });

  it('refuses to sell starter items, so new characters cannot mint gold', () => {
    const { sim, pid, p } = atTrader();
    const starter = [...p.items.values()].find((i) => i.kind === 'sigil' && p.inventory.includes(i.uid));
    if (!starter) throw new Error('no starter sigil in the bag');
    expect(sellItem(sim, pid, starter.uid)).toBe('Starter items cannot be sold');
    expect(sellPrice(starter)).toBe(0);
    expect(p.gold).toBe(0);
  });

  it('only trades at the stall', () => {
    const { sim, pid, p, pos, trader } = atTrader();
    const ring = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { category: 'ring' });
    addItem(p, ring);
    pos.x = trader.x + 2000;
    expect(sellItem(sim, pid, ring.uid)).toBe('Stand at the trader to sell');
    expect(p.inventory.includes(ring.uid)).toBe(true);
  });

  it('sells to players who can pay and have room, as a fresh copy', () => {
    const { sim, pid, p } = atTrader();
    const helm = createGear(999, sim.rand.loot, 'magic', 3, { category: 'helmet' });
    const price = buyPrice(helm);
    expect(buyItem(sim, pid, helm, price)).toBe(`That costs ${price} gold`);
    p.gold = price + 5;
    expect(buyItem(sim, pid, helm, price)).toBeNull();
    expect(p.gold).toBe(5);
    const owned = [...p.items.values()].find((i) => i.name === helm.name && i.kind === 'gear' && i.category === 'helmet');
    expect(owned).toBeDefined();
    expect(owned?.uid).not.toBe(999);
  });

  it('prices by tier and item level, and buying costs three times selling', () => {
    const { sim } = atTrader();
    const common = createGear(1, sim.rand.loot, 'common', 1, { category: 'ring' });
    const relic = createGear(2, sim.rand.loot, 'relic', 10, { category: 'ring' });
    expect(sellPrice(relic)).toBeGreaterThan(sellPrice(common) * 10);
    expect(buyPrice(common)).toBe(sellPrice(common) * 3);
  });
});

describe('skill bar order', () => {
  it('swaps two skill slots without unequipping anything', () => {
    const sim = new Simulation(2, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const [a, b] = [p.sigils[0]?.uid, p.sigils[2]?.uid];
    expect(sim.swapSigils(pid, 0, 2)).toBeNull();
    expect([p.sigils[0]?.uid, p.sigils[2]?.uid]).toEqual([b, a]);
  });
});
