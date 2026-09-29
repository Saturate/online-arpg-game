import type { Item, ItemUid } from './items.js';

/**
 * D2-style item grids. A grid is a flat array of cells, row by row, each holding the uid of the
 * item covering it (an item covers every cell of its footprint). The first cell an item appears in,
 * scanning row by row, is its top-left corner.
 */

export interface GridSize {
  w: number;
  h: number;
}

/** Changing a size is safe: saves of another size are repacked on load (see layOut). */
export const BAG: GridSize = { w: 12, h: 8 };
export const STASH: GridSize = { w: 12, h: 10 };

const GEAR_SIZES: Record<string, GridSize> = {
  weapon: { w: 2, h: 3 },
  body: { w: 2, h: 3 },
  helmet: { w: 2, h: 2 },
  gloves: { w: 2, h: 2 },
  boots: { w: 2, h: 2 },
  belt: { w: 2, h: 1 },
  amulet: { w: 1, h: 1 },
  ring: { w: 1, h: 1 },
};

export function itemSize(item: Item): GridSize {
  if (item.kind === 'gear') return GEAR_SIZES[item.category] ?? { w: 1, h: 1 };
  if (item.kind === 'vessel') return { w: 1, h: 2 };
  return { w: 1, h: 1 };
}

export function emptyGrid(size: GridSize): (ItemUid | null)[] {
  return new Array<ItemUid | null>(size.w * size.h).fill(null);
}

export function canPlace(cells: readonly (ItemUid | null)[], size: GridSize, item: GridSize, x: number, y: number, ignore: ItemUid | null = null): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + item.w > size.w || y + item.h > size.h) return false;
  for (let dy = 0; dy < item.h; dy++) {
    for (let dx = 0; dx < item.w; dx++) {
      const at = cells[(y + dy) * size.w + x + dx];
      if (at !== null && at !== ignore) return false;
    }
  }
  return true;
}

export function place(cells: (ItemUid | null)[], size: GridSize, uid: ItemUid, item: GridSize, x: number, y: number): void {
  for (let dy = 0; dy < item.h; dy++) for (let dx = 0; dx < item.w; dx++) cells[(y + dy) * size.w + x + dx] = uid;
}

export function removeFrom(cells: (ItemUid | null)[], uid: ItemUid): void {
  for (let i = 0; i < cells.length; i++) if (cells[i] === uid) cells[i] = null;
}

/** Column by column from the top left, like D2, so tall items stack down the left edge. */
export function findSpot(cells: readonly (ItemUid | null)[], size: GridSize, item: GridSize): { x: number; y: number } | null {
  for (let x = 0; x + item.w <= size.w; x++) {
    for (let y = 0; y + item.h <= size.h; y++) if (canPlace(cells, size, item, x, y)) return { x, y };
  }
  return null;
}

export function anchorOf(cells: readonly (ItemUid | null)[], size: GridSize, uid: ItemUid): { x: number; y: number } | null {
  const i = cells.indexOf(uid);
  return i < 0 ? null : { x: i % size.w, y: Math.floor(i / size.w) };
}

/** Every distinct item in a grid with its top-left corner, in reading order. */
export function placements(cells: readonly (ItemUid | null)[], size: GridSize): { uid: ItemUid; x: number; y: number }[] {
  const seen = new Set<ItemUid>();
  const out: { uid: ItemUid; x: number; y: number }[] = [];
  cells.forEach((uid, i) => {
    if (uid === null || seen.has(uid)) return;
    seen.add(uid);
    out.push({ uid, x: i % size.w, y: Math.floor(i / size.w) });
  });
  return out;
}
