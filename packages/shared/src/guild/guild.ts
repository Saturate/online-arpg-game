import { GUILD_LIMITS } from '../config/guild.js';
import { isStashColorId, isStashTabName, type StashColorId } from '../config/stash.js';
import { convertRuneRolls, type RuneRollsReport } from '../items/convertRuneRolls.js';
import { isRuneTiers6 } from '../items/convertV2.js';
import { isRuneImplicits1, loadImplicits, type ImplicitsReport } from '../items/convertImplicits.js';
import { canPlace, emptyGrid, findSpot, itemSize, place, placements, removeFrom, STASH } from '../items/grid.js';
import { reissueUids, type Item, type ItemUid } from '../items/items.js';
import { isItemShape } from '../items/stash.js';

/**
 * Guilds (docs/features/guilds.md): ranks and their powers, names and tags, and the guild stash.
 * The stash is one object per guild, held by the server's guild service rather than by any room,
 * so members in different rooms and world copies all act on the same one. Every rule here checks
 * before it changes anything, so a refusal leaves the stash as it was.
 */

export const GUILD_RANKS = ['leader', 'officer', 'member'] as const;
export type GuildRank = (typeof GUILD_RANKS)[number];
/** The ranks whose stash access is set per tab; the Leader can always do everything. */
export const MANAGED_RANKS = ['officer', 'member'] as const;
export type ManagedRank = (typeof MANAGED_RANKS)[number];

export function isGuildRank(v: unknown): v is GuildRank {
  return typeof v === 'string' && GUILD_RANKS.some((r) => r === v);
}

export function isManagedRank(v: unknown): v is ManagedRank {
  return typeof v === 'string' && MANAGED_RANKS.some((r) => r === v);
}

export const GUILD_RANK_NAMES: Record<GuildRank, string> = { leader: 'Leader', officer: 'Officer', member: 'Member' };

/** Lower is higher: the Leader is 0. */
export function rankOrder(rank: GuildRank): number {
  return GUILD_RANKS.indexOf(rank);
}

export type GuildPower = 'invite' | 'kick' | 'promote' | 'demote' | 'transfer' | 'disband' | 'manageTabs' | 'motd';

/**
 * Leader: everything. Officer: invites, kicks Members, manages stash tabs (buy, rename, recolour,
 * permissions) and the message of the day. Member: the stash, as each tab allows. Only the Leader
 * promotes a Member to Officer, demotes one, hands leadership on and disbands.
 */
const POWERS: Record<GuildRank, readonly GuildPower[]> = {
  leader: ['invite', 'kick', 'promote', 'demote', 'transfer', 'disband', 'manageTabs', 'motd'],
  officer: ['invite', 'kick', 'manageTabs', 'motd'],
  member: [],
};

export function guildCan(rank: GuildRank, power: GuildPower): boolean {
  return POWERS[rank].includes(power);
}

/** A kick needs the power and a target ranked below the kicker: an Officer kicks Members only. */
export function canKick(actor: GuildRank, target: GuildRank): boolean {
  return guildCan(actor, 'kick') && rankOrder(target) > rankOrder(actor);
}

// Names and tags --------------------------------------------------------------------------------

/**
 * Tags and names other players would read as staff or the game speaking. The codebase has no
 * profanity filter for character names either (chat-and-parties.md); this list only guards
 * against impersonation. Compared without case, a tag whole and a name word by word.
 */
const RESERVED = ['admin', 'admins', 'adm', 'mod', 'mods', 'moderator', 'gm', 'gms', 'staff', 'owner', 'dev', 'devs', 'developer', 'sys', 'sysop', 'system', 'server', 'official', 'support'];

export const GUILD_TAG_PATTERN = /^[A-Za-z0-9]+$/;
export const GUILD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 '-]*$/;

/** Why a tag cannot be used, or null. 2 to 5 letters or digits, never a reserved word. */
export function guildTagProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < GUILD_LIMITS.tagMin || v.length > GUILD_LIMITS.tagMax || !GUILD_TAG_PATTERN.test(v)) {
    return `Tags are ${GUILD_LIMITS.tagMin} to ${GUILD_LIMITS.tagMax} letters or digits`;
  }
  if (RESERVED.includes(v.toLowerCase())) return 'That tag is reserved';
  return null;
}

/** Why a guild name cannot be used, or null. 3 to 24 characters, a letter first, single spaces. */
export function guildNameProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < GUILD_LIMITS.nameMin || v.length > GUILD_LIMITS.nameMax || v !== v.trim() || v.includes('  ') || !GUILD_NAME_PATTERN.test(v)) {
    return `Guild names are ${GUILD_LIMITS.nameMin} to ${GUILD_LIMITS.nameMax} letters, digits, spaces, ' or -, starting with a letter`;
  }
  if (v.toLowerCase().split(/[ '-]+/).some((w) => RESERVED.includes(w))) return 'That name is reserved';
  return null;
}

/** The message of the day as stored: whitespace collapsed, control characters gone, capped. Empty clears it. */
export function cleanMotd(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, GUILD_LIMITS.motdMax);
}

// The guild stash -----------------------------------------------------------------------------

export interface TabPerms {
  view: boolean;
  deposit: boolean;
  withdraw: boolean;
}

/** A guild stash tab: a STASH-sized grid like a personal general tab, with access per rank. */
export interface GuildTab {
  /** Stable across renames; 1 for the free tab, then one more per tab bought. */
  id: number;
  name: string;
  color: StashColorId;
  cells: (ItemUid | null)[];
  perms: Record<ManagedRank, TabPerms>;
}

/**
 * The guild stash in memory. Item uids are the guild's own (`nextUid` counts them, sigil runes
 * included), apart from every room's: an item gets fresh uids on the way in and on the way out,
 * as every stored item does, so no uid ever names two things.
 */
export interface GuildStash {
  tabs: GuildTab[];
  items: Map<ItemUid, Item>;
  nextUid: number;
}

/** As stored in `guilds.stash_json`. Carries the item format markers every stored item list does. */
export interface GuildStashSave {
  guildStashFormat: 1;
  runeFormat: 2;
  runeTiers: 6;
  /** Every rune carries its implicit (rune phase 2); rows without it take the implicit pass once. */
  runeImplicits: 1;
  nextUid: number;
  tabs: GuildTab[];
  items: Item[];
}

/**
 * Deposit and withdraw imply view: a tab you cannot see you cannot drop into or take from. Everything
 * off hides the tab.
 */
export function normalisePerms(p: TabPerms): TabPerms {
  const view = p.view || p.deposit || p.withdraw;
  return { view, deposit: p.deposit, withdraw: p.withdraw };
}

const ALL: TabPerms = { view: true, deposit: true, withdraw: true };

/** Officers do everything; Members see and add but do not take, until an Officer allows it. */
export function newGuildTab(id: number): GuildTab {
  return { id, name: `Tab ${id}`, color: 'ash', cells: emptyGrid(STASH), perms: { officer: { ...ALL }, member: { view: true, deposit: true, withdraw: false } } };
}

export function emptyGuildStash(): GuildStash {
  return { tabs: [newGuildTab(1)], items: new Map(), nextUid: 1 };
}

/** What a rank may do in a tab. */
export function tabAccess(tab: GuildTab, rank: GuildRank): TabPerms {
  return rank === 'leader' ? { ...ALL } : { ...tab.perms[rank] };
}

/** A copy whose tabs and item map can change without touching `s`; items are shared, they are never edited in place. */
export function cloneGuildStash(s: GuildStash): GuildStash {
  return { tabs: s.tabs.map((t) => ({ ...t, cells: [...t.cells], perms: { officer: { ...t.perms.officer }, member: { ...t.perms.member } } })), items: new Map(s.items), nextUid: s.nextUid };
}

export function guildTab(s: GuildStash, id: number): GuildTab | undefined {
  return s.tabs.find((t) => t.id === id);
}

export function locateGuildItem(s: GuildStash, uid: ItemUid): GuildTab | null {
  return s.tabs.find((t) => t.cells.includes(uid)) ?? null;
}

/** Items that sit in no tab (rune roll returns that found no room); retried on load and after every take. */
export function unplacedGuildItems(s: GuildStash): Item[] {
  const placed = new Set<ItemUid | null>(s.tabs.flatMap((t) => t.cells));
  return [...s.items.values()].filter((i) => !placed.has(i.uid));
}

/**
 * Gives an incoming item the guild's own uids. The caller removes the original from the character
 * in the same step, so the item exists once.
 */
export function intoGuild(s: GuildStash, item: Item): Item {
  if (!Number.isSafeInteger(s.nextUid)) throw new Error('guild stash: the uid counter is broken');
  return reissueUids(item, () => s.nextUid++);
}

/**
 * Puts a guild item (already under guild uids) into a tab: on the cell `at` (its top-left), or the
 * first free spot. Refuses rather than changes anything when it does not fit.
 */
export function guildPlace(s: GuildStash, tabId: number, item: Item, at: { x: number; y: number } | null): string | null {
  const tab = guildTab(s, tabId);
  if (!tab) return 'No such guild tab';
  const size = itemSize(item);
  const spot = at ? (canPlace(tab.cells, STASH, size, at.x, at.y, s.items.has(item.uid) ? item.uid : null) ? at : null) : findSpot(tab.cells, STASH, size);
  if (!spot) return at ? 'No room there' : 'No room in that guild tab';
  for (const t of s.tabs) removeFrom(t.cells, item.uid);
  place(tab.cells, STASH, item.uid, size, spot.x, spot.y);
  s.items.set(item.uid, item);
  return null;
}

/** Takes an item out of the stash and returns it, or null when it is not there. */
export function guildTake(s: GuildStash, uid: ItemUid): Item | null {
  const item = s.items.get(uid);
  if (!item) return null;
  for (const t of s.tabs) removeFrom(t.cells, uid);
  s.items.delete(uid);
  return item;
}

/** Lays unplaced items into the first tab with room, in tab order. What still fits nowhere stays unplaced. */
export function placeUnplaced(s: GuildStash): void {
  for (const item of unplacedGuildItems(s)) {
    for (const tab of s.tabs) if (guildPlace(s, tab.id, item, null) === null) break;
  }
}

export function serializeGuildStash(s: GuildStash): GuildStashSave {
  return { guildStashFormat: 1, runeFormat: 2, runeTiers: 6, runeImplicits: 1, nextUid: s.nextUid, tabs: s.tabs.map((t) => ({ ...t, cells: [...t.cells] })), items: [...s.items.values()] };
}

// Reading stored data --------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(what: string): never {
  throw new Error(`guild stash: ${what}`);
}

function parsePerms(v: unknown): TabPerms {
  if (!isRecord(v)) fail('tab permissions are damaged');
  return normalisePerms({ view: v.view === true, deposit: v.deposit === true, withdraw: v.withdraw === true });
}

export interface GuildStashLoad {
  stash: GuildStash;
  /** The rune roll pass or the implicit pass ran (the row predates a marker): write the row back. */
  converted: boolean;
  rolls: RuneRollsReport | null;
  /** The implicit pass's report, when it ran. */
  implicits: ImplicitsReport | null;
  warnings: string[];
}

/**
 * A stored guild stash. Anything that says where an item is must read cleanly or the whole thing
 * throws, so a damaged row is never saved back with items missing; the server then refuses the
 * guild's stash and keeps the row for a human. A name or colour that no longer passes is reset.
 * Rows from before the six rune tiers go through the rune roll pass once, and rows without
 * `runeImplicits: 1` through the implicit pass after it, like every other stored item list
 * (items.md); runes the roll pass hands back join the stash.
 */
export function parseGuildStash(raw: unknown): GuildStashLoad {
  if (!isRecord(raw) || raw.guildStashFormat !== 1) fail('not guild stash format 1');
  if (raw.runeFormat !== 2) fail('not rune format 2');
  if (!Array.isArray(raw.items) || !Array.isArray(raw.tabs)) fail('items or tabs is not a list');
  const warnings: string[] = [];
  const stored = raw.items.map((it: unknown) => (isItemShape(it) ? it : fail(`item ${isRecord(it) ? String(it.uid) : '?'} is damaged`)));
  // Sigil runes take uids from the same counter, so a slot without a whole uid would turn the
  // counter into NaN and let two later deposits share one uid.
  const slotUids = new Set<ItemUid>();
  for (const it of stored) {
    if (it.kind !== 'sigil') continue;
    for (const r of it.slots) {
      const uid: unknown = isRecord(r) ? r.uid : undefined;
      if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0 || slotUids.has(uid)) fail(`sigil ${it.uid} holds a damaged rune`);
      slotUids.add(uid);
    }
  }
  for (const it of stored) if (slotUids.has(it.uid)) fail(`uid ${it.uid} is both an item and a sigil rune`);
  // Every load-time item conversion of a guild stash happens here, and serializeGuildStash writes
  // every marker: a new pass (and its marker) is added in these two places only.
  const rolls = isRuneTiers6(raw) ? null : convertRuneRolls(stored);
  // Runes the roll pass hands back go through the implicit pass with the rest.
  const returned = rolls?.returned ?? [];
  const implicits = loadImplicits(raw, [...(rolls ? rolls.items : stored), ...returned]);
  const items = implicits.items.slice(0, implicits.items.length - returned.length);
  const back = implicits.items.slice(implicits.items.length - returned.length);
  const byUid = new Map<ItemUid, Item>();
  let top = typeof raw.nextUid === 'number' && Number.isSafeInteger(raw.nextUid) && raw.nextUid >= 1 ? raw.nextUid : 1;
  const bump = (it: Item): void => {
    top = Math.max(top, it.uid + 1);
    if (it.kind === 'sigil') for (const r of it.slots) top = Math.max(top, r.uid + 1);
  };
  for (const it of items) {
    if (byUid.has(it.uid)) fail(`uid ${it.uid} appears twice`);
    byUid.set(it.uid, it);
    bump(it);
  }
  const seenTab = new Set<number>();
  const tabs = raw.tabs.map((t: unknown, i: number): GuildTab => {
    if (!isRecord(t) || typeof t.id !== 'number' || !Number.isSafeInteger(t.id) || t.id < 1 || t.id > GUILD_LIMITS.tabIdMax || seenTab.has(t.id)) fail(`tab ${i} is damaged`);
    seenTab.add(t.id);
    if (!Array.isArray(t.cells)) fail(`tab ${t.id} cells is not a list`);
    if (!isRecord(t.perms)) fail(`tab ${t.id} permissions are damaged`);
    return {
      id: t.id,
      name: isStashTabName(t.name) ? t.name : `Tab ${t.id}`,
      color: isStashColorId(t.color) ? t.color : 'ash',
      cells: t.cells.map((c: unknown) => (typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : null)),
      perms: { officer: parsePerms(t.perms.officer), member: parsePerms(t.perms.member) },
    };
  });
  if (tabs.length === 0) fail('no tabs');
  const stash: GuildStash = { tabs: tabs.map((t) => ({ ...t, cells: emptyGrid(STASH) })), items: byUid, nextUid: top };
  // Laid out again from the stored grids: each item takes the first tab naming it, at its stored
  // corner when that is still free, so a damaged grid can never put one item in two places.
  const used = new Set<ItemUid>();
  tabs.forEach((t, i) => {
    const target = stash.tabs[i];
    if (!target) return;
    const isGrid = t.cells.length === STASH.w * STASH.h;
    const order = isGrid ? placements(t.cells, STASH) : [...new Set(t.cells.filter((u): u is ItemUid => u !== null))].map((uid) => ({ uid, x: -1, y: -1 }));
    for (const { uid, x, y } of order) {
      const item = byUid.get(uid);
      if (!item) {
        warnings.push(`tab ${t.id} points at missing item ${uid}; cleared`);
        continue;
      }
      if (used.has(uid)) continue;
      const s = itemSize(item);
      const spot = isGrid && canPlace(target.cells, STASH, s, x, y) ? { x, y } : findSpot(target.cells, STASH, s);
      if (!spot) continue;
      place(target.cells, STASH, uid, s, spot.x, spot.y);
      used.add(uid);
    }
  });
  // A returned rune keeps the uid it had in its sigil: guild uids come from one counter, sigil runes
  // included, so it names nothing else, and `bump` already counted it.
  for (const r of back) if (!stash.items.has(r.uid)) stash.items.set(r.uid, r);
  placeUnplaced(stash);
  const left = unplacedGuildItems(stash).length;
  if (left > 0) warnings.push(`${left} items fit in no tab; they wait unplaced until room frees up`);
  return { stash, converted: rolls !== null || !isRuneImplicits1(raw), rolls: rolls?.report ?? null, implicits: isRuneImplicits1(raw) ? null : implicits.report, warnings };
}

// What the client sees -------------------------------------------------------------------------

/** One guild tab as a member sees it: their own access, and every rank's for those who manage tabs. */
export interface GuildTabView {
  id: number;
  name: string;
  color: StashColorId;
  /** Null when the viewer may not see inside it (the tab still shows, locked). */
  cells: (ItemUid | null)[] | null;
  access: TabPerms;
  /** Every managed rank's access, only for those who manage tabs. */
  perms?: Record<ManagedRank, TabPerms>;
}

export interface GuildStashView {
  tabs: GuildTabView[];
  /** Items of the tabs the viewer may see, and nothing else. */
  items: Item[];
  /** Gold for the next tab, or null at the cap. */
  tabPrice: number | null;
  /** Items in no tab, waiting for room (only after a load-time conversion found none). */
  unplaced: number;
}

export function guildStashView(s: GuildStash, rank: GuildRank, tabPrice: number | null): GuildStashView {
  const manager = guildCan(rank, 'manageTabs');
  const items: Item[] = [];
  const tabs = s.tabs.map((t): GuildTabView => {
    const access = tabAccess(t, rank);
    if (access.view) for (const { uid } of placements(t.cells, STASH)) {
      const it = s.items.get(uid);
      if (it) items.push(it);
    }
    return { id: t.id, name: t.name, color: t.color, cells: access.view ? [...t.cells] : null, access, ...(manager ? { perms: { officer: { ...t.perms.officer }, member: { ...t.perms.member } } } : {}) };
  });
  return { tabs, items, tabPrice, unplaced: unplacedGuildItems(s).length };
}
