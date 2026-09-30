import {
  categoryForSlot,
  findSpot,
  GEAR_SLOTS,
  generalTab,
  holdsBoundRunes,
  isBound,
  itemSize,
  STASH,
  stashItemUids,
  gearStats,
  STAT_IDS,
  type ClassId,
  type ClientMessage,
  type GearItem,
  type GearSlot,
  type InventoryMessage,
  type Item,
  type ItemUid,
  type StashTabRef,
  type StatId,
} from '@rune/shared';

/**
 * Where an item currently sits, or where it is dropped. Bag and stash places carry a cell when it
 * matters (a drop target, or the item's own corner); a bare bag place means "anywhere in the bag".
 */
export type ItemPlace =
  | { at: 'bag'; x?: number; y?: number }
  /** A cell of general stash tab `tab`. */
  | { at: 'stash'; tab: number; x: number; y: number }
  /** In the rune tab (a rolled rune in its list), or the rune tab itself as a drop target. */
  | { at: 'runeTab' }
  /** In the sigil tab's list, or the sigil tab itself as a drop target. */
  | { at: 'sigilTab' }
  /** A tab's label in the tab bar: only a drop target, which puts the item anywhere in that tab. */
  | { at: 'tabLabel'; tab: StashTabRef }
  | { at: 'sigil'; slot: number }
  | { at: 'warband'; slot: number }
  | { at: 'gear'; slot: GearSlot }
  /** On the trader's shelf: only for tooltips, never dragged or dropped. */
  | { at: 'trader'; price: number }
  /** In the forge editor's slots or pool: only for tooltips, with the hint to show under it. */
  | { at: 'forge'; hint: string; warn?: string };

export interface DragPayload {
  uid: ItemUid;
  from: ItemPlace;
  /** The cell of the item under the pointer when the drag began, so the drop keeps that grip. */
  grab: { x: number; y: number };
}

export const DRAG_TYPE = 'application/x-rune-item';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isGearSlot(v: unknown): v is GearSlot {
  return typeof v === 'string' && GEAR_SLOTS.some((s) => s === v);
}

function cell(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64;
}

function parsePlace(v: unknown): ItemPlace | null {
  if (!isRecord(v)) return null;
  if (v.at === 'bag') return cell(v.x) && cell(v.y) ? { at: 'bag', x: v.x, y: v.y } : { at: 'bag' };
  if (v.at === 'stash' && cell(v.x) && cell(v.y) && typeof v.tab === 'number' && Number.isInteger(v.tab)) return { at: 'stash', tab: v.tab, x: v.x, y: v.y };
  if (v.at === 'runeTab' || v.at === 'sigilTab') return { at: v.at };
  if ((v.at === 'sigil' || v.at === 'warband') && typeof v.slot === 'number' && Number.isInteger(v.slot) && v.slot >= 0 && v.slot < 4) return { at: v.at, slot: v.slot };
  if (v.at === 'gear' && isGearSlot(v.slot)) return { at: 'gear', slot: v.slot };
  return null;
}

/** Drag data can come from anywhere on the page, so it is parsed rather than trusted. */
export function parseDrag(raw: string): DragPayload | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || typeof v.uid !== 'number') return null;
    const from = parsePlace(v.from);
    const grab = isRecord(v.grab) && cell(v.grab.x) && cell(v.grab.y) ? { x: v.grab.x, y: v.grab.y } : { x: 0, y: 0 };
    return from ? { uid: v.uid, from, grab } : null;
  } catch {
    return null;
  }
}

function firstEmpty(slots: readonly (ItemUid | null)[]): number | null {
  const i = slots.findIndex((s) => s === null);
  return i < 0 ? null : i;
}

function inStashPlace(place: ItemPlace): boolean {
  return place.at === 'stash' || place.at === 'runeTab' || place.at === 'sigilTab';
}

/**
 * Right-click behaviour, D2 style: equipped things come off, bag things go on. Sigils and vessels
 * only take a free slot: replacing a skill by accident is worse than having to drag. At the stash a
 * right-click is the same quick move as ctrl+click; `openTab` is the general tab on screen.
 */
export function quickAction(inv: InventoryMessage, item: Item, place: ItemPlace, classId: ClassId, stashOpen = false, traderOpen = false, openTab: number | null = null): ClientMessage | null {
  // At the trader, right-click on a bag item sells it.
  if (traderOpen && place.at === 'bag') return { t: 'sell', uid: item.uid };
  if (stashOpen && (place.at === 'bag' || inStashPlace(place))) return { t: 'quickMove', uid: item.uid, tab: openTab };
  switch (place.at) {
    case 'stash':
    case 'runeTab':
    case 'sigilTab':
    case 'tabLabel':
    case 'trader':
    case 'forge':
      return null;
    case 'sigil':
      return { t: 'unequipSigil', slot: place.slot };
    case 'warband':
      return { t: 'unequipVessel', slot: place.slot };
    case 'gear':
      return { t: 'unequipGear', slot: place.slot };
    case 'bag':
      if (item.kind === 'gear') return { t: 'equipGear', uid: item.uid, slot: null };
      if (item.kind === 'sigil') {
        const slot = firstEmpty(inv.sigils);
        return slot === null ? null : { t: 'equipSigil', uid: item.uid, slot };
      }
      const slot = classId === 'binder' ? firstEmpty(inv.warband) : null;
      return slot === null ? null : { t: 'equipVessel', uid: item.uid, slot };
  }
}

/** What dropping `drag` onto `target` should do, or null when it does not fit there. */
export function dropAction(inv: InventoryMessage, item: Item, drag: DragPayload, target: ItemPlace, classId: ClassId): ClientMessage | null {
  const fromGrid = drag.from.at === 'bag' || inStashPlace(drag.from);
  if (target.at === 'trader' || drag.from.at === 'trader' || target.at === 'forge' || drag.from.at === 'forge' || drag.from.at === 'tabLabel') return null;
  if (target.at === 'runeTab') return fromGrid && item.kind === 'rune' && drag.from.at !== 'runeTab' ? { t: 'moveItem', uid: item.uid, to: { at: 'runes' } } : null;
  if (target.at === 'sigilTab') return fromGrid && item.kind === 'sigil' && drag.from.at !== 'sigilTab' ? { t: 'moveItem', uid: item.uid, to: { at: 'sigils' } } : null;
  if (target.at === 'tabLabel') {
    if (!fromGrid) return null;
    if (target.tab === 'runes') return item.kind === 'rune' ? { t: 'moveItem', uid: item.uid, to: { at: 'runes' } } : null;
    if (target.tab === 'sigils') return item.kind === 'sigil' ? { t: 'moveItem', uid: item.uid, to: { at: 'sigils' } } : null;
    const tab = generalTab(inv.stash, target.tab);
    const spot = tab ? findSpot(tab.cells, STASH, itemSize(item)) : null;
    return spot ? { t: 'moveItem', uid: item.uid, to: { at: 'tab', tab: target.tab, x: spot.x, y: spot.y } } : null;
  }
  if (target.at === 'bag' || target.at === 'stash') {
    if (!fromGrid) return target.at === 'bag' ? quickAction(inv, item, drag.from, classId) : null;
    if (target.x === undefined || target.y === undefined) return null;
    // A list row has no footprint to grip, so only grid-to-grid drags keep the offset.
    const grab = drag.from.at === 'bag' || drag.from.at === 'stash' ? drag.grab : { x: 0, y: 0 };
    const x = target.x - grab.x;
    const y = target.y - grab.y;
    if (x < 0 || y < 0) return null;
    return { t: 'moveItem', uid: item.uid, to: target.at === 'bag' ? { at: 'bag', x, y } : { at: 'tab', tab: target.tab, x, y } };
  }
  // Dragging one skill onto another slot reorders the skill bar.
  if (drag.from.at === 'sigil' && target.at === 'sigil') return drag.from.slot === target.slot ? null : { t: 'swapSigils', a: drag.from.slot, b: target.slot };
  // Other moves between two equipped slots are not supported; take it off first.
  if (drag.from.at !== 'bag') return null;
  if (target.at === 'sigil') return item.kind === 'sigil' ? { t: 'equipSigil', uid: item.uid, slot: target.slot } : null;
  if (target.at === 'warband') return item.kind === 'vessel' && classId === 'binder' ? { t: 'equipVessel', uid: item.uid, slot: target.slot } : null;
  return item.kind === 'gear' && categoryForSlot(target.slot) === item.category ? { t: 'equipGear', uid: item.uid, slot: target.slot } : null;
}

/** The equipped item a bag item would replace, matching the server's slot choice for rings. */
export function replacedBy(inv: InventoryMessage, item: GearItem): GearItem | null {
  const slots = GEAR_SLOTS.filter((s) => categoryForSlot(s) === item.category);
  if (slots.some((s) => inv.gear[s] === null)) return null;
  const uid = slots[0] === undefined ? null : inv.gear[slots[0]];
  const found = inv.items.find((i) => i.uid === uid);
  return found?.kind === 'gear' ? found : null;
}

export interface StatDelta {
  stat: StatId;
  delta: number;
}

/** Per-stat change from swapping `current` for `next`, largest first. Zero changes are left out. */
export function compareGear(next: GearItem, current: GearItem | null): StatDelta[] {
  const a = gearStats([next]);
  const b = current ? gearStats([current]) : {};
  // Rounded so float noise (0.8 - 0.7) neither prints nor counts as a change.
  return STAT_IDS.map((stat) => ({ stat, delta: Math.round(((a[stat] ?? 0) - (b[stat] ?? 0)) * 100) / 100 }))
    .filter((d) => d.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * Why the server would refuse to drop an item on the ground, so the bag can say it at once instead
 * of sending a command that only comes back as a notice.
 */
export function dropRefusal(item: Item): string | null {
  if (isBound(item)) return 'Bound items stay with this character';
  if (holdsBoundRunes(item)) return 'Take the bound runes out first';
  return null;
}

/** Items the character owns that sit in no grid and no slot: they wait for room (see pendingItems on the server). */
export function pendingOf(inv: InventoryMessage): Item[] {
  const placed = new Set<ItemUid | null>([...inv.inventory, ...stashItemUids(inv.stash), ...inv.warband, ...inv.sigils, ...Object.values(inv.gear)]);
  return inv.items.filter((i) => !placed.has(i.uid));
}
