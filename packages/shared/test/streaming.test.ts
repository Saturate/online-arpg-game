import { describe, expect, it } from 'vitest';
import { applyDev, buildMap, NET, SKILL_BUTTONS, SIM, Simulation, startArena, STREAMING, type EntityId, type MapDescriptor } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';
import { chunkAwake, isAsleep, setStreaming, sleepingEnemies, spawnEverywhere, streamingStats } from '../src/sim/streaming.js';

const STEPPE: MapDescriptor = { kind: 'zone', zone: 'steppe', seed: 77 };

/** Everything about a monster that its AI changes, at full precision. */
function monsterState(sim: Simulation, id: EntityId): string {
  const e = sim.world.enemy.get(id);
  const p = sim.world.position.get(id);
  const h = sim.world.health.get(id);
  if (!e || !p || !h) return 'gone';
  return JSON.stringify([p.x, p.y, h.life, e.aggro, e.facing, e.cooldowns, e.fireCooldown, e.contactCooldown, e.cast, e.burrowed, e.knockX, e.knockY]);
}

function asleepNow(sim: Simulation, id: EntityId): boolean {
  const e = sim.world.enemy.get(id);
  return e !== undefined && isAsleep(sleepingEnemies(sim), id, e);
}

function nearestDist(sim: Simulation, id: EntityId, others: readonly EntityId[]): number {
  const p = sim.world.position.get(id);
  let best = Infinity;
  for (const o of others) {
    const q = sim.world.position.get(o);
    if (p && q) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return best;
}

function addGodPlayer(sim: Simulation, x: number, y: number): EntityId {
  const id = sim.addPlayer(`p${x}:${y}`, 'mage', 'P', undefined, { x, y });
  const p = sim.world.player.get(id);
  if (p) p.god = true;
  return id;
}

/**
 * A zone room with every pack spawned, as rooms were before chunks spawned their packs on first
 * wake (step 3, tested in zoneChunks.test.ts): sleep is about monsters that exist far away.
 */
function steppe(seed: number): Simulation {
  const sim = new Simulation(seed, STEPPE);
  spawnEverywhere(sim);
  return sim;
}

function steps(sim: Simulation, n: number): void {
  for (let i = 0; i < n; i++) sim.step();
}

describe('world streaming: config', () => {
  it('keeps every sleeping monster well outside the network interest radius', () => {
    // A sleeper is at least this far from every player at a recompute; between recomputes a player
    // walks a few dozen units, so the margin over the interest radius is what they can close.
    const minSleeperDistance = STREAMING.awakeChunks * STREAMING.chunkSize;
    const travel = (STREAMING.recomputeEveryTicks / SIM.tickRate) * 600;
    expect(minSleeperDistance - travel).toBeGreaterThan(NET.interestRadius + 500);
    expect(STREAMING.jumpDistance).toBeLessThan(minSleeperDistance - NET.interestRadius);
  });
});

describe('world streaming: sleep and wake', () => {
  it('leaves far monsters untouched while near ones run', () => {
    const sim = steppe(5);
    const pid = addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y);
    sim.step();
    const sleepers = [...sim.world.enemy.keys()].filter((id) => asleepNow(sim, id));
    expect(sleepers.length).toBeGreaterThan(20);
    for (const id of sleepers) expect(nearestDist(sim, id, [pid])).toBeGreaterThan(STREAMING.awakeChunks * STREAMING.chunkSize);
    const before = new Map(sleepers.map((id) => [id, monsterState(sim, id)]));
    steps(sim, 100);
    for (const id of sleepers) expect(monsterState(sim, id), `monster ${id}`).toBe(before.get(id));

    // With streaming off the same idle monsters shuffle about, so the check above is not vacuous.
    const awake = steppe(5);
    setStreaming(awake, false);
    addGodPlayer(awake, awake.mapDef.spawn.x, awake.mapDef.spawn.y);
    steps(awake, 101);
    expect(sleepers.some((id) => monsterState(awake, id) !== before.get(id))).toBe(true);
  });

  it('wakes monsters as a player walks up, and never lets one sleep inside the interest radius', () => {
    const sim = steppe(9);
    const pid = addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y);
    sim.step();
    const far = [...sim.world.enemy.keys()].filter((id) => asleepNow(sim, id));
    expect(far.length).toBeGreaterThan(0);
    const woke = new Set<EntityId>();
    // Walk east across the whole zone; every tick, no sleeper may be close enough to be seen.
    for (let t = 1; t <= 600; t++) {
      sim.applyInput(pid, { seq: t, moveDir: { x: 1, y: 0 }, aimAngle: 0, buttons: 0 });
      sim.step();
      for (const [id] of sim.world.enemy) {
        if (asleepNow(sim, id)) expect(nearestDist(sim, id, [pid])).toBeGreaterThan(NET.interestRadius + 500);
        else if (far.includes(id)) woke.add(id);
      }
    }
    expect(woke.size).toBeGreaterThan(0);
  });

  it('wakes a sleeper at once when a player arrives next to it through a portal', () => {
    const sim = steppe(9);
    const pid = addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y);
    sim.step();
    const id = [...sim.world.enemy.keys()].find((e) => asleepNow(sim, e));
    const target = id === undefined ? undefined : sim.world.position.get(id);
    const pos = sim.world.position.get(pid);
    if (id === undefined || !target || !pos) throw new Error('no sleeper');
    pos.x = target.x + 300;
    pos.y = target.y;
    sim.step();
    expect(asleepNow(sim, id)).toBe(false);
    expect(streamingStats(sim).asleep).toBeGreaterThan(0);
  });

  it('wakes the monsters around the spawn on the tick a player respawns there', () => {
    const sim = steppe(9);
    const spawn = sim.mapDef.spawn;
    const corners = [
      { x: 150, y: 150 },
      { x: sim.map.width - 150, y: 150 },
      { x: 150, y: sim.map.height - 150 },
      { x: sim.map.width - 150, y: sim.map.height - 150 },
    ];
    const far = corners.reduce((a, b) => (Math.hypot(b.x - spawn.x, b.y - spawn.y) > Math.hypot(a.x - spawn.x, a.y - spawn.y) ? b : a));
    const pid = addGodPlayer(sim, far.x, far.y);
    steps(sim, STREAMING.recomputeEveryTicks + 1);
    const nearSpawn = [...sim.world.enemy.keys()].filter((id) => {
      const q = sim.world.position.get(id);
      return q !== undefined && Math.hypot(q.x - spawn.x, q.y - spawn.y) <= NET.interestRadius + 500 && asleepNow(sim, id);
    });
    expect(nearSpawn.length).toBeGreaterThan(5);
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    // Dead far away with one tick left to wait: this tick's `updatePlayers` puts them at the spawn.
    p.respawnIn = 1 / SIM.tickRate;
    for (let t = 0; t < 20; t++) {
      sim.step();
      const pos = sim.world.position.get(pid);
      if (!pos) throw new Error('no position');
      expect(p.respawnIn).toBeNull();
      expect(Math.hypot(pos.x - spawn.x, pos.y - spawn.y)).toBeLessThan(200);
      for (const [id] of sim.world.enemy) {
        if (asleepNow(sim, id)) expect(nearestDist(sim, id, [pid]), `tick ${t}`).toBeGreaterThan(NET.interestRadius + 500);
      }
    }
  });

  it('keeps a chasing monster awake outside the awake chunks, and lets it sleep once it is home and idle', () => {
    const sim = steppe(5);
    const pid = addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y);
    sim.step();
    const id = [...sim.world.enemy.keys()].find((e) => asleepNow(sim, e));
    const pos = id === undefined ? undefined : sim.world.position.get(id);
    if (id === undefined || !pos) throw new Error('no sleeper');
    const home = { x: pos.x, y: pos.y };
    // A long shot from far away: the hit aggroes it though its chunk sleeps.
    dealDamage(sim, id, 1, pid, []);
    const e = sim.world.enemy.get(id);
    expect(e?.aggro).toBe(true);
    let movedWhileAway = false;
    for (let t = 0; t < 100; t++) {
      sim.step();
      const p = sim.world.position.get(id);
      if (p && !chunkAwake(sim, p.x, p.y) && Math.hypot(p.x - home.x, p.y - home.y) > 1) movedWhileAway = true;
      expect(asleepNow(sim, id)).toBe(false);
    }
    expect(movedWhileAway).toBe(true);

    // Its target dies (and waits a long time to respawn): it walks home, heals, goes idle and sleeps.
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    p.respawnIn = 1e6;
    for (let t = 0; t < 2000 && e?.aggro; t++) {
      expect(asleepNow(sim, id)).toBe(false);
      sim.step();
    }
    expect(e?.aggro).toBe(false);
    steps(sim, STREAMING.recomputeEveryTicks);
    const back = sim.world.position.get(id);
    if (!back) throw new Error('gone');
    expect(Math.hypot(back.x - home.x, back.y - home.y)).toBeLessThan(40);
    expect(asleepNow(sim, id)).toBe(true);
  });
});

/**
 * Compared well past the interest radius, up to near the edge of the awake area: everything a player
 * could meet in the next seconds must match too. The last 200 units are left out, where an awake
 * monster can still brush a sleeper that the run without sleep would have shuffled. So are monsters
 * that slept at any time in the run (players circle about 275 units, so a pack near the edge can
 * sleep early on and be inside at the end), and monsters pressed against them: they stood still
 * while their twins shuffled, by design.
 */
const COMPARE_RADIUS = STREAMING.awakeChunks * STREAMING.chunkSize - 200;

/** Two runs of the same seed, with and without sleep, driven by the same inputs. */
function twin(desc: MapDescriptor, seed: number, setup: (sim: Simulation) => EntityId[], ticks: number, cast = true): { on: Simulation; off: Simulation; players: EntityId[]; nearEventsOn: string[]; nearEventsOff: string[]; slept: Set<EntityId> } {
  const on = new Simulation(seed, desc);
  const off = new Simulation(seed, desc);
  for (const sim of [on, off]) spawnEverywhere(sim);
  setStreaming(off, false);
  const players = setup(on);
  expect(setup(off)).toEqual(players);
  const nearEventsOn: string[] = [];
  const nearEventsOff: string[] = [];
  const slept = new Set<EntityId>();
  for (let t = 1; t <= ticks; t++) {
    for (const [sim, log] of [
      [on, nearEventsOn],
      [off, nearEventsOff],
    ] as const) {
      const a = (t / SIM.tickRate) * 0.8;
      for (const [k, pid] of players.entries()) {
        sim.applyInput(pid, { seq: t, moveDir: { x: Math.cos(a + k), y: Math.sin(a + k) }, aimAngle: a * 3, buttons: cast && t % 10 < 5 ? (SKILL_BUTTONS[0] ?? 0) : 0 });
      }
      sim.step();
      const near = sim.takeEvents().filter((ev) => players.some((pid) => {
        const p = sim.world.position.get(pid);
        return p !== undefined && Math.hypot(ev.x - p.x, ev.y - p.y) <= COMPARE_RADIUS;
      }));
      log.push(JSON.stringify(near));
    }
    touchedBySleep(on, slept);
  }
  return { on, off, players, nearEventsOn, nearEventsOff, slept };
}

/**
 * Adds every monster asleep now, and every awake one pressed against one already in the set, as far
 * as the chain of contacts runs: a pack straddling the edge of the awake area pushes its awake half
 * about through its sleeping half's twin in the run without sleep (see Limits in world-streaming.md).
 */
function touchedBySleep(sim: Simulation, out: Set<EntityId>): void {
  for (const id of sim.world.enemy.keys()) if (asleepNow(sim, id)) out.add(id);
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of sim.world.enemy.keys()) {
      if (out.has(id)) continue;
      const p = sim.world.position.get(id);
      const r = sim.world.radius.get(id) ?? 0;
      for (const o of out) {
        const q = sim.world.position.get(o);
        if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) > r + (sim.world.radius.get(o) ?? 0) + 4) continue;
        out.add(id);
        grew = true;
        break;
      }
    }
  }
}

/** Every monster near a player that never slept, with its full state, and the players themselves. */
function nearWorld(sim: Simulation, players: readonly EntityId[], slept: ReadonlySet<EntityId> = new Set()): string {
  const out: string[] = [];
  for (const id of [...sim.world.enemy.keys()].sort((a, b) => a - b)) {
    if (!slept.has(id) && nearestDist(sim, id, players) <= COMPARE_RADIUS) out.push(`${id}:${monsterState(sim, id)}`);
  }
  for (const pid of players) {
    const p = sim.world.player.get(pid);
    const pos = sim.world.position.get(pid);
    out.push(JSON.stringify([pos?.x, pos?.y, sim.world.health.get(pid)?.life, p?.xp, p?.heat]));
  }
  return out.join('\n');
}

function allMonsters(sim: Simulation): string {
  return [...sim.world.enemy.keys()].map((id) => `${id}:${monsterState(sim, id)}`).join('\n');
}

describe('world streaming: nothing changes near players', () => {
  it('a zone fight plays out identically with and without sleep', () => {
    const { on, off, players, nearEventsOn, nearEventsOff, slept } = twin(
      STEPPE,
      21,
      (sim) => {
        // Beside the nearest pack, so the fight starts at once; the rest of the zone sleeps.
        const s = sim.mapDef.spawn;
        const pack = [...buildMap(sim.mapDesc).packs].sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
        if (!pack) throw new Error('no packs');
        return [addGodPlayer(sim, pack.x - 250, pack.y), addGodPlayer(sim, pack.x - 200, pack.y + 120)];
      },
      400,
    );
    expect(streamingStats(on).asleep).toBeGreaterThan(20);
    expect(streamingStats(off).asleep).toBe(0);
    expect(nearEventsOn.some((e) => e.includes('"dmg"'))).toBe(true);
    expect(nearEventsOn).toEqual(nearEventsOff);
    expect(nearWorld(on, players, slept)).toBe(nearWorld(off, players, slept));
    // The comparison is not vacuous: most of what is near the players never slept.
    expect(nearWorld(on, players, slept).split('\n').length).toBeGreaterThan(12);
  });

  it('a dungeon plays out identically near players, and its boss wakes when reached', () => {
    const desc: MapDescriptor = { kind: 'dungeon', seed: 11, level: 3, run: 0 };
    const { on, off, players, nearEventsOn, nearEventsOff } = twin(desc, 3, (sim) => [addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y)], 300);
    expect(nearEventsOn).toEqual(nearEventsOff);
    expect(nearWorld(on, players)).toBe(nearWorld(off, players));

    const boss = [...on.world.enemy].find(([, e]) => e.boss);
    const bpos = boss ? on.world.position.get(boss[0]) : undefined;
    const pos = on.world.position.get(players[0] ?? -1);
    if (!boss || !bpos || !pos) throw new Error('no boss');
    pos.x = bpos.x - 200;
    pos.y = bpos.y;
    on.step();
    expect(asleepNow(on, boss[0])).toBe(false);
    steps(on, 40);
    expect(boss[1].aggro).toBe(true);
  });

  it('the Arena never sleeps anything and matches a run without streaming exactly', () => {
    const { on, off } = twin(
      { kind: 'arena' },
      4,
      (sim) => {
        const ids = [addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y)];
        startArena(sim, 3);
        return ids;
      },
      600,
    );
    expect(on.world.enemy.size).toBeGreaterThan(0);
    expect(streamingStats(on).asleep).toBe(0);
    expect(allMonsters(on)).toBe(allMonsters(off));
  });

  it('the sandbox never sleeps anything and matches a run without streaming exactly', () => {
    const { on, off } = twin(
      { kind: 'flat' },
      6,
      (sim) => {
        const pid = addGodPlayer(sim, sim.mapDef.spawn.x, sim.mapDef.spawn.y);
        // A builder's spawn in the far corner: the flat map is small enough that it stays awake.
        applyDev(sim, pid, { c: 'spawn', enemy: 'chaser', count: 4, rare: false, level: 1, x: 150, y: 150 });
        applyDev(sim, pid, { c: 'spawn', enemy: 'shooter', count: 3, rare: true, level: 2, x: sim.map.width - 150, y: sim.map.height - 150 });
        return [pid];
      },
      300,
    );
    expect(streamingStats(on).asleep).toBe(0);
    expect(allMonsters(on)).toBe(allMonsters(off));
  });
});
