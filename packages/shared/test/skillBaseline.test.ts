import { describe, expect, it } from 'vitest';
import { measureStarter, STARTER_SIGILS, type SkillDpsResult } from '../src/index.js';

/**
 * Measures every starter sigil with the harness that recorded the v1 baseline
 * (fixtures/skill-baseline-v1.json, kept as the record of v1; nothing writes it any more). The
 * balance against it is held by skillParity.test.ts; this test only checks that the numbers are sane.
 */

describe('starter sigil strength', () => {
  const results: Record<string, { class: string } & SkillDpsResult> = {};
  for (const def of STARTER_SIGILS) results[def.id] = { class: def.classId, ...measureStarter(def) };

  it('measures every damage skill with finite, positive numbers', () => {
    for (const [id, r] of Object.entries(results)) {
      if (r.kind !== 'damage') continue;
      for (const n of [r.forcePerCast, r.single, r.pack, r.perCast, r.peakEntities, r.casts]) {
        expect(n, id).not.toBeNull();
        expect(Number.isFinite(n), id).toBe(true);
        expect(n, id).toBeGreaterThan(0);
      }
    }
  });
});
