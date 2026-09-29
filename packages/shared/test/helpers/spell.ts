import { compileRunes, DEFAULT_SIGIL_CONTEXT, runeItemFromInstance, tokenizeSpell, type ClassId, type RuneItem, type SigilCompile } from '../../src/index.js';

/** Compiles the text form on an unrolled sigil with room for any spell. */
export function compileText(text: string, classId: ClassId = 'mage'): SigilCompile {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(`${text}: ${t.errors.map((e) => e.message).join('; ')}`);
  return compileRunes(t.runes, { ...DEFAULT_SIGIL_CONTEXT, classId });
}

/** The runes of the text form as sigil slots, as the forge would leave them. */
export function slotsFor(text: string, newUid: () => number, bound = false): RuneItem[] {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(`${text}: ${t.errors.map((e) => e.message).join('; ')}`);
  return t.runes.map((r) => runeItemFromInstance(newUid(), r, bound));
}
