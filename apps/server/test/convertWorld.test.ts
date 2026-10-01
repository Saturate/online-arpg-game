import { BAG, emptyGrid, loadMap, STASH, type ServerMessage } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A mage as the v1 server stored it, from the zones: a bound starter Fireball and a Linger stack, and zone waypoints. */
function v1Character(waypoints: string[]): Record<string, unknown> {
  const inventory = emptyGrid(BAG);
  inventory[0] = 2;
  return {
    classId: 'mage',
    name: 'Old',
    items: [
      { uid: 1, kind: 'sigil', tier: 'common', name: 'Fireball', ilvl: 1, affixes: [], runes: ['bolt', 'fire', 'onhit', 'nova', 'timer', 'zone', 'linger'], corrupted: false, skill: 'fireball', bound: true },
      { uid: 2, kind: 'rune', tier: 'magic', name: 'Linger Rune', ilvl: 1, rune: 'linger', count: 2, affixes: [] },
    ],
    inventory,
    stash: emptyGrid(STASH),
    sigils: [1, null, null, null],
    warband: [null, null, null, null, null],
    gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
    stance: 'defensive',
    waypoints,
    level: 14,
    xp: 0,
    gold: 10,
  };
}

async function database(save: Record<string, unknown>) {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-world-convert-')), 'rune.db');
  const store = new AccountStore(file);
  const acc = await store.register('veteran', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Old', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify(save), ch.id);
  return { store, raw, accountId: acc.id, characterId: ch.id };
}

function stored(raw: DatabaseSync, characterId: number): Record<string, unknown> {
  const row: unknown = raw.prepare('SELECT save_json FROM characters WHERE id = ?').get(characterId);
  const json = isRecord(row) ? row.save_json : undefined;
  if (typeof json !== 'string') throw new Error('no row');
  const v: unknown = JSON.parse(json);
  if (!isRecord(v)) throw new Error('not an object');
  return v;
}

function join1(rooms: RoomManager, store: AccountStore, accountId: number, characterId: number): FakeSocket {
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
  return socket;
}

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

describe('world save conversion on the server', () => {
  it('takes a v1-era save through the rune and world conversions in order, in town, once', async () => {
    const { store, raw, accountId, characterId } = await database(v1Character(['barrens', 'steppe', 'gloomvale', 'thornwood', 'dunes', 'hollows', 'mystery']));
    const loaded = store.loadCharacter(accountId, characterId)?.save;
    expect(loaded?.runeFormat).toBe(2);
    expect(loaded?.worldFormat).toBe(1);
    expect(loaded?.waypoints).toEqual(['steppe-1', 'gloomvale-1', 'thornwood-1', 'dunes-1', 'hollows-1', 'mystery']);
    // Linger x2 refunded at 12 gold each by the rune conversion.
    expect(loaded?.gold).toBe(10 + 24);
    expect(loaded?.level).toBe(14);

    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    expect(socket.sent.some((m) => m.t === 'sessionEnded')).toBe(false);
    const w = welcome(socket);
    expect(w.map.kind).toBe('world');
    const pos = rooms.roomById(w.roomId)?.sim.world.position.get(w.playerId);
    const def = loadMap(w.map).def;
    if (!pos) throw new Error('no player');
    expect(Math.hypot(pos.x - def.spawn.x, pos.y - def.spawn.y)).toBeLessThan(80);
    rooms.saveAll();

    const written = stored(raw, characterId);
    expect(written.runeFormat).toBe(2);
    expect(written.worldFormat).toBe(1);
    expect(written.waypoints).toEqual(['steppe-1', 'gloomvale-1', 'thornwood-1', 'dunes-1', 'hollows-1', 'mystery']);
    const items = Array.isArray(written.items) ? written.items.filter(isRecord) : [];
    expect(items.find((i) => i.kind === 'sigil')?.starter).toBe('fireball');

    // Loaded again, the marked save is read as it is: nothing converts or changes.
    const again = new RoomManager(1, store);
    join1(again, store, accountId, characterId);
    again.saveAll();
    const twice = stored(raw, characterId);
    expect(twice.waypoints).toEqual(written.waypoints);
    expect(twice.gold).toBe(written.gold);
    raw.close();
  });

  it('converts a v2 save from before the world, and leaves a marked one alone', async () => {
    const { store, raw, accountId, characterId } = await database(v1Character([]));
    const v2 = store.loadCharacter(accountId, characterId)?.save;
    if (!v2) throw new Error('no save');
    const { worldFormat: _marker, ...preWorld } = v2;
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify({ ...preWorld, waypoints: ['barrens', 'steppe', 'thornwood'] }), characterId);
    expect(store.loadCharacter(accountId, characterId)?.save?.waypoints).toEqual(['steppe-1', 'thornwood-1']);

    // A marked save keeps whatever its list holds, even an old zone id.
    raw.prepare('UPDATE characters SET save_json = ? WHERE id = ?').run(JSON.stringify({ ...v2, waypoints: ['steppe', 'dunes-1'] }), characterId);
    expect(store.loadCharacter(accountId, characterId)?.save?.waypoints).toEqual(['steppe', 'dunes-1']);
    raw.close();
  });
});
