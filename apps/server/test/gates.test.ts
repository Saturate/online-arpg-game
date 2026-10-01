import { DEFAULT_SERVER_SETTINGS, DUNGEON, ENEMIES, gateBoss, loadMap, respawnTicks, SIM, type GateInfo, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { TELEPORT_CHANNEL_SECONDS } from '../src/partyTravel.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Everyone is an owner, for the dev teleport and god mode. */
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
  ticks(rooms, 2);
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

function hero(rooms: RoomManager, s: FakeSocket) {
  const p = roomOf(rooms, s).sim.world.player.get(welcome(s).playerId);
  if (!p) throw new Error('no player');
  return p;
}

function teleport(rooms: RoomManager, s: FakeSocket, x: number, y: number): void {
  s.emit({ t: 'dev', cmd: { c: 'teleport', x, y } });
  ticks(rooms, 0.2);
}

/** The east road's gate: Ashen Steppe into the Sunscorched Dunes, with the `dunes-1` waypoint past it. */
function eastGate(s: FakeSocket): GateInfo {
  const g = loadMap(welcome(s).map).def.gates?.find((x) => x.id === 'steppe-gate');
  if (!g) throw new Error('no east gate');
  return g;
}

function waypoint(s: FakeSocket, id: string): { x: number; y: number } {
  const p = loadMap(welcome(s).map).def.portals.find((x) => x.waypoint === id);
  if (!p) throw new Error(`no waypoint ${id}`);
  return p;
}

const notices = (s: FakeSocket): string[] => s.sent.flatMap((m) => (m.t === 'notice' ? [m.text] : []));

describe('gates on the server', () => {
  it('refuses a waypoint behind a gate the character has not opened, and travels once it has', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    // Found by an admin's goto, which skips the seal; travel there still needs the gate.
    const past = waypoint(a, 'dunes-1');
    teleport(rooms, a, past.x, past.y);
    ticks(rooms, 0.3);
    expect(hero(rooms, a).waypoints).toContain('dunes-1');
    const town = waypoint(a, 'town');
    teleport(rooms, a, town.x, town.y);
    ticks(rooms, 3.2);
    a.emit({ t: 'useWaypoint', waypoint: 'dunes-1' });
    ticks(rooms, 0.1);
    expect(notices(a).at(-1)).toBe('The Ashen Steppe Gate is sealed to you: slay its guardian first');
    const pos = roomOf(rooms, a).sim.world.position.get(welcome(a).playerId);
    expect(Math.hypot((pos?.x ?? 0) - town.x, (pos?.y ?? 0) - town.y)).toBeLessThan(120);

    hero(rooms, a).gates.push('steppe-gate');
    a.emit({ t: 'useWaypoint', waypoint: 'dunes-1' });
    ticks(rooms, 0.1);
    const there = roomOf(rooms, a).sim.world.position.get(welcome(a).playerId);
    expect(Math.hypot((there?.x ?? 0) - past.x, (there?.y ?? 0) - past.y)).toBeLessThan(250);
  });

  it('refuses a party teleport to a member past a gate the traveller has not opened', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    a.emit({ t: 'partyInvite', name: 'Hero1' });
    b.emit({ t: 'partyAnswer', accept: true });
    const g = eastGate(b);
    teleport(rooms, b, g.x + Math.cos(g.angle) * 400, g.y + Math.sin(g.angle) * 400);
    b.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 1.1);
    const seen = a.last('partyStatus')?.members.find((m) => m.name === 'Hero1');
    expect(seen?.no).toBe('Hero1 is past the Ashen Steppe Gate, which is sealed to you');
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    expect(notices(a).at(-1)).toBe('Hero1 is past the Ashen Steppe Gate, which is sealed to you');
    expect(a.last('teleportChannel')).toBeUndefined();

    // With the gate opened the same teleport goes through.
    hero(rooms, a).gates.push(g.id);
    a.emit({ t: 'partyTeleport', name: 'Hero1' });
    ticks(rooms, TELEPORT_CHANNEL_SECONDS + 0.3);
    const pa = roomOf(rooms, a).sim.world.position.get(welcome(a).playerId);
    const pb = roomOf(rooms, b).sim.world.position.get(welcome(b).playerId);
    expect(Math.hypot((pa?.x ?? 0) - (pb?.x ?? 0), (pa?.y ?? 0) - (pb?.y ?? 0))).toBeLessThan(120);
  });

  it('keeps a gate opened by a kill through a logout and a login', async () => {
    const { store, rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    const id = ids[0];
    if (!a || !id) throw new Error('no socket');
    const g = eastGate(a);
    teleport(rooms, a, g.bossX - Math.cos(g.angle) * 300, g.bossY - Math.sin(g.angle) * 300);
    ticks(rooms, 0.5);
    const room = roomOf(rooms, a);
    expect(gateBoss(room.sim, g.id)).not.toBeNull();
    a.emit({ t: 'dev', cmd: { c: 'killAll' } });
    ticks(rooms, 0.1);
    expect(hero(rooms, a).gates).toEqual([g.id]);
    expect(a.sent.some((m) => m.t === 'snapshot' && m.self?.gates.includes(g.id))).toBe(true);
    a.close();
    expect(store.loadCharacter(id.account, id.character)?.save?.gates).toEqual([g.id]);

    const again = new FakeSocket();
    rooms.connect(again);
    again.emit({ t: 'join', token: store.createSession(id.account), characterId: id.character });
    ticks(rooms, 0.2);
    expect(hero(rooms, again).gates).toEqual([g.id]);
  });
});

describe('boss settings', () => {
  it('reach running rooms on save: boss life and damage, and the gate timer apart from the region one', async () => {
    const { store, rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const sim = roomOf(rooms, a).sim;
    expect(sim.rates.bossLife).toBe(DEFAULT_SERVER_SETTINGS.bossLifeMultiplier);
    expect(sim.rates.bossDamage).toBe(DEFAULT_SERVER_SETTINGS.bossDamageMultiplier);
    expect(respawnTicks(sim).gates).toBe(DEFAULT_SERVER_SETTINGS.gateRespawnMinutes * 60 * SIM.tickRate);
    rooms.updateSettings({ bossLifeMultiplier: 2.5, bossDamageMultiplier: 4, gateRespawnMinutes: 45 });
    expect(sim.rates.bossLife).toBe(2.5);
    expect(sim.rates.bossDamage).toBe(4);
    expect(respawnTicks(sim).gates).toBe(45 * 60 * SIM.tickRate);
    expect(respawnTicks(sim).bosses).toBe(DEFAULT_SERVER_SETTINGS.bossRespawnMinutes * 60 * SIM.tickRate);
    expect(store.loadSettings()).toMatchObject({ bossLifeMultiplier: 2.5, bossDamageMultiplier: 4, gateRespawnMinutes: 45 });
  });

  it('reach the boss of a dungeon opened after the change, which spawns as its room is built', async () => {
    const { rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    rooms.updateSettings({ bossLifeMultiplier: 4, bossDamageMultiplier: 3 });
    const entrance = loadMap(welcome(a).map).def.portals.find((p) => p.target === 'staging');
    if (!entrance) throw new Error('no dungeon entrance');
    teleport(rooms, a, entrance.x, entrance.y);
    ticks(rooms, 2);
    a.emit({ t: 'ready', ready: true });
    ticks(rooms, DUNGEON.countdownSeconds + 0.2);
    expect(welcome(a).map.kind).toBe('dungeon');
    const sim = roomOf(rooms, a).sim;
    const bosses = [...sim.world.enemy].filter(([, e]) => e.boss);
    expect(bosses).toHaveLength(1);
    const [id, e] = bosses[0] ?? [];
    if (id === undefined || !e) throw new Error('no dungeon boss');
    const armored = e.affixes.filter((x) => x.id === 'armored').reduce((sum, x) => sum + x.value, 0);
    const levelLife = 1 + 0.28 * (e.level - 1);
    expect((sim.world.health.get(id)?.maxLife ?? 0) / (1 + armored / 100)).toBeCloseTo(ENEMIES[e.typeId].life * 3 * 4 * levelLife, -1);
    expect(e.damageMult).toBeCloseTo(3 * (1 + 0.14 * (e.level - 1)));
  });
});
