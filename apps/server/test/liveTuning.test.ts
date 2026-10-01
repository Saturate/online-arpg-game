import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTunables, applyTunables, isTunableHistoryEntry, isTunablesState, resetTunables, SKILL_BUTTONS, SPELL, TUNABLES, type ServerMessage, type TunableHistoryEntry, type TunablesState } from '@rune/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

async function enter(store: AccountStore, rooms: RoomManager, name: string) {
  const acc = await store.register(name, 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, `${name}Hero`, 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  rooms.tick();
  return socket;
}

describe('live tuning API', () => {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store);
  let server: Server;
  let base = '';
  const tokens: Record<string, string> = {};
  let playerSocket: FakeSocket;
  let seq = 0;

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['mod1', 'moderator'],
      ['build1', 'builder'],
      ['pleb1', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      tokens[name] = store.createSession(acc.id);
    }
    const boss = store.accountByUsername('boss');
    if (!boss) throw new Error('no boss');
    tokens.scoped = store.adminTokens.create(boss.id, 'tuner', ['viewAdmin', 'tuning'], Date.now() + 60_000).token;
    tokens.unscoped = store.adminTokens.create(boss.id, 'reader', ['viewAdmin', 'settings'], Date.now() + 60_000).token;
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']));
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
    playerSocket = await enter(store, rooms, 'caster');
  });
  afterAll(() => server.close());
  // Each test starts from code defaults; the stored rows do not matter to the next one.
  afterEach(() => resetTunables());

  const call = (method: string, path: string, who: string, body?: unknown) => {
    const token = tokens[who];
    if (!token) throw new Error(`no token for ${who}`);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(base + path, init);
  };

  const stateOf = async (res: Response): Promise<TunablesState> => {
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (!isTunablesState(body)) throw new Error('not a tuning state');
    return body;
  };

  const history = async (): Promise<TunableHistoryEntry[]> => {
    const body: unknown = await (await call('GET', '/api/admin/tuning/history', 'build1')).json();
    if (!Array.isArray(body) || !body.every(isTunableHistoryEntry)) throw new Error('not a history');
    return body;
  };

  const caster = () => {
    const w = welcome(playerSocket);
    const room = rooms.roomById(w.roomId);
    const p = room?.sim.world.player.get(w.playerId);
    if (!room || !p) throw new Error('no caster');
    return { room, p, pid: w.playerId };
  };

  /** Casts the Fireball in slot 0 once from a cold bar; the Force it cost and its orb's radius. */
  const cast = (): { heat: number; radius: number } => {
    const { room, p, pid } = caster();
    while (p.castCooldown > 0) rooms.tick();
    p.heat = 0;
    const before = new Set(room.sim.world.projectile.keys());
    playerSocket.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[0] });
    rooms.tick();
    playerSocket.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
    let radius = 0;
    for (const [id, proj] of room.sim.world.projectile) if (proj.ownerId === pid && !before.has(id)) radius = room.sim.world.radius.get(id) ?? 0;
    return { heat: p.heat, radius };
  };

  it('lets every staff role look and only owners, admins and tuning tokens change', async () => {
    for (const who of ['build1', 'mod1', 'admin1', 'boss', 'scoped', 'unscoped']) {
      const s = await stateOf(await call('GET', '/api/admin/tuning', who));
      expect(s.schema).toHaveLength(TUNABLES.length);
    }
    expect((await call('GET', '/api/admin/tuning', 'pleb1')).status).toBe(404);
    for (const who of ['build1', 'mod1', 'unscoped']) {
      expect((await call('PATCH', '/api/admin/tuning', who, { 'spell.bolt.damage': 20 })).status, who).toBe(403);
      expect((await call('POST', '/api/admin/tuning/revert', who, { id: 1 })).status, who).toBe(403);
    }
    expect(activeTunables()).toEqual({});
    const s = await stateOf(await call('PATCH', '/api/admin/tuning', 'scoped', { 'spell.bolt.damage': 20 }));
    expect(s.values).toEqual({ 'spell.bolt.damage': 20 });
    expect((await history())[0]).toMatchObject({ path: 'spell.bolt.damage', old: null, new: 20, account: 'boss', token: 'tuner' });
    await stateOf(await call('PATCH', '/api/admin/tuning', 'admin1', { 'spell.bolt.damage': null }));
  });

  it('refuses a patch with any bad entry and changes nothing', async () => {
    for (const bad of [{ 'spell.bolt.damage': 20, 'spell.nope': 1 }, { 'spell.bolt.damage': -2 }, { 'spell.dash.ticks': 1.5 }, {}, [1]]) {
      expect((await call('PATCH', '/api/admin/tuning', 'boss', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('PUT', '/api/admin/tuning', 'boss', { 'spell.bolt.damage': 20 })).status).toBe(405);
    expect((await call('GET', '/api/admin/tuning/history?limit=abc', 'boss')).status).toBe(400);
    expect(activeTunables()).toEqual({});
    expect(SPELL.bolt.damage).toBe(16);
  });

  it('reaches a running room on the next cast and every client at once', async () => {
    const plain = cast();
    const sent = playerSocket.sent.length;
    await stateOf(await call('PATCH', '/api/admin/tuning', 'boss', { 'spell.orb.radius': 40, 'force.rune.orb': 30 }));
    const msg = playerSocket.sent.slice(sent).find((m) => m.t === 'tunables');
    expect(msg?.t === 'tunables' && msg.values).toEqual({ 'spell.orb.radius': 40, 'force.rune.orb': 30 });
    const tuned = cast();
    expect(plain.radius).toBeCloseTo(16, 5);
    expect(tuned.radius).toBeCloseTo(40, 5);
    expect(tuned.heat).toBeGreaterThan(plain.heat + 10);
    // A welcome sent after the change carries it too, so a client entering a room has it at once.
    const later = await enter(store, rooms, 'latecomer');
    expect(welcome(later).tunables).toEqual({ 'spell.orb.radius': 40, 'force.rune.orb': 30 });
    // Back to the code defaults: the next cast is the plain one again.
    await stateOf(await call('PATCH', '/api/admin/tuning', 'boss', { 'spell.orb.radius': null, 'force.rune.orb': 10 }));
    expect(activeTunables()).toEqual({});
    expect(cast()).toEqual(plain);
  });

  it('records history newest first and reverts any change, recording the revert', async () => {
    await stateOf(await call('PATCH', '/api/admin/tuning', 'admin1', { 'spell.nova.damage': 20 }));
    await stateOf(await call('PATCH', '/api/admin/tuning', 'admin1', { 'spell.nova.damage': 25 }));
    const [second, first] = await history();
    expect(second).toMatchObject({ path: 'spell.nova.damage', old: 20, new: 25, account: 'admin1', token: null, revertOf: null });
    expect(first).toMatchObject({ path: 'spell.nova.damage', old: null, new: 20 });
    if (!second || !first) throw new Error('no history');
    expect(second.id).toBeGreaterThan(first.id);

    const back = await stateOf(await call('POST', '/api/admin/tuning/revert', 'admin1', { id: second.id }));
    expect(back.values).toEqual({ 'spell.nova.damage': 20 });
    expect(SPELL.nova.damage).toBe(20);
    expect((await history())[0]).toMatchObject({ path: 'spell.nova.damage', old: 25, new: 20, revertOf: second.id });
    // Already in place: refused rather than logged twice.
    expect((await call('POST', '/api/admin/tuning/revert', 'admin1', { id: second.id })).status).toBe(409);
    const cleared = await stateOf(await call('POST', '/api/admin/tuning/revert', 'admin1', { id: first.id }));
    expect(cleared.values).toEqual({});
    expect(SPELL.nova.damage).toBe(14);
    expect((await call('POST', '/api/admin/tuning/revert', 'admin1', { id: 99999 })).status).toBe(404);
    expect((await call('POST', '/api/admin/tuning/revert', 'admin1', { id: 'x' })).status).toBe(400);
  });
});

describe('live tuning storage', () => {
  afterEach(() => resetTunables());

  it('survives a restart, and a stored value the range now refuses is dropped', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tunables-')), 'rune.db');
    const first = new AccountStore(file);
    first.tunables.commit(
      [
        { path: 'spell.zone.radius', old: null, new: 120 },
        { path: 'force.rune.nova', old: null, new: 20 },
      ],
      { account: 'boss', token: null },
    );
    first.close();
    resetTunables();

    const store = new AccountStore(file);
    expect(store.tunables.load()).toEqual({ 'spell.zone.radius': 120, 'force.rune.nova': 20 });
    expect(store.tunables.history().map((h) => h.path)).toEqual(['force.rune.nova', 'spell.zone.radius']);
    new RoomManager(1, store);
    expect(SPELL.zone.radius).toBe(120);
    expect(activeTunables()).toEqual({ 'spell.zone.radius': 120, 'force.rune.nova': 20 });

    store.tunables.commit([{ path: 'spell.zone.radius', old: 120, new: -1 }], { account: 'boss', token: null });
    expect(store.tunables.load()).toEqual({ 'force.rune.nova': 20 });
    store.close();
  });
});

describe('live tuning writes', () => {
  afterEach(() => resetTunables());

  async function setup(limits: { tuningWrites?: number } = {}) {
    const store = new AccountStore(':memory:');
    const rooms = new RoomManager(1, store);
    const acc = await store.register('boss', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const token = store.createSession(acc.id);
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']), limits);
    const server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { store, rooms, server, call };
  }

  it('limits how many changes one account makes a minute', async () => {
    const { server, call } = await setup({ tuningWrites: 2 });
    expect((await call('PATCH', '/api/admin/tuning', { 'spell.bolt.damage': 20 })).status).toBe(200);
    expect((await call('PATCH', '/api/admin/tuning', { 'spell.bolt.damage': 21 })).status).toBe(200);
    expect((await call('PATCH', '/api/admin/tuning', { 'spell.bolt.damage': 22 })).status).toBe(429);
    expect((await call('POST', '/api/admin/tuning/revert', { id: 1 })).status).toBe(429);
    expect((await call('GET', '/api/admin/tuning')).status).toBe(200);
    expect(SPELL.bolt.damage).toBe(21);
    server.close();
  });

  it('answers honestly when the change was saved but reaching the rooms failed', async () => {
    const { rooms, server, call, store } = await setup();
    rooms.tunablesChanged = () => {
      throw new Error('room blew up');
    };
    const res = await call('PATCH', '/api/admin/tuning', { 'spell.bolt.damage': 20 });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isTunablesState(body) && body.warning).toMatch(/Saved and applied/);
    expect(SPELL.bolt.damage).toBe(20);
    expect(store.tunables.load()).toEqual({ 'spell.bolt.damage': 20 });
    server.close();
  });

  it('reverts to a code default stored as a number as no override', async () => {
    const { server, call, store } = await setup();
    const [row] = store.tunables.commit([{ path: 'spell.bolt.damage', old: 16, new: 30 }], { account: 'boss', token: null });
    if (!row) throw new Error('no row');
    applyTunables(store.tunables.load());
    const res = await call('POST', '/api/admin/tuning/revert', { id: row.id });
    const body: unknown = await res.json();
    expect(isTunablesState(body) && body.values).toEqual({});
    expect(store.tunables.load()).toEqual({});
    expect(SPELL.bolt.damage).toBe(16);
    server.close();
  });

  it('tells a player whose aura a change unequips', async () => {
    const { store, rooms, server, call } = await setup();
    const acc = await store.register('healer', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, 'Healer', 'priest');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    rooms.tick();
    expect((await call('PATCH', '/api/admin/tuning', { 'spirit.rune.aura': 300 })).status).toBe(200);
    expect(socket.sent.some((m) => m.t === 'notice' && m.text === 'Prayer was unequipped: a balance change raised its spirit past your pool')).toBe(true);
    server.close();
  });

  it('refuses a set of numbers that would leave a starter not compiling, naming it, and a revert into one', async () => {
    const { server, call, store } = await setup();
    const bad = await call('PATCH', '/api/admin/tuning', { 'starter.frozen_orb.0.every': 0.14, 'starter.frozen_orb.2.count': 5 });
    expect(bad.status).toBe(400);
    const body: unknown = await bad.json();
    expect(typeof body === 'object' && body !== null && 'error' in body ? body.error : '').toMatch(/^Frozen Orb would not compile: /);
    expect(activeTunables()).toEqual({});
    expect(store.tunables.load()).toEqual({});
    // Each half alone is fine; the revert of the first, once the second is in, would break it again.
    expect((await call('PATCH', '/api/admin/tuning', { 'starter.frozen_orb.2.count': 5 })).status).toBe(200);
    expect((await call('PATCH', '/api/admin/tuning', { 'starter.frozen_orb.0.every': 0.3 })).status).toBe(200);
    const [row] = store.tunables.commit([{ path: 'starter.frozen_orb.0.every', old: 0.14, new: 0.3 }], { account: 'boss', token: null });
    if (!row) throw new Error('no row');
    const revert = await call('POST', '/api/admin/tuning/revert', { id: row.id });
    expect(revert.status).toBe(400);
    expect(activeTunables()['starter.frozen_orb.0.every']).toBe(0.3);
    server.close();
  });

  it('retunes a starter in a running room on its next cast, from the stored rolls of the copy the player owns', async () => {
    const { store, rooms, server, call } = await setup();
    const acc = await store.register('binder', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, 'Bonecaller', 'binder');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    rooms.tick();
    const w = welcome(socket);
    const room = rooms.roomById(w.roomId);
    const p = room?.sim.world.player.get(w.playerId);
    if (!room || !p) throw new Error('no binder');
    const slot = p.sigils.findIndex((eq) => {
      const item = eq ? p.items.get(eq.uid) : undefined;
      return item?.kind === 'sigil' && item.starter === 'bone_spear';
    });
    expect(slot).toBeGreaterThanOrEqual(0);
    let seq = 0;
    const spear = (): number => {
      while (p.castCooldown > 0) rooms.tick();
      p.heat = 0;
      const before = new Set(room.sim.world.projectile.keys());
      socket.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[slot] ?? 0 });
      rooms.tick();
      socket.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
      for (const [id, proj] of room.sim.world.projectile) if (proj.ownerId === w.playerId && !before.has(id)) return proj.damage;
      throw new Error('no spear');
    };
    const plain = spear();
    expect((await call('PATCH', '/api/admin/tuning', { 'starter.bone_spear.0.damage': 140 })).status).toBe(200);
    expect(spear()).toBeCloseTo((plain * 2.4) / 1.4, 5);
    server.close();
  });
});

