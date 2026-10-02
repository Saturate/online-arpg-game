import { isAffixId } from '../data/affixes.js';
import { isMinionTypeId } from '../data/minions.js';
import type { GearCategory } from '../data/gear.js';
import { isRuneId } from '../runes/v2/runes.js';
import { ITEM_TIERS, SIGIL_MAX_SLOTS, type AffixRoll, type Item, type ItemTier, type ItemUid, type RuneItem } from '../items/items.js';

/**
 * Item links in chat. The client sends only uids and `{n}` tokens in the text; the server looks
 * each uid up in the sender's own items and sends a display-only copy beside the text. The copy
 * carries negative uids, which every item command's validator refuses, so it can never be picked
 * up, moved or traded even if a client tried.
 */
export const CHAT_LINKS = {
  /** Per message, counting each token, so repeating one link cannot fill a line with tooltips. */
  max: 3,
  /** Real items roll at most 5; the cap only bounds what a receiver will accept. */
  maxAffixes: 12,
  nameMax: 80,
  loreMax: 300,
  /** Item names, base ids and starter ids are short; anything longer is not one of ours. */
  idMax: 48,
} as const;

/** `{1}` to `{3}` mark where a link sits; any other digit in braces is not a link. */
const TOKEN = /\{(\d)\}/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTier(v: unknown): v is ItemTier {
  return typeof v === 'string' && ITEM_TIERS.some((t) => t === v);
}

const GEAR_CATEGORIES: readonly GearCategory[] = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring'];
function isGearCategory(v: unknown): v is GearCategory {
  return typeof v === 'string' && GEAR_CATEGORIES.some((c) => c === v);
}

function isUid(v: unknown): v is ItemUid {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** The uids a chat message links, or null when the list is malformed or too long. */
export function parseChatLinkUids(value: unknown): ItemUid[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CHAT_LINKS.max) return null;
  const out: ItemUid[] = [];
  for (const v of value) {
    if (!isUid(v)) return null;
    out.push(v);
  }
  return out;
}

function copyAffix(a: AffixRoll): AffixRoll {
  return a.max === undefined ? { id: a.id, tier: a.tier, value: a.value } : { id: a.id, tier: a.tier, value: a.value, max: a.max };
}

function copyAffixes(affixes: readonly AffixRoll[]): AffixRoll[] {
  return affixes.map(copyAffix);
}

function copyRune(r: RuneItem, uid: number): RuneItem {
  const out: RuneItem = { uid, kind: 'rune', tier: r.tier, name: r.name, ilvl: r.ilvl, rune: r.rune, count: r.count, affixes: copyAffixes(r.affixes) };
  if (r.implicit) out.implicit = copyAffix(r.implicit);
  if (r.bound) out.bound = true;
  if (r.bench) out.bench = true;
  return out;
}

/**
 * What other players see of a linked item. Fields are listed by hand rather than spread, so a field
 * added to items later stays private until someone decides it may be shown.
 */
export function linkCopy(item: Item): Item {
  switch (item.kind) {
    case 'gear': {
      const out: Item = { uid: -1, kind: 'gear', tier: item.tier, name: item.name, ilvl: item.ilvl, base: item.base, category: item.category, affixes: copyAffixes(item.affixes) };
      if (item.bound) out.bound = true;
      return out;
    }
    case 'vessel': {
      const out: Item = { uid: -1, kind: 'vessel', tier: item.tier, name: item.name, minion: item.minion, level: item.level, ilvl: item.ilvl, affixes: copyAffixes(item.affixes) };
      if (item.bound) out.bound = true;
      if (item.pack !== undefined) out.pack = item.pack;
      if (item.fixedName) out.fixedName = true;
      if (item.lore !== undefined) out.lore = item.lore;
      return out;
    }
    case 'sigil': {
      // Inscribed runes get their own negative uids, so React keys stay unique in the tooltip.
      const out: Item = { uid: -1, kind: 'sigil', tier: item.tier, name: item.name, ilvl: item.ilvl, affixes: copyAffixes(item.affixes), slots: item.slots.map((r, i) => copyRune(r, -2 - i)), corrupted: item.corrupted };
      if (item.bound) out.bound = true;
      if (item.starter !== undefined) out.starter = item.starter;
      return out;
    }
    case 'rune':
      return copyRune(item, -1);
  }
}

function isShortText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isLevel(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1000;
}

function isAffixRoll(a: unknown): a is AffixRoll {
  if (!isRecord(a) || typeof a.id !== 'string' || !isAffixId(a.id) || !isLevel(a.tier) || typeof a.value !== 'number' || !Number.isFinite(a.value)) return false;
  // A ranged roll's high end, above its low end.
  return a.max === undefined || (typeof a.max === 'number' && Number.isFinite(a.max) && a.max > a.value);
}

function isAffixList(v: unknown): v is AffixRoll[] {
  return Array.isArray(v) && v.length <= CHAT_LINKS.maxAffixes && v.every(isAffixRoll);
}

function isLinkedRune(v: unknown): v is RuneItem {
  if (!isRecord(v) || v.kind !== 'rune' || typeof v.rune !== 'string' || !isRuneId(v.rune) || !isLevel(v.count) || v.count < 1) return false;
  if (v.implicit !== undefined && !isAffixRoll(v.implicit)) return false;
  return (v.bound === undefined || typeof v.bound === 'boolean') && (v.bench === undefined || typeof v.bench === 'boolean');
}

/**
 * A display copy as the receiving client checks it. The tooltip reads every field, so each one is
 * checked against what real items hold, and a real uid (zero or above) means it is not a copy.
 */
export function isLinkedItem(v: unknown): v is Item {
  if (!isRecord(v) || typeof v.uid !== 'number' || !Number.isSafeInteger(v.uid) || v.uid >= 0) return false;
  if (!isTier(v.tier) || !isShortText(v.name, CHAT_LINKS.nameMax) || !isLevel(v.ilvl) || !isAffixList(v.affixes)) return false;
  if (v.bound !== undefined && typeof v.bound !== 'boolean') return false;
  switch (v.kind) {
    case 'gear':
      return isShortText(v.base, CHAT_LINKS.idMax) && isGearCategory(v.category);
    case 'vessel':
      if (!isMinionTypeId(v.minion) || !isLevel(v.level)) return false;
      if (v.pack !== undefined && !isLevel(v.pack)) return false;
      if (v.fixedName !== undefined && typeof v.fixedName !== 'boolean') return false;
      return v.lore === undefined || (typeof v.lore === 'string' && v.lore.length <= CHAT_LINKS.loreMax);
    case 'sigil':
      if (typeof v.corrupted !== 'boolean' || (v.starter !== undefined && !isShortText(v.starter, CHAT_LINKS.idMax))) return false;
      return Array.isArray(v.slots) && v.slots.length <= SIGIL_MAX_SLOTS && v.slots.every((r) => isLinkedItem(r) && isLinkedRune(r));
    case 'rune':
      return isLinkedRune(v);
    default:
      return false;
  }
}

/**
 * The server's half: keeps the tokens whose uid is one of the sender's items (`lookup` searches only
 * them), renumbers them in order of first use, and removes every other token, so any `{n}` a receiver
 * finds in the text is a link the server made. A copy that fails the receivers' check is dropped
 * here rather than sent, so one odd item cannot get a whole line refused.
 */
export function resolveChatLinks(text: string, uids: readonly ItemUid[], lookup: (uid: ItemUid) => Item | undefined): { text: string; items: Item[] } {
  const items: Item[] = [];
  const index = new Map<number, number>();
  let used = 0;
  const out = text.replace(TOKEN, (_, digit: string) => {
    const n = Number(digit);
    const uid = n >= 1 ? uids[n - 1] : undefined;
    if (uid === undefined || used >= CHAT_LINKS.max) return '';
    let at = index.get(uid);
    if (at === undefined) {
      const found = lookup(uid);
      const copy = found ? linkCopy(found) : null;
      if (!copy || !isLinkedItem(copy)) return '';
      items.push(copy);
      at = items.length;
      index.set(uid, at);
    }
    used++;
    return `{${at}}`;
  });
  return { text: out.replace(/ {2,}/g, ' ').trim(), items };
}

export type ChatSegment = string | Item;

/** The receiver's half: the text split around its link tokens, for rendering as text and links. */
export function chatSegments(text: string, items: readonly Item[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const item = items[Number(m[1]) - 1];
    if (!item || m.index === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(item);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Plain text with each link as `[Name]`, for speech bubbles and anywhere without tooltips. */
export function chatPlainText(text: string, items: readonly Item[]): string {
  return chatSegments(text, items)
    .map((s) => (typeof s === 'string' ? s : `[${s.name}]`))
    .join('');
}
