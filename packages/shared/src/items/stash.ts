import { AFFIXES, isAffixId, type AffixId } from '../data/affixes.js';
import { isStashColorId, isStashTabName, STASH_TABS, type StashColorId } from '../config/stash.js';
import { isRuneId, RUNE_IDS, runeKind, type RuneKind } from '../runes/v2/runes.js';
import { canPlace, emptyGrid, findSpot, itemSize, place, placements, STASH } from './grid.js';
import { affixValue, holdsBoundRunes, isBound, isPlainRune, ITEM_TIERS, sigilCapacity, type Item, type ItemUid, type RuneItem, type SigilItem } from './items.js';

/**
 * The account stash in tabs (stash format 2). General tabs are STASH-sized grids like the bag. The
 * rune tab and the sigil tab are lists of items: rolled runes and plain stacks (each at most
 * RUNE_STACK, as in the bag) in one, sigils in the other. Every item in a grid or list lives in the
 * owner's items, so its uid is in exactly one place.
 */

export interface GeneralTab {
  kind: 'general';
  /** Stable across renames and sorts; 1 for the free tab, then one more per tab bought. */
  id: number;
  name: string;
  color: StashColorId;
  cells: (ItemUid | null)[];
}

export interface RuneTab {
  kind: 'runes';
  /** Rune items in the order last sorted; at most STASH_TABS.runeCap. */
  list: ItemUid[];
}

export interface SigilTab {
  kind: 'sigils';
  /** At most STASH_TABS.sigilCap. */
  list: ItemUid[];
}

/** Where every stash item sits. Carried by a character between rooms and sent to the client as it is. */
export interface StashLayout {
  stashFormat: 2;
  general: GeneralTab[];
  runes: RuneTab;
  sigils: SigilTab;
}

/** The account stash as stored, apart from any character. */
export interface StashSave extends StashLayout {
  runeFormat: 2;
  /**
   * Rune affix rolls count six tiers (2026-10-01). Required on what is written, so no writer can
   * leave it out and have the next load re-tier the row again; data read from storage may lack it
   * (StoredStash) and goes through convertRuneRolls once.
   */
  runeTiers: 6;
  /** Runes carry implicits (2026-10-02); a stash without it goes through the implicit pass once (convertImplicits). */
  runeImplicits: 1;
  items: Item[];
}

/** A stash as read from storage, before the one-time passes: it may predate the six tiers and implicits. */
export type StoredStash = Omit<StashSave, 'runeTiers' | 'runeImplicits'> & { runeTiers?: 6; runeImplicits?: 1 };

/** The stash before tabs: one grid. Only ever read, to be converted. */
export interface StashSaveV1 {
  items: Item[];
  cells: (ItemUid | null)[];
  runeFormat: 2;
}

/** Rune tab orders. `affix` sorts by one rune affix's value, which the message names. */
export const RUNE_SORT_KEYS = ['rune', 'kind', 'tier', 'ilvl', 'affix'] as const;
export type RuneSortKey = (typeof RUNE_SORT_KEYS)[number];
export const SIGIL_SORT_KEYS = ['tier', 'ilvl', 'slots', 'name'] as const;
export type SigilSortKey = (typeof SIGIL_SORT_KEYS)[number];
export type StashSortKey = RuneSortKey | SigilSortKey;

export function isRuneSortKey(v: unknown): v is RuneSortKey {
  return typeof v === 'string' && RUNE_SORT_KEYS.some((k) => k === v);
}

export function isSigilSortKey(v: unknown): v is SigilSortKey {
  return typeof v === 'string' && SIGIL_SORT_KEYS.some((k) => k === v);
}

/** An affix a rune can carry, the only kind the rune tab sorts by. */
export function isRuneAffixId(v: unknown): v is AffixId {
  return isAffixId(v) && AFFIXES[v].targets.includes('rune');
}

/** A tab as named in messages: a general tab by id, or the fixed rune and sigil tabs. */
export type StashTabRef = number | 'runes' | 'sigils';

export function newGeneralTab(id: number): GeneralTab {
  return { kind: 'general', id, name: `Tab ${id}`, color: 'ash', cells: emptyGrid(STASH) };
}

export function emptyStash(): StashLayout {
  return { stashFormat: 2, general: [newGeneralTab(1)], runes: { kind: 'runes', list: [] }, sigils: { kind: 'sigils', list: [] } };
}

/**
 * A stash from before tabs, held in a character save (a bag spill from before the account stash, or
 * the grid a room change carried): its one grid becomes tab 1, laid out again on load.
 */
export function legacyLayout(cells: readonly (ItemUid | null)[]): StashLayout {
  const l = emptyStash();
  const first = l.general[0];
  if (first && cells.length > 0) first.cells = [...cells];
  return l;
}

export function cloneLayout(l: StashLayout): StashLayout {
  return {
    stashFormat: 2,
    general: l.general.map((t) => ({ ...t, cells: [...t.cells] })),
    runes: { kind: 'runes', list: [...l.runes.list] },
    sigils: { kind: 'sigils', list: [...l.sigils.list] },
  };
}

export function generalTab(l: StashLayout, id: number): GeneralTab | undefined {
  return l.general.find((t) => t.id === id);
}

/** Every item uid the stash points at, each once. */
export function stashItemUids(l: StashLayout): ItemUid[] {
  const out = new Set<ItemUid>();
  for (const t of l.general) for (const u of t.cells) if (u !== null) out.add(u);
  for (const u of l.runes.list) out.add(u);
  for (const u of l.sigils.list) out.add(u);
  return [...out];
}

export type StashSpot = { at: 'tab'; tab: GeneralTab } | { at: 'runes' } | { at: 'sigils' };

export function locateInStash(l: StashLayout, uid: ItemUid): StashSpot | null {
  for (const tab of l.general) if (tab.cells.includes(uid)) return { at: 'tab', tab };
  if (l.runes.list.includes(uid)) return { at: 'runes' };
  if (l.sigils.list.includes(uid)) return { at: 'sigils' };
  return null;
}

/** Takes an item out of every stash place it is in (there is only ever one). */
export function removeFromStash(l: StashLayout, uid: ItemUid): void {
  for (const t of l.general) for (let i = 0; i < t.cells.length; i++) if (t.cells[i] === uid) t.cells[i] = null;
  l.runes.list = l.runes.list.filter((u) => u !== uid);
  l.sigils.list = l.sigils.list.filter((u) => u !== uid);
}

/** The shared account stash never holds anything bound, nor a sigil carrying bound runes. */
export function stashRefuses(item: Item): string | null {
  if (isBound(item)) return 'Bound items stay with this character';
  if (holdsBoundRunes(item)) return 'Take the bound runes out first';
  return null;
}

/**
 * A rune item the rune tab lists: a plain stack, or a rolled rune, which never stacks (a count on
 * one would be lost in a list that shows each as a single rune).
 */
export function isListableRune(item: Item): item is RuneItem {
  return item.kind === 'rune' && item.count >= 1 && (isPlainRune(item) || item.count === 1);
}

// Sorting the list tabs -------------------------------------------------------------------------

const tierRank = (i: Item): number => ITEM_TIERS.indexOf(i.tier);
const KIND_ORDER: readonly RuneKind[] = ['shape', 'infusion', 'shaper', 'effect', 'trigger', 'modifier'];

/**
 * Rune tab order. Every key falls back to grammar order, rolled before plain, then best tier and
 * item level first. By affix, runes carrying it come first, highest value first, the rest after.
 */
export function compareRunes(key: RuneSortKey, affix: AffixId | null = null): (a: RuneItem, b: RuneItem) => number {
  return (a, b) => {
    const byRune = RUNE_IDS.indexOf(a.rune) - RUNE_IDS.indexOf(b.rune);
    const byKind = KIND_ORDER.indexOf(runeKind(a.rune)) - KIND_ORDER.indexOf(runeKind(b.rune));
    const byRolled = Number(isPlainRune(a)) - Number(isPlainRune(b));
    const byTier = tierRank(b) - tierRank(a);
    const byIlvl = b.ilvl - a.ilvl;
    const has = (r: RuneItem): boolean => affix !== null && r.affixes.some((x) => x.id === affix);
    const byAffix = affix === null ? 0 : Number(has(b)) - Number(has(a)) || affixValue(b.affixes, affix) - affixValue(a.affixes, affix);
    const lead = key === 'kind' ? [byKind] : key === 'tier' ? [byTier] : key === 'ilvl' ? [byIlvl] : key === 'affix' ? [byAffix] : [];
    return [...lead, byRune, byRolled, byTier, byIlvl].find((d) => d !== 0) ?? a.uid - b.uid;
  };
}

export function compareSigils(key: SigilSortKey): (a: SigilItem, b: SigilItem) => number {
  return (a, b) => {
    const byTier = tierRank(b) - tierRank(a);
    const byIlvl = b.ilvl - a.ilvl;
    const bySlots = sigilCapacity(b) - sigilCapacity(a) || b.slots.length - a.slots.length;
    const byName = a.name.localeCompare(b.name);
    const order = key === 'tier' ? [byTier, byIlvl, byName] : key === 'ilvl' ? [byIlvl, byTier, byName] : key === 'slots' ? [bySlots, byTier, byName] : [byName, byTier, byIlvl];
    return order.find((d) => d !== 0) ?? a.uid - b.uid;
  };
}

// Reading stored data --------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUid(v: unknown): v is ItemUid {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function fail(what: string): never {
  throw new Error(`stash tabs: ${what}`);
}

/**
 * The server wrote these, so this is a shape check that catches an older build or a damaged row,
 * not an attack. Runes and sigils are checked a little deeper because the tabs sort and count them.
 */
export function isItemShape(v: unknown): v is Item {
  if (!isRecord(v) || !isUid(v.uid) || typeof v.name !== 'string' || typeof v.tier !== 'string' || typeof v.ilvl !== 'number' || !Array.isArray(v.affixes)) return false;
  if (v.kind === 'rune') return typeof v.rune === 'string' && isRuneId(v.rune) && typeof v.count === 'number' && Number.isInteger(v.count) && v.count >= 1;
  if (v.kind === 'sigil') return Array.isArray(v.slots) && typeof v.corrupted === 'boolean';
  return v.kind === 'gear' || v.kind === 'vessel';
}

function uidCells(v: unknown, what: string): (ItemUid | null)[] {
  if (!Array.isArray(v)) fail(`${what} is not a list`);
  return v.map((c: unknown) => (isUid(c) ? c : null));
}

function uidList(v: unknown, what: string): ItemUid[] {
  if (!Array.isArray(v)) fail(`${what} is not a list`);
  return v.map((c: unknown) => (isUid(c) ? c : fail(`${what} holds ${String(c)}`)));
}

/**
 * A stored layout (stash format 2), from an account row or a character save. Anything that says
 * where an item is must read cleanly or the whole thing throws, so a row is never saved back with
 * items missing. A name or colour that no longer passes is reset: it carries no items.
 */
export function parseStashLayout(raw: unknown): StashLayout {
  if (!isRecord(raw) || raw.stashFormat !== 2) fail('not stash format 2');
  if (!Array.isArray(raw.general)) fail('general tabs is not a list');
  const general = raw.general.map((t: unknown, i: number): GeneralTab => {
    if (!isRecord(t) || t.kind !== 'general' || typeof t.id !== 'number' || !Number.isSafeInteger(t.id) || t.id < 1) fail(`general tab ${i} is damaged`);
    return { kind: 'general', id: t.id, name: isStashTabName(t.name) ? t.name : `Tab ${t.id}`, color: isStashColorId(t.color) ? t.color : 'ash', cells: uidCells(t.cells, `general tab ${t.id}`) };
  });
  const runes = raw.runes;
  if (!isRecord(runes) || runes.kind !== 'runes') fail('rune tab is damaged');
  const sigils = raw.sigils;
  if (!isRecord(sigils) || sigils.kind !== 'sigils') fail('sigil tab is damaged');
  return { stashFormat: 2, general, runes: { kind: 'runes', list: uidList(runes.list, 'rune list') }, sigils: { kind: 'sigils', list: uidList(sigils.list, 'sigil list') } };
}

/**
 * The stash field of a character save: tabs, or a grid from before tabs, or nothing at all (saves
 * from before the stash). After the split it is always empty; it only holds items between rooms.
 */
export function saveStashLayout(raw: unknown): StashLayout {
  if (raw === undefined || raw === null) return emptyStash();
  if (Array.isArray(raw)) return legacyLayout(raw.map((c: unknown) => (isUid(c) ? c : null)));
  return parseStashLayout(raw);
}

export function parseStashSave(raw: unknown): StoredStash {
  if (!isRecord(raw) || raw.runeFormat !== 2) fail('not rune format 2');
  if (!Array.isArray(raw.items)) fail('items is not a list');
  const items = raw.items.map((it: unknown) => (isItemShape(it) ? it : fail(`item ${isRecord(it) ? String(it.uid) : '?'} is damaged`)));
  return { ...parseStashLayout(raw), runeFormat: 2, ...(raw.runeTiers === 6 ? { runeTiers: 6 } : {}), ...(raw.runeImplicits === 1 ? { runeImplicits: 1 } : {}), items };
}

export function isStashFormat2(raw: unknown): boolean {
  return isRecord(raw) && raw.stashFormat === 2;
}

// One-time conversion from the single grid --------------------------------------------------------

/** What converting one single-grid stash did, for the server log and the conversion check. */
export interface StashTabsReport {
  /** Rune items moved to the rune tab, and the runes they hold (a plain stack counts its count). */
  runesToTab: number;
  runeUnitsToTab: number;
  sigilsToTab: number;
  /** Runes and sigils that stay in general tab 1 instead of moving to their tab, by why. */
  stayed: { reason: 'over cap' | 'bound' | 'damaged'; count: number }[];
  warnings: string[];
}

function bump(rows: StashTabsReport['stayed'], reason: StashTabsReport['stayed'][number]['reason']): void {
  const row = rows.find((r) => r.reason === reason);
  if (row) row.count++;
  else rows.push({ reason, count: 1 });
}

/**
 * Turns a single-grid stash into tabs, once. The grid becomes general tab 1 with every item where it
 * was. Unbound rune items (plain stacks as they are, and rolled runes) and unbound sigils then move
 * to their tab's list in reading order, while the list has room; whatever does not move stays in
 * the grid. Nothing is merged or split, so every item keeps its uid. Items the grid does not show
 * (bound runes the rune conversion left for the joining character) stay in `items`, so loading hands
 * them to that character as before. Input is JSON, so it is checked: anything unreadable throws and
 * the row is kept for a human.
 *
 * One grid holds at most 120 items, fewer than either list's cap, so `caps` only changes anything
 * in a test of the over-cap path.
 */
export function convertStashTabs(raw: unknown, caps: { runeCap: number; sigilCap: number } = STASH_TABS): { stash: StoredStash; report: StashTabsReport } {
  const report: StashTabsReport = { runesToTab: 0, runeUnitsToTab: 0, sigilsToTab: 0, stayed: [], warnings: [] };
  if (isStashFormat2(raw)) return { stash: parseStashSave(raw), report };
  if (!isRecord(raw) || raw.runeFormat !== 2) fail('convert the runes first');
  if (!Array.isArray(raw.items)) fail('items is not a list');
  const items = raw.items.map((it: unknown) => (isItemShape(it) ? it : fail(`item ${isRecord(it) ? String(it.uid) : '?'} is damaged`)));
  const byUid = new Map<ItemUid, Item>();
  for (const it of items) {
    if (byUid.has(it.uid)) fail(`uid ${it.uid} appears twice`);
    byUid.set(it.uid, it);
  }
  const stored = uidCells(raw.cells, 'stash cells');
  const tab = newGeneralTab(1);
  // A grid of another size is packed in fresh, the way loading always has.
  const isGrid = stored.length === STASH.w * STASH.h;
  const order = isGrid ? placements(stored, STASH) : [...new Set(stored.filter((u): u is ItemUid => u !== null))].map((uid) => ({ uid, x: -1, y: -1 }));
  for (const { uid, x, y } of order) {
    const item = byUid.get(uid);
    if (!item) {
      report.warnings.push(`cell points at missing item ${uid}; cleared`);
      continue;
    }
    const s = itemSize(item);
    const spot = isGrid && canPlace(tab.cells, STASH, s, x, y) ? { x, y } : findSpot(tab.cells, STASH, s);
    if (spot) place(tab.cells, STASH, uid, s, spot.x, spot.y);
    else report.warnings.push(`item ${uid} has no cell; it waits as pending`);
  }
  const layout: StashLayout = { stashFormat: 2, general: [tab], runes: { kind: 'runes', list: [] }, sigils: { kind: 'sigils', list: [] } };
  const inGrid = new Set(tab.cells);
  for (const item of items) {
    if (!inGrid.has(item.uid) || (item.kind !== 'rune' && item.kind !== 'sigil')) continue;
    if (stashRefuses(item)) {
      bump(report.stayed, 'bound');
      continue;
    }
    if (item.kind === 'rune' && !isPlainRune(item) && item.count !== 1) {
      report.warnings.push(`rolled rune ${item.uid} has count ${item.count}; left in the grid`);
      bump(report.stayed, 'damaged');
      continue;
    }
    const list = item.kind === 'rune' ? layout.runes.list : layout.sigils.list;
    if (list.length >= (item.kind === 'rune' ? caps.runeCap : caps.sigilCap)) {
      bump(report.stayed, 'over cap');
      continue;
    }
    list.push(item.uid);
    for (let i = 0; i < tab.cells.length; i++) if (tab.cells[i] === item.uid) tab.cells[i] = null;
    if (item.kind === 'rune') {
      report.runesToTab++;
      report.runeUnitsToTab += item.count;
    } else report.sigilsToTab++;
  }
  return { stash: { ...layout, runeFormat: 2, items }, report };
}
