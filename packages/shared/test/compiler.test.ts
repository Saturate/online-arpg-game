import { describe, expect, it } from 'vitest';
import { compile, computeHeat, NEUTRAL_MODS, SPELL, type CompileResult, type RuneId } from '../src/index.js';

function c(seq: string, classId: 'mage' | 'warrior' | 'ranger' | 'priest' | 'binder' = 'mage'): CompileResult {
  const runes = seq.toLowerCase().replace(/on(hit|land|expire)/g, 'on$1').split(/\s+/);
  return compile(runes, { classId, capacity: 7, mods: NEUTRAL_MODS });
}

function ok(seq: string) {
  const r = c(seq);
  if (!r.ok) throw new Error(`${seq} was a dud: ${r.dud}`);
  return r;
}

describe('rune compiler fixtures', () => {
  it('Bolt Fire: fireball', () => {
    const r = ok('Bolt Fire');
    expect(r.program.form).toBe('bolt');
    expect(r.program.elements).toEqual(['fire']);
    expect(r.program.branch).toBeNull();
    expect(r.worstCaseEntities).toBe(1);
  });

  it('Bolt Fire Timer Split: travels, then splits into 3 fire bolts', () => {
    const r = ok('Bolt Fire Timer Split');
    const b = r.program.branch;
    expect(b?.trigger).toBe('timer');
    expect(b?.action).toBe('split');
    if (b?.action !== 'split') return;
    expect(b.count).toBe(3);
    expect(b.node.form).toBe('bolt');
    expect(b.node.elements).toEqual(['fire']);
    expect(b.node.damageScale).toBeCloseTo(SPELL.splitEfficiency / 3);
    expect(r.worstCaseEntities).toBe(4);
  });

  it('Bolt Fire Split: 3-way spread from the cast point', () => {
    const r = ok('Bolt Fire Split');
    expect(r.program.castSplit).toBe(3);
    expect(r.program.branch).toBeNull();
    expect(r.program.damageScale).toBeCloseTo(SPELL.splitEfficiency / 3);
    expect(r.worstCaseEntities).toBe(3);
  });

  it('Bolt Fire Split Timer: dud, trailing trigger', () => {
    expect(c('Bolt Fire Split Timer')).toMatchObject({ ok: false, dud: 'trailing_trigger' });
  });

  it('Dash Impact OnLand Nova: dash, knockback shockwave on landing', () => {
    const r = ok('Dash Impact OnLand Nova');
    expect(r.program.form).toBe('dash');
    expect(r.program.effects).toEqual(['impact']);
    const b = r.program.branch;
    expect(b).toMatchObject({ trigger: 'onland', action: 'form' });
    expect(b?.node.form).toBe('nova');
    expect(b?.node.depth).toBe(1);
  });

  it('Bolt Pierce Swift: fast piercing bolt', () => {
    const r = ok('Bolt Pierce Swift');
    expect(r.program.modifiers).toMatchObject({ pierce: 1, swift: 1 });
  });

  it('Zone Restore Linger: longer heal field', () => {
    const r = ok('Zone Restore Linger');
    expect(r.program.effects).toEqual(['restore']);
    expect(r.program.modifiers.linger).toBe(1);
  });

  it('Nova Restore: burst heal', () => {
    const r = ok('Nova Restore');
    expect(r.program.form).toBe('nova');
    expect(r.program.effects).toEqual(['restore']);
  });

  it('Aura Restore: persistent, reserves spirit and costs no heat', () => {
    const r = ok('Aura Restore');
    expect(r.persistent).toBe(true);
    expect(r.heat).toBe(0);
    expect(r.spirit).toBeGreaterThan(0);
  });

  it('Link Ward: persistent', () => {
    const r = ok('Link Ward');
    expect(r.persistent).toBe(true);
    expect(r.program.form).toBe('link');
  });

  it('Aura Fire OnHit Nova: dud, trigger in a persistent skill', () => {
    expect(c('Aura Fire OnHit Nova')).toMatchObject({ ok: false, dud: 'persistent_trigger' });
  });

  it('Split Bolt: dud, does not start with a Form', () => {
    expect(c('Split Bolt')).toMatchObject({ ok: false, dud: 'no_form_first' });
  });

  it('Bolt Timer Split x3: dud from the entity cap (1+3+9+27 = 40 > 24)', () => {
    expect(c('Bolt Timer Split Timer Split Timer Split')).toMatchObject({ ok: false, dud: 'entity_cap' });
  });
});

describe('rune compiler rules', () => {
  it('rejects triggers that do not suit the form', () => {
    expect(c('Nova OnHit Split')).toMatchObject({ ok: false, dud: 'trigger_form_mismatch' });
    expect(c('Bolt OnLand Nova')).toMatchObject({ ok: false, dud: 'trigger_form_mismatch' });
    expect(c('Zone OnHit Nova')).toMatchObject({ ok: false, dud: 'trigger_form_mismatch' });
    expect(c('Zone OnExpire Nova').ok).toBe(true);
    expect(c('Nova Timer Nova').ok).toBe(true);
  });

  it('requires an action or form after a trigger', () => {
    expect(c('Bolt Timer Fire')).toMatchObject({ ok: false, dud: 'trigger_needs_action' });
  });

  it('rejects a second form without a trigger', () => {
    expect(c('Bolt Nova')).toMatchObject({ ok: false, dud: 'orphan_form' });
    expect(c('Aura Restore Link')).toMatchObject({ ok: false, dud: 'orphan_form' });
  });

  it('rejects split in persistent skills and persistent sub-spells', () => {
    expect(c('Aura Split')).toMatchObject({ ok: false, dud: 'persistent_split' });
    expect(c('Bolt Timer Aura')).toMatchObject({ ok: false, dud: 'persistent_subspell' });
  });

  it('enforces max depth 3 before the entity cap', () => {
    expect(c('Bolt Timer Nova Timer Nova Timer Nova').ok).toBe(true);
    const deeper = compile(['bolt', 'timer', 'nova', 'timer', 'nova', 'timer', 'nova', 'timer', 'nova'], {
      classId: 'mage',
      capacity: 9,
      mods: NEUTRAL_MODS,
    });
    expect(deeper).toMatchObject({ ok: false, dud: 'too_deep' });
  });

  it('+1 max depth affix allows one level deeper', () => {
    const r = compile(['bolt', 'timer', 'nova', 'timer', 'nova', 'timer', 'nova', 'timer', 'nova'], {
      classId: 'mage',
      capacity: 9,
      mods: { ...NEUTRAL_MODS, maxDepthBonus: 1 },
    });
    expect(r.ok).toBe(true);
  });

  it('sub-spells inherit the parent element unless they have their own', () => {
    const inherit = ok('Bolt Fire OnHit Nova');
    expect(inherit.program.branch?.node.elements).toEqual(['fire']);
    const own = ok('Bolt Fire OnHit Nova Cold');
    expect(own.program.branch?.node.elements).toEqual(['cold']);
  });

  it('counts pierce hits for OnHit sub-spells in the entity budget', () => {
    expect(ok('Bolt Pierce OnHit Nova').worstCaseEntities).toBe(1 + (1 + SPELL.modifiers.pierceHits));
  });

  it('respects sigil capacity', () => {
    const r = compile(['bolt', 'fire', 'swift', 'large'], { classId: 'mage', capacity: 3, mods: NEUTRAL_MODS });
    expect(r).toMatchObject({ ok: false, dud: 'over_capacity' });
  });

  it('detects hidden combos on the same node only', () => {
    expect(ok('Nova Ward Fire').combos).toEqual(['burning_ward']);
    expect(ok('Bolt Fire Cold').combos).toEqual(['frostfire']);
    expect(ok('Bolt Fire OnHit Nova Cold').combos).toEqual([]);
  });

  it('charges deeper runes more heat and applies class affinity', () => {
    const ids: RuneId[] = ['bolt', 'fire'];
    // Mage has Fire affinity (x0.8), Bolt is off-affinity (x1.2).
    expect(computeHeat(ids, 'mage', 1)).toBeCloseTo(8 * 1.2 + 4 * 0.8);
    expect(computeHeat(ids, 'warrior', 1)).toBeCloseTo((8 + 4) * 1.2);
    // The Nova after Timer sits at depth 1: 14 * 1.5 * 1.2.
    expect(computeHeat(['bolt', 'timer', 'nova'], 'warrior', 1)).toBeCloseTo((8 + 4) * 1.2 + 14 * 1.5 * 1.2);
  });

  it('duds still report heat so the fizzle can cost half of it', () => {
    const r = c('Bolt Fire Split Timer');
    expect(r.ok).toBe(false);
    expect(r.heat).toBeGreaterThan(0);
  });
});
