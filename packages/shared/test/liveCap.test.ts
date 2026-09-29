import { describe, expect, it } from 'vitest';
import { SPELL, Simulation } from '../src/index.js';
import { compileText } from './helpers/spell.js';
import { liveSpellLoad, pendingReleases, spawnProgram } from '../src/sim/spells.js';

const bolt = compileText('bolt fire');
const zone = compileText('zone fire');
const nova = compileText('nova fire');
const delayed = compileText('nova[after 2s] fire zone');

function programOf(c: ReturnType<typeof compileText>): Extract<ReturnType<typeof compileText>, { ok: true }>['program'] {
  if (!c.ok) throw new Error('bad spell');
  return c.program;
}

describe('live spell cap', () => {
  it("ends a player's oldest spell entities instead of passing the cap", () => {
    const sim = new Simulation(2);
    const pid = sim.addPlayer('p', 'mage');
    for (let i = 0; i < 60; i++) spawnProgram(sim, programOf(bolt), pid, 500, 500 + i, 0);
    sim.world.flushDestroyed();
    const mine = [...sim.world.projectile.entries()].filter(([, p]) => p.ownerId === pid).map(([id]) => id);
    expect(mine.length).toBe(SPELL.liveCap.max);
    // The survivors are the newest 40.
    expect(Math.min(...mine)).toBeGreaterThan(Math.max(...mine) - SPELL.liveCap.max);
  });

  it('counts zones lighter than projectiles and novas, and each player separately', () => {
    const sim = new Simulation(2);
    const a = sim.addPlayer('a', 'mage');
    const b = sim.addPlayer('b', 'mage');
    const c = sim.addPlayer('c', 'mage');
    for (let i = 0; i < 150; i++) spawnProgram(sim, programOf(zone), a, 400 + i * 3, 400, 0);
    for (let i = 0; i < 30; i++) spawnProgram(sim, programOf(bolt), b, 900, 900 + i, 0);
    for (let i = 0; i < 60; i++) spawnProgram(sim, programOf(nova), c, 1300, 900 + i, 0);
    sim.world.flushDestroyed();
    expect(sim.world.zone.size).toBe(Math.floor(SPELL.liveCap.max / SPELL.liveCap.zone));
    expect([...sim.world.projectile.values()].filter((p) => p.ownerId === b).length).toBe(30);
    // A nova checks every target each tick like a projectile, so it weighs as much.
    expect(sim.world.nova.size).toBe(SPELL.liveCap.max / SPELL.liveCap.nova);
    expect(liveSpellLoad(sim, c).caster).toBe(SPELL.liveCap.max);
  });

  it('holds a whole room under the room cap, taking from the heaviest caster first', () => {
    const sim = new Simulation(2);
    const players = Array.from({ length: 10 }, (_, i) => sim.addPlayer(`p${i}`, 'mage'));
    for (const pid of players) for (let i = 0; i < 45; i++) spawnProgram(sim, programOf(bolt), pid, 500, 500 + i, 0);
    sim.world.flushDestroyed();
    const load = liveSpellLoad(sim, players[0] ?? -1);
    expect(load.room).toBeLessThanOrEqual(SPELL.liveCap.roomMax);
    expect(sim.world.projectile.size).toBe(SPELL.liveCap.roomMax);
    const counts = players.map((pid) => [...sim.world.projectile.values()].filter((p) => p.ownerId === pid).length);
    // Nobody is squeezed to nothing: the room cap trims the biggest loads, not the first caster's.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(SPELL.liveCap.max);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });

  it("ends a departed player's spells and their delayed payloads", () => {
    const sim = new Simulation(2, { kind: 'flat' });
    sim.waveTimer = Infinity;
    const gone = sim.addPlayer('gone', 'mage');
    const stays = sim.addPlayer('stays', 'mage');
    for (let i = 0; i < 5; i++) spawnProgram(sim, programOf(zone), gone, 600 + i * 20, 600, 0);
    spawnProgram(sim, programOf(delayed), gone, 800, 800, 0);
    spawnProgram(sim, programOf(zone), stays, 900, 900, 0);
    // Let the nova end so its zone waits as a delayed release.
    for (let t = 0; t < 10; t++) sim.step();
    expect(pendingReleases(sim, gone)).toBe(1);
    sim.removePlayer(gone);
    sim.step();
    sim.world.flushDestroyed();
    expect([...sim.world.zone.values()].filter((z) => z.spell.casterId === gone).length).toBe(0);
    expect(pendingReleases(sim, gone)).toBe(0);
    for (let t = 0; t < 40; t++) sim.step();
    expect([...sim.world.zone.values()].filter((z) => z.spell.casterId === gone).length).toBe(0);
    expect([...sim.world.zone.values()].filter((z) => z.spell.casterId === stays).length).toBe(1);
  });
});
