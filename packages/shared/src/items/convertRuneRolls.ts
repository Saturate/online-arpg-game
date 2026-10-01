import { starterSigilById } from '../data/starterSigils.js';
import { tokenizeSpell } from '../runes/v2/tokenize.js';
import type { RuneInstance } from '../runes/v2/runes.js';
import { runeItemFromInstance, type AffixRoll, type Item, type ItemUid, type RuneItem, type SigilItem } from './items.js';

/**
 * The owner's decisions of 2026-10-01, applied to items already in saves, stashes and the trader
 * shelf. It runs on every load instead of behind a format marker: what it looks for can no longer
 * be made (no drop rolls the retired affix, and the old starter recipes hold rolls no rune outside
 * its first sigil can have, since runes leaving a sigil are clamped), so a second pass finds nothing.
 *
 * - "Nothing is free": the sigil affix "first rune is free" is removed. The sigil keeps its uid,
 *   tier, name, slots and every other affix.
 * - Multishot and Flame Cleave were buffed. A sigil still holding the old recipe, rune for rune
 *   (rune ids, counts, affixes and their tiers, in order, no bench runes), gets the new recipe. The
 *   first runes keep their uids and binding and take the new rolls; runes the new recipe has no room
 *   for are removed, not returned, as the v1 conversion replaced starter runes. A sigil the player
 *   changed at the forge in any way is left alone.
 */

/** Sigil affix ids no longer in the game. They are not AffixIds any more, so they are matched as text. */
export const RETIRED_SIGIL_AFFIXES: ReadonlySet<string> = new Set(['first_rune_free']);

/** The recipes the buffed starters had before 2026-10-01, in the Spell Lab's text form. */
export const OLD_STARTER_RUNES: Readonly<Record<string, string>> = {
  multishot: 'bolt[pierce 2, +60% damage] split(3) split(3)',
  flame_cleave: 'bolt[-50% duration, +60% size] fire split(3)',
};

export interface StarterRebuild {
  sigil: ItemUid;
  starter: string;
  /** Rune uids that left the sigil because the new recipe is shorter. */
  runesRemoved: ItemUid[];
}

/** What one pass changed, for the server log and the conversion check. */
export interface RuneRollsReport {
  /** Sigils that lost a retired affix. */
  affixesRemoved: ItemUid[];
  startersRebuilt: StarterRebuild[];
}

export function emptyRuneRollsReport(): RuneRollsReport {
  return { affixesRemoved: [], startersRebuilt: [] };
}

export function runeRollsChanged(r: RuneRollsReport): boolean {
  return r.affixesRemoved.length > 0 || r.startersRebuilt.length > 0;
}

/** The old recipe of a buffed starter, or null for a starter that kept its runes. */
export function oldStarterRunes(starter: string): RuneInstance[] | null {
  const text = OLD_STARTER_RUNES[starter];
  if (text === undefined) return null;
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(`old starter recipe "${text}": ${t.errors.map((e) => e.message).join('; ')}`);
  return t.runes;
}

const rollsKey = (affixes: readonly AffixRoll[]): string => affixes.map((a) => `${a.id}:${a.tier}:${a.value}`).sort().join(',');

/** A rune of a written recipe as the starter sigil holds it: tier 0 rolls (runeItemFromInstance). */
const recipeKey = (inst: RuneInstance): string => `${inst.id}|${rollsKey(runeItemFromInstance(0, inst, false).affixes)}`;

/** Same rune id, count 1, not from the bench, and the same rolls (tiers included) as the recipe's rune. */
function sameRune(slot: RuneItem, inst: RuneInstance): boolean {
  return slot.bench !== true && slot.count === 1 && `${slot.rune}|${rollsKey(slot.affixes)}` === recipeKey(inst);
}

/** The sigil after the pass, and whether it lost a retired affix or was rebuilt. */
export function convertSigilRolls(sigil: SigilItem): { sigil: SigilItem; affixRemoved: boolean; rebuilt: StarterRebuild | null } {
  const affixes = sigil.affixes.filter((a) => !RETIRED_SIGIL_AFFIXES.has(a.id));
  const affixRemoved = affixes.length !== sigil.affixes.length;
  let slots = sigil.slots;
  let rebuilt: StarterRebuild | null = null;
  const def = starterSigilById(sigil.starter);
  const old = sigil.starter ? oldStarterRunes(sigil.starter) : null;
  if (def && old && old.length === sigil.slots.length && old.every((r, i) => {
    const slot = sigil.slots[i];
    return slot !== undefined && sameRune(slot, r);
  })) {
    slots = def.runes.map((inst, i) => {
      const was = sigil.slots[i];
      if (!was) throw new Error(`starter ${def.id}: the new recipe is longer than the old one`);
      // A rune the new recipe keeps as it was stays the very same item.
      const before = old[i];
      if (before && recipeKey(before) === recipeKey(inst)) return was;
      return runeItemFromInstance(was.uid, inst, was.bound === true);
    });
    rebuilt = { sigil: sigil.uid, starter: def.id, runesRemoved: sigil.slots.slice(def.runes.length).map((r) => r.uid) };
  }
  if (!affixRemoved && !rebuilt) return { sigil, affixRemoved, rebuilt };
  return { sigil: { ...sigil, affixes, slots }, affixRemoved, rebuilt };
}

/** One item after the pass; anything but a sigil comes back as it is. */
export function convertItemRolls(item: Item, report: RuneRollsReport): Item {
  if (item.kind !== 'sigil') return item;
  const r = convertSigilRolls(item);
  if (r.affixRemoved) report.affixesRemoved.push(item.uid);
  if (r.rebuilt) report.startersRebuilt.push(r.rebuilt);
  return r.sigil;
}

/** A list of items after the pass, in the same order, with what changed. */
export function convertRuneRolls(items: readonly Item[]): { items: Item[]; report: RuneRollsReport } {
  const report = emptyRuneRollsReport();
  return { items: items.map((it) => convertItemRolls(it, report)), report };
}
