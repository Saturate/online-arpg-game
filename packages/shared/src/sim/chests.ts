import { LOOT } from '../config/sim.js';
import { dropSigil } from '../items/drops.js';
import { createGear, rollTier, type Item } from '../items/items.js';
import { spawnBag } from './inventory.js';
import type { Simulation } from './simulation.js';

/** How close a living player must come to open a chest. */
export const CHEST_REACH = 70;

/** A dead end's chest: two items, magic or better, a level above the ground around it. */
const CHEST = { items: 2, tiers: { common: 0, magic: 60, rare: 34, relic: 6 } } as const;

/**
 * Chests opened in this room, by spot (`chestKey`), so a room rebuilt round a new town can be told
 * which were opened in the old one even if the list's order changed.
 */
const opened = new WeakMap<Simulation, Set<string>>();

export function chestKey(c: { x: number; y: number }): string {
  return `${Math.round(c.x)},${Math.round(c.y)}`;
}

export function openedChests(sim: Simulation): ReadonlySet<string> {
  return opened.get(sim) ?? new Set();
}

/** Carries opened chests over to a rebuilt room, so a town save does not fill them again. */
export function markChestsOpened(sim: Simulation, keys: Iterable<string>): void {
  const set = opened.get(sim) ?? new Set<string>();
  for (const k of keys) set.add(k);
  opened.set(sim, set);
}

/**
 * Opens a world chest the first time a living player walks up to it: its items drop on the ground
 * like a monster's, for whoever picks them up. Each chest opens once per room, so a world copy's
 * chests are found once until the room closes and the world regenerates.
 */
export function updateChests(sim: Simulation): void {
  const chests = sim.mapDef.chests;
  if (!chests || chests.length === 0 || sim.arena) return;
  let done = opened.get(sim);
  const w = sim.world;
  for (const [id, p] of w.player) {
    if (p.respawnIn !== null) continue;
    const pos = w.position.get(id);
    if (!pos) continue;
    for (const c of chests) {
      const key = chestKey(c);
      if (done?.has(key) || (pos.x - c.x) ** 2 + (pos.y - c.y) ** 2 > CHEST_REACH * CHEST_REACH) continue;
      if (!done) {
        done = new Set();
        opened.set(sim, done);
      }
      done.add(key);
      const rng = sim.rand.loot;
      const items: Item[] = [];
      for (let k = 0; k < CHEST.items; k++) {
        const tier = rollTier(rng, CHEST.tiers);
        items.push(rng.next() < 0.6 ? createGear(sim.newItemUid(), rng, tier, c.level) : dropSigil(rng, () => sim.newItemUid(), tier, c.level));
      }
      // Dropped in front of the chest, toward the one who opened it, so it is not under the model.
      const d = Math.hypot(pos.x - c.x, pos.y - c.y) || 1;
      const x = c.x + ((pos.x - c.x) / d) * 50;
      const y = c.y + ((pos.y - c.y) / d) * 50;
      spawnBag(sim, x, y, items, LOOT.bagRadius * 1.4, null);
      sim.emit({ e: 'explode', x, y, r: 60 }, x, y);
    }
  }
}
