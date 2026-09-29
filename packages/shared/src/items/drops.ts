import { FORGE } from '../config/forge.js';
import { LOOT } from '../config/sim.js';
import type { Rng } from '../sim/rng.js';
import { STARTER_SIGILS, createStarterSigil } from '../data/starterSigils.js';
import { createGear, createRolledRune, createRune, createSigil, createVessel, rollRune, rollTier, type Item, type ItemTier, type ItemUid, type SigilItem } from './items.js';

/**
 * The monster drop roll without the Simulation around it. The game's `dropLoot` and the loot
 * simulator on /dev.html both call it, so the simulator always shows the live numbers.
 */

export const DROP_TIER_WEIGHTS = {
  // Slowed on purpose: a rare from a normal monster is now a find, and a relic about 1 in 300 drops.
  normal: { common: 72, magic: 24, rare: 3.7, relic: 0.3 },
  rare: { common: 0, magic: 55, rare: 38, relic: 7 },
  // 10% relic: at 40% a boss averaged 1.6 relics, which made normal drops pointless next to it.
  boss: { common: 0, magic: 30, rare: 60, relic: 10 },
} as const satisfies Record<string, Record<ItemTier, number>>;

export const BOSS_DROPS = 4;
/** Per bag, so a high admin loot rate cannot build a bag too big to snapshot or show. */
export const MAX_DROP_ITEMS = 24;

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
  runeShare: number;
  /** Share of rune drops that are rolled; FORGE.rolledRuneShare when left out. */
  rolledRuneShare?: number;
}

export const DEFAULT_DROP_TUNING: DropTuning = {
  normalDropChance: LOOT.normalDropChance,
  gearShare: LOOT.gearShareOfDrops,
  vesselShare: LOOT.vesselShareOfDrops,
  runeShare: LOOT.runeShareOfDrops,
  rolledRuneShare: FORGE.rolledRuneShare,
};

/**
 * `quantity` is the server's loot rate. It multiplies a normal monster's drop chance (a normal
 * monster still drops at most one item) and how many items rares and bosses drop.
 */
export function rollDrops(rng: Rng, newUid: () => ItemUid, src: DropSource, tuning: DropTuning = DEFAULT_DROP_TUNING, quantity = 1): Item[] {
  let count = 0;
  if (src.boss) count = BOSS_DROPS;
  else if (src.rare) count = rng.int(LOOT.rareDropCount.min, LOOT.rareDropCount.max);
  else if (rng.next() < Math.min(1, tuning.normalDropChance * quantity)) count = 1;
  // The admin loot rate scales how many items rares and bosses drop too. The fraction is rolled, so
  // 1.5x means half of them drop one extra; at 1x no extra roll happens and seeds replay unchanged.
  if (quantity !== 1 && (src.rare || src.boss)) {
    const scaled = count * quantity;
    count = Math.min(MAX_DROP_ITEMS, Math.floor(scaled) + (rng.next() < scaled - Math.floor(scaled) ? 1 : 0));
  }
  const weights = src.boss ? DROP_TIER_WEIGHTS.boss : src.rare ? DROP_TIER_WEIGHTS.rare : DROP_TIER_WEIGHTS.normal;
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const tier = rollTier(rng, weights);
    const roll = rng.next();
    // Runes first, then the rest split as before. A plain rune's rarity comes from the rune; a rolled
    // one takes its affix count from the drop tier and its affix tiers from the monster level.
    if (roll < tuning.runeShare) {
      const rolled = rng.next() < (tuning.rolledRuneShare ?? FORGE.rolledRuneShare);
      items.push(rolled ? createRolledRune(newUid(), rng, tier, src.level) : createRune(newUid(), rollRune(rng)));
      continue;
    }
    const rest = (roll - tuning.runeShare) / (1 - tuning.runeShare);
    items.push(
      rest < tuning.gearShare
        ? createGear(newUid(), rng, tier, src.level)
        : rest < tuning.gearShare + tuning.vesselShare
          ? createVessel(newUid(), rng, tier, undefined, src.level)
          : dropSigil(rng, newUid, tier, src.level),
    );
  }
  return items;
}

/**
 * Mostly blank sigils with wand stats; some carry a starter sigil's runes, unbound, so a drop can
 * still hand a new player a spell to try.
 */
export function dropSigil(rng: Rng, newUid: () => ItemUid, tier: ItemTier, ilvl: number): SigilItem {
  const sigil = createSigil(newUid(), rng, tier, { ilvl, allowCorrupt: true });
  if (rng.next() >= LOOT.sigilSpellShare) return sigil;
  const def = STARTER_SIGILS[rng.int(0, STARTER_SIGILS.length - 1)];
  if (!def) return sigil;
  const spell = createStarterSigil(newUid, def, { bound: false });
  // Rares keep their rolled name; lower tiers are named for the spell they carry.
  const name = tier === 'rare' || tier === 'relic' ? sigil.name : `${sigil.corrupted ? 'Corrupted ' : ''}${def.name}`;
  return { ...sigil, name, slots: spell.slots, starter: def.id };
}
