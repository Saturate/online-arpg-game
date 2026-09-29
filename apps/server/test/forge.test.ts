import { createRolledRune, createRune, createSigil, emptyGrid, forgeInsertPrice, Rng, STASH, type PlayerSave, type StashSave } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

async function character(store: AccountStore) {
  const acc = await store.register('smith', 'password123');
  if (acc === 'taken') throw new Error('taken');
  const ch = store.createCharacter(acc.id, 'Smith', 'mage');
  if (typeof ch === 'string') throw new Error(ch);
  return { accountId: acc.id, characterId: ch.id };
}

function join1(rooms: RoomManager, store: AccountStore, accountId: number, characterId: number): FakeSocket {
  const socket = new FakeSocket();
  rooms.connect(socket);
  socket.emit({ t: 'join', token: store.createSession(accountId), characterId });
  return socket;
}

describe('inscribe on the server', () => {
  it('takes runes from the account stash and saves stash and character together', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rune-forge-')), 'rune.db');
    const store = new AccountStore(file);
    const { accountId, characterId } = await character(store);
    // First join makes the starter kit; leaving saves it.
    const rooms = new RoomManager(1, store);
    join1(rooms, store, accountId, characterId).close();
    const stored = store.loadCharacter(accountId, characterId)?.save;
    if (!stored) throw new Error('no save');
    const rng = new Rng(5);
    const sigil = createSigil(90_001, rng, 'rare');
    const rolled = createRolledRune(90_002, rng, 'rare', 6, 'orb');
    const fire = createRune(90_003, 'fire', 3);
    const save: PlayerSave = { ...stored, items: [...stored.items, sigil], inventory: [...stored.inventory], gold: 1000 };
    const free = save.inventory.indexOf(null);
    save.inventory[free] = sigil.uid;
    const cells = emptyGrid(STASH);
    cells[0] = rolled.uid;
    cells[1] = fire.uid;
    const stash: StashSave = { items: [rolled, fire], cells, runeFormat: 2 };
    store.saveCharacterAndStash(characterId, save, accountId, stash);

    const socket = join1(rooms, store, accountId, characterId);
    const welcome = socket.last('welcome');
    const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
    const member = room ? [...room.members.values()].find((m) => m.client.characterId === characterId) : undefined;
    const p = member ? room?.sim.world.player.get(member.playerId) : undefined;
    const pos = member ? room?.sim.world.position.get(member.playerId) : undefined;
    const forge = room?.sim.mapDef.forge;
    if (!room || !p || !pos || !forge) throw new Error('not in town');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    // The client sees the stash's contents wherever it stands, since the forge lists stash runes.
    room.tick();
    const inv = socket.last('inventory');
    if (!inv) throw new Error('no inventory sent');
    const { items, stash: stashCells } = inv;
    const find = (pred: (i: (typeof items)[number]) => boolean) => items.find((i) => pred(i) && stashCells.includes(i.uid));
    const stashedRolled = find((i) => i.kind === 'rune' && i.affixes.length > 0);
    const stashedFire = find((i) => i.kind === 'rune' && i.rune === 'fire');
    const bagSigil = inv.items.find((i) => i.kind === 'sigil' && i.slots.length === 0 && inv.inventory.includes(i.uid));
    if (!stashedRolled || !stashedFire || !bagSigil) throw new Error('stash not sent');

    socket.emit({ t: 'inscribe', uid: bagSigil.uid, base: [], slots: [{ from: 'rolled', uid: stashedRolled.uid }, { from: 'plain', rune: 'fire' }], attempt: 1 });
    expect(socket.sent.filter((m) => m.t === 'notice').map((m) => (m.t === 'notice' ? m.text : ''))).toEqual([]);
    rooms.saveAll();

    const after = store.loadStash(accountId);
    if (!after || after === 'unreadable') throw new Error('stash lost');
    const runes = after.stash.items.flatMap((i) => (i.kind === 'rune' ? [[i.rune, i.count, i.affixes.length > 0]] : []));
    expect(runes).toEqual([['fire', 2, false]]);
    const character2 = store.loadCharacter(accountId, characterId)?.save;
    const inscribed = character2?.items.find((i) => i.kind === 'sigil' && i.name === sigil.name);
    expect(inscribed?.kind === 'sigil' && inscribed.slots.map((r) => [r.rune, r.affixes.length > 0])).toEqual([
      ['orb', true],
      ['fire', false],
    ]);
    expect(character2?.gold).toBe(1000 - forgeInsertPrice(rolled) - forgeInsertPrice(createRune(0, 'fire')));
  });

  it('sends the new inventory before the accepted reply, and refuses a resend drafted from the old slots', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rune-forge-')), 'rune.db');
    const store = new AccountStore(file);
    const { accountId, characterId } = await character(store);
    const rooms = new RoomManager(1, store);
    const socket = join1(rooms, store, accountId, characterId);
    const welcome = socket.last('welcome');
    const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
    const member = room ? [...room.members.values()].find((m) => m.client.characterId === characterId) : undefined;
    const p = member ? room?.sim.world.player.get(member.playerId) : undefined;
    const pos = member ? room?.sim.world.position.get(member.playerId) : undefined;
    const forge = room?.sim.mapDef.forge;
    if (!room || !p || !pos || !forge) throw new Error('not in town');
    pos.x = forge.x + 50;
    pos.y = forge.y;
    p.gold = 1000;
    room.tick();
    const inv = socket.last('inventory');
    const sigil = inv?.items.find((i) => i.kind === 'sigil' && i.slots.length > 1);
    if (!inv || sigil?.kind !== 'sigil') throw new Error('no starter sigil');
    const base = sigil.slots.map((r) => r.uid);
    // Drop the last rune and buy a plain Fire for the end.
    const draft = { t: 'inscribe', uid: sigil.uid, base, slots: [...base.slice(0, -1).map((_, index) => ({ from: 'keep', index })), { from: 'plain', rune: 'fire' }] };
    p.items.set(90_010, createRune(90_010, 'fire', 3));
    p.inventory[p.inventory.indexOf(null)] = 90_010;
    const from = socket.sent.length;
    socket.emit({ ...draft, attempt: 7 });
    const after = socket.sent.slice(from);
    const replyAt = after.findIndex((m) => m.t === 'inscribed');
    const invAt = after.findIndex((m) => m.t === 'inventory');
    expect(after[replyAt]).toEqual({ t: 'inscribed', uid: sigil.uid, attempt: 7, ok: true });
    expect(invAt).toBeGreaterThanOrEqual(0);
    expect(invAt).toBeLessThan(replyAt);
    const shown = after[invAt];
    const now = shown?.t === 'inventory' ? shown.items.find((i) => i.uid === sigil.uid) : undefined;
    expect(now?.kind === 'sigil' && now.slots.at(-1)?.rune).toBe('fire');

    const before = JSON.stringify({ items: [...p.items.values()], inventory: p.inventory, gold: p.gold });
    const from2 = socket.sent.length;
    socket.emit({ ...draft, attempt: 8 });
    expect(socket.sent.slice(from2)).toEqual([{ t: 'inscribed', uid: sigil.uid, attempt: 8, ok: false, error: 'The sigil changed; look again' }]);
    expect(JSON.stringify({ items: [...p.items.values()], inventory: p.inventory, gold: p.gold })).toBe(before);
  });
});
