import {
  BAG,
  categoryForSlot,
  findSpot,
  GEAR_SLOTS,
  itemSize,
  STASH,
  gearStats,
  STAT_IDS,
  type ClassId,
  type ClientMessage,
  type GearItem,
  type GearSlot,
  type InventoryMessage,
  type Item,
  type ItemUid,
  type StatId,
} from '@rune/shared';

/**
 * Where an item currently sits, or where it is dropped. Bag and stash places carry a cell when it
 * matters (a drop target, or the item's own corner); a bare bag place means "anywhere in the bag".
 */
export type ItemPlace =
  | { at: 'bag'; x?: number; y?: number }
  | { at: 'stash'; x: number; y: number }
  | { at: 'sigil'; slot: number }
  | { at: 'warband'; slot: number }
  | { at: 'gear'; slot: GearSlot }
  /** On the trader's shelf: only for tooltips, never dragged or dropped. */
  | { at: 'trader'; price: number };

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
  if (v.at === 'stash' && cell(v.x) && cell(v.y)) return { at: 'stash', x: v.x, y: v.y };
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

/**
 * Right-click behaviour, D2 style: equipped things come off, bag things go on. Sigils and vessels
 * only take a free slot: replacing a skill by accident is worse than having to drag.
 */
export function quickAction(inv: InventoryMessage, item: Item, place: ItemPlace, classId: ClassId, stashOpen = false, traderOpen = false): ClientMessage | null {
  // At the trader, right-click on a bag item sells it.
  if (traderOpen && place.at === 'bag') return { t: 'sell', uid: item.uid };
  // At the stash, right-click moves things across instead, like D2's ctrl-click.
  if (stashOpen && (place.at === 'bag' || place.at === 'stash')) {
    const to = place.at === 'bag' ? 'stash' : 'bag';
    const spot = findSpot(to === 'bag' ? inv.inventory : inv.stash, to === 'bag' ? BAG : STASH, itemSize(item));
    return spot ? { t: 'moveItem', uid: item.uid, to, x: spot.x, y: spot.y } : null;
  }
  switch (place.at) {
    case 'stash':
    case 'trader':
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
  const fromGrid = drag.from.at === 'bag' || drag.from.at === 'stash';
  if (target.at === 'trader' || drag.from.at === 'trader') return null;
  if (target.at === 'bag' || target.at === 'stash') {
    if (!fromGrid) return target.at === 'bag' ? quickAction(inv, item, drag.from, classId) : null;
    if (target.x === undefined || target.y === undefined) return null;
    const x = target.x - drag.grab.x;
    const y = target.y - drag.grab.y;
    return x >= 0 && y >= 0 ? { t: 'moveItem', uid: item.uid, to: target.at, x, y } : null;
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
  return STAT_IDS.map((stat) => ({ stat, delta: (a[stat] ?? 0) - (b[stat] ?? 0) }))
    .filter((d) => d.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
