import {
  CASTABLE_RUNES,
  clampRuneRolls,
  createRune,
  rollLosses,
  isCastableRune,
  isPlainRune,
  neutralImplicit,
  RUNE_STACK,
  runeImplicit,
  type AffixRoll,
  type InventoryMessage,
  type ItemUid,
  type RuneId,
  type RuneItem,
  type RuneRef,
  type RuneRefImplicit,
  type SigilItem,
} from '@rune/shared';

/**
 * The forge editor's draft, kept as the inscribe message's own RuneRef list so what is shown is
 * exactly what gets sent. Everything here is pure: the component holds the list, these functions
 * say what it means against the sigil and the runes the character owns.
 */

export type RuneOrigin = 'sigil' | 'bag' | 'stash';

/** Rune items the character can draw from, in the order the server takes them. */
export interface RuneStock {
  bag: RuneItem[];
  stash: RuneItem[];
  /** The builders' free bench: every castable plain rune, as many as wanted, bound and free. */
  bench: boolean;
}

export type PriceOf = (rune: RuneItem) => number;

function uniqueRunes(cells: readonly (ItemUid | null)[], inv: InventoryMessage): RuneItem[] {
  const out: RuneItem[] = [];
  const seen = new Set<ItemUid>();
  for (const uid of cells) {
    if (uid === null || seen.has(uid)) continue;
    seen.add(uid);
    const item = inv.items.find((i) => i.uid === uid);
    // Runes the engine cannot run never drop, but a stray one must not reach the pool either.
    if (item?.kind === 'rune' && isCastableRune(item.rune)) out.push(item);
  }
  return out;
}

/** Stash runes in the order the server draws plain ones: the rune tab, then general tabs. */
export function runeStock(inv: InventoryMessage, bench = false): RuneStock {
  const stash = [...uniqueRunes(inv.stash.runes.list, inv), ...inv.stash.general.flatMap((t) => uniqueRunes(t.cells, inv))];
  return { bag: uniqueRunes(inv.inventory, inv), stash, bench };
}

export function keepAll(sigil: SigilItem): RuneRef[] {
  return sigil.slots.map((_, index) => ({ from: 'keep', index }));
}

export function sameDraft(a: readonly RuneRef[], b: readonly RuneRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => refKey(r) === refKey(b[i]));
}

export function refKey(r: RuneRef | undefined): string {
  if (!r) return '';
  if (r.from === 'keep') return `k${r.index}`;
  if (r.from === 'plain') return `p${r.rune}${r.implicit ? `:${r.implicit.tier}:${r.implicit.value}` : ''}`;
  return `r${r.uid}`;
}

export interface ResolvedSlot {
  ref: RuneRef;
  /** The rune that would sit in the slot (count 1). */
  item: RuneItem;
  origin: RuneOrigin;
  price: number;
}

export interface Resolution {
  slots: ResolvedSlot[];
  /** The refs that still point at something; anything else was dropped (the item moved away). */
  valid: RuneRef[];
  /**
   * Current slots not kept, as they come back out: rolls brought into the loot table, and bench
   * runes left out since they are gone once they leave a sigil.
   */
  refunds: RuneItem[];
  /** Rolls the refunds lose on the way out, one row per roll. */
  refundWeakened: { rune: RuneId; before: AffixRoll; after: AffixRoll }[];
  /** Bench runes taken out, which are not handed back. */
  benchGone: number;
  price: number;
  /** Bag cells the inserts free up: rolled runes taken from the bag, and plain stacks used up. */
  freedBagCells: number;
}

/**
 * The server takes a plain rune from the bag first, bound stacks first, then the rune tab's stacks,
 * then stacks in general tabs (runeStock lists the stash in that order). Mirrored
 * here so the price and the stash marker show what will really be taken.
 */
function plainSources(stock: RuneStock, rune: RuneId, implicit: RuneRefImplicit | undefined): RuneItem[] {
  const matches = (r: RuneItem): boolean => r.rune === rune && isPlainRune(r) && (implicit === undefined || sameImplicit(runeImplicit(r), implicit));
  const bag = stock.bag.filter(matches);
  const stash = stock.stash.filter(matches);
  return [...bag.filter((r) => r.bound), ...bag.filter((r) => !r.bound), ...stash];
}

function sameImplicit(a: AffixRoll | null, b: RuneRefImplicit | undefined): boolean {
  return a === null ? b === undefined : b !== undefined && a.tier === b.tier && a.value === b.value;
}

/** Plain runes pool by rune and implicit, since they stack by both. */
function plainKey(rune: RuneId, implicit: RuneRefImplicit | null | undefined): string {
  return implicit ? `${rune}:${implicit.tier}:${implicit.value}` : rune;
}

export function resolveDraft(sigil: SigilItem, draft: readonly RuneRef[], stock: RuneStock, priceOf: PriceOf): Resolution {
  const slots: ResolvedSlot[] = [];
  const valid: RuneRef[] = [];
  const keptIndex = new Set<number>();
  const usedRolled = new Set<ItemUid>();
  const taken = new Map<ItemUid, number>();
  let freedBagCells = 0;
  const bagUids = new Set(stock.bag.map((r) => r.uid));

  for (const ref of draft) {
    if (ref.from === 'keep') {
      const item = sigil.slots[ref.index];
      if (!item || keptIndex.has(ref.index)) continue;
      keptIndex.add(ref.index);
      slots.push({ ref, item, origin: 'sigil', price: 0 });
      valid.push(ref);
      continue;
    }
    if (ref.from === 'rolled') {
      if (usedRolled.has(ref.uid)) continue;
      const inBag = stock.bag.find((r) => r.uid === ref.uid && !isPlainRune(r));
      const item = inBag ?? stock.stash.find((r) => r.uid === ref.uid && !isPlainRune(r));
      if (!item) continue;
      usedRolled.add(ref.uid);
      if (inBag) freedBagCells++;
      slots.push({ ref, item, origin: inBag ? 'bag' : 'stash', price: stock.bench ? 0 : priceOf(item) });
      valid.push(ref);
      continue;
    }
    if (stock.bench) {
      // The bench makes its runes fresh, with the neutral implicit.
      const item = { ...createRune(-1, ref.rune), bound: true, bench: true };
      slots.push({ ref, item, origin: 'bag', price: 0 });
      valid.push(ref);
      continue;
    }
    const source = plainSources(stock, ref.rune, ref.implicit).find((r) => (taken.get(r.uid) ?? 0) < r.count);
    if (!source) continue;
    const used = (taken.get(source.uid) ?? 0) + 1;
    taken.set(source.uid, used);
    if (bagUids.has(source.uid) && used === source.count) freedBagCells++;
    const one: RuneItem = { ...source, count: 1 };
    slots.push({ ref, item: one, origin: bagUids.has(source.uid) ? 'bag' : 'stash', price: priceOf(one) });
    valid.push(ref);
  }

  const out = sigil.slots.filter((_, i) => !keptIndex.has(i));
  const back = out.filter((r) => r.bench !== true);
  const refundWeakened = back.flatMap((r) => rollLosses(r).map((l) => ({ rune: r.rune, ...l })));
  return { slots, valid, refunds: back.map(clampRuneRolls), refundWeakened, benchGone: out.length - back.length, price: slots.reduce((sum, s) => sum + s.price, 0), freedBagCells };
}

export interface PlainEntry {
  rune: RuneId;
  /** The implicit every rune of this entry carries: plain runes stack, and so pool, by it. */
  implicit: AffixRoll | null;
  /** The rune and implicit, unique per entry. */
  key: string;
  /** Plain runes of this id taken out of the sigil in this draft; putting one back is free. */
  loose: number;
  bag: number;
  stash: number;
  /** Bench only: no limit. */
  unlimited: boolean;
}

export interface RolledEntry {
  item: RuneItem;
  origin: RuneOrigin;
  ref: RuneRef;
}

export interface Pool {
  plain: PlainEntry[];
  rolled: RolledEntry[];
}

/** What is left to add: owned runes minus the draft, plus whatever the draft took out of the sigil. */
export function buildPool(sigil: SigilItem, draft: readonly RuneRef[], stock: RuneStock): Pool {
  const kept = new Set(draft.flatMap((r) => (r.from === 'keep' ? [r.index] : [])));
  const plainUsed = new Map<string, number>();
  for (const r of draft) if (r.from === 'plain') plainUsed.set(plainKey(r.rune, r.implicit), (plainUsed.get(plainKey(r.rune, r.implicit)) ?? 0) + 1);
  const rolledUsed = new Set(draft.flatMap((r) => (r.from === 'rolled' ? [r.uid] : [])));

  // Each pool entry is a rune with one implicit; `kinds` keeps its rune and implicit by key.
  const kinds = new Map<string, { rune: RuneId; implicit: AffixRoll | null }>();
  const keyOf = (r: RuneItem): string => {
    const implicit = runeImplicit(r);
    const key = plainKey(r.rune, implicit);
    if (!kinds.has(key)) kinds.set(key, { rune: r.rune, implicit });
    return key;
  };
  const loose = new Map<string, number>();
  const rolled: RolledEntry[] = [];
  sigil.slots.forEach((item, index) => {
    if (kept.has(index)) return;
    if (isPlainRune(item)) loose.set(keyOf(item), (loose.get(keyOf(item)) ?? 0) + 1);
    else rolled.push({ item, origin: 'sigil', ref: { from: 'keep', index } });
  });

  const counts = new Map<string, { bag: number; stash: number }>();
  const add = (r: RuneItem, where: 'bag' | 'stash'): void => {
    if (isPlainRune(r)) {
      const key = keyOf(r);
      const c = counts.get(key) ?? { bag: 0, stash: 0 };
      c[where] += r.count;
      counts.set(key, c);
    } else if (!rolledUsed.has(r.uid)) rolled.push({ item: r, origin: where, ref: { from: 'rolled', uid: r.uid } });
  };
  for (const r of stock.bag) add(r, 'bag');
  for (const r of stock.stash) add(r, 'stash');

  // The bench makes every castable rune fresh, with the neutral implicit.
  if (stock.bench) for (const rune of CASTABLE_RUNES) kinds.set(plainKey(rune, neutralImplicit(rune)), { rune, implicit: neutralImplicit(rune) });
  const keys: readonly string[] = stock.bench ? CASTABLE_RUNES.map((r) => plainKey(r, neutralImplicit(r))) : [...new Set([...counts.keys(), ...loose.keys()])];
  const plain: PlainEntry[] = [];
  for (const key of keys) {
    const kind = kinds.get(key);
    if (!kind || !isCastableRune(kind.rune)) continue;
    const c = counts.get(key) ?? { bag: 0, stash: 0 };
    // Bag first, as the server takes them; whatever the draft uses comes off the bag count first.
    let used = plainUsed.get(key) ?? 0;
    const fromBag = Math.min(c.bag, used);
    used -= fromBag;
    const entry: PlainEntry = { rune: kind.rune, implicit: kind.implicit, key, loose: loose.get(key) ?? 0, bag: c.bag - fromBag, stash: Math.max(0, c.stash - used), unlimited: stock.bench };
    if (entry.unlimited || entry.loose + entry.bag + entry.stash > 0) plain.push(entry);
  }
  // By rune, then the better implicit first.
  plain.sort((a, b) => (POOL_ORDER.get(a.rune) ?? 0) - (POOL_ORDER.get(b.rune) ?? 0) || (b.implicit?.value ?? 0) - (a.implicit?.value ?? 0));
  return { plain, rolled };
}

const POOL_ORDER = new Map<string, number>(CASTABLE_RUNES.map((id, i) => [id, i]));

/** Adding a plain rune puts back one the draft took out of this sigil first (free), then draws from the stock. */
export function plainRef(sigil: SigilItem, draft: readonly RuneRef[], entry: PlainEntry): RuneRef | null {
  const kept = new Set(draft.flatMap((r) => (r.from === 'keep' ? [r.index] : [])));
  const index = sigil.slots.findIndex((item, i) => !kept.has(i) && item.rune === entry.rune && isPlainRune(item) && plainKey(item.rune, runeImplicit(item)) === entry.key);
  if (index >= 0) return { from: 'keep', index };
  if (entry.unlimited) return { from: 'plain', rune: entry.rune };
  // The ref names the implicit, so the server takes from the stacks the player picked.
  if (entry.bag + entry.stash > 0) return entry.implicit ? { from: 'plain', rune: entry.rune, implicit: { tier: entry.implicit.tier, value: entry.implicit.value } } : { from: 'plain', rune: entry.rune };
  return null;
}

export function insertAt(draft: readonly RuneRef[], ref: RuneRef, at: number): RuneRef[] {
  const out = [...draft];
  out.splice(Math.max(0, Math.min(at, out.length)), 0, ref);
  return out;
}

export function removeAt(draft: readonly RuneRef[], at: number): RuneRef[] {
  return draft.filter((_, i) => i !== at);
}

/** Moves one slot so it ends up at `to` in the new list. */
export function moveSlot(draft: readonly RuneRef[], from: number, to: number): RuneRef[] {
  const ref = draft[from];
  if (!ref || from === to) return [...draft];
  const out = removeAt(draft, from);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, ref);
  return out;
}

/**
 * How many refunds will not fit in the bag and wait as pending instead. An estimate of the
 * server's placement: a plain rune tops up a bag stack of the same rune and binding first, anything
 * else takes a free cell (every rune is one cell).
 */
export function refundOverflow(inv: InventoryMessage, stock: RuneStock, res: Resolution): number {
  if (res.refunds.length === 0) return 0;
  let free = inv.inventory.filter((c) => c === null).length + res.freedBagCells;
  const room = new Map<string, number>();
  // Plain runes stack by rune, binding and implicit, as the server tops them up.
  const stackKey = (r: RuneItem): string => `${plainKey(r.rune, runeImplicit(r))}:${r.bound ? 1 : 0}`;
  for (const r of stock.bag) {
    if (!isPlainRune(r)) continue;
    const key = stackKey(r);
    room.set(key, (room.get(key) ?? 0) + Math.max(0, RUNE_STACK - r.count));
  }
  let overflow = 0;
  for (const r of res.refunds) {
    const key = stackKey(r);
    const left = room.get(key) ?? 0;
    if (isPlainRune(r) && left > 0) room.set(key, left - 1);
    else if (free > 0) free--;
    else overflow++;
  }
  return overflow;
}

/** The sigil as it would be after the save, for the compiler and the preview. */
export function draftSigil(sigil: SigilItem, res: Resolution): SigilItem {
  return { ...sigil, slots: res.slots.map((s) => ({ ...s.item, count: 1 })) };
}
