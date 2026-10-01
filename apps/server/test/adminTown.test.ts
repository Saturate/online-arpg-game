import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { checkLayout, isAdminToken, SIM, TOWN_DECOR_ASSETS, TOWN_LIMITS, propModels, type TokenScope, type TownLayout } from '@rune/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { events } from '../src/eventLog.js';
import { AccountApi, TOWN_BODY_BYTES } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

// townStore reads TOWN_LAYOUT when it is first imported, so the temp file is set before any import
// runs: saves go through the real atomic write, never over the committed town.
const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const d = mkdtempSync(path.join(tmpdir(), 'rune-town-api-'));
  process.env.TOWN_LAYOUT = path.join(d, 'town-layout.json');
  return d;
});
const layoutFile = join(dir, 'town-layout.json');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every limit filled, at full float precision: the biggest body a valid layout can be. */
function largestLayout(): TownLayout {
  const size = TOWN_LIMITS.maxSize;
  const coord = (i: number) => size - 1 - (i % 997) - 0.123456789012345;
  const pt = (i: number) => ({ x: coord(i), y: coord(i + 1) });
  const unlit = Object.entries(TOWN_DECOR_ASSETS).filter(([, s]) => !s.lit).map(([a]) => a);
  const longest = unlit.reduce((a, b) => (b.length > a.length ? b : a));
  const houseModels = propModels('house');
  const model = houseModels.reduce((a, b) => (b.length > a.length ? b : a));
  return {
    version: 1,
    name: 'W'.repeat(32),
    width: size,
    height: size,
    spawn: pt(0),
    props: Array.from({ length: TOWN_LIMITS.props }, (_, i) => ({ kind: 'house' as const, ...pt(i), angle: -99.12345678901234, scale: 2.123456789012345, length: 5998.123456789012, model })),
    paths: Array.from({ length: TOWN_LIMITS.paths }, (_, i) => ({ width: 399.1234567890123, points: Array.from({ length: TOWN_LIMITS.pathPoints }, (_, j) => pt(i + j)) })),
    plazas: Array.from({ length: TOWN_LIMITS.plazas }, (_, i) => ({ ...pt(i), r: 1499.123456789012 })),
    portals: Array.from({ length: TOWN_LIMITS.portals }, (_, i) => ({ target: 'wilds' as const, ...pt(i) })),
    decor: Array.from({ length: TOWN_LIMITS.decor }, (_, i) =>
      i < TOWN_LIMITS.solidDecor ? { asset: longest, ...pt(i), angle: -99.12345678901234, scale: 3.123456789012345, solid: true } : { asset: longest, ...pt(i), angle: -99.12345678901234, scale: 3.123456789012345 },
    ),
  };
}

describe('PUT /api/admin/town', () => {
  const store = new AccountStore(':memory:');
  const owners = new Set(['boss']);
  const rooms = new RoomManager(1, store, owners);
  const sessions: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const socket = new FakeSocket();
  let server: Server | undefined;
  let base = '';

  const call = (method: string, path: string, auth: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${auth}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined || raw !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = raw ?? JSON.stringify(body);
    }
    return fetch(base + path, init);
  };
  const json = async (res: Response): Promise<Record<string, unknown>> => {
    const v: unknown = await res.json();
    if (!isRecord(v)) throw new Error('not an object');
    return v;
  };
  const makeToken = async (who: string, name: string, scopes: readonly TokenScope[]): Promise<string> => {
    const res = await call('POST', '/api/admin/tokens', sessions[who] ?? '', { name, scopes, days: 1 });
    expect(res.status).toBe(201);
    const token = (await json(res)).token;
    if (!isAdminToken(token)) throw new Error('no token');
    return token;
  };
  const worldRoom = () => {
    const w = socket.last('welcome');
    const room = w ? rooms.roomById(w.roomId) : undefined;
    if (!w || !room) throw new Error('not in a room');
    return { room, playerId: w.playerId, roomId: w.roomId };
  };
  const renamed = (name: string): TownLayout => ({ ...rooms.currentTown(), name });
  const staffLines = (from: number) => events.since(from).entries.filter((e) => e.kind === 'staff').map((e) => e.text);
  const cursor = () => events.since(0).next;

  beforeAll(async () => {
    for (const [name, role] of [
      ['boss', null],
      ['admin1', 'admin'],
      ['builder1', 'builder'],
      ['mod1', 'moderator'],
      ['pleb1', 'player'],
    ] as const) {
      const acc = await store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      if (role) store.setRole(acc.id, role);
      ids[name] = acc.id;
      sessions[name] = store.createSession(acc.id);
    }
    // The owner plays, so a save has someone to carry over.
    const ch = store.createCharacter(ids.boss ?? 0, 'Bossman', 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    rooms.connect(socket);
    socket.emit({ t: 'join', token: sessions.boss, characterId: ch.id });
    for (let i = 0; i < SIM.tickRate; i++) rooms.tick();

    const api = new AccountApi(store, () => undefined, rooms, owners, { other: 100_000, token: 100_000 });
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(() => {
    server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a valid layout atomically, rebuilds the world room and carries the player over where they stood', async () => {
    const token = await makeToken('boss', 'town', ['townEdit']);
    const before = worldRoom();
    const pos = before.room.sim.world.position.get(before.playerId);
    if (!pos) throw new Error('no player');
    const at = { x: pos.x, y: pos.y };
    const from = cursor();

    const res = await call('PUT', '/api/admin/town', token, renamed('Emberwatch Rebuilt'));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ name: 'Emberwatch Rebuilt', rooms: 1, players: 1, hash: expect.any(String) });

    expect(rooms.currentTown().name).toBe('Emberwatch Rebuilt');
    const written: unknown = JSON.parse(readFileSync(layoutFile, 'utf8'));
    expect(written).toEqual(rooms.currentTown());
    // The temp file was renamed over, not left beside it.
    expect(existsSync(`${layoutFile}.tmp`)).toBe(false);

    for (let i = 0; i < 2; i++) rooms.tick();
    const after = worldRoom();
    expect(after.room).not.toBe(before.room);
    expect(after.roomId).toBe(before.roomId);
    const now = after.room.sim.world.position.get(after.playerId);
    if (!now) throw new Error('player not carried over');
    expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(120);

    // The action's own line naming account and token, then the token call line.
    const lines = staffLines(from);
    expect(lines).toContainEqual(expect.stringMatching(/^\[admin\] boss \(owner\) token "town": town saved "Emberwatch Rebuilt" \(\d+ props, \d+ paths, \d+ decor, hash \w+\); 1 world rooms rebuilt, 1 players carried over$/));
    expect(lines.at(-1)).toBe('[admin] boss (owner) token "town": PUT /api/admin/town');
  });

  it('refuses an invalid layout with the reason and changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const token = await makeToken('boss', 'bad town', ['townEdit']);
    const town = rooms.currentTown();
    const file = readFileSync(layoutFile, 'utf8');
    const room = worldRoom().room;
    const from = cursor();

    const noWayOut = { ...town, portals: town.portals.filter((p) => p.target !== 'wilds') };
    const res = await call('PUT', '/api/admin/town', token, noWayOut);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'The town needs a portal to the wilds' });

    const badProp = { ...town, props: town.props.map((p, i) => (i === 2 ? { ...p, scale: 9 } : p)) };
    expect(await json(await call('PUT', '/api/admin/town', token, badProp))).toEqual({ error: 'props[2]: scale must be a number from 0.3 to 3' });
    // Unknown decor is refused like an editor save, not dropped like a load from disk.
    const badDecor = { ...town, decor: [...town.decor, { asset: 'no_such_asset', x: 100, y: 100, angle: 0, scale: 1 }] };
    expect(await json(await call('PUT', '/api/admin/town', token, badDecor))).toEqual({ error: `decor[${town.decor.length}]: unknown asset no_such_asset` });
    expect((await call('PUT', '/api/admin/town', token, undefined, '{"version":')).status).toBe(400);
    expect((await call('PUT', '/api/admin/town', token, undefined, 'x'.repeat(TOWN_BODY_BYTES + 1))).status).toBe(413);

    expect(rooms.currentTown()).toBe(town);
    expect(readFileSync(layoutFile, 'utf8')).toBe(file);
    expect(worldRoom().room).toBe(room);
    expect(staffLines(from).filter((l) => l.includes('town saved'))).toEqual([]);
    expect(staffLines(from).at(-1)).toBe('[admin] boss (owner) token "bad town": PUT /api/admin/town -> 413');
  });

  it('needs townEdit: refused for a token without it, and for roles without it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 20_000);
    const town = rooms.currentTown();
    const settingsToken = await makeToken('boss', 'no town', ['settings', 'announce']);
    expect((await call('PUT', '/api/admin/town', settingsToken, renamed('Nope'))).status).toBe(403);
    expect((await call('PUT', '/api/admin/town', sessions.mod1 ?? '', renamed('Nope'))).status).toBe(403);
    expect((await call('PUT', '/api/admin/town', sessions.pleb1 ?? '', renamed('Nope'))).status).toBe(404);
    expect(rooms.currentTown()).toBe(town);

    // A builder's session and an admin's token have it, as the editor does.
    expect((await call('PUT', '/api/admin/town', sessions.builder1 ?? '', renamed('Builder Town'))).status).toBe(200);
    const adminToken = await makeToken('admin1', 'admin town', ['townEdit']);
    expect((await call('PUT', '/api/admin/town', adminToken, renamed('Admin Town'))).status).toBe(200);
    expect(rooms.currentTown().name).toBe('Admin Town');
  });

  it('holds the editor cooldown, shared with the in-game save', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30_000);
    const token = await makeToken('boss', 'fast town', ['townEdit']);
    expect((await call('PUT', '/api/admin/town', token, renamed('First'))).status).toBe(200);
    const second = await call('PUT', '/api/admin/town', token, renamed('Second'));
    expect(second.status).toBe(429);
    expect(await json(second)).toEqual({ error: 'Wait a few seconds between town saves' });
    // The owner's editor in game waits too, since it is the same account.
    socket.emit({ t: 'saveTown', layout: renamed('From the editor') });
    expect(socket.last('notice')?.text).toBe('Wait a few seconds between town saves');
    expect(rooms.currentTown().name).toBe('First');

    vi.setSystemTime(Date.now() + 3_000);
    socket.emit({ t: 'saveTown', layout: renamed('From the editor') });
    expect(socket.last('notice')?.text).toBe('Town saved');
    expect((await call('PUT', '/api/admin/town', token, renamed('Third'))).status).toBe(429);
    vi.setSystemTime(Date.now() + 3_000);
    expect((await call('PUT', '/api/admin/town', token, renamed('Third'))).status).toBe(200);
    expect(rooms.currentTown().name).toBe('Third');
  });

  it('takes the largest valid layout', () => {
    const big = largestLayout();
    expect(checkLayout(big)).not.toBeTypeOf('string');
    const bytes = Buffer.byteLength(`${JSON.stringify(big, null, 2)}\n`);
    expect(bytes).toBeLessThan(TOWN_BODY_BYTES);
  });
});
