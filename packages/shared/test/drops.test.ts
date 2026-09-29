import { describe, expect, it } from 'vitest';
import { BOSS_DROPS, DEFAULT_DROP_TUNING, LOOT, MAX_DROP_ITEMS, Rng, rollDrops, Simulation, type Item } from '../src/index.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { dropLoot } from '../src/sim/inventory.js';

function withoutUid(items: readonly Item[]): unknown[] {
  return items.map((item) => {
    const { uid: _uid, ...rest } = item;
    // Runes inside a sigil carry uids of their own.
    return item.kind === 'sigil' ? { ...rest, slots: item.slots.map(({ uid: _r, ...r }) => r) } : rest;
  });
}

describe('rollDrops', () => {
  it('matches the simulation drop roll item for item', () => {
    const sim = new Simulation(3, { kind: 'flat' });
    let compared = 0;
    for (const [i, src] of [
      { level: 1, rare: false, boss: false },
      { level: 4, rare: true, boss: false },
      { level: 7, rare: true, boss: true },
    ].entries()) {
      for (let k = 0; k < 40; k++) {
        const seed = i * 1000 + k;
        const id = spawnEnemy(sim, 'chaser', 500, 500, { rare: src.rare, level: src.level, aggro: false, boss: src.boss });
        const before = new Set(sim.world.loot.keys());
        sim.rand.loot = Rng.stream(seed, 'drops-test');
        dropLoot(sim, id);
        const bag = [...sim.world.loot.entries()].find(([lid]) => !before.has(lid))?.[1];
        let uid = 0;
        const expected = rollDrops(Rng.stream(seed, 'drops-test'), () => uid++, src);
        expect(withoutUid(bag?.items ?? [])).toEqual(withoutUid(expected));
        compared += expected.length;
        sim.world.destroy(id);
        sim.world.flushDestroyed();
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('is deterministic per seed', () => {
    let a = 0;
    let b = 0;
    const src = { level: 5, rare: true, boss: false };
    expect(rollDrops(new Rng(9), () => a++, src)).toEqual(rollDrops(new Rng(9), () => b++, src));
  });

  describe('loot rate', () => {
    const normal = { level: 3, rare: false, boss: false };
    const rare = { level: 3, rare: true, boss: false };
    const boss = { level: 3, rare: true, boss: true };
    const roll = (seed: number, src: typeof normal, q: number): Item[] => {
      let uid = 0;
      return rollDrops(new Rng(seed), () => uid++, src, DEFAULT_DROP_TUNING, q);
    };

    it('at 1x rolls exactly what the default does, so seeds replay unchanged', () => {
      for (let seed = 0; seed < 50; seed++) {
        for (const src of [normal, rare, boss]) {
          let a = 0;
          expect(roll(seed, src, 1)).toEqual(rollDrops(new Rng(seed), () => a++, src));
        }
      }
    });

    it('at 0 nothing drops, bosses included', () => {
      for (let seed = 0; seed < 50; seed++) for (const src of [normal, rare, boss]) expect(roll(seed, src, 0)).toEqual([]);
    });

    it('scales rare and boss item counts, rolling the fraction', () => {
      expect(roll(1, boss, 2)).toHaveLength(BOSS_DROPS * 2);
      expect(roll(1, boss, 1.5)).toHaveLength(BOSS_DROPS * 1.5);
      let total = 0;
      for (let seed = 0; seed < 400; seed++) {
        const n = roll(seed, rare, 1.5).length;
        expect(n).toBeGreaterThanOrEqual(Math.floor(LOOT.rareDropCount.min * 1.5));
        expect(n).toBeLessThanOrEqual(Math.ceil(LOOT.rareDropCount.max * 1.5));
        total += n;
      }
      const mean1x = (LOOT.rareDropCount.min + LOOT.rareDropCount.max) / 2;
      expect(total / 400).toBeCloseTo(mean1x * 1.5, 0);
    });

    it('caps a bag at MAX_DROP_ITEMS however high the rate', () => {
      expect(roll(1, boss, 20)).toHaveLength(MAX_DROP_ITEMS);
    });

    it('multiplies how often normal monsters drop, but never more than one item', () => {
      let at1 = 0;
      let at2 = 0;
      for (let seed = 0; seed < 4000; seed++) {
        at1 += roll(seed, normal, 1).length;
        const n = roll(seed, normal, 2).length;
        expect(n).toBeLessThanOrEqual(1);
        at2 += n;
      }
      expect(at2 / at1).toBeGreaterThan(1.7);
      expect(at2 / at1).toBeLessThan(2.3);
    });
  });
});
