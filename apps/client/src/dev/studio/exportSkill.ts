import type { StudioSkill } from './studioSim.js';

function str(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Formats a skill as an entry for `STARTER_SIGILS` in packages/shared/src/data/starterSigils.ts. */
export function formatSkill(def: StudioSkill): string {
  return `  { id: ${str(def.id)}, name: ${str(def.name)}, description: ${str(def.description)}, classId: ${str(def.classId)}, runes: spell(${str(def.text.trim())}) },`;
}

/** Lowercase snake id from a display name, for skills that have not been given one. */
export function skillIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || 'custom_skill';
}
