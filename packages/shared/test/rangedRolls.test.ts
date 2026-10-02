import { afterEach, describe, expect, it } from 'vitest';
import {
  AFFIX_IDS,
  AFFIXES,
  affixTierPath,
  applyTunables,
  checkBenchSpell,
  clampRoll,
  compileRunes,
  createRolledRune,
  createRune,
  DEFAULT_SIGIL_CONTEXT,
  describeTree,
  formatAffix,
  formatRunes,
  programDamage,
  resetTunables,
  Rng,
  rollAffixes,
  rollAverage,
  rollCast,
  runeItemFromInstance,
  Simulation,
  SKILL_BUTTONS,
  tokenizeSpell,
  toRuneInstance,
  type AffixRoll,
  type SigilCompile,
  type SpellProgram,
} from '../src/index.js';
import type { SpellNode } from '../src/sim/program.js';
import { compileText } from './helpers/spell.js';

afterEach(() => resetTunables());

function ok(c: SigilCompile): Extract<SigilCompile, { ok: true }> {
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('; '));
  return c;
}

const force = (text: string, classId: 'mage' | 'ranger' = 'ranger'): number => compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId }).force;

describe('ranged rolls at drop', () => {
  const rolls = (id: 'rune_damage' | 'rune_pierce' | 'split_count'): AffixRoll[] => {
    const rng = new Rng(7);
    const rune = id === 'split_count' ? 'split' : 'bolt';
    const out: AffixRoll[] = [];
    for (let i = 0; i < 4000; i++) out.push(...rollAffixes(rng, 'rune', 3, 5, { rune, allow: (a) => a === id, ilvl: 30 }));
    return out;
  };

  it('a quarter of damage, pierce and split rolls come ranged, centred on a roll of their tier', () => {
    for (const id of ['rune_damage', 'rune_pierce', 'split_count'] as const) {
      const all = rolls(id);
      const ranged = all.filter((a) => a.max !== undefined);
      // Split counts of 2 or 6 have no room for a range inside 2 to 6, so fewer of them come ranged.
      expect(ranged.length / all.length, id).toBeGreaterThan(id === 'split_count' ? 0.05 : 0.12);
      expect(ranged.length / all.length, id).toBeLessThan(0.3);
      for (const a of ranged) {
        const t = AFFIXES[id].tiers[a.tier];
        const avg = rollAverage(a);
        expect(t && avg >= t.min && avg <= t.max, `${id} ${a.value} to ${a.max}`).toBe(true);
        expect(a.max ?? 0).toBeGreaterThan(a.value);
      }
    }
    // Splits stay inside the grammar's 2 to 6, pierce never below 0.
    expect(rolls('split_count').every((a) => a.value >= 2 && (a.max ?? a.value) <= 6)).toBe(true);
    expect(rolls('rune_pierce').every((a) => a.value >= 0)).toBe(true);
  });

  it('no other affix rolls a range', () => {
    const ranged = AFFIX_IDS.filter((id) => AFFIXES[id].ranged !== undefined);
    expect(ranged.sort()).toEqual(['rune_damage', 'rune_pierce', 'split_count']);
    const rng = new Rng(3);
    for (let i = 0; i < 500; i++) {
      for (const a of createRolledRune(i, rng, 'relic', 30).affixes) if (!AFFIXES[a.id].ranged) expect(a.max, a.id).toBeUndefined();
    }
  });

  it('read as "1 to 4" on the item and in the text form, and round trip', () => {
    expect(formatAffix({ id: 'rune_damage', tier: 3, value: 20, max: 60 })).toBe('+20 to 60% damage');
    expect(formatAffix({ id: 'rune_pierce', tier: 3, value: 0, max: 2 })).toBe('Pierces 0 to 2 enemies');
    expect(formatAffix({ id: 'split_count', tier: 3, value: 3, max: 5 })).toBe('Makes 3 to 5 copies');
    const t = tokenizeSpell('bolt[+20 to 60% damage, pierce 0 to 2] split(3 to 5)');
    expect(t.errors).toEqual([]);
    expect(t.runes[0]?.affixes).toMatchObject({ damage: 20, damageMax: 60, pierce: 0, pierceMax: 2 });
    expect(t.runes[1]?.affixes).toMatchObject({ count: 3, countMax: 5 });
    expect(formatRunes(t.runes)).toBe('bolt[+20 to 60% damage, pierce 0 to 2] split(3 to 5)');
    const items = t.runes.map((r, i) => runeItemFromInstance(i, r, false));
    expect(items[0]?.affixes).toContainEqual({ id: 'rune_damage', tier: 3, value: 20, max: 60 });
    expect(items.map(toRuneInstance)).toEqual(t.runes);
    // A range has to go up.
    expect(tokenizeSpell('bolt[+60 to 20% damage]').errors[0]?.rule).toBe('unknown-affix');
  });
});

describe('per-cast rolls', () => {
  /** Every node of a program, payloads included. */
  const nodes = (p: SpellProgram): SpellNode[] => {
    const out: SpellNode[] = [];
    const visit = (n: SpellNode): void => {
      out.push(n);
      n.payload.forEach(visit);
    };
    p.roots.forEach(visit);
    return out;
  };

  it('roll inside each range, deterministically from the stream, payloads included', () => {
    const program = ok(compileText('bolt[pierce 1 to 3, +20 to 60% damage] split(2 to 4) onhit nova[+20 to 60% damage]')).program;
    const a = Rng.stream(5, 'cast');
    const b = Rng.stream(5, 'cast');
    const seen = { pierce: new Set<number>(), copies: new Set<number>() };
    for (let i = 0; i < 300; i++) {
      const x = rollCast(program, a);
      expect(x).toEqual(rollCast(program, b));
      const [bolt, nova] = nodes(x);
      if (!bolt || !nova) throw new Error('nodes');
      expect(bolt.perCast).toBeUndefined();
      expect(bolt.pierce).toBeGreaterThanOrEqual(1);
      expect(bolt.pierce).toBeLessThanOrEqual(3);
      expect(bolt.copies).toBeGreaterThanOrEqual(2);
      expect(bolt.copies).toBeLessThanOrEqual(4);
      seen.pierce.add(bolt.pierce);
      seen.copies.add(bolt.copies);
      // Each copy keeps 1.2 / n of the damage, for the n this cast rolled.
      const base = program.roots[0];
      if (!base) throw new Error('root');
      expect(bolt.damageScale * bolt.copies).toBeCloseTo(base.damageScale * base.copies, 9);
      const lo = (base.tuning.damage * 1) / 1;
      expect(bolt.tuning.damage).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(bolt.tuning.damage).toBeLessThanOrEqual((lo * 1.6) / 1.2 + 1e-9);
      expect(nova.perCast).toBeUndefined();
    }
    expect([...seen.pierce].sort()).toEqual([1, 2, 3]);
    expect([...seen.copies].sort()).toEqual([2, 3, 4]);
  });

  it('a spell with no range draws nothing and casts its program as it is', () => {
    const program = ok(compileText('bolt[pierce 2, +30% damage] split(3)')).program;
    const rng = Rng.stream(1, 'cast');
    const before = rng.next();
    const again = Rng.stream(1, 'cast');
    expect(rollCast(program, again)).toBe(program);
    expect(again.next()).toBe(before);
  });

  it('the server casts a different number of copies on different casts, the same for the same seed', () => {
    const counts = (seed: number): number[] => {
      const sim = new Simulation(seed, { kind: 'flat' });
      sim.waveTimer = Infinity;
      const pid = sim.addPlayer('p', 'ranger');
      const p = sim.world.player.get(pid);
      if (!p) throw new Error('setup');
      p.god = true;
      p.sigils = [{ uid: -1, compiled: compileText('bolt split(2 to 5)', 'ranger'), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
      const out: number[] = [];
      let seq = 0;
      for (let cast = 0; cast < 12; cast++) {
        p.heat = 0;
        p.castCooldown = 0;
        const before = new Set(sim.world.projectile.keys());
        sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] ?? 0 });
        sim.step();
        out.push([...sim.world.projectile.keys()].filter((id) => !before.has(id)).length);
        sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
        for (let i = 0; i < 30; i++) sim.step();
      }
      return out;
    };
    const a = counts(3);
    expect(a.every((n) => n >= 2 && n <= 5)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(counts(3)).toEqual(a);
  });
});

describe('ranged rolls, Force and the caps', () => {
  it('Force prices the average', () => {
    expect(force('bolt[+50 to 150% damage]')).toBe(force('bolt[+100% damage]'));
    expect(force('bolt[pierce 1 to 3]')).toBe(force('bolt[pierce 2]'));
    expect(force('bolt split(2 to 4)')).toBe(force('bolt split(3)'));
  });

  it('the entity budget and the live cap count the most a cast can roll', () => {
    const peak = (text: string): number => ok(compileText(text)).peakEntities;
    expect(peak('bolt split(2 to 4)')).toBe(peak('bolt split(4)'));
    expect(peak('bolt[onhit, pierce 1 to 3] nova')).toBe(peak('bolt[onhit, pierce 3] nova'));
    // Five copies fit, six do not; a range up to six is refused like six.
    expect(compileText('orb[every 0.15s] cold split(5) bolt').ok).toBe(true);
    const six = compileText('orb[every 0.15s] cold split(4 to 6) bolt');
    expect(six.ok).toBe(false);
    if (!six.ok) expect(six.errors.map((e) => e.rule)).toContain('entity-cap');
    // A Split's implicit extra copies count too.
    expect(compileText('orb[every 0.15s] cold split(5){1} bolt').ok).toBe(false);
  });

  it('a ranged Split count past six is refused like a count of seven', () => {
    const c = compileText('bolt split(4 to 7)');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.errors.map((e) => e.rule)).toContain('split-count');
  });

  it('a Split implicit makes a copy range, priced at its average and never past six', () => {
    const tree = ok(compileText('bolt split(3){2}')).tree;
    expect(tree.roots[0]?.copies).toBe(3);
    expect(tree.roots[0]?.copiesMax).toBe(5);
    expect(ok(compileText('bolt split(6){2}')).tree.roots[0]?.copiesMax).toBe(6);
    expect(force('bolt split(3){2}')).toBe(force('bolt split(4)'));
  });

  it('the sentence and the damage lines read the range', () => {
    const c = ok(compileText('bolt[+20 to 60% damage, pierce 0 to 2] split(2 to 4)'));
    const text = describeTree(c.tree);
    expect(text).toContain('Fires 2 to 4 bolts');
    expect(text).toContain('piercing 0 to 2 enemies');
    expect(text).toContain('with +20 to 60% damage');
    const d = programDamage(c.program)[0];
    expect(d?.copies).toBe(2);
    expect(d?.copiesMax).toBe(4);
    // Lowest: four copies and +20%; highest: two copies and +60%.
    const each = (n: number, pct: number, base: number): number => ((base * 1.2) / n) * (1 + pct / 100);
    expect(d?.parts[0]?.min).toBeCloseTo(each(4, 20, 12), 9);
    expect(d?.parts[0]?.max).toBeCloseTo(each(2, 60, 20), 9);
  });
});

describe('ranged rolls on the way out and on the bench', () => {
  it('clamp by their average, keeping their spread, and never rise', () => {
    const r: AffixRoll = { id: 'rune_damage', tier: 5, value: 50, max: 150 };
    expect(clampRoll(r)).toBe(r);
    applyTunables({ [affixTierPath('rune_damage', 5, 'max')]: 80 });
    expect(clampRoll(r)).toEqual({ id: 'rune_damage', tier: 5, value: 30, max: 130 });
  });

  it('the balance bench takes ranges a drop can have and refuses wider ones', () => {
    expect(checkBenchSpell({ text: 'bolt[+50 to 150% damage]', classId: 'ranger' })).toMatchObject({ text: 'bolt[+50 to 150% damage]' });
    expect(checkBenchSpell({ text: 'bolt[pierce 2 to 4] split(3 to 5){2}', classId: 'ranger' })).toMatchObject({ text: 'bolt[pierce 2 to 4] split(3 to 5){2}' });
    expect(checkBenchSpell({ text: 'bolt{125}', classId: 'ranger' })).toMatchObject({ text: 'bolt{125}' });
    expect(checkBenchSpell({ text: 'bolt[+10 to 190% damage]', classId: 'ranger' })).toMatch(/wider than a ranged roll/);
    expect(checkBenchSpell({ text: 'bolt[+20 to 60% speed]', classId: 'ranger' })).toMatch(/not an affix/);
    expect(checkBenchSpell({ text: 'bolt{140}', classId: 'ranger' })).toMatch(/implicit 140 is outside/);
    expect(checkBenchSpell({ text: 'bolt split{2}', classId: 'ranger' })).toMatchObject({ text: 'bolt split{2}' });
    expect(createRune(1, 'bolt').affixes).toEqual([]);
  });
});
