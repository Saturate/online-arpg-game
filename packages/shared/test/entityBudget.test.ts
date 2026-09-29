import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/index.js';
import { spawnProgram } from '../src/sim/spells.js';
import { compileText } from './helpers/spell.js';

/** Most spell entities alive at once when one cast runs to its end on an empty map. */
function enginePeak(text: string): { budget: number; engine: number } {
  const c = compileText(text);
  if (!c.ok) throw new Error(`${text}: ${c.errors.map((e) => e.message).join('; ')}`);
  const sim = new Simulation(3, { kind: 'flat' });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('p', 'mage');
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no player');
  spawnProgram(sim, c.program, pid, pos.x, pos.y, 0);
  let peak = 0;
  for (let t = 0; t < 400; t++) {
    sim.waveTimer = Infinity;
    sim.step();
    const w = sim.world;
    peak = Math.max(peak, w.projectile.size + w.nova.size + w.zone.size);
  }
  return { budget: c.peakEntities, engine: peak };
}

describe('entity budget against the engine', () => {
  // Interval releases with speed and duration affixes, on every form that can release on one.
  it.each([
    'orb[every 0.18s, -35% speed, -35% duration, +10% size, -40% damage] cold split(3) bolt',
    'orb[every 0.2s] cold split(4) bolt',
    'orb[every 0.2s, +50% speed] nova',
    'zone[every 0.2s] lightning nova',
    'zone[every 0.2s, +100% duration] nova[-50% speed]',
    'zone[every 0.25s] split(2) orb',
    'bolt[every 0.1s] split(3) bolt',
    'bolt[every 0.1s, -50% speed] bolt',
  ])('the forge shows what %s really keeps alive', (text) => {
    const { budget, engine } = enginePeak(text);
    expect(budget).toBe(engine);
  });
});
