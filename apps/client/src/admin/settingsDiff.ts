import { DEFAULT_SERVER_SETTINGS, sameStarterDamage, starterDamageOf, STARTER_SIGILS, type ServerSettings, type StarterDamage } from '@rune/shared';

/**
 * What the admin changed on the Settings form, against what the page loaded. Only that goes to the
 * server, so a page left open does not put back values changed meanwhile elsewhere (`pnpm admin`,
 * another tab).
 */

type PlainKey = Exclude<keyof ServerSettings, 'starterDamage'>;

function isPlainKey(k: string): k is PlainKey {
  return k !== 'starterDamage' && k in DEFAULT_SERVER_SETTINGS;
}

function copy<K extends PlainKey>(out: Partial<ServerSettings>, from: ServerSettings, k: K): void {
  out[k] = from[k];
}

/** Every field but the starter table whose value differs from the loaded one. */
export function changedSettings(saved: ServerSettings, draft: ServerSettings): Partial<ServerSettings> {
  const out: Partial<ServerSettings> = {};
  for (const k of Object.keys(DEFAULT_SERVER_SETTINGS)) {
    if (isPlainKey(k) && draft[k] !== saved[k]) copy(out, draft, k);
  }
  return out;
}

/** Starter id to the multiplier the admin set (1 resets it), only for the rows they changed. */
export function starterChanges(saved: StarterDamage, draft: StarterDamage): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const def of STARTER_SIGILS) {
    const m = starterDamageOf(draft, def.id);
    if (m !== starterDamageOf(saved, def.id)) out.set(def.id, m);
  }
  return out;
}

/** The changed rows laid over the server's current table, which the PUT then replaces whole. */
export function mergeStarterChanges(current: StarterDamage, changes: ReadonlyMap<string, number>): StarterDamage {
  const out: Record<string, number> = { ...current };
  for (const [id, m] of changes) {
    if (m === 1) delete out[id];
    else out[id] = m;
  }
  return out;
}

export function settingsDirty(saved: ServerSettings, draft: ServerSettings): boolean {
  return Object.keys(changedSettings(saved, draft)).length > 0 || !sameStarterDamage(saved.starterDamage, draft.starterDamage);
}
