import { INSTANCE_CAPACITY } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

async function setup(players: number, owners: ReadonlySet<string> = new Set()) {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, owners);
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < players; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
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

describe('staff teleport', () => {
  it('takes staff into the player\'s world and room, and refuses everyone else', async () => {
    const { sockets } = await setup(INSTANCE_CAPACITY + 1, new Set([`player${INSTANCE_CAPACITY}`]));
    const staff = sockets[INSTANCE_CAPACITY];
    const player = sockets[0];
    const other = sockets[1];
    if (!staff || !player || !other) throw new Error('no sockets');
    expect(staff.worldName()).toBe('Public world 2');
    staff.emit({ t: 'chat', text: '/goto Hero0' });
    expect(staff.worldName()).toBe('Public world 1');

    other.emit({ t: 'chat', text: '/goto Hero0' });
    expect(other.sent.some((m) => m.t === 'chat' && m.text.includes('Unknown command /goto'))).toBe(true);
  });
});

describe('stash safety', () => {
  it('refuses the join and keeps the row when the stash cannot be read', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rune-stash-')), 'rune.db');
    const store = new AccountStore(file);
    const acc = await store.register('stashy', 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, 'Hoarder', 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE accounts SET stash_json = '{broken' WHERE id = ?").run(acc.id);
    const rooms = new RoomManager(1, store);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    expect(socket.sent.some((m) => m.t === 'sessionEnded' && m.reason.includes('stash could not be loaded'))).toBe(true);
    const row = raw.prepare('SELECT stash_json FROM accounts WHERE id = ?').get(acc.id);
    expect(row).toMatchObject({ stash_json: '{broken' });
    raw.close();
  });
});
