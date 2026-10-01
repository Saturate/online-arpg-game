import { HEAT, HOUND_PACK, LOOT, SIM, SPIRIT } from '../config/sim.js';
import { AFFIXES, AFFIX_IDS, type AffixId, type AffixTarget, type BehaviourAffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import { formatNumber, GEAR_AFFIX_STATS, GEAR_BASES, gearBase, STAT_IDS, type GearCategory, type StatBlock, type StatId } from '../data/gear.js';
import { MINION_DEFS, MINION_TYPE_IDS, type MinionTypeId } from '../data/minions.js';
import { liveStarterRunes, starterSigilById, type StarterSigilDef } from '../data/starterSigils.js';
import { FORGE } from '../config/forge.js';
import { clampRuneRolls, honestTier } from './runeRolls.js';
import { affixesFor, CASTABLE_RUNES, runeKind, runeName, type AffixKey, type RuneAffixes, type RuneId, type RuneInstance } from '../runes/v2/runes.js';
import type { Rng } from '../sim/rng.js';

export { clampRoll, clampRuneRolls, honestTier, isNoStronger, retierRoll, rollLosses } from './runeRolls.js';

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

const MAX_PER_SLOT = 3;

export interface AffixRoll {
  id: AffixId;
  tier: number;
  value: number;
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
}

export type Item = SigilItem | VesselItem | GearItem | RuneItem;

export const RUNE_STACK = 20;

/** Shapes and infusions are common, what they do is rarer, and triggers and shapers (which chain spells) are the rare finds. */
export function runeTier(rune: RuneId): ItemTier {
  const k = runeKind(rune);
  return k === 'shape' || k === 'infusion' ? 'common' : k === 'effect' || k === 'modifier' ? 'magic' : 'rare';
}

export function createRune(uid: ItemUid, rune: RuneId, count = 1): RuneItem {
  return { uid, kind: 'rune', tier: runeTier(rune), name: `${runeName(rune)} Rune`, ilvl: 1, rune, count, affixes: [] };
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
  const maxAffixTier = Math.min(TIER_ROLLS[tier === 'common' ? 'magic' : tier].maxAffixTier, ilvlAffixTier(ilvl));
  // A rune rolled for its amount always gets that roll, whatever the drop tier allows.
  const count = Math.max(rng.int(n.min, n.max), dropsRolled(id) ? 1 : 0);
  const affixes = rollAffixes(rng, 'rune', count, maxAffixTier, { rune: id, allow: (a) => runeMayCarry(id, a) });
  const itemTier = ITEM_TIERS[Math.max(ITEM_TIERS.indexOf(tier), ITEM_TIERS.indexOf(runeTier(id)), 1)] ?? 'magic';
  return { uid, kind: 'rune', tier: itemTier, name: nameFromAffixes(`${runeName(id)} Rune`, affixes), ilvl: Math.max(1, ilvl), rune: id, count: 1, affixes };
}

/**
 * The grammar's view of a rune item: its id and what its affixes set. Values add up, so two rolls
 * of the same number affix stack like doubled runes do.
 */
export function toRuneInstance(item: RuneItem): RuneInstance {
  const a: RuneAffixes = {};
  const add = (key: 'speed' | 'size' | 'duration' | 'damage' | 'pierce' | 'count' | 'concentration', v: number): void => {
    a[key] = (a[key] ?? 0) + v;
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
        break;
      case 'rune_pierce':
        add('pierce', roll.value);
        break;
      case 'split_count':
        add('count', roll.value);
        break;
      case 'rune_concentrated':
        add('concentration', roll.value);
        break;
      default:
        break;
    }
  }
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
    if (key !== 'speed' && key !== 'size' && key !== 'duration' && key !== 'damage' && key !== 'pierce' && key !== 'count' && key !== 'concentration') {
      throw new Error(`${rune.id}: no rune affix sets ${key}`);
    }
    const v = a[key];
    if (v !== undefined) item.affixes.push({ id: AFFIX_FOR_KEY[key], tier: honestTier(AFFIX_FOR_KEY[key], v), value: v });
  }
  if (bound) item.bound = true;
  return item;
}

/**
 * The starter sigil this one still is: its `starter`, while the slots hold that starter's runes in
 * its order. Only the rune ids are compared, since balance passes retune the starters' rolls and
 * sigils already out there keep the rolls they were made with. Once the runes change, the sigil is
 * named and described by what it holds, not by the starter it came from.
 */
export function matchingStarter(item: SigilItem): StarterSigilDef | undefined {
  const def = starterSigilById(item.starter);
  if (!def || def.runes.length !== item.slots.length) return undefined;
  return def.runes.every((r, i) => item.slots[i]?.rune === r.id) ? def : undefined;
}

/** A rune by what it casts: its id and each roll's value, not the tier, uid or binding. */
export function runeRecipeKey(item: RuneItem): string {
  return `${item.rune}|${item.affixes.map((a) => `${a.id}:${a.value}`).sort().join(',')}`;
}

/**
 * Whether a rune in a starter's slot stands for the recipe's rune there: the same rune with the
 * same affix kinds, and each roll at least the honest tier of the recipe's roll (its value read
 * fresh, not the stored tier, which old saves have wrong). Values inside a tier are ignored, so a
 * copy made before a retune still matches; a weaker roll does not, so swapping a starter's rune for
 * a cheaper one and keeping the starter's numbers can never upgrade what the player holds.
 */
export function slotHoldsRecipeRune(slot: RuneItem, recipe: RuneInstance): boolean {
  if (slot.bench === true || slot.rune !== recipe.id) return false;
  const want = runeItemFromInstance(0, recipe, false).affixes;
  if (want.length !== slot.affixes.length) return false;
  return want.every((w) => {
    const have = slot.affixes.find((a) => a.id === w.id);
    return have !== undefined && honestTier(have.id, have.value) >= honestTier(w.id, w.value);
  });
}

/**
 * Whether the sigil casts as its starter: its own `starter` names the starter, and each slot holds
 * the recipe's rune for it (slotHoldsRecipeRune), checked against the code-default recipe so live
 * tuning never makes a copy stop matching. A sigil without that `starter` never casts a starter's
 * numbers, even holding the same runes. Bench runes are free and made on the spot, so a starter
 * refilled from the bench casts what they are.
 */
export function holdsStarterRecipe(item: SigilItem): boolean {
  const def = matchingStarter(item);
  if (!def) return false;
  return def.runes.every((r, i) => {
    const slot = item.slots[i];
    return slot !== undefined && slotHoldsRecipeRune(slot, r);
  });
}

/** The starter this sigil casts as (holdsStarterRecipe), for its name, description and filters. */
export function castingStarter(item: SigilItem): StarterSigilDef | undefined {
  return holdsStarterRecipe(item) ? matchingStarter(item) : undefined;
}

/** The slot's rune item with the live recipe's rolls instead of its own; the same object when they are equal. */
function withLiveRolls(slot: RuneItem, inst: RuneInstance): RuneItem {
  const affixes = runeItemFromInstance(slot.uid, inst, false).affixes;
  const same = affixes.length === slot.affixes.length && affixes.every((a, i) => {
    const b = slot.affixes[i];
    return b !== undefined && a.id === b.id && a.value === b.value && a.tier === b.tier;
  });
  return same ? slot : { ...slot, affixes };
}

/**
 * The runes as they cast. A whole starter casts its live recipe numbers (the code defaults with any
 * live tuning), not the rolls stored on its runes, so a retune reaches every copy at once and none
 * is clamped by it. The stored rolls stay on the items for prices and for what comes out of the sigil.
 *
 * Anything else casts its rolls clamped into the loot table, as they would be if they came out: a
 * starter's hand-set rolls (Multishot's +300% damage, Frozen Orb's 0.18 s pulse) are balanced for
 * the whole starter, and kept alone, reordered or beside other runes a +300% Bolt dealt 2.85x the
 * best starter's damage per Force. Putting the starter back together restores it.
 */
export function castingSlots(item: SigilItem): RuneItem[] {
  const def = castingStarter(item);
  if (!def) return item.slots.map(clampRuneRolls);
  const live = liveStarterRunes(def);
  return item.slots.map((slot, i) => {
    const inst = live[i];
    return inst ? withLiveRolls(slot, inst) : slot;
  });
}

/**
 * The runes to show with their rolls: a whole starter's live numbers, which is what it casts, and
 * otherwise the stored rolls, which are what come out of the sigil.
 */
export function shownSlots(item: SigilItem): RuneItem[] {
  return holdsStarterRecipe(item) ? castingSlots(item) : item.slots;
}

/**
 * Rune slots: the tier's base, plus the slots affix and one for corruption, capped at
 * SIGIL_MAX_SLOTS. A starter sigil always has room for its own runes.
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
  if (item.kind === 'sigil') return { ...item, uid, affixes: [...item.affixes], slots: item.slots.map((r) => ({ ...r, uid: newUid(), affixes: [...r.affixes] })) };
  return { ...item, uid, affixes: [...item.affixes] };
}

/** Affix tier unlocked by item level: T2 from level 3, T3 from level 5. */
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
  filter: { category?: GearCategory; rune?: RuneId; allow?: (id: AffixId) => boolean } = {},
): AffixRoll[] {
  const { category, rune, allow } = filter;
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
        if (tier <= maxAffixTier && t.weight > 0) candidates.push({ item: { id, tier }, weight: t.weight });
      });
    }
    const pick = weightedPick(rng, candidates);
    if (!pick) break;
    const def = AFFIXES[pick.id];
    const tierDef = def.tiers[pick.tier];
    if (!tierDef) break;
    out.push({ id: pick.id, tier: pick.tier, value: roundTo(rng.range(tierDef.min, tierDef.max), def.decimals ?? 0) });
    usedGroups.add(def.group);
    slotCounts[def.slot]++;
  }
  return out;
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

export function formatAffix(a: AffixRoll): string {
  const def = AFFIXES[a.id];
  const n = formatNumber(a.value, def.decimals ?? 0);
  return def.text.replace('{v}', def.signed && a.value > 0 ? `+${n}` : n);
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
