import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  bracketTree,
  CASTABLE_RUNES,
  clampRoll,
  compareRunes,
  compileRunes,
  compileSigilItem,
  CONCENTRATED,
  createGrantItem,
  createRolledRune,
  createRune,
  createSigil,
  DEFAULT_SIGIL_CONTEXT,
  describeTree,
  dropsRolled,
  forgeInsertPrice,
  formatRunes,
  isItemShape,
  parseGrantRequest,
  parseSpellText,
  rollDrops,
  ROLLABLE_RUNES,
  Rng,
  runeDescription,
  runeGlyph,
  runeItemFromInstance,
  runeName,
  sellPrice,
  Simulation,
  tokenizeSpell,
  toRuneInstance,
  type ClassId,
  type GrammarContext,
  type RuleId,
  type RuneItem,
  type SigilCompile,
  type SpellNode,
} from '../src/index.js';
import { addItem } from '../src/sim/inventory.js';

function root(text: string, ctx: Partial<GrammarContext> = {}): SpellNode {
  const r = parseSpellText(text, ctx);
  const n = r.tree?.roots[0];
  if (!r.ok || !n) throw new Error(`${text}: ${r.errors.map((e) => e.message).join('; ')}`);
  return n;
}

function errorOf(text: string, rule: RuleId): { runeIndex: number; message: string } {
  const e = parseSpellText(text).errors.find((x) => x.rule === rule);
  if (!e) throw new Error(`${text}: expected ${rule}, got ${JSON.stringify(parseSpellText(text).errors)}`);
  return e;
}

function compiled(text: string, classId: ClassId = 'mage'): Extract<SigilCompile, { ok: true }> {
  const c = compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId });
  if (!c.ok) throw new Error(`${text}: ${c.errors.map((e) => e.message).join('; ')}`);
  return c;
}

const force = (text: string, classId: ClassId = 'mage'): number => compiled(text, classId).force;

describe('Concentrated in the grammar', () => {
  it('gives the shape before it more damage and 30% less size', () => {
    const nova = root('nova concentrated(55)');
    expect(nova.stats.concentration).toBe(55);
    expect(nova.stats.size).toBe(CONCENTRATED.sizePercent);
    expect(nova.stats.damage).toBe(0);
  });

  it('uses the lowest roll when the rune carries none', () => {
    expect(root('nova concentrated').stats.concentration).toBe(CONCENTRATED.defaultMore);
    expect(root('zone conc').stats.concentration).toBe(CONCENTRATED.defaultMore);
  });

  it('adds up when doubled, and sits beside Large', () => {
    const doubled = root('nova concentrated(50) concentrated(60)');
    expect(doubled.stats.concentration).toBe(110);
    expect(doubled.stats.size).toBe(2 * CONCENTRATED.sizePercent);
    expect(root('nova large concentrated').stats.size).toBe(50 + CONCENTRATED.sizePercent);
    expect(root('nova[+50% size] concentrated').stats.size).toBe(50 + CONCENTRATED.sizePercent);
  });

  it('works on every shape with an area, the cast or a payload', () => {
    for (const shape of ['orb', 'bolt', 'nova', 'zone']) expect(root(`${shape} concentrated`).stats.concentration).toBe(40);
    expect(root('aura fire concentrated').stats.concentration).toBe(40);
    const bolt = root('bolt[onhit] fire nova concentrated(50)');
    expect(bolt.stats.concentration).toBe(0);
    expect(bolt.payload[0]?.stats.concentration).toBe(50);
  });

  it('does not need the plain modifier flag', () => {
    expect(root('nova concentrated', { plainModifierRunes: false }).stats.concentration).toBe(40);
  });

  it('refuses a shape with no area, naming the rune', () => {
    const dash = errorOf('dash concentrated', 'concentrated-needs-area');
    expect(dash.runeIndex).toBe(1);
    expect(dash.message).toContain('Dash (rune 1) has no area');
    expect(errorOf('bond ward concentrated', 'concentrated-needs-area').runeIndex).toBe(2);
    expect(errorOf('dash[onland] concentrated nova', 'concentrated-needs-area').runeIndex).toBe(1);
  });

  it('refuses an amount of 0% or less', () => {
    expect(errorOf('nova concentrated(0)', 'concentrated-amount').runeIndex).toBe(1);
    expect(errorOf('nova concentrated(-20)', 'concentrated-amount').message).toContain('-20%');
  });

  it('carries no other affix, and is no shape to start with', () => {
    expect(errorOf('nova concentrated[+20% damage]', 'affix-not-allowed').runeIndex).toBe(1);
    expect(errorOf('concentrated nova', 'first-rune-shape').runeIndex).toBe(0);
  });

  it('reads back in the sentence, the bracket view and the text form', () => {
    const r = parseSpellText('nova concentrated(55) lightning');
    if (!r.tree) throw new Error('no tree');
    expect(describeTree(r.tree)).toBe('Casts a small lightning nova, concentrated for 55% more damage.');
    expect(bracketTree(r.tree)).toBe('Nova[small, lightning, 55% more damage]');
    const runes = tokenizeSpell('nova concentrated(55) concentrated').runes;
    expect(formatRunes(runes)).toBe('nova concentrated(55) concentrated');
    expect(tokenizeSpell('nova concentrated[concentration 48]').runes[1]?.affixes.concentration).toBe(48);
  });

  it('has a name, a glyph and a tooltip', () => {
    expect(runeName('concentrated')).toBe('Concentrated');
    expect(runeGlyph('concentrated')).toBe('Ct');
    expect(runeDescription('concentrated')).toContain('more damage');
  });
});

describe('Concentrated in the compiler', () => {
  it('multiplies the damage scale and shrinks the radius', () => {
    const plain = compiled('nova lightning').program.roots[0];
    const conc = compiled('nova lightning concentrated(50)').program.roots[0];
    if (!plain || !conc) throw new Error('no root');
    expect(conc.damageScale / plain.damageScale).toBeCloseTo(1.5, 6);
    expect(conc.tuning.radius).toBeCloseTo(0.7, 6);
    expect(conc.tuning.damage).toBe(plain.tuning.damage);
  });

  it('multiplies the damage affix and the sigil damage rather than adding to them', () => {
    const conc = compiled('nova[+50% damage] concentrated(50)').program.roots[0];
    if (!conc) throw new Error('no root');
    expect(conc.tuning.damage * conc.damageScale).toBeCloseTo(1.5 * 1.5, 6);
    const c = compileRunes(tokenizeSpell('nova concentrated(50)').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', damageMultiplier: 1.2 });
    expect(c.ok && c.program.roots[0]?.damageScale).toBeCloseTo(1.8, 6);
  });

  it('strengthens an aura in a smaller radius, for spirit', () => {
    const aura = compiled('aura fire concentrated(50)');
    const plain = compiled('aura fire');
    expect(aura.program.roots[0]?.damageScale).toBeCloseTo(1.5, 6);
    expect(aura.program.roots[0]?.tuning.radius).toBeCloseTo(0.7, 6);
    expect(aura.spirit - plain.spirit).toBe(10);
  });

  it('costs Force: its base price plus its damage, priced like a damage roll', () => {
    expect(force('nova concentrated')).toBeGreaterThan(force('nova'));
    expect(force('nova concentrated(60)')).toBeGreaterThan(force('nova concentrated(40)'));
    // More than the +55% damage affix, which takes no slot and gives up no area.
    expect(force('nova concentrated(55)')).toBeGreaterThan(force('nova[+55% damage]'));
    expect(force('nova concentrated concentrated')).toBeGreaterThan(force('nova concentrated'));
  });

  it('pays at least half its price on a payload, like other riders', () => {
    const extra = force('bolt[onhit] nova concentrated(60)', 'ranger') - force('bolt[onhit] nova', 'ranger');
    const onCast = force('nova concentrated(60)', 'ranger') - force('nova', 'ranger');
    expect(extra).toBeGreaterThanOrEqual(onCast * 0.5 - 0.1);
  });

  it('is castable and so drops and shows in the forge pool', () => {
    const castable: readonly string[] = CASTABLE_RUNES;
    expect(castable).toContain('concentrated');
    expect(ROLLABLE_RUNES).toContain('concentrated');
  });
});

describe('Concentrated runes as items', () => {
  it('always roll their amount, with tiers by item level', () => {
    const rng = new Rng(7);
    let uid = 1;
    const low = Array.from({ length: 60 }, () => createRolledRune(uid++, rng, 'magic', 1, 'concentrated'));
    for (const r of low) {
      expect(r.affixes.map((a) => a.id)).toEqual(['rune_concentrated']);
      expect(r.affixes[0]?.tier).toBe(0);
      expect(r.affixes[0]?.value).toBeGreaterThanOrEqual(40);
      expect(r.affixes[0]?.value).toBeLessThanOrEqual(46);
      expect(r.tier).not.toBe('common');
      expect(r.name).toContain('Concentrated Rune');
      expect(r.count).toBe(1);
    }
    const high = Array.from({ length: 200 }, () => createRolledRune(uid++, rng, 'rare', 8, 'concentrated'));
    const values = high.map((r) => r.affixes[0]?.value ?? 0);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...values)).toBeLessThanOrEqual(60);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(54);
    expect(new Set(high.map((r) => r.affixes[0]?.tier))).toEqual(new Set([0, 1, 2]));
  });

  it('never drop plain from monsters', () => {
    expect(dropsRolled('concentrated')).toBe(true);
    expect(dropsRolled('large')).toBe(false);
    const rng = new Rng(11);
    let uid = 1;
    const found: RuneItem[] = [];
    for (let i = 0; i < 3000; i++) {
      for (const item of rollDrops(rng, () => uid++, { level: 6, rare: true, boss: false })) {
        if (item.kind === 'rune' && item.rune === 'concentrated') found.push(item);
      }
    }
    expect(found.length).toBeGreaterThan(20);
    for (const r of found) {
      expect(r.affixes.filter((a) => a.id === 'rune_concentrated')).toHaveLength(1);
      expect(r.count).toBe(1);
    }
  });

  it('cast with the rolled amount, and clamp to the table outside a sigil', () => {
    const rune: RuneItem = { ...createRune(1, 'concentrated'), affixes: [{ id: 'rune_concentrated', tier: 1, value: 51 }] };
    expect(toRuneInstance(rune)).toEqual({ id: 'concentrated', affixes: { concentration: 51 } });
    expect(toRuneInstance(createRune(2, 'concentrated'))).toEqual({ id: 'concentrated', affixes: {} });
    const back = runeItemFromInstance(3, { id: 'concentrated', affixes: { concentration: 58 } }, false);
    expect(back.affixes).toEqual([{ id: 'rune_concentrated', tier: 2, value: 58 }]);
    expect(clampRoll({ id: 'rune_concentrated', tier: 2, value: 90 })).toEqual({ id: 'rune_concentrated', tier: 2, value: 60 });
    expect(AFFIXES.rune_concentrated.text.replace('{v}', '51')).toBe('51% more damage');
  });

  it('sell and price by their roll like other rolled runes', () => {
    const at = (tier: number, value: number): RuneItem => ({ ...createRune(1, 'concentrated'), affixes: [{ id: 'rune_concentrated', tier, value }] });
    expect(sellPrice(at(2, 58))).toBeGreaterThan(sellPrice(at(0, 42)));
    expect(sellPrice(at(0, 42))).toBeGreaterThan(sellPrice(createRune(1, 'concentrated')));
    expect(forgeInsertPrice(at(1, 50))).toBe(sellPrice(at(1, 50)));
  });

  it('load from a save as a rune item and sort by their roll in the rune tab', () => {
    const rng = new Rng(3);
    const a = createRolledRune(1, rng, 'rare', 8, 'concentrated');
    const b = createRolledRune(2, rng, 'rare', 8, 'concentrated');
    const fromJson: unknown = JSON.parse(JSON.stringify(a));
    expect(isItemShape(fromJson)).toBe(true);
    const sorted = [a, b, createRune(3, 'fire')].sort(compareRunes('affix', 'rune_concentrated'));
    expect(sorted[2]?.rune).toBe('fire');
    expect(sorted[0]?.affixes[0]?.value).toBeGreaterThanOrEqual(sorted[1]?.affixes[0]?.value ?? 0);
  });

  it('can be granted from the admin page', () => {
    const req = parseGrantRequest({ username: 'owner', characterId: 1, template: 'rune', tier: 'rare', level: 6, minion: null, rune: 'concentrated' });
    if (typeof req === 'string') throw new Error(req);
    let uid = 1;
    const item = createGrantItem(req, () => uid++, new Rng(5));
    expect(item.kind === 'rune' && item.rune === 'concentrated' && item.affixes[0]?.id === 'rune_concentrated').toBe(true);
  });

  it('go into a sigil at the forge and cast from it', () => {
    const sim = new Simulation(4, { kind: 'world', seed: 3 });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    const forge = sim.mapDef.forge;
    if (!p || !pos || !forge) throw new Error('setup');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    p.gold = 1000;
    const blank = createSigil(sim.newItemUid(), sim.rand.loot, 'magic');
    addItem(p, blank);
    addItem(p, createRune(sim.newItemUid(), 'nova', 1));
    const conc: RuneItem = { ...createRolledRune(sim.newItemUid(), sim.rand.loot, 'rare', 8, 'concentrated'), affixes: [{ id: 'rune_concentrated', tier: 2, value: 57 }] };
    addItem(p, conc);
    expect(sim.inscribe(pid, blank.uid, [{ from: 'plain', rune: 'nova' }, { from: 'rolled', uid: conc.uid }])).toBeNull();
    expect(blank.slots.map((r) => r.rune)).toEqual(['nova', 'concentrated']);
    const c = compileSigilItem(blank, 'mage');
    expect(c.ok && c.tree.roots[0]?.stats.concentration).toBe(57);
    expect(sim.inscribe(pid, blank.uid, [{ from: 'keep', index: 0 }])).toBeNull();
    const back = p.items.get(conc.uid);
    expect(back?.kind === 'rune' && back.affixes).toEqual([{ id: 'rune_concentrated', tier: 2, value: 57 }]);
  });
});
