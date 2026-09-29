import type { ItemTier } from '../items/items.js';

/** Forge and rune-drop tuning. Drop shares of runes against other loot stay in LOOT (config/sim.ts). */
export const FORGE = {
  /**
   * Gold per inserted rune is its sell value times this. At 1 the forge costs what the rune would
   * sell for; taking a rune out is free. Any factor is safe against minting, because a sigil sells
   * for no more than its runes' sell values on top of its own.
   */
  insertPriceFactor: 1,
  /** Share of rune drops that come rolled (with rune affixes); the rest are plain and stack. */
  rolledRuneShare: 0.2,
  /**
   * Rune affixes a rolled rune gets, by the drop's tier. Fewer than gear: a shape has at most six
   * affixes it may carry, and a rune with all of them would leave nothing to find.
   */
  rolledRuneAffixes: {
    common: { min: 1, max: 1 },
    magic: { min: 1, max: 2 },
    rare: { min: 2, max: 3 },
    relic: { min: 3, max: 3 },
  } satisfies Record<ItemTier, { min: number; max: number }>,
  /** Sell value each rune affix adds, by affix tier (T1, T2, T3), so better rolls are worth more. */
  runeAffixValue: [4, 10, 25],
} as const;
