import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRune, DEFAULT_SERVER_SETTINGS, SKILL_BUTTONS, type ServerMessage, type SigilItem } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

async function setup() {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set(['player0']));
  const acc = await store.register('player0', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Bonecaller', 'binder');
  if (typeof ch === 'string') throw new Error(ch);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  socket.emit({ t: 'dev', cmd: { c: 'god', on: true } });
  rooms.tick();
  return { store, rooms, socket };
}

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

function player(rooms: RoomManager, s: FakeSocket) {
  const room = rooms.roomById(welcome(s).roomId);
  const pid = welcome(s).playerId;
  const p = room?.sim.world.player.get(pid);
  if (!room || !p) throw new Error('no player');
  return { sim: room.sim, pid, p };
}

function bench(rooms: RoomManager, s: FakeSocket) {
  const { sim, pid, p } = player(rooms, s);
  const slot = p.sigils.findIndex((eq) => eq !== null && p.items.get(eq.uid)?.name === 'Bone Spear');
  const eq = p.sigils[slot];
  const item = eq ? p.items.get(eq.uid) : undefined;
  if (slot < 0 || item?.kind !== 'sigil') throw new Error('no Bone Spear in the kit');
  return { sim, pid, p, slot, item };
}

let seq = 0;

/** Casts the sigil in `slot` once, after any running cooldown, and returns the damage its new projectile carries. */
function castDamage(rooms: RoomManager, s: FakeSocket, slot: number): number {
  const { sim, pid, p } = player(rooms, s);
  const release = () => {
    s.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: 0 });
    rooms.tick();
  };
  release();
  while (p.castCooldown > 0) release();
  const before = new Set(sim.world.projectile.keys());
  p.heat = 0;
  s.emit({ t: 'input', seq: ++seq, moveDir: { x: 0, y: 0 }, aimAngle: 0, buttons: SKILL_BUTTONS[slot] });
  rooms.tick();
  const fresh = [...sim.world.projectile].filter(([id, pr]) => !before.has(id) && pr.ownerId === pid);
  const first = fresh[0];
  if (!first) throw new Error('the cast spawned no projectile');
  return first[1].damage;
}

describe('starter damage setting', () => {
  it('reaches the client in the welcome and again only when it changes', async () => {
    const { rooms, socket } = await setup();
    expect(welcome(socket).starterDamage).toEqual({});
    rooms.updateSettings({ xpRate: 2 });
    expect(socket.last('starterDamage')).toBeUndefined();
    rooms.updateSettings({ starterDamage: { bone_spear: 1.5 } });
    expect(socket.last('starterDamage')?.damage).toEqual({ bone_spear: 1.5 });
    const sent = socket.sent.length;
    rooms.updateSettings({ starterDamage: { bone_spear: 1.5 } });
    expect(socket.sent.slice(sent).some((m) => m.t === 'starterDamage')).toBe(false);
  });

  it('changes a whole starter on the next cast, without a restart, and touches no item', async () => {
    const { rooms, socket } = await setup();
    const { p, slot } = bench(rooms, socket);
    const items = JSON.stringify([...p.items.values()]);
    const base = castDamage(rooms, socket, slot);
    expect(base).toBeGreaterThan(0);
    rooms.updateSettings({ starterDamage: { bone_spear: 2 } });
    expect(castDamage(rooms, socket, slot)).toBeCloseTo(base * 2, 6);
    rooms.updateSettings({ starterDamage: { bone_spear: 0.5 } });
    expect(castDamage(rooms, socket, slot)).toBeCloseTo(base * 0.5, 6);
    rooms.updateSettings({ starterDamage: {} });
    expect(castDamage(rooms, socket, slot)).toBeCloseTo(base, 6);
    expect(JSON.stringify([...p.items.values()])).toBe(items);
  });

  it('leaves a starter with a rune added and a player-made spell alone', async () => {
    const { rooms, socket } = await setup();
    const { sim, p, slot, item } = bench(rooms, socket);
    const base = castDamage(rooms, socket, slot);
    // The same Bone Spear runes in a sigil that is not a starter, then the starter with a Lightning rune added.
    const { starter: _starter, ...rest } = item;
    const playerMade: SigilItem = { ...rest, uid: sim.newItemUid(), name: 'Sigil' };
    const added: SigilItem = { ...item, uid: sim.newItemUid(), slots: [...item.slots, createRune(sim.newItemUid(), 'lightning')] };
    for (const other of [playerMade, added]) {
      p.items.set(other.uid, other);
      p.inventory[p.inventory.findIndex((c) => c === null)] = other.uid;
      socket.emit({ t: 'equipSigil', uid: other.uid, slot });
      rooms.tick();
      expect(p.sigils[slot]?.uid, 'equipped').toBe(other.uid);
      const plain = castDamage(rooms, socket, slot);
      rooms.updateSettings({ starterDamage: { bone_spear: 3 } });
      expect(castDamage(rooms, socket, slot)).toBeCloseTo(plain, 6);
      rooms.updateSettings({ starterDamage: {} });
    }
    expect(base).toBeGreaterThan(0);
  });

  it('survives a restart; an old row without it loads the default and a bad entry drops alone', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rune-starter-')), 'rune.db');
    const store = new AccountStore(file);
    store.saveSettings({ ...DEFAULT_SERVER_SETTINGS, starterDamage: { bone_spear: 1.5 } });
    expect(store.loadSettings().starterDamage).toEqual({ bone_spear: 1.5 });
    store.close();
    const raw = new DatabaseSync(file);
    raw.prepare(`UPDATE settings SET value = '{"xpRate":2}' WHERE key = 'server'`).run();
    const reopened = new AccountStore(file);
    expect(reopened.loadSettings()).toEqual({ ...DEFAULT_SERVER_SETTINGS, xpRate: 2 });
    raw.prepare(`UPDATE settings SET value = '{"starterDamage":{"bone_spear":2,"retired_skill":2,"smite":40}}' WHERE key = 'server'`).run();
    raw.close();
    expect(reopened.loadSettings().starterDamage).toEqual({ bone_spear: 2 });
    reopened.close();
  });
});
