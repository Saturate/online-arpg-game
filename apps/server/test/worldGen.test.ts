import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTunables, gateTimers, loadMap, openedChests, planChecksum, resetTunables, SIM, Simulation, type GateInfo, type ServerMessage, type Vec2, type WorldRebuildResult } from '@rune/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { WorldGenStore } from '../src/worldGenStore.js';
import { DatabaseSync } from 'node:sqlite';
import type { Room } from '../src/room.js';
import { FakeSocket } from './fakeSocket.js';

vi.mock('../src/townStore.js', async (original) => ({ ...(await original<typeof import('../src/townStore.js')>()), saveTownLayout: () => undefined }));

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

afterEach(() => resetTunables());

async function enter(store: AccountStore, rooms: RoomManager, name: string): Promise<{ socket: FakeSocket; accountId: number }> {
  const acc = await store.register(name, 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, `${name}Hero`, 'warrior');
  if (typeof ch === 'string') throw new Error(ch);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  socket.emit({ t: 'dev', cmd: { c: 'god', on: true } });
  return { socket, accountId: acc.id };
}

async function setup(players: number, file = ':memory:') {
  const store = new AccountStore(file);
  const names = Array.from({ length: players }, (_, i) => `player${i}`);
  const rooms = new RoomManager(1, store, new Set(names));
  const joined = [];
  for (const n of names) joined.push(await enter(store, rooms, n));
  ticks(rooms, 0.2);
  return { store, rooms, sockets: joined.map((j) => j.socket), ids: joined.map((j) => j.accountId) };
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

function planOf(rooms: RoomManager, s: FakeSocket) {
  const plan = roomOf(rooms, s).sim.zone?.plan;
  if (!plan) throw new Error('no plan');
  return plan;
}

function teleport(rooms: RoomManager, s: FakeSocket, x: number, y: number): void {
  s.emit({ t: 'dev', cmd: { c: 'teleport', x, y } });
  ticks(rooms, 0.2);
}

function result(r: WorldRebuildResult | string): WorldRebuildResult {
  if (typeof r === 'string') throw new Error(r);
  return r;
}

function townSide(g: GateInfo, d: number): Vec2 {
  return { x: g.x - Math.cos(g.angle) * d, y: g.y - Math.sin(g.angle) * d };
}

/** The gate boss of the east road killed with the dev tools, standing near it on the town side. */
function killGateBoss(rooms: RoomManager, s: FakeSocket): GateInfo {
  const g = (loadMap(welcome(s).map).def.gates ?? []).find((x) => x.id === 'steppe-gate');
  if (!g) throw new Error('no east gate');
  const near = townSide(g, 300);
  teleport(rooms, s, near.x, near.y);
  ticks(rooms, 0.5);
  s.emit({ t: 'dev', cmd: { c: 'killAll' } });
  ticks(rooms, 2);
  return g;
}

/** Opens the nearest chest of the home side by standing on it. */
function openChest(rooms: RoomManager, s: FakeSocket): void {
  const chest = roomOf(rooms, s).sim.mapDef.chests?.[0];
  if (!chest) throw new Error('no chest');
  teleport(rooms, s, chest.x + 30, chest.y);
  ticks(rooms, 0.5);
}

describe('world generation numbers per world copy', () => {
  it('builds a new copy with a changed number and leaves a running one as it was', async () => {
    const { rooms, sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    const running = welcome(a);
    const before = planChecksum(planOf(rooms, a));
    expect(running.map.kind === 'world' && running.map.gen).toBeFalsy();

    applyTunables({ 'worldgen.levelMax': 40, 'worldgen.packs': 300, 'worldgen.trunkWander': 0.3 });
    ticks(rooms, 1);
    // The running copy keeps its numbers: same room, same plan, no new welcome.
    expect(welcome(a)).toBe(running);
    expect(planChecksum(planOf(rooms, a))).toBe(before);
    expect(planOf(rooms, a).gen.levelMax).toBe(25);

    // A party world opened now is a new copy: it takes the numbers in force.
    a.emit({ t: 'partyInvite', name: 'player1Hero' });
    b.emit({ t: 'partyAnswer', accept: true });
    ticks(rooms, 0.2);
    a.emit({ t: 'partyWorld' });
    ticks(rooms, 0.5);
    const party = welcome(a);
    expect(party.roomId).not.toBe(running.roomId);
    expect(party.map.kind === 'world' ? party.map.gen : null).toEqual({ packs: 300, trunkWander: 0.3, levelMax: 40 });
    const plan = planOf(rooms, a);
    expect(plan.gen.levelMax).toBe(40);
    expect(Math.max(...plan.nodes.filter((n) => n.road >= 0).map((n) => plan.levelAt(n.x, n.y)))).toBe(40);
    // The welcome's checksum is the plan's, and a client building from the welcome's descriptor gets it.
    expect(party.planHash).toBe(planChecksum(plan));
    const client = loadMap(party.map).zone?.plan;
    expect(client && planChecksum(client)).toBe(party.planHash);
  }, 60_000);

  it('rebuilds the public world with its own numbers after a restart, not the ones in force then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-worldgen-'));
    const file = join(dir, 'rune.db');
    try {
      const first = await setup(0, file);
      first.store.tunables.commit([{ path: 'worldgen.levelMax', old: null, new: 40 }], { account: 'test', token: null });
      applyTunables(first.store.tunables.load());
      const { socket } = await enter(first.store, first.rooms, 'early');
      ticks(first.rooms, 0.2);
      const built = welcome(socket);
      expect(built.map.kind === 'world' ? built.map.gen : null).toEqual({ levelMax: 40 });
      socket.close();
      first.store.tunables.commit([{ path: 'worldgen.levelMax', old: 40, new: 30 }], { account: 'test', token: null });
      first.store.close();

      // The restart: a new manager over the same database, live tuning loaded with levelMax 30.
      const store = new AccountStore(file);
      const rooms = new RoomManager(1, store, new Set());
      const { socket: again } = await enter(store, rooms, 'late');
      ticks(rooms, 0.2);
      const rebuilt = welcome(again);
      expect(rebuilt.map).toEqual(built.map);
      expect(rebuilt.planHash).toBe(built.planHash);
      // A party world made now would take the 30.
      expect(rooms.live().worlds[0]?.genCurrent).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('force rebuild', () => {
  it('keeps the memory when the plan is the same and carries everyone over', async () => {
    const { rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const g = killGateBoss(rooms, a);
    openChest(rooms, a);
    const room = roomOf(rooms, a);
    const chests = [...openedChests(room.sim)];
    expect(chests.length).toBeGreaterThan(0);
    const at = pos(rooms, a);
    const hash = welcome(a).planHash;

    const r = result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    expect(r.copies).toEqual([{ game: 'i1', name: 'Public world 1', seed: 1, open: true, players: 1, planChanged: false }]);
    ticks(rooms, 0.2);
    const next = roomOf(rooms, a);
    expect(next).not.toBe(room);
    expect(welcome(a).planHash).toBe(hash);
    const p = pos(rooms, a);
    expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeLessThan(60);
    expect(gateTimers(next.sim).map((t) => t.id)).toEqual([g.id]);
    expect([...openedChests(next.sim)]).toEqual(chests);
  }, 60_000);

  it('drops the memory when the plan changes, says so, and carries everyone to open ground inside a smaller world', async () => {
    const { rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    killGateBoss(rooms, a);
    openChest(rooms, a);
    const old = welcome(a);
    // Far out on the map, past where an 11000 world ends.
    const far = planOf(rooms, a).nodes.reduce((best, n) => (Math.hypot(n.x - 6500, n.y - 6500) > Math.hypot(best.x - 6500, best.y - 6500) ? n : best));
    teleport(rooms, a, far.x, far.y);
    expect(Math.max(far.x, far.y, 13000 - far.x, 13000 - far.y)).toBeGreaterThan(11000);

    applyTunables({ 'worldgen.size': 11000, 'worldgen.hubRadius': 1800, 'worldgen.rareShare': 0.25 });
    const r = result(rooms.rebuildWorlds(ids[0] ?? 0, 'i1'));
    expect(r.gen).toEqual({ size: 11000, hubRadius: 1800, rareShare: 0.25 });
    expect(r.copies[0]).toMatchObject({ game: 'i1', open: true, players: 1, planChanged: true });
    ticks(rooms, 0.2);
    const now = welcome(a);
    expect(now.roomId).toBe(old.roomId);
    expect(now.planHash).not.toBe(old.planHash);
    expect(now.map.kind === 'world' ? now.map.gen : null).toEqual(r.gen);
    const sim = roomOf(rooms, a).sim;
    expect(sim.mapDef.width).toBe(11000);
    expect(gateTimers(sim)).toEqual([]);
    expect(openedChests(sim).size).toBe(0);
    const p = pos(rooms, a);
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(11000);
    expect(p.y).toBeLessThan(11000);
    expect(sim.map.pointBlocked(p.x, p.y, SIM.playerRadius, 'move')).toBe(false);
    expect(sim.zone?.reachable(p.x, p.y)).toBe(true);
    const said = a.sent.filter((m) => m.t === 'chat' && m.kind === 'system').map((m) => (m.t === 'chat' ? m.text : ''));
    expect(said.at(-1)).toContain('bosses and chests are back');
  }, 60_000);

  it('gives the Live view the new region grid once the plan hash changes', async () => {
    const { rooms, ids } = await setup(1);
    const live = rooms.live();
    const world = live.worlds[0];
    if (!world?.regions || world.planHash === null) throw new Error('no grid');
    expect(world).toMatchObject({ kind: 'public', seed: 1, gen: {}, genCurrent: true });
    const have = new Map([[world.game, world.planHash]]);
    expect(rooms.live(have).worlds[0]?.regions).toBeNull();

    applyTunables({ 'worldgen.hubRadius': 2800 });
    expect(rooms.live(have).worlds[0]?.genCurrent).toBe(false);
    result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    const after = rooms.live(have).worlds[0];
    expect(after?.planHash).not.toBe(world.planHash);
    expect(after?.genCurrent).toBe(true);
    expect(after?.regions).not.toBeNull();
    expect(after?.regions?.cells).not.toEqual(world.regions.cells);
  }, 60_000);

  it('refuses an unknown copy and a second rebuild inside the cooldown', async () => {
    const { rooms, ids } = await setup(1);
    expect(rooms.rebuildWorlds(ids[0] ?? 0, 'i99')).toBe('No such world copy');
    result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    expect(rooms.rebuildWorlds(ids[0] ?? 0, null)).toBe('wait');
  }, 60_000);
});

describe('seed reroll and pin', () => {
  it('pins a seed for the public world, sets the world seed and rebuilds it with a new plan', async () => {
    const { rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const before = welcome(a);
    const r = result(rooms.rerollWorld(ids[0] ?? 0, 'i1', 4242));
    expect(r.copies).toEqual([{ game: 'i1', name: 'Public world 1', seed: 4242, open: true, players: 1, planChanged: true }]);
    expect(rooms.settings().worldSeed).toBe(4242);
    ticks(rooms, 0.2);
    const after = welcome(a);
    expect(after.roomId).toBe(before.roomId);
    expect(after.map.kind === 'world' && before.map.kind === 'world' && after.map.seed !== before.map.seed).toBe(true);
    expect(after.planHash).not.toBe(before.planHash);
    expect(rooms.live().worlds[0]?.seed).toBe(4242);
  }, 60_000);

  it('rerolls a party world to a random seed and leaves the world seed setting alone', async () => {
    const { rooms, sockets, ids } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    a.emit({ t: 'partyInvite', name: 'player1Hero' });
    b.emit({ t: 'partyAnswer', accept: true });
    ticks(rooms, 0.2);
    a.emit({ t: 'partyWorld' });
    ticks(rooms, 0.5);
    const party = rooms.live().worlds.find((w) => w.kind === 'party');
    if (!party) throw new Error('no party world');
    const r = result(rooms.rerollWorld(ids[0] ?? 0, party.game, null));
    expect(r.copies).toHaveLength(1);
    expect(r.copies[0]?.seed).not.toBe(party.seed);
    expect(r.copies[0]).toMatchObject({ players: 2, planChanged: true });
    expect(rooms.settings().worldSeed).toBe(1);
    expect(rooms.live().worlds.find((w) => w.game === party.game)?.seed).toBe(r.copies[0]?.seed);
  }, 60_000);
});

describe('the rebuild and reroll routes', () => {
  it('takes the tuning permission to rebuild and the settings permission to reroll, and checks the body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-worldgen-api-'));
    const store = new AccountStore(join(dir, 'rune.db'));
    const rooms = new RoomManager(1, store, new Set(['boss']));
    const sessions: Record<string, string> = {};
    for (const [name, role] of [
      ['boss', null],
      ['mod1', 'moderator'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      sessions[name] = store.createSession(acc.id);
    }
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']), { other: 100_000, token: 100_000 });
    const server: Server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const addr: AddressInfo | string | null = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const post = (path: string, who: string, body: unknown) =>
        fetch(`http://127.0.0.1:${addr.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${sessions[who] ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post('/api/admin/worlds/rebuild', 'mod1', {})).status).toBe(403);
      expect((await post('/api/admin/worlds/reroll', 'mod1', { game: 'i1' })).status).toBe(403);
      expect((await post('/api/admin/worlds/reroll', 'boss', {})).status).toBe(400);
      expect((await post('/api/admin/worlds/reroll', 'boss', { game: 'i1', seed: -1 })).status).toBe(400);
      expect((await post('/api/admin/worlds/rebuild', 'boss', { game: '../x' })).status).toBe(400);
      expect((await post('/api/admin/worlds/rebuild', 'boss', { game: 'i9' })).status).toBe(404);
      const ok = await post('/api/admin/worlds/rebuild', 'boss', {});
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ copies: [], failed: [], gen: {} });
      expect((await post('/api/admin/worlds/rebuild', 'boss', {})).status).toBe(429);
    } finally {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A bag of gold put on the ground directly, as a kill would drop it. */
function dropGold(room: Room, x: number, y: number): void {
  const w = room.sim.world;
  const id = w.create('loot');
  w.position.set(id, { x, y });
  w.radius.set(id, 16);
  w.loot.set(id, { items: [], gold: 77, lifetime: 900, dropper: null });
}

function goldBag(room: Room): Vec2 {
  const w = room.sim.world;
  for (const [id, l] of w.loot) {
    const p = w.position.get(id);
    if (l.gold === 77 && p) return { x: p.x, y: p.y };
  }
  throw new Error('no bag');
}

describe('a rebuild on another world size', () => {
  it.each([
    ['grows', 16000, 2400],
    ['shrinks', 11000, 1800],
  ])('keeps a player at the stash and a bag in town where they were in town when the world %s', async (_how, size, hub) => {
    const { rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const room = roomOf(rooms, a);
    const stash = room.sim.mapDef.stash;
    const town = room.sim.mapDef.townAt;
    if (!stash || !town) throw new Error('no stash');
    teleport(rooms, a, stash.x + 60, stash.y);
    const stood = pos(rooms, a);
    dropGold(room, town.x + 400, town.y + 300);
    const lay = goldBag(room);

    applyTunables({ 'worldgen.size': size, 'worldgen.hubRadius': hub });
    result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    ticks(rooms, 0.2);
    const next = roomOf(rooms, a);
    expect(next.sim.mapDef.width).toBe(size);
    const moved = next.sim.mapDef.townAt;
    if (!moved) throw new Error('no town');
    const shift = { x: moved.x - town.x, y: moved.y - town.y };
    expect(Math.abs(shift.x)).toBeGreaterThanOrEqual(1000);
    const p = pos(rooms, a);
    expect(Math.hypot(p.x - (stood.x + shift.x), p.y - (stood.y + shift.y))).toBeLessThan(40);
    expect(next.inSafeZone(p.x, p.y)).toBe(true);
    const bag = goldBag(next);
    expect(Math.hypot(bag.x - (lay.x + shift.x), bag.y - (lay.y + shift.y))).toBeLessThan(60);
    expect(room.sim.world.loot.size).toBe(0);
  }, 60_000);
});

describe('rebuild safety and limits', () => {
  it('keeps the memory when a changed number moves no ground', async () => {
    const { rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    const g = killGateBoss(rooms, a);
    openChest(rooms, a);
    const chests = [...openedChests(roomOf(rooms, a).sim)];
    const hash = welcome(a).planHash;
    applyTunables({ 'worldgen.levelMax': 40 });
    const r = result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    expect(r.copies[0]).toMatchObject({ planChanged: false, players: 1 });
    ticks(rooms, 0.2);
    // The checksum covers the numbers, so it changes; the ground the memory is kept by does not.
    expect(welcome(a).planHash).not.toBe(hash);
    const sim = roomOf(rooms, a).sim;
    expect(sim.zone?.plan?.gen.levelMax).toBe(40);
    expect(gateTimers(sim).map((t) => t.id)).toEqual([g.id]);
    expect([...openedChests(sim)]).toEqual(chests);
  }, 60_000);

  it('rebuilds one copy at most once a minute, whoever asks', async () => {
    const { rooms, ids } = await setup(2);
    result(rooms.rebuildWorlds(ids[0] ?? 0, null));
    const again = result(rooms.rebuildWorlds(ids[1] ?? 0, null));
    expect(again.copies).toEqual([]);
    expect(again.failed).toEqual([{ game: 'i1', name: 'Public world 1', reason: expect.stringMatching(/once a minute/) }]);
  }, 60_000);

  it('leaves a copy whose build fails as it was, says so, and goes on with the others', async () => {
    const { rooms, sockets, ids } = await setup(3);
    const [a, b, c] = sockets;
    if (!a || !b || !c) throw new Error('no sockets');
    // b and c in a party world, a alone in the public one.
    b.emit({ t: 'partyInvite', name: 'player2Hero' });
    c.emit({ t: 'partyAnswer', accept: true });
    ticks(rooms, 0.2);
    b.emit({ t: 'partyWorld' });
    ticks(rooms, 0.5);
    const publicRoom = roomOf(rooms, a);
    const before = welcome(a);
    applyTunables({ 'worldgen.packs': 300 });
    // The first room built (the public copy's) throws while it is made.
    const spy = vi.spyOn(Simulation.prototype, 'startItemUidsAt').mockImplementationOnce(() => {
      throw new Error('test: build failed');
    });
    const r = result(rooms.rerollWorld(ids[0] ?? 0, 'i1', 5150));
    spy.mockRestore();
    expect(r.failed).toEqual([{ game: 'i1', name: 'Public world 1', reason: 'the build failed; see the server log' }]);
    expect(r.copies).toEqual([]);
    // Nothing changed: same room, same map, the seed setting and the stored numbers untouched.
    expect(roomOf(rooms, a)).toBe(publicRoom);
    expect(welcome(a)).toBe(before);
    expect(rooms.settings().worldSeed).toBe(1);
    expect(rooms.live().worlds.find((w) => w.game === 'i1')?.seed).toBe(1);

    const spy2 = vi.spyOn(Simulation.prototype, 'startItemUidsAt').mockImplementationOnce(() => {
      throw new Error('test: build failed');
    });
    const all = result(rooms.rebuildWorlds(ids[1] ?? 0, null));
    spy2.mockRestore();
    expect(all.failed.map((f) => f.game)).toEqual(['i1']);
    expect(all.copies.map((x) => x.game)).toEqual(['i2']);
    expect(roomOf(rooms, b).sim.zone?.plan?.gen.packs).toBe(300);
  }, 60_000);

  it('pins a public copy onto a seed another public copy is on with that seed\'s numbers, not the ones in force', async () => {
    const { store, rooms, sockets, ids } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    // A second public copy on seed 2, made while levelMax was 40.
    rooms.updateSettings({ worldSeed: 2 });
    applyTunables({ 'worldgen.levelMax': 40 });
    const { socket: b } = await enter(store, rooms, 'second');
    ticks(rooms, 0.2);
    expect(welcome(b).map).toMatchObject({ gen: { levelMax: 40 } });
    applyTunables({ 'worldgen.levelMax': 30 });
    const r = result(rooms.rerollWorld(ids[0] ?? 0, 'i1', 2));
    expect(r.gen).toEqual({ levelMax: 40 });
    ticks(rooms, 0.2);
    expect(welcome(a).map).toEqual(welcome(b).map);
    expect(store.worldGen.publicGen(2)).toEqual({ levelMax: 40 });
  }, 60_000);
});

describe('stored public numbers', () => {
  it('keeps the readable numbers one by one and puts the rest back to their defaults', () => {
    const db = new DatabaseSync(':memory:');
    const s = new WorldGenStore(db);
    expect(s.publicGen(9)).toBeNull();
    db.prepare('INSERT INTO world_gen (seed, gen_json, updated_at) VALUES (?, ?, 0)').run(9, JSON.stringify({ packs: 300, size: 99999, gone: 1, levelMin: 30, levelMax: 20 }));
    expect(s.publicGen(9)).toEqual({ packs: 300 });
    db.prepare('INSERT INTO world_gen (seed, gen_json, updated_at) VALUES (?, ?, 0)').run(10, '{not json');
    expect(s.publicGen(10)).toEqual({});
    s.savePublic(11, { forests: 60, levelCurve: 2 });
    expect(s.publicGen(11)).toEqual({ forests: 60, levelCurve: 2 });
  });
});
