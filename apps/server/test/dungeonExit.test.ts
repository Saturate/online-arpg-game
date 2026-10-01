import { DUNGEON, loadMap, SIM, type Portal, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Owners, for the dev teleport onto portals, god mode and killAll. */
async function setup(players: number) {
  const store = new AccountStore(':memory:');
  const owners = new Set(Array.from({ length: players }, (_, i) => `player${i}`));
  const rooms = new RoomManager(1, store, owners);
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

function portalOf(s: FakeSocket, find: (p: Portal) => boolean): Portal {
  const portal = loadMap(welcome(s).map).def.portals.find(find);
  if (!portal) throw new Error('no portal');
  return portal;
}

function walkInto(rooms: RoomManager, s: FakeSocket, find: (p: Portal) => boolean): void {
  const portal = portalOf(s, find);
  s.emit({ t: 'dev', cmd: { c: 'teleport', x: portal.x, y: portal.y } });
  ticks(rooms, 2);
}

const isExit = (p: Portal) => p.sealed === 'boss';

function self(rooms: RoomManager, s: FakeSocket): { x: number; y: number } {
  const pos = roomOf(rooms, s).sim.world.position.get(welcome(s).playerId);
  if (!pos) throw new Error('no player');
  return pos;
}

/** Hero0 walks onto the world's first dungeon entrance, into its antechamber and a fresh run. */
async function inDungeon() {
  const { rooms, sockets } = await setup(2);
  const [a, b] = sockets;
  if (!a || !b) throw new Error('no sockets');
  walkInto(rooms, a, (p) => p.target === 'staging');
  a.emit({ t: 'ready', ready: true });
  ticks(rooms, DUNGEON.countdownSeconds + 0.2);
  expect(welcome(a).map.kind).toBe('dungeon');
  return { rooms, a, b };
}

describe('dungeon exit', () => {
  it('stays closed until the boss dies, and a request to it is refused', async () => {
    const { rooms, a } = await inDungeon();
    const run = welcome(a).roomId;
    walkInto(rooms, a, isExit);
    ticks(rooms, 2);
    expect(welcome(a).roomId).toBe(run);
    expect(a.last('snapshot')?.exitOpen).toBeUndefined();

    // A request made some other way than walking in still goes nowhere.
    const room = roomOf(rooms, a);
    room.sim.portalRequests.push({ playerId: welcome(a).playerId, target: 'wilds', portal: portalOf(a, isExit) });
    ticks(rooms, 0.1);
    expect(welcome(a).roomId).toBe(run);
  });

  it('opens when the boss dies, tells everyone inside, and leads out', async () => {
    const { rooms, a } = await inDungeon();
    a.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 0.2);
    expect(a.last('snapshot')?.exitOpen).toBe(true);
    expect(a.sent.some((m) => m.t === 'chat' && m.kind === 'system' && m.text === 'The way out opens in the boss chamber')).toBe(true);
    const seed = welcome(a).map;
    walkInto(rooms, a, isExit);
    // Back in the world, beside the entrance the run was entered from.
    const out = welcome(a).map;
    expect(out.kind).toBe('world');
    if (out.kind !== 'world' || seed.kind !== 'dungeon') throw new Error('not out');
    const entrance = loadMap(out).def.portals.find((p) => p.target === 'staging' && p.dungeon?.seed === seed.seed);
    if (!entrance) throw new Error('no entrance');
    const at = self(rooms, a);
    expect(Math.hypot(at.x - entrance.x, at.y - entrance.y)).toBeLessThan(250);
  });

  it('shows the exit already open to someone joining after the boss died', async () => {
    const { rooms, a, b } = await inDungeon();
    const run = welcome(a).roomId;
    a.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 0.2);
    walkInto(rooms, b, (p) => p.target === 'staging');
    walkInto(rooms, b, (p) => p.target === 'dungeon');
    expect(welcome(b).roomId).toBe(run);
    const joined = b.sent.lastIndexOf(welcome(b));
    const first = b.sent.slice(joined).find((m) => m.t === 'snapshot');
    expect(first?.t === 'snapshot' ? first.exitOpen : undefined).toBe(true);
  });

  it('always has a way back to the antechamber, and the gate leads back into the same run', async () => {
    const { rooms, a } = await inDungeon();
    const run = welcome(a).roomId;
    walkInto(rooms, a, (p) => p.target === 'staging');
    expect(welcome(a).map.kind).toBe('staging');
    walkInto(rooms, a, (p) => p.target === 'dungeon');
    expect(welcome(a).roomId).toBe(run);
  });
});
