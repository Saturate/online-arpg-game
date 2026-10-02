import { chestKey, createGear, LOOT, markChestsOpened, openedChests, SIM, spawnBag, type Item, type ServerMessage, WILDS } from '@rune/shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import type { Room } from '../src/room.js';
import { parseSnapshot, RESUME_WINDOW_MS } from '../src/sessionSnapshot.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

interface Player {
  account: number;
  character: number;
  name: string;
}

/** A clock the test moves by hand, shared by the server before and after the restart. */
function testClock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Everyone is an owner, for the dev teleport. */
async function setup(count: number, clock = testClock()) {
  const store = new AccountStore(':memory:');
  const owners = new Set(Array.from({ length: count }, (_, i) => `player${i}`));
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    players.push({ account: acc.id, character: ch.id, name: `Hero${i}` });
  }
  const rooms = new RoomManager(1, store, owners, clock.now);
  const sockets = players.map((p) => join(rooms, store, p));
  return { store, rooms, sockets, players, clock, owners };
}

function join(rooms: RoomManager, store: AccountStore, p: Player): FakeSocket {
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(p.account), characterId: p.character });
  return socket;
}

/** The same database, a new process: a fresh manager that restores the snapshot before anyone joins. */
function reboot(store: AccountStore, owners: ReadonlySet<string>, clock: { now: () => number }): { rooms: RoomManager; summary: string } {
  const rooms = new RoomManager(1, store, owners, clock.now);
  return { rooms, summary: rooms.restore() };
}

function nth<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no entry ${i}`);
  return v;
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

function ticks(rooms: RoomManager, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds * SIM.tickRate); i++) rooms.tick();
}

/** An item as a player would recognise it: everything but its uids, which every room reissues. */
function fingerprint(item: Item): string {
  return JSON.stringify(item, (k, v: unknown) => (k === 'uid' ? undefined : v));
}

function rings(room: Room, n: number): Item[] {
  return Array.from({ length: n }, () => createGear(room.sim.newItemUid(), room.sim.rand.loot, 'magic', 1, { category: 'ring' }));
}

/** Every item in the database (characters and stashes) and on the ground of every open room, and the gold on the ground. */
function census(store: AccountStore, rooms: RoomManager, players: readonly Player[], roomIds: readonly string[]): { items: string[]; gold: number } {
  const items: string[] = [];
  let gold = 0;
  for (const p of players) {
    const ch = store.loadCharacter(p.account, p.character);
    for (const it of ch?.save?.items ?? []) items.push(fingerprint(it));
    const stash = store.loadStash(p.account);
    if (stash && stash !== 'unreadable') for (const it of stash.stash.items) items.push(fingerprint(it));
  }
  for (const id of roomIds) {
    const room = rooms.roomById(id);
    if (!room) continue;
    for (const [lid, l] of room.sim.world.loot) {
      if (!room.sim.world.isAlive(lid)) continue;
      for (const it of l.items) items.push(fingerprint(it));
      gold += l.gold;
    }
  }
  return { items: items.sort(), gold };
}

describe('session snapshot round trip', () => {
  it('brings back world copies with their seeds and numbers, memory, parties, piles and where everyone stood', async () => {
    const { store, rooms, sockets, players, clock, owners } = await setup(3);
    const [a, b, c] = sockets;
    if (!a || !b || !c) throw new Error('setup');
    // Hero0 and Hero1 open a party world; Hero2 stays in the public world.
    a.emit({ t: 'chat', text: '/invite Hero1' });
    b.emit({ t: 'partyAnswer', accept: true });
    a.emit({ t: 'partyWorld' });
    expect(a.worldName()).toBe("Hero0's party world");
    ticks(rooms, 1);
    const publicRoom = roomOf(rooms, c);
    const partyRoom = roomOf(rooms, a);
    const before = at(rooms, c);
    const spot = publicRoom.sim.map.findOpen(before.x + 600, before.y + 200, SIM.playerRadius + 6);
    c.emit({ t: 'dev', cmd: { c: 'teleport', x: spot.x, y: spot.y } });
    ticks(rooms, 0.5);
    const stood = { ...at(rooms, c) };
    // Ground loot in both copies, one pile with gold.
    spawnBag(publicRoom.sim, stood.x + 120, stood.y, rings(publicRoom, 3), LOOT.bagRadius, null);
    spawnBag(partyRoom.sim, at(rooms, a).x + 120, at(rooms, a).y, rings(partyRoom, 2), LOOT.bagRadius, null);
    const chest = publicRoom.sim.mapDef.chests?.[0];
    if (!chest) throw new Error('no chest');
    markChestsOpened(publicRoom.sim, [chestKey(chest)]);
    const worldsBefore = rooms.live().worlds.map((w) => ({ game: w.game, name: w.name, kind: w.kind, seed: w.seed, gen: w.gen }));
    const pilesBefore = (room: Room) => [...room.sim.world.loot.values()].map((l) => l.items.map(fingerprint).sort()).sort();
    const publicPiles = pilesBefore(publicRoom);
    const partyPiles = pilesBefore(partyRoom);

    const r = rooms.shutdown();
    expect(r.players).toBe(3);
    expect(r.piles).toBe(2);
    expect(c.sent.some((m) => m.t === 'restart' && m.seconds === 0)).toBe(true);
    expect(store.snapshots.has()).toBe(true);

    clock.advance(60_000);
    const { rooms: next, summary } = reboot(store, owners, clock);
    expect(summary).toContain('2 piles on the ground');
    // Used once: the row is gone, and a second boot restores nothing.
    expect(store.snapshots.has()).toBe(false);
    // Before anyone joined, the copies are back with their seeds and numbers, and the ground loot lies there.
    const restoredPublic = next.roomById(publicRoom.id);
    const restoredParty = next.roomById(partyRoom.id);
    if (!restoredPublic || !restoredParty) throw new Error('world rooms not restored');
    expect(pilesBefore(restoredPublic)).toEqual(publicPiles);
    expect(pilesBefore(restoredParty)).toEqual(partyPiles);
    expect(openedChests(restoredPublic.sim).has(chestKey(chest))).toBe(true);

    const a2 = join(next, store, nth(players, 0));
    const b2 = join(next, store, nth(players, 1));
    const c2 = join(next, store, nth(players, 2));
    expect(next.live().worlds.map((w) => ({ game: w.game, name: w.name, kind: w.kind, seed: w.seed, gen: w.gen }))).toEqual(worldsBefore);
    expect(a2.worldName()).toBe("Hero0's party world");
    expect(b2.worldName()).toBe("Hero0's party world");
    expect(a2.party()?.members.map((m) => m.name)).toEqual(['Hero0', 'Hero1']);
    expect(a2.party()?.hasWorld).toBe(true);
    expect(c2.worldName()).toBe('Public world 1');
    const back = at(next, c2);
    expect(Math.hypot(back.x - stood.x, back.y - stood.y)).toBeLessThan(40);
    expect(new RoomManager(1, store, owners, clock.now).restore()).toBe('no session snapshot');
  });

  it('puts a player who was in a dungeon beside its entrance, and one in the Arena in town', async () => {
    const { store, rooms, sockets, players, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 2);
    const world = roomOf(rooms, a);
    const entrance = world.sim.mapDef.portals.find((p) => p.target === 'staging' && p.dungeon && (world.sim.zone?.plan?.gateAt(p.x, p.y) ?? null) === null);
    if (!entrance?.dungeon) throw new Error('no open dungeon entrance');
    a.emit({ t: 'dev', cmd: { c: 'teleport', x: entrance.x, y: entrance.y } });
    ticks(rooms, 1);
    expect(welcome(a).map.kind).toBe('staging');
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    const a2 = join(next, store, nth(players, 0));
    expect(welcome(a2).map.kind).toBe('world');
    const pos = at(next, a2);
    expect(Math.hypot(pos.x - entrance.x, pos.y - entrance.y)).toBeLessThan(400);
    expect(roomOf(next, a2).inSafeZone(pos.x, pos.y)).toBe(false);
  });
});

describe('reconnect window', () => {
  it('lands where they stood inside the window and at the town spawn after it', async () => {
    const { store, rooms, sockets, players, clock, owners } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const spawn = room.sim.playerSpawnPoint();
    for (const s of [a, b]) {
      const spot = room.sim.map.findOpen(spawn.x + 700, spawn.y + 100, SIM.playerRadius + 6);
      s.emit({ t: 'dev', cmd: { c: 'teleport', x: spot.x, y: spot.y } });
    }
    ticks(rooms, 0.5);
    const stood = { ...at(rooms, a) };
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    clock.advance(RESUME_WINDOW_MS - 1000);
    const a2 = join(next, store, nth(players, 0));
    expect(Math.hypot(at(next, a2).x - stood.x, at(next, a2).y - stood.y)).toBeLessThan(40);
    clock.advance(2000);
    const b2 = join(next, store, nth(players, 1));
    const late = at(next, b2);
    expect(roomOf(next, b2).inSafeZone(late.x, late.y)).toBe(true);
  });

  it('gives a stale tab that resumed and then reloads its place again, inside the window only', async () => {
    const { store, rooms, sockets, players, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const spawn = room.sim.playerSpawnPoint();
    const spot = room.sim.map.findOpen(spawn.x + 700, spawn.y, SIM.playerRadius + 6);
    a.emit({ t: 'dev', cmd: { c: 'teleport', x: spot.x, y: spot.y } });
    ticks(rooms, 0.5);
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    const first = join(next, store, nth(players, 0));
    // The new build's welcome makes the tab reload: it walks a step, the socket closes, and it joins again.
    const moved = next.roomById(welcome(first).roomId)?.sim.map.findOpen(spot.x + 80, spot.y, SIM.playerRadius + 6);
    if (!moved) throw new Error('no spot');
    first.emit({ t: 'dev', cmd: { c: 'teleport', x: moved.x, y: moved.y } });
    ticks(next, 0.2);
    const left = { ...at(next, first) };
    first.close();
    const again = join(next, store, nth(players, 0));
    expect(Math.hypot(at(next, again).x - left.x, at(next, again).y - left.y)).toBeLessThan(40);
    clock.advance(RESUME_WINDOW_MS);
    again.close();
    const late = join(next, store, nth(players, 0));
    expect(roomOf(next, late).inSafeZone(at(next, late).x, at(next, late).y)).toBe(true);
  });

  it('keeps a restored world room and its loot open for the window, then lets it close', async () => {
    const { store, rooms, sockets, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const pos = at(rooms, a);
    spawnBag(room.sim, pos.x + 100, pos.y, rings(room, 1), LOOT.bagRadius, null);
    // A long lifetime, so only the room closing can take the pile.
    for (const l of room.sim.world.loot.values()) l.lifetime = l.maxLife = 3600;
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    // An empty world room closes after WILDS.idleCloseSeconds; a held one waits out the window.
    ticks(next, WILDS.idleCloseSeconds + 5);
    expect(next.roomById(room.id)?.sim.world.loot.size).toBe(1);
    clock.advance(RESUME_WINDOW_MS);
    ticks(next, 1);
    expect(next.roomById(room.id)).toBeUndefined();
  });
});

describe('item conservation across a restart', () => {
  it('a bag picked up just before SIGTERM is in the save and not on the ground, and nothing appears or vanishes', async () => {
    const { store, rooms, sockets, players, clock, owners } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const pos = at(rooms, a);
    spawnBag(room.sim, pos.x + 30, pos.y, rings(room, 2), LOOT.bagRadius, null);
    spawnBag(room.sim, pos.x - 300, pos.y + 200, rings(room, 3), LOOT.bagRadius, null);
    const bag = [...room.sim.world.loot.keys()][0];
    if (bag === undefined) throw new Error('no bag');
    ticks(rooms, 0.2);
    rooms.saveAll();
    const roomIds = [room.id];
    const start = census(store, rooms, players, roomIds);
    // Picked up on the last tick before the signal: no autosave ran since, only the shutdown's write.
    a.emit({ t: 'pickup', id: bag });
    rooms.tick();
    rooms.shutdown();
    expect(census(store, rooms, players, roomIds)).toEqual(start);

    const { rooms: next } = reboot(store, owners, clock);
    const afterBoot = census(store, next, players, roomIds);
    expect(afterBoot).toEqual(start);
    expect([...(next.roomById(room.id)?.sim.world.loot.values() ?? [])].some((l) => l.items.length === 2)).toBe(false);
    // Everyone back in, a while of play, a save: still the same items.
    for (const p of players) join(next, store, p);
    ticks(next, 1);
    next.saveAll();
    expect(census(store, next, players, roomIds)).toEqual(start);
  });

  /** Hero0 holds an unbound ring in the bag, saved; returns what the census counted then. */
  async function withRing() {
    const t = await setup(2);
    const [a] = t.sockets;
    if (!a) throw new Error('setup');
    ticks(t.rooms, 2);
    const room = roomOf(t.rooms, a);
    const pos = at(t.rooms, a);
    const [ring] = rings(room, 1);
    if (!ring) throw new Error('no ring');
    spawnBag(room.sim, pos.x + 30, pos.y, [ring], LOOT.bagRadius, null);
    const bag = [...room.sim.world.loot.keys()].at(-1);
    if (bag === undefined) throw new Error('no bag');
    a.emit({ t: 'pickup', id: bag });
    ticks(t.rooms, 0.2);
    const p = room.sim.world.player.get(welcome(a).playerId);
    if (!p?.items.has(ring.uid)) throw new Error('ring not picked up');
    t.rooms.saveAll();
    return { ...t, a, room, ring, start: census(t.store, t.rooms, t.players, [room.id]) };
  }

  it('an item dropped on the last tick is on the restored ground and not in the save', async () => {
    const { store, rooms, players, clock, owners, a, room, ring, start } = await withRing();
    a.emit({ t: 'discard', uid: ring.uid });
    rooms.tick();
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    expect(census(store, next, players, [room.id])).toEqual(start);
    expect(store.loadCharacter(nth(players, 0).account, nth(players, 0).character)?.save?.items.some((i) => fingerprint(i) === fingerprint(ring))).toBe(false);
  });

  it('a drop and then a disconnect before SIGTERM leaves the item on the ground once', async () => {
    const { store, rooms, players, clock, owners, a, room, ring, start } = await withRing();
    a.emit({ t: 'discard', uid: ring.uid });
    rooms.tick();
    a.close();
    rooms.tick();
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    expect(census(store, next, players, [room.id])).toEqual(start);
  });

  it('a drop and then a walk into a dungeon before SIGTERM leaves the item on the world ground once', async () => {
    const { store, rooms, players, clock, owners, a, room, ring, start } = await withRing();
    a.emit({ t: 'discard', uid: ring.uid });
    rooms.tick();
    const entrance = room.sim.mapDef.portals.find((p) => p.target === 'staging' && p.dungeon && (room.sim.zone?.plan?.gateAt(p.x, p.y) ?? null) === null);
    if (!entrance) throw new Error('no open dungeon entrance');
    a.emit({ t: 'dev', cmd: { c: 'teleport', x: entrance.x, y: entrance.y } });
    ticks(rooms, 1);
    expect(welcome(a).map.kind).toBe('staging');
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    expect(census(store, next, players, [room.id])).toEqual(start);
  });

  it('a failed shutdown write leaves no snapshot, and the plain save after it keeps every item', async () => {
    const { store, rooms, players, clock, owners, a, room, ring, start } = await withRing();
    a.emit({ t: 'discard', uid: ring.uid });
    rooms.tick();
    vi.spyOn(store.snapshots, 'write').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => rooms.shutdown()).toThrow('disk full');
    expect(store.snapshots.has()).toBe(false);
    expect(a.last('restart')).toEqual({ t: 'restart', seconds: 0 });
    // What index.ts does next. The dropped ring is on the ground of a process that is ending: lost, as on any restart before.
    rooms.saveAll();
    const { rooms: next, summary } = reboot(store, owners, clock);
    expect(summary).toBe('no session snapshot');
    const after = census(store, next, players, [room.id]);
    const lost = start.items.filter((f) => f === fingerprint(ring));
    expect(after.items).toEqual(start.items.filter((f) => !lost.includes(f)));
  });

  it('gives every item in a restored room its own uid once everyone is back', async () => {
    const { store, rooms, players, clock, owners, room } = await withRing();
    const pos = room.sim.playerSpawnPoint();
    for (let i = 0; i < 20; i++) spawnBag(room.sim, pos.x + 200 + i * 60, pos.y, rings(room, 3), LOOT.bagRadius, null);
    rooms.shutdown();
    const { rooms: next } = reboot(store, owners, clock);
    for (const p of players) join(next, store, p);
    ticks(next, 0.5);
    const restored = next.roomById(room.id);
    if (!restored) throw new Error('no room');
    const uids: number[] = [];
    const w = restored.sim.world;
    for (const [, p] of w.player) {
      for (const it of p.items.values()) {
        uids.push(it.uid);
        if (it.kind === 'sigil') for (const r of it.slots) uids.push(r.uid);
      }
    }
    for (const [id, l] of w.loot) if (w.isAlive(id)) for (const it of l.items) uids.push(it.uid);
    expect(uids.length).toBeGreaterThan(60);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('keeps no ground loot of a room where a member had no character to export', async () => {
    const { store, rooms, sockets, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const pos = at(rooms, a);
    spawnBag(room.sim, pos.x + 100, pos.y, rings(room, 2), LOOT.bagRadius, null);
    vi.spyOn(room, 'exportMember').mockReturnValue(null);
    expect(rooms.shutdown().piles).toBe(0);
    const { rooms: next } = reboot(store, owners, clock);
    expect(next.roomById(room.id)?.sim.world.loot.size ?? 0).toBe(0);
  });

  it('a crash without SIGTERM restores nothing new', async () => {
    const { store, rooms, players, sockets, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const pos = at(rooms, a);
    spawnBag(room.sim, pos.x + 100, pos.y, rings(room, 2), LOOT.bagRadius, null);
    // What the uncaught exception handler does: stop and save, no snapshot.
    rooms.stop();
    rooms.saveAll();
    expect(store.snapshots.has()).toBe(false);
    const { rooms: next, summary } = reboot(store, owners, clock);
    expect(summary).toBe('no session snapshot');
    expect(next.roomById(room.id)).toBeUndefined();
    const a2 = join(next, store, nth(players, 0));
    expect(roomOf(next, a2).sim.world.loot.size).toBe(0);
  });

  it('keeps no ground loot of a room where a character could not be exported', async () => {
    const { store, rooms, sockets, clock, owners } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const room = roomOf(rooms, a);
    const pos = at(rooms, a);
    spawnBag(room.sim, pos.x + 100, pos.y, rings(room, 2), LOOT.bagRadius, null);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(room, 'exportMember').mockImplementation(() => {
      throw new Error('broken save');
    });
    expect(rooms.shutdown().piles).toBe(0);
    silence.mockRestore();
    const { rooms: next } = reboot(store, owners, clock);
    expect(next.roomById(room.id)?.sim.world.loot.size ?? 0).toBe(0);
  });

  it('saves nothing after the shutdown write and ignores what clients still send', async () => {
    const { store, rooms, sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('setup');
    ticks(rooms, 1);
    const save = vi.spyOn(store, 'saveCharacterAndStash');
    rooms.shutdown();
    a.emit({ t: 'chat', text: 'still here?' });
    a.close();
    expect(save).not.toHaveBeenCalled();
  });

});

describe('snapshot format', () => {
  it('drops a snapshot of another format or a damaged one instead of reading it wrong', async () => {
    const { rooms } = await setup(1);
    const good = JSON.stringify(rooms.snapshot());
    expect(typeof parseSnapshot(good)).toBe('object');
    expect(parseSnapshot(good.replace('"format":1', '"format":2'))).toBe('format 2, this build reads 1');
    expect(parseSnapshot(good.replace('"instances":[', '"instances":[7,'))).toBe('bad world copies');
    expect(parseSnapshot('{')).toBe('not JSON');
  });
});

describe('restart countdown', () => {
  it('warns everyone with a countdown and reminders, and tells a late joiner the time left', async () => {
    const { store, rooms, sockets, players, clock } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('setup');
    b.close();
    expect(rooms.restartCountdown(60)).toBe(1);
    expect(a.last('restart')).toEqual({ t: 'restart', seconds: 60 });
    expect(a.last('banner')?.title).toBe('Server update');
    clock.advance(31_000);
    rooms.tick();
    expect(a.last('chat')?.text).toBe('Server update in 29 seconds');
    const late = join(rooms, store, nth(players, 1));
    expect(late.last('restart')).toEqual({ t: 'restart', seconds: 29 });
  });
});

describe('snapshot time with a busy world', () => {
  it('writes saves and snapshot for 32 players and 400 piles well inside the grace period', async () => {
    const clock = testClock();
    const { store, rooms, sockets } = await setup(32, clock);
    ticks(rooms, 0.5);
    // Four public copies of eight; 100 piles of five items in each world room.
    const worldRooms = new Set(sockets.map((s) => roomOf(rooms, s)));
    expect(worldRooms.size).toBe(4);
    for (const room of worldRooms) {
      const spawn = room.sim.playerSpawnPoint();
      for (let i = 0; i < 100; i++) {
        const spot = room.sim.map.findOpen(spawn.x + ((i % 10) - 5) * 90, spawn.y + (Math.floor(i / 10) - 5) * 90, LOOT.bagRadius);
        spawnBag(room.sim, spot.x, spot.y, rings(room, 5), LOOT.bagRadius, null);
      }
    }
    const t0 = performance.now();
    const r = rooms.shutdown();
    const total = performance.now() - t0;
    const r0 = performance.now();
    const next = new RoomManager(1, store, new Set(), clock.now);
    const summary = next.restore();
    const restoreMs = performance.now() - r0;
    console.info(`[snapshot timing] shutdown write ${r.ms.toFixed(1)} ms (${total.toFixed(1)} ms with closing ${r.players} sockets), ${r.piles} piles, ${Math.round(r.bytes / 1024)} KB; restore ${restoreMs.toFixed(0)} ms: ${summary}`);
    expect(r.players).toBe(32);
    // A few drops land close enough to join a neighbour's pile.
    expect(r.piles).toBeGreaterThan(380);
    // Kubernetes allows 20 s; a second would already be far too slow.
    expect(r.ms).toBeLessThan(1000);
  });
});
