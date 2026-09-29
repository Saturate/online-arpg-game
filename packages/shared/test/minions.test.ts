import { describe, expect, it } from 'vitest';
import { Simulation, SIM, SKILL_BUTTONS, type EntityId } from '../src/index.js';

function binder(seed = 1) {
  const sim = new Simulation(seed);
  const id = sim.addPlayer('c', 'binder');
  sim.step();
  const p = sim.world.player.get(id)!;
  return { sim, id, p };
}

describe('minion AI', () => {
  it('focuses the enemy its master last hit', () => {
    const { sim, id, p } = binder();
    const pos = sim.world.position.get(id)!;
    const near = sim.spawnEnemy('chaser', pos.x + 120, pos.y);
    const far = sim.spawnEnemy('chaser', pos.x - 250, pos.y);
    sim.world.health.get(near)!.life = 10_000;
    sim.world.health.get(far)!.life = 10_000;
    // The binder's Bone Spear (slot 2) hits the far one.
    sim.applyInput(id, { seq: 0, moveDir: { x: 0, y: 0 }, aimAngle: Math.PI, buttons: SKILL_BUTTONS[1] });
    for (let i = 0; i < 20; i++) sim.step();
    expect(p.focusTarget).toBe(far);
    const targets = p.minions.filter((m): m is EntityId => m !== null).map((m) => sim.world.minion.get(m)?.targetId);
    expect(targets).toContain(far);
  });

  it('follows the breadcrumb trail around a wall instead of sticking to it', () => {
    const sim = new Simulation(3, { kind: 'arena' });
    const id = sim.addPlayer('c', 'binder');
    sim.step();
    const p = sim.world.player.get(id)!;
    const wall = sim.mapDef.obstacles.find((o) => o.kind === 'wall' && o.shape.type === 'capsule' && o.shape.ay === o.shape.by);
    if (!wall || wall.shape.type !== 'capsule') throw new Error('arena has no horizontal wall');
    const { ax, bx, ay } = wall.shape;
    const midX = (ax + bx) / 2;
    // Walk the master around the end of the wall, laying a trail, and park them on the far side.
    const route = [
      { x: midX, y: ay + 80 },
      { x: bx + 60, y: ay + 80 },
      { x: bx + 60, y: ay - 80 },
      { x: midX, y: ay - 80 },
    ];
    p.trail = route.map((r) => ({ ...r }));
    sim.world.position.set(id, { ...route[3]! });
    const m = p.minions[0]!;
    sim.world.position.set(m, { x: midX, y: ay + 60 });
    for (let i = 0; i < 200; i++) sim.step();
    const mp = sim.world.position.get(m)!;
    expect(mp.y).toBeLessThan(ay);
  });

  it('archers do not fire without line of sight', () => {
    const sim = new Simulation(5, { kind: 'arena' });
    const id = sim.addPlayer('c', 'binder');
    sim.step();
    const p = sim.world.player.get(id)!;
    const archer = p.minions.find((m) => m !== null && sim.world.minion.get(m)?.typeId === 'skeleton_archer')!;
    const rock = sim.mapDef.obstacles.find((o) => o.kind === 'rock' && o.shape.type === 'circle' && o.shape.r > 40);
    if (!rock || rock.shape.type !== 'circle') throw new Error('no big rock');
    const { x, y, r } = rock.shape;
    sim.world.position.set(archer, { x: x - r - 30, y });
    sim.world.position.set(id, { x: x - r - 60, y });
    const e = sim.spawnEnemy('chaser', x + r + 30, y);
    sim.world.health.get(e)!.life = 10_000;
    const before = sim.world.projectile.size;
    sim.step();
    expect(sim.world.projectile.size).toBe(before);
    expect(SIM.dt).toBeGreaterThan(0);
  });
});
