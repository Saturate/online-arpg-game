import { describe, expect, it } from 'vitest';
import {
  applyTunables,
  canKick,
  cloneGuildStash,
  createGear,
  createRune,
  emptyGuildStash,
  GUILD,
  GUILD_RANKS,
  guildCan,
  guildNameProblem,
  guildPlace,
  guildStashView,
  guildTabPrice,
  guildTagProblem,
  guildTake,
  intoGuild,
  isChatMessage,
  newGuildTab,
  normalisePerms,
  parseClientMessage,
  parseGuildStash,
  Rng,
  serializeGuildStash,
  tabAccess,
  TUNABLES,
  unplacedGuildItems,
  type GuildPower,
  type GuildRank,
  type Item,
} from '../src/index.js';

const gear = (uid: number, name = 'Vest'): Item => ({ ...createGear(uid, new Rng(uid), 'rare', 5, { base: 'padded_vest' }), name });

describe('guild tags and names', () => {
  it('takes 2 to 5 letters or digits and refuses staff words in any case', () => {
    expect(guildTagProblem('IRON')).toBeNull();
    expect(guildTagProblem('a1')).toBeNull();
    expect(guildTagProblem('A')).toMatch(/2 to 5/);
    expect(guildTagProblem('SIXSIX')).toMatch(/2 to 5/);
    expect(guildTagProblem('I R')).toMatch(/letters or digits/);
    expect(guildTagProblem('<b>')).toMatch(/letters or digits/);
    expect(guildTagProblem(12)).toMatch(/2 to 5/);
    for (const t of ['GM', 'admin', 'Mod', 'STAFF', 'Dev']) expect(guildTagProblem(t)).toBe('That tag is reserved');
  });

  it('takes 3 to 24 characters starting with a letter, single spaces, and refuses reserved words in it', () => {
    expect(guildNameProblem('Iron Oath')).toBeNull();
    expect(guildNameProblem("Raven's Hold-2")).toBeNull();
    expect(guildNameProblem('Io')).toMatch(/3 to 24/);
    expect(guildNameProblem('1st Legion')).toMatch(/starting with a letter/);
    expect(guildNameProblem(' Iron')).toMatch(/3 to 24/);
    expect(guildNameProblem('Iron  Oath')).toMatch(/3 to 24/);
    expect(guildNameProblem('Iron​Oath')).toMatch(/3 to 24/);
    expect(guildNameProblem('The Staff Council')).toBe('That name is reserved');
    expect(guildNameProblem('Moderator-Guild')).toBe('That name is reserved');
    // A reserved word inside another word is fine.
    expect(guildNameProblem('Modest Few')).toBeNull();
  });
});

describe('rank powers', () => {
  it('gives the Leader everything, Officers invite, kick, tabs and the message of the day, Members nothing', () => {
    const powers: GuildPower[] = ['invite', 'kick', 'promote', 'demote', 'transfer', 'disband', 'manageTabs', 'motd'];
    const table = Object.fromEntries(GUILD_RANKS.map((r) => [r, powers.filter((p) => guildCan(r, p))]));
    expect(table).toEqual({
      leader: powers,
      officer: ['invite', 'kick', 'manageTabs', 'motd'],
      member: [],
    });
  });

  it('lets a kicker remove only ranks below their own', () => {
    const pairs: [GuildRank, GuildRank, boolean][] = [
      ['leader', 'officer', true],
      ['leader', 'member', true],
      ['leader', 'leader', false],
      ['officer', 'member', true],
      ['officer', 'officer', false],
      ['officer', 'leader', false],
      ['member', 'member', false],
    ];
    for (const [a, t, ok] of pairs) expect([a, t, canKick(a, t)]).toEqual([a, t, ok]);
  });
});

describe('tab permissions', () => {
  it('starts Officers on everything and Members on view and deposit; the Leader always has all', () => {
    const tab = newGuildTab(1);
    expect(tabAccess(tab, 'officer')).toEqual({ view: true, deposit: true, withdraw: true });
    expect(tabAccess(tab, 'member')).toEqual({ view: true, deposit: true, withdraw: false });
    tab.perms.officer = { view: false, deposit: false, withdraw: false };
    expect(tabAccess(tab, 'leader')).toEqual({ view: true, deposit: true, withdraw: true });
  });

  it('makes deposit and withdraw imply view', () => {
    expect(normalisePerms({ view: false, deposit: true, withdraw: false })).toEqual({ view: true, deposit: true, withdraw: false });
    expect(normalisePerms({ view: false, deposit: false, withdraw: true })).toEqual({ view: true, deposit: false, withdraw: true });
    expect(normalisePerms({ view: false, deposit: false, withdraw: false })).toEqual({ view: false, deposit: false, withdraw: false });
  });

  it('shows a rank only the tabs it may view, items included, and every rank’s settings only to tab managers', () => {
    const s = emptyGuildStash();
    s.tabs.push(newGuildTab(2));
    const hidden = s.tabs[1];
    if (!hidden) throw new Error('no tab');
    hidden.perms.member = { view: false, deposit: false, withdraw: false };
    expect(guildPlace(s, 1, intoGuild(s, gear(50, 'Open')), null)).toBeNull();
    expect(guildPlace(s, 2, intoGuild(s, gear(51, 'Secret')), null)).toBeNull();
    const member = guildStashView(s, 'member', 500);
    expect(member.items.map((i) => i.name)).toEqual(['Open']);
    expect(member.tabs.map((t) => t.cells === null)).toEqual([false, true]);
    expect(member.tabs[0]?.perms).toBeUndefined();
    const officer = guildStashView(s, 'officer', 500);
    expect(officer.items.map((i) => i.name).sort()).toEqual(['Open', 'Secret']);
    expect(officer.tabs[1]?.perms?.member).toEqual({ view: false, deposit: false, withdraw: false });
    expect(officer.tabPrice).toBe(500);
  });
});

describe('guild stash moves', () => {
  it('gives incoming items guild uids, refuses overlaps, and takes items out whole', () => {
    const s = emptyGuildStash();
    const a = intoGuild(s, gear(9000, 'A'));
    expect(a.uid).toBe(1);
    expect(guildPlace(s, 1, a, { x: 0, y: 0 })).toBeNull();
    const b = intoGuild(s, gear(9001, 'B'));
    expect(guildPlace(s, 1, b, { x: 1, y: 1 })).toBe('No room there');
    expect(guildPlace(s, 1, b, { x: 2, y: 0 })).toBeNull();
    expect(guildPlace(s, 7, b, null)).toBe('No such guild tab');
    // Moving an item onto cells it covers itself is fine.
    expect(guildPlace(s, 1, a, { x: 0, y: 1 })).toBeNull();
    expect(s.tabs[0]?.cells.filter((c) => c === a.uid)).toHaveLength(6);
    expect(guildTake(s, a.uid)?.name).toBe('A');
    expect(guildTake(s, a.uid)).toBeNull();
    expect(s.tabs[0]?.cells.includes(a.uid)).toBe(false);
  });

  it('gives a clone its own tabs and item map', () => {
    const s = emptyGuildStash();
    guildPlace(s, 1, intoGuild(s, gear(1)), null);
    const next = cloneGuildStash(s);
    guildTake(next, 1);
    const tab = next.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.cells.fill(null);
    tab.perms.member.withdraw = true;
    expect(s.items.size).toBe(1);
    expect(s.tabs[0]?.cells.includes(1)).toBe(true);
    expect(s.tabs[0]?.perms.member.withdraw).toBe(false);
  });

  it('fills the full grid and refuses the next item', () => {
    const s = emptyGuildStash();
    for (let i = 0; i < 120; i++) expect(guildPlace(s, 1, intoGuild(s, createRune(i + 1, 'bolt', 20)), null)).toBeNull();
    expect(guildPlace(s, 1, intoGuild(s, createRune(999, 'fire', 1)), null)).toBe('No room in that guild tab');
  });
});

describe('stored guild stashes', () => {
  it('round-trips through JSON with the item format markers', () => {
    const s = emptyGuildStash();
    guildPlace(s, 1, intoGuild(s, gear(5)), { x: 3, y: 2 });
    const save = serializeGuildStash(s);
    expect(save).toMatchObject({ guildStashFormat: 1, runeFormat: 2, runeTiers: 6 });
    const back = parseGuildStash(JSON.parse(JSON.stringify(save)));
    expect(back.converted).toBe(false);
    expect(serializeGuildStash(back.stash)).toEqual(save);
  });

  it('throws on a damaged row rather than loading it with items missing', () => {
    const save = serializeGuildStash(emptyGuildStash());
    expect(() => parseGuildStash(null)).toThrow();
    expect(() => parseGuildStash({ ...save, guildStashFormat: 2 })).toThrow(/format/);
    expect(() => parseGuildStash({ ...save, runeFormat: 1 })).toThrow(/rune format/);
    expect(() => parseGuildStash({ ...save, items: [{ uid: 1 }] })).toThrow(/damaged/);
    expect(() => parseGuildStash({ ...save, items: [gear(1), gear(1)] })).toThrow(/twice/);
    expect(() => parseGuildStash({ ...save, tabs: [] })).toThrow(/no tabs/);
    expect(() => parseGuildStash({ ...save, tabs: [{ ...save.tabs[0], perms: null }] })).toThrow(/permissions/);
  });

  it('puts an item named in two places in one, keeps items whose cell is gone, and never reuses a uid', () => {
    const save = serializeGuildStash(emptyGuildStash());
    const tab = save.tabs[0];
    if (!tab) throw new Error('no tab');
    const cells = [...tab.cells];
    cells[0] = 3;
    cells[5] = 3;
    const second = { ...newGuildTab(2), cells: cells.map((c, i) => (i === 0 ? 3 : null)) };
    const rune = createRune(3, 'bolt', 4);
    const lost = createRune(4, 'fire', 2);
    const loaded = parseGuildStash({ ...save, nextUid: 1, tabs: [{ ...tab, cells }, second], items: [rune, lost] });
    const where = loaded.stash.tabs.flatMap((t) => t.cells.flatMap((c) => (c === null ? [] : [`${t.id}:${c}`])));
    expect(where.filter((w) => w.endsWith(':3'))).toEqual(['1:3']);
    // The item no cell named is laid into the first free spot instead of vanishing.
    expect(where).toContain('1:4');
    expect(unplacedGuildItems(loaded.stash)).toEqual([]);
    expect(loaded.stash.nextUid).toBe(5);
  });

  it('runs a row from before the six rune tiers through the rune roll pass, keeping every roll value', () => {
    const save = serializeGuildStash(emptyGuildStash());
    const tab = save.tabs[0];
    if (!tab) throw new Error('no tab');
    const rolled = { ...createRune(1, 'bolt', 1), name: 'Bolt Rune of Speed', tier: 'magic' as const, affixes: [{ id: 'rune_speed' as const, tier: 0, value: 30 }] };
    const cells = tab.cells.map((c, i) => (i === 0 ? 1 : c));
    const loaded = parseGuildStash({ guildStashFormat: 1, runeFormat: 2, nextUid: 2, tabs: [{ ...tab, cells }], items: [rolled] });
    expect(loaded.converted).toBe(true);
    const back = loaded.stash.items.get(1);
    expect(back?.affixes[0]?.value).toBe(30);
    expect(serializeGuildStash(loaded.stash).runeTiers).toBe(6);
    expect(parseGuildStash(JSON.parse(JSON.stringify(serializeGuildStash(loaded.stash)))).converted).toBe(false);
  });
});

describe('guild prices are live tuning numbers', () => {
  it('lists founding, the tab cap and both tab prices, and a change reaches the price rules', () => {
    const paths = TUNABLES.filter((t) => t.category === 'guilds').map((t) => [t.path, t.default]);
    expect(paths).toEqual([
      ['guild.foundPrice', 1000],
      ['guild.maxTabs', 10],
      ['guild.firstTabPrice', 500],
      ['guild.tabPriceStep', 500],
    ]);
    expect(guildTabPrice(1)).toBe(500);
    expect(guildTabPrice(3)).toBe(1500);
    expect(guildTabPrice(10)).toBeNull();
    try {
      applyTunables({ 'guild.foundPrice': 250, 'guild.maxTabs': 4, 'guild.tabPriceStep': 100 });
      expect(GUILD.foundPrice).toBe(250);
      expect(guildTabPrice(3)).toBe(700);
      expect(guildTabPrice(4)).toBeNull();
    } finally {
      applyTunables({});
    }
    expect(GUILD.foundPrice).toBe(1000);
  });
});

describe('guild messages on the wire', () => {
  it('reads every guild request and refuses bad shapes', () => {
    expect(parseClientMessage({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' })).toEqual({ t: 'guildCreate', name: 'Iron Oath', tag: 'IRON' });
    expect(parseClientMessage({ t: 'guildCreate', name: 'x'.repeat(25), tag: 'IRON' })).toBeNull();
    expect(parseClientMessage({ t: 'guildKick', member: 3 })).toEqual({ t: 'guildKick', member: 3 });
    expect(parseClientMessage({ t: 'guildKick', member: -1 })).toBeNull();
    expect(parseClientMessage({ t: 'guildDeposit', uid: 4, tab: 1, at: null })).toEqual({ t: 'guildDeposit', uid: 4, tab: 1, at: null });
    expect(parseClientMessage({ t: 'guildDeposit', uid: 4, tab: 1, at: { x: 12, y: 0 } })).toBeNull();
    expect(parseClientMessage({ t: 'guildDeposit', uid: 4, tab: 21, at: null })).toBeNull();
    expect(parseClientMessage({ t: 'guildDeposit', uid: 4, tab: 1 })).toBeNull();
    expect(parseClientMessage({ t: 'guildWithdraw', uid: 4, at: { x: 11, y: 7 } })).toEqual({ t: 'guildWithdraw', uid: 4, at: { x: 11, y: 7 } });
    expect(parseClientMessage({ t: 'guildWithdraw', uid: 4, at: { x: 11, y: 8 } })).toBeNull();
    expect(parseClientMessage({ t: 'guildMove', uid: 4, tab: 2, at: null })).toBeNull();
    expect(parseClientMessage({ t: 'guildTabPerms', tab: 1, rank: 'leader', perms: { view: true, deposit: true, withdraw: true } })).toBeNull();
    expect(parseClientMessage({ t: 'guildTabPerms', tab: 1, rank: 'member', perms: { view: true, deposit: 1, withdraw: true } })).toBeNull();
    expect(parseClientMessage({ t: 'guildEditTab', tab: 1, name: '<script>', color: 'rust' })).toBeNull();
    expect(parseClientMessage({ t: 'guildLog', before: null })).toEqual({ t: 'guildLog', before: null });
    expect(parseClientMessage({ t: 'guildMotd', text: 'x'.repeat(1001) })).toBeNull();
  });

  it('accepts guild chat lines with a tag and refuses an oversized tag', () => {
    expect(isChatMessage({ t: 'chat', kind: 'guild', from: 'Hero', to: null, text: 'hi', tag: 'IRON' })).toBe(true);
    expect(isChatMessage({ t: 'chat', kind: 'game', from: 'Hero', to: null, text: 'hi', tag: 'TOOLONG' })).toBe(false);
  });
});
