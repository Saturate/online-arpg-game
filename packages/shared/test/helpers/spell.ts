import { compileRunes, DEFAULT_SIGIL_CONTEXT, runeItemFromInstance, starterSigilById, tokenizeSpell, type ClassId, type RuneItem, type SigilCompile, type SigilItem } from '../../src/index.js';

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

/**
 * The kit recipes before 2026-10-01 put every roll in the drop tables: hand-set rolls past any drop.
 * Characters made before then still hold sigils like these, and keep them as stored.
 */
export const OLD_KIT_RUNES: Readonly<Record<string, string>> = {
  fireball: 'orb[onhit, -15% speed, +100% damage] fire nova[after 0.5s] zone[+30% duration]',
  frozen_orb: 'orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage] cold split(3) bolt',
  blink: 'dash[+69% speed]',
  flame_cleave: 'nova[-40% size, +50% damage] fire',
  multishot: 'bolt[pierce 2, +300% damage] split(5)',
  bone_spear: 'bolt[pierce 4, +50% speed, +40% damage]',
};

/** A kit sigil as an old save holds it: common, named after its kit, with the old hand-set rolls. */
export function oldKitSigil(id: string, newUid: () => number, bound: boolean): SigilItem {
  const text = OLD_KIT_RUNES[id];
  const def = starterSigilById(id);
  if (text === undefined || !def) throw new Error(`no old kit ${id}`);
  const sigil: SigilItem = { uid: newUid(), kind: 'sigil', tier: 'common', name: def.name, ilvl: 1, affixes: [], slots: slotsFor(text, newUid, bound), corrupted: false, starter: id };
  if (bound) sigil.bound = true;
  return sigil;
}
