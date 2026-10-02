import { isStashColorId, isStashTabName, STASH_TABS, stashTabPrice, type StashColorId } from '../config/stash.js';
import type { AffixId } from '../data/affixes.js';
import { BAG, canPlace, emptyGrid, findSpot, itemSize, place, placements, removeFrom, STASH, type GridSize } from '../items/grid.js';
import { isPlainRune, RUNE_STACK, stacksWith, type Item, type ItemUid, type RuneItem } from '../items/items.js';
import {
  compareRunes,
  compareSigils,
  generalTab,
  isListableRune,
  isRuneAffixId,
  isRuneSortKey,
  isSigilSortKey,
  locateInStash,
  newGeneralTab,
  removeFromStash,
  stashRefuses,
  type StashSortKey,
  type StashSpot,
  type StashTabRef,
} from '../items/stash.js';
import type { GridDest, ItemDest } from '../protocol/messages.js';
import type { EntityId, PlayerComp } from './ecs.js';
import { addItem, changed, compareForSort, settlePending, stackSpace, topUpStacks } from './inventory.js';
import { distSq } from './math.js';
import type { Simulation } from './simulation.js';

/**
 * Stash tab operations. Each one checks everything first and then applies, so a refusal leaves the
 * character and the stash exactly as they were. Every one needs the player at the chest.
 */

/** How close to the stash chest a player must stand to use it; like waypoints, checked on the server. */
export const STASH_REACH = 150;

export function nearStash(sim: Simulation, pid: EntityId): boolean {
  const at = sim.mapDef.stash;
  const pos = sim.world.position.get(pid);
  return !!at && !!pos && distSq(at.x, at.y, pos.x, pos.y) <= STASH_REACH * STASH_REACH;
}

type From = { at: 'bag' } | StashSpot;

function whereIs(p: PlayerComp, uid: ItemUid): From | null {
  if (p.inventory.includes(uid)) return { at: 'bag' };
  return locateInStash(p.stash, uid);
}

function unplace(p: PlayerComp, uid: ItemUid, from: From): void {
  if (from.at === 'bag') removeFrom(p.inventory, uid);
  else removeFromStash(p.stash, uid);
}

/** A cell target as its grid, or why it does not exist. */
function gridOf(p: PlayerComp, to: GridDest): { cells: (ItemUid | null)[]; size: GridSize } | string {
  if (to.at === 'bag') return { cells: p.inventory, size: BAG };
  const tab = generalTab(p.stash, to.tab);
  return tab ? { cells: tab.cells, size: STASH } : 'No such stash tab';
}

function sameGrid(p: PlayerComp, from: From, to: GridDest): boolean {
  if (from.at === 'bag') return to.at === 'bag';
  return from.at === 'tab' && to.at === 'tab' && from.tab.id === to.tab;
}

function done(p: PlayerComp): null {
  settlePending(p);
  changed(p);
  return null;
}

/** Room in the rune tab's plain stacks of this rune: what a plain stack put in tops up first. */
function tabStackSpace(p: PlayerComp, item: RuneItem): number {
  let room = 0;
  for (const u of p.stash.runes.list) {
    const it = p.items.get(u);
    if (it?.kind === 'rune' && it.uid !== item.uid && it.bound !== true && stacksWith(it, item)) room += Math.max(0, RUNE_STACK - it.count);
  }
  return room;
}

/** Why the rune tab would not take this rune item whole, or null. */
function runeTabRefuses(p: PlayerComp, item: RuneItem): string | null {
  if (!isListableRune(item) || item.count > RUNE_STACK) return 'That rune cannot be stashed';
  // A plain stack that fits in the tab's own stacks needs no row of its own.
  if (isPlainRune(item) && item.count <= tabStackSpace(p, item)) return null;
  if (p.stash.runes.list.length >= STASH_TABS.runeCap) return `The rune tab holds ${STASH_TABS.runeCap} runes`;
  return null;
}

/**
 * Moves a bag or stash item: onto a cell of the bag or of a general tab (the cells must be free, the
 * item itself aside), or into the rune or sigil tab. A plain stack put in the rune tab tops up the
 * tab's stacks of that rune first, and only what is left takes a row of its own.
 */
export function moveItem(sim: Simulation, pid: EntityId, uid: ItemUid, to: ItemDest): string | null {
  const p = sim.world.player.get(pid);
  const item = p?.items.get(uid);
  if (!p || !item) return 'No such item';
  const from = whereIs(p, uid);
  if (!from) return 'Take it off first';
  if ((from.at !== 'bag' || to.at !== 'bag') && !nearStash(sim, pid)) return 'Stand at the stash to use it';
  // The stash is shared by the account; a bound item put there would reach every other character.
  if (from.at === 'bag' && to.at !== 'bag') {
    const refused = stashRefuses(item);
    if (refused) return refused;
  }
  if (to.at === 'runes') {
    if (item.kind !== 'rune') return 'Only runes go in the rune tab';
    if (from.at === 'runes') return null;
    const refused = runeTabRefuses(p, item);
    if (refused) return refused;
    unplace(p, uid, from);
    if (isPlainRune(item)) topUpStacks(p, item, p.stash.runes.list);
    if (item.count === 0) p.items.delete(uid);
    else p.stash.runes.list.push(uid);
    return done(p);
  }
  if (to.at === 'sigils') {
    if (item.kind !== 'sigil') return 'Only sigils go in the sigil tab';
    if (from.at === 'sigils') return null;
    if (p.stash.sigils.list.length >= STASH_TABS.sigilCap) return `The sigil tab holds ${STASH_TABS.sigilCap} sigils`;
    unplace(p, uid, from);
    p.stash.sigils.list.push(uid);
    return done(p);
  }
  const grid = gridOf(p, to);
  if (typeof grid === 'string') return grid;
  const size = itemSize(item);
  if (!canPlace(grid.cells, grid.size, size, to.x, to.y, sameGrid(p, from, to) ? uid : null)) return 'No room there';
  unplace(p, uid, from);
  place(grid.cells, grid.size, uid, size, to.x, to.y);
  return done(p);
}

/** The first free spot for an item among general tabs, trying `first` before the rest in tab order. */
function generalSpot(p: PlayerComp, item: Item, first: number | null): GridDest | null {
  const size = itemSize(item);
  const tabs = [...p.stash.general].sort((a, b) => Number(b.id === first) - Number(a.id === first));
  for (const tab of tabs) {
    const spot = findSpot(tab.cells, STASH, size);
    if (spot) return { at: 'tab', tab: tab.id, x: spot.x, y: spot.y };
  }
  return null;
}

/** Why the bag cannot take this item whole (a plain rune may fill up stacks first), or null. */
function bagRefuses(p: PlayerComp, item: Item): string | null {
  if (item.kind === 'rune' && isPlainRune(item) && item.count <= stackSpace(p, item)) return null;
  return findSpot(p.inventory, BAG, itemSize(item)) ? null : 'No room in your bag';
}

/**
 * Ctrl+click at the chest. A bag item goes to the tab that takes it: runes to the rune tab, sigils
 * to the sigil tab, anything else to general tab
 * `openTab` when it has room, else the first general tab that does. A stash item goes to the bag,
 * a plain stack topping up matching bag stacks first. All or nothing.
 */
export function quickMove(sim: Simulation, pid: EntityId, uid: ItemUid, openTab: number | null): string | null {
  const p = sim.world.player.get(pid);
  const item = p?.items.get(uid);
  if (!p || !item) return 'No such item';
  const from = whereIs(p, uid);
  if (!from) return 'Take it off first';
  if (!nearStash(sim, pid)) return 'Stand at the stash to use it';
  if (from.at === 'bag') {
    const refused = stashRefuses(item);
    if (refused) return refused;
    if (item.kind === 'rune') return moveItem(sim, pid, uid, { at: 'runes' });
    if (item.kind === 'sigil') return moveItem(sim, pid, uid, { at: 'sigils' });
    const spot = generalSpot(p, item, openTab);
    return spot ? moveItem(sim, pid, uid, spot) : 'No room in the stash';
  }
  const refused = bagRefuses(p, item);
  if (refused) return refused;
  unplace(p, uid, from);
  if (item.kind === 'rune' && isPlainRune(item)) {
    topUpStacks(p, item);
    if (item.count === 0) {
      p.items.delete(uid);
      return done(p);
    }
  }
  const spot = findSpot(p.inventory, BAG, itemSize(item));
  // bagRefuses found room for it (or its stacks), so this only guards the impossible.
  if (!spot) throw new Error(`quickMove: no bag cell for ${uid} after the check`);
  place(p.inventory, BAG, uid, itemSize(item), spot.x, spot.y);
  return done(p);
}

/**
 * Takes `count` runes off a plain stack in the stash (the rune tab or a general tab): onto a free
 * cell of the bag or a general tab, or (`to` null) into the bag wherever they fit, topping up bag
 * stacks first. The whole stack is an ordinary move; part of one leaves as a new stack.
 */
export function takeRunes(sim: Simulation, pid: EntityId, uid: ItemUid, count: number, to: GridDest | null): string | null {
  const p = sim.world.player.get(pid);
  const item = p?.items.get(uid);
  if (!p || !item) return 'No such item';
  if (!nearStash(sim, pid)) return 'Stand at the stash to use it';
  const from = locateInStash(p.stash, uid);
  if (!from) return 'That is not in the stash';
  if (item.kind !== 'rune' || !isPlainRune(item)) return 'Only plain rune stacks can be split';
  if (!Number.isInteger(count) || count < 1 || count > item.count) return `That stack holds ${item.count}`;
  if (count === item.count) return to === null ? quickMove(sim, pid, uid, null) : moveItem(sim, pid, uid, to);
  const part: RuneItem = { ...item, uid: sim.newItemUid(), count, affixes: [] };
  if (to === null) {
    // addItem is all or nothing, so a part that does not fit leaves the bag untouched.
    if (!addItem(p, part)) return 'No room in your bag';
  } else {
    const grid = gridOf(p, to);
    if (typeof grid === 'string') return grid;
    if (!canPlace(grid.cells, grid.size, itemSize(part), to.x, to.y)) return 'No room there';
    p.items.set(part.uid, part);
    place(grid.cells, grid.size, part.uid, itemSize(part), to.x, to.y);
  }
  item.count -= count;
  return done(p);
}

/**
 * General tabs pack to the front in bag sort order; the rune and sigil tabs sort their lists by
 * `key`, and the rune tab by `affix` when the key is 'affix'.
 */
export function sortStash(sim: Simulation, pid: EntityId, tab: StashTabRef, key: StashSortKey | null, affix: AffixId | null = null): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (!nearStash(sim, pid)) return 'Stand at the stash to use it';
  if (tab === 'runes') {
    if (!isRuneSortKey(key)) return 'Sort runes by rune, kind, tier, item level or an affix';
    if (key === 'affix' && !isRuneAffixId(affix)) return 'Pick a rune affix to sort by';
    const items = p.stash.runes.list.flatMap((u) => {
      const it = p.items.get(u);
      return it?.kind === 'rune' ? [it] : [];
    });
    if (items.length !== p.stash.runes.list.length) return 'Could not sort the rune tab';
    p.stash.runes.list = items.sort(compareRunes(key, key === 'affix' ? affix : null)).map((i) => i.uid);
    changed(p);
    return null;
  }
  if (tab === 'sigils') {
    if (!isSigilSortKey(key)) return 'Sort sigils by tier, item level, slots or name';
    const items = p.stash.sigils.list.flatMap((u) => {
      const it = p.items.get(u);
      return it?.kind === 'sigil' ? [it] : [];
    });
    if (items.length !== p.stash.sigils.list.length) return 'Could not sort the sigil tab';
    p.stash.sigils.list = items.sort(compareSigils(key)).map((i) => i.uid);
    changed(p);
    return null;
  }
  const general = generalTab(p.stash, tab);
  if (!general) return 'No such stash tab';
  const items = placements(general.cells, STASH).flatMap(({ uid }) => {
    const item = p.items.get(uid);
    return item ? [item] : [];
  });
  items.sort(compareForSort);
  const cells = emptyGrid(STASH);
  for (const item of items) {
    const s = itemSize(item);
    const spot = findSpot(cells, STASH, s);
    // Sorting packs at least as tightly as the tab was, but never lose an item if it somehow does not.
    if (!spot) return 'Could not sort the tab';
    place(cells, STASH, item.uid, s, spot.x, spot.y);
  }
  general.cells = cells;
  changed(p);
  return null;
}

/** Buys the next general tab with this character's gold, at the chest; up to STASH_TABS.maxGeneral. */
export function buyStashTab(sim: Simulation, pid: EntityId): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (!nearStash(sim, pid)) return 'Stand at the stash to use it';
  const price = stashTabPrice(p.stash.general.length);
  if (price === null) return `You own all ${STASH_TABS.maxGeneral} stash tabs`;
  if (p.gold < price) return `A new stash tab costs ${price} gold`;
  const id = Math.max(0, ...p.stash.general.map((t) => t.id)) + 1;
  p.gold -= price;
  p.stash.general.push(newGeneralTab(id));
  changed(p);
  return null;
}

export function editStashTab(sim: Simulation, pid: EntityId, tab: number, name: string, color: StashColorId): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (!nearStash(sim, pid)) return 'Stand at the stash to use it';
  const general = generalTab(p.stash, tab);
  if (!general) return 'No such stash tab';
  if (!isStashTabName(name)) return `Tab names are 1 to ${STASH_TABS.nameMax} letters, digits, spaces or simple punctuation`;
  if (!isStashColorId(color)) return 'No such colour';
  general.name = name;
  general.color = color;
  changed(p);
  return null;
}
