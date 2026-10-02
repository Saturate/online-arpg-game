import type { EntityId, EntitySnap, Item, ItemTier, ItemUid, LootName, ServerMessage } from '@rune/shared';
import { create } from 'zustand';
import { cssColor, TIER_COLORS, UNIQUE_COLOR } from '../render/config.js';

type LootSnap = Extract<EntitySnap, { k: 'loot' }>;
type LootPileMessage = Extract<ServerMessage, { t: 'lootPile' }>;

/**
 * The open loot window (docs/features/loot.md, "Loot piles"). `items` null means the server has not
 * answered yet. The server sends the pile again whenever it changes and closes it when it is gone.
 */
interface LootWindowState {
  id: EntityId | null;
  items: Item[] | null;
  own: readonly ItemUid[];
}

export const useLootWindow = create<LootWindowState>(() => ({ id: null, items: null, own: [] }));

export function openLootWindow(id: EntityId): void {
  useLootWindow.setState({ id, items: null, own: [] });
}

/** Clears the window without telling the server: it closed it, or the room changed. */
export function dropLootWindow(): void {
  useLootWindow.setState({ id: null, items: null, own: [] });
}

/** A `lootPile` message for any other pile is a stale answer to an earlier window, and is ignored. */
export function receiveLootPile(msg: LootPileMessage): void {
  if (useLootWindow.getState().id !== msg.id) return;
  if (msg.items === null) dropLootWindow();
  else useLootWindow.setState({ items: msg.items, own: msg.own });
}

/** The pile under the cursor, for the hover preview; its own store because it changes as the mouse moves. */
interface LootHoverState {
  id: EntityId | null;
  names: readonly LootName[];
  count: number;
}

export const useLootHover = create<LootHoverState>(() => ({ id: null, names: [], count: 0 }));

/** Sets the hovered pile, writing to the store only when what the preview shows changed. */
export function hoverPile(snap: LootSnap | null): void {
  const cur = useLootHover.getState();
  if (!snap) {
    if (cur.id !== null) useLootHover.setState({ id: null, names: [], count: 0 });
    return;
  }
  // Snapshots arrive as fresh objects every tick, so the names are compared by value.
  if (cur.id === snap.id && cur.count === snap.count && sameNames(cur.names, snap.names)) return;
  useLootHover.setState({ id: snap.id, names: snap.names, count: snap.count });
}

function sameNames(a: readonly LootName[], b: readonly LootName[]): boolean {
  return a.length === b.length && a.every((n, i) => {
    const m = b[i];
    return m !== undefined && n.n === m.n && n.tier === m.tier && n.u === m.u && n.c === m.c;
  });
}

export function nameColor(n: { tier: ItemTier; u?: true }): string {
  return cssColor(n.u ? UNIQUE_COLOR : TIER_COLORS[n.tier]);
}

/** A rune stack's count after its name, as the bag shows it. */
export function nameText(n: LootName): string {
  return n.c === undefined ? n.n : `${n.n} x${n.c}`;
}

const GOOD: readonly ItemTier[] = ['rare', 'relic'];

/**
 * A pile's one ground label: a single item by name, a pile as a count in its best item's colour, like
 * gold. Shown for good drops always and for everything while Alt is held; null when it stays hidden.
 */
export function pileLabel(snap: LootSnap, showAll: boolean): { text: string; color: string } | null {
  const best = snap.names[0];
  if (snap.count === 0 || !best) return null;
  if (!showAll && !GOOD.includes(best.tier) && !best.u) return null;
  return { text: snap.count === 1 ? nameText(best) : `${snap.count} items`, color: nameColor(best) };
}

/** A click on a single item takes it at once; a pile opens its window. */
export function opensWindow(count: number): boolean {
  return count > 1;
}
