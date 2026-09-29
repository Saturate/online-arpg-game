import { describe, expect, it } from 'vitest';
import { BUTTON, CLASSES, ENEMIES, serializeEntities, SIM, Simulation, SKILL_BUTTONS, type InputFrame } from '../src/index.js';

function input(seq: number, over: Partial<InputFrame> = {}): InputFrame {
  return { seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0, ...over };
}

describe('Simulation', () => {
  it('moves a player by exactly speed * dt per input and clamps tampered direction vectors', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c1', 'ranger');
    const start = { ...sim.world.position.get(id)! };
    sim.applyInput(id, input(0, { moveDir: { x: 50, y: 0 } }));
    const pos = sim.world.position.get(id)!;
    expect(pos.x - start.x).toBeCloseTo(CLASSES.ranger.moveSpeed * SIM.dt);
    expect(pos.y).toBe(start.y);
  });

  it('ignores inputs with a sequence number it has already processed', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c1', 'ranger');
    sim.applyInput(id, input(5, { moveDir: { x: 1, y: 0 } }));
    const x = sim.world.position.get(id)!.x;
    sim.applyInput(id, input(5, { moveDir: { x: 1, y: 0 } }));
    sim.applyInput(id, input(3, { moveDir: { x: 1, y: 0 } }));
    expect(sim.world.position.get(id)!.x).toBe(x);
  });

  it('kills a chaser with a skill (fireball, slot 1)', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c1', 'mage');
    const p = sim.world.position.get(id)!;
    const enemy = sim.spawnEnemy('chaser', p.x + 120, p.y);
    let seq = 0;
    for (let t = 0; t < 200 && sim.world.isAlive(enemy); t++) {
      sim.applyInput(id, input(seq++, { buttons: SKILL_BUTTONS[0], aimAngle: 0 }));
      sim.step();
    }
    expect(sim.world.isAlive(enemy)).toBe(false);
  });

  it('has no basic attack: the primary button does nothing', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c1', 'mage');
    for (let seq = 0; seq < 4; seq++) sim.applyInput(id, input(seq, { buttons: BUTTON.primary }));
    expect(sim.world.projectile.size).toBe(0);
  });

  it('chasers damage players, players die and respawn with full life', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c1', 'mage');
    const p = sim.world.position.get(id)!;
    for (let i = 0; i < 6; i++) sim.spawnEnemy('chaser', p.x + 30, p.y + i);
    let died = false;
    for (let t = 0; t < 400; t++) {
      sim.step();
      if (sim.world.player.get(id)!.respawnIn !== null) {
        died = true;
        break;
      }
    }
    expect(died).toBe(true);
    for (const eid of [...sim.world.enemy.keys()]) sim.world.destroy(eid);
    for (let t = 0; t < SIM.playerRespawnSeconds / SIM.dt + 1; t++) sim.step();
    expect(sim.world.player.get(id)!.respawnIn).toBeNull();
    expect(sim.world.health.get(id)!.life).toBe(CLASSES.mage.life);
  });

  it('spawns waves once a player is present', () => {
    const sim = new Simulation(1);
    for (let t = 0; t < 100; t++) sim.step();
    expect(sim.world.enemy.size).toBe(0);
    sim.addPlayer('c1', 'mage');
    for (let t = 0; t < 100; t++) sim.step();
    expect(sim.wave).toBe(1);
    expect(sim.world.enemy.size).toBeGreaterThan(0);
  });

  it('is deterministic for the same seed and inputs', () => {
    function run(): string {
      const sim = new Simulation(42);
      const id = sim.addPlayer('c1', 'ranger');
      for (let t = 0; t < 300; t++) {
        sim.applyInput(id, input(t, { moveDir: { x: Math.sin(t / 10), y: 1 }, aimAngle: t / 7, buttons: SKILL_BUTTONS[0] }));
        sim.step();
      }
      return JSON.stringify(serializeEntities(sim));
    }
    expect(run()).toBe(run());
  });
});

describe('player spawning', () => {
  it('respawns away from enemies camping the previous spawn', () => {
    const sim = new Simulation(7);
    const cx = SIM.arena.width / 2;
    const cy = SIM.arena.height / 2;
    for (let i = 0; i < 8; i++) sim.spawnEnemy('chaser', cx + i, cy);
    const id = sim.addPlayer('c1', 'mage');
    const p = sim.world.position.get(id)!;
    expect(Math.hypot(p.x - cx, p.y - cy)).toBeGreaterThan(200);
  });
});
