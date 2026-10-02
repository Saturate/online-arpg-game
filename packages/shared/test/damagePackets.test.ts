import { afterEach, describe, expect, it } from 'vitest';
import {
  AFFIXES,
  applyTunables,
  AURA,
  compileRunes,
  createRolledRune,
  DEFAULT_SIGIL_CONTEXT,
  describeTree,
  formatAffix,
  formatRunes,
  hitRanges,
  noAdded,
  packetTotal,
  parseSpellText,
  programDamage,
  resetTunables,
  Rng,
  rollHit,
  runeItemFromInstance,
  shapeBaseRange,
  SIM,
  SKILL_BUTTONS,
  Simulation,
  SPELL,
  tokenizeSpell,
  toRuneInstance,
  tunableSetProblem,
  type DamagePacket,
  type EntityId,
} from '../src/index.js';
import { applyPoison, dealDamage, type DamageRecord } from '../src/sim/combat.js';
import { packetOf } from '../src/sim/damage.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { compileText } from './helpers/spell.js';

/** The single number each shape dealt per hit before damage packets. */
const OLD_BASE = { bolt: 16, orb: 16, nova: 14, zone: 14, dash: 12 } as const;

/** Every shape's range pinned to its old number, so a hit is exactly what it was. */
const FLAT = Object.fromEntries(Object.entries(OLD_BASE).flatMap(([shape, v]) => [[`spell.${shape}.damageMin`, v], [`spell.${shape}.damageMax`, v]]));

afterEach(() => resetTunables());

interface Cast {
  sim: Simulation;
  pid: EntityId;
  dummy: EntityId;
  hits: DamageRecord[];
}

/** Casts `text` once at a pinned dummy and records every hit the sim deals. */
function castAt(text: string, opts: { ticks?: number; seed?: number; distance?: number; classId?: 'mage' | 'ranger' | 'warrior' } = {}): Cast {
  const sim = new Simulation(opts.seed ?? 11, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('p', opts.classId ?? 'mage');
  const p = sim.world.player.get(pid);
  const pos = sim.world.position.get(pid);
  if (!p || !pos) throw new Error('setup');
  p.god = true;
  p.warband = p.warband.map(() => null);
  // Class damage stats aside, so a hit is the spell's own numbers.
  p.stats.damageMult = 1;
  p.sigils = [{ uid: -1, compiled: compileText(text), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
  const at = { x: pos.x + (opts.distance ?? 120), y: pos.y };
  const dummy = sim.spawnEnemy('chaser', at.x, at.y);
  const hits: DamageRecord[] = [];
  sim.damageTap = (h) => hits.push(h);
  for (let i = 0; i < (opts.ticks ?? 60); i++) {
    p.heat = 0;
    sim.applyInput(pid, { seq: i + 1, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: i === 0 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
    sim.waveTimer = Infinity;
    sim.step();
    const h = sim.world.health.get(dummy);
    const e = sim.world.enemy.get(dummy);
    const dp = sim.world.position.get(dummy);
    if (h) h.life = h.maxLife;
    if (e) e.speedMult = 0;
    if (dp) Object.assign(dp, at);
  }
  return { sim, pid, dummy, hits };
}

const onDummy = (c: Cast, quiet = false): DamageRecord[] => c.hits.filter((h) => h.targetId === c.dummy && h.sourceId === c.pid && h.quiet === quiet);

function only(p: Readonly<DamagePacket>): string[] {
  return (Object.keys(p) as (keyof DamagePacket)[]).filter((k) => p[k] > 0);
}

describe('damage packets at defaults', () => {
  it('every shape range averages the number it dealt before, so balance holds', () => {
    for (const [shape, v] of Object.entries(OLD_BASE)) {
      const form = shape === 'bolt' || shape === 'orb' || shape === 'nova' || shape === 'zone' || shape === 'dash' ? shape : 'bolt';
      const r = shapeBaseRange(form);
      expect(r && (r.min + r.max) / 2, shape).toBe(v);
      expect(r && r.max > r.min, `${shape} rolls a range`).toBe(true);
    }
    expect(shapeBaseRange('aura')).toBeNull();
  });

  it('a hit deals exactly the old total when the range is pinned, in physical, fire or split between infusions', () => {
    applyTunables(FLAT);
    const plain = onDummy(castAt('bolt'));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain[0]?.packet).toEqual(packetOf('physical', 16));
    const fire = onDummy(castAt('bolt fire'));
    expect(fire[0]?.packet).toEqual(packetOf('fire', 16));
    // Frostfire: one roll, half to each, then its +25% on the whole packet.
    const both = onDummy(castAt('bolt fire cold'))[0]?.packet;
    expect(both?.fire).toBeCloseTo(8 * (1 + SPELL.comboDamageBonus), 9);
    expect(both?.cold).toBeCloseTo(8 * (1 + SPELL.comboDamageBonus), 9);
    expect(both && packetTotal(both)).toBeCloseTo(16 * (1 + SPELL.comboDamageBonus), 9);
    const nova = onDummy(castAt('nova lightning', { distance: 40 }))[0]?.packet;
    expect(nova).toEqual(packetOf('lightning', 14));
  });

  it('the average hit over many rolls is the old number', () => {
    const rng = Rng.stream(3, 'damage');
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += packetTotal(rollHit(rng, { min: 12, max: 20 }, ['fire'], noAdded()));
    expect(sum / n).toBeCloseTo(16, 1);
  });
});

describe('conversion and added damage', () => {
  it('infusions convert the base in equal shares; added damage converts nothing', () => {
    const base = { min: 12, max: 20 };
    const added = noAdded();
    added.fire = { min: 4, max: 8 };
    expect(hitRanges(base, [], added)).toMatchObject({ physical: { min: 12, max: 20 }, fire: { min: 4, max: 8 }, cold: { min: 0, max: 0 } });
    expect(hitRanges(base, ['fire'], added)).toMatchObject({ physical: { min: 0, max: 0 }, fire: { min: 16, max: 28 } });
    expect(hitRanges(base, ['cold', 'lightning'], added)).toMatchObject({ physical: { min: 0, max: 0 }, cold: { min: 6, max: 10 }, lightning: { min: 6, max: 10 }, fire: { min: 4, max: 8 } });
  });

  it('a bolt with added fire hits for its physical roll plus 4 to 8 fire, and does not burn', () => {
    applyTunables(FLAT);
    const c = castAt('bolt[adds 4 fire]');
    const hit = onDummy(c)[0]?.packet;
    expect(hit?.physical).toBe(16);
    expect(hit?.fire).toBeGreaterThanOrEqual(4);
    expect(hit?.fire).toBeLessThanOrEqual(8);
    expect(c.sim.world.status.get(c.dummy)?.burn).toBeNull();
    // With Fire as well, the base turns to fire and the added fire joins it; now it burns.
    const infused = castAt('bolt[adds 4 fire] fire');
    const h2 = onDummy(infused)[0]?.packet;
    expect(h2 && only(h2)).toEqual(['fire']);
    expect(h2?.fire).toBeGreaterThanOrEqual(20);
    expect(infused.sim.world.status.get(infused.dummy)?.burn).not.toBeNull();
  });

  it('every multiplier scales the added damage with the rest: the damage roll, Concentrated, Splits', () => {
    applyTunables(FLAT);
    const plain = onDummy(castAt('bolt[adds 4 lightning]'))[0]?.packet;
    const doubled = onDummy(castAt('nova[adds 4 lightning] concentrated(50)', { distance: 40 }))[0]?.packet;
    expect(plain?.lightning).toBeGreaterThan(0);
    expect(doubled?.physical).toBeCloseTo(14 * 1.5, 9);
    expect(doubled?.lightning).toBeGreaterThanOrEqual(4 * 1.5);
    expect(doubled?.lightning).toBeLessThanOrEqual(8 * 1.5 + 1e-9);
  });

  it('reads and writes "adds X to Y" in the text form, the high end fixed at twice the low', () => {
    const t = tokenizeSpell('bolt[adds 4 to 8 fire] nova[add 3 cold]');
    expect(t.errors).toEqual([]);
    expect(t.runes[0]?.affixes.addedFire).toBe(4);
    expect(t.runes[1]?.affixes.addedCold).toBe(3);
    expect(formatRunes(t.runes)).toBe('bolt[adds 4 to 8 fire] nova[adds 3 to 6 cold]');
    expect(tokenizeSpell('bolt[adds 4 to 9 fire]').errors[0]?.rule).toBe('unknown-affix');
  });

  it('a shape takes one damage affix: a damage roll or one added element; persistent shapes take none', () => {
    expect(parseSpellText('bolt[adds 4 fire, adds 4 cold]').errors[0]?.rule).toBe('affix-not-allowed');
    expect(parseSpellText('bolt[adds 4 fire, +20% damage]').errors[0]?.rule).toBe('affix-not-allowed');
    expect(parseSpellText('aura[adds 4 fire] fire').errors[0]?.rule).toBe('affix-not-allowed');
    expect(parseSpellText('bolt[adds 4 fire] split(2)').ok).toBe(true);
    // On a shape that deals no damage it does nothing, and the forge says so.
    const heal = compileText('nova[adds 4 fire] restore');
    expect(heal.ok && heal.notes.some((n) => n.includes('added damage does nothing'))).toBe(true);
  });

  it('is priced like the damage roll it equals on that shape', () => {
    const force = (text: string): number => {
      const r = compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage' });
      return r.force;
    };
    // Adds 4 to 8 averages 6: on a Bolt's 16 that is +37.5% damage, on a Nova's 14 about +42.9%.
    expect(force('bolt[adds 4 fire]')).toBeCloseTo(force('bolt[+37.5% damage]'), 5);
    expect(force('nova[adds 4 cold]')).toBeCloseTo(force(`nova[+${(600 / 14).toFixed(6)}% damage]`), 1);
    expect(force('bolt[adds 9 fire]')).toBeGreaterThan(force('bolt[adds 1 fire]'));
  });
});

describe('the affixes', () => {
  it('have six tiers, T1 best and rare, on every non-persistent castable shape, sharing the damage roll slot', () => {
    for (const id of ['rune_added_fire', 'rune_added_cold', 'rune_added_lightning'] as const) {
      const def = AFFIXES[id];
      expect(def.tiers).toHaveLength(6);
      expect(def.group).toBe(AFFIXES.rune_damage.group);
      expect(def.runes).toEqual(AFFIXES.rune_damage.runes);
      expect(def.tiers[5]?.weight).toBeLessThan(def.tiers[0]?.weight ?? 0);
      for (let t = 1; t < 6; t++) expect(def.tiers[t]?.min).toBeGreaterThanOrEqual(def.tiers[t - 1]?.max ?? Infinity);
    }
    expect(formatAffix({ id: 'rune_added_cold', tier: 2, value: 4 })).toBe('Adds 4 to 8 cold damage');
  });

  it('drop on shape runes, never beside a damage roll, and read back as the grammar sets them', () => {
    const rng = new Rng(99);
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const r = createRolledRune(i, rng, 'relic', 30, 'bolt');
      const ids = r.affixes.map((a) => a.id);
      const damageSlot = ids.filter((id) => id === 'rune_damage' || id.startsWith('rune_added_'));
      expect(damageSlot.length).toBeLessThanOrEqual(1);
      for (const a of r.affixes) if (a.id.startsWith('rune_added_')) seen.add(a.id);
      const inst = toRuneInstance(r);
      const text = formatRunes([inst]);
      const back = tokenizeSpell(text);
      expect(back.errors, text).toEqual([]);
      expect(back.runes[0], text).toEqual(inst);
    }
    expect(seen).toEqual(new Set(['rune_added_fire', 'rune_added_cold', 'rune_added_lightning']));
    const item = runeItemFromInstance(1, { id: 'orb', affixes: { addedLightning: 7 } }, false);
    expect(item.affixes).toEqual([{ id: 'rune_added_lightning', tier: 5, value: 7 }]);
  });
});

describe('per-hit rolls', () => {
  it('are the same for the same seed and casts, and vary inside the range', () => {
    const a = onDummy(castAt('orb[every 0.2s] cold split(3) bolt', { ticks: 80 })).map((h) => h.packet);
    const b = onDummy(castAt('orb[every 0.2s] cold split(3) bolt', { ticks: 80 })).map((h) => h.packet);
    expect(a.length).toBeGreaterThan(3);
    expect(a).toEqual(b);
    const totals = onDummy(castAt('bolt', { ticks: 10 }));
    const many: number[] = [];
    for (let seed = 1; seed < 30; seed++) {
      const hit = onDummy(castAt('bolt', { seed, ticks: 10 }))[0];
      if (hit) many.push(packetTotal(hit.packet));
    }
    expect(totals.length).toBeGreaterThan(0);
    expect(Math.min(...many)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...many)).toBeLessThanOrEqual(20);
    expect(new Set(many.map((v) => v.toFixed(3))).size).toBeGreaterThan(10);
  });

  it('come from their own stream, so a combat roll after them is the same with or without the range', () => {
    const ranged = castAt('nova fire', { distance: 40 });
    applyTunables(FLAT);
    const flat = castAt('nova fire', { distance: 40 });
    expect(ranged.sim.rand.combat.next()).toBe(flat.sim.rand.combat.next());
    expect(ranged.sim.rand.loot.next()).toBe(flat.sim.rand.loot.next());
  });

  it('tuning refuses a lowest base damage above the highest', () => {
    expect(tunableSetProblem({ 'spell.bolt.damageMin': 25 })).toMatch(/Bolt: its lowest base damage 25 is above its highest 20/);
    expect(tunableSetProblem({ 'spell.bolt.damageMin': 20 })).toBeNull();
  });
});

/** A sim with one player and a recorder of every hit. */
function world(classId: 'warrior' | 'binder' = 'warrior') {
  const sim = new Simulation(7, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('c', classId);
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no player');
  const hits: DamageRecord[] = [];
  sim.damageTap = (h) => hits.push(h);
  const steps = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * SIM.tickRate); i++) {
      sim.waveTimer = Infinity;
      sim.step();
    }
  };
  return { sim, pid, pos, hits, steps };
}

describe('every damage path carries a packet', () => {
  it('monster contact is physical; an elemental monster keeps its element and its ailment', () => {
    const { sim, pid, pos, hits, steps } = world();
    const brute = spawnEnemy(sim, 'chaser', pos.x + 20, pos.y, { rare: false, level: 1, aggro: true });
    steps(2);
    const bites = hits.filter((h) => h.sourceId === brute && h.targetId === pid);
    expect(bites.length).toBeGreaterThan(0);
    for (const b of bites) expect(only(b.packet)).toEqual(['physical']);

    const cold = world();
    const slime = spawnEnemy(cold.sim, 'frost_slime', cold.pos.x + 20, cold.pos.y, { rare: false, level: 1, aggro: true });
    cold.steps(3);
    const touches = cold.hits.filter((h) => h.sourceId === slime && h.targetId === cold.pid);
    expect(touches.length).toBeGreaterThan(0);
    for (const t of touches) expect(only(t.packet)).toEqual(['cold']);
    expect(cold.sim.world.status.get(cold.pid)?.chill).toBeGreaterThan(0);
  });

  it('the death burst and the hazard it leaves deal their element', () => {
    const { sim, pid, pos, hits, steps } = world();
    const slime = spawnEnemy(sim, 'fire_slime', pos.x + 30, pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(sim, slime, packetOf('physical', 1e6), pid);
    steps(1);
    const fromSlime = hits.filter((h) => h.sourceId === slime && h.targetId === pid);
    expect(fromSlime.some((h) => !h.quiet && only(h.packet).join() === 'fire')).toBe(true);
    // The burning ground ticks after the burst, also fire.
    expect(fromSlime.filter((h) => only(h.packet).join() === 'fire').length).toBeGreaterThan(1);

    const frost = world();
    const fs = spawnEnemy(frost.sim, 'frost_slime', frost.pos.x + 30, frost.pos.y, { rare: false, level: 1, aggro: false });
    dealDamage(frost.sim, fs, packetOf('physical', 1e6), frost.pid);
    frost.steps(1);
    const frostHits = frost.hits.filter((h) => h.sourceId === fs && h.targetId === frost.pid);
    expect(frostHits.length).toBeGreaterThan(1);
    for (const h of frostHits) expect(only(h.packet)).toEqual(['cold']);
  });

  it('a minion bite is physical, its poison ticks are poison, and a burn ticks fire', () => {
    const { sim, pid, pos, hits, steps } = world('binder');
    sim.step();
    const minion = sim.world.player.get(pid)?.minions.find((m) => m !== null);
    if (minion === null || minion === undefined) throw new Error('no minion');
    const mpos = sim.world.position.get(minion);
    if (!mpos) throw new Error('no minion position');
    const target = spawnEnemy(sim, 'chaser', mpos.x + 30, mpos.y, { rare: false, level: 1, aggro: false });
    const th = sim.world.health.get(target);
    if (th) th.life = th.maxLife = 1e6;
    steps(4);
    const bites = hits.filter((h) => h.sourceId === minion && h.targetId === target);
    expect(bites.length).toBeGreaterThan(0);
    for (const b of bites) expect(only(b.packet)).toEqual(['physical']);

    applyPoison(sim, target, 50, pid);
    const st = sim.world.status.get(target);
    if (!st) throw new Error('no status');
    st.burn = { dps: 10, t: 1, sourceId: pid };
    hits.length = 0;
    steps(0.5);
    const ticks = hits.filter((h) => h.targetId === target && h.sourceId === pid && h.quiet);
    expect(ticks.some((h) => only(h.packet).join() === 'poison')).toBe(true);
    expect(ticks.some((h) => only(h.packet).join() === 'fire')).toBe(true);
  });

  it('an elemental aura ticks its element', () => {
    const { sim, pid, pos, hits, steps } = world();
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    p.sigils = [{ uid: -1, compiled: compileText('aura cold lightning'), misfireMultiplier: 1, castDelayShare: 1 }, null, null, null];
    const target = spawnEnemy(sim, 'chaser', pos.x + 60, pos.y, { rare: false, level: 1, aggro: false });
    const e = sim.world.enemy.get(target);
    if (e) e.speedMult = 0;
    steps(0.5);
    const ticks = hits.filter((h) => h.targetId === target && h.quiet);
    expect(new Set(ticks.map((h) => only(h.packet).join()))).toEqual(new Set(['cold', 'lightning']));
    for (const t of ticks) expect(packetTotal(t.packet)).toBeCloseTo(AURA.elementDps * SIM.dt, 9);
  });

  it('a reflected spell keeps its mix of types, capped on the total', () => {
    const c = castAt('bolt[adds 9 lightning] fire', { ticks: 2 });
    const e = c.sim.world.enemy.get(c.dummy);
    if (!e) throw new Error('no dummy');
    e.reflectChance = 1;
    const p = c.sim.world.player.get(c.pid);
    if (!p) throw new Error('no player');
    p.god = false;
    for (let i = 0; i < 60; i++) {
      p.heat = 0;
      c.sim.applyInput(c.pid, { seq: 100 + i, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: i % 12 === 0 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
      c.sim.waveTimer = Infinity;
      c.sim.step();
    }
    // The hits themselves, not the burn they leave (which ticks fire alone).
    const back = c.hits.filter((h) => h.sourceId === c.dummy && h.targetId === c.pid && !h.quiet);
    expect(back.length).toBeGreaterThan(0);
    for (const h of back) {
      expect(only(h.packet)).toEqual(['fire', 'lightning']);
      expect(packetTotal(h.packet)).toBeLessThanOrEqual(12 + 1e-9);
    }
  });

  it("a minion's death explosion deals fire", () => {
    const { sim, pid, hits } = world('binder');
    sim.step();
    const minion = sim.world.player.get(pid)?.minions.find((m) => m !== null);
    if (minion === null || minion === undefined) throw new Error('no minion');
    const m = sim.world.minion.get(minion);
    const mpos = sim.world.position.get(minion);
    if (!m || !mpos) throw new Error('no minion');
    m.affixes = [...m.affixes, { id: 'explodes_on_death', tier: 0, value: 100 }];
    const near = spawnEnemy(sim, 'chaser', mpos.x + 20, mpos.y, { rare: false, level: 1, aggro: false });
    const nh = sim.world.health.get(near);
    if (nh) nh.life = nh.maxLife = 1e6;
    dealDamage(sim, minion, packetOf('physical', 1e9), near);
    const blast = hits.filter((h) => h.sourceId === minion && h.targetId === near);
    expect(blast).toHaveLength(1);
    expect(only(blast[0]?.packet ?? packetOf('physical', 0))).toEqual(['fire']);
  });
});

describe('tooltips and the sentence', () => {
  it('the sentence says what each shape deals, by type', () => {
    const r = parseSpellText('orb[onhit] fire nova zone');
    expect(r.ok).toBe(false);
    const fireball = parseSpellText('orb[onhit] fire nova');
    if (!fireball.tree) throw new Error('no tree');
    expect(describeTree(fireball.tree)).toBe('Fires a fire orb. Deals 12 to 20 fire damage. On hit it releases a nova. The nova deals 10 to 18 fire damage.');
    const added = parseSpellText('bolt[adds 4 fire]');
    if (!added.tree) throw new Error('no tree');
    expect(describeTree(added.tree)).toBe('Fires a bolt. Deals 12 to 20 physical and 4 to 8 fire damage.');
    const zone = parseSpellText('zone cold');
    if (!zone.tree) throw new Error('no tree');
    expect(describeTree(zone.tree)).toBe('Places a cold zone. Deals 10 to 18 cold damage every 0.5 s.');
    const heal = parseSpellText('nova restore');
    if (!heal.tree) throw new Error('no tree');
    expect(describeTree(heal.tree)).not.toContain('Deals');
  });

  it('a tuned range shows at once', () => {
    applyTunables({ 'spell.bolt.damageMin': 8, 'spell.bolt.damageMax': 14 });
    const r = parseSpellText('bolt lightning');
    if (!r.tree) throw new Error('no tree');
    expect(describeTree(r.tree)).toContain('Deals 8 to 14 lightning damage.');
  });

  it("the compiled spell's damage lines carry the sigil's numbers, per type, with copies and cadence", () => {
    const compiled = compileRunes(tokenizeSpell('orb[every 0.2s] cold split(3) bolt[adds 2 lightning]').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage', damageMultiplier: 2 });
    if (!compiled.ok) throw new Error('no compile');
    const lines = programDamage(compiled.program);
    expect(lines.map((l) => [l.form, l.copies, l.depth])).toEqual([
      ['orb', 1, 0],
      ['bolt', 3, 1],
    ]);
    expect(lines[0]?.parts).toEqual([{ type: 'cold', min: 24, max: 40 }]);
    // Split(3) keeps 1.2 / 3 of the damage per copy; the added lightning splits with it.
    expect(lines[1]?.parts.map((p) => p.type)).toEqual(['cold', 'lightning']);
    expect(lines[1]?.parts[1]?.min).toBeCloseTo(2 * 0.4 * 2, 9);
    const aura = compileText('aura fire');
    expect(aura.ok && programDamage(aura.program)[0]).toMatchObject({ cadence: { per: 'second' }, parts: [{ type: 'fire', min: AURA.elementDps, max: AURA.elementDps }] });
    const zone = compileText('zone[+50% speed] fire');
    expect(zone.ok && programDamage(zone.program)[0]?.cadence).toEqual({ per: 'tick', seconds: SPELL.zone.tickSeconds / 1.5 });
  });
});
