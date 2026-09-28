import { describe, expect, it } from 'vitest';
import { GameMap, generateDungeon, loadMap, stagingMap, type WorldMap } from '../src/index.js';

/** Walkable nav cells reachable from a point, by flood fill. */
function reach(map: WorldMap, x: number, y: number): { gm: GameMap; seen: Set<number> } {
  const gm = new GameMap(map);
  const start = gm.navCell(x, y);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const c = queue.pop() ?? 0;
    const cx = c % gm.navCols;
    const cy = (c - cx) / gm.navCols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (!gm.isWalkable(cx + dx, cy + dy)) continue;
      const n = (cy + dy) * gm.navCols + cx + dx;
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return { gm, seen };
}

describe('dungeon generation', () => {
  it('is deterministic per seed and run, and a new run changes the layout', () => {
    const a = generateDungeon({ seed: 42, level: 3 }, 0).map;
    const b = generateDungeon({ seed: 42, level: 3 }, 0).map;
    const c = generateDungeon({ seed: 42, level: 3 }, 1).map;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.obstacles)).not.toBe(JSON.stringify(c.obstacles));
  });

  it('connects every pack and both portals to the entrance, with one boss', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { map } = generateDungeon({ seed, level: 2 }, seed % 3);
      const { gm, seen } = reach(map, map.spawn.x, map.spawn.y);
      for (const p of map.packs) expect(seen.has(gm.navCell(p.x, p.y)), `seed ${seed} pack at ${p.x},${p.y}`).toBe(true);
      for (const p of map.portals) expect(seen.has(gm.navCell(p.x, p.y)), `seed ${seed} portal ${p.label}`).toBe(true);
      expect(map.packs.filter((p) => p.boss)).toHaveLength(1);
      // Only the rock touching floor becomes walls; this bounds the collision workload.
      expect(map.obstacles.length).toBeLessThan(900);
    }
  });

  it('builds a safe staging room with a gate and a way back', () => {
    const map = stagingMap({ seed: 7, level: 2 });
    expect(map.safe).toBe(true);
    expect(map.portals.map((p) => p.target).sort()).toEqual(['dungeon', 'wilds']);
    const { gm, seen } = reach(map, map.spawn.x, map.spawn.y);
    for (const p of map.portals) expect(seen.has(gm.navCell(p.x, p.y))).toBe(true);
  });

  it('puts reachable dungeon entrances in the wilds', () => {
    const { def } = loadMap({ kind: 'wilds', seed: 1234 });
    const entrances = def.portals.filter((p) => p.target === 'staging');
    expect(entrances.length).toBeGreaterThan(0);
    const { gm, seen } = reach(def, def.spawn.x, def.spawn.y);
    for (const e of entrances) {
      expect(e.dungeon).toBeDefined();
      expect(seen.has(gm.navCell(e.x, e.y))).toBe(true);
    }
  });
});
