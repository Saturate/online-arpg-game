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
  runeMayCarry,
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
  const eq: EquippedSigil = { uid: -1, compiled, misfireMultiplier: 1, castDelayShare: 1 };
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
    expect(rulesOf('orb[bounce 2]')).toContain('engine-not-ready');
    const homing = compileText('bolt fire orb[homing]');
    expect(homing.ok ? [] : homing.errors).toContainEqual(expect.objectContaining({ rule: 'multicast', runeIndex: 2 }));
  });

  it('runs shapes cast together and payloads of several shapes', () => {
    const multi = compileRunes(tokenizeSpell('bolt nova').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', multicast: 2 });
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.program.roots.map((r) => r.form)).toEqual(['bolt', 'nova']);
    const payload = compileRunes(tokenizeSpell('bolt[onhit] fire nova zone').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', multicast: 2 });
    expect(payload.ok).toBe(true);
    if (payload.ok) expect(payload.program.roots[0]?.payload.map((n) => n.form)).toEqual(['nova', 'zone']);
    // Without the multicast, the same payload names the rule and the rune that broke it.
    const single = compileText('bolt[onhit] fire nova zone');
    expect(single.ok ? [] : single.errors).toContainEqual(expect.objectContaining({ rule: 'multicast', runeIndex: 3 }));
  });

  it('carries each rune\'s own numbers into the program', () => {
    const c = compileText('orb[every 0.3s, -20% speed, +40% size, pierce 2] cold split(3) bolt[after 0.7s, +50% duration, -10% damage] nova');
    if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('; '));
    const orb = c.program.roots[0];
    expect(orb).toMatchObject({ form: 'orb', release: { kind: 'every', seconds: 0.3 }, pierce: 2 });
    expect(orb?.tuning).toMatchObject({ speed: 0.8, radius: 1.4, phase: 1 });
    const bolt = orb?.payload[0];
    expect(bolt).toMatchObject({ form: 'bolt', copies: 3, release: { kind: 'after', seconds: 0.7 } });
    expect(bolt?.tuning).toMatchObject({ range: 1.5, damage: 0.9, phase: 0 });
    expect(c.notes.some((n) => n.includes('rolls through every enemy'))).toBe(true);
    // An orb that bursts on hit does not roll through.
    const burst = compileText('orb[onhit, pierce 1] fire nova');
    if (burst.ok) expect(burst.program.roots[0]?.tuning.phase).toBe(0);
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

  it('prices Force per rune by depth, affinity and affixes, and a dud still has a price', () => {
    const ctx = { ...DEFAULT_SIGIL_CONTEXT, forceMultiplier: 1 };
    const force = (text: string, classId: 'mage' | 'warrior' = 'mage'): number => compileRunes(tokenizeSpell(text).runes, { ...ctx, classId }).force;
    // Bolt 8 off affinity (1.2), Fire 4 on the mage's affinity (0.8).
    expect(force('bolt fire')).toBeCloseTo(8 * 1.2 + 4 * 0.8);
    expect(force('bolt fire', 'warrior')).toBeCloseTo(12 * 1.2);
    // The trigger at the bolt's depth, the nova one payload level down at the payload share.
    expect(force('bolt timer nova', 'warrior')).toBeCloseTo((8 + 2) * 1.2 + 14 * HEAT.payloadForceFactor * 1.2, 1);
    // A Split is never discounted, even on a payload.
    expect(force('bolt timer split(3) bolt', 'warrior') - force('bolt timer bolt', 'warrior')).toBeCloseTo(6 * 1.2, 1);
    // A number affix costs what the plain rune it replaces does; a drawback gives half back.
    expect(force('nova[+50% size]', 'warrior')).toBeCloseTo(force('nova large', 'warrior'), 1);
    expect(force('bolt[pierce 2]', 'warrior') - force('bolt', 'warrior')).toBeCloseTo(3 * 1.2, 1);
    const faster = force('bolt[+50% speed]', 'warrior') - force('bolt', 'warrior');
    expect(faster).toBeCloseTo(3 * 1.2, 1);
    expect(force('bolt[-50% speed]', 'warrior') - force('bolt', 'warrior')).toBeCloseTo(-HEAT.affixRefundShare * faster, 1);
    expect(force('bolt[-90% speed, -90% damage]', 'warrior')).toBeGreaterThan(0);
    // A release affix costs what its trigger rune would.
    expect(force('bolt[after 0.5s] nova', 'warrior')).toBeCloseTo(force('bolt timer nova', 'warrior'));
    expect(force('bolt fire onhit')).toBeGreaterThan(0);
    expect(force('bolt[-90% speed, -90% damage]', 'warrior')).toBeGreaterThanOrEqual(HEAT.minForcePerCast);
  });

  it('charges a payload for its number affixes at more than its base share', () => {
    const force = (text: string): number => compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, forceMultiplier: 1, classId: 'warrior' }).force;
    const affixes = force('nova[+50% size, +55% damage]') - force('nova');
    const paid = force('bolt[after 0.3s] nova[+50% size, +55% damage]') - force('bolt[after 0.3s] nova');
    // Each Force is rounded to 0.1, so the differences carry up to 0.1 of rounding.
    expect(Math.abs(paid - affixes * HEAT.payloadAffixShare)).toBeLessThanOrEqual(0.11);
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

  it('drop only as runes the engine can run, and every rolled one reads as a castable rune', () => {
    let uid = 1;
    const rng = new Rng(7);
    const castable: readonly string[] = CASTABLE_RUNES;
    for (let i = 0; i < 300; i++) {
      for (const item of rollDrops(rng, () => uid++, { level: 10, rare: true, boss: false })) {
        if (item.kind !== 'rune') continue;
        expect(castable).toContain(item.rune);
        for (const a of item.affixes) expect(runeMayCarry(item.rune, a.id), `${item.rune} ${a.id}`).toBe(true);
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
