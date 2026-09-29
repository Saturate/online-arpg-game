import { INSTANCE_CAPACITY, isServerMessage, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import type { GameSocket } from '../src/client.js';
import { RoomManager } from '../src/manager.js';

/** A connection the test drives by hand, recording everything the server sends it. */
class FakeSocket implements GameSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly OPEN = 1;
  readonly sent: ServerMessage[] = [];
  private listeners = new Map<string, (data: unknown, isBinary: boolean) => void>();

  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: 'close' | 'error', listener: () => void): this;
  on(event: string, listener: (data: unknown, isBinary: boolean) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  send(data: unknown): void {
    const msg: unknown = JSON.parse(String(data));
    if (isServerMessage(msg)) this.sent.push(msg);
  }
  close(): void {
    this.readyState = 3;
    this.listeners.get('close')?.(undefined, false);
  }
  emit(msg: object): void {
    this.listeners.get('message')?.(Buffer.from(JSON.stringify(msg)), false);
  }
  worldName(): string | undefined {
    const w = this.sent.filter((m) => m.t === 'world').at(-1);
    return w?.t === 'world' ? w.world.name : undefined;
  }
  party(): Extract<ServerMessage, { t: 'party' }>['party'] | undefined {
    const p = this.sent.filter((m) => m.t === 'party').at(-1);
    return p?.t === 'party' ? p.party : undefined;
  }
}

async function setup(players: number) {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store);
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < players; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id, mode: 'world' });
    sockets.push(socket);
  }
  return { rooms, sockets };
}

describe('public worlds', () => {
  it('fills one shared world up to capacity, then opens the next', async () => {
    const { sockets } = await setup(INSTANCE_CAPACITY + 1);
    const names = sockets.map((s) => s.worldName());
    expect(new Set(names.slice(0, INSTANCE_CAPACITY))).toEqual(new Set(['Public world 1']));
    expect(names[INSTANCE_CAPACITY]).toBe('Public world 2');
  });

  it('ignores the old player-chosen seed messages', async () => {
    const { sockets } = await setup(1);
    const [a] = sockets;
    if (!a) throw new Error('no socket');
    a.emit({ t: 'newInstance', seed: 42 });
    expect(a.worldName()).toBe('Public world 1');
  });
});

describe('parties', () => {
  it('invites, joins the inviter, opens a party world together, and leaves back to public', async () => {
    const { sockets } = await setup(INSTANCE_CAPACITY + 1);
    // Hero0 is in world 1 and the last one in world 2, so accepting has to move them over.
    const a = sockets[0];
    const b = sockets[INSTANCE_CAPACITY];
    if (!a || !b) throw new Error('no sockets');
    // World 1 is full, so first make room.
    sockets[1]?.close();
    a.emit({ t: 'chat', text: `/invite Hero${INSTANCE_CAPACITY}` });
    expect(b.sent.some((m) => m.t === 'partyInvite' && m.from === 'Hero0')).toBe(true);
    b.emit({ t: 'partyAnswer', accept: true });
    expect(b.party()?.members.map((m) => m.name)).toEqual(['Hero0', `Hero${INSTANCE_CAPACITY}`]);
    expect(b.worldName()).toBe('Public world 1');

    a.emit({ t: 'partyWorld' });
    expect(a.worldName()).toBe("Hero0's party world");
    expect(b.worldName()).toBe("Hero0's party world");
    expect(a.party()?.hasWorld).toBe(true);

    b.emit({ t: 'partyLeave' });
    expect(b.party()).toBeNull();
    expect(b.worldName()).toMatch(/^Public world/);
  });

  it('only lets the leader open a party world', async () => {
    const { sockets } = await setup(2);
    const [a, b] = sockets;
    if (!a || !b) throw new Error('no sockets');
    a.emit({ t: 'partyInvite', name: 'Hero1' });
    b.emit({ t: 'partyAnswer', accept: true });
    b.emit({ t: 'partyWorld' });
    expect(b.worldName()).toBe('Public world 1');
    expect(b.sent.some((m) => m.t === 'chat' && m.text.includes('Only the party leader'))).toBe(true);
  });
});
