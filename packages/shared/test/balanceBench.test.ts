import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTunables,
  balanceSpecs,
  benchMark,
  benchSpecKey,
  bestKit,
  checkBenchSpell,
  EquippedTally,
  equippedSpells,
  formatRunes,
  compileBenchSpell,
  kitSpecs,
  measureBenchSpec,
  measureSkill,
  measureStarter,
  mostEquipped,
  perForce,
  resetTunables,
  Simulation,
  spellDistance,
  STARTER_SIGILS,
  type BenchMeasure,
  type BenchSpec,
} from '../src/index.js';

// Vitest runs in Node; the shared package builds without Node's types.
declare const console: { log(message: string): void };
declare const performance: { now(): number };
declare const process: { env: Record<string, string | undefined> };

const close = (a: number | null, b: number | null): void => {
  if (a === null || b === null) return expect(a).toBe(b);
  expect(a).toBeCloseTo(b, 9);
};

function measured(m: BenchMeasure): Extract<BenchMeasure, { ok: true }> {
  if (!m.ok) throw new Error(m.error);
  return m;
}

describe('balance bench measurement', () => {
  afterEach(() => resetTunables());

  it('reads the same Force, casts, kind and damage per Force as the parity harness for every kit', () => {
    for (const def of STARTER_SIGILS) {
      const full = measureStarter(def);
      const bench = measured(measureBenchSpec({ kind: 'kit', kitId: def.id }));
      expect(bench.kind, def.id).toBe(full.kind);
      expect(bench.force, def.id).toBe(full.forcePerCast);
      expect(bench.spirit, def.id).toBe(full.spiritReserved);
      expect(bench.casts, def.id).toBe(full.casts);
      if (full.single === null) expect(bench.single, def.id).toBeNull();
      else {
        const pf = perForce(full);
        close(bench.single, pf.single);
        close(bench.pack, pf.pack);
      }
    }
  });

  it('reads the same numbers as the balance test for every hand-picked spell', () => {
    for (const spec of balanceSpecs()) {
      const compiled = compileBenchSpell(spec);
      if (!compiled.ok) throw new Error(spec.text);
      const distance = spellDistance(spec.text);
      const full = measureSkill({ classId: spec.classId, equip: () => ({ uid: -1, compiled, misfireMultiplier: 1, castDelayShare: 1 }), ...(distance !== undefined ? { distance } : {}) });
      const bench = measured(measureBenchSpec(spec));
      expect(bench.force, spec.text).toBe(full.forcePerCast);
      expect(bench.casts, spec.text).toBe(full.casts);
      const pf = perForce(full);
      close(bench.single, full.single === null ? null : pf.single);
      close(bench.pack, full.pack === null ? null : pf.pack);
    }
  });

  it('measures the best kit as the balance test reports it: Freezing Arrow 2.13 single, Exploding Arrow 7.71 pack', () => {
    const best = bestKit(kitSpecs().map(measureBenchSpec));
    expect(best?.single.toFixed(2)).toBe('2.13');
    expect(best?.pack.toFixed(2)).toBe('7.71');
  });

  it('follows an applied override and goes back with the set', () => {
    const spec: BenchSpec = { kind: 'spell', text: 'bolt fire', classId: 'mage', multicast: 1 };
    const before = measured(measureBenchSpec(spec));
    applyTunables({ 'spell.bolt.damageMax': 40 });
    const after = measured(measureBenchSpec(spec));
    expect(after.single ?? 0).toBeGreaterThan((before.single ?? 0) * 1.5);
    resetTunables();
    expect(measured(measureBenchSpec(spec)).single).toBe(before.single);
  });

  it('marks above 2x soft and above 5x hard', () => {
    expect(benchMark(null)).toBeNull();
    expect(benchMark(2)).toBeNull();
    expect(benchMark(2.01)).toBe('soft');
    expect(benchMark(5)).toBe('soft');
    expect(benchMark(5.01)).toBe('hard');
  });

  it('reports a spell that does not compile instead of throwing', () => {
    const m = measureBenchSpec({ kind: 'spell', text: 'fire', classId: 'mage', multicast: 1 });
    expect(m.ok).toBe(false);
    expect(measureBenchSpec({ kind: 'kit', kitId: 'nope' }).ok).toBe(false);
  });

  // Wall-clock bounds flake on shared CI runners; the number is printed either way.
  it.skipIf(process.env.CI !== undefined)('measures every bench row in a few ms each', () => {
    const rows: BenchSpec[] = [...kitSpecs(), ...balanceSpecs()];
    const t0 = performance.now();
    for (const r of rows) measureBenchSpec(r);
    const each = (performance.now() - t0) / rows.length;
    console.log(`\nbench: ${rows.length} rows, ${each.toFixed(1)} ms a row\n`);
    // About 3 ms on a dev machine; the bound leaves room for parallel test files.
    expect(each).toBeLessThan(40);
  });
});

describe('admin picks', () => {
  it('stores the text as the grammar writes it, so two spellings are one pick', () => {
    const a = checkBenchSpell({ text: '  bolt[+55%   damage]  fire ', classId: 'ranger' });
    const b = checkBenchSpell({ text: 'bolt[+55% damage] fire', classId: 'ranger', multicast: 1 });
    expect(a).toEqual(b);
    expect(typeof a === 'string' ? a : a.text).toBe('bolt[+55% damage] fire');
  });

  it('refuses text the grammar cannot read or the compiler cannot cast, and bad fields', () => {
    for (const bad of [
      null,
      { text: '', classId: 'mage' },
      { text: 'bolt', classId: 'pirate' },
      { text: 'bolt', classId: 'mage', multicast: 0 },
      { text: 'bolt', classId: 'mage', multicast: 1.5 },
      { text: 'blot fire', classId: 'mage' },
      { text: 'fire fire', classId: 'mage' },
      { text: 'bolt '.repeat(11), classId: 'mage' },
      { text: 'x'.repeat(401), classId: 'mage' },
      // Rolls no rune item can have: past every tier of the drop table.
      { text: 'bolt[+300% damage]', classId: 'mage' },
      { text: 'bolt[+900% speed] fire', classId: 'mage' },
      { text: 'orb[every 0.01s] nova', classId: 'mage' },
    ]) {
      expect(typeof checkBenchSpell(bad), JSON.stringify(bad)).toBe('string');
    }
  });

  it('names the roll past the drop table the way the grammar names a bad word', () => {
    expect(checkBenchSpell({ text: 'fire bolt[+300% damage]', classId: 'mage' })).toMatch(/^"bolt\[\+300% damage\]" \(word 2\): .*outside what any rune rolls/);
  });

  it('accepts every kit, and every hand-picked spell but the two probes faster than any roll', () => {
    for (const def of STARTER_SIGILS) {
      const r = checkBenchSpell({ text: formatRunes(def.runes), classId: def.classId });
      // Kits hold in-table rolls by design; a kit that fails here means the tables moved past it.
      expect(typeof r === 'string' ? `${def.id}: ${r}` : 'ok').toBe('ok');
    }
    // The balance test keeps two spells from before the tables (every 0.1 s, after 0.1 s) on purpose.
    const refused = balanceSpecs().filter((s) => typeof checkBenchSpell(s) === 'string').map((s) => s.text);
    expect(refused).toEqual(['zone[every 0.1s] lightning nova', 'nova[after 0.1s] lightning nova[after 0.1s] nova']);
  });

  it('keys rows by class, multicast and text, and kits by id', () => {
    expect(benchSpecKey({ kind: 'kit', kitId: 'fireball' })).toBe('kit:fireball');
    expect(benchSpecKey({ kind: 'spell', text: 'bolt', classId: 'mage', multicast: 2 })).toBe('mage|2|bolt');
  });
});

describe('most equipped sigils', () => {
  /** A real save from the sim, so the aggregation reads what the server stores. */
  function save(classId: 'mage' | 'ranger', name: string): Record<string, unknown> {
    const sim = new Simulation(1, { kind: 'flat' });
    const id = sim.addPlayer(name, classId, name);
    const s = sim.exportPlayer(id);
    if (!s) throw new Error('no save');
    return JSON.parse(JSON.stringify(s));
  }

  it('counts each character once per sigil, by rune text, most first, without names', () => {
    const mages = [save('mage', 'Ann'), save('mage', 'Bob'), save('mage', 'Cid')];
    const ranger = save('ranger', 'Dee');
    const saves = [...mages.map((s) => ({ classId: 'mage', save: s })), { classId: 'ranger', save: ranger }];
    const top = mostEquipped(saves);
    expect(top.length).toBeGreaterThan(0);
    const first = top[0];
    expect(first?.equipped).toBe(3);
    expect(first?.classId).toBe('mage');
    for (let i = 1; i < top.length; i++) expect((top[i - 1]?.equipped ?? 0) >= (top[i]?.equipped ?? 0)).toBe(true);
    const json = JSON.stringify(top);
    for (const n of ['Ann', 'Bob', 'Cid', 'Dee']) expect(json).not.toContain(n);
    // Every listed text reads back under the grammar and compiles on its class.
    for (const p of top) expect(typeof checkBenchSpell(p)).not.toBe('string');
    expect(mostEquipped(saves, 2)).toHaveLength(2);
  });

  it('counts the same sigil twice on one character once, and skips old or unreadable saves', () => {
    const s = save('mage', 'Eve');
    const sigils = s.sigils;
    if (!Array.isArray(sigils)) throw new Error('no sigils');
    const one = mostEquipped([{ classId: 'mage', save: { ...s, sigils: [sigils[0], sigils[0], null, null] } }]);
    expect(one).toHaveLength(1);
    expect(one[0]?.equipped).toBe(1);
    expect(mostEquipped([{ classId: 'mage', save: { ...s, runeFormat: 1 } }, { classId: 'mage', save: 'junk' }, { classId: 'pirate', save: s }])).toEqual([]);
    const items = s.items;
    if (!Array.isArray(items)) throw new Error('no items');
    const broken = items.map((it: unknown) => (typeof it === 'object' && it !== null && 'slots' in it ? { ...it, slots: [{ kind: 'rune', rune: 'nope', affixes: [] }] } : it));
    expect(mostEquipped([{ classId: 'mage', save: { ...s, items: broken } }])).toEqual([]);
  });
});

describe('equipped tally', () => {
  const a = { text: 'bolt fire', multicast: 1 };
  const b = { text: 'nova lightning', multicast: 1 };

  it('replaces what a character counted on each save and forgets it on delete', () => {
    const t = new EquippedTally();
    t.set(1, 'mage', [a, b]);
    t.set(2, 'ranger', [a]);
    t.set(3, 'ranger', [a]);
    expect(t.top()).toEqual([
      { ...a, classId: 'ranger', equipped: 3 },
      { ...b, classId: 'mage', equipped: 1 },
    ]);
    t.set(1, 'mage', [b]);
    expect(t.top()[0]).toEqual({ ...a, classId: 'ranger', equipped: 2 });
    t.remove(2);
    t.remove(3);
    t.remove(99);
    expect(t.top()).toEqual([{ ...b, classId: 'mage', equipped: 1 }]);
    expect(t.characters).toBe(1);
    t.set(1, 'mage', []);
    expect(t.top()).toEqual([]);
  });

  it('reads a save without its names', () => {
    const sim = new Simulation(1, { kind: 'flat' });
    const save = sim.exportPlayer(sim.addPlayer('Zed', 'mage', 'Zed'));
    const spells = equippedSpells(save);
    expect(spells.length).toBeGreaterThan(0);
    expect(JSON.stringify(spells)).not.toContain('Zed');
    expect(equippedSpells(null)).toEqual([]);
  });
});
