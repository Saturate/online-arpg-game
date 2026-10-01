import { loadMap, SIM, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

async function soloPlayer() {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set(['player0']));
  const acc = await store.register('player0', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Hero0', 'warrior');
  if (typeof ch === 'string') throw new Error(ch);
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
  return { rooms, socket };
}

function welcome(s: FakeSocket): Welcome {
  const w = s.last('welcome');
  if (!w) throw new Error('no welcome');
  return w;
}

function pausedNow(rooms: RoomManager, s: FakeSocket): boolean {
  const room = rooms.roomById(welcome(s).roomId);
  if (!room) throw new Error('no room');
  return room.paused;
}

describe('pause', () => {
  it('never pauses the world, where the town is, even for a player alone in it', async () => {
    const { rooms, socket } = await soloPlayer();
    const map = welcome(socket).map;
    expect(map.kind).toBe('world');
    expect(welcome(socket).canPause).toBe(false);
    socket.emit({ t: 'pause', paused: true });
    expect(pausedNow(rooms, socket)).toBe(false);
    expect(socket.last('notice')?.text).toBe('The town never pauses');
  });

  it('pauses a room the player is alone in outside town', async () => {
    const { rooms, socket } = await soloPlayer();
    const portal = loadMap(welcome(socket).map).def.portals.find((p) => p.target === 'arena');
    if (!portal) throw new Error('no arena portal in town');
    socket.emit({ t: 'dev', cmd: { c: 'teleport', x: portal.x, y: portal.y } });
    for (let i = 0; i < 2 * SIM.tickRate; i++) rooms.tick();
    expect(welcome(socket).map.kind).toBe('arenaGate');
    expect(welcome(socket).canPause).toBe(true);
    socket.emit({ t: 'pause', paused: true });
    expect(pausedNow(rooms, socket)).toBe(true);
  });
});
