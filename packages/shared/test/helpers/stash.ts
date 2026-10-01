import { emptyStash, legacyLayout, type Item, type ItemUid, type PlayerComp, type StashLayout, type StashSave } from '../../src/index.js';

/** The cells of the first general tab, where the old single-grid tests put things. */
export function tab1(p: { stash: StashLayout }): (ItemUid | null)[] {
  const tab = p.stash.general[0];
  if (!tab) throw new Error('no general tab');
  return tab.cells;
}

/** A stored account stash with one general tab holding `cells`. */
export function stashOf(items: Item[], cells: (ItemUid | null)[] = emptyStash().general[0]?.cells ?? []): StashSave {
  return { ...legacyLayout(cells), runeFormat: 2, runeTiers: 6, items };
}

/** Whether an item sits anywhere in the character's stash (any tab or list). */
export function inStash(p: PlayerComp, uid: ItemUid): boolean {
  return p.stash.general.some((t) => t.cells.includes(uid)) || p.stash.runes.list.includes(uid) || p.stash.sigils.list.includes(uid);
}
