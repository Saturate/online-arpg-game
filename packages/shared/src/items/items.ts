import { HEAT, LOOT, SPIRIT } from '../config/sim.js';
import { AFFIXES, AFFIX_IDS, type AffixId, type AffixTarget, type BehaviourAffixId } from '../data/affixes.js';
import type { ClassId } from '../data/classes.js';
import { GEAR_AFFIX_STATS, GEAR_BASES, gearBase, STAT_IDS, type GearCategory, type StatBlock, type StatId } from '../data/gear.js';
import { MINION_DEFS, MINION_TYPE_IDS, type MinionTypeId } from '../data/minions.js';
import type { RuneId } from '../data/runes.js';
import { skillById, SKILLS } from '../data/skills.js';
import { compile, NEUTRAL_MODS, type CompileMods, type CompileResult } from '../runes/compiler.js';
import type { Rng } from '../sim/rng.js';

export const ITEM_TIERS = ['common', 'magic', 'rare', 'relic'] as const;
export type ItemTier = (typeof ITEM_TIERS)[number];

export const SIGIL_CAPACITY: Record<ItemTier, number> = { common: 3, magic: 4, rare: 5, relic: 6 };

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
  affixes: AffixRoll[];
  runes: RuneId[];
  corrupted: boolean;
  /** Prebaked skill id. Null for a blank or hand-inscribed sigil. */
  skill: string | null;
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
}

export type Item = SigilItem | VesselItem | GearItem;

export function sigilCapacity(item: SigilItem): number {
  return SIGIL_CAPACITY[item.tier] + (item.corrupted ? 1 : 0);
}

/** Affix tier unlocked by item level: T2 from level 3, T3 from level 5. */
function ilvlAffixTier(ilvl: number): number {
  return ilvl >= 5 ? 2 : ilvl >= 3 ? 1 : 0;
}

/**
 * Compiles whatever a sigil holds. Prebaked skills ignore slot capacity (they are not hand-built)
 * and carry their own tuning and entity budget.
 */
export function compileSigilItem(item: SigilItem, classId: ClassId, draft?: readonly RuneId[]): CompileResult {
  const skill = skillById(item.skill);
  const mods = sigilMods(item);
  if (skill && draft === undefined) {
    const result = compile(skill.runes, {
      classId,
      capacity: Infinity,
      mods,
      ...(skill.tuning ? { tuning: skill.tuning } : {}),
      ...(skill.maxEntities !== undefined ? { maxEntities: skill.maxEntities } : {}),
    });
    if (result.ok && skill.heat !== undefined && !result.persistent) return { ...result, heat: skill.heat * mods.heatMultiplier };
    return result;
  }
  return compile(draft ?? item.runes, { classId, capacity: sigilCapacity(item), mods });
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
export function rollAffixes(rng: Rng, target: AffixTarget, count: number, maxAffixTier: number, category?: GearCategory): AffixRoll[] {
  const out: AffixRoll[] = [];
  const usedGroups = new Set<string>();
  const slotCounts = { prefix: 0, suffix: 0 };
  for (let n = 0; n < count; n++) {
    const candidates: { item: { id: AffixId; tier: number }; weight: number }[] = [];
    for (const id of AFFIX_IDS) {
      const def = AFFIXES[id];
      if (!def.targets.includes(target) || usedGroups.has(def.group)) continue;
      if (category && def.slots && !def.slots.includes(category)) continue;
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
  return AFFIXES[a.id].text.replace('{v}', String(a.value));
}

export function sigilMods(item: SigilItem): CompileMods & { misfireMultiplier: number } {
  const a = item.affixes;
  return {
    ...NEUTRAL_MODS,
    maxDepthBonus: affixValue(a, 'max_depth'),
    splitEfficiencyBonus: affixValue(a, 'split_efficiency'),
    heatMultiplier: 1 - affixValue(a, 'heat_reduced') / 100,
    spiritMultiplier: 1 - affixValue(a, 'spirit_reduced') / 100,
    areaMultiplier: 1 + affixValue(a, 'area_increased') / 100,
    damageMultiplier: 1 + affixValue(a, 'damage_increased') / 100,
    misfireMultiplier: item.corrupted ? LOOT.corruptMisfireMultiplier : 1,
  };
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
  /** A prebaked skill id, `'random'` for any skill from the pool, or null for a blank sigil. */
  skill?: string | 'random' | null;
}

export function createSigil(uid: ItemUid, rng: Rng, tier: ItemTier, opts: SigilOptions = {}): SigilItem {
  const ilvl = opts.ilvl ?? 1;
  const rolls = TIER_ROLLS[tier];
  const affixes = rollAffixes(rng, 'sigil', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)));
  const corrupted = (opts.allowCorrupt ?? false) && tier !== 'common' && rng.next() < LOOT.corruptChance;
  const skill = opts.skill === 'random' ? (SKILLS[rng.int(0, SKILLS.length - 1)] ?? null) : (skillById(opts.skill) ?? null);
  const base = skill ? skill.name : `${tierLabel(tier)} Sigil`;
  const name = tier === 'rare' || tier === 'relic' ? rareName(rng) : nameFromAffixes(base, affixes);
  return {
    uid,
    kind: 'sigil',
    tier,
    name: (corrupted ? 'Corrupted ' : '') + name,
    ilvl,
    affixes,
    runes: skill ? [...skill.runes] : [],
    corrupted,
    skill: skill?.id ?? null,
  };
}

export function createVessel(uid: ItemUid, rng: Rng, tier: ItemTier, minion?: MinionTypeId, ilvl = 1): VesselItem {
  const rolls = TIER_ROLLS[tier];
  const type = minion ?? MINION_TYPE_IDS[rng.int(0, MINION_TYPE_IDS.length - 1)] ?? 'zombie_brute';
  const affixes = rollAffixes(rng, 'vessel', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)));
  const base = `${MINION_DEFS[type].name} Vessel`;
  return {
    uid,
    kind: 'vessel',
    tier,
    name: tier === 'rare' || tier === 'relic' ? rareName(rng) : nameFromAffixes(base, affixes),
    minion: type,
    level: Math.max(1, ilvl) + ITEM_TIERS.indexOf(tier) + rng.int(0, 1),
    ilvl,
    affixes,
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
  const affixes = rollAffixes(rng, 'gear', rng.int(rolls.min, rolls.max), Math.min(rolls.maxAffixTier, ilvlAffixTier(ilvl)), base.category);
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

/** A blank corrupted relic so rune combinations can be tried in the test arena. */
export const TEST_SIGIL = { tier: 'relic', corrupted: true, name: 'Test Sigil' } as const;

export const STARTER_VESSELS: MinionTypeId[] = ['zombie_brute', 'skeleton_archer'];
