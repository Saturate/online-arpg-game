import { LOOT } from '../config/sim.js';
import type { Rng } from '../sim/rng.js';
import { createGear, createSigil, createVessel, rollTier, type Item, type ItemTier, type ItemUid } from './items.js';

/**
 * The monster drop roll without the Simulation around it. The game's `dropLoot` and the loot
 * simulator on /dev.html both call it, so the simulator always shows the live numbers.
 */

export const DROP_TIER_WEIGHTS = {
  normal: { common: 60, magic: 30, rare: 9, relic: 1 },
  rare: { common: 0, magic: 40, rare: 45, relic: 15 },
  // 18% relic: at 40% a boss averaged 1.6 relics, which made normal drops pointless next to it.
  boss: { common: 0, magic: 15, rare: 67, relic: 18 },
} as const satisfies Record<string, Record<ItemTier, number>>;

export const BOSS_DROPS = 4;

export interface DropSource {
  level: number;
  rare: boolean;
  boss: boolean;
}

/** Tuning knobs the simulator can override; defaults are the live LOOT config. */
export interface DropTuning {
  normalDropChance: number;
  gearShare: number;
  vesselShare: number;
}

export const DEFAULT_DROP_TUNING: DropTuning = {
  normalDropChance: LOOT.normalDropChance,
  gearShare: LOOT.gearShareOfDrops,
  vesselShare: LOOT.vesselShareOfDrops,
};

export function rollDrops(rng: Rng, newUid: () => ItemUid, src: DropSource, tuning: DropTuning = DEFAULT_DROP_TUNING): Item[] {
  let count = 0;
  if (src.boss) count = BOSS_DROPS;
  else if (src.rare) count = rng.int(LOOT.rareDropCount.min, LOOT.rareDropCount.max);
  else if (rng.next() < tuning.normalDropChance) count = 1;
  const weights = src.boss ? DROP_TIER_WEIGHTS.boss : src.rare ? DROP_TIER_WEIGHTS.rare : DROP_TIER_WEIGHTS.normal;
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const tier = rollTier(rng, weights);
    const roll = rng.next();
    items.push(
      roll < tuning.gearShare
        ? createGear(newUid(), rng, tier, src.level)
        : roll < tuning.gearShare + tuning.vesselShare
          ? createVessel(newUid(), rng, tier, undefined, src.level)
          : createSigil(newUid(), rng, tier, { ilvl: src.level, allowCorrupt: true, skill: 'random' }),
    );
  }
  return items;
}
