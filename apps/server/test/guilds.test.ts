import { applyGuildStashTabs, addItem, BAG, createGear, createRune, findSpot, GUILD, GUILD_LIMITS, guildTabPrice, parseGuildStash, Rng, type GuildInfo, type GuildStashView, type Item, type PlayerComp } from '@rune/shared';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts.js';
import { INVITE_MS, LEADER_IDLE_MS } from '../src/guilds.js';
import { AccountApi } from '../src/http.js';
import { events } from '../src/eventLog.js';
import { RoomManager } from '../src/manager.js';
import { FakeSocket } from './fakeSocket.js';

interface Hero {
  socket: FakeSocket;
  accountId: number;
  characterId: number;
  name: string;
  token: string;
}

/** A file database (so a restart can read it back), a manager on a clock the test moves, and `n` heroes online. */
async function world(n: number) {
  const file = join(mkdtempSync(join(tmpdir(), 'rune-guild-')), 'rune.db');
  const store = new AccountStore(file);
  let now = Date.now();
  const clock = (): number => now;
  const rooms = new RoomManager(1, store, new Set(), clock);
  const heroes: Hero[] = [];
  for (let i = 0; i < n; i++) {
    const acc = await store.register(`guilder${i}`, 'password123');
    if (acc === 'taken') throw new Error('taken');
    const ch = store.createCharacter(acc.id, `Hero${i}`, 'warrior');
    if (typeof ch === 'string') throw new Error(ch);
    const token = store.createSession(acc.id);
    const socket = new FakeSocket();
    rooms.connect(socket);
    socket.emit({ t: 'join', token, characterId: ch.id });
    heroes.push({ socket, accountId: acc.id, characterId: ch.id, name: `Hero${i}`, token });
  }
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON');
  return { file, store, rooms, heroes, raw, advance: (ms: number) => (now += ms) };
}

function hero(heroes: Hero[], i: number): Hero {
  const h = heroes[i];
  if (!h) throw new Error(`no hero ${i}`);
  return h;
}

function roomOf(rooms: RoomManager, socket: FakeSocket) {
  const welcome = socket.last('welcome');
  const room = welcome ? rooms.roomById(welcome.roomId) : undefined;
  const member = room ? [...room.members.values()].find((m) => m.client.socket === socket) : undefined;
  const p = member ? room?.sim.world.player.get(member.playerId) : undefined;
  const pos = member ? room?.sim.world.position.get(member.playerId) : undefined;
  if (!room || !member || !p || !pos) throw new Error('not in a room');
  return { room, p, pos };
}

/** The hero's player, standing at the stash chest of their room. */
function atChest(rooms: RoomManager, socket: FakeSocket): PlayerComp {
  const { room, p, pos } = roomOf(rooms, socket);
  const at = room.sim.mapDef.stash;
  if (!at) throw new Error('no stash here');
  pos.x = at.x + 50;
  pos.y = at.y;
  return p;
}

function player(rooms: RoomManager, socket: FakeSocket): PlayerComp {
  return roomOf(rooms, socket).p;
}

/** A named, unbound rare body armour put in the bag, so it can be followed by name everywhere. */
function giveGear(rooms: RoomManager, socket: FakeSocket, name: string, seed = 1): number {
  const { room, p } = roomOf(rooms, socket);
  const item: Item = { ...createGear(room.sim.newItemUid(), new Rng(seed), 'rare', 5), name };
  if (!addItem(p, item)) throw new Error('bag full');
  return item.uid;
}

function guildInfo(socket: FakeSocket): GuildInfo | null {
  return socket.last('guild')?.guild ?? null;
}

/** The guild stash as the client holds it: the last full view with every later tab update merged in. */
function stashView(socket: FakeSocket): GuildStashView | null {
  let view: GuildStashView | null = null;
  for (const m of socket.sent) {
    if (m.t === 'guildStash') view = m.stash;
    else if (m.t === 'guildStashTabs' && view) view = applyGuildStashTabs(view, m.update);
  }
  return view;
}

function lastNotice(socket: FakeSocket): string | undefined {
  return socket.last('notice')?.text;
}

function systemLines(socket: FakeSocket): string[] {
  return socket.sent.flatMap((m) => (m.t === 'chat' && m.kind === 'system' ? [m.text] : []));
}

function uidIn(view: GuildStashView | null, name: string): number {
  const it = view?.items.find((i) => i.name === name);
  if (!it) throw new Error(`no ${name} in the guild stash view`);
  return it.uid;
}

function bagHas(p: PlayerComp, name: string): boolean {
  return p.inventory.some((u) => u !== null && p.items.get(u)?.name === name);
}

/** Hero 0 founds "Iron Oath" [IRON] with enough gold; heroes listed in `members` join it. */
function found(w: Awaited<ReturnType<typeof world>>, members: number[] = []): void {
  const leader = hero(w.heroes, 0);
  player(w.rooms, leader.socket).gold = 10_000;
  leader.socket.emit({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' });
  for (const i of members) {
    const h = hero(w.heroes, i);
    leader.socket.emit({ t: 'guildInvite', name: h.name });
    h.socket.emit({ t: 'guildAnswer', accept: true });
  }
}

/** Where every item named `name` is after a restart: character saves, account stashes and guild stashes. */
function placesAfterRestart(file: string, heroes: Hero[], name: string): string[] {
  const store = new AccountStore(file);
  const out: string[] = [];
  for (const h of heroes) {
    const save = store.loadCharacter(h.accountId, h.characterId)?.save;
    for (const it of save?.items ?? []) if (it.name === name) out.push(`character ${h.name}`);
    const stash = store.loadStash(h.accountId);
    if (stash === 'unreadable') throw new Error('unreadable stash');
    for (const it of stash?.stash.items ?? []) if (it.name === name) out.push(`stash ${h.name}`);
  }
  for (const g of store.guilds.loadAll()) {
    const { stash } = parseGuildStash(JSON.parse(g.stashJson));
    for (const it of stash.items.values()) if (it.name === name) out.push(`guild ${g.name}`);
  }
  store.close();
  return out;
}

describe('founding a guild', () => {
  it('costs the founding character its gold, saved with the guild, and the guild comes back after a restart', async () => {
    const w = await world(1);
    const h = hero(w.heroes, 0);
    const p = player(w.rooms, h.socket);
    p.gold = GUILD.foundPrice + 5;
    h.socket.emit({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' });
    const info = guildInfo(h.socket);
    expect(info).toMatchObject({ name: 'Iron Oath', tag: 'IRON', rank: 'leader' });
    expect(info?.members.map((m) => [m.name, m.rank])).toEqual([['Hero0', 'leader']]);
    expect(p.gold).toBe(5);
    // Saved in the founding's own transaction: no autosave ran.
    expect(w.store.loadCharacter(h.accountId, h.characterId)?.save?.gold).toBe(5);
    const again = new RoomManager(1, w.store);
    const s = new FakeSocket();
    again.connect(s);
    h.socket.close();
    s.emit({ t: 'join', token: w.store.createSession(h.accountId), characterId: h.characterId });
    expect(guildInfo(s)).toMatchObject({ name: 'Iron Oath', tag: 'IRON', rank: 'leader' });
  });

  it('refuses too little gold, a taken name or tag (any case), reserved and badly formed tags, and a second guild', async () => {
    const w = await world(2);
    const a = hero(w.heroes, 0);
    const b = hero(w.heroes, 1);
    player(w.rooms, a.socket).gold = GUILD.foundPrice - 1;
    a.socket.emit({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' });
    expect(lastNotice(a.socket)).toMatch(/costs/);
    expect(guildInfo(a.socket)).toBeNull();
    found(w);
    const pb = player(w.rooms, b.socket);
    pb.gold = 10_000;
    b.socket.emit({ t: 'guildCreate', name: 'iron oath', tag: 'ASH' });
    expect(lastNotice(b.socket)).toBe('That guild name is taken');
    b.socket.emit({ t: 'guildCreate', name: 'Ash Vow', tag: 'iron' });
    expect(lastNotice(b.socket)).toBe('That tag is taken');
    b.socket.emit({ t: 'guildCreate', name: 'Ash Vow', tag: 'GM' });
    expect(lastNotice(b.socket)).toBe('That tag is reserved');
    b.socket.emit({ t: 'guildCreate', name: 'Ash Vow', tag: 'A' });
    expect(lastNotice(b.socket)).toMatch(/2 to 5 letters or digits/);
    b.socket.emit({ t: 'guildCreate', name: 'Ash Vow', tag: 'TOOLONG' });
    expect(lastNotice(b.socket)).toMatch(/2 to 5/);
    b.socket.emit({ t: 'guildCreate', name: 'Staff Council', tag: 'ASH' });
    expect(lastNotice(b.socket)).toBe('That name is reserved');
    expect(pb.gold).toBe(10_000);
    b.socket.emit({ t: 'guildCreate', name: 'Ash Vow', tag: 'ASH' });
    expect(guildInfo(b.socket)?.tag).toBe('ASH');
    b.socket.emit({ t: 'guildCreate', name: 'Second Vow', tag: 'TWO' });
    expect(lastNotice(b.socket)).toBe('Leave your guild first');
  });
});

describe('rank powers', () => {
  it('lets the Leader and Officers invite, and not Members; invites need an online player outside a guild', async () => {
    const w = await world(4);
    found(w, [1]);
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => hero(w.heroes, i));
    if (!a || !b || !c || !d) throw new Error('heroes');
    b.socket.emit({ t: 'guildInvite', name: 'Hero2' });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader and Officers can invite');
    expect(c.socket.last('guildInvite')).toBeUndefined();
    a.socket.emit({ t: 'guildInvite', name: 'Nobody' });
    expect(systemLines(a.socket).at(-1)).toBe('Nobody is not online');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    b.socket.emit({ t: 'guildInvite', name: 'hero2' });
    expect(c.socket.last('guildInvite')).toMatchObject({ from: 'Hero1', guild: 'Iron Oath', tag: 'IRON' });
    c.socket.emit({ t: 'guildAnswer', accept: false });
    expect(systemLines(b.socket).at(-1)).toBe('Hero2 declined your guild invite');
    c.socket.emit({ t: 'guildAnswer', accept: true });
    expect(systemLines(c.socket).at(-1)).toBe('That guild invite is no longer open');
    a.socket.emit({ t: 'guildInvite', name: 'Hero1' });
    expect(systemLines(a.socket).at(-1)).toBe('Hero1 is already in a guild');
  });

  it('lets an Officer kick Members only, the Leader kick Officers, and nobody kick the Leader', async () => {
    const w = await world(4);
    found(w, [1, 2, 3]);
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => hero(w.heroes, i));
    if (!a || !b || !c || !d) throw new Error('heroes');
    c.socket.emit({ t: 'guildKick', member: d.accountId });
    expect(systemLines(c.socket).at(-1)).toBe('Only the Leader and Officers can remove members');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    a.socket.emit({ t: 'guildPromote', member: c.accountId });
    b.socket.emit({ t: 'guildKick', member: c.accountId });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader can remove an Officer');
    b.socket.emit({ t: 'guildKick', member: a.accountId });
    expect(systemLines(b.socket).at(-1)).toBe('The Leader cannot be removed');
    b.socket.emit({ t: 'guildKick', member: d.accountId });
    expect(guildInfo(d.socket)).toBeNull();
    expect(systemLines(d.socket)).toContain('You were removed from Iron Oath');
    a.socket.emit({ t: 'guildKick', member: c.accountId });
    expect(guildInfo(c.socket)).toBeNull();
    expect(guildInfo(a.socket)?.members.map((m) => m.name).sort()).toEqual(['Hero0', 'Hero1']);
  });

  it('lets only the Leader promote, demote and hand leadership on; the Leader cannot just leave', async () => {
    const w = await world(3);
    found(w, [1, 2]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    b.socket.emit({ t: 'guildPromote', member: c.accountId });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader promotes members');
    b.socket.emit({ t: 'guildDemote', member: b.accountId });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader demotes members');
    b.socket.emit({ t: 'guildTransfer', member: b.accountId });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader hands leadership on');
    a.socket.emit({ t: 'guildLeave' });
    expect(systemLines(a.socket).at(-1)).toMatch(/Hand leadership to another member first/);
    a.socket.emit({ t: 'guildDemote', member: b.accountId });
    expect(guildInfo(b.socket)?.rank).toBe('member');
    a.socket.emit({ t: 'guildTransfer', member: c.accountId });
    expect(guildInfo(c.socket)?.rank).toBe('leader');
    expect(guildInfo(a.socket)?.rank).toBe('officer');
    a.socket.emit({ t: 'guildLeave' });
    expect(guildInfo(a.socket)).toBeNull();
    expect(guildInfo(c.socket)?.members.map((m) => m.name).sort()).toEqual(['Hero1', 'Hero2']);
  });

  it('lets Officers, not Members, buy, rename and set permissions of tabs, and set the message of the day', async () => {
    const w = await world(3);
    found(w, [1, 2]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    const pb = atChest(w.rooms, b.socket);
    const pc = atChest(w.rooms, c.socket);
    pb.gold = 2000;
    pc.gold = 2000;
    c.socket.emit({ t: 'guildBuyTab' });
    expect(lastNotice(c.socket)).toBe('Only the Leader and Officers buy guild tabs');
    c.socket.emit({ t: 'guildEditTab', tab: 1, name: 'Mine', color: 'rust' });
    expect(lastNotice(c.socket)).toBe('Only the Leader and Officers manage guild tabs');
    c.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'member', perms: { view: true, deposit: true, withdraw: true } });
    expect(lastNotice(c.socket)).toBe('Only the Leader and Officers set tab permissions');
    c.socket.emit({ t: 'guildMotd', text: 'hello' });
    expect(systemLines(c.socket).at(-1)).toBe('Only the Leader and Officers set the message of the day');
    const price = guildTabPrice(1) ?? 0;
    b.socket.emit({ t: 'guildStashOpen' });
    b.socket.emit({ t: 'guildBuyTab' });
    expect(pb.gold).toBe(2000 - price);
    expect(stashView(b.socket)?.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(w.store.loadCharacter(b.accountId, b.characterId)?.save?.gold).toBe(2000 - price);
    b.socket.emit({ t: 'guildEditTab', tab: 2, name: 'Officers', color: 'blood' });
    expect(stashView(b.socket)?.tabs[1]).toMatchObject({ name: 'Officers', color: 'blood' });
    b.socket.emit({ t: 'guildMotd', text: '  Raid at   dusk  ' });
    expect(guildInfo(c.socket)?.motd).toBe('Raid at dusk');
    expect(pc.gold).toBe(2000);
  });

  it('stops buying at the tab cap, which is a live tuning number', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const p = atChest(w.rooms, a.socket);
    p.gold = 1_000_000;
    const cap = GUILD.maxTabs;
    GUILD.maxTabs = 3;
    try {
      a.socket.emit({ t: 'guildStashOpen' });
      for (let i = 0; i < 4; i++) {
        w.advance(2000);
        a.socket.emit({ t: 'guildBuyTab' });
      }
      expect(stashView(a.socket)?.tabs).toHaveLength(3);
      expect(stashView(a.socket)?.tabPrice).toBeNull();
      expect(lastNotice(a.socket)).toBe('Your guild owns all 3 tabs it can');
    } finally {
      GUILD.maxTabs = cap;
    }
  });

  it('holds at most 50 members', async () => {
    const w = await world(2);
    found(w);
    const a = hero(w.heroes, 0);
    const b = hero(w.heroes, 1);
    const guildId = guildInfo(a.socket)?.id ?? 0;
    // 49 more accounts straight into the tables, then read back the way an account change is.
    const addAccount = w.raw.prepare("INSERT INTO accounts (username, password_salt, password_hash, created_at) VALUES (?, x'00', x'00', ?)");
    const addMember = w.raw.prepare("INSERT INTO guild_members (account_id, guild_id, rank, joined_at) VALUES (?, ?, 'member', ?)");
    for (let i = 0; i < GUILD_LIMITS.maxMembers - 1; i++) {
      const r = addAccount.run(`filler${i}`, Date.now());
      addMember.run(Number(r.lastInsertRowid), guildId, Date.now());
    }
    w.rooms.checkGuildLeadership();
    a.socket.emit({ t: 'guildInvite', name: 'Hero1' });
    expect(systemLines(a.socket).at(-1)).toBe(`Your guild is full (${GUILD_LIMITS.maxMembers})`);
    expect(b.socket.last('guildInvite')).toBeUndefined();
  });
});

describe('the guild stash', () => {
  it('needs the chest, and gives Members view and deposit but not withdraw on a new tab', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    const uid = giveGear(w.rooms, b.socket, 'Witness Vest');
    b.socket.emit({ t: 'guildStashOpen' });
    expect(lastNotice(b.socket)).toBe('Stand at the stash to use it');
    const pb = atChest(w.rooms, b.socket);
    b.socket.emit({ t: 'guildStashOpen' });
    expect(stashView(b.socket)?.tabs[0]?.access).toEqual({ view: true, deposit: true, withdraw: false });
    b.socket.emit({ t: 'guildDeposit', uid, tab: 1, at: null });
    expect(bagHas(pb, 'Witness Vest')).toBe(false);
    const gid = uidIn(stashView(b.socket), 'Witness Vest');
    b.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(lastNotice(b.socket)).toBe('Your rank cannot take items from Tab 1');
    expect(bagHas(pb, 'Witness Vest')).toBe(false);
    // The Leader allows it, and the Member's open view follows at once.
    a.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'member', perms: { view: false, deposit: false, withdraw: true } });
    expect(stashView(b.socket)?.tabs[0]?.access).toEqual({ view: true, deposit: false, withdraw: true });
    b.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(bagHas(pb, 'Witness Vest')).toBe(true);
    expect(placesAfterRestart(w.file, w.heroes, 'Witness Vest')).toEqual(['character Hero1']);
  });

  it('keeps tabs a rank cannot view closed, items included, and refuses deposits where the rank may not', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    const pa = atChest(w.rooms, a.socket);
    atChest(w.rooms, b.socket);
    pa.gold = 5000;
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildBuyTab' });
    a.socket.emit({ t: 'guildTabPerms', tab: 2, rank: 'member', perms: { view: false, deposit: false, withdraw: false } });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Hidden Vest'), tab: 2, at: { x: 0, y: 0 } });
    b.socket.emit({ t: 'guildStashOpen' });
    const view = stashView(b.socket);
    expect(view?.tabs[1]).toMatchObject({ id: 2, cells: null, access: { view: false, deposit: false, withdraw: false } });
    expect(view?.items.some((i) => i.name === 'Hidden Vest')).toBe(false);
    // Officers' and Members' settings are shown to tab managers only.
    expect(view?.tabs[1]?.perms).toBeUndefined();
    expect(stashView(a.socket)?.tabs[1]?.perms?.member).toEqual({ view: false, deposit: false, withdraw: false });
    b.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, b.socket, 'Member Vest'), tab: 2, at: null });
    expect(lastNotice(b.socket)).toBe('Your rank cannot put items into Tab 2');
    // Moving between tabs needs withdraw on the tab it leaves.
    b.socket.emit({ t: 'guildDeposit', uid: player(w.rooms, b.socket).inventory.find((u) => u !== null && player(w.rooms, b.socket).items.get(u)?.name === 'Member Vest') ?? -1, tab: 1, at: null });
    const mine = uidIn(stashView(b.socket), 'Member Vest');
    b.socket.emit({ t: 'guildMove', uid: mine, tab: 1, at: { x: 6, y: 4 } });
    expect(stashView(b.socket)?.tabs[0]?.cells?.[4 * 12 + 6]).toBe(mine);
  });

  it('refuses bound items and sigils holding bound runes', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const p = atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'unequipSigil', slot: 0 });
    const sigil = p.inventory.find((u) => u !== null && p.items.get(u)?.kind === 'sigil');
    if (sigil === undefined || sigil === null) throw new Error('no starter sigil in the bag');
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: sigil, tab: 1, at: null });
    expect(lastNotice(a.socket)).toBe('Bound items stay with this character');
    expect(p.inventory).toContain(sigil);
    expect(stashView(a.socket)?.items).toEqual([]);
  });

  it('refuses a withdrawal into a full bag and changes nothing', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const p = atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Deep Vest'), tab: 1, at: null });
    const gid = uidIn(stashView(a.socket), 'Deep Vest');
    // Full stacks of 20 take a cell each and top nothing up, so the bag ends with no free cell.
    const { room } = roomOf(w.rooms, a.socket);
    while (findSpot(p.inventory, BAG, { w: 1, h: 1 })) if (!addItem(p, createRune(room.sim.newItemUid(), 'bolt', 20))) break;
    const before = [...p.inventory];
    a.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(lastNotice(a.socket)).toBe('No room in your bag');
    expect(p.inventory).toEqual(before);
    expect(stashView(a.socket)?.items.map((i) => i.name)).toEqual(['Deep Vest']);
    // A cell given by hand that is taken is refused the same way.
    a.socket.emit({ t: 'guildWithdraw', uid: gid, at: { x: 0, y: 0 } });
    expect(lastNotice(a.socket)).toBe('No room there');
    expect(placesAfterRestart(w.file, w.heroes, 'Deep Vest')).toEqual(['guild Iron Oath']);
  });

  it('gives an item taken by two members at once, from different world copies, to exactly one', async () => {
    const w = await world(3);
    found(w, [1]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    // Hero1 goes into a party world with Hero2: a different world copy and room from the Leader's.
    b.socket.emit({ t: 'partyInvite', name: 'Hero2' });
    c.socket.emit({ t: 'partyAnswer', accept: true });
    b.socket.emit({ t: 'partyWorld' });
    expect(b.socket.worldName()).toBe("Hero1's party world");
    expect(roomOf(w.rooms, a.socket).room).not.toBe(roomOf(w.rooms, b.socket).room);
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    const pa = atChest(w.rooms, a.socket);
    const pb = atChest(w.rooms, b.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    b.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Contested Vest'), tab: 1, at: null });
    const gid = uidIn(stashView(b.socket), 'Contested Vest');
    // Both requests arrive before either room ticks.
    b.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    a.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(bagHas(pb, 'Contested Vest')).toBe(true);
    expect(bagHas(pa, 'Contested Vest')).toBe(false);
    expect(lastNotice(a.socket)).toBe('Someone else took it');
    expect(stashView(a.socket)?.items).toEqual([]);
    w.rooms.saveAll();
    expect(placesAfterRestart(w.file, w.heroes, 'Contested Vest')).toEqual(['character Hero1']);
  });

  it('refuses a member kicked between opening the stash and taking from it', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    atChest(w.rooms, a.socket);
    const pb = atChest(w.rooms, b.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    b.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Kept Vest'), tab: 1, at: null });
    const gid = uidIn(stashView(b.socket), 'Kept Vest');
    a.socket.emit({ t: 'guildKick', member: b.accountId });
    expect(stashView(b.socket)).toBeNull();
    b.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(lastNotice(b.socket)).toBe('You are not in a guild');
    expect(bagHas(pb, 'Kept Vest')).toBe(false);
    expect(stashView(a.socket)?.items.map((i) => i.name)).toEqual(['Kept Vest']);
  });

  it('keeps every item in one place when the write fails, and after a later autosave and a restart', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const p = atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    const uid = giveGear(w.rooms, a.socket, 'Fragile Vest');
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Stored Vest', 2), tab: 1, at: null });
    w.raw.exec("CREATE TRIGGER guild_write_fails BEFORE UPDATE ON guilds BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
    w.advance(2000);
    a.socket.emit({ t: 'guildDeposit', uid, tab: 1, at: null });
    expect(lastNotice(a.socket)).toBe('That could not be saved, so nothing moved');
    expect(p.inventory).toContain(uid);
    const stored = uidIn(stashView(a.socket), 'Stored Vest');
    a.socket.emit({ t: 'guildWithdraw', uid: stored, at: null });
    expect(lastNotice(a.socket)).toBe('That could not be saved, so nothing moved');
    expect(bagHas(p, 'Stored Vest')).toBe(false);
    a.socket.emit({ t: 'guildStashOpen' });
    expect(stashView(a.socket)?.items.map((i) => i.name)).toEqual(['Stored Vest']);
    w.raw.exec('DROP TRIGGER guild_write_fails');
    w.rooms.saveAll();
    expect(placesAfterRestart(w.file, w.heroes, 'Fragile Vest')).toEqual(['character Hero0']);
    expect(placesAfterRestart(w.file, w.heroes, 'Stored Vest')).toEqual(['guild Iron Oath']);
    // The disk recovers: the next move saves as normal.
    a.socket.emit({ t: 'guildDeposit', uid, tab: 1, at: null });
    expect(placesAfterRestart(w.file, w.heroes, 'Fragile Vest')).toEqual(['guild Iron Oath']);
  });

  it('conserves every item over mixed moves, a disconnect straight after one, and a seamless restart', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    atChest(w.rooms, a.socket);
    atChest(w.rooms, b.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    b.socket.emit({ t: 'guildStashOpen' });
    const names = ['Vest A', 'Vest B', 'Vest C', 'Vest D'];
    names.forEach((n, i) => a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, n, i + 1), tab: 1, at: null }));
    w.advance(2000);
    b.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(b.socket), 'Vest B'), at: null });
    b.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(b.socket), 'Vest C'), at: null });
    b.socket.emit({ t: 'guildDeposit', uid: player(w.rooms, b.socket).inventory.find((u) => u !== null && player(w.rooms, b.socket).items.get(u)?.name === 'Vest C') ?? -1, tab: 1, at: null });
    // A drops straight after a withdrawal, before any autosave.
    a.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(a.socket), 'Vest D'), at: null });
    a.socket.close();
    w.rooms.shutdown();
    const where = Object.fromEntries(names.map((n) => [n, placesAfterRestart(w.file, w.heroes, n)]));
    expect(where).toEqual({ 'Vest A': ['guild Iron Oath'], 'Vest B': ['character Hero1'], 'Vest C': ['guild Iron Oath'], 'Vest D': ['character Hero0'] });
    // The next boot puts the session back; the guild stash is in SQLite and needs nothing from the snapshot.
    const store = new AccountStore(w.file);
    const next = new RoomManager(1, store);
    next.restore();
    const s = new FakeSocket();
    next.connect(s);
    s.emit({ t: 'join', token: store.createSession(b.accountId), characterId: b.characterId });
    atChest(next, s);
    s.emit({ t: 'guildStashOpen' });
    expect(stashView(s)?.items.map((i) => i.name).sort()).toEqual(['Vest A', 'Vest C']);
    const uids = new Set(stashView(s)?.items.map((i) => i.uid));
    expect(uids.size).toBe(2);
  });

  it('limits how fast one client moves items', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    const uids = Array.from({ length: 12 }, (_, i) => giveGear(w.rooms, a.socket, `Spam ${i}`, i + 1));
    for (const uid of uids) a.socket.emit({ t: 'guildDeposit', uid, tab: 1, at: null });
    expect(stashView(a.socket)?.items.length).toBe(4);
    const p = player(w.rooms, a.socket);
    for (let i = 0; i < 2; i++) {
      w.advance(1000);
      for (const uid of uids) if (p.inventory.includes(uid)) a.socket.emit({ t: 'guildDeposit', uid, tab: 1, at: null });
    }
    expect(stashView(a.socket)?.items.length).toBe(12);
  });
});

describe('the guild log', () => {
  it('records founding, joins, rank changes, every deposit and withdrawal, kicks and leaves, newest first', async () => {
    const w = await world(3);
    found(w, [1, 2]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Logged Vest'), tab: 1, at: null });
    a.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(a.socket), 'Logged Vest'), at: null });
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    a.socket.emit({ t: 'guildKick', member: c.accountId });
    b.socket.emit({ t: 'guildLeave' });
    a.socket.emit({ t: 'guildLog', before: null });
    const entries = a.socket.last('guildLog')?.entries ?? [];
    expect(entries.map((e) => e.kind)).toEqual(['leave', 'kick', 'rank', 'withdraw', 'deposit', 'join', 'join', 'found']);
    expect(entries.find((e) => e.kind === 'deposit')?.text).toMatch(/^Hero0 put Logged Vest \(rare, item level 5\) into Tab 1$/);
    expect(entries.find((e) => e.kind === 'withdraw')?.text).toMatch(/^Hero0 took Logged Vest .* from Tab 1$/);
    expect(entries.find((e) => e.kind === 'join')?.text).toBe('Hero2 joined (invited by Hero0)');
    // Paged by id, newest first.
    const oldest = entries.at(-3)?.id ?? 0;
    a.socket.emit({ t: 'guildLog', before: oldest });
    expect(a.socket.last('guildLog')?.entries.map((e) => e.kind)).toEqual(['join', 'found']);
    // Outsiders read nothing.
    c.socket.emit({ t: 'guildLog', before: null });
    expect(systemLines(c.socket).at(-1)).toBe('You are not in a guild');
  });
});

describe('disbanding', () => {
  it('needs the Leader and an empty stash', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    b.socket.emit({ t: 'guildDisband' });
    expect(systemLines(b.socket).at(-1)).toBe('Only the Leader can disband the guild');
    atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Last Vest'), tab: 1, at: null });
    a.socket.emit({ t: 'guildDisband' });
    expect(systemLines(a.socket).at(-1)).toBe('Empty the guild stash first: it still holds 1 item');
    a.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(a.socket), 'Last Vest'), at: null });
    a.socket.emit({ t: 'guildDisband' });
    expect(guildInfo(a.socket)).toBeNull();
    expect(guildInfo(b.socket)).toBeNull();
    expect(stashView(a.socket)).toBeNull();
    // The name and tag are free again.
    player(w.rooms, b.socket).gold = 5000;
    b.socket.emit({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' });
    expect(guildInfo(b.socket)?.rank).toBe('leader');
  });
});

describe('leadership handover', () => {
  it('passes to the longest-serving Officer after 30 days without a login, else the longest-serving Member', async () => {
    const w = await world(4);
    found(w, [1, 2, 3]);
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => hero(w.heroes, i));
    if (!a || !b || !c || !d) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: c.accountId });
    a.socket.emit({ t: 'guildPromote', member: d.accountId });
    const guildId = guildInfo(a.socket)?.id ?? 0;
    // Hero3 has served longer than Hero2, though Hero2 joined the guild first in this test.
    w.raw.prepare('UPDATE guild_members SET joined_at = joined_at - 1000 WHERE account_id = ?').run(d.accountId);
    a.socket.close();
    expect(w.rooms.checkGuildLeadership()).toBe(0);
    w.advance(LEADER_IDLE_MS - 60_000);
    expect(w.rooms.checkGuildLeadership()).toBe(0);
    w.advance(120_000);
    expect(w.rooms.checkGuildLeadership()).toBe(1);
    expect(guildInfo(d.socket)?.rank).toBe('leader');
    const ranks = Object.fromEntries((guildInfo(b.socket)?.members ?? []).map((m) => [m.name, m.rank]));
    expect(ranks).toEqual({ Hero0: 'officer', Hero1: 'member', Hero2: 'officer', Hero3: 'leader' });
    expect(w.rooms.guildDetail(guildId, null)?.log[0]?.text).toMatch(/^Leadership passed to Hero3: Hero0 had not logged in for 30 days$/);
    // An online Leader is never idle, however old their last save.
    w.advance(LEADER_IDLE_MS * 2);
    expect(w.rooms.checkGuildLeadership()).toBe(0);
  });

  it('passes on when the Leader’s account is deleted, to a Member when there is no Officer', async () => {
    const w = await world(3);
    found(w, [1, 2]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    w.raw.prepare('UPDATE guild_members SET joined_at = joined_at - 1000 WHERE account_id = ?').run(c.accountId);
    a.socket.close();
    w.raw.prepare('DELETE FROM accounts WHERE id = ?').run(a.accountId);
    expect(w.rooms.checkGuildLeadership()).toBe(1);
    expect(guildInfo(c.socket)?.rank).toBe('leader');
    expect(guildInfo(b.socket)?.members.map((m) => [m.name, m.rank]).sort()).toEqual([
      ['Hero1', 'member'],
      ['Hero2', 'leader'],
    ]);
    expect(guildInfo(c.socket)?.members).toHaveLength(2);
  });

  it('leaves a guild with nobody else to lead it as it is, and an admin can name a Leader', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    const id = guildInfo(a.socket)?.id ?? 0;
    expect(w.rooms.setGuildLeader(id, b.accountId, 'test admin')).toBeNull();
    expect(guildInfo(b.socket)?.rank).toBe('leader');
    expect(guildInfo(a.socket)?.rank).toBe('officer');
    expect(w.rooms.setGuildLeader(id, 999_999, 'test admin')).toMatch(/^That account is not in the guild/);
    expect(w.rooms.setGuildLeader(999, b.accountId, 'test admin')).toBe('No such guild');
    expect(w.rooms.guildList()).toEqual([expect.objectContaining({ id, name: 'Iron Oath', tag: 'IRON', members: 2, leader: expect.objectContaining({ accountId: b.accountId, character: 'Hero1' }), tabs: 1, items: 0, stashReadable: true })]);
  });
});

describe('guild chat and tags', () => {
  it('sends /g to every member in any room and nobody else, and tags names in chat and on nameplates', async () => {
    const w = await world(3);
    found(w, [1]);
    const [a, b, c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !b || !c) throw new Error('heroes');
    b.socket.emit({ t: 'partyInvite', name: 'Hero2' });
    c.socket.emit({ t: 'partyAnswer', accept: true });
    b.socket.emit({ t: 'partyWorld' });
    a.socket.emit({ t: 'chat', text: '/g gather at the gate' });
    const line = b.socket.last('chat');
    expect(line).toMatchObject({ kind: 'guild', from: 'Hero0', tag: 'IRON', text: 'gather at the gate' });
    expect(c.socket.sent.some((m) => m.t === 'chat' && m.kind === 'guild' && m.text === 'gather at the gate')).toBe(false);
    c.socket.emit({ t: 'chat', text: '/g hello' });
    expect(systemLines(c.socket).at(-1)).toBe('You are not in a guild');
    b.socket.emit({ t: 'chat', text: '/p party line' });
    expect(c.socket.last('chat')).toMatchObject({ kind: 'party', from: 'Hero1', tag: 'IRON' });
    c.socket.emit({ t: 'chat', text: 'untagged' });
    const own = c.socket.last('chat');
    expect(own?.kind).toBe('game');
    expect(own?.tag).toBeUndefined();
    w.rooms.tick();
    const snap = a.socket.last('snapshot');
    const me = snap?.entities.find((e) => e.k === 'player' && e.name === 'Hero0');
    expect(me?.k === 'player' ? me.tag : undefined).toBe('IRON');
  });

  it('shows the roster with rank, class, level, online and zone', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    b.socket.close();
    a.socket.emit({ t: 'guildRefresh' });
    const roster = guildInfo(a.socket)?.members ?? [];
    expect(roster.map((m) => ({ name: m.name, rank: m.rank, cls: m.cls, level: m.level, online: m.online }))).toEqual([
      { name: 'Hero0', rank: 'leader', cls: 'warrior', level: 1, online: true },
      { name: 'Hero1', rank: 'member', cls: 'warrior', level: 1, online: false },
    ]);
    expect(roster[0]?.zone).not.toBe('');
    expect(roster[1]?.zone).toBe('');
  });
});

describe('stored guild stashes', () => {
  it('refuses the stash of a guild whose row cannot be read, and never writes over it', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const id = guildInfo(a.socket)?.id ?? 0;
    const damaged = JSON.stringify({ guildStashFormat: 1, runeFormat: 2, items: [{ uid: 1 }], tabs: [] });
    w.raw.prepare('UPDATE guilds SET stash_json = ? WHERE id = ?').run(damaged, id);
    a.socket.close();
    const rooms = new RoomManager(1, w.store);
    const s = new FakeSocket();
    rooms.connect(s);
    s.emit({ t: 'join', token: w.store.createSession(a.accountId), characterId: a.characterId });
    atChest(rooms, s);
    s.emit({ t: 'guildStashOpen' });
    expect(lastNotice(s)).toMatch(/could not be loaded/);
    s.emit({ t: 'guildDisband' });
    expect(systemLines(s).at(-1)).toMatch(/could not be loaded/);
    expect(rooms.guildList()[0]?.stashReadable).toBe(false);
    expect(w.raw.prepare('SELECT stash_json FROM guilds WHERE id = ?').get(id)).toEqual({ stash_json: damaged });
  });

  it('runs a row from before the six rune tiers through the rune roll pass once, and writes it back marked', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const id = guildInfo(a.socket)?.id ?? 0;
    const rune = { uid: 7, kind: 'rune', tier: 'magic', name: 'Bolt Rune of Speed', ilvl: 5, rune: 'bolt', count: 1, affixes: [{ id: 'rune_speed', tier: 2, value: 30 }] };
    const cells = Array.from({ length: 120 }, (_, i) => (i === 0 ? 7 : null));
    const old = { guildStashFormat: 1, runeFormat: 2, nextUid: 8, tabs: [{ id: 1, name: 'Tab 1', color: 'ash', cells, perms: { officer: { view: true, deposit: true, withdraw: true }, member: { view: true, deposit: true, withdraw: false } } }], items: [rune] };
    w.raw.prepare('UPDATE guilds SET stash_json = ? WHERE id = ?').run(JSON.stringify(old), id);
    a.socket.close();
    const rooms = new RoomManager(1, w.store);
    expect(rooms.guildList()[0]?.items).toBe(1);
    const row: unknown = w.raw.prepare('SELECT stash_json FROM guilds WHERE id = ?').get(id);
    const json = typeof row === 'object' && row !== null ? Reflect.get(row, 'stash_json') : undefined;
    const stored: unknown = typeof json === 'string' ? JSON.parse(json) : null;
    expect(stored).toMatchObject({ runeFormat: 2, runeTiers: 6, runeImplicits: 1, guildStashFormat: 1 });
    // The roll keeps its value; only the tier label can move.
    const items = typeof stored === 'object' && stored !== null ? Reflect.get(stored, 'items') : null;
    expect(Array.isArray(items) && items[0]?.affixes?.[0]?.value).toBe(30);
  });
});

describe('the admin Guilds routes', () => {
  it('show guilds, rosters and logs to every staff role, and let only the guilds permission name a Leader', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    const id = guildInfo(a.socket)?.id ?? 0;
    const staff: Record<string, string> = {};
    for (const [name, role] of [['amod', 'moderator'], ['anadmin', 'admin']] as const) {
      const acc = await w.store.register(name, 'password123');
      if (acc === 'taken') throw new Error('taken');
      w.store.setRole(acc.id, role);
      staff[name] = w.store.createSession(acc.id);
    }
    const api = new AccountApi(w.store, () => undefined, w.rooms, new Set(), { other: 100_000, token: 100_000 });
    const server = createServer((req, res) => {
      if (!api.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr: AddressInfo | string | null = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const call = (method: string, path: string, token: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const list = await call('GET', '/api/admin/guilds', staff.amod ?? '');
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([expect.objectContaining({ id, name: 'Iron Oath', tag: 'IRON', members: 2 })]);
      const detail = await call('GET', `/api/admin/guilds/${id}`, staff.amod ?? '');
      const body: unknown = await detail.json();
      expect(body).toMatchObject({ roster: [{ username: 'guilder0', rank: 'leader', character: 'Hero0', online: true }, { username: 'guilder1', rank: 'member' }], log: [{ kind: 'join' }, { kind: 'found' }], moreLog: false });
      expect((await call('GET', '/api/admin/guilds/999', staff.amod ?? '')).status).toBe(404);
      expect((await call('POST', `/api/admin/guilds/${id}/leader`, staff.amod ?? '', { accountId: b.accountId })).status).toBe(403);
      expect((await call('POST', `/api/admin/guilds/${id}/leader`, a.token, { accountId: b.accountId })).status).toBe(404);
      expect((await call('POST', `/api/admin/guilds/${id}/leader`, staff.anadmin ?? '', { accountId: 12345 })).status).toBe(409);
      expect((await call('POST', `/api/admin/guilds/${id}/leader`, staff.anadmin ?? '', { accountId: b.accountId })).status).toBe(200);
      expect(guildInfo(b.socket)?.rank).toBe('leader');
    } finally {
      server.close();
    }
  });

  it('gives a row from before rune implicits its implicits once, and writes it back marked', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const id = guildInfo(a.socket)?.id ?? 0;
    const stack = { uid: 3, kind: 'rune', tier: 'common', name: 'Bolt Rune', ilvl: 1, rune: 'bolt', count: 12, affixes: [] };
    const cells = Array.from({ length: 120 }, (_, i) => (i === 0 ? 3 : null));
    const old = { guildStashFormat: 1, runeFormat: 2, runeTiers: 6, nextUid: 4, tabs: [{ id: 1, name: 'Tab 1', color: 'ash', cells, perms: { officer: { view: true, deposit: true, withdraw: true }, member: { view: true, deposit: true, withdraw: false } } }], items: [stack] };
    w.raw.prepare('UPDATE guilds SET stash_json = ? WHERE id = ?').run(JSON.stringify(old), id);
    a.socket.close();
    const read = (): unknown => {
      const row: unknown = w.raw.prepare('SELECT stash_json FROM guilds WHERE id = ?').get(id);
      const json = typeof row === 'object' && row !== null ? Reflect.get(row, 'stash_json') : undefined;
      return typeof json === 'string' ? JSON.parse(json) : null;
    };
    new RoomManager(1, w.store);
    const first = read();
    expect(first).toMatchObject({ runeImplicits: 1, items: [{ uid: 3, rune: 'bolt', count: 12 }] });
    const items = typeof first === 'object' && first !== null ? Reflect.get(first, 'items') : null;
    expect(Array.isArray(items) && items[0]?.implicit).toBeTruthy();
    // A second boot loads the marked row exactly as stored.
    new RoomManager(1, w.store);
    expect(read()).toEqual(first);
  });
});

describe('after the independent review', () => {
  it('lets only the Leader set what Officers may do', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    atChest(w.rooms, a.socket);
    const pb = atChest(w.rooms, b.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Leader Vest'), tab: 1, at: null });
    a.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'officer', perms: { view: true, deposit: false, withdraw: false } });
    b.socket.emit({ t: 'guildStashOpen' });
    w.advance(2000);
    b.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'officer', perms: { view: true, deposit: true, withdraw: true } });
    expect(lastNotice(b.socket)).toBe('Only the Leader sets Officer permissions');
    b.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(b.socket), 'Leader Vest'), at: null });
    expect(bagHas(pb, 'Leader Vest')).toBe(false);
    // Officers still manage Members.
    b.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'member', perms: { view: true, deposit: true, withdraw: true } });
    expect(stashView(b.socket)?.tabs[0]?.perms?.member.withdraw).toBe(true);
  });

  it('drops an invite whose sender left or lost the power, after 2 minutes, or when the Leader cancels it', async () => {
    const w = await world(4);
    found(w, [1]);
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => hero(w.heroes, i));
    if (!a || !b || !c || !d) throw new Error('heroes');
    a.socket.emit({ t: 'guildPromote', member: b.accountId });
    b.socket.emit({ t: 'guildInvite', name: c.name });
    a.socket.emit({ t: 'guildKick', member: b.accountId });
    c.socket.emit({ t: 'guildAnswer', accept: true });
    expect(guildInfo(c.socket)).toBeNull();
    expect(systemLines(c.socket).at(-1)).toBe('That guild invite is no longer open');
    a.socket.emit({ t: 'guildInvite', name: c.name });
    expect(guildInfo(a.socket)?.invites?.map((i) => i.name)).toEqual(['Hero2']);
    w.advance(INVITE_MS);
    c.socket.emit({ t: 'guildAnswer', accept: true });
    expect(guildInfo(c.socket)).toBeNull();
    a.socket.emit({ t: 'guildInvite', name: d.name });
    a.socket.emit({ t: 'guildCancelInvite', member: d.accountId });
    expect(systemLines(d.socket).at(-1)).toBe('Your invite to Iron Oath was withdrawn');
    expect(guildInfo(a.socket)?.invites).toEqual([]);
    d.socket.emit({ t: 'guildAnswer', accept: true });
    expect(guildInfo(d.socket)).toBeNull();
    // An invite that is fresh and whose sender still may invite goes through.
    a.socket.emit({ t: 'guildInvite', name: c.name });
    w.advance(INVITE_MS - 1000);
    c.socket.emit({ t: 'guildAnswer', accept: true });
    expect(guildInfo(c.socket)?.rank).toBe('member');
  });

  it('sends viewers only the tabs a move changed, closes it for one who walked away, and logs moves inside a tab', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    const pa = atChest(w.rooms, a.socket);
    atChest(w.rooms, b.socket);
    pa.gold = 5000;
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildBuyTab' });
    b.socket.emit({ t: 'guildStashOpen' });
    const sent = b.socket.sent.length;
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Moved Vest'), tab: 1, at: { x: 0, y: 0 } });
    const updates = b.socket.sent.slice(sent).flatMap((m) => (m.t === 'guildStashTabs' ? [m.update.tabs.map((t) => String(t.id))] : m.t === 'guildStash' ? [['full']] : []));
    expect(updates).toEqual([['1']]);
    w.advance(2000);
    a.socket.emit({ t: 'guildMove', uid: uidIn(stashView(a.socket), 'Moved Vest'), tab: 1, at: { x: 4, y: 0 } });
    a.socket.emit({ t: 'guildLog', before: null });
    expect(a.socket.last('guildLog')?.entries[0]?.text).toBe('Hero0 moved Moved Vest (rare, item level 5) inside Tab 1');
    // Hero1 walks off: the next change closes their window instead of following them.
    roomOf(w.rooms, b.socket).pos.x += 2000;
    a.socket.emit({ t: 'guildMove', uid: uidIn(stashView(a.socket), 'Moved Vest'), tab: 2, at: { x: 0, y: 0 } });
    expect(b.socket.sent.at(-1)).toEqual({ t: 'guildStash', stash: null });
  });

  it('limits stash writes per guild as well as per member', async () => {
    const w = await world(5);
    found(w, [1, 2, 3, 4]);
    const heroes = [0, 1, 2, 3, 4].map((i) => hero(w.heroes, i));
    for (const h of heroes) atChest(w.rooms, h.socket);
    let busy = 0;
    for (const h of heroes) {
      for (let i = 0; i < 4; i++) h.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, h.socket, `${h.name} ${i}`, i + 1), tab: 1, at: null });
      if (lastNotice(h.socket) === 'The guild stash is busy; try again in a moment') busy++;
    }
    expect(busy).toBe(1);
    expect(w.rooms.guildList()[0]?.items).toBe(16);
  });

  it('answers a withdrawal or move from a tab the rank cannot see as if the item were not there', async () => {
    const w = await world(2);
    found(w, [1]);
    const [a, b] = [0, 1].map((i) => hero(w.heroes, i));
    if (!a || !b) throw new Error('heroes');
    atChest(w.rooms, a.socket);
    atChest(w.rooms, b.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Hidden'), tab: 1, at: null });
    const gid = uidIn(stashView(a.socket), 'Hidden');
    a.socket.emit({ t: 'guildTabPerms', tab: 1, rank: 'member', perms: { view: false, deposit: false, withdraw: false } });
    w.advance(2000);
    b.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(lastNotice(b.socket)).toBe('Someone else took it');
    b.socket.emit({ t: 'guildMove', uid: gid, tab: 1, at: { x: 5, y: 5 } });
    expect(lastNotice(b.socket)).toBe('Someone else took it');
    b.socket.emit({ t: 'guildWithdraw', uid: 999_999, at: null });
    expect(lastNotice(b.socket)).toBe('Someone else took it');
  });

  it('never reuses a disbanded guild id', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const first = guildInfo(a.socket)?.id ?? 0;
    a.socket.emit({ t: 'guildDisband' });
    player(w.rooms, a.socket).gold = 5000;
    a.socket.emit({ t: 'guildCreate', name: 'Second Oath', tag: 'TWO' });
    expect(guildInfo(a.socket)?.id).toBeGreaterThan(first);
  });

  it('lets an admin give a guild left with no members any account outside a guild as its Leader', async () => {
    const w = await world(3);
    found(w);
    const [a, , c] = [0, 1, 2].map((i) => hero(w.heroes, i));
    if (!a || !c) throw new Error('heroes');
    atChest(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    a.socket.emit({ t: 'guildDeposit', uid: giveGear(w.rooms, a.socket, 'Stranded Vest'), tab: 1, at: null });
    const id = guildInfo(a.socket)?.id ?? 0;
    a.socket.close();
    w.raw.prepare('DELETE FROM accounts WHERE id = ?').run(a.accountId);
    w.rooms.checkGuildLeadership();
    expect(w.rooms.guildList()[0]).toMatchObject({ members: 0, leader: null, items: 1 });
    expect(w.rooms.setGuildLeader(id, 999_999, 'test admin')).toBe('No such account');
    expect(w.rooms.setGuildLeader(id, c.accountId, 'test admin')).toBeNull();
    expect(guildInfo(c.socket)).toMatchObject({ rank: 'leader', name: 'Iron Oath' });
    const pc = atChest(w.rooms, c.socket);
    c.socket.emit({ t: 'guildStashOpen' });
    c.socket.emit({ t: 'guildWithdraw', uid: uidIn(stashView(c.socket), 'Stranded Vest'), at: null });
    expect(bagHas(pc, 'Stranded Vest')).toBe(true);
  });

  it('names the bag stacks a plain rune stack merged into in the server log', async () => {
    const w = await world(1);
    found(w);
    const a = hero(w.heroes, 0);
    const p = atChest(w.rooms, a.socket);
    const { room } = roomOf(w.rooms, a.socket);
    a.socket.emit({ t: 'guildStashOpen' });
    const first = createRune(room.sim.newItemUid(), 'nova', 3);
    if (!addItem(p, first)) throw new Error('full');
    a.socket.emit({ t: 'guildDeposit', uid: first.uid, tab: 1, at: null });
    const kept = createRune(room.sim.newItemUid(), 'nova', 5);
    if (!addItem(p, kept)) throw new Error('full');
    const gid = stashView(a.socket)?.items.find((i) => i.kind === 'rune')?.uid ?? -1;
    a.socket.emit({ t: 'guildWithdraw', uid: gid, at: null });
    expect(p.items.get(kept.uid)).toMatchObject({ count: 8 });
    const line = events.recent(5, (e) => e.text.includes('withdrawal from Iron Oath')).at(0)?.text ?? '';
    expect(line).toContain(`bag stack ${kept.uid} (+3)`);
  });
});

