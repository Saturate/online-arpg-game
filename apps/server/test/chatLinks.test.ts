import { CHAT_MAX_LENGTH, DEFAULT_SERVER_SETTINGS, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

type Chat = Extract<ServerMessage, { t: 'chat' }>;

async function setup() {
  const store = new AccountStore(':memory:');
  const rooms = new RoomManager(1, store, new Set());
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < 2; i++) {
    const acc = await store.register(`player${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token: store.createSession(acc.id), characterId: ch.id });
    sockets.push(socket);
  }
  const [a, b] = sockets;
  if (!a || !b) throw new Error('no sockets');
  rooms.tick();
  return { rooms, a, b };
}

function uids(s: FakeSocket): number[] {
  const inv = s.last('inventory');
  if (!inv) throw new Error('no inventory');
  return inv.items.map((i) => i.uid);
}

function chats(s: FakeSocket): Chat[] {
  return s.sent.filter((m): m is Chat => m.t === 'chat' && m.kind !== 'system');
}

describe('item links in chat', () => {
  it('sends a display copy of the sender own item to everyone in the world', async () => {
    const { a, b } = await setup();
    const [uid] = uids(a);
    if (uid === undefined) throw new Error('no item');
    const name = a.last('inventory')?.items.find((i) => i.uid === uid)?.name;
    a.emit({ t: 'chat', text: 'look {1}', links: [uid] });
    const got = chats(b).at(-1);
    expect(got?.text).toBe('look {1}');
    expect(got?.items?.[0]?.name).toBe(name);
    expect(got?.items?.[0]?.uid).toBeLessThan(0);
    // The sender sees the same line.
    expect(chats(a).at(-1)?.items).toHaveLength(1);
  });

  it('never resolves another player item, so links cannot probe inventories', async () => {
    const { a, b } = await setup();
    const theirs = uids(b).filter((u) => !uids(a).includes(u));
    expect(theirs.length).toBeGreaterThan(0);
    a.emit({ t: 'chat', text: 'peek {1} {2}', links: theirs.slice(0, 2) });
    const got = chats(b).at(-1);
    expect(got?.text).toBe('peek');
    expect(got?.items).toBeUndefined();
  });

  it('drops unknown uids and keeps the known ones', async () => {
    const { a, b } = await setup();
    const [mine] = uids(a);
    if (mine === undefined) throw new Error('no item');
    a.emit({ t: 'chat', text: '{1} and {2}', links: [123_456, mine] });
    const got = chats(b).at(-1);
    expect(got?.text).toBe('and {1}');
    expect(got?.items).toHaveLength(1);
  });

  it('refuses a message with more than three links, and a line that is only a dead link', async () => {
    const { a, b } = await setup();
    const before = chats(b).length;
    a.emit({ t: 'chat', text: '{1}{2}{3}{4}', links: [1, 2, 3, 4] });
    a.emit({ t: 'chat', text: '{1}', links: [999_999] });
    expect(chats(b).length).toBe(before);
  });

  it('caps the text before links are resolved', async () => {
    const { a, b } = await setup();
    const [mine] = uids(a);
    if (mine === undefined) throw new Error('no item');
    a.emit({ t: 'chat', text: `${'x'.repeat(CHAT_MAX_LENGTH)}{1}`, links: [mine] });
    const got = chats(b).at(-1);
    expect(got?.text.length).toBeLessThanOrEqual(CHAT_MAX_LENGTH);
    expect(got?.items).toBeUndefined();
  });

  it('links in whispers and party chat too', async () => {
    const { a, b } = await setup();
    const [mine] = uids(a);
    if (mine === undefined) throw new Error('no item');
    a.emit({ t: 'chat', text: '/w Hero1 for you {1}', links: [mine] });
    const got = chats(b).at(-1);
    expect(got?.kind).toBe('whisper');
    expect(got?.text).toBe('for you {1}');
    expect(got?.items).toHaveLength(1);
  });
});

describe('zoom settings', () => {
  it('reach players on join and again when an admin changes them', async () => {
    const { rooms, a, b } = await setup();
    expect(a.last('zoom')?.zoom).toEqual({ zoomDefault: DEFAULT_SERVER_SETTINGS.zoomDefault, zoomDungeon: DEFAULT_SERVER_SETTINGS.zoomDungeon, zoomMin: DEFAULT_SERVER_SETTINGS.zoomMin, zoomMax: DEFAULT_SERVER_SETTINGS.zoomMax });
    rooms.updateSettings({ zoomDefault: 1.2, zoomMax: 1.5 });
    expect(b.last('zoom')?.zoom).toMatchObject({ zoomDefault: 1.2, zoomMax: 1.5 });
  });
});
