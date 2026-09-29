import { isBound, type Item, type ItemTier } from './items.js';

/**
 * Trader prices. Selling pays a little, buying costs three times as much, so the trader is a way
 * to pass items between players and clear out junk rather than a gold farm.
 */

const TIER_VALUE: Record<ItemTier, number> = { common: 4, magic: 12, rare: 40, relic: 150 };

export const TRADER = {
  /** Shared by every player on the server; the oldest item is destroyed when a sale goes past this. */
  capacity: 50,
  buyMultiplier: 3,
  /** How close to the trader's stall a player must stand; checked on the server. */
  reach: 170,
} as const;

export function sellPrice(item: Item): number {
  if (isBound(item)) return 0;
  const each = Math.max(1, Math.round(TIER_VALUE[item.tier] * (1 + 0.12 * (item.ilvl - 1))));
  // A rune stack is worth its count; priced as one, a stack of 20 sold for 5% of its value.
  return item.kind === 'rune' ? each * item.count : each;
}

export function buyPrice(item: Item): number {
  return sellPrice(item) * TRADER.buyMultiplier;
}
