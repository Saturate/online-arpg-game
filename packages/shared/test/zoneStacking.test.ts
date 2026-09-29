import { describe, expect, it } from 'vitest';
import { compile, NEUTRAL_MODS, SIM, Simulation, type EntityId } from '../src/index.js';
import { spawnSpell } from '../src/sim/spells.js';

const fireZone = compile(['zone', 'fire'], { classId: 'mage', capacity: 7, mods: NEUTRAL_MODS });

/** Damage a dummy takes in two seconds standing in `zones` fire zones from each caster. */
function damageTaken(casters: number, zonesEach: number): number {
  const sim = new Simulation(4);
  sim.waveTimer = Infinity;
  const ids: EntityId[] = [];
  for (let i = 0; i < casters; i++) ids.push(sim.addPlayer(`c${i}`, 'mage'));
  const dummy = sim.spawnEnemy('chaser', 900, 900);
  const h = sim.world.health.get(dummy);
  const e = sim.world.enemy.get(dummy);
  if (!h || !e || !fireZone.ok) throw new Error('setup');
  h.maxLife = 1e9;
  h.life = 1e9;
  e.speedMult = 0;
  for (const caster of ids) for (let z = 0; z < zonesEach; z++) spawnSpell(sim, fireZone.program, caster, 900 + z * 5, 900, 0, null);
  for (let i = 0; i < 2 * SIM.tickRate; i++) sim.step();
  return 1e9 - h.life;
}

describe('ground zones', () => {
  it('one caster\'s overlapping zones hit like one', () => {
    const one = damageTaken(1, 1);
    expect(one).toBeGreaterThan(0);
    expect(damageTaken(1, 4)).toBeCloseTo(one, -1);
  });

  it('zones from different casters still stack', () => {
    expect(damageTaken(2, 1)).toBeGreaterThan(damageTaken(1, 1) * 1.5);
  });
});
