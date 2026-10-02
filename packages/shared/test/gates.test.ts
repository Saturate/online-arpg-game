import { describe, expect, it } from 'vitest';
import { freshWorld, gateBoss, gateSeal, gateTimers, loadMap, NET, PROGRESSION, rememberWorld, respawnGateBoss, restoreWorld, respawnTicks, setRespawnTimes, SIM, Simulation, stepPlayer, type GateInfo, type MoveState, type Vec2 } from '../src/index.js';
import { applyDev } from '../src/sim/dev.js';
import { dealDamage } from '../src/sim/combat.js';
import { packetOf } from '../src/sim/damage.js';

const DESC = { kind: 'world', seed: 3 } as const;

function gates(): GateInfo[] {
  const list = loadMap(DESC).def.gates ?? [];
  if (list.length !== 3) throw new Error('expected three gates');
  return list;
}

function player(sim: Simulation, id: number) {
  const p = sim.world.player.get(id);
  if (!p) throw new Error('no player');
  return p;
}

function at(sim: Simulation, id: number): Vec2 {
  const pos = sim.world.position.get(id);
  if (!pos) throw new Error('no position');
  return pos;
}

/** A spot on the road this far before the gate (negative: past it). */
function beforeGate(g: GateInfo, d: number): Vec2 {
  return { x: g.x - Math.cos(g.angle) * d, y: g.y - Math.sin(g.angle) * d };
}

/** Walks a player along `dir` for `ticks` ticks through the simulation, as inputs from a client. */
function walk(sim: Simulation, id: number, dir: Vec2, ticks: number, seq = { n: 0 }): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.applyInput(id, { seq: ++seq.n, moveDir: dir, aimAngle: 0, buttons: 0 });
    sim.step();
    const pos = at(sim, id);
    out.push({ x: pos.x, y: pos.y });
  }
  return out;
}

function newSim(): Simulation {
  const sim = new Simulation(5, DESC, { waves: false });
  return sim;
}

function hero(sim: Simulation, name: string, where: Vec2): number {
  const id = sim.addPlayer(name, 'warrior', name);
  sim.world.position.set(id, { ...where });
  player(sim, id).god = true;
  return id;
}

describe('gate bosses', () => {
  it('gives every world gate a boss, a name and a spot on the town side of its seal', () => {
    const { plan } = freshWorld(3);
    for (const g of gates()) {
      expect(g.name).toMatch(/ Gate$/);
      expect(['lich', 'butcher', 'broodmother']).toContain(g.boss);
      expect(g.level).toBeGreaterThan(plan.levelAt(g.x, g.y));
      expect(plan.gateAt(g.bossX, g.bossY)).toBeNull();
      const past = beforeGate(g, -200);
      expect(plan.gateAt(past.x, past.y)).toBe(g.id);
    }
    // Every waypoint past a gate lies behind it by the seal's own rule.
    for (const w of loadMap(DESC).def.waypoints ?? []) expect(plan.gateAt(w.x, w.y)).toBe(w.behind);
  });

  it('holds a character without the gate at the seal, and lets one with it through', () => {
    for (const g of gates()) {
      const dir = { x: Math.cos(g.angle), y: Math.sin(g.angle) };
      const sim = newSim();
      const plan = sim.zone?.plan;
      if (!plan) throw new Error('no plan');
      const sealed = hero(sim, 'a', beforeGate(g, 80));
      const opened = hero(sim, 'b', beforeGate(g, 80));
      player(sim, opened).gates.push(g.id);
      const seqA = { n: 0 };
      const seqB = { n: 0 };
      for (let i = 0; i < 60; i++) {
        walk(sim, sealed, dir, 1, seqA);
        walk(sim, opened, dir, 1, seqB);
      }
      expect(plan.gateAt(at(sim, sealed).x, at(sim, sealed).y), g.id).toBeNull();
      // Held at the line between the arch's legs (sliding along it a little), not somewhere short of it.
      expect(Math.hypot(at(sim, sealed).x - g.x, at(sim, sealed).y - g.y)).toBeLessThan(110);
      expect(plan.gateAt(at(sim, opened).x, at(sim, opened).y)).toBe(g.id);
      // Off the road too: walking at the seal from the side slides along it, never across.
      const side = { x: -dir.y * 0.6 + dir.x * 0.8, y: dir.x * 0.6 + dir.y * 0.8 };
      walk(sim, sealed, side, 80, seqA);
      expect(plan.gateAt(at(sim, sealed).x, at(sim, sealed).y)).toBeNull();
    }
  });

  it('lets a character already behind a gate walk about and back out', () => {
    const g = gates()[0];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    const plan = sim.zone?.plan;
    const id = hero(sim, 'a', beforeGate(g, -150));
    walk(sim, id, { x: Math.cos(g.angle), y: Math.sin(g.angle) }, 10);
    expect(plan?.gateAt(at(sim, id).x, at(sim, id).y)).toBe(g.id);
    walk(sim, id, { x: -Math.cos(g.angle), y: -Math.sin(g.angle) }, 80);
    expect(plan?.gateAt(at(sim, id).x, at(sim, id).y)).toBeNull();
  });

  it('predicts the same path on a separately built world as the server walks', () => {
    for (const g of gates()) {
      const sim = newSim();
      const id = hero(sim, 'a', beforeGate(g, 120));
      // The client's own build of the world, with the gate list its snapshot carries.
      const client = freshWorld(3);
      const seal = gateSeal({ zone: client.zone }, player(sim, id).gates);
      expect(seal).not.toBeNull();
      let state: MoveState = { ...at(sim, id), dash: null };
      const start = { ...at(sim, id) };
      const seq = { n: 0 };
      const dirs = [
        { x: Math.cos(g.angle), y: Math.sin(g.angle) },
        { x: Math.cos(g.angle + 0.7), y: Math.sin(g.angle + 0.7) },
        { x: Math.cos(g.angle - 1.1), y: Math.sin(g.angle - 1.1) },
      ];
      for (const dir of dirs) {
        const server = walk(sim, id, dir, 40, seq);
        for (const pos of server) {
          state = stepPlayer(client.game, state, dir, player(sim, id).stats.moveSpeed, SIM.dt, SIM.playerRadius, seal);
          expect(state.x).toBe(pos.x);
          expect(state.y).toBe(pos.y);
        }
      }
      expect(Math.hypot(state.x - start.x, state.y - start.y)).toBeGreaterThan(50);
    }
  });

  it('spawns the boss when someone comes near, and its kill opens the gate for the party in range only', () => {
    const g = gates()[1];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    const near = beforeGate(g, 400);
    const a = hero(sim, 'a', near);
    const b = hero(sim, 'b', { x: near.x + 30, y: near.y });
    const far = hero(sim, 'c', beforeGate(g, 400 + PROGRESSION.partyRange + 600));
    const stranger = hero(sim, 'd', { x: near.x - 30, y: near.y });
    for (const id of [a, b, far]) player(sim, id).party = 'p1';
    for (let i = 0; i < 6; i++) sim.step();
    const boss = gateBoss(sim, g.id);
    if (boss === null) throw new Error('no gate boss');
    const e = sim.world.enemy.get(boss);
    expect(e?.boss).toBe(true);
    expect(e?.typeId).toBe(g.boss);
    expect(e?.level).toBe(g.level);
    sim.takeEvents();
    dealDamage(sim, boss, packetOf('physical', 1e9), a);
    sim.step();
    expect(player(sim, a).gates).toEqual([g.id]);
    expect(player(sim, b).gates).toEqual([g.id]);
    expect(player(sim, far).gates).toEqual([]);
    expect(player(sim, stranger).gates).toEqual([]);
    const opened = sim.takeEvents().flatMap(({ ev }) => (ev.e === 'gateOpened' ? [ev.id] : []));
    expect(opened.sort()).toEqual([a, b].sort());
    expect(gateBoss(sim, g.id)).toBeNull();
  });

  it('brings the boss back after the boss respawn time from its death, and on the hook at once', () => {
    const g = gates()[2];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    // Three seconds, so the test does not wait out the default.
    setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 240, gateRespawnMinutes: 0.05 });
    const a = hero(sim, 'a', beforeGate(g, 400));
    for (let i = 0; i < 6; i++) sim.step();
    const first = gateBoss(sim, g.id);
    if (first === null) throw new Error('no gate boss');
    dealDamage(sim, first, packetOf('physical', 1e9), a);
    for (let i = 0; i < 50; i++) sim.step();
    expect(gateBoss(sim, g.id)).toBeNull();
    // Due, but a newcomer the gate is sealed to stands within view of the boss's spot: it waits rather
    // than appear in plain sight. The killer has the gate, so they do not hold it back.
    const b = hero(sim, 'b', beforeGate(g, 400));
    for (let i = 0; i < 40; i++) sim.step();
    expect(gateBoss(sim, g.id)).toBeNull();
    // Out of view of the spot (the interest radius, 1100) but still near enough the gate to spawn it.
    sim.world.position.set(b, sim.map.findOpen(beforeGate(g, 1500).x, beforeGate(g, 1500).y, 16));
    sim.world.position.set(a, sim.map.findOpen(beforeGate(g, 1500).x, beforeGate(g, 1500).y, 16));
    expect(Math.hypot((sim.world.position.get(b)?.x ?? 0) - g.bossX, (sim.world.position.get(b)?.y ?? 0) - g.bossY)).toBeGreaterThan(NET.interestRadius);
    for (let i = 0; i < 6; i++) sim.step();
    const second = gateBoss(sim, g.id);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // Killed again by someone who already has the gate: it opens nothing new and comes back the same way.
    if (second === null) return;
    dealDamage(sim, second, packetOf('physical', 1e9), a);
    expect(player(sim, a).gates).toEqual([g.id]);
    setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 240, gateRespawnMinutes: 30 });
    respawnGateBoss(sim, g.id);
    for (let i = 0; i < 6; i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
  });

  it("waits out the gate boss's own respawn time, not the region bosses'", () => {
    const g = gates()[0];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    // Region bosses due in three seconds, gate bosses in half an hour.
    setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 0.05, gateRespawnMinutes: 30 });
    expect(respawnTicks(sim).gates).toBe(30 * 60 * SIM.tickRate);
    const a = hero(sim, 'a', beforeGate(g, 1500));
    // Out of view of the boss's spot and holding the gate after the kill, so nothing but the timer holds a respawn back.
    expect(Math.hypot((sim.world.position.get(a)?.x ?? 0) - g.bossX, (sim.world.position.get(a)?.y ?? 0) - g.bossY)).toBeGreaterThan(NET.interestRadius);
    for (let i = 0; i < 6; i++) sim.step();
    const first = gateBoss(sim, g.id);
    if (first === null) throw new Error('no gate boss');
    dealDamage(sim, first, packetOf('physical', 1e9), a);
    expect(player(sim, a).gates).toEqual([g.id]);
    // Well past the region bosses' three seconds (60 ticks).
    for (let i = 0; i < 200; i++) sim.step();
    expect(gateBoss(sim, g.id)).toBeNull();
    // A shorter gate time reaches the boss already waiting, counted from its death.
    setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 30, gateRespawnMinutes: 0.05 });
    for (let i = 0; i < 6; i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
  });

  it('does not spawn a boss on a road nobody walks', () => {
    const sim = newSim();
    sim.addPlayer('a', 'warrior', 'a');
    for (let i = 0; i < 20; i++) sim.step();
    for (const g of gates()) expect(gateBoss(sim, g.id)).toBeNull();
  });

  it('keeps opened gates through a save and a load', () => {
    const [g0, g1] = gates();
    if (!g0 || !g1) throw new Error('no gates');
    const sim = newSim();
    const a = hero(sim, 'a', sim.mapDef.spawn);
    player(sim, a).gates.push(g0.id);
    const save = sim.exportPlayer(a);
    expect(save?.gates).toEqual([g0.id]);
    const next = newSim();
    const b = next.addPlayer('a', 'warrior', 'a', save ?? undefined);
    expect(player(next, b).gates).toEqual([g0.id]);
    // A save from before gate bosses opens nothing.
    const old = save ? { ...save } : undefined;
    if (old) delete old.gates;
    const c = next.addPlayer('c', 'warrior', 'c', old);
    expect(player(next, c).gates).toEqual([]);
    expect(g1.id).not.toBe(g0.id);
  });

  it('opens the gate for whoever clears the monsters with dev tools, and nobody else in the party', () => {
    const g = gates()[0];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    const a = hero(sim, 'a', beforeGate(g, 300));
    const b = hero(sim, 'b', beforeGate(g, 340));
    for (const id of [a, b]) player(sim, id).party = 'p1';
    for (let i = 0; i < 6; i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
    applyDev(sim, a, { c: 'killAll' });
    expect(player(sim, a).gates).toEqual([g.id]);
    expect(player(sim, b).gates).toEqual([]);
    // Its timer runs as after a kill.
    for (let i = 0; i < 20; i++) sim.step();
    expect(gateTimers(sim).map((t) => t.id)).toEqual([g.id]);
  });

  it("carries a dead gate boss's timer into a new room of the world copy, so a reopen does not bring it back early", () => {
    const g = gates()[1];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    setRespawnTimes(sim, { respawnMinutes: 10, bossRespawnMinutes: 240, gateRespawnMinutes: 0.25 });
    const a = hero(sim, 'a', beforeGate(g, 1500));
    for (let i = 0; i < 6; i++) sim.step();
    const first = gateBoss(sim, g.id);
    if (first === null) throw new Error('no gate boss');
    dealDamage(sim, first, packetOf('physical', 1e9), a);
    for (let i = 0; i < 100; i++) sim.step();
    const memory = rememberWorld(sim);
    expect(memory.gates).toEqual([expect.objectContaining({ id: g.id, boss: g.boss })]);
    const served = memory.gates[0]?.sinceDeath ?? 0;
    expect(served).toBeGreaterThanOrEqual(100);

    const next = newSim();
    setRespawnTimes(next, { respawnMinutes: 10, bossRespawnMinutes: 240, gateRespawnMinutes: 0.25 });
    restoreWorld(next, memory);
    hero(next, 'b', beforeGate(g, 1500));
    // 0.25 minutes is 300 ticks; the 100 served before the close count, the rest are still to wait.
    const left = 300 - served;
    for (let i = 0; i < left - 10; i++) next.step();
    expect(gateBoss(next, g.id)).toBeNull();
    for (let i = 0; i < 20; i++) next.step();
    expect(gateBoss(next, g.id)).not.toBeNull();

    // Without the memory, the same world opens with the boss there at once.
    const fresh = newSim();
    hero(fresh, 'c', beforeGate(g, 1500));
    for (let i = 0; i < 6; i++) fresh.step();
    expect(gateBoss(fresh, g.id)).not.toBeNull();
  });

  it('drops a carried timer whose gate now has another boss', () => {
    const g = gates()[0];
    if (!g) throw new Error('no gate');
    const sim = newSim();
    restoreWorld(sim, { gates: [{ id: g.id, boss: g.boss === 'lich' ? 'butcher' : 'lich', sinceDeath: 0, spawns: 1 }], bosses: [], chests: [] });
    hero(sim, 'a', beforeGate(g, 1500));
    for (let i = 0; i < 6; i++) sim.step();
    expect(gateBoss(sim, g.id)).not.toBeNull();
  });
});
