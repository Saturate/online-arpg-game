import { describe, expect, it } from 'vitest';
import { SPELL, Simulation } from '../src/index.js';
import { compileText } from './helpers/spell.js';
import { spawnProgram } from '../src/sim/spells.js';

const bolt = compileText('bolt fire');
const zone = compileText('zone fire');

describe('live spell cap', () => {
  it('ends a player\'s oldest spell entities instead of passing the cap', () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('p', 'mage');
    if (!bolt.ok) throw new Error('bad bolt');
    for (let i = 0; i < 60; i++) spawnProgram(sim, bolt.program, pid, 500, 500 + i, 0);
    sim.world.flushDestroyed();
    const mine = [...sim.world.projectile.values()].filter((p) => p.ownerId === pid);
    expect(mine.length).toBe(SPELL.liveCap.max);
  });

  it('counts zones lighter than projectiles, and each player separately', () => {
    const sim = new Simulation(2);
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'mage');
    if (!zone.ok || !bolt.ok) throw new Error('bad spells');
    for (let i = 0; i < 150; i++) spawnProgram(sim, zone.program, a, 400 + i * 3, 400, 0);
    for (let i = 0; i < 30; i++) spawnProgram(sim, bolt.program, b, 900, 900 + i, 0);
    sim.world.flushDestroyed();
    expect(sim.world.zone.size).toBe(Math.floor(SPELL.liveCap.max / SPELL.liveCap.area));
    expect([...sim.world.projectile.values()].filter((p) => p.ownerId === b).length).toBe(30);
  });
});
