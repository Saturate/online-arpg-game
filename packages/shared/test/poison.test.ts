import { describe, expect, it } from 'vitest';
import { AILMENTS, ENEMIES, SIM, Simulation, serializeEntities, STATUS } from '../src/index.js';
import { applyPoison } from '../src/sim/combat.js';
import { spawnEnemy } from '../src/sim/enemies.js';

function setup(classId: 'warrior' | 'binder' = 'warrior') {
  const sim = new Simulation(7, { kind: 'flat' });
  const pid = sim.addPlayer('c', classId);
  const pos = sim.world.position.get(pid);
  if (!pos) throw new Error('no player');
  return { sim, pid, pos };
}

function stepSeconds(sim: Simulation, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * SIM.tickRate); i++) sim.step();
}

describe('poison', () => {
  it('stacks up to the cap, refreshes every stack and replaces the weakest', () => {
    const { sim, pos } = setup();
    const target = spawnEnemy(sim, 'dire_wolf', pos.x + 600, pos.y, { rare: false, level: 1, aggro: false });
    const st = sim.world.status.get(target);
    if (!st) throw new Error('no status');
    applyPoison(sim, target, 10, 0);
    st.poison[0]!.t = 1;
    applyPoison(sim, target, 20, 0);
    expect(st.poison).toHaveLength(2);
    // A new bite resets the older stack's timer too.
    expect(st.poison.every((s) => s.t === AILMENTS.poison.seconds)).toBe(true);
    for (let i = 0; i < 5; i++) applyPoison(sim, target, 30, 0);
    expect(st.poison).toHaveLength(AILMENTS.poison.maxStacks);
    // The two weak stacks gave way to stronger bites; a weaker bite later changes nothing.
    expect(Math.min(...st.poison.map((s) => s.dps))).toBeCloseTo(30 * AILMENTS.poison.dpsFractionOfHit);
    applyPoison(sim, target, 5, 0);
    expect(Math.min(...st.poison.map((s) => s.dps))).toBeCloseTo(30 * AILMENTS.poison.dpsFractionOfHit);
  });

  it('ticks damage over its duration and then wears off, on monsters, players and minions', () => {
    const { sim, pid, pos } = setup('binder');
    sim.step();
    const p = sim.world.player.get(pid);
    const minion = p?.minions.find((m) => m !== null) ?? null;
    if (minion === null || minion === undefined) throw new Error('no starter minion');
    const monster = spawnEnemy(sim, 'dire_wolf', pos.x + 900, pos.y, { rare: false, level: 1, aggro: false });
    for (const id of [monster, pid, minion]) {
      const h = sim.world.health.get(id)!;
      h.maxLife = 1000;
      h.life = 1000;
      applyPoison(sim, id, 50, 0);
      applyPoison(sim, id, 50, 0);
    }
    // Keep the minion out of any fight so only poison touches it.
    p!.stance = 'follow';
    stepSeconds(sim, 1);
    const expected = 2 * 50 * AILMENTS.poison.dpsFractionOfHit;
    for (const id of [monster, pid, minion]) {
      const lost = 1000 - sim.world.health.get(id)!.life;
      // Player armour softens it a little; monsters and minions take it in full.
      expect(lost, `entity ${id}`).toBeGreaterThan(expected * 0.5);
      expect(lost, `entity ${id}`).toBeLessThanOrEqual(expected + 0.5);
      const flags = serializeEntities(sim).find((e) => e.id === id);
      expect(flags && 'st' in flags ? flags.st & STATUS.poison : 0).toBe(STATUS.poison);
    }
    stepSeconds(sim, AILMENTS.poison.seconds);
    for (const id of [monster, pid, minion]) expect(sim.world.status.get(id)?.poison).toHaveLength(0);
  });

  it("the Grave Hound's bite poisons the player", () => {
    const { sim, pid, pos } = setup();
    expect(ENEMIES.grave_hound.behaviour === 'monster' && ENEMIES.grave_hound.traits.poisonBite).toBe(true);
    const id = spawnEnemy(sim, 'grave_hound', pos.x + 30, pos.y, { rare: false, level: 3, aggro: true });
    const hound = sim.world.enemy.get(id)!;
    // No pounce: at bite range only the bite should land.
    hound.cooldowns.fill(99);
    const h = sim.world.health.get(pid)!;
    h.maxLife = 5000;
    h.life = 5000;
    stepSeconds(sim, 2);
    expect(sim.world.status.get(pid)?.poison.length).toBeGreaterThan(0);
  });
});
