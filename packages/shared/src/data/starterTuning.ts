import { STARTER_SIGILS } from './starterSigils.js';

/**
 * The admin's live damage multiplier per starter skill (ServerSettings.starterDamage). Starter
 * numbers live on each player's sigil item and a shape's base damage is shared by every spell of
 * that shape, so neither can buff one skill without touching items or player-made spells. The
 * multiplier applies only while a sigil holds its starter's whole recipe (`holdsStarterRecipe`),
 * at compile time, on damage alone (`compileSigilItem`).
 */

/** Sparse: starter id to multiplier, only for starters off the default of 1. */
export type StarterDamage = Readonly<Record<string, number>>;

export const NO_STARTER_DAMAGE: StarterDamage = {};

/**
 * The owner's range. It can push a starter past the 2x bound player-made spells are held to (3x
 * Freezing Arrow is 3x the best starter), so the admin page flags a row over the bound rather than
 * the limit forbidding it.
 */
export const STARTER_DAMAGE_LIMITS = { min: 0.5, max: 3 } as const;

/** Player-made spells are held to this many times the best starter's damage per Force (test/forcePerDamage.test.ts). */
export const DAMAGE_PER_FORCE_BOUND = 2;

const STARTER_IDS: ReadonlySet<string> = new Set(STARTER_SIGILS.map((s) => s.id));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function inRange(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= STARTER_DAMAGE_LIMITS.min && v <= STARTER_DAMAGE_LIMITS.max;
}

/** Strict, for the admin PUT: every key a starter id, every value in range. Entries of exactly 1 are dropped. */
export function parseStarterDamage(value: unknown): StarterDamage | string {
  if (!isRecord(value)) return 'starterDamage must be an object of starter id to multiplier';
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(value)) {
    if (!STARTER_IDS.has(id)) return `starterDamage: ${id} is not a starter skill`;
    if (!starterDealsDamage(id)) return `starterDamage: ${id} deals no damage, so it takes no multiplier`;
    if (!inRange(v)) return `starterDamage.${id} must be between ${STARTER_DAMAGE_LIMITS.min} and ${STARTER_DAMAGE_LIMITS.max}`;
    if (v !== 1) out[id] = v;
  }
  return out;
}

/**
 * Lenient, for a stored row: keeps every good entry and drops the rest, so a starter removed or
 * renamed in a later build does not reset the others.
 */
export function storedStarterDamage(value: unknown): { table: StarterDamage; dropped: string[] } {
  const out: Record<string, number> = {};
  const dropped: string[] = [];
  if (!isRecord(value)) return { table: out, dropped: value === undefined ? [] : ['the whole table'] };
  for (const [id, v] of Object.entries(value)) {
    if (starterDealsDamage(id) && inRange(v)) {
      if (v !== 1) out[id] = v;
    } else dropped.push(id);
  }
  return { table: out, dropped };
}

/** The client compiles tooltips and the forge with this, so a bad table is ignored rather than shown. */
export function isStarterDamage(value: unknown): value is StarterDamage {
  return isRecord(value) && Object.entries(value).every(([id, v]) => starterDealsDamage(id) && inRange(v));
}

/** A starter that deals no damage (heals, wards, auras, plain dashes) always reads 1, so nothing claims it is tuned. */
export function starterDamageOf(table: StarterDamage, starterId: string): number {
  const v = starterDealsDamage(starterId) ? table[starterId] : undefined;
  return typeof v === 'number' ? v : 1;
}

export function sameStarterDamage(a: StarterDamage, b: StarterDamage): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Each damage-dealing starter's damage per Force at multiplier 1, to one target and to a pack of 6,
 * as test/forcePerDamage.test.ts measures it (test/harness/skillDps.ts). Held to the harness by
 * test/starterTuning.test.ts, which prints the new table when a balance change moves it. The
 * harness's dummies never die, so damage per Force scales with the multiplier.
 */
export const STARTER_DAMAGE_PER_FORCE: Readonly<Record<string, { single: number; pack: number }>> = {
  fireball: { single: 1.985, pack: 7.103 },
  frozen_orb: { single: 1.492, pack: 5.722 },
  static_nova: { single: 0.913, pack: 5.477 },
  leap_slam: { single: 0.719, pack: 4.211 },
  war_cry: { single: 0.765, pack: 4.59 },
  flame_cleave: { single: 1.343, pack: 6.671 },
  multishot: { single: 0.772, pack: 2.317 },
  exploding_arrow: { single: 1.435, pack: 7.713 },
  freezing_arrow: { single: 2.127, pack: 5.4 },
  smite: { single: 1.28, pack: 2.559 },
  bone_spear: { single: 1.395, pack: 2.791 },
  corpse_blast: { single: 0.792, pack: 4.748 },
  frost_mire: { single: 0.466, pack: 2.799 },
};

const DAMAGE_STARTER_IDS: ReadonlySet<string> = new Set(Object.keys(STARTER_DAMAGE_PER_FORCE));

/** Whether the starter takes a multiplier: the harness measures it as dealing damage. */
export function starterDealsDamage(starterId: string): boolean {
  return DAMAGE_STARTER_IDS.has(starterId);
}

/** The best starter at the defaults: the reference player-made spells are held to. */
export const BEST_STARTER_PER_FORCE = {
  single: Math.max(0, ...Object.values(STARTER_DAMAGE_PER_FORCE).map((r) => r.single)),
  pack: Math.max(0, ...Object.values(STARTER_DAMAGE_PER_FORCE).map((r) => r.pack)),
};

export interface StarterDamageEstimate {
  single: number;
  pack: number;
  /** The larger of single and pack as a share of the best starter's at the defaults. */
  ofBest: number;
}

/** Damage per Force at `multiplier`, scaled from the measured table; null for a starter that deals no damage. */
export function starterDamageEstimate(starterId: string, multiplier: number): StarterDamageEstimate | null {
  const base = STARTER_DAMAGE_PER_FORCE[starterId];
  if (!base || BEST_STARTER_PER_FORCE.single <= 0 || BEST_STARTER_PER_FORCE.pack <= 0) return null;
  const single = base.single * multiplier;
  const pack = base.pack * multiplier;
  return { single, pack, ofBest: Math.max(single / BEST_STARTER_PER_FORCE.single, pack / BEST_STARTER_PER_FORCE.pack) };
}
