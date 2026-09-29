import { describe, expect, it } from 'vitest';
import { compileSigilItem, createStarterSigil, sigilCastDelay, sigilMisfireMultiplier, STARTER_SIGILS, type StarterSigilDef } from '../src/index.js';
import { measureSkill, type EquipSkill, type SkillDpsResult } from './harness/skillDps.js';

/**
 * Measures every starter sigil with the harness that recorded the v1 baseline
 * (fixtures/skill-baseline-v1.json, kept as the record of v1; nothing writes it any more). The
 * balance pass compares these numbers against it; this test only checks that they are sane.
 */

/** The same path the game takes for a starter kit sigil. */
function equipStarter(def: StarterSigilDef): EquipSkill {
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const item = createStarterSigil(() => sim.newItemUid(), def, { bound: true });
    p.items.set(item.uid, item);
    return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMisfireMultiplier(item), castDelay: sigilCastDelay(item) };
  };
}

/** Novas and zones go off on the caster, so they are measured with the target just outside the player's body. */
const SELF_CENTRED_DISTANCE = 40;

function distanceFor(def: StarterSigilDef): number | undefined {
  const shape = def.runes[0]?.id;
  return shape === 'nova' || shape === 'zone' ? SELF_CENTRED_DISTANCE : undefined;
}

describe('starter sigil strength', () => {
  const results: Record<string, { class: string } & SkillDpsResult> = {};
  for (const def of STARTER_SIGILS) {
    const distance = distanceFor(def);
    const r = measureSkill({ classId: def.classId, equip: equipStarter(def), ...(distance !== undefined ? { distance } : {}) });
    results[def.id] = { class: def.classId, ...r };
  }

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

  it('measures the same kind of skill as v1 for every starter', async () => {
    const { default: v1 } = await import('./fixtures/skill-baseline-v1.json');
    for (const [id, r] of Object.entries(results)) {
      const old: unknown = Reflect.get(v1, id);
      expect(old, id).toBeDefined();
      expect(r.kind, id).toBe(typeof old === 'object' && old !== null ? Reflect.get(old, 'kind') : undefined);
    }
  });
});
