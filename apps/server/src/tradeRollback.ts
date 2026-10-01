import type { Item, ItemUid, PlayerComp, StashLayout } from '@rune/shared';

/**
 * Everything a trade can change on a player, held by value. `sellItem` and `buyItem` touch only
 * these: the item map (a bought rune tops up bag stacks in place, so the items are copied, not
 * referenced), the bag, the stash layout and the gold. Nothing in the sim holds item objects
 * outside the map (equipment and slots refer to uids), so putting copies back is safe.
 */
export interface TradeSnapshot {
  items: Map<ItemUid, Item>;
  inventory: (ItemUid | null)[];
  stash: StashLayout;
  gold: number;
}

export function snapshotForTrade(p: PlayerComp): TradeSnapshot {
  return structuredClone({ items: p.items, inventory: p.inventory, stash: p.stash, gold: p.gold });
}

/** Puts the player back exactly as snapshotted, and bumps the version so the client gets its bag again. */
export function rollBackTrade(p: PlayerComp, s: TradeSnapshot): void {
  p.items.clear();
  for (const [uid, item] of s.items) p.items.set(uid, item);
  p.inventory.splice(0, p.inventory.length, ...s.inventory);
  p.stash = s.stash;
  p.gold = s.gold;
  p.inventoryVersion++;
}
