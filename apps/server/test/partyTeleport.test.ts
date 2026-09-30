import { DUNGEON, loadMap, SIM, type PartyMemberStatus, type ServerMessage } from '@rune/shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { channelBreak, TELEPORT_CHANNEL_SECONDS, type ChannelWatch } from '../src/partyTravel.js';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Everyone is an owner, for the dev teleport onto portals and god mode against stray monsters. */
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
  return { store, rooms, sockets };
}

function pair(sockets: FakeSocket[]): [FakeSocket, FakeSocket] {
  const [a, b] = sockets;
  if (!a || !b) throw new Error('no sockets');
  return [a, b];
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

function self(rooms: RoomManager, s: FakeSocket) {
  const room = roomOf(rooms, s);
  const id = welcome(s).playerId;
  const p = room.sim.world.player.get(id);
  const h = room.sim.world.health.get(id);
  const pos = room.sim.world.position.get(id);
  if (!p || !h || !pos) throw new Error('no player');
  return { p, h, pos };
}

function walkInto(rooms: RoomManager, sockets: FakeSocket[], target: string): void {
  for (const s of sockets) {
    const portal = loadMap(welcome(s).map).def.portals.find((p) => p.target === target);
    if (!portal) throw new Error(`no ${target} portal`);
    s.emit({ t: 'dev', cmd: { c: 'teleport', x: portal.x, y: portal.y } });
  }
  ticks(rooms, 2);
}

function party(a: FakeSocket, b: FakeSocket): void {
  a.emit({ t: 'partyInvite', name: 'Hero1' });
  b.emit({ t: 'partyAnswer', accept: true });
}

function status(s: FakeSocket, name: string): PartyMemberStatus | undefined {
  return s.last('partyStatus')?.members.find((m) => m.name === name);
}

function notices(s: FakeSocket): string[] {
  return s.sent.flatMap((m) => (m.t === 'notice' ? [m.text] : []));
}

function ended(s: FakeSocket) {
  const m = s.last('teleportChannel');
  return m && m.to === null ? m : undefined;
}

/** Hero1 goes out into the first zone, away from Hero0 in town, and clears it. */
async function apart() {
  const { store, rooms, sockets } = await setup(2);
  const [a, b] = pair(sockets);
  party(a, b);
  walkInto(rooms, [b], 'zone');
  expect(welcome(b).map.kind).toBe('zone');
  expect(welcome(b).roomId).not.toBe(welcome(a).roomId);
  b.emit({ t: 'dev', cmd: { c: 'killAll' } });
  return { store, rooms, a, b };
}

describe('party status', () => {
  it('sends every member the others once a second, with place, zone, life and a position only in the same room', async () => {
    const { rooms, a, b } = await apart();
    a.sent.length = 0;
    ticks(rooms, 1);
    expect(a.sent.filter((m) => m.t === 'partyStatus')).toHaveLength(1);
    const seen = status(a, 'Hero1');
    expect(seen).toMatchObject({ cls: 'warrior', level: 1, place: 'wilds', dead: false, zone: roomOf(rooms, b).name });
    expect(seen?.maxLife).toBeGreaterThan(0);
    expect(seen?.x).toBeUndefined();
    expect(seen?.no).toBeUndefined();
    expect(status(a, 'Hero0')).toBeUndefined();
    expect(status(b, 'Hero0')?.place).toBe('town');

    // A byte budget: a party of two costs a couple of hundred bytes a second each.
    const size = JSON.stringify(a.last('partyStatus')).length;
    expect(size).toBeLessThan(200);
  });

  it('shows an offline member as offline, keeping class and level', async () => {
    const { rooms, a, b } = await apart();
    ticks(rooms, 1);
    b.close();
    ticks(rooms, 1);
    expect(status(a, 'Hero1')).toMatchObject({ place: 'offline', cls: 'warrior', level: 1, no: 'Hero1 is offline' });
  });
});

describe('teleport to a party member', () => {
  it('channels for 3 s, then moves the player into the member\'s room beside them, saving on the way', async () => {
    const { store, rooms, a, b } = await apart();
    const save = vi.spyOn(store, 'saveCharacterAndStash');
    a.emit({ t: 'partyTeleport', name: 'hero1' });
    expect(a.last('teleportChannel')).toEqual({ t: 'teleportChannel', to: 'Hero1', seconds: TELEPORT_CHANNEL_SECONDS });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS - 0.2);
    expect(welcome(a).roomId).not.toBe(welcome(b).roomId);
    ticks(rooms, 0.3);
    expect(ended(a)).toEqual({ t: 'teleportChannel', to: null, reason: null });
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    // The same room change as waypoints and portals: the character is written on the way out.
    expect(save).toHaveBeenCalled();
    const there = self(rooms, a).pos;
    const target = self(rooms, b).pos;
    expect(Math.hypot(there.x - target.x, there.y - target.y)).toBeLessThan(150);

    // And back the other way.
    b.emit({ t: 'townPortal' });
    b.emit({ t: 'partyTeleport', name: 'Hero0' });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    expect(welcome(b).roomId).toBe(welcome(a).roomId);
  });

  it('breaks on moving, on a hit and on a cast', async () => {
    const { rooms, a } = await apart();
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    a.emit({ t: 'input', seq: 1, moveDir: { x: 1, y: 0 }, aimAngle: 0, buttons: 0 });
    ticks(rooms, 0.5);
    expect(ended(a)?.reason).toBe('Teleport cancelled: you moved');
    a.emit({ t: 'input', seq: 2, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
    ticks(rooms, 0.2);

    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, 0.5);
    self(rooms, a).h.life -= 5;
    ticks(rooms, 0.1);
    expect(ended(a)?.reason).toBe('Teleport interrupted: you took damage');

    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, 0.5);
    // What a cast leaves behind; the warrior's own starter skills lunge, which would read as moving.
    self(rooms, a).p.castCooldown = 0.8;
    ticks(rooms, 0.1);
    expect(ended(a)?.reason).toBe('Teleport cancelled: you cast a spell');
    expect(welcome(a).map.kind).toBe('zone');
  });

  it('refuses yourself, strangers, the dead, offline members and anyone outside a party', async () => {
    const { rooms, sockets } = await setup(3);
    const [a, b] = pair(sockets);
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('You are not in a party');
    party(a, b);
    a.emit({ t: 'partyTeleport', name: 'Hero0' });
    expect(notices(a).at(-1)).toBe('That is you');
    a.emit({ t: 'partyTeleport', name: 'Hero2' });
    expect(notices(a).at(-1)).toBe('Hero2 is not in your party');

    const me = self(rooms, a);
    me.p.respawnIn = 5;
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('You cannot teleport while dead');
    me.p.respawnIn = null;

    b.close();
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('Hero1 is offline');
    expect(a.sent.some((m) => m.t === 'teleportChannel')).toBe(false);
  });

  it('refuses into an Arena run and out of one', async () => {
    const { rooms, a, b } = await apart();
    b.emit({ t: 'townPortal' });
    walkInto(rooms, [b], 'arena');
    b.emit({ t: 'ready', ready: true });
    ticks(rooms, DUNGEON.countdownSeconds + 0.2);
    expect(welcome(b).map.kind).toBe('arena');
    ticks(rooms, 1);
    expect(status(a, 'Hero1')).toMatchObject({ place: 'arena', no: 'Hero1 is in an Arena run' });
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('Hero1 is in an Arena run');
    b.emit({ t: 'partyTeleport', name: 'Hero0' });
    expect(notices(b).at(-1)).toBe('You cannot teleport out of an Arena run');
  });

  it('checks again when the channel ends, in case the member walked somewhere refused', async () => {
    const { rooms, a, b } = await apart();
    b.emit({ t: 'townPortal' });
    walkInto(rooms, [b], 'arena');
    expect(welcome(b).map.kind).toBe('arenaGate');
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    b.emit({ t: 'ready', ready: true });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    expect(welcome(b).map.kind).toBe('arena');
    expect(ended(a)?.reason).toBe('Hero1 is in an Arena run');
    expect(welcome(a).map.kind).not.toBe('arena');
  });

  it('refuses a dungeon run shared with players outside the party', async () => {
    const { rooms, sockets } = await setup(3);
    const [a, b] = pair(sockets);
    const c = sockets[2];
    if (!c) throw new Error('no socket');
    party(a, b);
    // Hero1 and the stranger Hero2 go into the same dungeon run through the first dungeon's gate.
    walkInto(rooms, [b, c], 'zone');
    const def = loadMap(welcome(b).map).def;
    const gate = def.portals.find((p) => p.target === 'staging');
    if (!gate) throw new Error("the first zone has no dungeon gate");
    walkInto(rooms, [b, c], 'staging');
    b.emit({ t: 'ready', ready: true });
    c.emit({ t: 'ready', ready: true });
    ticks(rooms, DUNGEON.countdownSeconds + 0.2);
    expect(welcome(b).map.kind).toBe('dungeon');
    expect(welcome(c).roomId).toBe(welcome(b).roomId);
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('Hero1 is in a dungeon run with players outside your party');
    c.close();
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(a.last('teleportChannel')?.to).toBe('Hero1');
  });
});

describe('channelBreak', () => {
  const at: ChannelWatch = { roomId: 'r', x: 100, y: 100, life: 50, castCooldown: 0, dashing: false, dead: false };
  it('holds while standing still and regenerating, and breaks on each interruption', () => {
    expect(channelBreak(at, at, { ...at, x: 103, life: 51 })).toBeNull();
    expect(channelBreak(at, at, null)).toMatch(/left/);
    expect(channelBreak(at, at, { ...at, roomId: 'q' })).toMatch(/left/);
    expect(channelBreak(at, at, { ...at, dead: true })).toMatch(/died/);
    expect(channelBreak(at, at, { ...at, life: 49 })).toMatch(/damage/);
    expect(channelBreak(at, at, { ...at, x: 120 })).toMatch(/moved/);
    expect(channelBreak(at, at, { ...at, dashing: true })).toMatch(/moved/);
    expect(channelBreak(at, { ...at, castCooldown: 0.2 }, { ...at, castCooldown: 0.5 })).toMatch(/cast/);
    expect(channelBreak(at, { ...at, castCooldown: 0.5 }, { ...at, castCooldown: 0.45 })).toBeNull();
  });
});
