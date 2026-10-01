import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTunables,
  AILMENTS,
  applyTunables,
  AURA,
  fitSpirit,
  spiritReservedFor,
  pendingItems,
  CASTABLE_RUNES,
  compileRunes,
  DEFAULT_SIGIL_CONTEXT,
  HEAT,
  isServerMessage,
  LINK,
  parseTunablePatch,
  parseTunableValues,
  recompileSigils,
  resetTunables,
  RUNE_FORCE,
  RUNE_SPIRIT,
  SKILL_BUTTONS,
  SPELL,
  Simulation,
  tokenizeSpell,
  TUNABLES,
  tunableSpec,
  tunableValue,
  tunablesVersion,
  type EntityId,
  type SigilCompile,
  type TunableValues,
} from '../src/index.js';

afterEach(() => resetTunables());

function compile(text: string, classId: 'mage' | 'ranger' = 'mage'): SigilCompile {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) throw new Error(t.errors.map((e) => e.message).join('; '));
  return compileRunes(t.runes, { ...DEFAULT_SIGIL_CONTEXT, classId });
}

function force(text: string): number {
  const c = compile(text);
  if (!c.ok) throw new Error(`${text}: ${c.errors.map((e) => e.message).join('; ')}`);
  return c.force;
}

/** Every number in a config object, by the path the registry should give it. */
function leaves(prefix: string, obj: object): string[] {
  return Object.entries(obj).flatMap(([k, v]: [string, unknown]) => {
    if (typeof v === 'number') return [`${prefix}.${k}`];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return leaves(`${prefix}.${k}`, v);
    return [];
  });
}

/** A mage casting `text` from slot 0 at an unkillable dummy; returns the dummy's damage and the Force paid. */
function castAtDummy(text: string, ticks = 40): { damage: number; heat: number; radius: number } {
  const sim = new Simulation(7, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid: EntityId = sim.addPlayer('tuner', 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  p.god = true;
  p.warband = p.warband.map(() => null);
  p.sigils = [{ uid: -1, compiled: compile(text), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
  const dummy = sim.spawnEnemy('chaser', pos.x + 120, pos.y);
  const h = sim.world.health.get(dummy);
  if (!h) throw new Error('no dummy');
  h.maxLife = 1e9;
  h.life = 1e9;
  let heat = 0;
  let radius = 0;
  for (let i = 0; i < ticks; i++) {
    p.heat = 0;
    sim.applyInput(pid, { seq: i + 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: i === 0 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
    sim.step();
    if (i === 0) {
      heat = p.heat;
      for (const [id, proj] of sim.world.projectile) if (proj.ownerId === pid) radius = sim.world.radius.get(id) ?? 0;
    }
    const e = sim.world.enemy.get(dummy);
    const dp = sim.world.position.get(dummy);
    if (e) e.speedMult = 0;
    if (dp) Object.assign(dp, { x: pos.x + 120, y: pos.y });
  }
  return { damage: 1e9 - (sim.world.health.get(dummy)?.life ?? 1e9), heat, radius };
}

describe('the live tuning registry', () => {
  it('lists every SPELL, AURA, Bond and ailment number, with unique paths and its code default', () => {
    const paths = new Set(TUNABLES.map((t) => t.path));
    expect(paths.size).toBe(TUNABLES.length);
    const expected = [...leaves('spell', SPELL), ...leaves('aura', AURA), ...leaves('bond', LINK), ...leaves('ailment', AILMENTS)];
    for (const p of expected) expect(paths.has(p), p).toBe(true);
    expect(tunableSpec('spell.bolt.damage')?.default).toBe(16);
    expect(tunableSpec('spell.orb.radius')?.default).toBe(16);
    expect(tunableSpec('spell.nova.radius')?.default).toBe(130);
    for (const t of TUNABLES) {
      expect(t.default, t.path).toBe(tunableValue(t.path));
      expect(t.min <= t.default && t.default <= t.max, `${t.path} ${t.min} <= ${t.default} <= ${t.max}`).toBe(true);
      expect(t.label.length, t.path).toBeGreaterThan(0);
    }
  });

  it('prices every castable rune: Force (Split per copy; Aura and Bond cost none), spirit and the effect amounts', () => {
    for (const id of CASTABLE_RUNES) {
      if (id === 'aura' || id === 'bond' || id === 'split') continue;
      expect(tunableSpec(`force.rune.${id}`)?.default, id).toBe(RUNE_FORCE[id]);
    }
    for (const [id, v] of Object.entries(RUNE_SPIRIT)) expect(tunableSpec(`spirit.rune.${id}`)?.default, id).toBe(v);
    for (const p of ['force.splitPerCopy', 'rune.split.defaultCount', 'rune.swift.speed', 'rune.large.size', 'rune.concentrated.sizePercent', 'rune.concentrated.defaultMore', 'spirit.concentratedShare', 'spell.stackedInfusionBonus', 'spell.comboDamageBonus', 'spell.burningWardDamage', 'ailment.burn.dpsFractionOfHit', 'ailment.chill.slow', 'ailment.shock.damageTakenBonus']) {
      expect(tunableSpec(p), p).toBeDefined();
    }
    for (const key of ['payloadForceFactor', 'payloadRepeatShare', 'payloadAffixShare', 'affixStepForce', 'minForcePerCast']) expect(tunableSpec(`force.${key}`)?.default, key).toBe(Reflect.get(HEAT, key));
  });

  it('keeps ranges positive where zero would break the engine', () => {
    expect(tunableSpec('spell.zone.tickSeconds')?.min).toBeGreaterThan(0);
    expect(tunableSpec('spell.dash.ticks')).toMatchObject({ min: 1, int: true });
    expect(tunableSpec('spell.bolt.speed')?.min).toBeGreaterThan(0);
    expect(tunableSpec('spell.affixSteps.damage')?.min).toBeGreaterThan(1);
    expect(tunableSpec('ailment.chill.slow')?.max).toBe(1);
    expect(tunableSpec('spell.bolt.damage')).toMatchObject({ min: 0, max: 160 });
  });
});

describe('validating a change', () => {
  it('accepts numbers in range and null for the code default', () => {
    expect(parseTunablePatch({ 'spell.bolt.damage': 30, 'force.rune.nova': null })).toEqual({ 'spell.bolt.damage': 30, 'force.rune.nova': null });
    expect(parseTunablePatch({ 'spell.bolt.damage': 0 })).toEqual({ 'spell.bolt.damage': 0 });
  });

  it('refuses the whole patch for one bad entry', () => {
    for (const bad of [
      { 'spell.bolt.damage': 30, 'spell.bolt.nope': 1 },
      { 'spell.bolt.damage': -1 },
      { 'spell.bolt.damage': 161 },
      { 'spell.bolt.damage': '20' },
      { 'spell.bolt.damage': Number.NaN },
      { 'spell.dash.ticks': 2.5 },
      { 'spell.zone.tickSeconds': 0 },
      {},
      null,
      [1],
      'spell.bolt.damage',
    ]) {
      expect(typeof parseTunablePatch(bad), JSON.stringify(bad)).toBe('string');
    }
  });

  it('keeps the good entries of stored or received values and drops the rest', () => {
    const dropped: string[] = [];
    expect(parseTunableValues({ 'spell.bolt.damage': 30, 'spell.gone': 3, 'spell.orb.radius': -5, 'spell.nova.radius': 130 }, (why) => dropped.push(why))).toEqual({ 'spell.bolt.damage': 30 });
    // An unknown path (a retired one, or a newer server's) goes without a report; a bad value is reported.
    expect(dropped).toHaveLength(1);
    expect(parseTunableValues('nope')).toEqual({});
  });

  it('checks the change message on the client side of the wire', () => {
    expect(isServerMessage({ t: 'tunables', values: { 'spell.bolt.damage': 30 } })).toBe(true);
    expect(isServerMessage({ t: 'tunables', values: { 'spell.bolt.damage': 'x' } })).toBe(false);
    expect(isServerMessage({ t: 'tunables' })).toBe(false);
  });
});

describe('applying overrides', () => {
  it('sets the config in place and a reset brings back every code default', () => {
    const before = tunablesVersion();
    applyTunables({ 'spell.bolt.damage': 30, 'aura.radius': 200, 'force.rune.fire': 9, 'spirit.rune.aura': 40, 'rune.large.size': 80 });
    expect(SPELL.bolt.damage).toBe(30);
    expect(AURA.radius).toBe(200);
    expect(RUNE_FORCE.fire).toBe(9);
    expect(RUNE_SPIRIT.aura).toBe(40);
    expect(tunablesVersion()).toBeGreaterThan(before);
    expect(activeTunables()).toEqual({ 'spell.bolt.damage': 30, 'aura.radius': 200, 'force.rune.fire': 9, 'spirit.rune.aura': 40, 'rune.large.size': 80 });
    resetTunables();
    for (const t of TUNABLES) expect(tunableValue(t.path), t.path).toBe(t.default);
    expect(activeTunables()).toEqual({});
  });

  it('gives the same numbers for the same overrides whatever was applied before', () => {
    const set: TunableValues = { 'spell.orb.damage': 40, 'spell.nova.radius': 90 };
    applyTunables(set);
    const first = castAtDummy('orb[onhit] fire nova');
    applyTunables({ 'spell.orb.damage': 5, 'spell.zone.damage': 60, 'force.rune.orb': 30 });
    applyTunables(set);
    expect(castAtDummy('orb[onhit] fire nova')).toEqual(first);
    expect(SPELL.zone.damage).toBe(14);
  });

  it('reaches the next cast: damage, size and Force', () => {
    const plain = castAtDummy('orb');
    applyTunables({ 'spell.orb.damage': 32, 'spell.orb.radius': 40, 'force.rune.orb': 20 });
    const tuned = castAtDummy('orb');
    expect(tuned.damage).toBeCloseTo(plain.damage * 2, 5);
    expect(tuned.radius).toBeCloseTo(40, 5);
    expect(plain.radius).toBeCloseTo(16, 5);
    expect(tuned.heat).toBeCloseTo(plain.heat * 2, 1);
  });

  it('moves the numbers derived from a tunable along with it', () => {
    // A release affix costs what its trigger rune costs.
    const every = force('bolt[every 0.3s] nova');
    applyTunables({ 'force.rune.pulse': 13 });
    expect(force('bolt[every 0.3s] nova') - every).toBeCloseTo((13 - 3) * HEAT.costMultiplier * HEAT.offAffinityMultiplier, 1);
    // A plain Split makes the default count of copies, and a Timer waits the default seconds.
    applyTunables({ 'rune.split.defaultCount': 4, 'spell.timerSeconds': 1.5 });
    const split = compile('bolt split');
    expect(split.ok && split.program.roots[0]?.copies).toBe(4);
    const timed = compile('bolt timer nova');
    expect(timed.ok && timed.program.roots[0]?.release?.seconds).toBe(1.5);
    // The entity budget follows the live cap.
    applyTunables({ 'spell.liveCap.max': 3 });
    expect(compile('bolt split(4)').ok).toBe(false);
    resetTunables();
    expect(compile('bolt split(4)').ok).toBe(true);
    // Doubled infusions and Large.
    const doubled = compile('bolt fire fire');
    applyTunables({ 'spell.stackedInfusionBonus': 1, 'rune.large.size': 100 });
    const doubledTuned = compile('bolt fire fire');
    if (!doubled.ok || !doubledTuned.ok) throw new Error('compile');
    expect((doubledTuned.program.roots[0]?.damageScale ?? 0) / (doubled.program.roots[0]?.damageScale ?? 1)).toBeCloseTo(2 / 1.25, 5);
    const large = compile('bolt large');
    expect(large.ok && large.program.roots[0]?.tuning.radius).toBeCloseTo(2, 5);
  });

  it('recompiles equipped sigils, so their Force follows a change', () => {
    const sim = new Simulation(3, { kind: 'flat' });
    const pid = sim.addPlayer('tuner', 'mage');
    const p = sim.world.player.get(pid);
    const before = p?.sigils[0]?.compiled.force ?? 0;
    expect(before).toBeGreaterThan(0);
    applyTunables({ 'force.rune.orb': 40 });
    expect(p?.sigils[0]?.compiled.force).toBe(before);
    recompileSigils(sim);
    expect(p?.sigils[0]?.compiled.force ?? 0).toBeGreaterThan(before);
  });
});

describe('live tuning and the spirit pool', () => {
  function priest() {
    const sim = new Simulation(4, { kind: 'flat' });
    const pid = sim.addPlayer('tuner', 'priest');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no priest');
    const auraSlot = p.sigils.findIndex((eq) => eq?.compiled.ok === true && eq.compiled.persistent);
    if (auraSlot < 0) throw new Error('the priest kit has no aura equipped');
    return { sim, pid, p, auraSlot };
  }

  it('unequips persistent skills from the end when a change pushes spirit past the pool, keeping the sigil', () => {
    const { sim, pid, p, auraSlot } = priest();
    const uid = p.sigils[auraSlot]?.uid;
    applyTunables({ 'spirit.rune.aura': 300 });
    const notices = recompileSigils(sim);
    expect(p.sigils[auraSlot]).toBeNull();
    expect(spiritReservedFor(p)).toBeLessThanOrEqual(p.stats.spiritMax);
    expect(notices).toEqual([{ pid, text: 'Prayer was unequipped: a balance change raised its spirit past your pool' }]);
    expect(uid !== undefined && p.items.has(uid)).toBe(true);
    expect(uid !== undefined && (p.inventory.includes(uid) || pendingItems(p).includes(uid))).toBe(true);
  });

  it('does the same for a save that loads equipped under raised prices', () => {
    const { sim, pid, auraSlot } = priest();
    const save = sim.exportPlayer(pid);
    if (!save) throw new Error('no save');
    applyTunables({ 'spirit.rune.aura': 300 });
    const again = sim.addPlayer('again', 'priest', 'Again', save);
    const q = sim.world.player.get(again);
    expect(q?.sigils[auraSlot]?.compiled.ok).toBe(true);
    expect(fitSpirit(sim, again)).toEqual(['Prayer']);
    expect(q?.sigils[auraSlot]).toBeNull();
  });

  it('tells the player when a change makes an equipped sigil a dud', () => {
    const sim = new Simulation(5, { kind: 'flat' });
    const pid = sim.addPlayer('tuner', 'mage');
    applyTunables({ 'spell.liveCap.max': 1 });
    const notices = recompileSigils(sim);
    expect(notices.some((n) => n.pid === pid && n.text.startsWith('Frozen Orb no longer casts after a balance change'))).toBe(true);
  });
});

describe('compiling under extreme tuning', () => {
  it('stays fast with the slowest, longest-lived pulsing shapes the ranges allow', () => {
    const slow = { 'spell.bolt.speed': tunableSpec('spell.bolt.speed')?.min ?? 1, 'spell.bolt.range': tunableSpec('spell.bolt.range')?.max ?? 1, 'spell.orb.speed': tunableSpec('spell.orb.speed')?.min ?? 1, 'spell.orb.range': tunableSpec('spell.orb.range')?.max ?? 1, 'spell.zone.durationSeconds': tunableSpec('spell.zone.durationSeconds')?.max ?? 1 };
    applyTunables(slow);
    const spells = ['bolt[every 0.1s, -90% speed, +75% duration] nova', 'orb[every 0.1s, -90% speed, +75% duration] split(3) bolt[every 0.1s] nova', 'zone[every 0.1s, +75% duration] bolt'];
    for (const text of spells) compile(text);
    const started = Date.now();
    for (const text of spells) compile(text);
    // Several hundred ms before the pulse peak was walked in one pass.
    expect((Date.now() - started) / spells.length).toBeLessThan(15);
  });
});

