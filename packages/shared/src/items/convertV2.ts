import { AFFIXES, isAffixId } from '../data/affixes.js';
import { isClassId } from '../data/classes.js';
import { GEAR_SLOTS, type GearCategory, type GearSlot } from '../data/gear.js';
import { isMinionTypeId, STANCES, type Stance } from '../data/minions.js';
import { createStarterSigil, starterSigilById } from '../data/starterSigils.js';
import { isWaypointId } from '../world/worldPlan.js';
import type { TraderEntry } from '../protocol/messages.js';
import type { RuneId } from '../runes/v2/runes.js';
import { legacyLayout, saveStashLayout, type StashSaveV1 } from './stash.js';
import type { PlayerSave } from '../sim/simulation.js';
import { BAG, emptyGrid, findSpot, itemSize, place, STASH, type GridSize } from './grid.js';
import {
  createRune,
  isPlainRune,
  ITEM_TIERS,
  RUNE_STACK,
  sigilCapacity,
  type AffixRoll,
  type GearItem,
  type Item,
  type ItemTier,
  type ItemUid,
  type RuneItem,
  type SigilItem,
  type VesselItem,
} from './items.js';
import { buyPrice } from './prices.js';

/**
 * One-time conversion of v1 data (rune ids from the old compiler; sigils holding a rune id list,
 * a prebaked skill id and per-slot binding flags) to the v2 items. Anything stored without
 * `runeFormat: 2` comes through here before anything else reads it. Input is whatever JSON.parse
 * gave, so it is checked, not trusted: a field that cannot be read throws, so the row is kept
 * untouched for a human instead of being half converted.
 */

/** What one conversion did, for the server log and the conversion check against live data. */
export interface ConversionReport {
  /** Built-in skill sigils rebuilt as starter sigils, by starter id. */
  starterSigils: string[];
  /** v1 runes carried over one to one (Link becomes Bond): loose, hand-inscribed and unpacked. */
  runesMapped: { from: string; to: RuneId; count: number }[];
  /**
   * v1 runes inside built-in skill sigils, by v1 id. The starter sigil's own runes take their place
   * and nothing is paid for them: they were the skill, not runes the player put in.
   */
  runesReplaced: { from: string; count: number }[];
  /** Runes with no v2 counterpart (Linger, Pierce), paid out at their v1 sell value. */
  runesRefunded: { from: string; count: number; gold: number }[];
  /** Gold credited to the owner for refunded runes (0 on the trader shelf, which has no owner). */
  gold: number;
  /** Runes that came out of a sigil as loose items: past a hand-inscribed sigil's capacity, or from an old Test Sigil. */
  runesReturned: number;
  /** Of those, the ones with no room in the bag (or stash), left pending. */
  runesPending: number;
  /** Old Test Sigils taken apart. */
  testSigilsUnpacked: number;
  /** Anything a human should look at. */
  warnings: string[];
}

/** A v2 save from before the seamless world: its waypoints still list the old zones' ids. */
export type PreWorldSave = Omit<PlayerSave, 'worldFormat'>;

export interface CharacterConversion {
  save: PreWorldSave;
  report: ConversionReport;
}

export interface StashConversion {
  stash: StashSaveV1;
  report: ConversionReport;
}

/** The trader's shared shelf as stored. */
export interface TraderShelfSave {
  nextId: number;
  stock: TraderEntry[];
  runeFormat: 2;
  /** Rune affix rolls count six tiers (2026-10-01). Data without it is re-tiered once on load (convertRuneRolls). */
  runeTiers?: 6;
}

export interface TraderShelfConversion {
  shelf: TraderShelfSave;
  report: ConversionReport;
}

export function emptyReport(): ConversionReport {
  return { starterSigils: [], runesMapped: [], runesReplaced: [], runesRefunded: [], gold: 0, runesReturned: 0, runesPending: 0, testSigilsUnpacked: 0, warnings: [] };
}

/** Stored JSON whose rune affix rolls already count six tiers; anything without it goes through convertRuneRolls once. */
export function isRuneTiers6(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Reflect.get(raw, 'runeTiers') === 6;
}

/** Stored JSON carries this marker once it is v2; anything without it is v1. */
export function isRuneFormat2(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Reflect.get(raw, 'runeFormat') === 2;
}

// v1 data --------------------------------------------------------------------------------------

export const V1_RUNE_IDS = [
  'bolt',
  'nova',
  'zone',
  'dash',
  'aura',
  'link',
  'fire',
  'cold',
  'lightning',
  'impact',
  'ward',
  'restore',
  'swift',
  'large',
  'linger',
  'pierce',
  'timer',
  'onhit',
  'onexpire',
  'onland',
  'pulse',
  'split',
] as const;
export type V1RuneId = (typeof V1_RUNE_IDS)[number];

export function isV1RuneId(v: unknown): v is V1RuneId {
  return typeof v === 'string' && V1_RUNE_IDS.some((id) => id === v);
}

/**
 * Where each v1 rune goes. Null means it has no v2 rune and is paid out in gold. The v1 Link was
 * the ally tether, which v2 calls Bond (v2's Link is a new shaper).
 */
export const V1_TO_V2: Record<V1RuneId, RuneId | null> = {
  bolt: 'bolt',
  nova: 'nova',
  zone: 'zone',
  dash: 'dash',
  aura: 'aura',
  link: 'bond',
  fire: 'fire',
  cold: 'cold',
  lightning: 'lightning',
  impact: 'impact',
  ward: 'ward',
  restore: 'restore',
  swift: 'swift',
  large: 'large',
  linger: null,
  pierce: null,
  timer: 'timer',
  onhit: 'onhit',
  onexpire: 'onexpire',
  onland: 'onland',
  pulse: 'pulse',
  split: 'split',
};

/**
 * v1 prices, frozen here because items/prices.ts has moved on: a rune sold for its tier's value,
 * plus 12% per item level above 1, times the stack count. v1 rune tiers came from their category
 * (forms and elements common, effects and modifiers magic, triggers and Split rare).
 */
const V1_TIER_VALUE: Record<ItemTier, number> = { common: 4, magic: 12, rare: 40, relic: 150 };
const V1_RUNE_TIER: Record<V1RuneId, ItemTier> = {
  bolt: 'common',
  nova: 'common',
  zone: 'common',
  dash: 'common',
  aura: 'common',
  link: 'common',
  fire: 'common',
  cold: 'common',
  lightning: 'common',
  impact: 'magic',
  ward: 'magic',
  restore: 'magic',
  swift: 'magic',
  large: 'magic',
  linger: 'magic',
  pierce: 'magic',
  timer: 'rare',
  onhit: 'rare',
  onexpire: 'rare',
  onland: 'rare',
  pulse: 'rare',
  split: 'rare',
};

/**
 * One v1 rune's sell value, ignoring binding. v1 paid nothing for a bound rune, but these runes
 * are being taken away, not sold, so a bound one is paid like any other.
 */
export function v1RuneValue(rune: V1RuneId, tier: ItemTier = V1_RUNE_TIER[rune], ilvl = 1): number {
  return Math.max(1, Math.round(V1_TIER_VALUE[tier] * (1 + 0.12 * (ilvl - 1))));
}

/** An old dev-tools sigil; v1 took these apart on load and so does the conversion. */
export function isV1TestSigil(raw: unknown): boolean {
  return isRecord(raw) && raw.kind === 'sigil' && raw.name === 'Test Sigil' && raw.tier === 'relic' && raw.corrupted === true;
}

// Narrowing ------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new Error(`v1 conversion: ${where}: ${what}`);
}

function isTier(v: unknown): v is ItemTier {
  return typeof v === 'string' && ITEM_TIERS.some((t) => t === v);
}

const GEAR_CATEGORIES: readonly GearCategory[] = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring'];
function isGearCategory(v: unknown): v is GearCategory {
  return typeof v === 'string' && GEAR_CATEGORIES.some((c) => c === v);
}

function isStance(v: unknown): v is Stance {
  return typeof v === 'string' && STANCES.some((s) => s === v);
}

function isUid(v: unknown): v is ItemUid {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, `${key} is not a number`);
  return v;
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail(where, `${key} is not a string`);
  return v;
}

function uidList(v: unknown, where: string): (ItemUid | null)[] {
  if (!Array.isArray(v)) fail(where, 'not a list');
  return v.map((c: unknown) => (isUid(c) ? c : null));
}

/** Affix rolls; ids the game no longer has (or not for this item kind) are dropped with a warning. */
function affixList(v: unknown, where: string, sigil: boolean, report: ConversionReport): AffixRoll[] {
  if (!Array.isArray(v)) fail(where, 'affixes is not a list');
  const out: AffixRoll[] = [];
  for (const a of v) {
    if (!isRecord(a)) fail(where, 'an affix is not an object');
    const id = a.id;
    const tier = a.tier;
    const value = a.value;
    if (typeof tier !== 'number' || !Number.isInteger(tier) || typeof value !== 'number' || !Number.isFinite(value)) fail(where, `affix ${String(id)} has no tier or value`);
    if (!isAffixId(id) || (sigil && !AFFIXES[id].targets.includes('sigil'))) {
      report.warnings.push(`${where}: affix ${String(id)} no longer exists on ${sigil ? 'sigils' : 'this item'} and was dropped`);
      continue;
    }
    out.push({ id, tier, value });
  }
  return out;
}

// Conversion state -----------------------------------------------------------------------------

/** A loose rune to hand back: mapped already, placed once every item is converted. */
interface Loose {
  rune: RuneId;
  bound: boolean;
  count: number;
}

class Converter {
  readonly report = emptyReport();
  readonly loose: Loose[] = [];
  private nextUid: number;

  constructor(firstFreeUid: number) {
    this.nextUid = firstFreeUid;
  }

  fresh(): ItemUid {
    return this.nextUid++;
  }

  /** Books one v1 rune kind, returning where it goes (null: paid out, already counted). */
  map(from: V1RuneId, count: number, tier: ItemTier, ilvl: number): RuneId | null {
    const to = V1_TO_V2[from];
    if (to === null) {
      const gold = v1RuneValue(from, tier, ilvl) * count;
      const row = this.report.runesRefunded.find((r) => r.from === from);
      if (row) {
        row.count += count;
        row.gold += gold;
      } else this.report.runesRefunded.push({ from, count, gold });
      this.report.gold += gold;
      return null;
    }
    const row = this.report.runesMapped.find((r) => r.from === from);
    if (row) row.count += count;
    else this.report.runesMapped.push({ from, to, count });
    return to;
  }

  giveBack(rune: RuneId, bound: boolean, count: number): void {
    this.report.runesReturned += count;
    const same = this.loose.find((l) => l.rune === rune && l.bound === bound);
    if (same) same.count += count;
    else this.loose.push({ rune, bound, count });
  }

  convertItem(raw: unknown, where: string): Item | null {
    if (!isRecord(raw)) fail(where, 'item is not an object');
    const uid = raw.uid;
    if (!isUid(uid)) fail(where, 'item has no uid');
    const at = `${where} item ${uid}`;
    const tier = raw.tier;
    if (!isTier(tier)) fail(at, 'unknown tier');
    const name = str(raw, 'name', at);
    const ilvl = num(raw, 'ilvl', at);
    const bound = raw.bound === true;
    switch (raw.kind) {
      case 'gear': {
        const base = str(raw, 'base', at);
        const category = raw.category;
        if (!isGearCategory(category)) fail(at, 'unknown gear category');
        const item: GearItem = { uid, kind: 'gear', tier, name, ilvl, base, category, affixes: affixList(raw.affixes, at, false, this.report) };
        if (bound) item.bound = true;
        return item;
      }
      case 'vessel': {
        const minion = raw.minion;
        if (!isMinionTypeId(minion)) fail(at, 'unknown minion');
        const item: VesselItem = { uid, kind: 'vessel', tier, name, minion, level: num(raw, 'level', at), ilvl, affixes: affixList(raw.affixes, at, false, this.report) };
        if (bound) item.bound = true;
        return item;
      }
      case 'rune': {
        const from = raw.rune;
        if (!isV1RuneId(from)) fail(at, `unknown v1 rune ${String(from)}`);
        const count = num(raw, 'count', at);
        if (!Number.isInteger(count) || count < 1) fail(at, 'rune count is not a positive whole number');
        const to = this.map(from, count, tier, ilvl);
        if (to === null) return null;
        if (Array.isArray(raw.affixes) && raw.affixes.length > 0) this.report.warnings.push(`${at}: v1 rune had affixes, which v1 runes never roll; dropped`);
        const item = createRune(uid, to, count);
        item.ilvl = ilvl;
        if (bound) item.bound = true;
        return item;
      }
      case 'sigil':
        return this.convertSigil(raw, uid, tier, name, ilvl, bound, at);
      default:
        return fail(at, `unknown item kind ${String(raw.kind)}`);
    }
  }

  private convertSigil(raw: Record<string, unknown>, uid: ItemUid, tier: ItemTier, name: string, ilvl: number, bound: boolean, at: string): SigilItem | null {
    if (!Array.isArray(raw.runes)) fail(at, 'sigil has no rune list');
    const runes: V1RuneId[] = raw.runes.map((r: unknown) => (isV1RuneId(r) ? r : fail(at, `unknown v1 rune ${String(r)}`)));
    const flags = raw.boundSlots;
    // v1's slotBound: a slot without its own flag is bound exactly when the sigil is.
    const slotBound = (i: number): boolean => {
      const f: unknown = Array.isArray(flags) ? flags[i] : undefined;
      return typeof f === 'boolean' ? f : bound;
    };
    const corrupted = raw.corrupted === true;
    const affixes = affixList(raw.affixes, at, true, this.report);

    if (isV1TestSigil(raw)) {
      this.report.testSigilsUnpacked++;
      // As v1 unpacked them: a Test Sigil without per-slot flags held bound runes.
      runes.forEach((r, i) => {
        const b = Array.isArray(flags) && typeof flags[i] === 'boolean' ? flags[i] === true : true;
        const to = this.map(r, 1, V1_RUNE_TIER[r], 1);
        if (to !== null) this.giveBack(to, b, 1);
      });
      this.report.warnings.push(`${at}: old Test Sigil taken apart (${runes.length} rune${runes.length === 1 ? '' : 's'} back${affixes.length > 0 ? `; its ${affixes.length} affixes go with it` : ''})`);
      return null;
    }

    const skill = raw.skill;
    const def = typeof skill === 'string' ? starterSigilById(skill) : undefined;
    if (typeof skill === 'string' && !def) this.report.warnings.push(`${at}: skill ${skill} has no starter sigil; kept as a hand-inscribed sigil`);
    if (def) {
      let first = true;
      const item = createStarterSigil(
        () => {
          if (!first) return this.fresh();
          first = false;
          return uid;
        },
        def,
        { bound },
      );
      item.tier = tier;
      item.name = name;
      item.ilvl = ilvl;
      item.affixes = affixes;
      item.corrupted = corrupted;
      this.report.starterSigils.push(def.id);
      for (const r of runes) {
        const row = this.report.runesReplaced.find((x) => x.from === r);
        if (row) row.count++;
        else this.report.runesReplaced.push({ from: r, count: 1 });
      }
      return item;
    }

    const item: SigilItem = { uid, kind: 'sigil', tier, name, ilvl, affixes, slots: [], corrupted };
    if (bound) item.bound = true;
    const cap = sigilCapacity(item);
    runes.forEach((r, i) => {
      const to = this.map(r, 1, V1_RUNE_TIER[r], 1);
      if (to === null) return;
      const b = slotBound(i);
      if (item.slots.length < cap) {
        const rune = createRune(this.fresh(), to, 1);
        if (b) rune.bound = true;
        item.slots.push(rune);
      } else this.giveBack(to, b, 1);
    });
    if (runes.length > 0) this.report.warnings.push(`${at}: hand-inscribed sigil kept ${item.slots.length} of ${runes.length} runes in its slots; check it at the forge`);
    return item;
  }

  /**
   * Hands the loose runes back: topping up matching plain stacks in `cells` first, then new stacks
   * in free cells, then pending (in `items`, in no grid). `cells` null means no grid takes them.
   * Bound runes go only where `allowBound` says, since the account stash never holds them.
   */
  placeLoose(items: Item[], cells: (ItemUid | null)[] | null, size: GridSize, allowBound: boolean): void {
    for (const l of this.loose) {
      const grid = cells && (allowBound || !l.bound) ? cells : null;
      let left = l.count;
      if (grid) {
        const inGrid = new Set(grid);
        for (const it of items) {
          if (left === 0) break;
          if (it.kind !== 'rune' || !inGrid.has(it.uid) || !isPlainRune(it) || it.rune !== l.rune || (it.bound === true) !== l.bound) continue;
          const add = Math.min(left, RUNE_STACK - it.count);
          if (add <= 0) continue;
          it.count += add;
          left -= add;
        }
      }
      while (left > 0) {
        const n = Math.min(left, RUNE_STACK);
        left -= n;
        const stack = createRune(this.fresh(), l.rune, n);
        if (l.bound) stack.bound = true;
        items.push(stack);
        const spot = grid ? findSpot(grid, size, itemSize(stack)) : null;
        if (grid && spot) place(grid, size, stack.uid, itemSize(stack), spot.x, spot.y);
        else this.report.runesPending += n;
      }
    }
    this.loose.length = 0;
  }
}

/** One past the largest item uid anywhere in the raw data, so fresh uids never collide with old ones. */
function firstFreeUid(rawItems: readonly unknown[]): number {
  let max = 0;
  for (const it of rawItems) {
    const u = isRecord(it) ? it.uid : undefined;
    if (isUid(u)) max = Math.max(max, u);
  }
  return max + 1;
}

function convertItems(c: Converter, raw: unknown, where: string): { items: Item[]; removed: Set<ItemUid> } {
  if (!Array.isArray(raw)) fail(where, 'items is not a list');
  const items: Item[] = [];
  const removed = new Set<ItemUid>();
  const seen = new Set<ItemUid>();
  for (const r of raw) {
    const item = c.convertItem(r, where);
    const uid = isRecord(r) && isUid(r.uid) ? r.uid : -1;
    if (seen.has(uid)) c.report.warnings.push(`${where}: uid ${uid} appears twice in the v1 data`);
    seen.add(uid);
    if (item) items.push(item);
    else removed.add(uid);
  }
  return { items, removed };
}

/** The same bag repack restoreSave does for a list of another size, so there are cells to put runes in. */
function asGrid(saved: readonly (ItemUid | null)[], size: GridSize, items: readonly Item[]): (ItemUid | null)[] {
  if (saved.length === size.w * size.h) return [...saved];
  const cells = emptyGrid(size);
  const byUid = new Map(items.map((i) => [i.uid, i]));
  for (const uid of new Set(saved)) {
    const item = uid === null ? undefined : byUid.get(uid);
    if (!item || uid === null) continue;
    const spot = findSpot(cells, size, itemSize(item));
    if (spot) place(cells, size, uid, itemSize(item), spot.x, spot.y);
  }
  return cells;
}

function drop(cells: readonly (ItemUid | null)[], removed: ReadonlySet<ItemUid>): (ItemUid | null)[] {
  return cells.map((u) => (u !== null && removed.has(u) ? null : u));
}

// v2 shape guards (for idempotency) ----------------------------------------------------------

/** The stash field is left open: saves from before tabs hold a grid there, read by saveStashLayout. */
function isV2Save(v: unknown): v is Omit<PlayerSave, 'stash'> & { stash: unknown } {
  return (
    isRecord(v) &&
    v.runeFormat === 2 &&
    isClassId(v.classId) &&
    typeof v.name === 'string' &&
    Array.isArray(v.items) &&
    Array.isArray(v.inventory) &&
    Array.isArray(v.sigils) &&
    Array.isArray(v.warband) &&
    isRecord(v.gear) &&
    isStance(v.stance) &&
    Array.isArray(v.waypoints) &&
    typeof v.level === 'number' &&
    typeof v.xp === 'number' &&
    typeof v.gold === 'number'
  );
}

function isV2Stash(v: unknown): v is StashSaveV1 {
  return isRecord(v) && v.runeFormat === 2 && Array.isArray(v.items) && Array.isArray(v.cells);
}

function isV2Shelf(v: unknown): v is TraderShelfSave {
  return isRecord(v) && v.runeFormat === 2 && typeof v.nextId === 'number' && Array.isArray(v.stock);
}

// Entry points ---------------------------------------------------------------------------------

export function convertCharacterSave(raw: unknown): CharacterConversion {
  if (isRuneFormat2(raw)) {
    if (!isV2Save(raw)) fail('character save', 'marked runeFormat 2 but not a v2 save');
    return { save: { ...raw, stash: saveStashLayout(raw.stash) }, report: emptyReport() };
  }
  if (!isRecord(raw)) fail('character save', 'not an object');
  const classId = raw.classId;
  if (!isClassId(classId)) fail('character save', 'unknown class');
  const name = str(raw, 'name', 'character save');
  if (!Array.isArray(raw.items)) fail('character save', 'items is not a list');
  const c = new Converter(firstFreeUid(raw.items));
  const { items, removed } = convertItems(c, raw.items, `character ${name}`);

  const stance = raw.stance;
  if (!isStance(stance)) c.report.warnings.push(`character ${name}: unknown stance ${String(stance)}; set to defensive`);
  const gearRaw = raw.gear;
  if (!isRecord(gearRaw)) fail('character save', 'gear is not an object');
  const gear: Record<GearSlot, ItemUid | null> = { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null };
  for (const slot of GEAR_SLOTS) {
    const u = gearRaw[slot];
    gear[slot] = isUid(u) && !removed.has(u) ? u : null;
  }
  const inventoryRaw = drop(uidList(raw.inventory, 'inventory'), removed);
  const stash = raw.stash === undefined ? [] : drop(uidList(raw.stash, 'stash'), removed);
  const waypoints = Array.isArray(raw.waypoints) ? raw.waypoints.filter(isWaypointId) : [];
  const level = typeof raw.level === 'number' && Number.isFinite(raw.level) ? raw.level : 1;
  const xp = typeof raw.xp === 'number' && Number.isFinite(raw.xp) ? raw.xp : 0;
  const goldBefore = typeof raw.gold === 'number' && Number.isFinite(raw.gold) ? raw.gold : 0;

  // Only repacked when something must go in, so an untouched bag keeps its exact v1 cells.
  const inventory = c.loose.length > 0 ? asGrid(inventoryRaw, BAG, items) : inventoryRaw;
  c.placeLoose(items, inventory, BAG, true);

  const save: PreWorldSave = {
    classId,
    name,
    items,
    inventory,
    stash: legacyLayout(stash),
    sigils: drop(uidList(raw.sigils, 'sigils'), removed),
    warband: drop(uidList(raw.warband, 'warband'), removed),
    gear,
    stance: isStance(stance) ? stance : 'defensive',
    waypoints,
    level,
    xp,
    gold: goldBefore + c.report.gold,
    runeFormat: 2,
  };
  return { save, report: c.report };
}

export function convertStash(raw: unknown): StashConversion {
  if (isRuneFormat2(raw)) {
    if (!isV2Stash(raw)) fail('account stash', 'marked runeFormat 2 but not a v2 stash');
    return { stash: raw, report: emptyReport() };
  }
  if (!isRecord(raw)) fail('account stash', 'not an object');
  if (!Array.isArray(raw.items)) fail('account stash', 'items is not a list');
  const c = new Converter(firstFreeUid(raw.items));
  const { items, removed } = convertItems(c, raw.items, 'stash');
  const stored = drop(uidList(raw.cells, 'stash cells'), removed);
  // A grid of another size is laid out afresh on load, so runes are left for that to place.
  const cells = stored.length === STASH.w * STASH.h ? stored : null;
  // Bound runes never go into the shared stash: left pending, restoreStash moves them to the
  // joining character's bag.
  c.placeLoose(items, cells, STASH, false);
  if (c.report.gold > 0) c.report.warnings.push(`stash: ${c.report.gold} gold for refunded runes goes to the character that loads it`);
  return { stash: { items, cells: cells ?? stored, runeFormat: 2 }, report: c.report };
}

export function convertTraderShelf(raw: unknown): TraderShelfConversion {
  if (isRuneFormat2(raw)) {
    if (!isV2Shelf(raw)) fail('trader shelf', 'marked runeFormat 2 but not a v2 shelf');
    return { shelf: raw, report: emptyReport() };
  }
  if (!isRecord(raw)) fail('trader shelf', 'not an object');
  if (!Array.isArray(raw.stock)) fail('trader shelf', 'stock is not a list');
  const rawItems = raw.stock.map((e: unknown) => (isRecord(e) ? e.item : undefined));
  const c = new Converter(firstFreeUid(rawItems));
  const stock: TraderEntry[] = [];
  let nextId = typeof raw.nextId === 'number' && Number.isInteger(raw.nextId) ? raw.nextId : 1;
  for (const e of raw.stock) {
    if (!isRecord(e)) fail('trader shelf', 'entry is not an object');
    const id = num(e, 'id', 'trader shelf');
    const price = num(e, 'price', `trader shelf entry ${id}`);
    const goldBefore = c.report.gold;
    const item = c.convertItem(e.item, `trader shelf entry ${id}`);
    if (item?.bound) c.report.warnings.push(`trader shelf entry ${id}: bound item on the shelf`);
    if (item) stock.push({ id, item, price });
    nextId = Math.max(nextId, id + 1);
    if (c.report.gold > goldBefore) c.report.warnings.push(`trader shelf entry ${id}: refunded rune removed; its seller was paid when it was sold`);
  }
  // The shelf belongs to nobody, so refunded runes pay no one.
  for (const r of c.report.runesRefunded) r.gold = 0;
  c.report.gold = 0;
  // Runes that came out of a sigil become shelf entries of their own, priced as loadMarket does.
  const loose: Item[] = [];
  c.placeLoose(loose, null, BAG, true);
  c.report.runesPending = 0;
  for (const item of loose) {
    const rune = { ...item, uid: 0 };
    stock.push({ id: nextId++, item: rune, price: buyPrice(rune) });
  }
  return { shelf: { nextId, stock, runeFormat: 2 }, report: c.report };
}
