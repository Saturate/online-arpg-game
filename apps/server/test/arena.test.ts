import { ARENA, DUNGEON, killScore, loadMap, monsterXp, seasonOf, SIM, type ClassId, type EnemyComp, type ServerMessage } from '@rune/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dealDamage } from '../../../packages/shared/src/sim/combat.js';
import { AccountStore } from '../src/accounts.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Players join the public world. Owners (by account name) get the dev tools, used here to teleport onto portals. */
async function setup(players: number, owners: ReadonlySet<string> = new Set(), classes: readonly ClassId[] = []) {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, owners);
  const sockets: FakeSocket[] = [];
  const characters: number[] = [];
  for (let i = 0; i < players; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, classes[i] ?? 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    sockets.push(socket);
    characters.push(ch.id);
  }
  return { store, rooms, sockets, characters };
}

const allOwners = (n: number): ReadonlySet<string> => new Set(Array.from({ length: n }, (_, i) => `player${i}`));

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

/** Teleports onto the first portal with this target in the player's current room, and lets it fire. */
function walkInto(rooms: RoomManager, sockets: FakeSocket[], target: string): void {
  for (const s of sockets) {
    const portal = loadMap(welcome(s).map).def.portals.find((p) => p.target === target);
    if (!portal) throw new Error(`no ${target} portal`);
    s.emit({ t: 'dev', cmd: { c: 'teleport', x: portal.x, y: portal.y } });
  }
  // Past the arrival cooldown, so the portal fires.
  ticks(rooms, 2);
}

function startRun(rooms: RoomManager, sockets: FakeSocket[]): void {
  walkInto(rooms, sockets, 'arena');
  for (const s of sockets) expect(welcome(s).map.kind).toBe('arenaGate');
  for (const s of sockets) s.emit({ t: 'ready', ready: true });
  ticks(rooms, DUNGEON.countdownSeconds + 0.2);
  for (const s of sockets) expect(welcome(s).map.kind).toBe('arena');
}

function untilWave(rooms: RoomManager, room: Room, wave: number): void {
  for (let i = 0; i < 20 * SIM.tickRate && room.sim.wave < wave; i++) rooms.tick();
  expect(room.sim.wave).toBe(wave);
}

describe('Arena runs', () => {
  it('goes from the town portal to the Arena gate, and on a ready check into a fresh run', async () => {
    const { rooms, sockets } = await setup(2, allOwners(2));
    walkInto(rooms, sockets, 'arena');
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    expect(welcome(a).map.kind).toBe('arenaGate');
    expect(a.last('staging')).toMatchObject({ kind: 'arena', level: 1, open: false });
    a.emit({ t: 'ready', ready: true });
    ticks(rooms, DUNGEON.countdownSeconds + 0.2);
    // Not everyone is ready, so nobody goes.
    expect(welcome(a).map.kind).toBe('arenaGate');
    b.emit({ t: 'ready', ready: true });
    ticks(rooms, DUNGEON.countdownSeconds + 0.2);
    expect(welcome(a).map.kind).toBe('arena');
    expect(welcome(a).roomId).toBe(welcome(b).roomId);
    // A scored run: no pausing, no bench, no dev tools.
    expect(welcome(a)).toMatchObject({ canPause: false, editor: false, devTools: false });
    expect(a.last('arena')).toMatchObject({ wave: 0, score: 0, alive: 2, inside: 2 });
  });

  it('takes no latecomers: the pit stays shut and staff cannot jump in', async () => {
    const { rooms, sockets } = await setup(3, allOwners(3));
    const [a, b, late] = sockets;
    if (!a || !b || !late) throw new Error('no sockets');
    startRun(rooms, [a, b]);
    walkInto(rooms, [late], 'arena');
    expect(welcome(late).map.kind).toBe('arenaGate');
    expect(late.last('staging')).toMatchObject({ open: false, inside: 2 });
    walkInto(rooms, [late], 'dungeon');
    expect(welcome(late).map.kind).toBe('arenaGate');
    expect(late.sent.some((m) => m.t === 'notice' && m.text.includes('pit opens'))).toBe(true);
    late.emit({ t: 'chat', text: '/goto Hero0' });
    expect(late.last('chat')?.text).toBe('That player is in an Arena run');
    expect(welcome(late).map.kind).toBe('arenaGate');
  });

  it('drops no loot or gold, pays half XP, scores kills and cleared waves', async () => {
    const { rooms, sockets } = await setup(1, allOwners(1));
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    startRun(rooms, [a]);
    const room = roomOf(rooms, a);
    const sim = room.sim;
    const pid = welcome(a).playerId;
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const goldBefore = p.gold;
    untilWave(rooms, room, 1);
    const killed: EnemyComp[] = [...sim.world.enemy.values()].map((e) => ({ ...e }));
    expect(killed.length).toBeGreaterThanOrEqual(ARENA.baseCount);
    for (const id of [...sim.world.enemy.keys()]) dealDamage(sim, id, 1e9, pid, []);
    rooms.tick();
    expect(sim.world.loot.size).toBe(0);
    expect(p.gold).toBe(goldBefore);
    // Wave 1 is level 1 for a level 1 party, so no level-gap penalty muddies the sum.
    expect(p.level).toBe(1);
    expect(p.xp).toBeCloseTo(killed.reduce((s, e) => s + monsterXp(e), 0) * ARENA.xpMultiplier, 6);
    const kills = killed.reduce((s, e) => s + killScore(e), 0);
    expect(sim.arena?.score).toBe(kills + ARENA.waveClearBonus);
    rooms.tick();
    expect(a.last('arena')).toMatchObject({ wave: 1, score: kills + ARENA.waveClearBonus });
  });

  it('gives one life, ends when everyone is down, records the run, and returns to the gate', async () => {
    const { store, rooms, sockets, characters } = await setup(1, allOwners(1));
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    startRun(rooms, [a]);
    const room = roomOf(rooms, a);
    const sim = room.sim;
    const pid = welcome(a).playerId;
    untilWave(rooms, room, 1);
    for (const id of [...sim.world.enemy.keys()]) dealDamage(sim, id, 1e9, pid, []);
    untilWave(rooms, room, 2);
    const score = sim.arena?.score ?? 0;
    const xp = sim.world.player.get(pid)?.xp ?? 0;
    dealDamage(sim, pid, 1e9, pid, []);
    ticks(rooms, SIM.playerRespawnSeconds + 1);
    // Still down, well past the normal respawn.
    expect(sim.world.player.get(pid)?.respawnIn).not.toBeNull();
    const result = a.last('arenaResult');
    const season = seasonOf(Date.now());
    expect(result).toMatchObject({ score, wave: 2, board: 'solo', rank: 1, season, party: [{ name: 'Hero0', cls: 'warrior' }] });
    const board = store.leaderboard(season);
    expect(board.solo).toEqual([expect.objectContaining({ names: ['Hero0'], classes: ['warrior'], partySize: 1, score, wave: 2 })]);
    expect(board.party).toEqual([]);

    ticks(rooms, ARENA.resultSeconds);
    expect(welcome(a).map.kind).toBe('arenaGate');
    // Back on their feet in the gate, and the XP earned in the run was saved on the way out.
    const gate = roomOf(rooms, a);
    expect(gate.sim.world.player.get(welcome(a).playerId)?.respawnIn).toBeNull();
    expect(rooms.roomById(room.id)).toBeUndefined();
    const acc = store.accountForCharacter(characters[0] ?? -1);
    const saved = acc ? store.loadCharacter(acc.id, characters[0] ?? -1)?.save : null;
    expect(saved?.xp).toBeCloseTo(xp, 6);
  });

  it('ends a party run when one is dead and the other has left, and files it on the party board', async () => {
    const { store, rooms, sockets } = await setup(2, allOwners(2));
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    startRun(rooms, [a, b]);
    const room = roomOf(rooms, a);
    untilWave(rooms, room, 1);
    b.emit({ t: 'townPortal' });
    expect(welcome(b).map.kind).toBe('world');
    rooms.tick();
    expect(a.last('arenaResult')).toBeUndefined();
    dealDamage(room.sim, welcome(a).playerId, 1e9, welcome(a).playerId, []);
    rooms.tick();
    expect(a.last('arenaResult')).toMatchObject({ board: 'party', wave: 1 });
    expect(store.leaderboard(seasonOf(Date.now())).party).toEqual([expect.objectContaining({ names: ['Hero0', 'Hero1'], partySize: 2 })]);
  });

  it('desummons a fallen Binder\'s warband for the rest of the run and brings it back at the gate', async () => {
    const { rooms, sockets } = await setup(2, allOwners(2), ['binder', 'warrior']);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    startRun(rooms, [a, b]);
    const room = roomOf(rooms, a);
    const pid = welcome(a).playerId;
    const warband = (): number => [...room.sim.world.minion.values()].filter((m) => m.ownerId === pid).length;
    untilWave(rooms, room, 1);
    expect(warband()).toBeGreaterThan(0);
    dealDamage(room.sim, pid, 1e9, pid, []);
    rooms.tick();
    expect(warband()).toBe(0);
    ticks(rooms, SIM.playerRespawnSeconds + 1);
    expect(room.sim.world.player.get(pid)?.respawnIn).not.toBeNull();
    expect(warband()).toBe(0);
    // The other member leaves, which ends the run; after the score screen the Binder is at the gate with the warband.
    b.emit({ t: 'townPortal' });
    rooms.tick();
    expect(a.last('arenaResult')).toBeDefined();
    ticks(rooms, ARENA.resultSeconds);
    expect(welcome(a).map.kind).toBe('arenaGate');
    const gate = roomOf(rooms, a);
    const back = welcome(a).playerId;
    rooms.tick();
    expect([...gate.sim.world.minion.values()].filter((m) => m.ownerId === back).length).toBeGreaterThan(0);
  });

  it('refuses dev commands inside a run', async () => {
    const { rooms, sockets } = await setup(1, allOwners(1));
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    startRun(rooms, [a]);
    a.emit({ t: 'dev', cmd: { c: 'spawn', enemy: 'chaser', count: 3, rare: false, level: 1, x: 1400, y: 1000 } });
    expect(a.last('notice')?.text).toBe('Dev tools are off in Arena runs');
    expect(roomOf(rooms, a).sim.world.enemy.size).toBe(0);
  });
});

describe('builders sandbox', () => {
  it('opens a private flat room with the bench for builders only, and /sandbox again leaves it', async () => {
    const { rooms, sockets } = await setup(2, new Set(['player0']));
    const [builder, player] = sockets;
    if (!builder || !player) throw new Error('no sockets');
    player.emit({ t: 'chat', text: '/sandbox' });
    expect(player.last('chat')?.text).toBe('Unknown command /sandbox. Try /help');
    expect(welcome(player).map.kind).toBe('world');

    builder.emit({ t: 'chat', text: '/sandbox' });
    expect(welcome(builder)).toMatchObject({ map: { kind: 'flat' }, editor: true, devTools: true });
    const sandbox = roomOf(rooms, builder);
    ticks(rooms, 10);
    // No waves: builders spawn what they test.
    expect(sandbox.sim.world.enemy.size).toBe(0);
    player.emit({ t: 'chat', text: '/goto Hero0' });
    expect(welcome(player).map.kind).toBe('world');

    builder.emit({ t: 'chat', text: '/sandbox' });
    expect(welcome(builder).map.kind).toBe('world');
  });
});

describe('leaderboard endpoint', () => {
  let server: Server;
  let base = '';
  const store = new AccountStore(':memory:');
  it('marks runs by staff on the board instead of hiding them', () => {
    const own = new AccountStore(':memory:');
    own.recordArenaRun({ season: '2026-09', names: ['Owner'], classes: ['mage'], score: 500, wave: 5, seconds: 60, finishedAt: 1, staff: true });
    expect(own.leaderboard('2026-09').solo).toEqual([expect.objectContaining({ names: ['Owner'], staff: true })]);
  });

  const run = (season: string, names: string[], score: number) =>
    store.recordArenaRun({ season, names, classes: names.map(() => 'mage'), score, wave: Math.ceil(score / 100), seconds: 60, finishedAt: 1, staff: false });

  beforeAll(async () => {
    const rooms = new RoomManager(1, store);
    const api = new AccountApi(store, () => undefined, rooms, new Set());
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  it('lists a season\'s solo and party boards and earlier winners, without logging in', async () => {
    expect(run('2026-08', ['Old'], 900)).toBe(1);
    run('2026-08', ['Older', 'Pal'], 500);
    run('2026-09', ['Ann'], 300);
    expect(run('2026-09', ['Bo'], 700)).toBe(1);
    expect(run('2026-09', ['Cy'], 300)).toBe(3);
    run('2026-09', ['Ann', 'Bo'], 1200);
    const res = await fetch(`${base}/api/arena/leaderboard?season=2026-09`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      season: '2026-09',
      solo: [{ names: ['Bo'], score: 700 }, { names: ['Ann'], score: 300 }, { names: ['Cy'], score: 300 }],
      party: [{ names: ['Ann', 'Bo'], partySize: 2, score: 1200 }],
      winners: [{ season: '2026-08', solo: { names: ['Old'] }, party: { names: ['Older', 'Pal'] } }],
    });
    expect((await fetch(`${base}/api/arena/leaderboard?season=2026-13`)).status).toBe(400);
    expect((await fetch(`${base}/api/arena/leaderboard?season=x';--`)).status).toBe(400);
    const current: unknown = await (await fetch(`${base}/api/arena/leaderboard`)).json();
    expect(current).toMatchObject({ season: seasonOf(Date.now()) });
  });
});
