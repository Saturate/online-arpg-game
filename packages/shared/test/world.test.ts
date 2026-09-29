import { describe, expect, it } from 'vitest';
import { BUTTON, CLASSES, loadMap, SIM, Simulation, SPELL, STARTER_VESSELS, stepPlayer, WILDS, type InputFrame, type MoveState } from '../src/index.js';

const frame = (seq: number, over: Partial<InputFrame> = {}): InputFrame => ({ seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0, ...over });

describe('map collision', () => {
  const { game, def } = loadMap({ kind: 'testground' });
  const rock = def.obstacles.find((o) => o.kind === 'rock' && o.shape.type === 'circle' && o.shape.r > 30);

  it('never lets a walking player end up inside a rock', () => {
    if (!rock || rock.shape.type !== 'circle') throw new Error('arena has no big rock');
    let s: MoveState = { x: rock.shape.x - rock.shape.r - 60, y: rock.shape.y, dash: null };
    for (let i = 0; i < 40; i++) s = stepPlayer(game, s, { x: 1, y: 0 }, 220, SIM.dt, SIM.playerRadius);
    expect(Math.hypot(s.x - rock.shape.x, s.y - rock.shape.y)).toBeGreaterThanOrEqual(rock.shape.r + SIM.playerRadius - 0.01);
  });

  it('does not let a dash tunnel through a small rock', () => {
    const small = def.obstacles.find((o) => o.kind === 'rock' && o.shape.type === 'circle' && o.shape.r < 16);
    if (!small || small.shape.type !== 'circle') return;
    let s: { x: number; y: number; dash: { vx: number; vy: number; ticksLeft: number } | null } = {
      x: small.shape.x - 60,
      y: small.shape.y,
      dash: { vx: 1500, vy: 0, ticksLeft: 4 },
    };
    for (let i = 0; i < 4; i++) s = stepPlayer(game, s, { x: 0, y: 0 }, 220, SIM.dt, SIM.playerRadius);
    expect(s.x).toBeLessThan(small.shape.x);
  });

  it('water blocks walking but not shots', () => {
    const water = def.obstacles.find((o) => o.kind === 'water');
    expect(water?.blocksMove).toBe(true);
    expect(water?.blocksShots).toBe(false);
  });
});

describe('wilds generation', () => {
  it('is deterministic per seed and different across seeds', () => {
    const a = loadMap({ kind: 'wilds', seed: 101 }).def;
    const b = loadMap({ kind: 'wilds', seed: 101 }).def;
    const c = loadMap({ kind: 'wilds', seed: 202 }).def;
    expect(JSON.stringify(a.obstacles)).toBe(JSON.stringify(b.obstacles));
    expect(JSON.stringify(a.obstacles)).not.toBe(JSON.stringify(c.obstacles));
  });

  it('places packs away from the camp, with a boss, and none inside obstacles', () => {
    const { def, game } = loadMap({ kind: 'wilds', seed: 303 });
    expect(def.packs.length).toBeGreaterThan(10);
    expect(def.packs.filter((p) => p.boss)).toHaveLength(1);
    for (const p of def.packs) {
      expect(Math.hypot(p.x - def.spawn.x, p.y - def.spawn.y)).toBeGreaterThanOrEqual(WILDS.safeRadius);
      expect(game.pointBlocked(p.x, p.y, 20, 'move')).toBe(false);
    }
  });

  it('packs idle until a player comes near, then wake the whole pack', () => {
    const sim = new Simulation(1, { kind: 'wilds', seed: 404 });
    const pid = sim.addPlayer('c', 'mage');
    const firstPack = sim.mapDef.packs[0];
    if (!firstPack) throw new Error('no packs');
    for (let i = 0; i < 5; i++) sim.step();
    expect([...sim.world.enemy.values()].every((e) => !e.aggro)).toBe(true);
    sim.world.position.set(pid, sim.map.findOpen(firstPack.x - 150, firstPack.y, 20));
    for (let i = 0; i < 5; i++) sim.step();
    const awake = [...sim.world.enemy.values()].filter((e) => e.aggro).length;
    expect(awake).toBeGreaterThanOrEqual(2);
  });
});

describe('prebaked skills', () => {
  it('every class kit compiles to a working skill', () => {
    for (const cls of ['warrior', 'ranger', 'mage', 'priest', 'binder'] as const) {
      const sim = new Simulation(1);
      const id = sim.addPlayer('c', cls);
      const p = sim.world.player.get(id)!;
      for (const eq of p.sigils) expect(eq?.compiled.ok, `${cls} ${eq?.uid}`).toBe(true);
    }
  });

  it('Frozen Orb sprays shards while it travels and passes through enemies', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c', 'mage');
    const pos = sim.world.position.get(id)!;
    sim.spawnEnemy('chaser', pos.x + 90, pos.y);
    const slot = sim.world.player.get(id)!.sigils.findIndex((s) => sim.world.player.get(id)!.items.get(s?.uid ?? -1)?.name === 'Frozen Orb');
    const bit = [BUTTON.skill1, BUTTON.skill2, BUTTON.skill3, BUTTON.skill4][slot]!;
    sim.applyInput(id, frame(0, { buttons: bit }));
    for (let i = 0; i < 12; i++) sim.step();
    expect(sim.world.projectile.size).toBeGreaterThan(6);
  });

  it('Fireball explodes on impact and leaves burning ground', () => {
    const sim = new Simulation(1);
    const id = sim.addPlayer('c', 'mage');
    const pos = sim.world.position.get(id)!;
    const target = sim.spawnEnemy('spinner', pos.x + 120, pos.y);
    sim.world.health.get(target)!.life = 10_000;
    sim.applyInput(id, frame(0, { buttons: BUTTON.skill1 }));
    let sawZone = false;
    for (let i = 0; i < 40 && !sawZone; i++) {
      sim.step();
      sawZone = sim.world.zone.size > 0;
    }
    expect(sawZone).toBe(true);
    expect(SPELL.zone.durationSeconds).toBeGreaterThan(0);
  });
});

describe('rooms', () => {
  it('stepping into a portal queues a room change', () => {
    const sim = new Simulation(1, { kind: 'town' });
    const id = sim.addPlayer('c', 'warrior');
    const portal = sim.mapDef.portals.find((p) => p.target === 'wilds')!;
    for (let i = 0; i < 40; i++) sim.step();
    sim.world.position.set(id, { x: portal.x, y: portal.y });
    sim.step();
    expect(sim.portalRequests).toContainEqual({ playerId: id, target: 'wilds', portal });
  });

  it('a character keeps items and equipment across rooms', () => {
    const town = new Simulation(1, { kind: 'town' });
    const a = town.addPlayer('c', 'binder', 'Kay');
    const save = town.exportPlayer(a)!;
    const wilds = new Simulation(2, { kind: 'wilds', seed: 5 });
    const b = wilds.addPlayer('c', save.classId, save.name, save);
    const p = wilds.world.player.get(b)!;
    expect(p.items.size).toBe(save.items.length);
    expect(p.sigils.filter((s) => s?.compiled.ok)).toHaveLength(4);
    wilds.step();
    expect(p.minions.filter((m) => m !== null).length).toBe(STARTER_VESSELS.length);
  });

  it('town is safe: nothing takes damage', () => {
    const sim = new Simulation(1, { kind: 'town' });
    const id = sim.addPlayer('c', 'mage');
    const e = sim.spawnEnemy('chaser', sim.world.position.get(id)!.x + 20, sim.world.position.get(id)!.y);
    for (let i = 0; i < 40; i++) sim.step();
    expect(sim.world.health.get(id)!.life).toBe(CLASSES.mage.life);
    expect(sim.world.health.get(e)!.life).toBeGreaterThan(0);
  });
});

describe('sliding', () => {
  it('walking straight at the centre of the town well slides around it instead of sticking', () => {
    const { game, def } = loadMap({ kind: 'town' });
    const well = def.obstacles.find((o) => o.kind === 'well');
    if (!well || well.shape.type !== 'circle') throw new Error('no well');
    let s: MoveState = { x: well.shape.x, y: well.shape.y + 120, dash: null };
    for (let i = 0; i < 60; i++) s = stepPlayer(game, s, { x: 0, y: -1 }, 200, SIM.dt, SIM.playerRadius);
    expect(s.y).toBeLessThan(well.shape.y - well.shape.r);
  });
});
