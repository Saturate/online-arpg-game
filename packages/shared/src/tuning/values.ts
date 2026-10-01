/**
 * The wire shape of live tuning overrides, kept apart from the registry so protocol validation can
 * check it without loading the compiler.
 */

/** Overrides by path; a path missing here is at its code default. */
export type TunableValues = Record<string, number>;

/** Far above the registry's size; a bigger object did not come from a real server. */
const MAX_ENTRIES = 2000;

/** A flat object of finite numbers. Which paths exist and their ranges are checked when applied. */
export function isTunableValues(v: unknown): v is TunableValues {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length <= MAX_ENTRIES && values.every((n) => typeof n === 'number' && Number.isFinite(n));
}
