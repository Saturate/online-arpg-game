import { describe, expect, it } from 'vitest';
import { gateBoss, loadMap, setRespawnTimes, Simulation, GATES, SIM, type Vec2 } from '../src/index.js';
import { dealDamage } from '../src/sim/combat.js';

const DESC = { kind: 'world', seed: 3 } as const;

function setup() {
  const sim = new Simulation(5, DESC, { waves: false });
  const g = (loadMap(DESC).def.gates ?? [])[0];
  if (!g) throw new Error('no gate');
  setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 240, gateRespawnMinutes: 0.05 });
  const wp = sim.mapDef.portals
    .filter((p) => p.target === 'waypoint')
    .sort((a, b) => Math.hypot(a.x - g.bossX, a.y - g.bossY) - Math.hypot(b.x - g.bossX, b.y - g.bossY))[0];
  if (!wp) throw new Error('no waypoint');
  const put = (name: string, at: Vec2): number => {
    const id = sim.addPlayer(name, 'warrior', name);
    sim.world.position.set(id, sim.map.findOpen(at.x, at.y, 16));
    const p = sim.world.player.get(id);
    if (p) p.god = true;
    return id;
  };
  const killer = put('k', { x: g.x - Math.cos(g.angle) * 400, y: g.y - Math.sin(g.angle) * 400 });
  for (let i = 0; i < 6; i++) sim.step();
  const boss = gateBoss(sim, g.id);
  if (boss === null) throw new Error('no boss');
  dealDamage(sim, boss, 1e9, killer, []);
  return { sim, g, wp, killer, put };
}

describe('gate boss respawn near campers', () => {
  it('comes back while someone who opened the gate idles at the waypoint past it', () => {
    const { sim, g, wp, killer, put } = setup();
    sim.world.position.set(killer, sim.map.findOpen(wp.x, wp.y, 16));
    put('n', { x: g.x - Math.cos(g.angle) * 1600, y: g.y - Math.sin(g.angle) * 1600 });
    for (let i = 0; i < SIM.tickRate * 10; i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
  });

  it('waits for a newcomer in view, but only up to the maximum delay', () => {
    const { sim, g, killer, put } = setup();
    sim.world.position.set(killer, sim.mapDef.spawn);
    put('n', { x: g.bossX - Math.cos(g.angle) * 300, y: g.bossY - Math.sin(g.angle) * 300 });
    for (let i = 0; i < SIM.tickRate * 10; i++) sim.step();
    expect(gateBoss(sim, g.id)).toBeNull();
    for (let i = 0; i < SIM.tickRate * (GATES.maxRespawnDelaySeconds + 5); i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
  });
});
