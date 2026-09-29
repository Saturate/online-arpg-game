import { describe, expect, it } from 'vitest';
import {
  CASTABLE_RUNES,
  compileRunes,
  compileSigilItem,
  createRune,
  createSigil,
  createStarterSigil,
  DEFAULT_SIGIL_CONTEXT,
  formatRunes,
  HEAT,
  Rng,
  rollDrops,
  runeItemFromInstance,
  sigilCapacity,
  SIGIL_MAX_SLOTS,
  SKILL_BUTTONS,
  Simulation,
  STARTER_SIGILS,
  toRuneInstance,
  tokenizeSpell,
  type EquippedSigil,
  type RuneItem,
  type SigilItem,
} from '../src/index.js';
import { compileText } from './helpers/spell.js';

/** `distance` to the dummy: zones are placed on the caster in today's engine. */
function castAtDummy(text: string, distance = 200): number {
  const compiled = compileText(text);
  if (!compiled.ok) throw new Error(`${text}: ${compiled.errors.map((e) => e.message).join('; ')}`);
  const sim = new Simulation(3);
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('lab', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  const eq: EquippedSigil = { uid: -1, compiled, misfireMultiplier: 1, castDelay: HEAT.castCooldownSeconds };
  p.sigils = [eq, null, null, null];
  const dummy = sim.spawnEnemy('chaser', pos.x + distance, pos.y);
  const h = sim.world.health.get(dummy);
  const e = sim.world.enemy.get(dummy);
  if (!h || !e) throw new Error('no dummy');
  h.maxLife = 1e9;
  h.life = 1e9;
  e.speedMult = 0;
  let seq = 0;
  for (let t = 0; t < 60; t++) {
    p.heat = 0;
    sim.applyInput(pid, { seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] ?? 0 });
    sim.step();
  }
  return 1e9 - h.life;
}

function rulesOf(text: string): string[] {
  const c = compileText(text);
  return c.ok ? [] : c.errors.map((e) => e.rule);
}

describe('compiling v2 spells', () => {
  it('castable spells deal damage', () => {
    for (const text of ['orb[every 0.2s] cold split(4) bolt[small]', 'bolt fire onhit nova', 'orb[onexpire] fire split(6) bolt[+30% damage]', 'nova lightning split(3)']) {
      expect(castAtDummy(text), text).toBeGreaterThan(0);
    }
    expect(castAtDummy('zone fire fire', 40)).toBeGreaterThan(0);
  });

  it('names what the engine cannot run yet instead of dropping it', () => {
    expect(rulesOf('orb lightning split(3) link')).toContain('rune-not-castable');
    expect(rulesOf('beam fire')).toContain('rune-not-castable');
    expect(rulesOf('bolt[homing]')).toContain('engine-not-ready');
    const multi = compileRunes(tokenizeSpell('bolt nova').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', multicast: 2 });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.errors.map((e) => e.rule)).toEqual(['engine-not-ready']);
  });

  it('doubled infusions hit harder', () => {
    expect(castAtDummy('bolt fire fire')).toBeGreaterThan(castAtDummy('bolt fire'));
  });

  it('refuses more runes than the sigil has slots', () => {
    const runes = tokenizeSpell('bolt fire cold').runes;
    const r = compileRunes(runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', slots: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.rule).toBe('over-capacity');
  });

  it('prices Force per rune by depth and affinity, and a dud still has a price', () => {
    const ctx = { ...DEFAULT_SIGIL_CONTEXT, forceMultiplier: 1 };
    const force = (text: string, classId: 'mage' | 'warrior' = 'mage'): number => compileRunes(tokenizeSpell(text).runes, { ...ctx, classId }).force;
    // Bolt 8 off affinity (1.2), Fire 4 on the mage's affinity (0.8).
    expect(force('bolt fire')).toBeCloseTo(8 * 1.2 + 4 * 0.8);
    expect(force('bolt fire', 'warrior')).toBeCloseTo(12 * 1.2);
    // The trigger at the bolt's depth, the nova one payload level down.
    expect(force('bolt timer nova', 'warrior')).toBeCloseTo((8 + 4) * 1.2 + 14 * (1 + HEAT.depthHeatFactor) * 1.2);
    // A release affix costs what its trigger rune would.
    expect(force('bolt[after 0.5s] nova', 'warrior')).toBeCloseTo(force('bolt timer nova', 'warrior'));
    expect(force('bolt fire onhit')).toBeGreaterThan(0);
    const free = compileRunes(tokenizeSpell('bolt fire').runes, { ...ctx, classId: 'mage', firstRuneFree: true });
    expect(free.force).toBeCloseTo(4 * 0.8);
  });

  it('persistent shapes reserve spirit instead of Force', () => {
    const aura = compileText('aura ward');
    expect(aura).toMatchObject({ ok: true, persistent: true, force: 0, spirit: 42 });
    const bond = compileText('bond ward');
    expect(bond).toMatchObject({ ok: true, persistent: true, spirit: 37 });
    if (bond.ok) expect(bond.program.form).toBe('bond');
  });
});

describe('rune items', () => {
  it('turn into the grammar rune their affixes describe', () => {
    const rolled: RuneItem = {
      ...createRune(1, 'orb'),
      affixes: [
        { id: 'release_every', tier: 1, value: 0.35 },
        { id: 'rune_speed', tier: 0, value: -20 },
        { id: 'rune_damage', tier: 0, value: 15 },
        { id: 'rune_pierce', tier: 0, value: 2 },
      ],
    };
    expect(toRuneInstance(rolled)).toEqual({ id: 'orb', affixes: { release: { kind: 'every', seconds: 0.35 }, speed: -20, damage: 15, pierce: 2 } });
    expect(toRuneInstance({ ...createRune(2, 'split'), affixes: [{ id: 'split_count', tier: 2, value: 5 }] })).toEqual({ id: 'split', affixes: { count: 5 } });
    expect(toRuneInstance(createRune(3, 'fire'))).toEqual({ id: 'fire', affixes: {} });
  });

  it('round trip through the starter sigil builder', () => {
    for (const def of STARTER_SIGILS) {
      const back = def.runes.map((r, i) => toRuneInstance(runeItemFromInstance(i, r, false)));
      expect(back, def.id).toEqual(def.runes);
    }
  });

  it('drop only as plain runes the engine can run', () => {
    let uid = 1;
    const rng = new Rng(7);
    const castable: readonly string[] = CASTABLE_RUNES;
    for (let i = 0; i < 300; i++) {
      for (const item of rollDrops(rng, () => uid++, { level: 10, rare: true, boss: false })) {
        if (item.kind !== 'rune') continue;
        expect(castable).toContain(item.rune);
        expect(item.affixes).toEqual([]);
      }
    }
  });
});

describe('sigil capacity', () => {
  const sigil = (tier: SigilItem['tier'], over: Partial<SigilItem> = {}): SigilItem => ({ ...createSigil(1, new Rng(1), tier), affixes: [], corrupted: false, ...over });

  it('is the tier base plus the slots affix and corruption, capped', () => {
    expect(sigilCapacity(sigil('common'))).toBe(3);
    expect(sigilCapacity(sigil('magic'))).toBe(4);
    expect(sigilCapacity(sigil('rare'))).toBe(5);
    expect(sigilCapacity(sigil('relic'))).toBe(6);
    expect(sigilCapacity(sigil('rare', { corrupted: true, affixes: [{ id: 'sigil_slots', tier: 2, value: 3 }] }))).toBe(9);
    expect(sigilCapacity(sigil('relic', { corrupted: true, affixes: [{ id: 'sigil_slots', tier: 2, value: 3 }, { id: 'sigil_slots', tier: 2, value: 3 }] }))).toBe(SIGIL_MAX_SLOTS);
  });

  it('always fits a starter sigil\'s own runes', () => {
    const fireball = STARTER_SIGILS.find((s) => s.id === 'fireball');
    if (!fireball) throw new Error('no fireball');
    expect(fireball.runes.length).toBeGreaterThan(3);
    expect(sigilCapacity(sigil('common', { starter: 'fireball' }))).toBe(fireball.runes.length);
  });
});

describe('starter sigils', () => {
  it('keep the old skill ids, and every one compiles for its own class', () => {
    expect(STARTER_SIGILS).toHaveLength(20);
    for (const def of STARTER_SIGILS) {
      let uid = 1;
      const item = createStarterSigil(() => uid++, def, { bound: true });
      const r = compileSigilItem(item, def.classId);
      expect(r.ok ? [] : r.errors.map((e) => e.message), `${def.id}: ${formatRunes(def.runes)}`).toEqual([]);
    }
  });

  it('give the sigil and every rune in it its own fresh uid', () => {
    const def = STARTER_SIGILS.find((s) => s.id === 'frozen_orb');
    if (!def) throw new Error('no frozen orb');
    const issued: number[] = [];
    let next = 100;
    const item = createStarterSigil(() => {
      issued.push(next);
      return next++;
    }, def, { bound: true });
    const uids = [item.uid, ...item.slots.map((r) => r.uid)];
    expect(new Set(uids).size).toBe(def.runes.length + 1);
    expect(uids.sort()).toEqual(issued.sort());
    expect(item.slots.every((r) => r.count === 1 && r.bound === true)).toBe(true);
    const loose = createStarterSigil(() => next++, def, { bound: false });
    expect(loose.bound).toBeUndefined();
    expect(loose.slots.some((r) => r.bound === true)).toBe(false);
  });

  it('are what a new character starts with, and a save round trip reissues every uid', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('a', 'mage');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('setup');
    const equipped = p.sigils.flatMap((s) => (s ? [p.items.get(s.uid)] : []));
    expect(equipped.map((i) => (i?.kind === 'sigil' ? i.starter : null))).toEqual(['fireball', 'frozen_orb', 'static_nova', 'blink']);
    expect(p.sigils.every((s) => s?.compiled.ok === true)).toBe(true);
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    expect(save.runeFormat).toBe(2);
    const before = new Set(save.items.flatMap((i) => [i.uid, ...(i.kind === 'sigil' ? i.slots.map((r) => r.uid) : [])]));
    const other = new Simulation(3);
    other.startItemUidsAt(1_000_000);
    const qid = other.addPlayer('a', 'mage', 'A', save);
    const q = other.world.player.get(qid);
    if (!q) throw new Error('setup');
    const after = [...q.items.values()].flatMap((i) => [i.uid, ...(i.kind === 'sigil' ? i.slots.map((r) => r.uid) : [])]);
    expect(new Set(after).size).toBe(after.length);
    for (const uid of after) expect(before.has(uid)).toBe(false);
    // Runes in slots live only in their sigil, never also in the character's items.
    const slotUids = [...q.items.values()].flatMap((i) => (i.kind === 'sigil' ? i.slots.map((r) => r.uid) : []));
    for (const uid of slotUids) expect(q.items.has(uid)).toBe(false);
  });
});
