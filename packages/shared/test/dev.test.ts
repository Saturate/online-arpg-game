import { describe, expect, it } from 'vitest';
import { applyDev, parseDevCommand, Simulation } from '../src/index.js';

describe('dev commands', () => {
  it('rejects malformed or out of range commands', () => {
    expect(parseDevCommand({ c: 'spawn', enemy: 'nope', count: 1, level: 1, x: 10, y: 10 })).toBeNull();
    expect(parseDevCommand({ c: 'spawn', enemy: 'chaser', count: 500, level: 1, x: 10, y: 10 })).toBeNull();
    expect(parseDevCommand({ c: 'timeScale', scale: 1000 })).toBeNull();
    expect(parseDevCommand({ c: 'teleport', x: Number.NaN, y: 0 })).toBeNull();
    expect(parseDevCommand('killAll')).toBeNull();
  });

  it('spawns aggroed monsters and clears them', () => {
    const sim = new Simulation(7);
    const pid = sim.addPlayer('d', 'mage');
    const before = sim.world.enemy.size;
    const cmd = parseDevCommand({ c: 'spawn', enemy: 'chaser', count: 4, rare: true, level: 5, x: 600, y: 600 });
    expect(cmd).not.toBeNull();
    if (!cmd) return;
    applyDev(sim, pid, cmd);
    expect(sim.world.enemy.size).toBe(before + 4);
    applyDev(sim, pid, { c: 'killAll' });
    sim.world.flushDestroyed();
    expect(sim.world.enemy.size).toBe(0);
  });

  it('gives items of the requested gear slot', () => {
    const sim = new Simulation(8);
    const pid = sim.addPlayer('d', 'warrior');
    applyDev(sim, pid, { c: 'give', item: 'gear', tier: 'rare', level: 5, category: 'helmet' });
    const p = sim.world.player.get(pid);
    const helmets = [...(p?.items.values() ?? [])].filter((i) => i.kind === 'gear' && i.category === 'helmet');
    expect(helmets).toHaveLength(1);
  });
});
