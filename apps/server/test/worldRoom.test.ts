import { chestKey, loadMap, openedChests, SIM, type Portal, type ServerMessage, type TownLayout } from '@rune/shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

// A town save must not write over the committed town file.
vi.mock('../src/townStore.js', async (original) => ({ ...(await original<typeof import('../src/townStore.js')>()), saveTownLayout: () => undefined }));

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Everyone is an owner, for the dev teleport, god mode and the town editor. */
async function setup(players: number) {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set(Array.from({ length: players }, (_, i) => `player${i}`)));
  const sockets: FakeSocket[] = [];
  const ids: { account: number; character: number }[] = [];
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
    ids.push({ account: acc.id, character: ch.id });
  }
  // Past the portal cooldown a fresh arrival has.
  for (let i = 0; i < 2 * SIM.tickRate; i++) rooms.tick();
  return { store, rooms, sockets, ids };
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

function at(rooms: RoomManager, s: FakeSocket): { x: number; y: number } {
  const pos = roomOf(rooms, s).sim.world.position.get(welcome(s).playerId);
  if (!pos) throw new Error('no player');
  return pos;
}

function portal(s: FakeSocket, find: (p: Portal) => boolean): Portal {
  const p = loadMap(welcome(s).map).def.portals.find(find);
  if (!p) throw new Error('no such portal');
  return p;
}

function teleport(rooms: RoomManager, s: FakeSocket, x: number, y: number): void {
  s.emit({ t: 'dev', cmd: { c: 'teleport', x, y } });
  ticks(rooms, 0.2);
}

const notices = (s: FakeSocket): string[] => s.sent.flatMap((m) => (m.t === 'notice' ? [m.text] : []));

describe('the world room', () => {
  it('is one room per world copy, the town and every region in it, and walking out never changes room', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    expect(welcome(a).map.kind).toBe('world');
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    const room = welcome(a).roomId;
    const def = loadMap(welcome(a).map).def;
    // Out of the town and right across the world: still the same room.
    for (const wp of def.waypoints ?? []) {
      teleport(rooms, a, wp.x + 150, wp.y);
      expect(welcome(a).roomId).toBe(room);
    }
    expect(rooms.overview().rooms.filter((r) => r.id.endsWith('-world'))).toHaveLength(1);
  });

  it('travels by waypoint inside the room once found, and refuses one not found yet or from off a waypoint', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const room = welcome(a).roomId;
    const east = portal(a, (p) => p.waypoint === 'steppe-1');
    const town = portal(a, (p) => p.waypoint === 'town');

    // From the town's waypoint, before finding the east one.
    teleport(rooms, a, town.x, town.y);
    ticks(rooms, 0.5);
    const offer = a.last('waypoints');
    expect(offer).toMatchObject({ current: 'town', unlocked: ['town'] });
    a.emit({ t: 'useWaypoint', waypoint: 'steppe-1' });
    expect(notices(a).at(-1)).toBe('You have not found that waypoint yet');

    // Walking onto the east waypoint finds it; from there the town is one click away.
    teleport(rooms, a, east.x, east.y);
    // Past the town waypoint's retry delay, which a walk out here would take anyway.
    ticks(rooms, 3.2);
    expect(a.last('waypoints')).toMatchObject({ current: 'steppe-1', unlocked: ['town', 'steppe-1'] });
    a.emit({ t: 'useWaypoint', waypoint: 'town' });
    ticks(rooms, 0.1);
    expect(welcome(a).roomId).toBe(room);
    const there = at(rooms, a);
    expect(Math.hypot(there.x - town.x, there.y - town.y)).toBeLessThan(250);

    // And back out, from the town's waypoint.
    a.emit({ t: 'useWaypoint', waypoint: 'steppe-1' });
    ticks(rooms, 0.1);
    const out = at(rooms, a);
    expect(Math.hypot(out.x - east.x, out.y - east.y)).toBeLessThan(250);

    // Off any waypoint, nothing goes.
    const spawn = loadMap(welcome(a).map).def.spawn;
    teleport(rooms, a, spawn.x - 500, spawn.y);
    a.emit({ t: 'useWaypoint', waypoint: 'town' });
    expect(notices(a).at(-1)).toBe('Stand on a waypoint to travel');
  });

  it('enters a dungeon from its entrance and the antechamber leads back beside it', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const world = welcome(a).roomId;
    const entrance = portal(a, (p) => p.target === 'staging');
    teleport(rooms, a, entrance.x, entrance.y);
    ticks(rooms, 0.5);
    expect(welcome(a).map.kind).toBe('staging');
    const back = portal(a, (p) => p.target === 'wilds');
    teleport(rooms, a, back.x, back.y);
    ticks(rooms, 2);
    expect(welcome(a).roomId).toBe(world);
    const pos = at(rooms, a);
    expect(Math.hypot(pos.x - entrance.x, pos.y - entrance.y)).toBeLessThan(250);
    expect(Math.hypot(pos.x - entrance.x, pos.y - entrance.y)).toBeGreaterThan(entrance.r);
  });

  it('keeps the Arena entrance in town, and the Arena gate leads back to town', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const world = welcome(a).roomId;
    const arena = portal(a, (p) => p.target === 'arena');
    const town = loadMap(welcome(a).map).def.safeZones?.[0];
    if (!town) throw new Error('no town');
    expect(arena.x > town.x && arena.x < town.x + town.w && arena.y > town.y && arena.y < town.y + town.h).toBe(true);
    teleport(rooms, a, arena.x, arena.y);
    ticks(rooms, 0.5);
    expect(welcome(a).map.kind).toBe('arenaGate');
    const back = portal(a, (p) => p.target === 'town');
    teleport(rooms, a, back.x, back.y);
    ticks(rooms, 2);
    expect(welcome(a).roomId).toBe(world);
  });

  it('admin goto moves staff beside a player out in the world, in the same room', async () => {
    const { rooms, sockets, ids } = await setup(2);
    const [a, b] = sockets;
    const target = ids[1];
    const staff = ids[0];
    if (!a || !b || !target || !staff) throw new Error('no sockets');
    const wp = portal(b, (p) => p.waypoint === 'thornwood-2');
    teleport(rooms, b, wp.x + 200, wp.y);
    expect(rooms.gotoCharacter(staff.account, target.character)).toBeNull();
    ticks(rooms, 0.1);
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    const pa = at(rooms, a);
    const pb = at(rooms, b);
    expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThan(150);
  });

  it('the town portal brings a player out in the world back to town, in the same room', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const room = welcome(a).roomId;
    const spawn = loadMap(welcome(a).map).def.spawn;
    teleport(rooms, a, spawn.x + 3000, spawn.y);
    a.emit({ t: 'townPortal' });
    ticks(rooms, 0.1);
    expect(welcome(a).roomId).toBe(room);
    const pos = at(rooms, a);
    expect(Math.hypot(pos.x - spawn.x, pos.y - spawn.y)).toBeLessThan(120);
  });

  it('a town save keeps the loot on the ground and the opened chests', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const chest = loadMap(welcome(a).map).def.chests?.[0];
    if (!chest) throw new Error('no chest');
    teleport(rooms, a, chest.x + 30, chest.y);
    ticks(rooms, 0.2);
    const before = roomOf(rooms, a).sim;
    expect(openedChests(before).has(chestKey(chest))).toBe(true);
    const items = [...before.world.loot.values()].flatMap((l) => l.items.map((i) => i.uid)).sort();
    expect(items.length).toBeGreaterThan(0);
    a.emit({ t: 'saveTown', layout: { ...rooms.currentTown(), name: 'Emberwatch Rebuilt' } });
    ticks(rooms, 0.5);
    const after = roomOf(rooms, a).sim;
    expect(after).not.toBe(before);
    // The same items on the ground, once each, and the chest standing beside the player stays empty.
    expect([...after.world.loot.values()].flatMap((l) => l.items.map((i) => i.uid)).sort()).toEqual(items);
    expect(before.world.loot.size).toBe(0);
    expect(openedChests(after).has(chestKey(chest))).toBe(true);
  });

  it('leaving a dungeon goes to the world copy the player is in now, after a teleport across copies', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    a.emit({ t: 'partyInvite', name: 'Hero1' });
    b.emit({ t: 'partyAnswer', accept: true });
    // A opens the party world, B stays behind in the public one and walks into a dungeon's antechamber.
    a.emit({ t: 'partyWorld' });
    b.emit({ t: 'publicWorld' });
    ticks(rooms, 2);
    const entrance = portal(b, (p) => p.target === 'staging');
    teleport(rooms, b, entrance.x, entrance.y);
    ticks(rooms, 0.5);
    expect(welcome(b).map.kind).toBe('staging');
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, 3.5);
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    const back = portal(a, (p) => p.target === 'wilds');
    teleport(rooms, a, back.x, back.y);
    ticks(rooms, 2);
    expect(welcome(a).map.kind).toBe('world');
    expect(a.worldName()).toBe('Public world 1');
    expect(roomOf(rooms, a).instanceId).toBe(rooms.roomById(welcome(b).roomId)?.instanceId);
  });

  it('a town save rebuilds the world and leaves everyone where they stood', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const wp = portal(a, (p) => p.waypoint === 'gloomvale-1');
    teleport(rooms, a, wp.x + 150, wp.y);
    const before = at(rooms, a);
    const room = welcome(a).roomId;
    const layout: TownLayout = { ...rooms.currentTown(), name: 'Emberwatch Rebuilt' };
    a.emit({ t: 'saveTown', layout });
    ticks(rooms, 0.1);
    expect(notices(a).at(-1)).toBe('Town saved');
    expect(welcome(a).roomId).toBe(room);
    const after = at(rooms, a);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(120);
  });
});
