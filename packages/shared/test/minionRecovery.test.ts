import { describe, expect, it } from 'vitest';
import { createVessel, loadMap, MINIONS, SIM, Simulation, spiritReservedFor, startArena, type EntityId, type VesselItem } from '../src/index.js';
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

/** The town's corner in the world map: the coordinates below are the town layout's own. */
const T = loadMap({ kind: 'world', seed: 3 }).def.townAt ?? { x: 0, y: 0 };

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

function minionsOf(sim: Simulation, owner: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const [mid, m] of sim.world.minion) if (m.ownerId === owner && sim.world.isAlive(mid)) out.push(mid);
  return out;
}

/** A Binder with the starter Brute and a relic Hound pack of three in slot 1. */
function packBinder(sim: Simulation, client: string) {
  const id = sim.addPlayer(client, 'binder');
  const p = sim.world.player.get(id);
  if (!p) throw new Error('setup');
  p.stats.spiritMax = 1000;
  const v: VesselItem = { ...createVessel(sim.newItemUid(), sim.rng, 'relic', 'hound', 1), affixes: [], pack: 3 };
  p.items.set(v.uid, v);
  p.inventory[p.inventory.indexOf(null)] = v.uid;
  expect(sim.equipVessel(id, v.uid, 1)).toBeNull();
  sim.step();
  return { id, p };
}

describe('minions of a fallen Arena member', () => {
  it('are desummoned at the death, without loot, XP, score or a death of their own, and stay away for the run', () => {
    const sim = new Simulation(9, { kind: 'testground' });
    startArena(sim, 1);
    const a = packBinder(sim, 'a');
    const b = packBinder(sim, 'b');
    const apos = sim.world.position.get(a.id);
    if (!apos) throw new Error('setup');
    // 1 Brute, 1 Leader and 3 packmates each.
    expect(minionsOf(sim, a.id)).toHaveLength(5);
    expect(minionsOf(sim, b.id)).toHaveLength(5);
    const enemy = sim.spawnEnemy('chaser', apos.x + 60, apos.y);
    const eh = sim.world.health.get(enemy);
    if (!eh) throw new Error('setup');
    eh.life = eh.maxLife = 100_000;
    const warband = [...a.p.warband];
    const spirit = spiritReservedFor(a.p);
    const xp = a.p.xp;
    sim.takeEvents();

    dealDamage(sim, a.id, 1_000_000, enemy, []);
    expect(a.p.respawnIn).not.toBeNull();
    sim.step();
    expect(minionsOf(sim, a.id)).toEqual([]);
    expect(a.p.minions.every((m) => m === null)).toBe(true);
    expect(a.p.packs[1]?.mates).toEqual([]);
    expect(a.p.packs[1]?.down).toEqual([]);
    const events = sim.takeEvents().map((e) => e.ev);
    expect(events.filter((e) => e.e === 'death' && e.k === 'minion')).toEqual([]);
    expect(events.filter((e) => e.e === 'explode')).toEqual([]);
    expect(sim.world.loot.size).toBe(0);
    expect(sim.arena?.score).toBe(0);
    expect(sim.arena?.kills).toBe(0);
    expect(a.p.xp).toBe(xp);
    // The vessels stay bound and keep their spirit.
    expect(a.p.warband).toEqual(warband);
    expect(spiritReservedFor(a.p)).toBe(spirit);
    // The living member's warband is untouched.
    expect(minionsOf(sim, b.id)).toHaveLength(5);

    // Well past the minion and player respawn times: still dead, still no warband.
    for (let i = 0; i < (SIM.playerRespawnSeconds + MINIONS.respawnSeconds + 2) * SIM.tickRate; i++) sim.step();
    expect(a.p.respawnIn).not.toBeNull();
    expect(minionsOf(sim, a.id)).toEqual([]);
    // A vessel bound while down does not bring one back either.
    expect(sim.unequipVessel(a.id, 0)).toBeNull();
    const brute = a.p.inventory.find((uid) => uid !== null && a.p.items.get(uid)?.kind === 'vessel' && uid !== warband[1]);
    if (brute === undefined || brute === null) throw new Error('no brute in the bag');
    expect(sim.equipVessel(a.id, brute, 0)).toBeNull();
    for (let i = 0; i < 5; i++) sim.step();
    expect(minionsOf(sim, a.id)).toEqual([]);
  });

  it('come back with the warband when the run ends and the member goes back to the gate', () => {
    const run = new Simulation(10, { kind: 'testground' });
    startArena(run, 1);
    const a = packBinder(run, 'a');
    dealDamage(run, a.id, 1_000_000, a.id, []);
    run.step();
    expect(minionsOf(run, a.id)).toEqual([]);
    // The whole party is down: the run is over, and the score screen keeps the warband away.
    for (let i = 0; i < 10 * SIM.tickRate; i++) run.step();
    expect(minionsOf(run, a.id)).toEqual([]);
    // The server moves the character out the way it moves any room change.
    const save = run.exportPlayer(a.id);
    if (!save) throw new Error('no save');
    run.removePlayer(a.id);
    expect(run.world.minion.size).toBe(0);
    const gate = new Simulation(11, { kind: 'testground' });
    const back = gate.addPlayer('a', 'binder', 'A', save);
    gate.step();
    expect(minionsOf(gate, back)).toHaveLength(5);
  });

  it('outside the Arena the warband still stands down instead', () => {
    const sim = new Simulation(12, { kind: 'testground' });
    const a = packBinder(sim, 'a');
    dealDamage(sim, a.id, 1_000_000, a.id, []);
    sim.step();
    const left = minionsOf(sim, a.id);
    expect(left).toHaveLength(5);
    expect(left.every((m) => sim.world.minion.get(m)?.standingDown === true)).toBe(true);
  });
});

describe('minion pathing behind the town fence', () => {
  // The town (in its own coordinates, offset by T): its east fence runs along x = 2140 with the gate between y = 760 and 940.
  function townFence() {
    const sim = new Simulation(4, { kind: 'world', seed: 3 });
    const fence = sim.mapDef.obstacles.find((o) => o.kind === 'fence' && o.shape.type === 'capsule' && o.shape.ax === T.x + 2140 && o.shape.by === T.y + 760);
    if (!fence) throw new Error('the town layout has no east fence');
    const b = binderOn(sim);
    b.pos.x = T.x + 2060;
    b.pos.y = T.y + 400;
    b.p.trail = [];
    const mpos = sim.world.position.get(b.m);
    if (!mpos) throw new Error('setup');
    mpos.x = T.x + 2220;
    mpos.y = T.y + 400;
    return { sim, mpos, ...b };
  }

  it('finds a nav route through the gate', () => {
    const { sim } = townFence();
    const route = findNavPath(sim.map, { x: T.x + 2220, y: T.y + 400 }, { x: T.x + 2060, y: T.y + 400 }, 2500);
    expect(route).not.toBeNull();
    expect(route?.some((r) => r.y > T.y + 760 && r.y < T.y + 940 && Math.abs(r.x - (T.x + 2140)) < 40)).toBe(true);
    expect(route?.at(-1)).toEqual({ x: T.x + 2060, y: T.y + 400 });
  });

  it('walks round through the gate after a teleport left it outside with no trail', () => {
    const { sim, mpos, pos, m } = townFence();
    let throughGate = false;
    let steps = 0;
    for (; steps < 12 * SIM.tickRate; steps++) {
      sim.step();
      if (mpos.y > T.y + 760 && mpos.y < T.y + 940 && Math.abs(mpos.x - (T.x + 2140)) < 40) throughGate = true;
      if (mpos.x < T.x + 2140 && dist(mpos, pos) < 120) break;
    }
    expect(sim.world.isAlive(m)).toBe(true);
    expect(mpos.x).toBeLessThan(T.x + 2140);
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
    expect(mpos.x).toBeGreaterThan(T.x + 2140);
    for (let i = 0; i < 1 * SIM.tickRate; i++) sim.step();
    expect(mpos.x).toBeLessThan(T.x + 2140);
    expect(dist(mpos, pos)).toBeLessThan(80);
  });

  it('drops a route whose goal has moved on when the replan is refused, instead of walking it', () => {
    const { sim, mpos, m } = townFence();
    const mc = sim.world.minion.get(m);
    if (!mc) throw new Error('setup');
    // A route planned a tick ago toward a goal far south; the master is now north-west, out of sight.
    mc.path = [{ x: T.x + 2230, y: T.y + 1400 }];
    mc.pathGoal = sim.map.navCell(T.x + 2230, T.y + 1400);
    mc.pathTick = sim.tick;
    const stale = { x: T.x + 2230, y: T.y + 1400 };
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
    const sim = new Simulation(4, { kind: 'world', seed: 3 });
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
    b.pos.x = T.x + 2060;
    b.pos.y = T.y + 400;
    b.p.trail = [];
    const minions = b.p.minions.filter((x): x is EntityId => x !== null && x !== undefined);
    expect(minions.length).toBe(count);
    for (const [k, id] of minions.entries()) {
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('setup');
      mp.x = T.x + 2220 + (k % 2) * spacing;
      mp.y = T.y + 200 + Math.floor(k / 2) * spacing;
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
      expect(mp.x).toBeLessThan(T.x + 2140);
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
