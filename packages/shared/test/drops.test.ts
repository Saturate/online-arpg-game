import { describe, expect, it } from 'vitest';
import { Rng, rollDrops, Simulation, type Item } from '../src/index.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { dropLoot } from '../src/sim/inventory.js';

function withoutUid(items: readonly Item[]): unknown[] {
  return items.map(({ uid: _uid, ...rest }) => rest);
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
});
