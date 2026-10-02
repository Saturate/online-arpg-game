import { createGear, LOOT, spawnBag, type ItemUid, type ServerMessage } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { Client, type ClientSocket } from '../src/client.js';
import { Room } from '../src/room.js';

function recordingClient(id: string): { client: Client; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const socket: ClientSocket = {
    readyState: 1,
    OPEN: 1,
    send: (data) => {
      const msg: ServerMessage = JSON.parse(String(data));
      sent.push(msg);
    },
    close: () => undefined,
  };
  return { client: new Client(id, socket), sent };
}

function lootMessages(sent: readonly ServerMessage[]): Extract<ServerMessage, { t: 'lootPile' }>[] {
  return sent.flatMap((m) => (m.t === 'lootPile' ? [m] : []));
}

function setup() {
  const room = new Room('flat', { kind: 'flat' }, 1);
  const a = recordingClient('a');
  const b = recordingClient('b');
  room.add(a.client, 'mage', 'Ann');
  room.add(b.client, 'warrior', 'Bo');
  const pa = room.members.get('a')?.playerId;
  const pb = room.members.get('b')?.playerId;
  if (pa === undefined || pb === undefined) throw new Error('setup');
  const w = room.sim.world;
  const at = w.position.get(pa);
  const bpos = w.position.get(pb);
  if (!at || !bpos) throw new Error('setup');
  bpos.x = at.x;
  bpos.y = at.y;
  const items = [0, 1, 2].map(() => createGear(room.sim.newItemUid(), room.sim.rand.loot, 'magic', 1, { category: 'ring' }));
  spawnBag(room.sim, at.x + 30, at.y, items, LOOT.bagRadius, null);
  const pile = [...w.loot.keys()].at(-1);
  if (pile === undefined) throw new Error('no pile');
  return { room, a, b, pa, pb, pile, items };
}

describe('loot window over the wire', () => {
  it('sends the open pile only to its viewer, keeps it current and closes it when emptied', () => {
    const { room, a, b, pb, pile, items } = setup();
    room.handle(a.client, { t: 'lootOpen', id: pile });
    const opened = lootMessages(a.sent).at(-1);
    expect(opened?.items?.map((i) => i.uid)).toEqual(items.map((i) => i.uid));
    expect(lootMessages(b.sent)).toHaveLength(0);

    const first = items[0];
    if (!first) throw new Error('setup');
    room.handle(b.client, { t: 'pickup', id: pile, uid: first.uid });
    room.tick();
    const update = lootMessages(a.sent).at(-1);
    expect(update?.items?.map((i) => i.uid)).toEqual(items.slice(1).map((i) => i.uid));
    // Nothing changed since: no resend.
    const count = lootMessages(a.sent).length;
    room.tick();
    expect(lootMessages(a.sent)).toHaveLength(count);

    room.handle(b.client, { t: 'pickup', id: pile });
    room.tick();
    expect(lootMessages(a.sent).at(-1)).toEqual({ t: 'lootPile', id: pile, items: null });
    const bo = room.sim.world.player.get(pb);
    for (const it of items) expect(bo?.items.has(it.uid)).toBe(true);
    // A take from the closed window is refused and changes nothing.
    const before = [...(room.sim.world.player.get(room.members.get('a')?.playerId ?? -1)?.items.keys() ?? [])];
    const second: ItemUid | undefined = items[1]?.uid;
    if (second === undefined) throw new Error('setup');
    room.handle(a.client, { t: 'pickup', id: pile, uid: second });
    expect(a.sent.at(-1)).toEqual({ t: 'notice', text: 'Someone else took it' });
    expect([...(room.sim.world.player.get(room.members.get('a')?.playerId ?? -1)?.items.keys() ?? [])]).toEqual(before);
  });

  it('closes the window when the hero walks away or the pile despawns', () => {
    const { room, a, pa, pile } = setup();
    room.handle(a.client, { t: 'lootOpen', id: pile });
    const pos = room.sim.world.position.get(pa);
    if (!pos) throw new Error('setup');
    pos.x += 400;
    room.tick();
    expect(lootMessages(a.sent).at(-1)).toEqual({ t: 'lootPile', id: pile, items: null });
    pos.x -= 400;
    room.handle(a.client, { t: 'lootOpen', id: pile });
    expect(lootMessages(a.sent).at(-1)?.items).toHaveLength(3);
    const l = room.sim.world.loot.get(pile);
    if (!l) throw new Error('no pile');
    l.lifetime = 0.01;
    room.tick();
    room.tick();
    expect(lootMessages(a.sent).at(-1)).toEqual({ t: 'lootPile', id: pile, items: null });
  });

  it('refuses to open a pile out of reach', () => {
    const { room, a, pa, pile } = setup();
    const pos = room.sim.world.position.get(pa);
    if (!pos) throw new Error('setup');
    pos.x += 400;
    room.handle(a.client, { t: 'lootOpen', id: pile });
    expect(lootMessages(a.sent).at(-1)).toEqual({ t: 'lootPile', id: pile, items: null });
    room.tick();
    expect(lootMessages(a.sent)).toHaveLength(1);
  });
});
