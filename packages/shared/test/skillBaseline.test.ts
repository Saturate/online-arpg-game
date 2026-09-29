import { describe, expect, it } from 'vitest';
import { SKILLS, compileSigilItem, sigilMods, type SigilItem, type SkillDef } from '../src/index.js';
import { measureSkill, type EquipSkill, type SkillDpsResult } from './harness/skillDps.js';

/**
 * Records how strong each v1 built-in skill is, so the v2 rebuilds can be tuned to match. This
 * test never compares against the fixture: v1 goes away with the rework, and the file is the record.
 *
 * Regenerate the fixture with:
 *   WRITE_BASELINE=1 pnpm vitest run packages/shared/test/skillBaseline.test.ts -u
 * (`-u` lets vitest overwrite a fixture that already exists.)
 */

/** The same path the game takes for a plain, affix-free sigil of a prebaked skill. */
function equipV1(skill: SkillDef): EquipSkill {
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const item: SigilItem = {
      uid: sim.newItemUid(),
      kind: 'sigil',
      tier: 'common',
      name: skill.name,
      ilvl: 1,
      affixes: [],
      runes: [...skill.runes],
      corrupted: false,
      skill: skill.id,
    };
    p.items.set(item.uid, item);
    return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMods(item).misfireMultiplier };
  };
}

/** Vitest runs in Node, but this package is typed without Node, so `process` is narrowed from globalThis. */
function envFlag(name: string): boolean {
  const proc: unknown = Reflect.get(globalThis, 'process');
  if (typeof proc !== 'object' || proc === null || !('env' in proc)) return false;
  const env = proc.env;
  if (typeof env !== 'object' || env === null) return false;
  return Reflect.get(env, name) === '1';
}

/**
 * Novas and zones go off on the caster in v1, so at 250 units they miss the target. They are
 * measured with the target just outside the player's body, the way they are played.
 */
const SELF_CENTRED_DISTANCE = 40;

function distanceFor(skill: SkillDef): number | undefined {
  const form = skill.runes[0];
  return form === 'nova' || form === 'zone' ? SELF_CENTRED_DISTANCE : undefined;
}

describe('v1 skill baseline', () => {
  const results: Record<string, { class: string } & SkillDpsResult> = {};
  for (const skill of SKILLS) {
    const distance = distanceFor(skill);
    const r = measureSkill({ classId: skill.classId, equip: equipV1(skill), ...(distance !== undefined ? { distance } : {}) });
    results[skill.id] = { class: skill.classId, ...r };
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

  it.runIf(envFlag('WRITE_BASELINE'))('writes the fixture', async () => {
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot('./fixtures/skill-baseline-v1.json');
  });
});
