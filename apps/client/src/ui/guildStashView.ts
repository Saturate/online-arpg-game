import { canPlace, findSpot, guildCan, type GuildRank, itemSize, STASH, stashRefuses, type ClientMessage, type GuildStashView, type GuildTabView, type InventoryMessage, type Item, type ItemUid, type ManagedRank, type TabPerms } from '@rune/shared';
import type { DragPayload, ItemPlace } from './itemActions.js';
import type { ItemStation } from './stations.js';

/**
 * The guild side of the stash window, as pure rules: what a drag, a drop or a quick click between
 * the bag and the guild stash sends, and how each tab's access reads. Every check mirrors the
 * server's (apps/server/src/guilds.ts), so the drop highlight only lights where the server will
 * agree. Guild items carry the guild's own uids, which can equal a bag item's, so a place always
 * says which side an item is on.
 */

export function guildTabOf(view: GuildStashView, id: number): GuildTabView | undefined {
  return view.tabs.find((t) => t.id === id);
}

/** The tab to show: the one asked for while it still exists, else the first the viewer may see inside, else the first. */
export function currentGuildTab(view: GuildStashView, wanted: number): GuildTabView | undefined {
  return guildTabOf(view, wanted) ?? view.tabs.find((t) => t.cells !== null) ?? view.tabs[0];
}

export function guildItem(view: GuildStashView | null, uid: ItemUid): Item | undefined {
  return view?.items.find((i) => i.uid === uid);
}

/**
 * The item a drag carries, from the side it left: guild uids are the guild's own and can equal a
 * bag item's, so the place decides which list to look in, never the uid alone.
 */
export function draggedItem(drag: DragPayload, inv: InventoryMessage | null, view: GuildStashView | null): Item | undefined {
  return drag.from.at === 'guild' ? guildItem(view, drag.uid) : inv?.items.find((i) => i.uid === drag.uid);
}

/** Whether the item being dragged is the one in this cell: the same uid on the same side. */
export function isDraggedHere(drag: DragPayload | null, place: ItemPlace, uid: ItemUid | undefined): boolean {
  return drag !== null && uid !== undefined && drag.uid === uid && (drag.from.at === 'guild') === (place.at === 'guild');
}

/** The tab holding a guild item, by its cells. */
export function guildTabHolding(view: GuildStashView, uid: ItemUid): GuildTabView | undefined {
  return view.tabs.find((t) => t.cells?.includes(uid) ?? false);
}

/** What a drop or quick click does: a message to send, a reason it cannot, or nothing to do. */
export type GuildAction = { send: ClientMessage } | { refuse: string } | null;

function cannotPut(tab: GuildTabView): string {
  return `Your rank cannot put items into ${tab.name}`;
}

function cannotTake(tab: GuildTabView): string {
  return `Your rank cannot take items from ${tab.name}`;
}

const NO_ROOM_THERE = 'No room there';
const NO_ROOM_TAB = 'No room in that guild tab';

/** The server's own room check (guildPlace): the corner must fit, or the tab must have a spot. */
function fits(tab: GuildTabView, item: Item, at: { x: number; y: number } | null, self: ItemUid | null): boolean {
  if (!tab.cells) return false;
  const size = itemSize(item);
  return at ? canPlace(tab.cells, STASH, size, at.x, at.y, self) : findSpot(tab.cells, STASH, size) !== null;
}

function deposit(item: Item, tab: GuildTabView, at: { x: number; y: number } | null): GuildAction {
  if (!tab.access.deposit) return { refuse: cannotPut(tab) };
  const refused = stashRefuses(item);
  if (refused) return { refuse: refused };
  if (!fits(tab, item, at, null)) return { refuse: at ? NO_ROOM_THERE : NO_ROOM_TAB };
  return { send: { t: 'guildDeposit', uid: item.uid, tab: tab.id, at } };
}

/**
 * Dropping `drag` (carrying `item`) onto `target`, when either end is the guild stash; null when
 * neither is, so the account stash rules apply. Cells are top-left corners after the grab offset,
 * as the account stash does it.
 */
export function guildDropAction(view: GuildStashView | null, item: Item, drag: DragPayload, target: ItemPlace): GuildAction {
  const from = drag.from;
  const toGuild = target.at === 'guild' || target.at === 'guildTab';
  if (from.at !== 'guild' && !toGuild) return null;
  if (!view) return { refuse: 'The guild stash is closed' };
  const corner = (x: number, y: number): { x: number; y: number } | null => {
    const grab = from.at === 'bag' || from.at === 'guild' ? drag.grab : { x: 0, y: 0 };
    const cx = x - grab.x;
    const cy = y - grab.y;
    return cx < 0 || cy < 0 ? null : { x: cx, y: cy };
  };
  if (toGuild) {
    const tab = guildTabOf(view, target.tab);
    if (!tab) return { refuse: 'No such guild tab' };
    if (from.at === 'bag') {
      if (target.at === 'guildTab') return deposit(item, tab, null);
      const at = corner(target.x, target.y);
      return at ? deposit(item, tab, at) : null;
    }
    if (from.at !== 'guild') return { refuse: 'Only items in your bag go into the guild stash' };
    const source = guildTabOf(view, from.tab);
    if (!source) return null;
    if (source.id !== tab.id && !source.access.withdraw) return { refuse: cannotTake(source) };
    if (!tab.access.deposit) return { refuse: cannotPut(tab) };
    if (target.at === 'guildTab') {
      if (source.id === tab.id || !tab.cells) return null;
      const spot = findSpot(tab.cells, STASH, itemSize(item));
      return spot ? { send: { t: 'guildMove', uid: item.uid, tab: tab.id, at: spot } } : { refuse: NO_ROOM_TAB };
    }
    const at = corner(target.x, target.y);
    if (!at || (source.id === tab.id && at.x === from.x && at.y === from.y)) return null;
    // Inside one tab the item's own cells count as free, as the server's move does.
    if (!fits(tab, item, at, source.id === tab.id ? item.uid : null)) return { refuse: NO_ROOM_THERE };
    return { send: { t: 'guildMove', uid: item.uid, tab: tab.id, at } };
  }
  // From the guild stash to anywhere else: only the bag takes it.
  if (from.at !== 'guild') return null;
  const source = guildTabOf(view, from.tab);
  if (!source) return null;
  if (!source.access.withdraw) return { refuse: cannotTake(source) };
  if (target.at !== 'bag') return { refuse: 'Guild items go to your bag first' };
  if (target.x === undefined || target.y === undefined) return { send: { t: 'guildWithdraw', uid: item.uid, at: null } };
  const at = corner(target.x, target.y);
  return at ? { send: { t: 'guildWithdraw', uid: item.uid, at } } : null;
}

/**
 * Ctrl/Cmd+click or right-click with the guild stash on screen: a bag item goes into the open
 * guild tab wherever it fits, a guild item to the bag wherever it fits. `openTab` is the guild tab
 * shown, or null while the window shows the account stash. Null when the click is not the guild
 * stash's to handle; a refusal while the guild stash is still on its way, so a bag click never
 * falls through to the account stash behind it.
 */
export function guildQuickAction(view: GuildStashView | null, openTab: number | null, station: ItemStation | null, item: Item, place: ItemPlace): GuildAction {
  if (station !== 'stash') return null;
  if (place.at === 'guild') {
    const tab = view ? guildTabOf(view, place.tab) : undefined;
    if (!tab) return null;
    return tab.access.withdraw ? { send: { t: 'guildWithdraw', uid: item.uid, at: null } } : { refuse: cannotTake(tab) };
  }
  if (place.at !== 'bag' || openTab === null) return null;
  if (!view) return { refuse: 'The guild stash is still opening' };
  const tab = guildTabOf(view, openTab) ?? currentGuildTab(view, openTab);
  return tab ? deposit(item, tab, null) : null;
}

/**
 * Whether a deposit waits for a yes, and what the prompt says. A tab the viewer's rank cannot take
 * from is a one-way trip, so every deposit there asks, dragged or clicked. With the Settings prompt
 * on, a quick click with a rare or relic asks too, like selling and dropping do; a drag is deliberate
 * enough on its own.
 */
export function depositPrompt(view: GuildStashView | null, action: GuildAction, item: Item, how: 'quick' | 'drag', confirmValuable: boolean): string | null {
  if (!view || !action || !('send' in action) || action.send.t !== 'guildDeposit') return null;
  const tab = guildTabOf(view, action.send.tab);
  if (!tab) return null;
  if (!tab.access.withdraw) return `You cannot take this back out of ${tab.name}.`;
  if (how === 'quick' && confirmValuable && (item.tier === 'rare' || item.tier === 'relic')) return `Put it into ${tab.name} for the guild?`;
  return null;
}

/** Whether a drop involves the guild stash at all, so the account stash rules stay out of it. */
export function involvesGuild(drag: DragPayload, target: ItemPlace): boolean {
  return drag.from.at === 'guild' || target.at === 'guild' || target.at === 'guildTab';
}

/**
 * The tooltip's last line for a guild item, and whether it is a limit (shown as a warning). A tab
 * that takes deposits but not withdrawals still lets the viewer rearrange inside it: the server's
 * move within one tab needs deposit only.
 */
export function guildItemHint(view: GuildStashView | null, tabId: number, quickKey: string): { text: string; warn: boolean } {
  const tab = view ? guildTabOf(view, tabId) : undefined;
  if (tab?.access.withdraw) return { text: `${quickKey}+click to take it out · Drag to move`, warn: false };
  if (tab?.access.deposit) return { text: 'Your rank cannot take from this tab · Drag to move it inside the tab', warn: true };
  return { text: 'Your rank can look but not take from this tab', warn: true };
}

// Access and permissions -------------------------------------------------------------------------

export const PERM_KEYS = ['view', 'deposit', 'withdraw'] as const;
export type PermKey = (typeof PERM_KEYS)[number];
export const PERM_LABELS: Record<PermKey, string> = { view: 'View', deposit: 'Deposit', withdraw: 'Withdraw' };

/** The viewer's access as one short line, for the tab bar's tip and the toolbar. */
export function accessText(a: TabPerms): string {
  if (!a.view) return 'Locked: your rank cannot see inside';
  if (a.deposit && a.withdraw) return 'You can put in and take out';
  if (a.deposit) return 'You can put in, not take out';
  if (a.withdraw) return 'You can take out, not put in';
  return 'You can look, not put in or take out';
}

/**
 * One checkbox changed. Deposit and withdraw need view, so turning either on turns view on, and
 * turning view off turns both off: the same rule the server's normalisePerms keeps.
 */
export function togglePerm(p: TabPerms, key: PermKey, on: boolean): TabPerms {
  if (key === 'view') return on ? { ...p, view: true } : { view: false, deposit: false, withdraw: false };
  const next = { ...p, [key]: on };
  return { ...next, view: next.view || next.deposit || next.withdraw };
}

/**
 * The permissions editor's copy while changes are on their way: each click builds on the last
 * one sent, not on the view from before it, so two quick clicks both land. The server's next view
 * replaces it.
 */
export function nextPendingPerms(base: Record<ManagedRank, TabPerms>, pending: Record<ManagedRank, TabPerms> | null, rank: ManagedRank, key: PermKey, on: boolean): Record<ManagedRank, TabPerms> {
  const current = pending ?? base;
  return { ...current, [rank]: togglePerm(current[rank], key, on) };
}

/**
 * Which permission rows a viewer may change: Member rows for anyone who manages tabs, the Officer
 * row for the Leader alone (the server refuses Officers setting their own rank's access).
 */
export function canEditPermRow(viewer: GuildRank, row: ManagedRank): boolean {
  return row === 'officer' ? viewer === 'leader' : guildCan(viewer, 'manageTabs');
}

/** The Buy button sends once per tab count: a second click before the new tab arrives does nothing. */
export function canSendBuy(sentAtTabs: number | null, tabs: number): boolean {
  return sentAtTabs !== tabs;
}

/** A drag from the guild grid needs withdraw (or a move inside the same tab, which also needs deposit). */
export function canDragFrom(tab: GuildTabView): boolean {
  return tab.access.withdraw || tab.access.deposit;
}
