import { describe, expect, it } from 'vitest';
import { applyDev, DUNGEON, enemyDisplayName, GameMap, generateDungeon, loadMap, NET, serializeEntities, Simulation, snapshotFor, stagingMap, type EntityId, type Portal, type WorldMap } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';
import { packetOf } from '../src/sim/damage.js';

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

describe('dungeon boss', () => {
  it('clears the run once and opens a cache of rare or better items', () => {
    const sim = new Simulation(3, { kind: 'dungeon', seed: 11, level: 3, run: 0 });
    const pid = sim.addPlayer('c', 'mage');
    const boss = [...sim.world.enemy].find(([, e]) => e.boss);
    if (!boss) throw new Error('no boss');
    const bagsBefore = sim.world.loot.size;
    dealDamage(sim, boss[0], packetOf('physical', 1e9), pid);
    sim.step();
    expect(sim.cleared).toBe(true);
    const items = [...sim.world.loot.values()].flatMap((b) => b.items);
    expect(sim.world.loot.size).toBeGreaterThanOrEqual(bagsBefore + 2);
    expect(items.filter((i) => i.tier === 'rare' || i.tier === 'relic').length).toBeGreaterThanOrEqual(DUNGEON.cacheItems);
  });

  it('never clears anything outside a dungeon', () => {
    const sim = new Simulation(3, { kind: 'wilds', seed: 5 });
    const pid = sim.addPlayer('c', 'mage');
    const boss = [...sim.world.enemy].find(([, e]) => e.boss);
    if (boss) dealDamage(sim, boss[0], packetOf('physical', 1e9), pid);
    sim.step();
    expect(sim.cleared).toBe(false);
  });
});

describe('dungeon exit', () => {
  const desc = { kind: 'dungeon', seed: 11, level: 3, run: 0 } as const;

  function setup(): { sim: Simulation; pid: EntityId; exit: Portal; entrance: Portal } {
    const sim = new Simulation(3, desc);
    const pid = sim.addPlayer('c', 'mage');
    const p = sim.world.player.get(pid);
    if (p) p.god = true;
    const exit = sim.mapDef.portals.find((x) => x.sealed === 'boss');
    const entrance = sim.mapDef.portals.find((x) => x.target === 'staging');
    if (!exit || !entrance) throw new Error('missing portal');
    return { sim, pid, exit, entrance };
  }

  function stand(sim: Simulation, pid: EntityId, at: Portal, seconds: number): void {
    for (let i = 0; i < seconds * 20; i++) {
      sim.world.position.set(pid, { x: at.x, y: at.y });
      sim.step();
    }
  }

  function exitOpen(sim: Simulation, pid: EntityId): boolean {
    return snapshotFor(sim, pid, serializeEntities(sim), [], NET.interestRadius).exitOpen === true;
  }

  function killBoss(sim: Simulation, pid: EntityId): void {
    const boss = [...sim.world.enemy].find(([, e]) => e.boss);
    if (!boss) throw new Error('no boss');
    dealDamage(sim, boss[0], packetOf('physical', 1e9), pid);
    sim.step();
  }

  it('seals the exit in the boss room and opens the way back to the antechamber from the start', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { map } = generateDungeon({ seed, level: 2 }, 0);
      const exits = map.portals.filter((p) => p.sealed === 'boss');
      expect(exits.map((p) => p.target)).toEqual(['wilds']);
      const back = map.portals.filter((p) => p.target === 'staging');
      expect(back).toHaveLength(1);
      expect(back[0]?.sealed).toBeUndefined();
      expect(back[0]?.dungeon).toEqual({ seed, level: 2 });
      expect(Math.hypot((back[0]?.x ?? 0) - map.spawn.x, (back[0]?.y ?? 0) - map.spawn.y)).toBeLessThan(150);
    }
  });

  it('never asks to use the exit while the boss lives', () => {
    const { sim, pid, exit } = setup();
    stand(sim, pid, exit, 4);
    expect(sim.portalRequests).toHaveLength(0);
    expect(exitOpen(sim, pid)).toBe(false);
  });

  it('uses the entrance portal before the boss dies', () => {
    const { sim, pid, entrance } = setup();
    stand(sim, pid, entrance, 2);
    expect(sim.portalRequests.map((r) => r.target)).toContain('staging');
  });

  it('opens the exit when the boss dies, after a grace for anyone standing on it', () => {
    const { sim, pid, exit } = setup();
    sim.world.position.set(pid, { x: exit.x, y: exit.y });
    killBoss(sim, pid);
    expect(exitOpen(sim, pid)).toBe(true);
    stand(sim, pid, exit, 2);
    expect(sim.portalRequests).toHaveLength(0);
    stand(sim, pid, exit, 2);
    expect(sim.portalRequests.map((r) => r.portal)).toContain(exit);
  });

  it('drops the cache clear of the exit when the boss dies on it', () => {
    const { sim, pid, exit } = setup();
    const boss = [...sim.world.enemy].find(([, e]) => e.boss);
    if (!boss) throw new Error('no boss');
    sim.world.position.set(boss[0], { x: exit.x, y: exit.y });
    dealDamage(sim, boss[0], packetOf('physical', 1e9), pid);
    sim.step();
    const bags = [...sim.world.loot.keys()].flatMap((id) => {
      const pos = sim.world.position.get(id);
      return pos ? [Math.hypot(pos.x - exit.x, pos.y - exit.y)] : [];
    });
    expect(bags.length).toBeGreaterThan(0);
    expect(Math.min(...bags)).toBeGreaterThan(exit.r + 40);
  });

  it('shows the exit open to a player who arrives after the boss died', () => {
    const { sim, pid } = setup();
    killBoss(sim, pid);
    const late = sim.addPlayer('late', 'warrior');
    expect(exitOpen(sim, late)).toBe(true);
  });

  it('opens the exit when dev tools remove the boss', () => {
    const { sim, pid } = setup();
    applyDev(sim, pid, { c: 'killAll' });
    sim.step();
    expect(sim.cleared).toBe(true);
  });
});

describe('monster names', () => {
  it('builds D2-style names from prefix and suffix affixes', () => {
    expect(enemyDisplayName('chaser', ['hasted', 'reflects_projectiles'])).toBe('Hasted Chaser of Mirrors');
    expect(enemyDisplayName('shooter', [])).toBe('Shooter');
  });
});

describe('bridges', () => {
  it('every bridge can be walked across, from the spawn, on both banks', () => {
    for (const desc of [{ kind: 'arena' as const }, ...[1, 2, 3, 7, 1234, 530187].map((seed) => ({ kind: 'wilds' as const, seed }))]) {
      const map = loadMap(desc).def;
      const { gm, seen } = reach(map, map.spawn.x, map.spawn.y);
      for (const b of map.bridges) {
        const dx = Math.cos(b.angle);
        const dy = Math.sin(b.angle);
        const off = b.length / 2 + 40;
        for (const [x, y] of [
          [b.x, b.y],
          [b.x + dx * off, b.y + dy * off],
          [b.x - dx * off, b.y - dy * off],
        ] as const) {
          expect(seen.has(gm.navCell(x, y)), `${JSON.stringify(desc)} bridge at ${Math.round(b.x)},${Math.round(b.y)}`).toBe(true);
        }
      }
    }
  });
});
