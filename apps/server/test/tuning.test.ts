import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionToken } from '@rune/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { AccountApi } from '../src/http.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

describe('tuning routes', () => {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store);
  let server: Server;
  let base = '';
  const tokens: Record<string, string> = {};

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
    const api = new AccountApi(store, () => undefined, rooms, new Set(['boss']));
    server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const call = (method: string, path: string, who: string, body?: unknown) => {
    const token = tokens[who];
    if (!token || !isSessionToken(token)) throw new Error(`no token for ${who}`);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(base + path, init);
  };

  it('lets every staff role look and only settings roles edit', async () => {
    for (const who of ['build1', 'mod1', 'admin1', 'boss']) expect((await call('GET', '/api/admin/monsters', who)).status, who).toBe(200);
    expect((await call('GET', '/api/admin/minions', 'build1')).status).toBe(200);
    expect((await call('GET', '/api/admin/monsters', 'pleb1')).status).toBe(404);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'build1', { life: 400 })).status).toBe(403);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'mod1', { life: 400 })).status).toBe(403);
    expect((await call('DELETE', '/api/admin/monsters/ogre', 'build1')).status).toBe(403);
    const res = await call('PUT', '/api/admin/monsters/ogre', 'admin1', { life: 400 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ogre: { life: 400 } });
    expect(await (await call('GET', '/api/admin/monsters', 'build1')).json()).toEqual({ ogre: { life: 400 } });
  });

  it('rejects unknown types, unknown fields and bad numbers', async () => {
    expect((await call('PUT', '/api/admin/monsters/dragon', 'boss', { life: 400 })).status).toBe(404);
    expect((await call('PUT', '/api/admin/minions/ogre', 'boss', { life: 400 })).status).toBe(404);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'boss', { lifez: 400 })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'boss', { life: -4 })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'boss', { abilities: { '0': { cooldown: 'soon' } } })).status).toBe(400);
    expect((await call('PUT', '/api/admin/minions/wraith', 'boss', { model: 'nope' })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters', 'boss', { ogre: {} })).status).toBe(405);
    expect((await call('PUT', '/api/admin/monsters/dire_wolf', 'boss', { height: 40 })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'boss', { abilities: { '01': { kind: 'slam', cooldown: 5 } } })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters/ogre', 'boss', { abilities: { '0': { kind: 'shoot', cooldown: 5 } } })).status).toBe(400);
    expect((await call('PUT', '/api/admin/monsters/bone_archer', 'boss', { abilities: { '0': { kind: 'shoot', cooldown: 0 } } })).status).toBe(400);
    expect((await call('PUT', '/api/admin/minions/skeleton_archer', 'boss', { projectileSpeed: 0 })).status).toBe(400);
    // Nothing above changed what was stored.
    expect(rooms.tuningOverrides().monsters).toEqual({ ogre: { life: 400 } });
  });

  it('resets a type with DELETE, and with a patch equal to the code', async () => {
    expect(await (await call('PUT', '/api/admin/minions/wraith', 'boss', { damage: 30 })).json()).toEqual({ wraith: { damage: 30 } });
    expect(await (await call('DELETE', '/api/admin/minions/wraith', 'boss')).json()).toEqual({});
    expect(await (await call('PUT', '/api/admin/monsters/ogre', 'boss', { life: 300 })).json()).toEqual({});
  });
});

describe('tuning in the running game', () => {
  async function enter(rooms: RoomManager, store: AccountStore, name: string) {
    const acc = await store.register(name, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `${name}char`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    return socket;
  }

  it('applies new numbers to spawns in open rooms and keeps the living as they were', async () => {
    const store = new AccountStore(':memory:');
    const rooms = new RoomManager(1, store);
    const socket = await enter(rooms, store, 'tuner');
    const roomId = socket.last('welcome')?.roomId;
    const room = roomId === undefined ? undefined : rooms.roomById(roomId);
    if (!room) throw new Error('not in a room');
    const before = room.sim.spawnEnemy('ogre', 300, 300);
    rooms.setMonsterOverride('ogre', { life: 1234 });
    const after = room.sim.spawnEnemy('ogre', 320, 300);
    expect(room.sim.world.health.get(before)?.maxLife).toBe(300);
    expect(room.sim.world.health.get(after)?.maxLife).toBe(1234);
  });

  it('sends models before the welcome and pushes only model changes', async () => {
    const store = new AccountStore(':memory:');
    const rooms = new RoomManager(1, store);
    rooms.setMonsterOverride('dire_wolf', { model: 'mon_ghoul', height: 40 });
    const socket = await enter(rooms, store, 'watcher');
    const tags = socket.sent.map((m) => m.t);
    expect(tags.indexOf('models')).toBeGreaterThanOrEqual(0);
    expect(tags.indexOf('models')).toBeLessThan(tags.indexOf('welcome'));
    expect(socket.last('models')?.models).toEqual({ monsters: { dire_wolf: { model: 'mon_ghoul', height: 40 } }, minions: {} });

    const count = () => socket.sent.filter((m) => m.t === 'models').length;
    const sentBefore = count();
    rooms.setMonsterOverride('ogre', { life: 400 });
    expect(count()).toBe(sentBefore);
    rooms.setMinionOverride('skeleton_archer', { height: 70 });
    expect(count()).toBe(sentBefore + 1);
    expect(socket.last('models')?.models.minions).toEqual({ skeleton_archer: { height: 70 } });
  });

  it('keeps overrides across a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rune-tuning-')), 'rune.db');
    const first = new AccountStore(path);
    new RoomManager(1, first).setMonsterOverride('ghoul', { moveSpeed: 200, abilities: { '0': { kind: 'leap', damage: 40 } } });
    // As if the ogre's first ability had since changed from a shoot to the slam it is now.
    first.tuning.save('monsters', 'ogre', { life: 500, abilities: { '0': { kind: 'shoot', cooldown: 4 }, '1': { kind: 'slam', damage: 30 } } });
    first.close();
    const second = new AccountStore(path);
    expect(new RoomManager(1, second).tuningOverrides().monsters).toEqual({
      ghoul: { moveSpeed: 200, abilities: { '0': { kind: 'leap', damage: 40 } } },
      ogre: { life: 500, abilities: { '1': { kind: 'slam', damage: 30 } } },
    });
    second.close();
  });
});
