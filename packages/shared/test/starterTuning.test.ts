import { describe, expect, it } from 'vitest';
import {
  BEST_STARTER_PER_FORCE,
  compileSigilItem,
  createRune,
  createStarterSigil,
  DEFAULT_SERVER_SETTINGS,
  isServerMessage,
  isStarterDamage,
  parseSettingsPatch,
  parseStarterDamage,
  Simulation,
  STARTER_DAMAGE_PER_FORCE,
  STARTER_SIGILS,
  starterDamageEstimate,
  starterDamageFor,
  starterSigilById,
  storedStarterDamage,
  type SigilCompile,
  type SigilItem,
  type SpellProgram,
  type StarterDamage,
  type StarterSigilDef,
} from '../src/index.js';
import { distanceFor, measureStarter } from './harness/parity.js';
import { measureSkill, type SkillDpsResult } from './harness/skillDps.js';

declare const console: { log(message: string): void };

type SpellNode = SpellProgram['roots'][number];

function def(id: string): StarterSigilDef {
  const d = starterSigilById(id);
  if (!d) throw new Error(`no starter ${id}`);
  return d;
}

let uid = 1;
function sigil(id: string): SigilItem {
  return createStarterSigil(() => uid++, def(id), { bound: false });
}

function nodes(c: SigilCompile): SpellNode[] {
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('; '));
  const out: SpellNode[] = [];
  const visit = (n: SpellNode): void => {
    out.push(n);
    n.payload.forEach(visit);
  };
  c.program.roots.forEach(visit);
  return out;
}

function perForce(r: SkillDpsResult): { single: number; pack: number } {
  const spent = (r.forcePerCast ?? 0) * (r.casts ?? 0);
  return spent <= 0 ? { single: 0, pack: 0 } : { single: (r.single ?? 0) / spent, pack: (r.pack ?? 0) / spent };
}

/** A starter measured as the balance test measures it, compiled with a tuning table. */
function measureTuned(d: StarterSigilDef, table: StarterDamage): SkillDpsResult {
  const distance = distanceFor(d);
  return measureSkill({
    classId: d.classId,
    equip: (sim) => {
      const item = createStarterSigil(() => sim.newItemUid(), d, { bound: true });
      return { uid: item.uid, compiled: compileSigilItem(item, d.classId, table), misfireMultiplier: 1, castDelayShare: 1 };
    },
    ...(distance !== undefined ? { distance } : {}),
  });
}

describe('starter damage table', () => {
  it('accepts only starter ids in 0.5 to 3, and keeps it sparse', () => {
    expect(parseStarterDamage({ bone_spear: 1.5, smite: 1 })).toEqual({ bone_spear: 1.5 });
    expect(parseStarterDamage({ bone_spear: 0.5, fireball: 3 })).toEqual({ bone_spear: 0.5, fireball: 3 });
    expect(parseStarterDamage({})).toEqual({});
    for (const bad of [{ bone_spear: 0.49 }, { bone_spear: 3.01 }, { bone_spear: '1.5' }, { bone_spear: Number.NaN }, { bone_spear: null }]) expect(parseStarterDamage(bad), JSON.stringify(bad)).toMatch(/between 0.5 and 3/);
    expect(parseStarterDamage({ nova: 2 })).toMatch(/not a starter/);
    expect(parseStarterDamage({ __proto__: 2 })).toEqual({});
    expect(parseStarterDamage(JSON.parse('{"__proto__": 2}'))).toMatch(/not a starter/);
    for (const bad of [null, 2, 'bone_spear', [1.5]]) expect(parseStarterDamage(bad)).toMatch(/must be an object/);
  });

  it('goes through the settings patch, and a bad table refuses the whole patch', () => {
    expect(DEFAULT_SERVER_SETTINGS.starterDamage).toEqual({});
    expect(parseSettingsPatch({ starterDamage: { bone_spear: 2 } })).toEqual({ starterDamage: { bone_spear: 2 } });
    expect(parseSettingsPatch({ xpRate: 2, starterDamage: { bone_spear: 9 } })).toMatch(/starterDamage.bone_spear/);
  });

  it('a stored table keeps its good entries and drops the rest', () => {
    expect(storedStarterDamage(undefined)).toEqual({ table: {}, dropped: [] });
    expect(storedStarterDamage({ bone_spear: 1.5, gone_skill: 2, smite: 99, fireball: 1 })).toEqual({ table: { bone_spear: 1.5 }, dropped: ['gone_skill', 'smite'] });
    expect(storedStarterDamage('x')).toEqual({ table: {}, dropped: ['the whole table'] });
  });

  it('the client message is checked entry by entry', () => {
    expect(isStarterDamage({ bone_spear: 1.5 })).toBe(true);
    expect(isServerMessage({ t: 'starterDamage', damage: { bone_spear: 1.5 } })).toBe(true);
    expect(isServerMessage({ t: 'starterDamage', damage: { bone_spear: 30 } })).toBe(false);
    expect(isServerMessage({ t: 'starterDamage', damage: { nova: 2 } })).toBe(false);
    expect(isServerMessage({ t: 'starterDamage' })).toBe(false);
  });
});

describe('starter damage multiplier', () => {
  it('multiplies the damage of every shape in a whole starter, payloads included, and nothing else', () => {
    const fireball = sigil('fireball');
    const plain = nodes(compileSigilItem(fireball, 'mage'));
    const tuned = nodes(compileSigilItem(fireball, 'mage', { fireball: 1.5 }));
    expect(tuned.length).toBe(plain.length);
    expect(plain.length).toBeGreaterThan(1);
    tuned.forEach((n, i) => {
      const p = plain[i];
      if (!p) throw new Error('missing node');
      expect(n.tuning.damage).toBeCloseTo(p.tuning.damage * 1.5, 10);
      expect({ ...n.tuning, damage: 0 }).toEqual({ ...p.tuning, damage: 0 });
      expect(n.damageScale).toBe(p.damageScale);
    });
  });

  it('leaves heals and shields alone: they read damageScale, which it does not touch', () => {
    for (const id of ['holy_nova', 'sanctuary', 'prayer', 'iron_skin', 'soul_link']) {
      const s = sigil(id);
      const d = def(id);
      const plain = nodes(compileSigilItem(s, d.classId));
      const tuned = nodes(compileSigilItem(s, d.classId, { [id]: 3 }));
      tuned.forEach((n, i) => expect(n.damageScale).toBe(plain[i]?.damageScale));
    }
  });

  it('never reaches a starter with any rune changed, nor a player-made spell with the same runes', () => {
    const table = { bone_spear: 2 };
    const whole = sigil('bone_spear');
    expect(starterDamageFor(whole, table)).toBe(2);
    const first = whole.slots[0];
    if (!first) throw new Error('no rune');
    const reroll: SigilItem = { ...whole, slots: [{ ...first, affixes: first.affixes.map((a, i) => (i === 0 ? { ...a, value: a.value - 1 } : a)) }] };
    const extra: SigilItem = { ...whole, slots: [...whole.slots, createRune(uid++, 'lightning')] };
    const { starter: _starter, ...noStarter } = whole;
    const playerMade: SigilItem = noStarter;
    for (const s of [reroll, extra, playerMade]) {
      expect(starterDamageFor(s, table)).toBe(1);
      expect(compileSigilItem(s, 'binder', table)).toEqual(compileSigilItem(s, 'binder'));
    }
    // Another starter's entry does nothing to this one.
    expect(compileSigilItem(whole, 'binder', { smite: 3 })).toEqual(compileSigilItem(whole, 'binder'));
  });

  it('at the defaults compiles every starter exactly as before, so the balance tests are unchanged', () => {
    for (const d of STARTER_SIGILS) {
      const s = sigil(d.id);
      expect(compileSigilItem(s, d.classId, {})).toEqual(compileSigilItem(s, d.classId));
      expect(compileSigilItem(s, d.classId, { [d.id]: 1 })).toEqual(compileSigilItem(s, d.classId));
    }
  });

  it('reaches sigils already equipped when the rates change, and changes no item', () => {
    const sim = new Simulation(3, { kind: 'flat' });
    const pid = sim.addPlayer('c', 'binder', 'Binder');
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const slot = p.sigils.findIndex((eq) => eq !== null && p.items.get(eq.uid)?.kind === 'sigil' && p.items.get(eq.uid)?.name === 'Bone Spear');
    expect(slot).toBeGreaterThanOrEqual(0);
    const damageAt = (): number => {
      const eq = p.sigils[slot];
      return eq?.compiled.ok ? (eq.compiled.program.roots[0]?.tuning.damage ?? 0) : 0;
    };
    const before = damageAt();
    const items = JSON.stringify([...p.items.values()]);
    sim.setRates({ ...sim.rates, starterDamage: { bone_spear: 2 } });
    expect(damageAt()).toBeCloseTo(before * 2, 10);
    sim.setRates({ ...sim.rates, xp: 2 });
    expect(damageAt()).toBeCloseTo(before * 2, 10);
    sim.setRates({ ...sim.rates, starterDamage: {} });
    expect(damageAt()).toBeCloseTo(before, 10);
    expect(JSON.stringify([...p.items.values()])).toBe(items);
  });
});

describe('starter damage per Force estimate', () => {
  it('matches the balance harness at 1x for every damage-dealing starter', () => {
    const measured: string[] = [];
    let drift = false;
    for (const d of STARTER_SIGILS) {
      const r = measureStarter(d);
      const listed = STARTER_DAMAGE_PER_FORCE[d.id];
      if (r.kind !== 'damage') {
        if (listed) drift = true;
        continue;
      }
      const pf = perForce(r);
      measured.push(`  ${d.id}: { single: ${pf.single.toFixed(3)}, pack: ${pf.pack.toFixed(3)} },`);
      if (!listed || Math.abs(listed.single - pf.single) > 0.002 || Math.abs(listed.pack - pf.pack) > 0.002) drift = true;
    }
    if (drift) console.log(`\nSTARTER_DAMAGE_PER_FORCE is out of date; measured:\n${measured.join('\n')}\n`);
    expect(drift).toBe(false);
  }, 60_000);

  it('scales with the multiplier, as the admin page assumes (Bone Spear at 1.5x and 2x)', () => {
    const base = STARTER_DAMAGE_PER_FORCE.bone_spear;
    if (!base) throw new Error('bone_spear missing');
    for (const m of [1.5, 2]) {
      const pf = perForce(measureTuned(def('bone_spear'), { bone_spear: m }));
      expect(pf.single).toBeCloseTo(base.single * m, 2);
      expect(pf.pack).toBeCloseTo(base.pack * m, 2);
      const est = starterDamageEstimate('bone_spear', m);
      console.log(`bone_spear at ${m}x: measured ${pf.single.toFixed(2)} / ${pf.pack.toFixed(2)} per Force, estimate ${est?.single.toFixed(2)} / ${est?.pack.toFixed(2)}, ${est?.ofBest.toFixed(2)}x best`);
    }
  }, 60_000);

  it('rates a starter against the best starter at the defaults', () => {
    expect(BEST_STARTER_PER_FORCE.single).toBe(STARTER_DAMAGE_PER_FORCE.freezing_arrow?.single);
    expect(BEST_STARTER_PER_FORCE.pack).toBe(STARTER_DAMAGE_PER_FORCE.exploding_arrow?.pack);
    expect(starterDamageEstimate('freezing_arrow', 1)?.ofBest).toBe(1);
    expect(starterDamageEstimate('freezing_arrow', 2.5)?.ofBest).toBe(2.5);
    expect(starterDamageEstimate('bone_spear', 1)?.ofBest).toBeCloseTo(1.395 / 2.127, 5);
    expect(starterDamageEstimate('holy_nova', 2)).toBeNull();
  });
});
