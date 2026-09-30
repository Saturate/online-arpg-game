import { DUNGEON, LOOT } from '../config/sim.js';
import { dropSigil } from '../items/drops.js';
import { createGear, rollTier, type Item } from '../items/items.js';
import type { Portal } from '../world/types.js';
import { spawnBag } from './inventory.js';
import type { Simulation } from './simulation.js';

/** Seconds a player standing where the exit appears gets before it takes them, so they can loot first. */
const EXIT_GRACE_SECONDS = 3;

/** Whether a portal can be seen and used now. A dungeon's exit stays sealed until its boss dies. */
export function portalOpen(sim: Simulation, portal: Portal): boolean {
  return portal.sealed !== 'boss' || sim.cleared;
}

/** Loot this close to the exit's centre would need a step into it to pick up. */
const EXIT_LOOT_MARGIN = 20;
/** How far such loot moves: always clear of the exit, and never past the far wall of the smallest boss room. */
const EXIT_LOOT_SHIFT = 100;

/**
 * Loot on or beside the exit when it opens (the boss's drops and cache, if it died there) moves
 * toward the boss room's centre, which is open floor, so looting never walks anyone out of the
 * dungeon. The shift keeps the spread of the drops.
 */
function offExit(sim: Simulation, x: number, y: number): { x: number; y: number } {
  const exit = sim.mapDef.portals.find((p) => p.sealed === 'boss');
  const home = sim.mapDef.packs.find((p) => p.boss);
  if (!exit || !home || Math.hypot(x - exit.x, y - exit.y) > exit.r + EXIT_LOOT_MARGIN) return { x, y };
  const d = Math.hypot(home.x - exit.x, home.y - exit.y) || 1;
  const shift = exit.r + EXIT_LOOT_SHIFT;
  return { x: x + ((home.x - exit.x) / d) * shift, y: y + ((home.y - exit.y) / d) * shift };
}

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
  const w = sim.world;
  for (const id of w.loot.keys()) {
    const pos = w.position.get(id);
    if (pos) w.position.set(id, offExit(sim, pos.x, pos.y));
  }
  const at = offExit(sim, x + 50, y);
  spawnBag(sim, at.x, at.y, items, LOOT.bagRadius * 1.6, null);
  sim.emit({ e: 'explode', x: at.x, y: at.y, r: 90 }, at.x, at.y);
  for (const exit of sim.mapDef.portals) {
    if (exit.sealed !== 'boss') continue;
    for (const [id, p] of w.player) {
      const pos = w.position.get(id);
      if (pos && (pos.x - exit.x) ** 2 + (pos.y - exit.y) ** 2 <= exit.r * exit.r) p.portalCooldown = Math.max(p.portalCooldown, EXIT_GRACE_SECONDS);
    }
  }
}
