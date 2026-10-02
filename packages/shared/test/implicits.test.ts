import { afterEach, describe, expect, it } from 'vitest';
import {
  AFFIXES,
  affixTierPath,
  applyTunables,
  buyPrice,
  CASTABLE_RUNES,
  clampRuneRolls,
  compileRunes,
  createPlainDrop,
  createRolledRune,
  createRune,
  createSigil,
  createStarterSigil,
  DEFAULT_DROP_TUNING,
  DEFAULT_SIGIL_CONTEXT,
  describeTree,
  FORGE,
  forgeInsertPrice,
  formatImplicit,
  formatRunes,
  IMPLICIT_NEUTRAL_TIER,
  implicitIdFor,
  implicitKey,
  neutralImplicit,
  programDamage,
  resetTunables,
  Rng,
  rollDrops,
  runeImplicit,
  runeItemFromInstance,
  runeRecipeKey,
  RUNE_AFFIX_TIERS,
  sellPrice,
  Simulation,
  SKILL_BUTTONS,
  SPELL,
  STARTER_SIGILS,
  stacksWith,
  tokenizeSpell,
  toRuneInstance,
  tunableSetProblem,
  TUNABLES,
  type AffixRoll,
  type Item,
  type RuneItem,
  type SigilCompile,
} from '../src/index.js';
import { addItem } from '../src/sim/inventory.js';
import { compileText } from './helpers/spell.js';

afterEach(() => resetTunables());

function ok(c: SigilCompile): Extract<SigilCompile, { ok: true }> {
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('; '));
  return c;
}

/** A rune as saves from before implicits hold it. */
function preImplicit(r: RuneItem): RuneItem {
  const { implicit: _gone, ...old } = r;
  return old;
}

describe('implicit tables', () => {
  it('every castable rune has one implicit, six tiers, and the neutral roll in the middle of T4', () => {
    for (const rune of CASTABLE_RUNES) {
      const id = implicitIdFor(rune);
      expect(id, rune).not.toBeNull();
      if (!id) continue;
      const def = AFFIXES[id];
      expect(def.targets).toEqual(['implicit']);
      expect(def.runes).toContain(rune);
      expect(def.tiers).toHaveLength(RUNE_AFFIX_TIERS);
      const t4 = def.tiers[IMPLICIT_NEUTRAL_TIER];
      expect(t4 && def.neutral !== undefined && def.neutral >= t4.min && def.neutral <= t4.max, `${rune} neutral in T4`).toBe(true);
      // Better tiers sit higher and unlock later; T1 is the rarest.
      def.tiers.forEach((t, i) => {
        const prev = def.tiers[i - 1];
        if (!prev) return;
        expect(t.min, `${id} T${6 - i} above T${7 - i}`).toBeGreaterThanOrEqual(prev.max);
        expect(t.ilvl ?? 1).toBeGreaterThanOrEqual(prev.ilvl ?? 1);
      });
      expect(def.tiers[5]?.weight).toBeLessThan(def.tiers[0]?.weight ?? 0);
    }
    expect(implicitIdFor('beam')).toBeNull();
  });

  it('are tunable in Rune balance and checked as a set like affix tables', () => {
    const paths = TUNABLES.filter((t) => t.path.startsWith('affix.implicit_'));
    expect(paths.length).toBe(11 * 6 * 4);
    expect(paths.every((t) => t.category === 'runes')).toBe(true);
    expect(tunableSetProblem({ [affixTierPath('implicit_base', 5, 'min')]: 90 })).toMatch(/implicit_base T1/);
    expect(tunableSetProblem({ [affixTierPath('implicit_base', 5, 'max')]: 150 })).toBeNull();
  });
});

describe('implicits on drops', () => {
  it('every rune a monster drops carries one, plain or rolled, its tier gated by the monster level', () => {
    let uid = 1;
    const rng = new Rng(9);
    const low: RuneItem[] = [];
    const high: RuneItem[] = [];
    for (let i = 0; i < 1500; i++) {
      // Loose runes only: a sigil dropping with a kit's runes carries the kit's neutral rolls.
      low.push(...rollDrops(rng, () => uid++, { level: 1, rare: true, boss: false }, DEFAULT_DROP_TUNING).filter((i): i is RuneItem => i.kind === 'rune'));
      high.push(...rollDrops(rng, () => uid++, { level: 30, rare: true, boss: false }, DEFAULT_DROP_TUNING).filter((i): i is RuneItem => i.kind === 'rune'));
    }
    expect(low.length).toBeGreaterThan(200);
    for (const r of [...low, ...high]) {
      const i = r.implicit;
      expect(i, `${r.rune} ${r.uid}`).toBeDefined();
      if (!i) continue;
      expect(i.id).toBe(implicitIdFor(r.rune));
      const t = AFFIXES[i.id].tiers[i.tier];
      expect(t && i.value >= t.min && i.value <= t.max, `${i.id} T${6 - i.tier} ${i.value}`).toBe(true);
      // Plain runes take their tier's middle, so plain runes of one tier still stack.
      if (r.affixes.length === 0 && t) expect(i.value).toBe(Math.round((t.min + t.max) / 2));
    }
    // Level 1 unlocks T6 and T5 only; deep levels reach T1.
    expect(Math.max(...low.map((r) => r.implicit?.tier ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.max(...high.map((r) => r.implicit?.tier ?? 0))).toBe(5);
    // No two rolled runes alike: rolled implicits spread over their tier.
    const rolledBolts = new Set(high.filter((r) => r.rune === 'bolt' && r.affixes.length > 0).map((r) => r.implicit?.value));
    expect(rolledBolts.size).toBeGreaterThan(5);
  });

  it('a rolled rune rolls its implicit after its affixes, so the affixes a seed gives did not move', () => {
    const a = createRolledRune(1, new Rng(4), 'rare', 20, 'orb');
    const b = createRolledRune(1, new Rng(4), 'rare', 20, 'orb');
    expect(a).toEqual(b);
    expect(a.implicit).toBeDefined();
    expect(createPlainDrop(2, new Rng(5), 'fire', 1).implicit?.tier).toBeLessThanOrEqual(1);
  });

  it('kit runes, bench runes and runes made from text carry the neutral roll', () => {
    let uid = 1;
    for (const def of STARTER_SIGILS) {
      const kit = createStarterSigil(() => uid++, def, { bound: true });
      for (const r of kit.slots) expect(r.implicit, `${def.id} ${r.rune}`).toEqual(neutralImplicit(r.rune));
      // The text form leaves the neutral roll out, so every kit reads as it did.
      expect(formatRunes(kit.slots.map(toRuneInstance))).toBe(formatRunes(def.runes));
    }
    expect(createRune(1, 'split').implicit).toEqual({ id: 'implicit_split', tier: IMPLICIT_NEUTRAL_TIER, value: 0 });
  });
});

describe('implicits in the text form', () => {
  it('read as {n} after the rune and write back the same, leaving the neutral roll out', () => {
    const t = tokenizeSpell('bolt{120}[+30% damage] fire{90} split(3){1} timer{110} nova');
    expect(t.errors).toEqual([]);
    expect(t.runes.map((r) => r.implicit)).toEqual([120, 90, 1, 110, undefined]);
    expect(formatRunes(t.runes)).toBe('bolt{120}[+30% damage] fire{90} split(3){1} timer{110} nova');
    expect(formatRunes(tokenizeSpell('bolt{100} split{0}').runes)).toBe('bolt split');
  });

  it('refuse what no rune could hold', () => {
    const errors = (text: string): string[] => compileText(text).ok ? [] : (compileText(text) as Extract<SigilCompile, { ok: false }>).errors.map((e) => e.rule);
    expect(errors('bolt{5}')).toContain('implicit-range');
    expect(errors('bolt{900}')).toContain('implicit-range');
    expect(errors('bolt split{5}')).toContain('implicit-range');
    expect(errors('bolt split{1.5}')).toContain('implicit-range');
  });

  it('round trip through rune items, at the tier their value falls in', () => {
    const item = runeItemFromInstance(1, { id: 'bolt', affixes: {}, implicit: 112 }, false);
    expect(item.implicit).toEqual({ id: 'implicit_base', tier: 4, value: 112 });
    expect(toRuneInstance(item).implicit).toBe(112);
    expect(runeItemFromInstance(2, { id: 'split', affixes: {}, implicit: 0 }, false).implicit?.tier).toBe(IMPLICIT_NEUTRAL_TIER);
    // A rune stored before implicits reads as the neutral roll everywhere.
    const { implicit: _gone, ...old } = createRune(3, 'bolt');
    expect(runeImplicit(old)).toEqual(neutralImplicit('bolt'));
    expect(runeRecipeKey(old)).toBe(runeRecipeKey(createRune(4, 'bolt')));
  });
});

describe('what each implicit does', () => {
  it('a shape scales its live base range; Base shapes tuning still reaches it', () => {
    const plain = programDamage(ok(compileText('bolt')).program)[0];
    const strong = programDamage(ok(compileText('bolt{120}')).program)[0];
    expect(strong?.parts[0]?.min).toBeCloseTo((plain?.parts[0]?.min ?? 0) * 1.2, 9);
    expect(strong?.parts[0]?.max).toBeCloseTo((plain?.parts[0]?.max ?? 0) * 1.2, 9);
    applyTunables({ 'spell.bolt.damageMin': 24, 'spell.bolt.damageMax': 40 });
    expect(programDamage(ok(compileText('bolt{120}')).program)[0]?.parts[0]).toMatchObject({ min: 24 * 1.2, max: 40 * 1.2 });
    expect(describeTree(ok(compileText('bolt{120}')).tree)).toContain('Deals 29 to 48 physical damage');
  });

  it('an infusion converts its share at its implicit, on cast shapes and auras', () => {
    const fire = programDamage(ok(compileText('bolt fire{120}')).program)[0];
    expect(fire?.parts).toEqual([{ type: 'fire', min: 12 * 1.2, max: 20 * 1.2 }]);
    const two = programDamage(ok(compileText('bolt fire{120} cold')).program)[0];
    const frost = 1 + SPELL.comboDamageBonus;
    expect(two?.parts.find((p) => p.type === 'fire')?.max).toBeCloseTo(10 * 1.2 * frost, 9);
    expect(two?.parts.find((p) => p.type === 'cold')?.max).toBeCloseTo(10 * frost, 9);
    const aura = programDamage(ok(compileText('aura fire{120}')).program)[0];
    const plainAura = programDamage(ok(compileText('aura fire')).program)[0];
    expect(aura?.parts[0]?.max).toBeCloseTo((plainAura?.parts[0]?.max ?? 0) * 1.2, 9);
  });

  it('timers, pulses, Swift, Large, Concentrated, triggers, effects, auras and bonds follow theirs', () => {
    const tree = (text: string) => ok(compileText(text)).tree;
    expect(tree('bolt timer{125} nova').roots[0]?.release?.seconds).toBeCloseTo(SPELL.timerSeconds / 1.25, 3);
    expect(tree('zone pulse{125} bolt').roots[0]?.release?.seconds).toBeCloseTo(SPELL.pulseSeconds / 1.25, 3);
    // A written number is used as written.
    expect(tree('bolt timer{125}(0.8) nova').roots[0]?.release?.seconds).toBe(0.8);
    expect(tree('bolt swift{120}').roots[0]?.stats.speed).toBeCloseTo(36, 9);
    expect(tree('bolt large{90}').roots[0]?.stats.size).toBeCloseTo(45, 9);
    expect(tree('nova concentrated{120}').roots[0]?.stats.size).toBeCloseTo(-25, 9);
    // On Hit's implicit is its payload's damage.
    const payload = ok(compileText('bolt onhit{120} nova')).program.roots[0]?.payload[0];
    const plainPayload = ok(compileText('bolt onhit nova')).program.roots[0]?.payload[0];
    expect(payload?.tuning.damage).toBeCloseTo((plainPayload?.tuning.damage ?? 0) * 1.2, 9);
    expect(ok(compileText('nova impact{120} ward{80}')).program.roots[0]?.effectPower).toEqual({ impact: 1.2, ward: 0.8 });
    expect(ok(compileText('aura{120} ward')).program.roots[0]?.tuning.radius).toBeCloseTo(1.2, 9);
    expect(ok(compileText('bond{120} ward')).program.roots[0]?.damageScale).toBeCloseTo(1.2, 9);
  });

  it('a better effect heals, shields and knocks back harder in play', () => {
    const shieldOf = (text: string): number => {
      const sim = new Simulation(3, { kind: 'flat' });
      sim.waveTimer = Infinity;
      const pid = sim.addPlayer('p', 'priest');
      const p = sim.world.player.get(pid);
      if (!p) throw new Error('setup');
      p.sigils = [{ uid: -1, compiled: compileText(text, 'priest'), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
      sim.applyInput(pid, { seq: 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] ?? 0 });
      for (let i = 0; i < 20; i++) sim.step();
      return sim.world.status.get(pid)?.shield?.amount ?? 0;
    };
    const plain = shieldOf('nova ward');
    expect(plain).toBeGreaterThan(0);
    expect(shieldOf('nova ward{120}')).toBeCloseTo(plain * 1.2, 6);
  });
});

describe('implicits and Force', () => {
  const force = (text: string, classId: 'mage' | 'ranger' | 'warrior' = 'mage'): number => compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId }).force;

  it('a better implicit costs more, a weaker one less, priced like a damage roll of its size', () => {
    expect(force('bolt{125}')).toBeGreaterThan(force('bolt'));
    expect(force('bolt{85}')).toBeLessThan(force('bolt'));
    // +25% base damage is priced like +25% damage.
    expect(force('bolt{125}')).toBeCloseTo(force('bolt[+25% damage]'), 1);
    expect(force('bolt fire{125}')).toBeGreaterThan(force('bolt fire'));
    expect(force('nova impact{125}')).toBeGreaterThan(force('nova impact'));
    expect(force('bolt onhit{125} nova')).toBeGreaterThan(force('bolt onhit nova'));
    expect(force('bolt swift{125}')).toBeGreaterThan(force('bolt swift'));
    // A faster pulse pays through the releases it adds.
    expect(force('zone pulse{125} bolt')).toBeGreaterThan(force('zone pulse bolt'));
  });

  it('every neutral rune costs exactly what it did, so every kit keeps its Force', () => {
    for (const def of STARTER_SIGILS) {
      const neutral = def.runes.map((r) => (implicitIdFor(r.id) ? { ...r, implicit: r.id === 'split' ? 0 : 100 } : r));
      const a = compileRunes(def.runes, { ...DEFAULT_SIGIL_CONTEXT, classId: def.classId });
      const b = compileRunes(neutral, { ...DEFAULT_SIGIL_CONTEXT, classId: def.classId });
      expect(b.force, def.id).toBe(a.force);
      if (a.ok && b.ok) expect(b.spirit, def.id).toBe(a.spirit);
    }
  });

  it('auras and bonds reserve spirit by the strength their runes give', () => {
    const spirit = (text: string): number => ok(compileText(text)).spirit;
    expect(spirit('aura{120} fire')).toBeGreaterThan(spirit('aura fire'));
    expect(spirit('aura fire{120}')).toBe(Math.round(30 + 12));
    expect(spirit('bond{80} ward')).toBeLessThan(spirit('bond ward'));
  });
});

describe('implicit prices', () => {
  const withImplicit = (tier: number): RuneItem => {
    const r = createRune(1, 'bolt');
    const t = AFFIXES.implicit_base.tiers[tier];
    return { ...r, implicit: { id: 'implicit_base', tier, value: t ? Math.round((t.min + t.max) / 2) : 100 } };
  };

  it('add their tier value: nothing up to the neutral T4, more from T3', () => {
    const base = sellPrice(preImplicit(createRune(1, 'bolt')));
    for (let tier = 0; tier < 6; tier++) expect(sellPrice(withImplicit(tier))).toBe(base + (FORGE.runeImplicitValue[tier] ?? 0));
    expect(FORGE.runeImplicitValue.slice(0, IMPLICIT_NEUTRAL_TIER + 1)).toEqual([0, 0, 0]);
    expect(forgeInsertPrice(withImplicit(5))).toBe(sellPrice(withImplicit(5)));
  });

  it('never sell for what they cost at the trader, whatever the tier', () => {
    for (let tier = 0; tier < 6; tier++) {
      const r = withImplicit(tier);
      expect(sellPrice(r)).toBeLessThan(buyPrice(r));
      // A rune bought before implicits (no implicit, priced then) never sells back above it once converted.
      const before = buyPrice(preImplicit(createRune(1, 'bolt')));
      expect(sellPrice(withImplicit(IMPLICIT_NEUTRAL_TIER))).toBeLessThan(before);
    }
  });
});

describe('implicits and stacks', () => {
  function atForge() {
    const sim = new Simulation(4, { kind: 'world', seed: 3 });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    const forge = sim.mapDef.forge;
    if (!p || !pos || !forge) throw new Error('setup');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    const blank = createSigil(sim.newItemUid(), sim.rand.loot, 'magic');
    addItem(p, blank);
    return { sim, pid, p, blank };
  }
  const tiered = (uid: number, tier: number, value: number, count = 1): RuneItem => ({ ...createRune(uid, 'fire', count), implicit: { id: 'implicit_conversion', tier, value } });

  it('plain runes stack only with the same implicit', () => {
    expect(stacksWith(tiered(1, 2, 100), tiered(2, 2, 100))).toBe(true);
    expect(stacksWith(tiered(1, 2, 100), tiered(2, 3, 106))).toBe(false);
    // A stack from before implicits is the neutral roll, so it takes new neutral runes.
    const { implicit: _gone, ...old } = createRune(3, 'fire', 5);
    expect(stacksWith(old, createRune(4, 'fire'))).toBe(true);
    expect(implicitKey(old)).toBe(implicitKey(createRune(4, 'fire')));
    const { sim, p } = atForge();
    addItem(p, tiered(sim.newItemUid(), 2, 100, 3));
    addItem(p, tiered(sim.newItemUid(), 3, 106, 2));
    addItem(p, tiered(sim.newItemUid(), 2, 100, 4));
    const stacks = [...p.items.values()].filter((i): i is RuneItem => i.kind === 'rune' && i.rune === 'fire').map((r) => `${r.implicit?.value}x${r.count}`).sort();
    expect(stacks).toEqual(['100x7', '106x2']);
  });

  it('the forge takes the stack a ref names by its implicit, at that implicit\'s price, and the rune keeps it', () => {
    const { sim, pid, p, blank } = atForge();
    p.gold = 1000;
    const strong = tiered(sim.newItemUid(), 5, 120, 2);
    const plain = tiered(sim.newItemUid(), 2, 100, 2);
    addItem(p, plain);
    addItem(p, strong);
    addItem(p, createRune(sim.newItemUid(), 'bolt', 1));
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'bolt' }, { from: 'plain', rune: 'fire', implicit: { tier: 5, value: 120 } }])).toBeNull();
    expect(blank.slots[1]?.implicit).toEqual({ id: 'implicit_conversion', tier: 5, value: 120 });
    expect(strong.count).toBe(1);
    expect(plain.count).toBe(2);
    expect(p.gold).toBe(1000 - forgeInsertPrice(createRune(0, 'bolt')) - forgeInsertPrice(tiered(0, 5, 120)));
    // A ref naming an implicit nobody holds is refused and nothing moves.
    expect(sim.inscribe(pid, blank.uid, [{ from: 'keep', index: 0 }, { from: 'plain', rune: 'fire', implicit: { tier: 4, value: 111 } }])).toBe('You need a Fire Rune');
    expect(blank.slots).toHaveLength(2);
    // Without one (an older client) it takes the first stack in source order.
    expect(sim.inscribe(pid, blank.uid, [{ from: 'keep', index: 0 }, { from: 'keep', index: 1 }, { from: 'plain', rune: 'fire' }])).toBeNull();
    expect(plain.count + strong.count).toBe(2);
    // The rune taken out comes back with its implicit and tops up its own stack.
    expect(sim.inscribe(pid, blank.uid, [{ from: 'keep', index: 0 }])).toBeNull();
    const fires = [...p.items.values()].filter((i): i is RuneItem => i.kind === 'rune' && i.rune === 'fire');
    expect(fires.reduce((n, r) => n + r.count, 0)).toBe(4);
    expect(fires.find((r) => r.implicit?.value === 120)?.count).toBe(2);
  });
});

describe('implicits on the way out', () => {
  it('clamp into a table tuned down, like any roll, and never rise', () => {
    const r: RuneItem = { ...createRune(1, 'bolt'), implicit: { id: 'implicit_base', tier: 5, value: 125 } };
    expect(clampRuneRolls(r)).toBe(r);
    applyTunables({ [affixTierPath('implicit_base', 5, 'max')]: 118 });
    const out = clampRuneRolls(r);
    expect(out.implicit).toEqual<AffixRoll>({ id: 'implicit_base', tier: 5, value: 118 });
    applyTunables({ [affixTierPath('implicit_base', 5, 'max')]: 140 });
    expect(clampRuneRolls(r)).toBe(r);
  });

  it('read as a line with its live number', () => {
    const line = (rune: RuneItem['rune'], value: number): string | null => formatImplicit({ ...createRune(1, rune), implicit: { id: implicitIdFor(rune) ?? 'implicit_base', tier: 3, value } });
    expect(line('bolt', 104)).toBe('104% base damage');
    expect(line('fire', 104)).toBe('Converts at 104% to fire');
    expect(line('timer', 125)).toBe(`Releases after ${Number((SPELL.timerSeconds / 1.25).toFixed(2))} s`);
    expect(line('swift', 110)).toBe('+33% speed');
    expect(line('concentrated', 120)).toBe('25% less size');
    expect(line('split', 1)).toBe('Up to 1 extra copy on a cast');
    expect(line('split', 0)).toBe('No extra copies');
    expect(line('ward', 90)).toBe('90% shield');
  });
});
