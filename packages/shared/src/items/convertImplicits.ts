import { neutralImplicit, type Item, type ItemUid, type RuneItem } from './items.js';

/**
 * The implicit pass (docs/features/items.md, "Implicit pass"): runes stored before implicits carry
 * none, so each castable rune, loose or in a sigil, plain stacks whole, gets the neutral roll once:
 * the middle of T4, the number every rune had before. Nothing else changes: uids, counts, rolls,
 * names and binding stay, so each rune casts, stacks and sells exactly as before (the neutral tier
 * adds no gold, FORGE.runeImplicitValue). The caller runs it on data without `runeImplicits: 1`
 * (isRuneImplicits1), after the earlier passes, and writes the marker back. A rune that already has
 * an implicit is left alone, so a second pass changes nothing.
 *
 * Every stored item list goes through it on load: characters, the account stash, the trader shelf,
 * ground loot in a session snapshot, and any new kind of storage (a guild stash) must as well.
 */

export interface ImplicitsReport {
  /** Rune uids (loose or in a sigil) given the neutral implicit. */
  runesGiven: ItemUid[];
}

export function emptyImplicitsReport(): ImplicitsReport {
  return { runesGiven: [] };
}

/** Stored JSON whose runes already carry implicits; anything without it goes through convertImplicits once. */
export function isRuneImplicits1(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Reflect.get(raw, 'runeImplicits') === 1;
}

function withImplicit(rune: RuneItem, report: ImplicitsReport): RuneItem {
  if (rune.implicit !== undefined) return rune;
  const implicit = neutralImplicit(rune.rune);
  if (!implicit) return rune;
  report.runesGiven.push(rune.uid);
  return { ...rune, implicit };
}

/** One item after the pass; the same object when nothing in it changes. */
export function convertItemImplicits(item: Item, report: ImplicitsReport): Item {
  if (item.kind === 'rune') return withImplicit(item, report);
  if (item.kind !== 'sigil') return item;
  const slots = item.slots.map((r) => withImplicit(r, report));
  return slots.every((r, i) => r === item.slots[i]) ? item : { ...item, slots };
}

/** A list of items after the pass, in the same order. */
export function convertImplicits(items: readonly Item[]): { items: Item[]; report: ImplicitsReport } {
  const report = emptyImplicitsReport();
  return { items: items.map((it) => convertItemImplicits(it, report)), report };
}

/** A stored list through the pass unless its row is marked, for loaders that read the marker off the raw row. */
export function loadImplicits(raw: unknown, items: readonly Item[]): { items: Item[]; report: ImplicitsReport } {
  return isRuneImplicits1(raw) ? { items: [...items], report: emptyImplicitsReport() } : convertImplicits(items);
}
