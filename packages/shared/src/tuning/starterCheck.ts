import { createStarterSigil, STARTER_SIGILS } from '../data/starterSigils.js';
import { compileSigilItem } from '../runes/v2/compile.js';
import { activeTunables, applyTunables } from './registry.js';
import type { TunableValues } from './values.js';

/**
 * Why a set of overrides would leave a starter that does not compile (a Frozen Orb pulsing faster
 * with more shards passes the live cap), or null when every starter compiles. Each number in range
 * can still combine into a broken starter, and a broken starter is a dud for every player who owns
 * it, so the API refuses such a set. This guards correctness, not balance: how strong a starter is
 * stays the admin's call. The overrides in force are put back before it returns.
 */
export function starterTuningProblem(values: Readonly<TunableValues>): string | null {
  const before = activeTunables();
  try {
    applyTunables(values);
    for (const def of STARTER_SIGILS) {
      let uid = 1;
      const c = compileSigilItem(createStarterSigil(() => uid++, def, { bound: false }), def.classId);
      if (!c.ok) {
        const e = c.errors[0];
        return `${def.name} would not compile: ${e ? `${e.rule}: ${e.message}` : 'it breaks a rule'}`;
      }
    }
    return null;
  } finally {
    applyTunables(before);
  }
}
