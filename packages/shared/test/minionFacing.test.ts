import { describe, expect, it } from 'vitest';
import { NET, Simulation, createVessel, serializeEntities, snapshotFor, type EntityId } from '../src/index.js';
import { spawnEnemy } from '../src/sim/enemies.js';
import { minionFacing } from '../src/sim/minions.js';

describe('minionFacing', () => {
  it('looks along a real step', () => {
    expect(minionFacing(0, { x: 0, y: 0 }, { x: -5, y: 0 }, 1, null)).toBeCloseTo(Math.PI);
    expect(minionFacing(0, { x: 0, y: 0 }, { x: 0, y: 5 }, 1, null)).toBeCloseTo(Math.PI / 2);
  });

  it('keeps its heading when standing still or nudged', () => {
    expect(minionFacing(2, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, null)).toBe(2);
    expect(minionFacing(2, { x: 0, y: 0 }, { x: 0.3, y: -0.2 }, 1, null)).toBe(2);
  });

  it('looks at a target it can strike, whichever way it steps', () => {
    expect(minionFacing(0, { x: 0, y: 0 }, { x: 5, y: 0 }, 1, { x: 5, y: -20 })).toBeCloseTo(-Math.PI / 2);
  });
});

function packOwner() {
  const sim = new Simulation(11, { kind: 'flat' });
  const id = sim.addPlayer('c1', 'binder');
  const p = sim.world.player.get(id)!;
  p.stats.spiritMax = 1000;
  sim.step();
  const v = { ...createVessel(sim.newItemUid(), sim.rng, 'relic', 'hound', 1), affixes: [], pack: 3 };
  p.items.set(v.uid, v);
  p.inventory[p.inventory.indexOf(null)] = v.uid;
  expect(sim.equipVessel(id, v.uid, 1)).toBeNull();
  sim.step();
  const dogs: EntityId[] = [p.minions[1]!, ...p.packs[1]!.mates];
  return { sim, id, p, dogs };
}

/** The flat test map spawns its own monsters; these tests need the pack alone or with one of theirs. */
function stepWithout(sim: Simulation, keep: EntityId | null): void {
  for (const e of [...sim.world.enemy.keys()]) if (e !== keep) sim.world.destroy(e);
  sim.step();
}

function minionSnapAngle(sim: Simulation, viewer: EntityId, dog: EntityId): number | undefined {
  for (const s of snapshotFor(sim, viewer, serializeEntities(sim), [], NET.interestRadius).entities) if (s.id === dog && s.k === 'minion') return s.a;
  return undefined;
}

describe('Hound pack facing', () => {
  it('faces the way the pack walks, not east', () => {
    const { sim, id, p, dogs } = packOwner();
    for (let i = 0; i < 40; i++) stepWithout(sim, null);
    const pos = sim.world.position.get(id)!;
    // The master walks west; the pack trots after and must face west too.
    p.heading = Math.PI;
    for (let i = 0; i < 40; i++) {
      pos.x -= 8;
      stepWithout(sim, null);
    }
    for (const dog of dogs) {
      const m = sim.world.minion.get(dog)!;
      expect(Math.cos(m.facing), `dog ${dog}`).toBeLessThan(-0.5);
      expect(minionSnapAngle(sim, id, dog)).toBeCloseTo(m.facing, 1);
    }
  });

  it('faces the enemy it bites', () => {
    const { sim, id, dogs } = packOwner();
    for (let i = 0; i < 40; i++) stepWithout(sim, null);
    const pos = sim.world.position.get(id)!;
    const enemy = spawnEnemy(sim, 'bone_golem', pos.x, pos.y - 60, { rare: false, level: 1, aggro: false });
    sim.world.health.get(enemy)!.life = 1e6;
    sim.world.health.get(enemy)!.maxLife = 1e6;
    for (let i = 0; i < 60; i++) stepWithout(sim, enemy);
    const ep = sim.world.position.get(enemy)!;
    let biting = 0;
    for (const dog of dogs) {
      const m = sim.world.minion.get(dog)!;
      const dp = sim.world.position.get(dog)!;
      if (Math.hypot(ep.x - dp.x, ep.y - dp.y) > 60) continue;
      const want = Math.atan2(ep.y - dp.y, ep.x - dp.x);
      expect(Math.cos(m.facing - want), `dog ${dog}`).toBeGreaterThan(0.9);
      biting++;
    }
    expect(biting).toBeGreaterThan(0);
  });
});
