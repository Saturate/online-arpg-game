import { compileSigilItem, createStarterSigil, SIM, STARTER_SIGILS, starterSigilById, tokenizeSpell } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { formatSkill, skillIdFromName } from '../src/dev/studio/exportSkill.js';
import { StudioMetrics } from '../src/dev/studio/metrics.js';
import { compileSkill, StudioSim, studioSkillOf, type StudioSetup, type StudioSkill } from '../src/dev/studio/studioSim.js';

const SETUP: StudioSetup = { seed: 42, classId: 'mage', dummies: 6, dummyType: 'chaser', layout: 'pack', distance: 320 };

function fireball(): StudioSkill {
  const def = starterSigilById('fireball');
  if (!def) throw new Error('fireball missing');
  return studioSkillOf(def);
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
  it('matches the starterSigils.ts shape, with runes the tokenizer reads back', () => {
    const out = formatSkill({ ...fireball(), name: "Ro'ka" });
    expect(out).toContain("name: 'Ro\\'ka',");
    const text = /spell\('(.*)'\)/.exec(out)?.[1];
    expect(text).toBe(fireball().text);
    expect(tokenizeSpell(text ?? '').runes).toEqual(starterSigilById('fireball')?.runes);
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

describe('studio pricing', () => {
  it('prices every starter exactly as the game prices the equipped sigil', () => {
    for (const def of STARTER_SIGILS) {
      let uid = 1;
      const game = compileSigilItem(createStarterSigil(() => uid++, def, { bound: true }), def.classId);
      const studio = compileSkill(studioSkillOf(def));
      expect(studio.force, def.id).toBe(game.force);
      expect(studio.ok && studio.spirit, def.id).toBe(game.ok && game.spirit);
    }
  });
});

describe('studio duds', () => {
  it('hold mode keeps fizzling a dud instead of casting it once', () => {
    const s = new StudioSim(SETUP, { ...fireball(), text: 'fire bolt' });
    for (let i = 0; i < 200; i++) s.step();
    expect(s.metrics.summary().fizzles).toBeGreaterThan(1);
  });
});
