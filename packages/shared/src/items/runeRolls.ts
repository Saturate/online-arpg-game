import { AFFIXES, type AffixId } from '../data/affixes.js';
import type { AffixRoll, RuneItem } from './items.js';

/**
 * Rolls a rune can only have while it sits in a sigil. Starter sigils hold hand-set rolls no drop
 * can reach (a +100% damage Orb, a 0.18 s pulse), and those sigils can be unbound. A rune keeps
 * its rolls inside the sigil; once it comes out (forge refund, bench, conversion) each affix value
 * is brought back to the best its affix can roll, so the rune cannot be sold, traded or reused
 * above what the loot table allows. Values already inside the table, or weaker than it (the
 * negative speeds of slow starter orbs), are left alone.
 */

/** Which way an affix gets stronger. `either`: neither end is the weaker one, so both are clamped. */
type Better = 'higher' | 'lower' | 'either';

const BETTER: Partial<Record<AffixId, Better>> = {
  // A shorter pulse fires more often.
  release_every: 'lower',
  // A fuse is a timing choice, not a strength: out-of-table times go to the nearest one a drop can have.
  release_after: 'either',
};

function betterOf(id: AffixId): Better {
  return BETTER[id] ?? 'higher';
}

interface Range {
  min: { value: number; tier: number };
  max: { value: number; tier: number };
}

/** The lowest and highest value any tier of the affix can roll, and the tier each comes from. */
function rollRange(id: AffixId): Range | null {
  const tiers = AFFIXES[id].tiers;
  // Tiers that never roll (weight 0) are not something a drop can have.
  const live = tiers.some((t) => t.weight > 0) ? tiers.map((t, tier) => ({ t, tier })).filter(({ t }) => t.weight > 0) : tiers.map((t, tier) => ({ t, tier }));
  let range: Range | null = null;
  for (const { t, tier } of live) {
    if (!range) {
      range = { min: { value: t.min, tier }, max: { value: t.max, tier } };
      continue;
    }
    if (t.min < range.min.value) range.min = { value: t.min, tier };
    if (t.max > range.max.value) range.max = { value: t.max, tier };
  }
  return range;
}

/** One roll as it would be outside a sigil: unchanged unless it is stronger than any drop can be. */
export function clampRoll(a: AffixRoll): AffixRoll {
  const range = rollRange(a.id);
  if (!range) return a;
  const better = betterOf(a.id);
  if ((better === 'higher' || better === 'either') && a.value > range.max.value) return { id: a.id, tier: range.max.tier, value: range.max.value };
  if ((better === 'lower' || better === 'either') && a.value < range.min.value) return { id: a.id, tier: range.min.tier, value: range.min.value };
  return a;
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
