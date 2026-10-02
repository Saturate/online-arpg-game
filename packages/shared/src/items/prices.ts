import { FORGE } from '../config/forge.js';
import { isBound, runeImplicit, type Item, type ItemTier, type RuneItem } from './items.js';

export { FORGE } from '../config/forge.js';

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

function baseValue(item: Item): number {
  return Math.max(1, Math.round(TIER_VALUE[item.tier] * (1 + 0.12 * (item.ilvl - 1))));
}

/** One rune of this item, bound or not: its tier, its implicit's tier, and each affix by its tier. */
function runeValue(rune: RuneItem): number {
  let v = baseValue(rune);
  const implicit = runeImplicit(rune);
  if (implicit) v += FORGE.runeImplicitValue[implicit.tier] ?? FORGE.runeImplicitValue[FORGE.runeImplicitValue.length - 1] ?? 0;
  for (const a of rune.affixes) v += FORGE.runeAffixValue[a.tier] ?? FORGE.runeAffixValue[FORGE.runeAffixValue.length - 1] ?? 0;
  return v;
}

export function sellPrice(item: Item): number {
  if (isBound(item)) return 0;
  // A rune stack is worth its count; priced as one, a stack of 20 sold for 5% of its value.
  if (item.kind === 'rune') return runeValue(item) * item.count;
  // A sigil is worth its runes on top of itself, which is what the forge charged to put them in.
  // Bound runes add nothing: such a sigil cannot be sold anyway (holdsBoundRunes).
  if (item.kind === 'sigil') return item.slots.reduce((sum, r) => sum + sellPrice(r), baseValue(item));
  return baseValue(item);
}

export function buyPrice(item: Item): number {
  return sellPrice(item) * TRADER.buyMultiplier;
}

/**
 * Gold the forge charges to insert one of this rune: its one-rune value times
 * FORGE.insertPriceFactor. Bound runes are free: they cannot be sold, so a price protects nothing,
 * and a new character with no gold must be able to put its starter runes back.
 */
export function forgeInsertPrice(rune: RuneItem): number {
  if (isBound(rune)) return 0;
  return Math.max(0, Math.round(runeValue(rune) * FORGE.insertPriceFactor));
}
