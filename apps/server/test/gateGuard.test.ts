import { gateBoss, gateTimers, loadMap, planChecksum, SIM, type GateInfo, type ServerMessage, type Vec2 } from '@rune/shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { events } from '../src/eventLog.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { TELEPORT_CHANNEL_SECONDS } from '../src/partyTravel.js';
import { FakeSocket } from './fakeSocket.js';

vi.mock('../src/townStore.js', async (original) => ({ ...(await original<typeof import('../src/townStore.js')>()), saveTownLayout: () => undefined }));

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/**
 * Everyone is an owner, for the dev teleport and god mode. Owners are held by the seals like anyone
 * else: only an admin's goto skips them, so these runs show what any player would get.
 */
async function setup(players: number) {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set(Array.from({ length: players }, (_, i) => `player${i}`)));
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < players; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    socket.emit({ t: 'dev', cmd: { c: 'god', on: true } });
    sockets.push(socket);
  }
  ticks(rooms, 2);
  return { rooms, sockets };
}

function ticks(rooms: RoomManager, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds * SIM.tickRate); i++) rooms.tick();
}

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

function roomOf(rooms: RoomManager, s: FakeSocket): Room {
  const room = rooms.roomById(welcome(s).roomId);
  if (!room) throw new Error('no room');
  return room;
}

function pos(rooms: RoomManager, s: FakeSocket): Vec2 {
  const p = roomOf(rooms, s).sim.world.position.get(welcome(s).playerId);
  if (!p) throw new Error('no position');
  return { x: p.x, y: p.y };
}

function hero(rooms: RoomManager, s: FakeSocket) {
  const p = roomOf(rooms, s).sim.world.player.get(welcome(s).playerId);
  if (!p) throw new Error('no player');
  return p;
}

/** The gate the player's spot lies behind that the player has not opened, or null. */
function sealedBehind(rooms: RoomManager, s: FakeSocket): string | null {
  const room = roomOf(rooms, s);
  const at = pos(rooms, s);
  const gate = room.sim.zone?.plan?.gateAt(at.x, at.y) ?? null;
  return gate !== null && !hero(rooms, s).gates.includes(gate) ? gate : null;
}

function gates(s: FakeSocket): GateInfo[] {
  return loadMap(welcome(s).map).def.gates ?? [];
}

function teleport(rooms: RoomManager, s: FakeSocket, x: number, y: number): void {
  s.emit({ t: 'dev', cmd: { c: 'teleport', x, y } });
  ticks(rooms, 0.2);
}

function party(rooms: RoomManager, a: FakeSocket, b: FakeSocket): void {
  a.emit({ t: 'partyInvite', name: 'Hero1' });
  b.emit({ t: 'partyAnswer', accept: true });
  ticks(rooms, 0.2);
}

const notices = (s: FakeSocket): string[] => s.sent.flatMap((m) => (m.t === 'notice' ? [m.text] : []));

/** On the road this far back from the gate toward town. */
function townSide(g: GateInfo, d: number): Vec2 {
  return { x: g.x - Math.cos(g.angle) * d, y: g.y - Math.sin(g.angle) * d };
}

describe('gate seals hold for every placement', () => {
  it('lands a party teleport to a member pressed against a seal on the town side, on every road', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    party(rooms, a, b);
    let seq = 1;
    for (const g of gates(b)) {
      // The reviewers' repro: B walks into the seal from just before it, so A's step aside would cross.
      const start = townSide(g, 15);
      teleport(rooms, b, start.x, start.y);
      b.emit({ t: 'input', seq: seq++, moveDir: { x: Math.cos(g.angle), y: Math.sin(g.angle) }, aimAngle: 0, buttons: 0 });
      ticks(rooms, 1);
      b.emit({ t: 'input', seq: seq++, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
      ticks(rooms, 0.1);
      expect(sealedBehind(rooms, b)).toBeNull();
      a.emit({ t: 'partyTeleport', name: 'Hero1' });
      ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.5);
      expect(hero(rooms, a).gates).toEqual([]);
      expect(sealedBehind(rooms, a)).toBeNull();
      const pa = pos(rooms, a);
      const pb = pos(rooms, b);
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThan(120);
      a.emit({ t: 'townPortal' });
      ticks(rooms, 1);
    }
  });

  it('refuses a teleport into a dungeon past a sealed gate while the world room is closed, and a dungeon exit past one leads to its town side', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    party(rooms, a, b);
    const worldId = welcome(b).roomId;
    const world = roomOf(rooms, b);
    const plan = world.sim.zone?.plan;
    if (!plan) throw new Error('no plan');
    const stagings = world.sim.mapDef.portals.filter((p) => p.target === 'staging');
    const gated = stagings.find((p) => plan.gateAt(p.x, p.y) !== null);
    const free = stagings.find((p) => plan.gateAt(p.x, p.y) === null);
    if (!gated || !free) throw new Error('need a dungeon past a gate and one before');
    const gateId = plan.gateAt(gated.x, gated.y);
    const gate = gates(b).find((g) => g.id === gateId);
    if (!gate) throw new Error('no gate');
    // B is let past the gate (as if it had killed the boss) and walks into the dungeon there; A into one before.
    hero(rooms, b).gates.push(gate.id);
    teleport(rooms, b, gated.x, gated.y);
    teleport(rooms, a, free.x, free.y);
    ticks(rooms, 2);
    expect(welcome(a).map.kind).toBe('staging');
    expect(welcome(b).map.kind).toBe('staging');
    // Nobody in the world room for longer than it waits: it closes.
    ticks(rooms, 320);
    expect(rooms.roomById(worldId)).toBeUndefined();
    const sealed = `Hero1 is past the ${gate.name}, which is sealed to you`;
    expect(a.last('partyStatus')?.members.find((m) => m.name === 'Hero1')?.no).toBe(sealed);
    const aRoom = welcome(a).roomId;
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe(sealed);
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.5);
    expect(welcome(a).roomId).toBe(aRoom);

    // Only an admin's goto gets A in there; the way out still leads to the town side of the gate.
    a.emit({ t: 'chat', text: '/goto Hero1' });
    ticks(rooms, 0.5);
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    const exit = loadMap(welcome(a).map).def.portals.find((p) => p.target === 'wilds');
    if (!exit) throw new Error('no exit');
    teleport(rooms, a, exit.x, exit.y);
    ticks(rooms, 3);
    expect(welcome(a).map.kind).toBe('world');
    expect(sealedBehind(rooms, a)).toBeNull();
    const back = townSide(gate, 520);
    const pa = pos(rooms, a);
    expect(Math.hypot(pa.x - back.x, pa.y - back.y)).toBeLessThan(120);
    // B, who has the gate, comes out beside the entrance as before.
    teleport(rooms, b, exit.x, exit.y);
    ticks(rooms, 3);
    const pb = pos(rooms, b);
    expect(Math.hypot(pb.x - gated.x, pb.y - gated.y)).toBeLessThan(250);
  }, 120_000);

  it('puts someone a town save leaves behind a sealed gate back on its town side, and keeps the gate boss timer', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    const g = gates(a).find((x) => x.id === 'steppe-gate');
    if (!g) throw new Error('no east gate');
    // B kills the boss with the dev tools (the gate opens for B only); A stands past the seal by dev teleport.
    const near = townSide(g, 300);
    teleport(rooms, b, near.x, near.y);
    ticks(rooms, 0.5);
    expect(gateBoss(roomOf(rooms, b).sim, g.id)).not.toBeNull();
    b.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 5);
    const past = townSide(g, -600);
    teleport(rooms, a, past.x, past.y);
    expect(sealedBehind(rooms, a)).toBe(g.id);
    const before = roomOf(rooms, a).sim;
    const served = gateTimers(before).find((t) => t.id === g.id)?.sinceDeath ?? 0;
    expect(served).toBeGreaterThan(0);

    a.emit({ t: 'saveTown', layout: { ...rooms.currentTown(), name: 'Emberwatch Rebuilt' } });
    ticks(rooms, 0.5);
    const after = roomOf(rooms, a).sim;
    expect(after).not.toBe(before);
    expect(sealedBehind(rooms, a)).toBeNull();
    const back = townSide(g, 520);
    const pa = pos(rooms, a);
    expect(Math.hypot(pa.x - back.x, pa.y - back.y)).toBeLessThan(120);
    // B, with the gate, stays where it stood; the dead boss is still dead and its timer still running.
    const pb = pos(rooms, b);
    expect(Math.hypot(pb.x - near.x, pb.y - near.y)).toBeLessThan(60);
    expect(gateBoss(after, g.id)).toBeNull();
    expect(gateTimers(after).find((t) => t.id === g.id)?.sinceDeath ?? 0).toBeGreaterThanOrEqual(served);
  });
});

describe('dungeon entrances past a seal', () => {
  it('turns away someone without the gate who stands on the entrance', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const world = roomOf(rooms, a);
    const plan = world.sim.zone?.plan;
    const gated = world.sim.mapDef.portals.find((p) => p.target === 'staging' && plan?.gateAt(p.x, p.y) !== null);
    if (!gated || !plan) throw new Error('no dungeon past a gate');
    const gate = gates(a).find((g) => g.id === plan.gateAt(gated.x, gated.y));
    teleport(rooms, a, gated.x, gated.y);
    ticks(rooms, 1);
    expect(welcome(a).map.kind).toBe('world');
    expect(notices(a).at(-1)).toBe(`The ${gate?.name ?? '?'} is sealed to you: slay its guardian first`);
  });
});

describe('world copy memory', () => {
  it('keeps a dead gate boss dead and its timer running when the world room closes empty and reopens', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const worldId = welcome(a).roomId;
    const g = gates(a).find((x) => x.id === 'steppe-gate');
    if (!g) throw new Error('no east gate');
    const near = townSide(g, 300);
    teleport(rooms, a, near.x, near.y);
    ticks(rooms, 0.5);
    a.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 5);
    // Into the Arena hall, so the world room stands empty until it closes.
    const arena = roomOf(rooms, a).sim.mapDef.portals.find((p) => p.target === 'arena');
    if (!arena) throw new Error('no arena entrance');
    teleport(rooms, a, arena.x, arena.y);
    ticks(rooms, 1);
    expect(welcome(a).map.kind).toBe('arenaGate');
    ticks(rooms, 320);
    expect(rooms.roomById(worldId)).toBeUndefined();

    a.emit({ t: 'townPortal' });
    ticks(rooms, 0.5);
    // The same world copy, reopened with the boss's death remembered.
    expect(welcome(a).roomId).toBe(worldId);
    const reopened = roomOf(rooms, a).sim;
    expect(gateTimers(reopened).map((t) => t.id)).toEqual([g.id]);
    teleport(rooms, a, near.x, near.y);
    ticks(rooms, 2);
    expect(gateBoss(reopened, g.id)).toBeNull();
  }, 120_000);
});

describe('world plan checksum', () => {
  it('sends the plan hash in the welcome and logs a client that reports another, once', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const plan = roomOf(rooms, a).sim.zone?.plan;
    if (!plan) throw new Error('no plan');
    const server = planChecksum(plan);
    expect(welcome(a).planHash).toBe(server);
    const cursor = events.since(0).next;
    const report = { t: 'planMismatch', roomId: welcome(a).roomId, server, client: '0badc0de' };
    a.emit(report);
    a.emit(report);
    const lines = events.since(cursor).entries.filter((e) => e.text.includes('plan checksum differs'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain(`server ${server}, client 0badc0de`);
    // A dungeon room has no plan and no hash.
    const entrance = roomOf(rooms, a).sim.mapDef.portals.find((p) => p.target === 'staging' && plan.gateAt(p.x, p.y) === null);
    if (!entrance) throw new Error('no entrance');
    teleport(rooms, a, entrance.x, entrance.y);
    ticks(rooms, 0.5);
    expect(welcome(a).map.kind).toBe('staging');
    expect(welcome(a).planHash).toBeUndefined();
  });
});
