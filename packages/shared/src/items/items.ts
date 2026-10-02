import { HEAT, HOUND_PACK, LOOT, SIM, SPELL, SPIRIT } from '../config/sim.js';
import { AFFIXES, AFFIX_IDS, affixText, IMPLICIT_NEUTRAL_TIER, implicitIdFor, isAffixId, type AffixId, type AffixTarget, type BehaviourAffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import { formatNumber, GEAR_AFFIX_STATS, GEAR_BASES, gearBase, STAT_IDS, type GearCategory, type StatBlock, type StatId } from '../data/gear.js';
import { MINION_DEFS, MINION_TYPE_IDS, type MinionTypeId } from '../data/minions.js';
import { starterSigilById, type StarterSigilDef } from '../data/starterSigils.js';
import { FORGE } from '../config/forge.js';
import { clampRuneRolls, honestTier } from './runeRolls.js';
import { affixesFor, CASTABLE_RUNES, CONCENTRATED, PLAIN_MODIFIER_EFFECT, runeKind, runeName, type AddedKey, type AffixKey, type RuneAffixes, type RuneId, type RuneInstance } from '../runes/v2/runes.js';
import type { Rng } from '../sim/rng.js';

export { clampRoll, clampRuneRolls, honestTier, isNoStronger, kitRoll, rollAverage, rollLosses, sixTierRoll } from './runeRolls.js';

export const ITEM_TIERS = ['common', 'magic', 'rare', 'relic'] as const;
export type ItemTier = (typeof ITEM_TIERS)[number];

export const SIGIL_CAPACITY: Record<ItemTier, number> = { common: 3, magic: 4, rare: 5, relic: 6 };
/** No sigil holds more runes than this, whatever it rolled. */
export const SIGIL_MAX_SLOTS = 10;

/** How many affixes an item of each tier rolls, and the highest affix tier index it can reach. */
const TIER_ROLLS: Record<ItemTier, { min: number; max: number; maxAffixTier: number }> = {
  common: { min: 0, max: 0, maxAffixTier: 0 },
  magic: { min: 1, max: 2, maxAffixTier: 1 },
  rare: { min: 3, max: 4, maxAffixTier: 2 },
  relic: { min: 4, max: 5, maxAffixTier: 2 },
};

/**
 * The highest rune affix tier (index) a rune drop of each tier can roll, on top of each tier's own
 * item-level gate: common and magic stop at T4, as magic once stopped at the old middle tier.
 */
const RUNE_AFFIX_TIER_CAP: Record<ItemTier, number> = { common: 2, magic: 2, rare: 5, relic: 5 };

const MAX_PER_SLOT = 3;

export interface AffixRoll {
  id: AffixId;
  tier: number;
  value: number;
  /**
   * A ranged roll's high end ("+20 to 60% damage"): `value` is the low end and the server rolls
   * inside the two on every cast. Only rune affixes with `ranged` in their table carry one.
   */
  max?: number;
}

export type ItemUid = number;

export interface SigilItem {
  uid: ItemUid;
  kind: 'sigil';
  tier: ItemTier;
  name: string;
  /** Item level: the monster level it dropped from. Gates which affix tiers can roll. */
  ilvl: number;
  /** Wand stats. */
  affixes: AffixRoll[];
  /**
   * The runes inscribed, left to right. Each is a whole rune item with count 1, its own uid, rolls
   * and binding, and lives only here (never also in the character's items), so taking it out gives
   * back exactly what went in.
   */
  slots: RuneItem[];
  corrupted: boolean;
  /** Starter kit: every new character gets one, so it cannot be sold (it would mint gold). */
  bound?: boolean;
  /** The starter sigil this was made from, for its name and icon only. */
  starter?: string;
}

export interface VesselItem {
  uid: ItemUid;
  kind: 'vessel';
  tier: ItemTier;
  name: string;
  minion: MinionTypeId;
  level: number;
  ilvl: number;
  affixes: AffixRoll[];
  /** Starter kit: every new character gets one, so it cannot be sold (it would mint gold). */
  bound?: boolean;
  /** Packmates beside the Leader, for pack minions (the Hound); rolled by tier (HOUND_PACK). */
  pack?: number;
  /** A hand-named item ("Brothers Creation"): its name is part of it and it shows in the unique colour. */
  fixedName?: boolean;
  /** A line of flavour text for its tooltip. */
  lore?: string;
}

export interface GearItem {
  uid: ItemUid;
  kind: 'gear';
  tier: ItemTier;
  name: string;
  ilvl: number;
  base: string;
  category: GearCategory;
  affixes: AffixRoll[];
  /** Starter kit: every new character gets one, so it cannot be sold (it would mint gold). */
  bound?: boolean;
}

/**
 * A rune to inscribe at the forge. A plain rune (no affixes) stacks: one bag cell holds up to
 * RUNE_STACK of the same one. A rolled rune (any affixes) is always a single item and never stacks.
 */
export interface RuneItem {
  uid: ItemUid;
  kind: 'rune';
  tier: ItemTier;
  name: string;
  ilvl: number;
  rune: RuneId;
  count: number;
  /** Rune affixes (target 'rune'). Empty means plain. */
  affixes: AffixRoll[];
  bound?: boolean;
  /**
   * Made on the builders' free bench. It exists only inside a sigil: whenever it leaves one, at the
   * bench or a real forge, it is gone, so the bench never becomes a free supply of runes.
   */
  bench?: boolean;
  /**
   * The rune's implicit (docs/features/runes.md, "Implicits"): every castable rune carries one,
   * rolled at drop. Saves from before implicits get the neutral roll once on load (the implicit
   * pass); read it with runeImplicit, which gives that neutral roll for data not converted yet.
   */
  implicit?: AffixRoll;
}

export type Item = SigilItem | VesselItem | GearItem | RuneItem;

export const RUNE_STACK = 20;

/** Shapes and infusions are common, what they do is rarer, and triggers and shapers (which chain spells) are the rare finds. */
export function runeTier(rune: RuneId): ItemTier {
  const k = runeKind(rune);
  return k === 'shape' || k === 'infusion' ? 'common' : k === 'effect' || k === 'modifier' ? 'magic' : 'rare';
}

/**
 * A plain rune with the neutral implicit: what kit runes, bench runes and runes converted from
 * older saves carry. Drops roll theirs (createPlainDrop, createRolledRune).
 */
export function createRune(uid: ItemUid, rune: RuneId, count = 1): RuneItem {
  const item: RuneItem = { uid, kind: 'rune', tier: runeTier(rune), name: `${runeName(rune)} Rune`, ilvl: 1, rune, count, affixes: [] };
  const implicit = neutralImplicit(rune);
  if (implicit) item.implicit = implicit;
  return item;
}

/** The roll every rune had before implicits: the middle of T4, so it casts exactly as it did. Null for a rune with no implicit. */
export function neutralImplicit(rune: RuneId): AffixRoll | null {
  const id = implicitIdFor(rune);
  const value = id ? AFFIXES[id].neutral : undefined;
  return id && value !== undefined ? { id, tier: IMPLICIT_NEUTRAL_TIER, value } : null;
}

/** A rune's implicit, or the neutral roll for one stored before implicits (not converted yet). */
export function runeImplicit(item: RuneItem): AffixRoll | null {
  return item.implicit ?? neutralImplicit(item.rune);
}

/** An implicit by what it does and what it is worth, so two plain runes stack only when theirs match. */
export function implicitKey(item: RuneItem): string {
  const i = runeImplicit(item);
  return i ? `${i.id}:${i.tier}:${i.value}` : '';
}

/** Whether two rune items may share a stack: both plain, the same rune, binding and implicit. */
export function stacksWith(a: RuneItem, b: RuneItem): boolean {
  return isPlainRune(a) && isPlainRune(b) && a.rune === b.rune && (a.bound === true) === (b.bound === true) && implicitKey(a) === implicitKey(b);
}

/**
 * An implicit rolled at drop. The tier is weighted among the tiers the item level unlocks; a rolled
 * rune then rolls its value inside the tier, while a plain rune takes the tier's middle, so plain
 * runes of one tier still stack (until runes stop stacking, docs/features/runes.md).
 */
export function rollImplicit(rng: Rng, rune: RuneId, ilvl: number, exact: boolean): AffixRoll | null {
  const id = implicitIdFor(rune);
  if (!id) return null;
  const def = AFFIXES[id];
  const tier = weightedPick(rng, def.tiers.flatMap((t, i) => (t.weight > 0 && (t.ilvl ?? 1) <= Math.max(1, ilvl) ? [{ item: i, weight: t.weight }] : []))) ?? 0;
  const t = def.tiers[tier];
  if (!t) return null;
  const value = roundTo(exact ? rng.range(t.min, t.max) : (t.min + t.max) / 2, def.decimals ?? 0);
  // Stored at the tier its value counts as, so Split's tiers that share a value (0 in T6 to T4, 1 in
  // T3 and T2) give one stack and one price.
  return { id, tier: implicitTier(id, value), value };
}

/** A plain rune as a monster drops it: its implicit's tier gated by the monster's level. */
export function createPlainDrop(uid: ItemUid, rng: Rng, rune: RuneId, level: number): RuneItem {
  const item = createRune(uid, rune);
  const implicit = rollImplicit(rng, rune, level, false);
  if (implicit) item.implicit = implicit;
  return item;
}

export function isPlainRune(item: RuneItem): boolean {
  return item.affixes.length === 0;
}

const RUNE_WEIGHT = { common: 6, magic: 3, rare: 1, relic: 0 } as const;

/** A random rune the engine can run, weighted toward the common ones. */
export function rollRune(rng: Rng): RuneId {
  return weightedPick(rng, CASTABLE_RUNES.map((id) => ({ item: id, weight: RUNE_WEIGHT[runeTier(id)] }))) ?? 'bolt';
}

/** The grammar key each rune affix sets; affixesFor(rune) must list it for the rune to carry it. */
const RUNE_AFFIX_KEY: Partial<Record<AffixId, AffixKey>> = {
  release_onhit: 'release',
  release_onexpire: 'release',
  release_after: 'release',
  release_every: 'release',
  release_onland: 'release',
  rune_speed: 'speed',
  rune_size: 'size',
  rune_duration: 'duration',
  rune_damage: 'damage',
  rune_pierce: 'pierce',
  split_count: 'count',
  rune_concentrated: 'concentration',
  rune_added_fire: 'addedFire',
  rune_added_cold: 'addedCold',
  rune_added_lightning: 'addedLightning',
};

/** Whether `rune` may roll this affix: the affix lists the rune and the grammar reads its key there. */
export function runeMayCarry(rune: RuneId, id: AffixId): boolean {
  const def = AFFIXES[id];
  const key = RUNE_AFFIX_KEY[id];
  return def.targets.includes('rune') && key !== undefined && (def.runes?.includes(rune) ?? false) && affixesFor(rune).includes(key);
}

/** Castable runes that have at least one affix they may roll; only these drop rolled. */
export const ROLLABLE_RUNES: readonly RuneId[] = CASTABLE_RUNES.filter((r) => AFFIX_IDS.some((id) => runeMayCarry(r, id)));

/**
 * Runes whose amount is rolled at drop, so they never drop plain: Concentrated's more damage is its
 * rune_concentrated roll. A plain one (the builders' bench) casts at CONCENTRATED.defaultMore.
 */
export const ALWAYS_ROLLED_RUNES: readonly RuneId[] = ['concentrated'];

export function dropsRolled(rune: RuneId): boolean {
  return ALWAYS_ROLLED_RUNES.includes(rune);
}

/**
 * A rolled rune: a single item with rune affixes, never stacking. Affix count comes from the drop's
 * tier and the affix tiers from item level, like gear. Its item tier is at least magic, and at least
 * the rune's own, so a rolled rune always reads as the better find.
 */
export function createRolledRune(uid: ItemUid, rng: Rng, tier: ItemTier, ilvl: number, rune?: RuneId): RuneItem {
  const id = rune ?? weightedPick(rng, ROLLABLE_RUNES.map((r) => ({ item: r, weight: RUNE_WEIGHT[runeTier(r)] }))) ?? 'orb';
  const n = FORGE.rolledRuneAffixes[tier];
  // A rune rolled for its amount always gets that roll, whatever the drop tier allows.
  const count = Math.max(rng.int(n.min, n.max), dropsRolled(id) ? 1 : 0);
  // Rune affix tiers carry their own item-level gates; the drop's tier only caps how high they go.
  const affixes = rollAffixes(rng, 'rune', count, RUNE_AFFIX_TIER_CAP[tier], { rune: id, allow: (a) => runeMayCarry(id, a), ilvl: Math.max(1, ilvl) });
  const itemTier = ITEM_TIERS[Math.max(ITEM_TIERS.indexOf(tier), ITEM_TIERS.indexOf(runeTier(id)), 1)] ?? 'magic';
  const item: RuneItem = { uid, kind: 'rune', tier: itemTier, name: nameFromAffixes(`${runeName(id)} Rune`, affixes), ilvl: Math.max(1, ilvl), rune: id, count: 1, affixes };
  // Rolled after the affixes, so the affixes a seed gives did not move when implicits came in.
  const implicit = rollImplicit(rng, id, item.ilvl, true);
  if (implicit) item.implicit = implicit;
  return item;
}

/**
 * The grammar's view of a rune item: its id and what its affixes set. Values add up, so two rolls
 * of the same number affix stack like doubled runes do.
 */
export function toRuneInstance(item: RuneItem): RuneInstance {
  const a: RuneAffixes = {};
  const add = (key: 'speed' | 'size' | 'duration' | 'damage' | 'pierce' | 'count' | 'concentration' | AddedKey, v: number): void => {
    a[key] = (a[key] ?? 0) + v;
  };
  // A ranged roll's high end: the grammar reads `damage` to `damageMax`, so the spread is kept apart
  // and added to the low end once every roll is in.
  const spread = { damage: 0, pierce: 0, count: 0 };
  const addMax = (roll: AffixRoll, key: 'damage' | 'pierce' | 'count'): void => {
    if (roll.max !== undefined && roll.max > roll.value) spread[key] += roll.max - roll.value;
  };
  for (const roll of item.affixes) {
    switch (roll.id) {
      case 'release_onhit':
        a.release = { kind: 'onhit', seconds: 0 };
        break;
      case 'release_onexpire':
        a.release = { kind: 'onexpire', seconds: 0 };
        break;
      case 'release_onland':
        a.release = { kind: 'onland', seconds: 0 };
        break;
      case 'release_after':
        a.release = { kind: 'after', seconds: roll.value };
        break;
      case 'release_every':
        a.release = { kind: 'every', seconds: roll.value };
        break;
      case 'rune_speed':
        add('speed', roll.value);
        break;
      case 'rune_size':
        add('size', roll.value);
        break;
      case 'rune_duration':
        add('duration', roll.value);
        break;
      case 'rune_damage':
        add('damage', roll.value);
        addMax(roll, 'damage');
        break;
      case 'rune_pierce':
        add('pierce', roll.value);
        addMax(roll, 'pierce');
        break;
      case 'split_count':
        add('count', roll.value);
        addMax(roll, 'count');
        break;
      case 'rune_concentrated':
        add('concentration', roll.value);
        break;
      case 'rune_added_fire':
        add('addedFire', roll.value);
        break;
      case 'rune_added_cold':
        add('addedCold', roll.value);
        break;
      case 'rune_added_lightning':
        add('addedLightning', roll.value);
        break;
      default:
        break;
    }
  }
  if (spread.damage > 0) a.damageMax = (a.damage ?? 0) + spread.damage;
  if (spread.pierce > 0) a.pierceMax = (a.pierce ?? 0) + spread.pierce;
  if (spread.count > 0) a.countMax = (a.count ?? 0) + spread.count;
  const implicit = runeImplicit(item);
  // The neutral roll is left out, so a rune from before implicits reads exactly as it did. An implicit
  // id the game no longer has is left in the item untouched and read as none, like a retired affix.
  if (implicit && isAffixId(implicit.id) && implicit.value !== AFFIXES[implicit.id].neutral) return { id: item.rune, affixes: a, implicit: implicit.value };
  return { id: item.rune, affixes: a };
}

const AFFIX_FOR_KEY = {
  speed: 'rune_speed',
  size: 'rune_size',
  duration: 'rune_duration',
  damage: 'rune_damage',
  pierce: 'rune_pierce',
  count: 'split_count',
  concentration: 'rune_concentrated',
  addedFire: 'rune_added_fire',
  addedCold: 'rune_added_cold',
  addedLightning: 'rune_added_lightning',
} as const;
const AFFIX_FOR_RELEASE = { onhit: 'release_onhit', onexpire: 'release_onexpire', onland: 'release_onland', after: 'release_after', every: 'release_every' } as const;

/**
 * The inverse of toRuneInstance, for hand-written rune lists (starter sigils): each number the
 * grammar reads becomes the affix that sets it, at the tier its value falls in (honestTier). Throws on a number no rune affix sets,
 * since that is a mistake in the data, not something a player can cause.
 */
export function runeItemFromInstance(uid: ItemUid, rune: RuneInstance, bound: boolean): RuneItem {
  const item = createRune(uid, rune.id, 1);
  const a = rune.affixes;
  for (const key of Object.keys(a)) {
    if (key === 'release') {
      const r = a.release;
      if (!r) continue;
      if (r.kind === 'onrelease') throw new Error(`${rune.id}: no rune affix releases on release`);
      const id = AFFIX_FOR_RELEASE[r.kind];
      const value = r.kind === 'after' || r.kind === 'every' ? r.seconds : 1;
      item.affixes.push({ id, tier: honestTier(id, value), value });
      continue;
    }
    if (key === 'damageMax' || key === 'pierceMax' || key === 'countMax') continue;
    if (
      key !== 'speed' &&
      key !== 'size' &&
      key !== 'duration' &&
      key !== 'damage' &&
      key !== 'pierce' &&
      key !== 'count' &&
      key !== 'concentration' &&
      key !== 'addedFire' &&
      key !== 'addedCold' &&
      key !== 'addedLightning'
    ) {
      throw new Error(`${rune.id}: no rune affix sets ${key}`);
    }
    const v = a[key];
    if (v === undefined) continue;
    const id = AFFIX_FOR_KEY[key];
    const high = key === 'damage' ? a.damageMax : key === 'pierce' ? a.pierceMax : key === 'count' ? a.countMax : undefined;
    // A ranged roll prices at the tier of its average, as Force does.
    if (high !== undefined && high > v) item.affixes.push({ id, tier: honestTier(id, (v + high) / 2), value: v, max: high });
    else item.affixes.push({ id, tier: honestTier(id, v), value: v });
  }
  if (rune.implicit !== undefined) {
    const id = implicitIdFor(rune.id);
    if (!id) throw new Error(`${rune.id}: this rune has no implicit`);
    item.implicit = { id, tier: implicitTier(id, rune.implicit), value: rune.implicit };
  }
  if (bound) item.bound = true;
  return item;
}

/** The tier an implicit value counts as: the neutral roll is T4 even where lower tiers share it (Split's 0). */
export function implicitTier(id: AffixId, value: number): number {
  return value === AFFIXES[id].neutral ? IMPLICIT_NEUTRAL_TIER : honestTier(id, value);
}

/**
 * The kit skill this sigil still spells, for its name and description only: its `starter`, while
 * the slots hold that skill's runes in order. Only the rune ids are compared, since sigils already
 * out there keep the rolls they were made with. Nothing casts, prices or extracts differently
 * because of it; once the runes change, the sigil is named by what it holds.
 */
export function matchingStarter(item: SigilItem): StarterSigilDef | undefined {
  const def = starterSigilById(item.starter);
  if (!def || def.runes.length !== item.slots.length) return undefined;
  return def.runes.every((r, i) => item.slots[i]?.rune === r.id) ? def : undefined;
}

/**
 * A rune by what it casts: its id, each roll's value (both ends of a ranged one) and its implicit's
 * value, not the tiers, uid or binding. A rune from before implicits reads as the neutral roll.
 */
export function runeRecipeKey(item: RuneItem): string {
  const implicit = runeImplicit(item);
  return `${item.rune}|${item.affixes.map((a) => `${a.id}:${a.value}${a.max === undefined ? '' : `-${a.max}`}`).sort().join(',')}|${implicit ? implicit.value : ''}`;
}

/**
 * Rune slots: the tier's base, plus the slots affix and one for corruption, capped at
 * SIGIL_MAX_SLOTS. A kit sigil is common (3 slots) but some kits hold 4 runes, so a sigil made
 * from a kit always has room for that many.
 */
export function sigilCapacity(item: SigilItem): number {
  const rolled = SIGIL_CAPACITY[item.tier] + affixValue(item.affixes, 'sigil_slots') + (item.corrupted ? 1 : 0);
  const starter = item.starter ? (starterSigilById(item.starter)?.runes.length ?? 0) : 0;
  return Math.min(SIGIL_MAX_SLOTS, Math.max(rolled, starter));
}

/** Share of the global cast cooldown this sigil waits, from its cast delay affix. */
export function sigilCastDelayShare(item: SigilItem): number {
  return 1 - affixValue(item.affixes, 'cast_delay') / 100;
}

/** Float slack, so 0.5 s is ten ticks and not eleven. */
const TICK_EPS = 1e-6;

/**
 * Seconds between casts: the global cooldown (the admin setting), shortened by the sigil's cast
 * delay share and the character's cast speed, then rounded up to whole sim ticks because the
 * server only casts on a tick (0.43 s waits 0.45 s). The sim and every tooltip use this one formula.
 */
export function castCooldownSeconds(globalSeconds: number, castDelayShare: number, castSpeedMult: number): number {
  const raw = (globalSeconds * castDelayShare) / castSpeedMult;
  return Math.max(1, Math.ceil(raw / SIM.dt - TICK_EPS)) * SIM.dt;
}

export function sigilMisfireMultiplier(item: SigilItem): number {
  return item.corrupted ? LOOT.corruptMisfireMultiplier : 1;
}

/**
 * A copy of an item under new uids, with every rune inside a sigil reissued too, so no uid ever
 * exists in two places. Used wherever items arrive from outside the room (saves, the stash, the shelf).
 */
export function reissueUids(item: Item, newUid: () => ItemUid): Item {
  const uid = newUid();
  // Affix arrays are copied too, so the copy shares nothing mutable with the item it came from.
  if (item.kind === 'sigil') return { ...item, uid, affixes: [...item.affixes], slots: item.slots.map((r) => ({ ...copyRune(r), uid: newUid() })) };
  if (item.kind === 'rune') return { ...copyRune(item), uid };
  return { ...item, uid, affixes: [...item.affixes] };
}

function copyRune(r: RuneItem): RuneItem {
  return { ...r, affixes: r.affixes.map((a) => ({ ...a })), ...(r.implicit ? { implicit: { ...r.implicit } } : {}) };
}

/** Highest affix tier index unlocked by item level for three-tier affixes (gear, sigils, vessels): the middle from level 3, the best from 5. Rune affix tiers carry their own gates. */
export function ilvlAffixTier(ilvl: number): number {
  return ilvl >= 5 ? 2 : ilvl >= 3 ? 1 : 0;
}

const NAME_FIRST = ['Grim', 'Hollow', 'Storm', 'Ash', 'Blood', 'Dusk', 'Rune', 'Wraith', 'Ember', 'Frost', 'Bone', 'Star', 'Viper', 'Oath', 'Gloom', 'Raven'];
const NAME_SECOND = ['Whorl', 'Seal', 'Mark', 'Brand', 'Glyph', 'Knot', 'Veil', 'Coil', 'Eye', 'Crown', 'Ward', 'Song', 'Scar', 'Bane', 'Heart', 'Tongue'];

/** Rares and relics get a random two-word name, D2 style; lower tiers are named from their affixes. */
function rareName(rng: Rng): string {
  return `${NAME_FIRST[rng.int(0, NAME_FIRST.length - 1)] ?? 'Grim'} ${NAME_SECOND[rng.int(0, NAME_SECOND.length - 1)] ?? 'Mark'}`;
}

function weightedPick<T>(rng: Rng, entries: readonly { item: T; weight: number }[]): T | null {
  let total = 0;
  for (const e of entries) total += e.weight;
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll < 0) return e.item;
  }
  return entries[entries.length - 1]?.item ?? null;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * The generic affix engine. Picks `count` affixes for `target`, weighted per tier, respecting
 * exclusive groups and the prefix/suffix limit.
 */
export function rollAffixes(
  rng: Rng,
  target: AffixTarget,
  count: number,
  maxAffixTier: number,
  filter: { category?: GearCategory; rune?: RuneId; allow?: (id: AffixId) => boolean; ilvl?: number } = {},
): AffixRoll[] {
  const { category, rune, allow, ilvl } = filter;
  const out: AffixRoll[] = [];
  const usedGroups = new Set<string>();
  const slotCounts = { prefix: 0, suffix: 0 };
  for (let n = 0; n < count; n++) {
    const candidates: { item: { id: AffixId; tier: number }; weight: number }[] = [];
    for (const id of AFFIX_IDS) {
      const def = AFFIXES[id];
      if (!def.targets.includes(target) || usedGroups.has(def.group)) continue;
      if (category && def.slots && !def.slots.includes(category)) continue;
      if (def.runes && (rune === undefined || !def.runes.includes(rune))) continue;
      if (allow && !allow(id)) continue;
      if (slotCounts[def.slot] >= MAX_PER_SLOT) continue;
      def.tiers.forEach((t, tier) => {
        if (tier > maxAffixTier || t.weight <= 0) return;
        if (t.ilvl !== undefined && ilvl !== undefined && ilvl < t.ilvl) return;
        candidates.push({ item: { id, tier }, weight: t.weight * (def.dropShare ?? 1) });
      });
    }
    const pick = weightedPick(rng, candidates);
    if (!pick) break;
    const def = AFFIXES[pick.id];
    const tierDef = def.tiers[pick.tier];
    if (!tierDef) break;
    const value = roundTo(rng.range(tierDef.min, tierDef.max), def.decimals ?? 0);
    out.push(def.ranged && rng.next() < def.ranged.share ? rangedRoll(pick.id, pick.tier, value) : { id: pick.id, tier: pick.tier, value });
    usedGroups.add(def.group);
    slotCounts[def.slot]++;
  }
  return out;
}

/**
 * A ranged roll around a normal one: `spread` either side, kept inside the affix's limits. It keeps
 * the tier of the roll it is centred on. A range with no room left (Split's 2 or 6) stays a number.
 */
function rangedRoll(id: AffixId, tier: number, centre: number): AffixRoll {
  const def = AFFIXES[id];
  const r = def.ranged;
  if (!r) return { id, tier, value: centre };
  // Symmetric about the roll it replaces, so its average (what Force and the price count) is that
  // roll and sits in its tier; a limit narrows both sides alike.
  const want = roundTo(r.absolute ? r.spread : centre * r.spread, def.decimals ?? 0);
  const half = Math.min(want, centre - (r.min ?? -Infinity), (r.max ?? Infinity) - centre);
  return half > 0 ? { id, tier, value: roundTo(centre - half, def.decimals ?? 0), max: roundTo(centre + half, def.decimals ?? 0) } : { id, tier, value: centre };
}

export function affixValue(affixes: readonly AffixRoll[], id: AffixId): number {
  let v = 0;
  for (const a of affixes) if (a.id === id) v += a.value;
  return v;
}

export function hasAffix(affixes: readonly AffixRoll[], id: AffixId): boolean {
  return affixes.some((a) => a.id === id);
}

export function behaviourOf(affixes: readonly AffixRoll[]): BehaviourAffixId | null {
  for (const a of affixes) if (a.id === 'bodyguard' || a.id === 'hunter' || a.id === 'coward') return a.id;
  return null;
}

/** A roll's line: "+30% damage", and a ranged roll as "+20 to 60% damage". */
export function formatAffix(a: AffixRoll): string {
  const def = AFFIXES[a.id];
  const n = formatNumber(a.value, def.decimals ?? 0);
  const low = def.signed && a.value > 0 ? `+${n}` : n;
  const shown = a.max !== undefined && a.max > a.value ? `${low} to ${formatNumber(a.max, def.decimals ?? 0)}` : low;
  return affixText(def, shown, formatNumber(a.value * (def.spread ?? 1), def.decimals ?? 0));
}

/**
 * A rune's implicit line, with what it gives at the live base numbers: "104% base damage",
 * "Releases after 0.48 s", "+31% speed". Null for a rune with no implicit.
 */
export function formatImplicit(item: RuneItem): string | null {
  const i = runeImplicit(item);
  if (!i || !isAffixId(i.id)) return null;
  const v = i.value;
  const pct = formatNumber(v, 0);
  const seconds = (base: number): string => String(Number(((base * 100) / Math.max(1e-9, v)).toFixed(2)));
  switch (i.id) {
    case 'implicit_base':
      return `${pct}% base damage`;
    case 'implicit_aura':
      return `${pct}% aura area`;
    case 'implicit_bond':
      return `${pct}% bond strength`;
    case 'implicit_conversion':
      return `Converts at ${pct}% to ${item.rune}`;
    case 'implicit_split':
      return v > 0 ? `Up to ${formatNumber(v, 0)} extra ${v === 1 ? 'copy' : 'copies'} on a cast` : 'No extra copies';
    case 'implicit_fuse':
      return `Releases after ${seconds(SPELL.timerSeconds)} s`;
    case 'implicit_pulse':
      return `Releases every ${seconds(SPELL.pulseSeconds)} s`;
    case 'implicit_payload':
      return `Its payload deals ${pct}% damage`;
    case 'implicit_effect':
      return `${pct}% ${item.rune === 'impact' ? 'knockback' : item.rune === 'ward' ? 'shield' : 'healing'}`;
    case 'implicit_modifier': {
      const effect = item.rune === 'swift' ? PLAIN_MODIFIER_EFFECT.swift : PLAIN_MODIFIER_EFFECT.large;
      return `+${formatNumber((effect.value * v) / 100, 1)}% ${effect.key}`;
    }
    case 'implicit_focus':
      return `${formatNumber((-CONCENTRATED.sizePercent * 100) / Math.max(1e-9, v), 1)}% less size`;
    default:
      return affixText(AFFIXES[i.id], pct, pct);
  }
}

export function vesselSpirit(item: VesselItem): number {
  return SPIRIT.vesselBaseByTier[item.tier] + SPIRIT.vesselPerAffix * item.affixes.length;
}

function tierLabel(tier: ItemTier): string {
  return tier[0]?.toUpperCase() + tier.slice(1);
}

function nameFromAffixes(base: string, affixes: readonly AffixRoll[]): string {
  const prefix = affixes.find((a) => AFFIXES[a.id].slot === 'prefix');
  const suffix = affixes.find((a) => AFFIXES[a.id].slot === 'suffix');
  return [prefix ? AFFIXES[prefix.id].nameWord : null, base, suffix ? AFFIXES[suffix.id].nameWord : null]
    .filter((s) => s !== null)
    .join(' ');
}

export function rollTier(rng: Rng, weights: Record<ItemTier, number>): ItemTier {
  return weightedPick(rng, ITEM_TIERS.map((t) => ({ item: t, weight: weights[t] }))) ?? 'common';
}

export interface SigilOptions {
  ilvl?: number;
  allowCorrupt?: boolean;
}

/** A blank sigil with rolled wand stats. Sigils that come with a spell are made in data/starterSigils.ts. */
/** The name a common or magic sigil gets from its affixes ("Quick Magic Sigil of Echoes"); rares and relics get rolled names. */
export function affixSigilName(tier: ItemTier, affixes: readonly AffixRoll[]): string {
  return nameFromAffixes(`${tierLabel(tier)} Sigil`, affixes);
}

export function createSigil(uid: ItemUid, rng: Rng, tier: ItemTier, opts: SigilOptions = {}): SigilItem {
  const ilvl = opts.ilvl ?? 1;
  const rolls = TIER_ROLLS[tier];
  const affixes = rollAffixes(rng, 'sigil', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)));
  const corrupted = (opts.allowCorrupt ?? false) && tier !== 'common' && rng.next() < LOOT.corruptChance;
  const name = tier === 'rare' || tier === 'relic' ? rareName(rng) : affixSigilName(tier, affixes);
  return { uid, kind: 'sigil', tier, name: (corrupted ? 'Corrupted ' : '') + name, ilvl, affixes, slots: [], corrupted };
}

export function createVessel(uid: ItemUid, rng: Rng, tier: ItemTier, minion?: MinionTypeId, ilvl = 1): VesselItem {
  const rolls = TIER_ROLLS[tier];
  const type = minion ?? MINION_TYPE_IDS[rng.int(0, MINION_TYPE_IDS.length - 1)] ?? 'zombie_brute';
  const affixes = rollAffixes(rng, 'vessel', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)));
  const base = `${MINION_DEFS[type].name} Vessel`;
  const item: VesselItem = {
    uid,
    kind: 'vessel',
    tier,
    name: tier === 'rare' || tier === 'relic' ? rareName(rng) : nameFromAffixes(base, affixes),
    minion: type,
    level: Math.max(1, ilvl) + ITEM_TIERS.indexOf(tier) + rng.int(0, 1),
    ilvl,
    affixes,
  };
  if (MINION_DEFS[type].pack) {
    const size = HOUND_PACK.packmatesByTier[tier];
    item.pack = rng.int(size.min, size.max);
  }
  return item;
}

/** Packmates a pack vessel binds; 1 for a pack vessel saved without the roll, 0 for other minions. */
export function vesselPackmates(item: VesselItem): number {
  if (!MINION_DEFS[item.minion].pack) return 0;
  const n = item.pack ?? 1;
  return Number.isInteger(n) ? Math.max(1, Math.min(HOUND_PACK.flankAngles.length, n)) : 1;
}

/** The owner's brothers' Hound vessel, for the admin grant tool: a relic with the full pack and a fixed name. */
export const BROTHERS_CREATION = {
  name: 'Brothers Creation',
  lore: 'Made by the brothers.',
  /** Fixed rolls at the top tier: a fast, hardy pack that comes back quickly, and no behaviour affix. */
  affixes: [
    { id: 'hasted', tier: 2, value: 50 },
    { id: 'armored', tier: 2, value: 100 },
    { id: 'attack_speed', tier: 2, value: 35 },
    { id: 'faster_respawn', tier: 2, value: 40 },
  ],
} as const satisfies { name: string; lore: string; affixes: readonly AffixRoll[] };

export function createBrothersCreation(uid: ItemUid, ilvl: number): VesselItem {
  const level = Math.max(1, Math.floor(ilvl));
  return {
    uid,
    kind: 'vessel',
    tier: 'relic',
    name: BROTHERS_CREATION.name,
    minion: 'hound',
    level: level + ITEM_TIERS.indexOf('relic') + 1,
    ilvl: level,
    affixes: BROTHERS_CREATION.affixes.map((a) => ({ ...a })),
    pack: HOUND_PACK.flankAngles.length,
    fixedName: true,
    lore: BROTHERS_CREATION.lore,
  };
}

/** Misfire chance for a cast made at `heat`. Linear from 0 at max heat to the configured cap at overheat max. */
export function misfireChance(heat: number, misfireMultiplier: number, heatMax: number = HEAT.max): number {
  if (heat <= heatMax) return 0;
  const over = (heat - heatMax) / (heatMax * (HEAT.overheatMax / HEAT.max) - heatMax);
  return Math.min(1, over * HEAT.misfireChanceAtCap * misfireMultiplier);
}

/**
 * A piece of equipment: a base type for its category that is at or below the item level, plus
 * affixes that suit the category. Weapons respect the base's class list when a class is given.
 */
export function createGear(uid: ItemUid, rng: Rng, tier: ItemTier, ilvl: number, opts: { category?: GearCategory; classId?: ClassId; base?: string } = {}): GearItem {
  const eligible = GEAR_BASES.filter(
    (b) => b.level <= Math.max(1, ilvl) && (!opts.category || b.category === opts.category) && (!opts.classId || !b.classes || b.classes.includes(opts.classId)),
  );
  // Slot first, then base: weapons have one base per class family, so a flat pick over bases made
  // nearly a third of all gear drops weapons, most of them for someone else's class.
  const categories = [...new Set(eligible.map((b) => b.category))];
  const category = categories[rng.int(0, Math.max(0, categories.length - 1))];
  const pool = eligible.filter((b) => b.category === category);
  const base = (opts.base ? gearBase(opts.base) : undefined) ?? pool[rng.int(0, Math.max(0, pool.length - 1))] ?? GEAR_BASES[0];
  if (!base) throw new Error('no gear bases defined');
  const rolls = TIER_ROLLS[tier];
  const affixes = rollAffixes(rng, 'gear', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)), { category: base.category });
  const name = tier === 'rare' || tier === 'relic' ? `${rareName(rng)} ${base.name}` : nameFromAffixes(base.name, affixes);
  return { uid, kind: 'gear', tier, name, ilvl, base: base.id, category: base.category, affixes };
}

const AFFIX_STAT: Partial<Record<AffixId, StatId>> = GEAR_AFFIX_STATS;

function isStatId(k: string): k is StatId {
  return STAT_IDS.some((s) => s === k);
}

/** Sums implicit and affix stats over a set of gear. */
export function gearStats(items: readonly GearItem[]): StatBlock {
  const out: StatBlock = {};
  const add = (k: StatId, v: number): void => {
    out[k] = (out[k] ?? 0) + v;
  };
  for (const it of items) {
    const base = gearBase(it.base);
    if (base) for (const [k, v] of Object.entries(base.implicit)) if (isStatId(k) && v !== undefined) add(k, v);
    for (const a of it.affixes) {
      const stat = AFFIX_STAT[a.id];
      if (stat) add(stat, a.value);
    }
  }
  return out;
}

/** Starter items cannot be sold, dropped or stashed. */
export function isBound(item: Item): boolean {
  return item.bound === true;
}

/** A sigil holding bound runes would carry them to another player or the stash, so it stays too. */
export function holdsBoundRunes(item: Item): boolean {
  return item.kind === 'sigil' && item.slots.some(isBound);
}

/**
 * One minion to start: with no basic attack every class fights with its skills, and two free
 * minions on top made the Binder clearly ahead. More vessels drop as loot.
 */
export const STARTER_VESSELS: MinionTypeId[] = ['zombie_brute'];
