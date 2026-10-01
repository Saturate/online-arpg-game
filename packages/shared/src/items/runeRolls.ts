import { AFFIXES, codeAffixTiers, isAffixId, RUNE_AFFIX_TIERS, type AffixId, type AffixTierDef } from '../data/affixes.js';
import type { AffixRoll, RuneItem } from './items.js';

/**
 * Rolls a rune can only have while it sits in a sigil. Kit sigils made before 2026-10-01 hold
 * hand-set rolls no drop can reach (Multishot's +300% damage Bolt), and some of those sigils are
 * unbound. A rune keeps its rolls inside the sigil and casts them as stored; once it comes out
 * (forge refund, bench, the rune roll pass) each affix value is brought back to the best its affix
 * can roll now (the live table, so tuning a range moves where extraction clamps), and the rune
 * cannot be sold, traded or reused above what the loot table allows. Values already inside the
 * table, or weaker than it (the negative speeds of old slow orbs), are left alone.
 */

/** Which way an affix gets stronger. `either`: neither end is the weaker one, so both are clamped. */
type Better = 'higher' | 'lower' | 'either';

const BETTER: Partial<Record<AffixId, Better>> = {
  // A shorter pulse fires more often.
  release_every: 'lower',
  // A fuse is a timing choice, not a strength: out-of-table times go to the nearest one a drop can have.
  release_after: 'either',
};

export function betterOf(id: AffixId): Better {
  return BETTER[id] ?? 'higher';
}

interface Range {
  min: { value: number; tier: number };
  max: { value: number; tier: number };
}

/** Tiers that can drop (weight above 0), with their index; all of them when none can. */
function liveTiers(tiers: readonly AffixTierDef[], upTo = Infinity): { t: AffixTierDef; tier: number }[] {
  const all = tiers.map((t, tier) => ({ t, tier })).filter(({ tier }) => tier <= upTo);
  return all.some(({ t }) => t.weight > 0) ? all.filter(({ t }) => t.weight > 0) : all;
}

/** The lowest and highest value the given tiers can roll, and the tier each comes from. */
function rangeOf(tiers: readonly AffixTierDef[], upTo = Infinity): Range | null {
  let range: Range | null = null;
  for (const { t, tier } of liveTiers(tiers, upTo)) {
    if (!range) {
      range = { min: { value: t.min, tier }, max: { value: t.max, tier } };
      continue;
    }
    if (t.min < range.min.value) range.min = { value: t.min, tier };
    if (t.max > range.max.value) range.max = { value: t.max, tier };
  }
  return range;
}

/** The lowest and highest value any live tier of the affix can roll. */
function rollRange(id: AffixId): Range | null {
  // Saves can hold an affix id the game no longer has (a retired affix); it has no table to clamp to.
  if (!isAffixId(id)) return null;
  return rangeOf(AFFIXES[id].tiers);
}

function clampInto(a: AffixRoll, range: Range | null): AffixRoll {
  if (!range) return a;
  const better = betterOf(a.id);
  // The tier only ever goes down: sell value and forge price count tiers, so a rune never comes out
  // worth more than it was inside.
  if ((better === 'higher' || better === 'either') && a.value > range.max.value) return { id: a.id, tier: Math.min(a.tier, range.max.tier), value: range.max.value };
  if ((better === 'lower' || better === 'either') && a.value < range.min.value) return { id: a.id, tier: Math.min(a.tier, range.min.tier), value: range.min.value };
  return a;
}

/** One roll as it would be outside a sigil: unchanged unless it is stronger than any drop can be. */
export function clampRoll(a: AffixRoll): AffixRoll {
  return clampInto(a, rollRange(a.id));
}

/** Whether `after` is no stronger than `before` for this affix; `either` affixes only count when they moved into the table. */
export function isNoStronger(before: AffixRoll, after: AffixRoll): boolean {
  const better = betterOf(before.id);
  if (better === 'higher') return after.value <= before.value;
  if (better === 'lower') return after.value >= before.value;
  return after.value === before.value || after.value === clampRoll(before).value;
}

/** The rune as it comes out of a sigil. Returns the same object when no roll changes. */
export function clampRuneRolls(item: RuneItem): RuneItem {
  const affixes = item.affixes.map(clampRoll);
  if (affixes.every((a, i) => a === item.affixes[i])) return item;
  return { ...item, affixes };
}

/** What taking the rune out of a sigil would cost it: each roll that changes, before and after. */
export function rollLosses(item: RuneItem): { before: AffixRoll; after: AffixRoll }[] {
  const out: { before: AffixRoll; after: AffixRoll }[] = [];
  for (const before of item.affixes) {
    const after = clampRoll(before);
    if (after !== before) out.push({ before, after });
  }
  return out;
}

/** The tier a value belongs to in these tiers: the lowest that holds it, the top when it is stronger than all, the bottom when weaker. */
function tierIn(tiers: readonly AffixTierDef[], id: AffixId, value: number): number {
  const live = liveTiers(tiers);
  const holding = live.find(({ t }) => value >= t.min && value <= t.max);
  if (holding) return holding.tier;
  const range = rangeOf(tiers);
  if (!range) return 0;
  const better = betterOf(id);
  if (better !== 'lower' && value > range.max.value) return range.max.tier;
  if (better === 'lower' && value < range.min.value) return range.min.tier;
  return live[0]?.tier ?? 0;
}

/**
 * The tier a value honestly belongs to in the live table: the lowest tier whose range holds it, the
 * top one when it is stronger than any drop, and the bottom one when it is weaker (a drawback).
 * Sell value and forge price count tiers, so a kit's split(5) prices as the roll it is.
 */
export function honestTier(id: AffixId, value: number): number {
  if (!isAffixId(id)) return 0;
  return tierIn(AFFIXES[id].tiers, id, value);
}

/**
 * The tier of a value in the code's own table, whatever tuning has set. The one-time re-tier of
 * old saves uses it, so a range tuned on the day a save first loads cannot move its tiers.
 */
function codeTier(id: AffixId, value: number): number {
  return tierIn(codeAffixTiers(id), id, value);
}

/** Whether the affix is a rune affix with the six tiers (release flags and fuses keep one). */
function sixTiers(id: AffixId): boolean {
  return AFFIXES[id].targets.includes('rune') && codeAffixTiers(id).length === RUNE_AFFIX_TIERS;
}

/**
 * A rune roll from a save made before the six rune tiers (2026-10-01): its tier index counted the
 * old three tiers, so it moves to the tier its value falls in among the six. The value never
 * changes. Rolls past every table (old kit rolls) land in T1. Sigil and other affixes kept their
 * tiers and are left alone, as is an affix id the game no longer has.
 */
export function sixTierRoll(a: AffixRoll): AffixRoll {
  if (!isAffixId(a.id) || !sixTiers(a.id)) return a;
  const tier = codeTier(a.id, a.value);
  return tier === a.tier ? a : { ...a, tier };
}

/**
 * A kit roll as a new kit gets it: inside the live table below T1 (the best tier is a rare find, not
 * something every character starts with), at the tier its value falls in. A recipe roll past that
 * comes down to its best; drawbacks are left as written.
 */
export function kitRoll(a: AffixRoll): AffixRoll {
  if (!isAffixId(a.id)) return a;
  const tiers = AFFIXES[a.id].tiers;
  const upTo = tiers.length === RUNE_AFFIX_TIERS ? RUNE_AFFIX_TIERS - 2 : Infinity;
  const clamped = clampInto(a, rangeOf(tiers, upTo));
  const tier = honestTier(a.id, clamped.value);
  return clamped.value === a.value && tier === a.tier ? a : { id: a.id, tier, value: clamped.value };
}
