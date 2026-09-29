import { DUNGEON, LOOT } from '../config/sim.js';
import { dropSigil } from '../items/drops.js';
import { createGear, rollTier, type Item } from '../items/items.js';
import { spawnBag } from './inventory.js';
import type { Simulation } from './simulation.js';

/** The end of a dungeon run: marks it cleared and opens the boss cache. Only dungeons have one. */
export function onBossKilled(sim: Simulation, x: number, y: number, level: number): void {
  // Arena runs never drop loot, whatever map they use.
  if (sim.mapDef.theme !== 'dungeon' || sim.arena || sim.cleared) return;
  sim.cleared = true;
  const rng = sim.rand.loot;
  const items: Item[] = [];
  for (let i = 0; i < DUNGEON.cacheItems; i++) {
    const tier = rollTier(rng, DUNGEON.cacheTierWeights);
    // Gear-heavy: the cache is the reliable way to fill empty slots.
    items.push(rng.next() < 0.7 ? createGear(sim.newItemUid(), rng, tier, level + 1) : dropSigil(rng, () => sim.newItemUid(), tier, level + 1));
  }
  spawnBag(sim, x + 50, y, items, LOOT.bagRadius * 1.6, null);
  sim.emit({ e: 'explode', x: x + 50, y, r: 90 }, x, y);
}
