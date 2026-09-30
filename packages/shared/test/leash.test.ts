import { describe, expect, it } from 'vitest';
import { SIM, Simulation, STREAMING, WILDS, type EntityId, type MapDescriptor } from '../src/index.js';
import { alertPack, spawnEnemy } from '../src/sim/enemies.js';
import { isAsleep, sleepingEnemies } from '../src/sim/streaming.js';

const STEPPE: MapDescriptor = { kind: 'zone', zone: 'steppe', seed: 77 };

interface Lane {
  sim: Simulation;
  id: EntityId;
  home: { x: number; y: number };
  dir: { x: number; y: number };
}

/**
 * A lone Chaser at the start of a long clear lane, so it chases in a straight line and nothing else
 * decides where it goes. Packs near the lane may join in; only this monster is checked.
 */
function lane(length: number): Lane {
  const sim = new Simulation(3, STEPPE);
  const map = sim.map;
  for (let y = 400; y < map.height - 400; y += 200) {
    for (let x = 400; x < map.width - 400; x += 200) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const dir = { x: Math.cos(a), y: Math.sin(a) };
        const ex = x + dir.x * length;
        const ey = y + dir.y * length;
        if (ex < 100 || ey < 100 || ex > map.width - 100 || ey > map.height - 100) continue;
        if (map.pointBlocked(x, y, 20, 'move') || !map.lineClear(x, y, ex, ey, 20, 'move')) continue;
        const id = spawnEnemy(sim, 'chaser', x, y, { rare: false, level: 1, aggro: false });
        const e = sim.world.enemy.get(id);
        const h = sim.world.health.get(id);
        if (!e || !h) throw new Error('spawn');
        h.life = h.maxLife = 1e9;
        return { sim, id, home: { x: e.homeX, y: e.homeY }, dir };
      }
    }
  }
  throw new Error('no clear lane');
}

function godPlayerAt(sim: Simulation, x: number, y: number): EntityId {
  const pid = sim.addPlayer('p', 'mage', 'P', undefined, { x, y });
  const p = sim.world.player.get(pid);
  if (p) p.god = true;
  return pid;
}

function fromHome(l: Lane): number {
  const p = l.sim.world.position.get(l.id);
  return p ? Math.hypot(p.x - l.home.x, p.y - l.home.y) : NaN;
}

describe('the leash', () => {
  it('sends a monster all the way home when its target stands beyond the leash, where it stays', () => {
    const l = lane(1800);
    const { sim, id } = l;
    const beyond = WILDS.leashDistance + 400;
    godPlayerAt(sim, l.home.x + l.dir.x * beyond, l.home.y + l.dir.y * beyond);
    alertPack(sim, id);
    const e = sim.world.enemy.get(id);
    if (!e) throw new Error('setup');
    let farthest = 0;
    let t = 0;
    for (; t < 40 * SIM.tickRate && e.aggro; t++) {
      sim.step();
      farthest = Math.max(farthest, fromHome(l));
    }
    // It reached the leash, turned, and went idle at home instead of hovering at the edge.
    expect(farthest).toBeGreaterThan(WILDS.leashDistance);
    expect(farthest).toBeLessThan(WILDS.leashDistance + 20);
    expect(e.aggro).toBe(false);
    expect(e.homeward).toBeNull();
    expect(fromHome(l)).toBeLessThan(25);
    // Its target is still there, but out of aggro range from home: it stays put.
    for (let k = 0; k < 5 * SIM.tickRate; k++) sim.step();
    expect(e.aggro).toBe(false);
    expect(fromHome(l)).toBeLessThan(40);
  });

  it('falls asleep at home once the target that dragged it out has gone far away', () => {
    const l = lane(1800);
    const { sim, id } = l;
    const beyond = WILDS.leashDistance + 400;
    const pid = godPlayerAt(sim, l.home.x + l.dir.x * beyond, l.home.y + l.dir.y * beyond);
    alertPack(sim, id);
    const e = sim.world.enemy.get(id);
    const ppos = sim.world.position.get(pid);
    if (!e || !ppos) throw new Error('setup');
    for (let t = 0; t < 30 * SIM.tickRate && e.homeward === null; t++) sim.step();
    expect(e.homeward).not.toBeNull();
    // The player walks off to the far corner, well out of the awake radius around the monster's home.
    const corners = [
      { x: 150, y: 150 },
      { x: sim.map.width - 150, y: 150 },
      { x: 150, y: sim.map.height - 150 },
      { x: sim.map.width - 150, y: sim.map.height - 150 },
    ];
    const corner = corners.reduce((a, b) => (Math.hypot(b.x - l.home.x, b.y - l.home.y) > Math.hypot(a.x - l.home.x, a.y - l.home.y) ? b : a));
    expect(Math.hypot(corner.x - l.home.x, corner.y - l.home.y)).toBeGreaterThan(STREAMING.awakeChunks * STREAMING.chunkSize + 1500);
    ppos.x = corner.x;
    ppos.y = corner.y;
    for (let t = 0; t < 60 * SIM.tickRate && e.aggro; t++) {
      sim.step();
      expect(isAsleep(sleepingEnemies(sim), id, e)).toBe(false);
    }
    expect(e.aggro).toBe(false);
    for (let k = 0; k < STREAMING.recomputeEveryTicks; k++) sim.step();
    expect(isAsleep(sleepingEnemies(sim), id, e)).toBe(true);
  });

  it('ignores a target right beside it for the first seconds home, then turns on it', () => {
    const l = lane(1800);
    const { sim, id } = l;
    const beyond = WILDS.leashDistance + 400;
    const pid = godPlayerAt(sim, l.home.x + l.dir.x * beyond, l.home.y + l.dir.y * beyond);
    alertPack(sim, id);
    const e = sim.world.enemy.get(id);
    const ppos = sim.world.position.get(pid);
    if (!e || !ppos) throw new Error('setup');
    for (let t = 0; t < 30 * SIM.tickRate && e.homeward === null; t++) sim.step();
    expect(e.homeward).not.toBeNull();
    const graceTicks = Math.round(WILDS.leashReturnSeconds * SIM.tickRate);
    // The player follows it home, staying just behind it; it keeps walking away from them.
    const start = fromHome(l);
    for (let k = 0; k < graceTicks - 2; k++) {
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('gone');
      ppos.x = mp.x + l.dir.x * 120;
      ppos.y = mp.y + l.dir.y * 120;
      sim.step();
      expect(e.homeward).not.toBeNull();
    }
    expect(fromHome(l)).toBeLessThan(start - 0.7 * 125 * ((graceTicks - 2) / SIM.tickRate));
    for (let k = 0; k < 6; k++) {
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('gone');
      ppos.x = mp.x + l.dir.x * 120;
      ppos.y = mp.y + l.dir.y * 120;
      sim.step();
    }
    expect(e.homeward).toBeNull();
    expect(e.aggro).toBe(true);
  });

  it('leaves a chase inside the leash as it was', () => {
    const l = lane(1800);
    const { sim, id } = l;
    const pid = godPlayerAt(sim, l.home.x + l.dir.x * 800, l.home.y + l.dir.y * 800);
    alertPack(sim, id);
    const e = sim.world.enemy.get(id);
    const ppos = sim.world.position.get(pid);
    if (!e || !ppos) throw new Error('setup');
    for (let t = 0; t < 12 * SIM.tickRate; t++) {
      sim.step();
      expect(e.homeward).toBeNull();
      expect(e.aggro).toBe(true);
    }
    const mp = sim.world.position.get(id);
    if (!mp) throw new Error('gone');
    expect(Math.hypot(mp.x - ppos.x, mp.y - ppos.y)).toBeLessThan(60);
  });
});
