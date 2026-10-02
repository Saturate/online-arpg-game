import { describe, expect, it } from 'vitest';
import { createGear, emptyGuildStash, guildPlace, guildStashTabsView, guildStashView, intoGuild, newGuildTab, Rng, type GearItem, type GuildInfo, type GuildStash } from '@rune/shared';
import { canEditPermRow, depositPrompt } from '../src/ui/guildStashView.js';
import { EMPTY_GUILD_LOG, INVITE_LAPSE_MS, pendingInvites, receiveGuild, type GuildSlice } from '../src/ui/guildView.js';

const rng = new Rng(11);
let nextUid = 900;
function ring(tier: 'magic' | 'rare' = 'magic'): GearItem {
  return createGear(nextUid++, rng, tier, 5, { category: 'ring' });
}

/** Tabs 1 and 2 with a ring in each, and tab 3 that Members may only deposit into. */
function stash(): { s: GuildStash; a: GearItem; b: GearItem } {
  const s = emptyGuildStash();
  s.tabs.push(newGuildTab(2), newGuildTab(3));
  const t3 = s.tabs[2];
  if (t3) t3.perms.member = { view: true, deposit: true, withdraw: false };
  const a = intoGuild(s, ring());
  const b = intoGuild(s, ring());
  guildPlace(s, 1, a, { x: 0, y: 0 });
  guildPlace(s, 2, b, { x: 0, y: 0 });
  return { s, a, b };
}

const base: GuildSlice = { guild: null, guildFoundPrice: 0, guildInvite: null, guildLog: EMPTY_GUILD_LOG, guildStash: null };

describe('partial guild stash updates in the store', () => {
  it('replaces only the changed tabs and moves items with them', () => {
    const { s, a, b } = stash();
    const before = guildStashView(s, 'officer', 500);
    // Ring a moves from tab 1 to tab 2.
    guildPlace(s, 2, a, { x: 3, y: 3 });
    const update = guildStashTabsView(s, 'officer', [1, 2], 500);
    const next = receiveGuild({ ...base, guildStash: before }, { t: 'guildStashTabs', update }).guildStash;
    if (!next) throw new Error('no view');
    expect(next.tabs.find((t) => t.id === 1)?.cells?.includes(a.uid)).toBe(false);
    expect(next.tabs.find((t) => t.id === 2)?.cells?.includes(a.uid)).toBe(true);
    // Tab 3 was not in the update and is the very same object.
    expect(next.tabs.find((t) => t.id === 3)).toBe(before.tabs.find((t) => t.id === 3));
    expect(next.items.map((i) => i.uid).sort()).toEqual([a.uid, b.uid].sort());
  });

  it('drops an item withdrawn from a replaced tab', () => {
    const { s, a, b } = stash();
    const before = guildStashView(s, 'officer', 500);
    const t1 = s.tabs[0];
    if (t1) t1.cells = t1.cells.map((c) => (c === a.uid ? null : c));
    s.items.delete(a.uid);
    const next = receiveGuild({ ...base, guildStash: before }, { t: 'guildStashTabs', update: guildStashTabsView(s, 'officer', [1], 500) }).guildStash;
    expect(next?.items.map((i) => i.uid)).toEqual([b.uid]);
  });

  it('ignores a partial update when no guild stash is open', () => {
    const { s } = stash();
    expect(receiveGuild(base, { t: 'guildStashTabs', update: guildStashTabsView(s, 'officer', [1], 500) })).toEqual({});
  });
});

describe('deposits that ask first', () => {
  const { s } = stash();
  const member = guildStashView(s, 'member', 500);
  const deposit = (tab: number, item: GearItem) => ({ send: { t: 'guildDeposit' as const, uid: item.uid, tab, at: null } });

  it('asks for any deposit into a tab the rank cannot take back from, dragged or clicked', () => {
    const item = ring();
    expect(depositPrompt(member, deposit(3, item), item, 'drag', false)).toBe('You cannot take this back out of Tab 3.');
    expect(depositPrompt(member, deposit(3, item), item, 'quick', false)).toBe('You cannot take this back out of Tab 3.');
  });

  it('asks for a quick deposit of a rare only with the Settings prompt on', () => {
    const officer = guildStashView(s, 'officer', 500);
    const rare = ring('rare');
    expect(depositPrompt(officer, deposit(1, rare), rare, 'quick', true)).toBe('Put it into Tab 1 for the guild?');
    expect(depositPrompt(officer, deposit(1, rare), rare, 'quick', false)).toBeNull();
    expect(depositPrompt(officer, deposit(1, rare), rare, 'drag', true)).toBeNull();
    const plain = ring();
    expect(depositPrompt(officer, deposit(1, plain), plain, 'quick', true)).toBeNull();
  });

  it('never asks for a move, a withdrawal or a refusal', () => {
    const item = ring();
    expect(depositPrompt(member, { send: { t: 'guildWithdraw', uid: item.uid, at: null } }, item, 'quick', true)).toBeNull();
    expect(depositPrompt(member, { refuse: 'No room there' }, item, 'drag', true)).toBeNull();
    expect(depositPrompt(member, null, item, 'drag', true)).toBeNull();
  });
});

describe('permission rows', () => {
  it('lets only the Leader change the Officer row; Officers still set the Member row', () => {
    expect(canEditPermRow('leader', 'officer')).toBe(true);
    expect(canEditPermRow('leader', 'member')).toBe(true);
    expect(canEditPermRow('officer', 'officer')).toBe(false);
    expect(canEditPermRow('officer', 'member')).toBe(true);
    expect(canEditPermRow('member', 'member')).toBe(false);
  });
});

describe('pending invites', () => {
  const g = (rank: GuildInfo['rank'], at: number): GuildInfo => ({ id: 1, name: 'Ashen Watch', tag: 'ASH', motd: '', rank, members: [], maxMembers: 50, createdAt: 0, invites: [{ id: 5, name: 'Pal', at }] });

  it('shows open invites to the Leader only, and hides lapsed ones', () => {
    const now = 1_000_000;
    expect(pendingInvites(g('leader', now - 1000), now).map((i) => i.name)).toEqual(['Pal']);
    expect(pendingInvites(g('officer', now - 1000), now)).toEqual([]);
    expect(pendingInvites(g('leader', now - INVITE_LAPSE_MS), now)).toEqual([]);
  });
});
