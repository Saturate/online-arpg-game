import { describe, expect, it } from 'vitest';
import { createGear, emptyGuildStash, guildPlace, guildStashView, intoGuild, newGuildTab, Rng, type GearItem, type GuildRank, type GuildStash } from '@rune/shared';
import { accessText, currentGuildTab, guildDropAction, guildItemHint, guildQuickAction, involvesGuild, togglePerm } from '../src/ui/guildStashView.js';
import { parseDrag, type DragPayload } from '../src/ui/itemActions.js';

const rng = new Rng(7);
let nextUid = 500;
function ring(bound = false): GearItem {
  const g = createGear(nextUid++, rng, 'magic', 5, { category: 'ring' });
  return bound ? { ...g, bound: true } : g;
}

/** A guild stash with tab 1 (Members may see and deposit), and tab 2 closed to Members. */
function stash(): { s: GuildStash; held: GearItem } {
  const s = emptyGuildStash();
  const second = newGuildTab(2);
  second.perms.member = { view: false, deposit: false, withdraw: false };
  s.tabs.push(second);
  const held = intoGuild(s, ring());
  if (guildPlace(s, 1, held, { x: 0, y: 0 }) !== null) throw new Error('no room');
  return { s, held };
}

const view = (rank: GuildRank) => {
  const { s, held } = stash();
  return { v: guildStashView(s, rank, 500), held };
};

const fromBag = (uid: number): DragPayload => ({ uid, from: { at: 'bag', x: 0, y: 0 }, grab: { x: 0, y: 0 } });

describe('guild stash drops', () => {
  it('deposits a bag item on the cell it is dropped on, keeping the grip', () => {
    const { v } = view('member');
    const item = ring();
    const drag: DragPayload = { uid: item.uid, from: { at: 'bag', x: 3, y: 1 }, grab: { x: 0, y: 1 } };
    expect(guildDropAction(v, item, drag, { at: 'guild', tab: 1, x: 4, y: 4 })).toEqual({ send: { t: 'guildDeposit', uid: item.uid, tab: 1, at: { x: 4, y: 3 } } });
    expect(guildDropAction(v, item, drag, { at: 'guildTab', tab: 1 })).toEqual({ send: { t: 'guildDeposit', uid: item.uid, tab: 1, at: null } });
  });

  it('refuses bound items and tabs the rank cannot put into, with the server words', () => {
    const { v } = view('member');
    const bound = ring(true);
    expect(guildDropAction(v, bound, fromBag(bound.uid), { at: 'guildTab', tab: 1 })).toEqual({ refuse: 'Bound items stay with this character' });
    const item = ring();
    expect(guildDropAction(v, item, fromBag(item.uid), { at: 'guildTab', tab: 2 })).toEqual({ refuse: 'Your rank cannot put items into Tab 2' });
  });

  it('withdraws only where the rank may take, to the bag cell under the drop', () => {
    const member = view('member');
    const drag: DragPayload = { uid: member.held.uid, from: { at: 'guild', tab: 1, x: 0, y: 0 }, grab: { x: 0, y: 0 } };
    expect(guildDropAction(member.v, member.held, drag, { at: 'bag', x: 2, y: 1 })).toEqual({ refuse: 'Your rank cannot take items from Tab 1' });
    const officer = view('officer');
    expect(guildDropAction(officer.v, officer.held, drag, { at: 'bag', x: 2, y: 1 })).toEqual({ send: { t: 'guildWithdraw', uid: officer.held.uid, at: { x: 2, y: 1 } } });
    // Guild items never go straight onto a gear slot or the account stash.
    expect(guildDropAction(officer.v, officer.held, drag, { at: 'gear', slot: 'ring1' })).toEqual({ refuse: 'Guild items go to your bag first' });
  });

  it('moves inside the guild stash: same tab needs deposit, another tab needs withdraw too', () => {
    const member = view('member');
    const drag: DragPayload = { uid: member.held.uid, from: { at: 'guild', tab: 1, x: 0, y: 0 }, grab: { x: 0, y: 0 } };
    expect(guildDropAction(member.v, member.held, drag, { at: 'guild', tab: 1, x: 5, y: 5 })).toEqual({ send: { t: 'guildMove', uid: member.held.uid, tab: 1, at: { x: 5, y: 5 } } });
    expect(guildDropAction(member.v, member.held, drag, { at: 'guild', tab: 1, x: 0, y: 0 })).toBeNull();
    const officer = view('officer');
    expect(guildDropAction(officer.v, officer.held, drag, { at: 'guildTab', tab: 2 })).toEqual({ send: { t: 'guildMove', uid: officer.held.uid, tab: 2, at: { x: 0, y: 0 } } });
  });

  it('leaves the account stash rules alone and keeps them out of guild drops', () => {
    const { v } = view('leader');
    const item = ring();
    expect(guildDropAction(v, item, fromBag(item.uid), { at: 'stash', tab: 1, x: 0, y: 0 })).toBeNull();
    expect(involvesGuild(fromBag(item.uid), { at: 'guild', tab: 1, x: 0, y: 0 })).toBe(true);
    expect(involvesGuild(fromBag(item.uid), { at: 'bag', x: 0, y: 0 })).toBe(false);
    // The drag payload of a guild cell survives the browser round trip.
    expect(parseDrag(JSON.stringify({ uid: 3, from: { at: 'guild', tab: 2, x: 1, y: 4 }, grab: { x: 0, y: 0 } }))?.from).toEqual({ at: 'guild', tab: 2, x: 1, y: 4 });
  });
});

describe('guild stash quick clicks', () => {
  it('sends a bag item into the open guild tab, and a guild item to the bag', () => {
    const { v, held } = view('officer');
    const item = ring();
    expect(guildQuickAction(v, 1, 'stash', item, { at: 'bag', x: 0, y: 0 })).toEqual({ send: { t: 'guildDeposit', uid: item.uid, tab: 1, at: null } });
    expect(guildQuickAction(v, 1, 'stash', held, { at: 'guild', tab: 1, x: 0, y: 0 })).toEqual({ send: { t: 'guildWithdraw', uid: held.uid, at: null } });
  });

  it('does nothing away from the stash or while the account side shows', () => {
    const { v } = view('officer');
    const item = ring();
    expect(guildQuickAction(v, 1, 'trader', item, { at: 'bag', x: 0, y: 0 })).toBeNull();
    expect(guildQuickAction(v, null, 'stash', item, { at: 'bag', x: 0, y: 0 })).toBeNull();
  });

  it('refuses rather than falls through to the account stash while the guild stash is on its way', () => {
    expect(guildQuickAction(null, 1, 'stash', ring(), { at: 'bag', x: 0, y: 0 })).toEqual({ refuse: 'The guild stash is still opening' });
  });
});

describe('guild tab access', () => {
  it('shows a locked tab to a rank without view, and no items from it', () => {
    const { v } = view('member');
    const second = v.tabs.find((t) => t.id === 2);
    expect(second?.cells).toBeNull();
    expect(second && accessText(second.access)).toBe('Locked: your rank cannot see inside');
    expect(v.tabs[0]?.perms).toBeUndefined();
    expect(view('officer').v.tabs[0]?.perms).toBeDefined();
    expect(currentGuildTab(v, 99)?.id).toBe(1);
  });

  it('reads each access line', () => {
    expect(accessText({ view: true, deposit: true, withdraw: false })).toBe('You can put in, not take out');
    expect(accessText({ view: true, deposit: true, withdraw: true })).toBe('You can put in and take out');
    expect(accessText({ view: true, deposit: false, withdraw: false })).toBe('You can look, not put in or take out');
  });

  it('keeps deposit and withdraw implying view', () => {
    const none = { view: false, deposit: false, withdraw: false };
    expect(togglePerm(none, 'withdraw', true)).toEqual({ view: true, deposit: false, withdraw: true });
    expect(togglePerm({ view: true, deposit: true, withdraw: true }, 'view', false)).toEqual(none);
    expect(togglePerm({ view: true, deposit: true, withdraw: false }, 'deposit', false)).toEqual({ view: true, deposit: false, withdraw: false });
  });

  it('tells a viewer who cannot take so in the tooltip', () => {
    const member = view('member').v;
    expect(guildItemHint(member, 1, 'Ctrl')).toBe('Your rank can look but not take from this tab');
    expect(guildItemHint(view('leader').v, 1, 'Ctrl')).toBe('Ctrl+click to take it out · Drag to move');
  });
});
