import { describe, expect, it } from 'vitest';
import { createVessel, SIM, Simulation, type EntityId, type VesselItem } from '../src/index.js';
import { dealDamage, isTargetable } from '../src/sim/combat.js';
import { findNavPath } from '../src/sim/minionPath.js';
import { pathBudgetStats } from '../src/sim/minions.js';

function binderOn(sim: Simulation) {
  const id = sim.addPlayer('c', 'binder');
  sim.step();
  const p = sim.world.player.get(id);
  const pos = sim.world.position.get(id);
  const m = p?.minions.find((x): x is EntityId => x !== null && x !== undefined);
  if (!p || !pos || m === undefined) throw new Error('setup');
  return { id, p, pos, m };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('minions while their master is dead', () => {
  it('stand down by the corpse, untouched and not fighting, and come back on respawn', () => {
    const sim = new Simulation(7, { kind: 'testground' });
    const { id, p, pos, m } = binderOn(sim);
    const mpos = sim.world.position.get(m);
    const mh = sim.world.health.get(m);
    if (!mpos || !mh) throw new Error('setup');
    const enemy = sim.spawnEnemy('chaser', pos.x + 60, pos.y);
    const eh = sim.world.health.get(enemy);
    if (!eh) throw new Error('setup');
    eh.life = eh.maxLife = 100_000;
    // Park the minion right next to the enemy, then kill the master.
    mpos.x = pos.x + 90;
    mpos.y = pos.y + 20;
    dealDamage(sim, id, 1_000_000, enemy, []);
    expect(p.respawnIn).not.toBeNull();
    expect(isTargetable(sim, m)).toBe(false);
    const corpse = { x: pos.x, y: pos.y };
    const minionLife = mh.life;
    const enemyLife = eh.life;
    // Just under the respawn time, so the master is still down at the end.
    for (let i = 0; i < SIM.playerRespawnSeconds * SIM.tickRate - 4; i++) sim.step();
    expect(p.respawnIn).not.toBeNull();
    const mc = sim.world.minion.get(m);
    expect(mc?.standingDown).toBe(true);
    expect(mc?.targetId).toBeNull();
    expect(sim.world.isAlive(m)).toBe(true);
    expect(mh.life).toBeGreaterThanOrEqual(minionLife);
    expect(eh.life).toBe(enemyLife);
    expect(dist(mpos, corpse)).toBeLessThan(140);

    // Respawn somewhere far off: the minion is put down beside the master and fights again.
    const home = { x: corpse.x - 600, y: corpse.y };
    sim.playerSpawnPoint = () => ({ ...home });
    for (let i = 0; i < 10; i++) sim.step();
    expect(p.respawnIn).toBeNull();
    expect(sim.world.minion.get(m)?.standingDown).toBe(false);
    expect(isTargetable(sim, m)).toBe(true);
    // Respawning replaces the master's position object.
    const back = sim.world.position.get(id);
    if (!back) throw new Error('no position');
    expect(dist(back, home)).toBeLessThan(1);
    expect(dist(mpos, back)).toBeLessThan(120);
  });

  it('a dead master does not kill the minion through a poison or burn it carries', () => {
    const sim = new Simulation(8, { kind: 'testground' });
    const { id, m } = binderOn(sim);
    const st = sim.world.status.get(m);
    const mh = sim.world.health.get(m);
    if (!st || !mh) throw new Error('setup');
    mh.life = 5;
    st.burn = { dps: 1000, t: 5, sourceId: id };
    const enemy = sim.spawnEnemy('chaser', 0, 0);
    dealDamage(sim, id, 1_000_000, enemy, []);
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.world.isAlive(m)).toBe(true);
  });
});

describe('minion pathing behind the town fence', () => {
  // The Mossy Barrens town: its east fence runs along x = 2140 with the gate between y = 760 and 940.
  function townFence() {
    const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
    const fence = sim.mapDef.obstacles.find((o) => o.kind === 'fence' && o.shape.type === 'capsule' && o.shape.ax === 2140 && o.shape.by === 760);
    if (!fence) throw new Error('the town layout has no east fence');
    const b = binderOn(sim);
    b.pos.x = 2060;
    b.pos.y = 400;
    b.p.trail = [];
    const mpos = sim.world.position.get(b.m);
    if (!mpos) throw new Error('setup');
    mpos.x = 2220;
    mpos.y = 400;
    return { sim, mpos, ...b };
  }

  it('finds a nav route through the gate', () => {
    const { sim } = townFence();
    const route = findNavPath(sim.map, { x: 2220, y: 400 }, { x: 2060, y: 400 }, 2500);
    expect(route).not.toBeNull();
    expect(route?.some((r) => r.y > 760 && r.y < 940 && Math.abs(r.x - 2140) < 40)).toBe(true);
    expect(route?.at(-1)).toEqual({ x: 2060, y: 400 });
  });

  it('walks round through the gate after a teleport left it outside with no trail', () => {
    const { sim, mpos, pos, m } = townFence();
    let throughGate = false;
    let steps = 0;
    for (; steps < 12 * SIM.tickRate; steps++) {
      sim.step();
      if (mpos.y > 760 && mpos.y < 940 && Math.abs(mpos.x - 2140) < 40) throughGate = true;
      if (mpos.x < 2140 && dist(mpos, pos) < 120) break;
    }
    expect(sim.world.isAlive(m)).toBe(true);
    expect(mpos.x).toBeLessThan(2140);
    expect(dist(mpos, pos)).toBeLessThan(120);
    // It walked the gate route rather than being pulled over by the stuck rule.
    expect(throughGate).toBe(true);
  });

  it('is pulled over to its master after about 2 s without progress out of sight', () => {
    const { sim, mpos, pos, m } = townFence();
    const mc = sim.world.minion.get(m);
    if (!mc) throw new Error('setup');
    // A minion that cannot move stands for one whose way is blocked in every direction.
    mc.moveSpeed = 0;
    for (let i = 0; i < 1.5 * SIM.tickRate; i++) sim.step();
    expect(mpos.x).toBeGreaterThan(2140);
    for (let i = 0; i < 1 * SIM.tickRate; i++) sim.step();
    expect(mpos.x).toBeLessThan(2140);
    expect(dist(mpos, pos)).toBeLessThan(80);
  });

  it('drops a route whose goal has moved on when the replan is refused, instead of walking it', () => {
    const { sim, mpos, m } = townFence();
    const mc = sim.world.minion.get(m);
    if (!mc) throw new Error('setup');
    // A route planned a tick ago toward a goal far south; the master is now north-west, out of sight.
    mc.path = [{ x: 2230, y: 1400 }];
    mc.pathGoal = sim.map.navCell(2230, 1400);
    mc.pathTick = sim.tick;
    const stale = { x: 2230, y: 1400 };
    const before = dist(mpos, stale);
    const stride = mc.moveSpeed / SIM.tickRate;
    sim.step();
    expect(mc.path).toEqual([]);
    // It stepped toward its master rather than a full stride down the old route.
    expect(before - dist(mpos, stale)).toBeLessThan(stride * 0.5);
  });
});

describe('the route search budget', () => {
  function brutesOutside(count: number, spacing: number) {
    const sim = new Simulation(4, { kind: 'zone', zone: 'barrens', seed: 3 });
    const b = binderOn(sim);
    b.p.stats.spiritMax = 10_000;
    b.p.level = 30;
    for (let slot = 1; slot < count; slot++) {
      const v: VesselItem = { ...createVessel(sim.newItemUid(), sim.rng, 'common', 'zombie_brute', 1), affixes: [] };
      b.p.items.set(v.uid, v);
      b.p.inventory[b.p.inventory.indexOf(null)] = v.uid;
      expect(sim.equipVessel(b.id, v.uid, slot)).toBeNull();
    }
    sim.step();
    b.pos.x = 2060;
    b.pos.y = 400;
    b.p.trail = [];
    const minions = b.p.minions.filter((x): x is EntityId => x !== null && x !== undefined);
    expect(minions.length).toBe(count);
    for (const [k, id] of minions.entries()) {
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('setup');
      mp.x = 2220 + (k % 2) * spacing;
      mp.y = 200 + Math.floor(k / 2) * spacing;
    }
    return { sim, minions, ...b };
  }

  it('runs at most 3 searches a tick and serves the rest in line', () => {
    const { sim, minions, pos } = brutesOutside(12, 100);
    let queuedAtOnce = 0;
    for (let t = 0; t < 8 * SIM.tickRate; t++) {
      sim.step();
      const stats = pathBudgetStats(sim);
      if (stats.tick === sim.tick - 1) {
        expect(stats.searches).toBeLessThanOrEqual(3);
        expect(stats.cells).toBeLessThanOrEqual(5000);
      }
      queuedAtOnce = Math.max(queuedAtOnce, stats.queued);
    }
    expect(queuedAtOnce).toBeGreaterThan(3);
    expect(pathBudgetStats(sim).queued).toBe(0);
    // Everyone got through the gate (or was pulled over) in the end.
    for (const id of minions) {
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('gone');
      expect(mp.x).toBeLessThan(2140);
      expect(dist(mp, pos)).toBeLessThan(300);
    }
  });

  it('shares one search between minions standing together with the same goal', () => {
    const { sim, minions } = brutesOutside(4, 0);
    sim.step();
    const stats = pathBudgetStats(sim);
    expect(stats.searches).toBe(1);
    for (const id of minions) expect(sim.world.minion.get(id)?.path.length ?? 0).toBeGreaterThan(0);
  });
});
