import { NEUTRAL_TUNING, type SkillDef, type SpellTuning } from '@rune/shared';

const TUNING_KEYS: readonly (keyof SpellTuning)[] = ['speed', 'range', 'damage', 'radius', 'phase'];

function num(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function str(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Tuning fields that differ from neutral; the rest are left out, like the hand-written entries. */
export function tuningDelta(tuning: Partial<SpellTuning>): Partial<SpellTuning> {
  const out: Partial<SpellTuning> = {};
  for (const k of TUNING_KEYS) {
    const v = tuning[k];
    if (v !== undefined && Math.abs(v - NEUTRAL_TUNING[k]) > 1e-9) out[k] = v;
  }
  return out;
}

/** Formats a skill as an entry for `SKILLS` in packages/shared/src/data/skills.ts. */
export function formatSkill(def: SkillDef): string {
  const lines = [
    '  {',
    `    id: ${str(def.id)},`,
    `    name: ${str(def.name)},`,
    `    description: ${str(def.description)},`,
    `    classId: ${str(def.classId)},`,
    `    runes: [${def.runes.map(str).join(', ')}],`,
  ];
  const tuning = tuningDelta(def.tuning ?? {});
  const tuningKeys = TUNING_KEYS.filter((k) => tuning[k] !== undefined);
  if (tuningKeys.length > 0) lines.push(`    tuning: { ${tuningKeys.map((k) => `${k}: ${num(tuning[k] ?? 0)}`).join(', ')} },`);
  if (def.maxEntities !== undefined) lines.push(`    maxEntities: ${def.maxEntities},`);
  if (def.heat !== undefined) lines.push(`    heat: ${num(def.heat)},`);
  lines.push('  },');
  return lines.join('\n');
}

/** Lowercase snake id from a display name, for skills that have not been given one. */
export function skillIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || 'custom_skill';
}
