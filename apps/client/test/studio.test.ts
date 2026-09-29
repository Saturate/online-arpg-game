import { skillById, SIM, type SkillDef } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { formatSkill, skillIdFromName, tuningDelta } from '../src/dev/studio/exportSkill.js';
import { StudioMetrics } from '../src/dev/studio/metrics.js';
import { StudioSim, type StudioSetup } from '../src/dev/studio/studioSim.js';

const SETUP: StudioSetup = { seed: 42, classId: 'mage', dummies: 6, dummyType: 'chaser', layout: 'pack', distance: 320 };

function fireball(): SkillDef {
  const def = skillById('fireball');
  if (!def) throw new Error('fireball missing');
  return def;
}

describe('studio metrics', () => {
  it('uses the filled part of the window early in a run', () => {
    const m = new StudioMetrics(5);
    for (let i = 0; i < 20; i++) m.push({ tick: i, casts: i === 0 ? 1 : 0, hits: 1, damage: 10, explodes: 0, fizzles: 0, heatSpent: i === 0 ? 20 : 0, live: 1 });
    const s = m.summary();
    expect(s.seconds).toBeCloseTo(20 * SIM.dt);
    expect(s.dpsWindow).toBeCloseTo(10 / SIM.dt);
    expect(s.dpsRun).toBeCloseTo(10 / SIM.dt);
    expect(s.hitsPerCast).toBe(20);
    expect(s.heatPerSecond).toBeCloseTo(20 / (20 * SIM.dt));
  });
});

describe('skill export', () => {
  it('keeps only non-neutral tuning and matches the skills.ts shape', () => {
    expect(tuningDelta({ speed: 1, damage: 1.3, phase: 0 })).toEqual({ damage: 1.3 });
    const out = formatSkill({ ...fireball(), name: "Ro'ka" });
    expect(out).toContain("name: 'Ro\\'ka',");
    expect(out).toContain("runes: ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'],");
    // Read from the definition, so retuning Fireball does not break the format test.
    expect(out).toContain(`tuning: { speed: ${fireball().tuning?.speed}, damage: ${fireball().tuning?.damage} },`);
    // Read from the definition, so balance changes to the heat cost do not break the format test.
    expect(out).toContain(`heat: ${fireball().heat},`);
    expect(skillIdFromName('  Frost Wave 2! ')).toBe('frost_wave_2');
  });
});

describe('studio sim', () => {
  it('is deterministic for a seed and deals damage to pinned dummies', () => {
    const run = () => {
      const s = new StudioSim(SETUP, fireball());
      for (let i = 0; i < 200; i++) s.step();
      return { summary: s.metrics.summary(), dummies: s.dummies.map((d) => s.sim.world.position.get(d.id)) };
    };
    const a = run();
    const b = run();
    expect(a.summary.damage).toBeGreaterThan(0);
    expect(a.summary.casts).toBeGreaterThan(0);
    expect(a.summary).toEqual(b.summary);
    const first = a.dummies[0];
    expect(first).toBeDefined();
  });

  it('infinite force casts at least as often as the realistic budget', () => {
    const realistic = new StudioSim(SETUP, fireball());
    const unlimited = new StudioSim(SETUP, fireball());
    unlimited.cast = { ...unlimited.cast, infiniteForce: true };
    for (let i = 0; i < 600; i++) {
      realistic.step();
      unlimited.step();
    }
    expect(unlimited.metrics.summary().casts).toBeGreaterThanOrEqual(realistic.metrics.summary().casts);
  });
});

describe('studio duds', () => {
  it('hold mode keeps fizzling a dud instead of casting it once', () => {
    const s = new StudioSim(SETUP, { ...fireball(), runes: ['fire', 'bolt'] });
    for (let i = 0; i < 200; i++) s.step();
    expect(s.metrics.summary().fizzles).toBeGreaterThan(1);
  });
});
