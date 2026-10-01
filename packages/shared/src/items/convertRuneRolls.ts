import { starterSigilById } from '../data/starterSigils.js';
import { tokenizeSpell } from '../runes/v2/tokenize.js';
import type { RuneInstance } from '../runes/v2/runes.js';
import { affixSigilName, holdsStarterRecipe, matchingStarter, runeItemFromInstance, runeRecipeKey, slotHoldsRecipeRune, type Item, type ItemUid, type RuneItem, type SigilItem } from './items.js';
import { clampRuneRolls, retierRoll } from './runeRolls.js';
import { BAG, findSpot, itemSize, place } from './grid.js';

/**
 * The owner's decisions of 2026-10-01, applied to items already in saves, stashes and the trader
 * shelf. It runs on every load instead of behind a format marker: what it looks for can no longer
 * be made (no drop rolls the retired affix, the old starter recipes hold rolls no rune outside its
 * first sigil can have, and new starter rolls are made at their honest tier), so a second pass
 * finds nothing.
 *
 * - "Nothing is free": the sigil affix "first rune is free" is removed. The sigil keeps its uid,
 *   tier, slots and every other affix; a name built from its affixes is built again without it.
 * - Multishot and Flame Cleave were buffed. A sigil still holding the old recipe, rune for rune
 *   (rune ids, counts and roll values in order, no bench runes), gets the new recipe. The first
 *   runes keep their uids and binding and take the new rolls. A rune the new recipe has no room for
 *   goes back to the player if it is unbound (it may be their own find), clamped like any rune
 *   leaving a sigil; a bound one was a starter-kit rune and goes. A sigil changed at the forge in
 *   any way is left alone.
 * - Hand-set starter rolls made before the change sit at tier 0 (T1) whatever their value; each
 *   roll stronger than its tier allows moves to the tier its value falls in (retierRoll).
 */

/** Sigil affix ids no longer in the game. They are not AffixIds any more, so they are matched as text. */
export const RETIRED_SIGIL_AFFIXES: ReadonlySet<string> = new Set(['first_rune_free']);

/** The name word each retired affix gave a sigil named from its affixes. */
const RETIRED_NAME_WORDS: readonly string[] = ['Primed'];

/**
 * The recipes the buffed starters had before 2026-10-01, in the Spell Lab's text form. A change to
 * a starter's numbers needs no entry: a sigil holding its starter's runes in order casts the live
 * recipe whatever its rolls (castingSlots). Only a change to which runes a recipe holds does.
 */
export const OLD_STARTER_RUNES: Readonly<Record<string, string>> = {
  multishot: 'bolt[pierce 2, +60% damage] split(3) split(3)',
  flame_cleave: 'bolt[-50% duration, +60% size] fire split(3)',
};

export interface StarterRebuild {
  sigil: ItemUid;
  starter: string;
  /** Bound rune uids that left the sigil because the new recipe is shorter; they are gone. */
  runesRemoved: ItemUid[];
  /** Unbound rune uids that left the sigil; they come back to the player as loose runes. */
  runesReturned: ItemUid[];
}

/** What one pass changed, for the server log and the conversion check. */
export interface RuneRollsReport {
  /** Sigils that lost a retired affix. */
  affixesRemoved: ItemUid[];
  /** Sigils renamed because their name carried a retired affix's word. */
  renamed: { uid: ItemUid; from: string; to: string }[];
  startersRebuilt: StarterRebuild[];
  /** Rune uids (loose or in a sigil) with a roll moved to its honest tier. */
  runesRetiered: ItemUid[];
}

export function emptyRuneRollsReport(): RuneRollsReport {
  return { affixesRemoved: [], renamed: [], startersRebuilt: [], runesRetiered: [] };
}

export function runeRollsChanged(r: RuneRollsReport): boolean {
  return r.affixesRemoved.length > 0 || r.renamed.length > 0 || r.startersRebuilt.length > 0 || r.runesRetiered.length > 0;
}

/** The old recipe of a buffed starter, or null for a starter that kept its runes. */
export function oldStarterRunes(starter: string): RuneInstance[] | null {
  const text = OLD_STARTER_RUNES[starter];
  if (text === undefined) return null;
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(`old starter recipe "${text}": ${t.errors.map((e) => e.message).join('; ')}`);
  return t.runes;
}

/** Tiers are left out: old starter rolls were made at tier 0, new ones at their honest tier. */
const recipeKey = (inst: RuneInstance): string => runeRecipeKey(runeItemFromInstance(0, inst, false));

function sameRune(slot: RuneItem, inst: RuneInstance): boolean {
  return slot.bench !== true && slot.count === 1 && runeRecipeKey(slot) === recipeKey(inst);
}

function retierRune(rune: RuneItem, report: RuneRollsReport): RuneItem {
  const affixes = rune.affixes.map(retierRoll);
  if (affixes.every((a, i) => a === rune.affixes[i])) return rune;
  report.runesRetiered.push(rune.uid);
  return { ...rune, affixes };
}

function renamed(sigil: SigilItem, affixes: SigilItem['affixes']): string {
  const words = sigil.name.split(' ');
  if (!words.some((w) => RETIRED_NAME_WORDS.includes(w))) return sigil.name;
  const corrupted = words[0] === 'Corrupted' ? 'Corrupted ' : '';
  if (sigil.tier === 'common' || sigil.tier === 'magic') return corrupted + affixSigilName(sigil.tier, affixes);
  return words.filter((w) => !RETIRED_NAME_WORDS.includes(w)).join(' ');
}

/** The sigil after the pass, the runes it hands back, and what changed. */
export function convertSigilRolls(sigil: SigilItem, report: RuneRollsReport): { sigil: SigilItem; returned: RuneItem[] } {
  const affixes = sigil.affixes.filter((a) => !RETIRED_SIGIL_AFFIXES.has(a.id));
  if (affixes.length !== sigil.affixes.length) report.affixesRemoved.push(sigil.uid);
  const name = renamed(sigil, affixes);
  if (name !== sigil.name) report.renamed.push({ uid: sigil.uid, from: sigil.name, to: name });
  let slots = sigil.slots;
  const returned: RuneItem[] = [];
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
    const out = sigil.slots.slice(def.runes.length);
    for (const r of out) if (r.bound !== true) returned.push(retierRune(clampRuneRolls(r), emptyRuneRollsReport()));
    report.startersRebuilt.push({
      sigil: sigil.uid,
      starter: def.id,
      runesRemoved: out.filter((r) => r.bound === true).map((r) => r.uid),
      runesReturned: out.filter((r) => r.bound !== true).map((r) => r.uid),
    });
  }
  const retiered = slots.map((r) => retierRune(r, report));
  if (retiered.some((r, i) => r !== slots[i])) slots = retiered;
  if (affixes.length === sigil.affixes.length && name === sigil.name && slots === sigil.slots) return { sigil, returned };
  return { sigil: { ...sigil, name, affixes, slots }, returned };
}

/** One item after the pass, and any runes a rebuilt sigil hands back. */
export function convertItemRolls(item: Item, report: RuneRollsReport): { item: Item; returned: RuneItem[] } {
  if (item.kind === 'rune') return { item: retierRune(item, report), returned: [] };
  if (item.kind !== 'sigil') return { item, returned: [] };
  const r = convertSigilRolls(item, report);
  return { item: r.sigil, returned: r.returned };
}

/**
 * A list of items after the pass, in the same order, plus the loose runes rebuilt sigils hand back
 * (each keeps the uid it had in its slot). The caller finds them a place.
 */
export function convertRuneRolls(items: readonly Item[]): { items: Item[]; returned: RuneItem[]; report: RuneRollsReport } {
  const report = emptyRuneRollsReport();
  const returned: RuneItem[] = [];
  const out = items.map((it) => {
    const r = convertItemRolls(it, report);
    returned.push(...r.returned);
    return r.item;
  });
  return { items: out, returned, report };
}

/**
 * A bag grid with the returned runes put in the first free cells. Runes that do not fit, or a grid
 * of another size (laid out afresh on load anyway), are left out of it: they stay in the save's
 * items in no grid, which is pending, and pending items find a place when the character joins.
 */
export function placeReturned(cells: readonly (ItemUid | null)[], runes: readonly RuneItem[]): (ItemUid | null)[] {
  const out = [...cells];
  if (out.length !== BAG.w * BAG.h) return out;
  for (const r of runes) {
    const spot = findSpot(out, BAG, itemSize(r));
    if (spot) place(out, BAG, r.uid, itemSize(r), spot.x, spot.y);
  }
  return out;
}

const affixKinds = (affixes: readonly { id: string }[]): string => affixes.map((a) => a.id).sort().join(',');
const runeKinds = (r: RuneInstance | undefined): string | null => (r ? `${r.id}|${affixKinds(runeItemFromInstance(0, r, false).affixes)}` : null);

/**
 * The starter's own runes in a sigil that holds its starter's runes in order but no longer casts
 * as it: a sign that the recipe changed in code (its affix kinds, or a roll's honest tier went up)
 * without an OLD_STARTER_RUNES entry, so every copy casts clamped. A rune is the starter's own when
 * it is not from the bench, is bound or rolled past every drop table (no player can make one), and
 * has the rune id and affix kinds this starter's recipe, now or in OLD_STARTER_RUNES, had at that
 * slot. A kit rune moved in from another starter, or the player's own find, is theirs to change.
 */
export function starterRunesOffRecipe(sigil: SigilItem): RuneItem[] {
  if (holdsStarterRecipe(sigil)) return [];
  const def = matchingStarter(sigil);
  if (!def) return [];
  const old = oldStarterRunes(def.id);
  return sigil.slots.filter((slot, i) => {
    const recipe = def.runes[i];
    if (recipe === undefined || slotHoldsRecipeRune(slot, recipe) || slot.bench === true) return false;
    if (slot.bound !== true && clampRuneRolls(slot) === slot) return false;
    const own = `${slot.rune}|${affixKinds(slot.affixes)}`;
    return own === runeKinds(recipe) || own === runeKinds(old?.[i]);
  });
}
