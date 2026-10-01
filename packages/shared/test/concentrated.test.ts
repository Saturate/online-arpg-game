import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  bracketTree,
  BUTTON,
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
  type SigilItem,
  type SpellNode,
} from '../src/index.js';
import { addItem } from '../src/sim/inventory.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { slotsFor } from './helpers/spell.js';

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

  it('goes on a shape once, and sits beside Large', () => {
    const twice = errorOf('nova concentrated(50) lightning concentrated(60)', 'concentrated-once');
    expect(twice.runeIndex).toBe(3);
    expect(twice.message).toContain('already has Concentrated (rune 2)');
    expect(root('bolt[onhit] concentrated nova concentrated').payload[0]?.stats.concentration).toBe(40);
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

  it('refuses an amount outside what a drop rolls, 40 to 60%', () => {
    expect(errorOf('nova concentrated(0)', 'concentrated-amount').runeIndex).toBe(1);
    expect(errorOf('nova concentrated(39)', 'concentrated-amount').message).toContain('40 to 60%');
    expect(errorOf('nova concentrated(1000000)', 'concentrated-amount').message).toContain('1000000%');
    expect(root('nova concentrated(60)').stats.concentration).toBe(60);
    const table = AFFIXES.rune_concentrated.tiers;
    expect(Math.min(...table.map((t) => t.min))).toBe(CONCENTRATED.minMore);
    expect(Math.max(...table.map((t) => t.max))).toBe(CONCENTRATED.maxMore);
    expect(CONCENTRATED.defaultMore).toBe(CONCENTRATED.minMore);
  });

  it('leaves Aura and Bond without a damage affix, as the drop table does', () => {
    expect(errorOf('aura[+50% damage] fire', 'affix-not-allowed').message).toContain('cannot carry a damage affix');
    expect(errorOf('bond[+20% damage] ward', 'affix-not-allowed').runeIndex).toBe(0);
    expect(root('nova[+50% damage]').stats.damage).toBe(50);
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
    const half = parseSpellText('zone concentrated(40.5)');
    if (!half.tree) throw new Error('no tree');
    expect(describeTree(half.tree)).toContain('concentrated for 40.5% more damage');
    const runes = tokenizeSpell('bolt[onhit] concentrated(55) nova concentrated').runes;
    expect(formatRunes(runes)).toBe('bolt[onhit] concentrated(55) nova concentrated');
    expect(tokenizeSpell('nova concentrated[concentration 48]').runes[1]?.affixes.concentration).toBe(48);
  });

  it('has a name, a glyph and a tooltip that says which shape it changes', () => {
    expect(runeName('concentrated')).toBe('Concentrated');
    expect(runeGlyph('concentrated')).toBe('Ct');
    expect(runeDescription('concentrated')).toContain('more damage');
    expect(runeDescription('concentrated')).toContain('across a trigger or a Split');
    // Like an infusion: written after a release and a Split, it still goes to the Orb.
    const orb = root('orb[onhit] split concentrated nova');
    expect(orb.stats.concentration).toBe(40);
    expect(orb.payload[0]?.stats.concentration).toBe(0);
  });
});

describe('Concentrated in the compiler', () => {
  it('multiplies the damage tuning only, and shrinks the radius', () => {
    const plain = compiled('nova lightning').program.roots[0];
    const conc = compiled('nova lightning concentrated(50)').program.roots[0];
    if (!plain || !conc) throw new Error('no root');
    expect(conc.tuning.damage / plain.tuning.damage).toBeCloseTo(1.5, 6);
    expect(conc.tuning.radius).toBeCloseTo(0.7, 6);
    // damageScale also scales heals and shields, so Concentrated stays out of it.
    expect(conc.damageScale).toBe(plain.damageScale);
  });

  it('multiplies the damage affix and the sigil damage rather than adding to them', () => {
    const conc = compiled('nova[+50% damage] concentrated(50)').program.roots[0];
    if (!conc) throw new Error('no root');
    expect(conc.tuning.damage).toBeCloseTo(1.5 * 1.5, 6);
    const c = compileRunes(tokenizeSpell('nova concentrated(50)').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', damageMultiplier: 1.2 });
    const n = c.ok ? c.program.roots[0] : undefined;
    expect(n ? n.damageScale * n.tuning.damage : 0).toBeCloseTo(1.8, 6);
  });

  it('notes that it only shrinks a shape that deals no damage', () => {
    expect(compiled('nova restore concentrated').notes.join(' ')).toContain('only adds damage');
    expect(compiled('aura ward concentrated').notes.join(' ')).toContain('only adds damage');
    expect(compiled('nova restore fire concentrated').notes.join(' ')).not.toContain('only adds damage');
  });

  it('costs Force: its base price plus its damage, priced like a damage roll', () => {
    expect(force('nova concentrated')).toBeGreaterThan(force('nova'));
    expect(force('nova concentrated(60)')).toBeGreaterThan(force('nova concentrated(40)'));
    // More than the +55% damage affix, which takes no slot and gives up no area.
    expect(force('nova concentrated(55)')).toBeGreaterThan(force('nova[+55% damage]'));
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

/** A mage (no aura of its own) holding one sigil in slot 0, alone in a flat room. */
function holding(spell: string) {
  const sim = new Simulation(3);
  const id = sim.addPlayer('c1', 'mage', 'Tester');
  const p = sim.world.player.get(id);
  if (!p) throw new Error('no player');
  const item: SigilItem = { ...createSigil(sim.newItemUid(), sim.rng, 'relic'), affixes: [], corrupted: true };
  item.slots = slotsFor(spell, () => sim.newItemUid());
  addItem(p, item);
  for (let i = 0; i < p.sigils.length; i++) p.sigils[i] = null;
  const err = sim.equipSigil(id, item.uid, 0);
  if (err !== null) throw new Error(`${spell}: ${err}`);
  const eq = p.sigils[0];
  if (!eq || !eq.compiled.ok) throw new Error(`${spell} does not compile`);
  return { sim, id, p, compiled: eq.compiled };
}

type AuraKind = 'damage' | 'impact' | 'ward' | 'restore';

/** Every aura type, and the element mixes Concentrated multiplies all at once. */
const AURAS: readonly { runes: string; kind: AuraKind }[] = [
  { runes: 'fire', kind: 'damage' },
  { runes: 'cold', kind: 'damage' },
  { runes: 'lightning', kind: 'damage' },
  { runes: 'fire cold lightning', kind: 'damage' },
  { runes: 'fire fire fire', kind: 'damage' },
  { runes: 'lightning lightning cold', kind: 'damage' },
  { runes: 'impact', kind: 'impact' },
  { runes: 'ward', kind: 'ward' },
  { runes: 'restore', kind: 'restore' },
];

/** At a 60% roll; the spirit share holds it at 1.6 / 1.35 for any mix, plus rounding. */
const MAX_DAMAGE_PER_SPIRIT = 1.2;

/** What one aura does in a tick: damage to an enemy beside the caster, its push, or the caster's own buff. */
function auraStrength(runes: string, kind: AuraKind): { strength: number; spirit: number } {
  const { sim, id, compiled } = holding(`aura ${runes}`);
  const pos = sim.world.position.get(id);
  if (!pos) throw new Error('no position');
  if (kind === 'ward' || kind === 'restore') {
    sim.step();
    const b = sim.world.buffs.get(id);
    return { strength: kind === 'ward' ? (b?.damageReduction ?? 0) : (b?.regenPerSecond ?? 0), spirit: compiled.spirit };
  }
  const eid = spawnEnemy(sim, 'chaser', pos.x + 30, pos.y, { rare: false, level: 1, aggro: false, boss: false });
  const h = sim.world.health.get(eid);
  if (!h) throw new Error('no enemy');
  h.maxLife = 1e9;
  h.life = 1e9;
  sim.step();
  // An idle enemy keeps its knockback queued, so the push one tick adds is readable there.
  const e = sim.world.enemy.get(eid);
  return { strength: kind === 'impact' ? Math.hypot(e?.knockX ?? 0, e?.knockY ?? 0) : 1e9 - h.life, spirit: compiled.spirit };
}

describe('Concentrated adds damage only', () => {
  for (const { runes, kind } of AURAS) {
    const what = kind === 'damage' ? `more damage per tick, at most ${MAX_DAMAGE_PER_SPIRIT}x the damage per spirit` : 'the same strength, so less per spirit';
    it(`on aura ${runes}: ${what}`, () => {
      for (const large of ['', ' large']) {
        const plain = auraStrength(`${runes}${large}`, kind);
        const conc = auraStrength(`${runes}${large} concentrated(60)`, kind);
        expect(plain.strength, `${runes}${large}`).toBeGreaterThan(0);
        expect(conc.spirit).toBeGreaterThan(plain.spirit);
        const perSpirit = conc.strength / conc.spirit / (plain.strength / plain.spirit);
        if (kind === 'damage') {
          expect(conc.strength / plain.strength).toBeCloseTo(1.6, 2);
          expect(perSpirit, `${runes}${large}`).toBeLessThanOrEqual(MAX_DAMAGE_PER_SPIRIT);
        } else {
          expect(conc.strength).toBeCloseTo(plain.strength, 6);
          expect(perSpirit).toBeLessThan(1);
        }
      }
    });
  }

  it('reserves at least 10 spirit, and 35% of the rest of a bigger aura', () => {
    const spirit = (text: string): number => compiled(text).spirit;
    expect(spirit('aura concentrated') - spirit('aura')).toBe(11);
    expect(spirit('aura fire cold lightning large concentrated') - spirit('aura fire cold lightning large')).toBe(24);
  });

  it('heals and shields no more per cast, and less per Force', () => {
    for (const spell of ['nova restore', 'nova ward', 'zone restore', 'nova restore fire']) {
      const measure = (text: string): { heal: number; shield: number; force: number } => {
        const { sim, id, compiled } = holding(text);
        const h = sim.world.health.get(id);
        if (!h) throw new Error('no health');
        h.life = 1;
        sim.applyInput(id, { seq: 0, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: BUTTON.skill1 });
        sim.step();
        sim.applyInput(id, { seq: 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
        for (let i = 0; i < 30; i++) sim.step();
        return { heal: h.life - 1, shield: sim.world.status.get(id)?.shield?.amount ?? 0, force: compiled.force };
      };
      const plain = measure(spell);
      const conc = measure(`${spell} concentrated(60)`);
      expect(plain.heal + plain.shield, spell).toBeGreaterThan(0);
      expect(conc.heal, spell).toBeCloseTo(plain.heal, 6);
      expect(conc.shield, spell).toBeCloseTo(plain.shield, 6);
      expect(conc.force).toBeGreaterThan(plain.force);
    }
  });
});
