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
  /**
   * Sell value each rune affix adds, by tier index from the weakest (T6) to the best (T1), so better
   * rolls are worth more. Release affixes have one tier and add the first value. T1 is a rare find
   * above every old roll; the old three tiers were worth 4, 10 and 25.
   */
  runeAffixValue: [4, 6, 9, 13, 20, 60],
} as const;
