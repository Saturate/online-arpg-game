import { describe, expect, it } from 'vitest';
import { SIM, Simulation, createVessel, type EntityId, type Vec2 } from '../src/index.js';
import { knockback } from '../src/sim/combat.js';

/**
 * The town's north fence: in the default layout it runs along y = 60 (town coordinates) from x = 60
 * to 1010 and from 1190 to 2140, with the north gate between.
 */
const FENCE_Y = 60;
const GATE = { x0: 1010, x1: 1190 };

/** Whether a move from `a` to `b` (town coordinates) crossed the fence line away from the gate. */
function crossedFence(a: Vec2, b: Vec2): boolean {
  if ((a.y - FENCE_Y) * (b.y - FENCE_Y) > 0) return false;
  const t = (FENCE_Y - a.y) / (b.y - a.y || 1);
  const x = a.x + (b.x - a.x) * t;
  return x > 60 && x < 2140 && !(x > GATE.x0 && x < GATE.x1);
}

describe('fast movers and the town fence', () => {
  it('a hound pack sprinting to catch up with its master never crosses the fence', () => {
    const sim = new Simulation(4, { kind: 'world', seed: 1 });
    const T = sim.mapDef.townAt ?? { x: 0, y: 0 };
    const id = sim.addPlayer('c', 'binder');
    const p = sim.world.player.get(id);
    if (!p) throw new Error('setup');
    p.stats.spiritMax = 1000;
    p.level = 30;
    sim.step();
    const v = { ...createVessel(sim.newItemUid(), sim.rng, 'relic', 'hound', 1), affixes: [], pack: 4 };
    p.items.set(v.uid, v);
    p.inventory[p.inventory.indexOf(null)] = v.uid;
    expect(sim.equipVessel(id, v.uid, 1)).toBeNull();
    sim.step();
    const dogs = [...sim.world.minion.entries()].filter(([, m]) => m.ownerId === id && m.pack?.role === 'mate').map(([m]) => m);
    expect(dogs.length).toBeGreaterThanOrEqual(2);

    // Master just across the fence, the pack inside it more than the catch-up distance away, so the
    // dogs sprint (about 24 units a tick for a packmate, whose radius is 10). With no route search
    // to spare (a busy tick's budget, held off here by marking a search as just tried) a dog steps
    // straight at its goal, into the fence.
    for (const start of [300, 600, 1500, 1800]) {
      const master = sim.map.findOpen(T.x + start, T.y - 360, SIM.playerRadius);
      const mp = sim.world.position.get(id);
      if (!mp) throw new Error('no master');
      mp.x = master.x;
      mp.y = master.y;
      p.trail.length = 0;
      const last = new Map<EntityId, Vec2>();
      for (const [k, m] of dogs.entries()) {
        const pos = sim.world.position.get(m);
        const at = sim.map.findOpen(T.x + start + k * 30, T.y + 120, 24);
        if (!pos) continue;
        pos.x = at.x;
        pos.y = at.y;
        last.set(m, { x: at.x - T.x, y: at.y - T.y });
      }
      for (let t = 0; t < 2 * SIM.tickRate; t++) {
        for (const m of dogs) {
          const mc = sim.world.minion.get(m);
          if (!mc) continue;
          mc.pathTick = sim.tick;
          mc.path.length = 0;
        }
        p.trail.length = 0;
        sim.step();
        for (const m of dogs) {
          const pos = sim.world.position.get(m);
          const prev = last.get(m);
          if (!pos || !prev) continue;
          const now = { x: pos.x - T.x, y: pos.y - T.y };
          // A pull-over beside the master is a teleport, not a walk through the fence.
          const walked = Math.hypot(now.x - prev.x, now.y - prev.y) < 60;
          expect(walked && crossedFence(prev, now), `dog from x ${start}, tick ${t}: ${Math.round(prev.x)},${Math.round(prev.y)} to ${Math.round(now.x)},${Math.round(now.y)}`).toBe(false);
          last.set(m, now);
        }
      }
    }
  });

  it('a monster knocked hard into the fence stays on its side', () => {
    const sim = new Simulation(4, { kind: 'world', seed: 1 });
    const T = sim.mapDef.townAt ?? { x: 0, y: 0 };
    // Just outside the north fence, thrown south (into town) by stacked hits.
    for (const x of [300, 700, 1500]) {
      const id = sim.spawnEnemy('chaser', T.x + x, T.y + FENCE_Y - 30);
      const pos = sim.world.position.get(id);
      if (!pos) throw new Error('setup');
      const start = { x: pos.x - T.x, y: pos.y - T.y };
      for (let k = 0; k < 4; k++) knockback(sim, id, pos.x, pos.y - 50, 320);
      let prev = start;
      for (let t = 0; t < 10; t++) {
        sim.step();
        const now = { x: pos.x - T.x, y: pos.y - T.y };
        expect(crossedFence(prev, now), `monster at x ${x}, tick ${t}`).toBe(false);
        prev = now;
      }
    }
  });

  it('the Hound Leader does not pounce over a fence at a monster on the other side', () => {
    const sim = new Simulation(4, { kind: 'world', seed: 1 });
    const T = sim.mapDef.townAt ?? { x: 0, y: 0 };
    const id = sim.addPlayer('c', 'binder');
    const p = sim.world.player.get(id);
    if (!p) throw new Error('setup');
    p.stats.spiritMax = 1000;
    p.level = 30;
    sim.step();
    const v = { ...createVessel(sim.newItemUid(), sim.rng, 'relic', 'hound', 1), affixes: [], pack: 2 };
    p.items.set(v.uid, v);
    p.inventory[p.inventory.indexOf(null)] = v.uid;
    expect(sim.equipVessel(id, v.uid, 1)).toBeNull();
    sim.step();
    const leader = [...sim.world.minion.entries()].find(([, m]) => m.ownerId === id && m.pack?.role === 'leader');
    if (!leader) throw new Error('no leader');
    const [lid, lm] = leader;
    const lpos = sim.world.position.get(lid);
    const mp = sim.world.position.get(id);
    if (!lpos || !mp) throw new Error('setup');
    // Leader and master inside the north fence, a monster just outside it, well inside leap range.
    const inside = sim.map.findOpen(T.x + 500, T.y + FENCE_Y + 70, 24);
    const master = sim.map.findOpen(T.x + 500, T.y + FENCE_Y + 140, SIM.playerRadius);
    Object.assign(lpos, inside);
    Object.assign(mp, master);
    const enemy = sim.spawnEnemy('chaser', inside.x, T.y + FENCE_Y - 160);
    const eh = sim.world.health.get(enemy);
    if (eh) eh.life = eh.maxLife = 100_000;
    lm.targetId = enemy;
    lm.leapCooldown = 0;
    for (let t = 0; t < 10; t++) {
      sim.step();
      expect(lm.leap, `tick ${t}: leapt over the fence`).toBeNull();
    }
  });
});
