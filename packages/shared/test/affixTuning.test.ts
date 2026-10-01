import { afterEach, describe, expect, it } from 'vitest';
import { addItem } from '../src/sim/inventory.js';
import {
  AFFIX_IDS,
  AFFIXES,
  affixTierLabel,
  affixTierPath,
  applyTunables,
  activeTunables,
  buyPrice,
  clampRoll,
  clampRuneRolls,
  codeAffixTiers,
  compileSigilItem,
  createRolledRune,
  createSigil,
  createStarterSigil,
  FORGE,
  forgeInsertPrice,
  parseTunablePatch,
  parseTunableValues,
  resetTunables,
  Rng,
  rollLosses,
  RUNE_AFFIX_TIERS,
  sellPrice,
  Simulation,
  sixTierRoll,
  STARTER_SIGILS,
  starterSigilById,
  TUNABLES,
  TUNING_CATEGORIES,
  TUNING_CATEGORY_NAMES,
  tunableSetProblem,
  tunableSpec,
  type AffixId,
  type AffixRoll,
  type RuneItem,
  type TunableValues,
} from '../src/index.js';

afterEach(() => resetTunables());

const NUMBER_RUNE_AFFIXES: readonly AffixId[] = ['rune_speed', 'rune_size', 'rune_duration', 'rune_damage', 'rune_pierce', 'split_count', 'rune_concentrated', 'release_every'];
const SIGIL_AFFIXES = AFFIX_IDS.filter((id) => AFFIXES[id].targets.includes('sigil'));

function rolledRunes(seed: number, n: number, ilvl = 30): RuneItem[] {
  const rng = new Rng(seed);
  const out: RuneItem[] = [];
  for (let i = 0; i < n; i++) out.push(createRolledRune(i + 1, rng, (['magic', 'rare', 'relic'] as const)[i % 3] ?? 'rare', ilvl));
  return out.filter((r) => r.affixes.length > 0);
}

describe('rune affix tiers', () => {
  it('number rune affixes have six tiers, from T6 (weakest, index 0) to T1 (best), labelled from the best', () => {
    for (const id of NUMBER_RUNE_AFFIXES) {
      expect(AFFIXES[id].tiers, id).toHaveLength(RUNE_AFFIX_TIERS);
      expect(affixTierLabel(id, 0)).toBe('T6');
      expect(affixTierLabel(id, 5)).toBe('T1');
    }
    // Sigil affixes keep three tiers, numbered the same way: the best is T1.
    expect(AFFIXES.damage_increased.tiers).toHaveLength(3);
    expect(affixTierLabel('damage_increased', 2)).toBe('T1');
    expect(affixTierLabel('release_onhit', 0)).toBe('T1');
  });

  it('T6 to T2 cover the old three tiers from low to high, and T1 sits above them', () => {
    const old: Record<string, [number, number]> = { rune_speed: [10, 50], rune_size: [10, 50], rune_duration: [15, 75], rune_damage: [10, 55], rune_pierce: [1, 3], split_count: [2, 6], rune_concentrated: [40, 60] };
    for (const [id, [lo, hi]] of Object.entries(old)) {
      if (!(AFFIX_IDS as readonly string[]).includes(id)) throw new Error(id);
      const tiers = AFFIXES[id as AffixId].tiers;
      expect(tiers[0]?.min, id).toBe(lo);
      expect(tiers[4]?.max, id).toBe(hi);
      // Split and Concentrated stop at the grammar's limit, so their T1 is T2's best.
      expect(tiers[5]?.max ?? 0, id).toBeGreaterThanOrEqual(hi);
    }
    expect(AFFIXES.release_every.tiers[0]?.max).toBe(0.6);
    expect(AFFIXES.release_every.tiers[4]?.min).toBe(0.2);
    expect(AFFIXES.release_every.tiers[5]?.min).toBeLessThan(0.2);
  });

  it('roll by item level: T6 only at level 1, T1 not before level 12, and common and magic stop at T4', () => {
    const tiers = (ilvl: number, tier: 'magic' | 'relic'): number[] => {
      const rng = new Rng(ilvl * 7);
      const seen = new Set<number>();
      for (let i = 0; i < 1500; i++) for (const a of createRolledRune(i, rng, tier, ilvl).affixes) if (NUMBER_RUNE_AFFIXES.includes(a.id)) seen.add(a.tier);
      return [...seen].sort();
    };
    expect(tiers(1, 'relic')).toEqual([0]);
    expect(tiers(11, 'relic')).toEqual([0, 1, 2, 3, 4]);
    expect(tiers(20, 'relic')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(tiers(20, 'magic')).toEqual([0, 1, 2]);
  });

  it('every drop roll lies inside the tier it carries', () => {
    for (const r of rolledRunes(5, 3000)) {
      for (const a of r.affixes) {
        const t = AFFIXES[a.id].tiers[a.tier];
        expect(t && a.value >= t.min && a.value <= t.max, `${a.id} ${a.tier} ${a.value}`).toBe(true);
      }
    }
  });
});

describe('re-tiering old saves to six tiers', () => {
  /** The three tiers every number rune affix had before 2026-10-01, and their sell values. */
  const OLD: Record<string, [number, number][]> = {
    rune_speed: [[10, 20], [20, 35], [35, 50]],
    rune_size: [[10, 20], [20, 35], [35, 50]],
    rune_duration: [[15, 30], [30, 50], [50, 75]],
    rune_damage: [[10, 20], [20, 35], [35, 55]],
    rune_pierce: [[1, 1], [1, 2], [2, 3]],
    split_count: [[2, 3], [3, 4], [5, 6]],
    rune_concentrated: [[40, 46], [47, 53], [54, 60]],
    release_every: [[0.4, 0.6], [0.3, 0.45], [0.2, 0.3]],
  };
  const OLD_VALUE = [4, 10, 25];

  it('moves each roll to the tier its value falls in, never changing the value', () => {
    expect(sixTierRoll({ id: 'rune_damage', tier: 2, value: 50 })).toEqual({ id: 'rune_damage', tier: 4, value: 50 });
    expect(sixTierRoll({ id: 'rune_damage', tier: 0, value: 15 })).toEqual({ id: 'rune_damage', tier: 0, value: 15 });
    expect(sixTierRoll({ id: 'rune_damage', tier: 1, value: 20 })).toEqual({ id: 'rune_damage', tier: 1, value: 20 });
    // Old kit rolls past every table land in T1.
    expect(sixTierRoll({ id: 'rune_damage', tier: 2, value: 300 })).toEqual({ id: 'rune_damage', tier: 5, value: 300 });
    expect(sixTierRoll({ id: 'release_every', tier: 2, value: 0.18 })).toEqual({ id: 'release_every', tier: 5, value: 0.18 });
    expect(sixTierRoll({ id: 'release_every', tier: 0, value: 0.6 })).toEqual({ id: 'release_every', tier: 0, value: 0.6 });
    // Drawbacks stay at the bottom; sigil affixes and release flags keep their tiers.
    expect(sixTierRoll({ id: 'rune_speed', tier: 0, value: -35 }).tier).toBe(0);
    const sigil: AffixRoll = { id: 'damage_increased', tier: 2, value: 40 };
    expect(sixTierRoll(sigil)).toBe(sigil);
    const flag: AffixRoll = { id: 'release_onhit', tier: 0, value: 1 };
    expect(sixTierRoll(flag)).toBe(flag);
  });

  it('reads the code tables, not a tuned one', () => {
    applyTunables({ [affixTierPath('rune_damage', 5, 'max')]: 400, [affixTierPath('rune_damage', 4, 'max')]: 300 });
    expect(sixTierRoll({ id: 'rune_damage', tier: 2, value: 200 }).tier).toBe(5);
    expect(sixTierRoll({ id: 'rune_damage', tier: 2, value: 50 }).tier).toBe(4);
  });

  it('never makes an old roll worth more than the trader asked for it (buy at 3x), so re-tiering cannot be farmed', () => {
    let checked = 0;
    for (const [id, tiers] of Object.entries(OLD)) {
      if (!(AFFIX_IDS as readonly string[]).includes(id)) throw new Error(id);
      const affix = id as AffixId;
      const decimals = AFFIXES[affix].decimals ?? 0;
      tiers.forEach(([lo, hi], tier) => {
        const step = 10 ** -decimals;
        for (let v = lo; v <= hi + step / 2; v += step) {
          const value = Number(v.toFixed(decimals));
          const after = sixTierRoll({ id: affix, tier, value });
          const before = OLD_VALUE[tier] ?? 0;
          const now = FORGE.runeAffixValue[after.tier] ?? 0;
          expect(now, `${id} ${value} old T${tier + 1}`).toBeLessThan(before * 3);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('affix ranges in live tuning', () => {
  it('list every rune affix tier under Rune balance and every sigil affix tier under Sigil balance, at their code values', () => {
    for (const id of NUMBER_RUNE_AFFIXES) {
      AFFIXES[id].tiers.forEach((t, tier) => {
        for (const key of ['min', 'max', 'weight', 'ilvl'] as const) {
          const spec = tunableSpec(affixTierPath(id, tier, key));
          expect(spec?.category, `${id} ${tier} ${key}`).toBe('runes');
          expect(spec?.default).toBe(t[key]);
        }
      });
    }
    expect(tunableSpec(affixTierPath('release_after', 0, 'max'))?.category).toBe('runes');
    expect(tunableSpec('affix.release_onhit.t1.min')).toBeUndefined();
    for (const id of SIGIL_AFFIXES) {
      AFFIXES[id].tiers.forEach((t, tier) => {
        expect(tunableSpec(affixTierPath(id, tier, 'min'))?.category, id).toBe('sigils');
        expect(tunableSpec(affixTierPath(id, tier, 'max'))?.default).toBe(t.max);
        expect(tunableSpec(affixTierPath(id, tier, 'weight'))).toBeUndefined();
      });
    }
    expect(affixTierPath('rune_damage', 5, 'max')).toBe('affix.rune_damage.t1.max');
    expect(TUNABLES.some((t) => t.path.startsWith('starter.'))).toBe(false);
  });

  it('order the Tuning tab: Rune balance, Sigil balance, Force prices, Spirit prices, Base shapes, then the rest', () => {
    expect(TUNING_CATEGORIES.slice(0, 5).map((c) => TUNING_CATEGORY_NAMES[c])).toEqual(['Rune balance', 'Sigil balance', 'Force prices', 'Spirit prices', 'Base shapes']);
  });

  it('keep each number inside engine limits', () => {
    expect(parseTunablePatch({ [affixTierPath('split_count', 5, 'max')]: 7 })).toMatch(/must be 2 to 6/);
    expect(parseTunablePatch({ [affixTierPath('rune_concentrated', 5, 'max')]: 61 })).toMatch(/must be 40 to 60/);
    expect(parseTunablePatch({ [affixTierPath('release_every', 5, 'min')]: 0.05 })).toMatch(/must be 0.1 to/);
    expect(parseTunablePatch({ [affixTierPath('rune_pierce', 5, 'max')]: 4.5 })).toMatch(/whole number/);
    expect(parseTunablePatch({ [affixTierPath('heat_reduced', 2, 'max')]: 95 })).toMatch(/must be 0 to 90/);
    expect(parseTunablePatch({ [affixTierPath('rune_damage', 0, 'ilvl')]: 0 })).toMatch(/must be 1 to/);
    expect(parseTunablePatch({ 'starter.bone_spear.0.damage': 140 })).toMatch(/Unknown tunable/);
  });

  it('refuse a set whose tiers are reversed, overlap, run backwards or unlock out of order', () => {
    expect(tunableSetProblem({})).toBeNull();
    const dmg = (tier: number, key: 'min' | 'max' | 'ilvl'): string => affixTierPath('rune_damage', tier, key);
    expect(tunableSetProblem({ [dmg(0, 'min')]: 19 })).toMatch(/rune_damage T6: its lowest roll 19 is above its highest 18/);
    expect(tunableSetProblem({ [dmg(1, 'min')]: 15 })).toMatch(/rune_damage T5 \(15 to 27\) overlaps or sits below rune_damage T6/);
    // Sharing an end is fine, as whole-number tiers must.
    expect(tunableSetProblem({ [dmg(1, 'min')]: 18 })).toBeNull();
    expect(tunableSetProblem({ [dmg(5, 'ilvl')]: 4 })).toMatch(/unlocks at item level 4/);
    expect(tunableSetProblem({ [dmg(0, 'ilvl')]: 2 })).toMatch(/rune_damage T6 must unlock at item level 1/);
    expect(tunableSetProblem({ [affixTierPath('rune_damage', 0, 'weight')]: 0 })).toMatch(/rune_damage T6 must keep a weight above 0/);
    expect(tunableSetProblem({ [affixTierPath('rune_damage', 5, 'weight')]: 0 })).toBeNull();
    const every = (tier: number, key: 'min' | 'max'): string => affixTierPath('release_every', tier, key);
    expect(tunableSetProblem({ [every(5, 'max')]: 0.25 })).toMatch(/shorter is better/);
    expect(tunableSetProblem({ [affixTierPath('damage_increased', 2, 'min')]: 30 })).toMatch(/damage_increased T1/);
    // Moving a whole tier up with its neighbour is a valid set.
    expect(tunableSetProblem({ [dmg(5, 'min')]: 60, [dmg(5, 'max')]: 80 })).toBeNull();
  });

  it('apply a valid set, and keep the code table whole for an affix a partial set would break', () => {
    applyTunables({ [affixTierPath('rune_damage', 5, 'max')]: 80, [affixTierPath('rune_size', 1, 'min')]: 12 });
    expect(AFFIXES.rune_damage.tiers[5]?.max).toBe(80);
    // T5 starting at 12 would overlap T6 (10 to 17), so rune_size keeps its code table.
    expect(AFFIXES.rune_size.tiers[1]?.min).toBe(18);
    expect(activeTunables()).toEqual({ [affixTierPath('rune_damage', 5, 'max')]: 80 });
    resetTunables();
    expect(AFFIXES.rune_damage.tiers).toEqual(codeAffixTiers('rune_damage'));
  });

  it('drop unknown stored paths without a report', () => {
    const reports: string[] = [];
    const v = parseTunableValues({ 'starter.bone_spear.0.damage': 140, [affixTierPath('rune_damage', 5, 'max')]: 70, 'spell.bolt.damage': -1 }, (why) => reports.push(why));
    expect(v).toEqual({ [affixTierPath('rune_damage', 5, 'max')]: 70 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/spell\.bolt\.damage/);
  });

  it('change new drops and where extraction clamps, never a stored roll', () => {
    const before = rolledRunes(9, 400);
    const sigil = createSigil(1, new Rng(2), 'relic', { ilvl: 30 });
    const stored = JSON.stringify({ before, sigil });
    const prices = before.map(sellPrice);
    const set: TunableValues = {
      [affixTierPath('rune_damage', 0, 'min')]: 30,
      [affixTierPath('rune_damage', 0, 'max')]: 30,
      [affixTierPath('rune_damage', 1, 'min')]: 30,
      [affixTierPath('rune_damage', 1, 'max')]: 30,
      [affixTierPath('rune_damage', 2, 'min')]: 30,
      [affixTierPath('rune_damage', 5, 'max')]: 150,
      [affixTierPath('damage_increased', 0, 'min')]: 30,
      [affixTierPath('damage_increased', 0, 'max')]: 30,
      [affixTierPath('damage_increased', 1, 'min')]: 30,
    };
    expect(tunableSetProblem(set)).toBeNull();
    applyTunables(set);
    // Held items are untouched: same rolls, same tiers, same prices.
    expect(JSON.stringify({ before, sigil })).toBe(stored);
    expect(before.map(sellPrice)).toEqual(prices);
    // New level-1 drops roll the tuned T6.
    const rng = new Rng(3);
    const fresh = Array.from({ length: 300 }, (_, i) => createRolledRune(i, rng, 'magic', 1, 'orb')).flatMap((r) => r.affixes.filter((a) => a.id === 'rune_damage'));
    expect(fresh.length).toBeGreaterThan(10);
    expect(fresh.every((a) => a.value === 30)).toBe(true);
    const sigils = Array.from({ length: 300 }, (_, i) => createSigil(i, new Rng(i), 'magic', { ilvl: 1 })).flatMap((s) => s.affixes.filter((a) => a.id === 'damage_increased'));
    expect(sigils.length).toBeGreaterThan(5);
    expect(sigils.every((a) => a.value === 30)).toBe(true);
    // Extraction clamps to the lower of the tuned best and the code's: a raise for a while cannot
    // let an old +300% roll out at the raised best for good.
    const codeBest = Math.max(...codeAffixTiers('rune_damage').map((t) => t.max));
    expect(clampRoll({ id: 'rune_damage', tier: 5, value: 300 }).value).toBe(codeBest);
    applyTunables({ [affixTierPath('rune_damage', 5, 'max')]: codeBest - 1 });
    expect(clampRoll({ id: 'rune_damage', tier: 5, value: 300 }).value).toBe(codeBest - 1);
    // How often a tier drops does not move the clamp.
    applyTunables({ [affixTierPath('rune_damage', 5, 'weight')]: 0 });
    expect(clampRoll({ id: 'rune_damage', tier: 5, value: 300 }).value).toBe(codeBest);
  });

  it('make new kits inside the tuned table, below T1', () => {
    applyTunables({ [affixTierPath('rune_damage', 4, 'max')]: 50 });
    const fireball = starterSigilById('fireball');
    if (!fireball) throw new Error('no fireball');
    let uid = 1;
    const kit = createStarterSigil(() => uid++, fireball, { bound: true });
    expect(kit.slots[0]?.affixes.find((a) => a.id === 'rune_damage')).toEqual({ id: 'rune_damage', tier: 4, value: 50 });
    for (const def of STARTER_SIGILS) {
      const s = createStarterSigil(() => uid++, def, { bound: false });
      expect(s.slots.flatMap(rollLosses), def.id).toEqual([]);
      expect(compileSigilItem(s, def.classId).ok, def.id).toBe(true);
    }
  });
});

describe('no gold from a range change', () => {
  const SETS: TunableValues[] = [
    {},
    // T1 everywhere and easy: wide, heavy, from level 1.
    { [affixTierPath('rune_damage', 5, 'max')]: 300, [affixTierPath('rune_damage', 5, 'weight')]: 1000, [affixTierPath('rune_damage', 5, 'ilvl')]: 1, [affixTierPath('rune_damage', 4, 'ilvl')]: 1, [affixTierPath('rune_damage', 3, 'ilvl')]: 1, [affixTierPath('rune_damage', 2, 'ilvl')]: 1, [affixTierPath('rune_damage', 1, 'ilvl')]: 1 },
    // Tables squeezed low.
    { [affixTierPath('rune_damage', 5, 'min')]: 56, [affixTierPath('rune_damage', 5, 'max')]: 56, [affixTierPath('rune_damage', 4, 'min')]: 46, [affixTierPath('rune_damage', 4, 'max')]: 46 },
  ];

  it('buying costs more than selling, inserting costs what the rune sells for, and extraction never gives more, under every set', () => {
    const held = rolledRunes(21, 300);
    for (const set of SETS) {
      expect(tunableSetProblem(set)).toBeNull();
      applyTunables(set);
      for (const r of [...held, ...rolledRunes(22, 300, 1), ...rolledRunes(23, 300, 30)]) {
        expect(buyPrice(r)).toBeGreaterThan(sellPrice(r));
        expect(forgeInsertPrice(r)).toBe(sellPrice(r));
        const out = clampRuneRolls(r);
        expect(sellPrice(out)).toBeLessThanOrEqual(sellPrice(r));
      }
    }
  });

  it('a rune bought, inserted, retuned and taken out at the real forge sells for no more than it cost', () => {
    const sim = new Simulation(4, { kind: 'world', seed: 3 });
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    const forge = sim.mapDef.forge;
    if (!p || !pos || !forge) throw new Error('setup');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    applyTunables(SETS[1] ?? {});
    const rng = new Rng(8);
    const runes = Array.from({ length: 60 }, () => createRolledRune(sim.newItemUid(), rng, 'relic', 30, 'orb')).filter((r) => r.affixes.some((a) => a.id === 'rune_damage'));
    const rune = runes.sort((a, b) => sellPrice(b) - sellPrice(a))[0];
    if (!rune) throw new Error('no rune');
    const sigil = createSigil(sim.newItemUid(), rng, 'rare', { ilvl: 10 });
    addItem(p, sigil);
    addItem(p, rune);
    const paid = buyPrice(rune);
    p.gold = 10_000;
    expect(sim.inscribe(pid, sigil.uid, [{ from: 'rolled', uid: rune.uid }])).toBeNull();
    expect(p.gold).toBe(10_000 - forgeInsertPrice(rune));
    // The tables shrink while the rune sits in the sigil; it keeps its roll there.
    applyTunables(SETS[2] ?? {});
    expect(sigil.slots[0]?.affixes).toEqual(rune.affixes);
    expect(sim.inscribe(pid, sigil.uid, [])).toBeNull();
    const back = p.items.get(rune.uid);
    if (back?.kind !== 'rune') throw new Error('rune not back');
    expect(sellPrice(back)).toBeLessThanOrEqual(sellPrice(rune));
    expect(sellPrice(back)).toBeLessThan(paid);
    expect(back.affixes.find((a) => a.id === 'rune_damage')?.value).toBeLessThanOrEqual(56);
  });
});
