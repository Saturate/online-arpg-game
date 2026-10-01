import { DUNGEON, INSTANCE_CAPACITY, loadMap, SIM, type PartyMemberStatus, type ServerMessage } from '@rune/shared';
import { describe, expect, it, vi } from 'vitest';
import { dealDamage } from '../../../packages/shared/src/sim/combat.js';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { channelBreak, TELEPORT_CHANNEL_SECONDS, type ChannelWatch } from '../src/partyTravel.js';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/**
 * Everyone is an owner, for the dev teleport onto portals and god mode against stray monsters.
 * `join` brings in more players later, up to `total`, so a test can fill a world copy after the fact.
 */
async function setup(players: number, total = players) {
  const store = new AccountStore(':memory:');
  const owners = new Set(Array.from({ length: total }, (_, i) => `player${i}`));
  const rooms = new RoomManager(1, store, owners);
  const sockets: FakeSocket[] = [];
  const join = async (): Promise<FakeSocket> => {
    const i = sockets.length;
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    socket.emit({ t: 'dev', cmd: { c: 'god', on: true } });
    sockets.push(socket);
    return socket;
  };
  for (let i = 0; i < players; i++) await join();
  return { store, rooms, sockets, join };
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

/** Out of town along the east road, beside its first waypoint: the same world room, far from the town. */
function goOut(rooms: RoomManager, sockets: FakeSocket[]): void {
  for (const [i, s] of sockets.entries()) {
    const wp = loadMap(welcome(s).map).def.portals.find((p) => p.waypoint === 'steppe-1');
    if (!wp) throw new Error('no east waypoint');
    s.emit({ t: 'dev', cmd: { c: 'teleport', x: wp.x + 160 + i * 30, y: wp.y } });
  }
  ticks(rooms, 0.5);
}

/** Hero1 goes out of town into the world, away from Hero0 in town, and clears it. */
async function apart() {
  const { store, rooms, sockets } = await setup(2);
  const [a, b] = pair(sockets);
  party(a, b);
  goOut(rooms, [b]);
  expect(welcome(b).map.kind).toBe('world');
  expect(welcome(b).roomId).toBe(welcome(a).roomId);
  b.emit({ t: 'dev', cmd: { c: 'killAll' } });
  return { store, rooms, a, b };
}

describe('party status', () => {
  it('sends every member the others once a second, with place, region, life and a position only in the same room', async () => {
    const { rooms, a, b } = await apart();
    a.sent.length = 0;
    ticks(rooms, 1);
    expect(a.sent.filter((m) => m.t === 'partyStatus')).toHaveLength(1);
    const seen = status(a, 'Hero1');
    // Out on the east road the world names the region, not the room.
    expect(seen).toMatchObject({ cls: 'warrior', level: 1, place: 'wilds', dead: false, zone: 'Ashen Steppe' });
    expect(seen?.maxLife).toBeGreaterThan(0);
    // The whole world is one room, so the frames get a position to point the minimap at.
    expect(seen?.x).toBeDefined();
    expect(seen?.no).toBeUndefined();
    expect(status(a, 'Hero0')).toBeUndefined();
    expect(status(b, 'Hero0')).toMatchObject({ place: 'town', zone: 'Emberwatch' });
    // In another room (a dungeon's antechamber), no position.
    walkInto(rooms, [b], 'staging');
    ticks(rooms, 1);
    expect(status(a, 'Hero1')?.place).toBe('dungeon');
    expect(status(a, 'Hero1')?.x).toBeUndefined();

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
  it('channels for 3 s, then puts the player beside the member across the world', async () => {
    const { rooms, a, b } = await apart();
    a.emit({ t: 'partyTeleport', name: 'hero1' });
    expect(a.last('teleportChannel')).toEqual({ t: 'teleportChannel', to: 'Hero1', seconds: TELEPORT_CHANNEL_SECONDS });
    const target = self(rooms, b).pos;
    expect(Math.hypot(self(rooms, a).pos.x - target.x, self(rooms, a).pos.y - target.y)).toBeGreaterThan(2000);
    ticks(rooms, TELEPORT_CHANNEL_SECONDS - 0.2);
    expect(Math.hypot(self(rooms, a).pos.x - target.x, self(rooms, a).pos.y - target.y)).toBeGreaterThan(2000);
    ticks(rooms, 0.3);
    expect(ended(a)).toEqual({ t: 'teleportChannel', to: null, reason: null });
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    const there = self(rooms, a).pos;
    expect(Math.hypot(there.x - target.x, there.y - target.y)).toBeLessThan(150);
  });

  it('carries the player into the member\'s room when that is another one, saving on the way', async () => {
    const { store, rooms, a, b } = await apart();
    walkInto(rooms, [b], 'staging');
    expect(welcome(b).map.kind).toBe('staging');
    const save = vi.spyOn(store, 'saveCharacterAndStash');
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    // The same room change as waypoints and portals: the character is written on the way out.
    expect(save).toHaveBeenCalled();

    // And back the other way, into the world.
    a.emit({ t: 'townPortal' });
    b.emit({ t: 'partyTeleport', name: 'Hero0' });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    expect(welcome(b).roomId).toBe(welcome(a).roomId);
    expect(welcome(b).map.kind).toBe('world');
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
    expect(welcome(a).map.kind).toBe('world');
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

describe('teleport across world copies', () => {
  /** Hero0 waits in the party's own world; Hero1 is back in Public world 1, which strangers then fill. */
  async function split() {
    const { rooms, sockets, join } = await setup(2, 2 + 2 * (INSTANCE_CAPACITY - 1));
    const [a, b] = pair(sockets);
    party(a, b);
    a.emit({ t: 'partyWorld' });
    b.emit({ t: 'publicWorld' });
    expect(a.worldName()).toBe("Hero0's party world");
    expect(b.worldName()).toBe('Public world 1');
    const strangers: FakeSocket[] = [];
    for (let i = 1; i < INSTANCE_CAPACITY; i++) strangers.push(await join());
    for (const s of strangers) expect(s.worldName()).toBe('Public world 1');
    expect(b.last('world')?.world.players).toBe(INSTANCE_CAPACITY);
    return { rooms, a, b, strangers, join };
  }

  it('moves a member into the other copy even when it counts as full, past its soft capacity', async () => {
    const { rooms, a, b } = await split();
    ticks(rooms, 1);
    expect(status(a, 'Hero1')?.no).toBeUndefined();
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(a.last('teleportChannel')?.to).toBe('Hero1');
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    expect(ended(a)?.reason).toBeNull();
    expect(a.worldName()).toBe('Public world 1');
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    expect(b.last('world')?.world.players).toBe(INSTANCE_CAPACITY + 1);
  });

  it('still sends strangers to another copy once one is over its soft capacity', async () => {
    const { rooms, a, join } = await split();
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.1);
    const late = await join();
    expect(late.worldName()).toBe('Public world 2');
  });

  it('refuses at the hard cap, which only a second party overflowing the same copy can reach', async () => {
    const { a, strangers, join } = await split();
    const host = strangers[0];
    if (!host) throw new Error('no stranger');
    // A stranger's party of the most members there can be, all joining from Public world 2.
    for (let i = 1; i < INSTANCE_CAPACITY; i++) {
      const guest = await join();
      expect(guest.worldName()).toBe('Public world 2');
      host.emit({ t: 'partyInvite', name: `Hero${INSTANCE_CAPACITY + i}` });
      guest.emit({ t: 'partyAnswer', accept: true });
      expect(guest.worldName()).toBe('Public world 1');
    }
    expect(host.last('world')?.world.players).toBe(2 * INSTANCE_CAPACITY - 1);
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe("Hero1's world is full");
  });
});

describe('party XP', () => {
  it('tells the simulation who is in which party, so a kill pays the party and not a stranger beside it', async () => {
    const { rooms, sockets } = await setup(3);
    const [a, b] = pair(sockets);
    const c = sockets[2];
    if (!c) throw new Error('no socket');
    party(a, b);
    goOut(rooms, [a, b, c]);
    const room = roomOf(rooms, a);
    expect(roomOf(rooms, c)).toBe(room);
    a.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 0.1);
    const [me, mate, stranger] = [a, b, c].map((s) => self(rooms, s));
    if (!me || !mate || !stranger) throw new Error('no players');
    expect(me.p.party).not.toBeNull();
    expect(mate.p.party).toBe(me.p.party);
    expect(stranger.p.party).toBeNull();
    const xp = [me, mate, stranger].map((x) => x.p.xp);
    const eid = room.sim.spawnEnemy('chaser', me.pos.x + 60, me.pos.y);
    dealDamage(room.sim, eid, 1e9, welcome(a).playerId, []);
    expect(me.p.xp).toBeGreaterThan(xp[0] ?? 0);
    expect(mate.p.xp).toBeGreaterThan(xp[1] ?? 0);
    expect(stranger.p.xp).toBe(xp[2]);

    // Leaving the party takes effect on the next tick.
    b.emit({ t: 'partyLeave' });
    ticks(rooms, 0.1);
    expect(me.p.party).toBeNull();
    expect(mate.p.party).toBeNull();
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
