import { NAV } from '../config/sim.js';
import type { GameMap } from '../world/gamemap.js';
import type { Vec2 } from './math.js';

/**
 * A* on the nav grid for one minion that has lost its master's trail. The enemies' flow field
 * (world/nav.ts) leads to the nearest player or minion, not to one master, so it cannot route a
 * minion home. Searches are rare (only when a minion is cut off) and capped, so a hopeless one
 * gives up quickly and the stuck teleport takes over.
 */

const SQRT2 = Math.SQRT2;

const STEPS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

interface Scratch {
  /** Search generation per cell, so the arrays never need clearing between searches. */
  seen: Uint32Array;
  closed: Uint32Array;
  g: Float32Array;
  from: Int32Array;
  generation: number;
}

const scratch = new WeakMap<GameMap, Scratch>();

function scratchFor(map: GameMap): Scratch {
  let s = scratch.get(map);
  if (!s) {
    const n = map.navCols * map.navRows;
    s = { seen: new Uint32Array(n), closed: new Uint32Array(n), g: new Float32Array(n), from: new Int32Array(n), generation: 0 };
    scratch.set(map, s);
  }
  s.generation++;
  return s;
}

/** Diagonal steps need both orthogonal neighbours open, as in the flow field, so routes never cut a corner. */
function canStep(map: GameMap, cx: number, cy: number, dx: number, dy: number): boolean {
  if (!map.isWalkable(cx + dx, cy + dy)) return false;
  if (dx !== 0 && dy !== 0) return map.isWalkable(cx + dx, cy) && map.isWalkable(cx, cy + dy);
  return true;
}

/** The cell under a point, or the nearest walkable one around it: a minion pressed against a fence can stand in a blocked cell. */
function openCell(map: GameMap, x: number, y: number): number | null {
  const cols = map.navCols;
  const c = map.navCell(x, y);
  const cx = c % cols;
  const cy = (c - cx) / cols;
  if (map.isWalkable(cx, cy)) return c;
  let best: number | null = null;
  let bestD = Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!map.isWalkable(cx + dx, cy + dy)) continue;
      const px = (cx + dx + 0.5) * NAV.cellSize - x;
      const py = (cy + dy + 0.5) * NAV.cellSize - y;
      const d = px * px + py * py;
      if (d < bestD) {
        bestD = d;
        best = (cy + dy) * cols + cx + dx;
      }
    }
  }
  return best;
}

/** Binary min-heap of cells keyed by f, kept in parallel plain arrays. */
class Heap {
  private readonly cells: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, key: number): void {
    const { cells, keys } = this;
    let i = cells.length;
    cells.push(cell);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pk = keys[parent] ?? 0;
      if (pk <= key) break;
      cells[i] = cells[parent] ?? 0;
      keys[i] = pk;
      i = parent;
    }
    cells[i] = cell;
    keys[i] = key;
  }

  pop(): number {
    const { cells, keys } = this;
    const top = cells[0] ?? -1;
    const lastCell = cells.pop();
    const lastKey = keys.pop();
    if (cells.length === 0 || lastCell === undefined || lastKey === undefined) return top;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= cells.length) break;
      const r = l + 1;
      const lk = keys[l] ?? Infinity;
      const rk = r < cells.length ? (keys[r] ?? Infinity) : Infinity;
      const child = rk < lk ? r : l;
      const ck = Math.min(lk, rk);
      if (ck >= lastKey) break;
      cells[i] = cells[child] ?? 0;
      keys[i] = ck;
      i = child;
    }
    cells[i] = lastCell;
    keys[i] = lastKey;
    return top;
  }
}

/**
 * Cell centres from just after `from` to `to`, or null when there is no route within `maxExpand`
 * cells searched. The last point is `to` itself when its cell is walkable.
 */
export function findNavPath(map: GameMap, from: Vec2, to: Vec2, maxExpand: number): Vec2[] | null {
  const start = openCell(map, from.x, from.y);
  const goal = openCell(map, to.x, to.y);
  if (start === null || goal === null) return null;
  if (start === goal) return [{ x: to.x, y: to.y }];
  const cols = map.navCols;
  const gx = goal % cols;
  const gy = (goal - gx) / cols;
  const h = (c: number): number => {
    const cx = c % cols;
    const dx = Math.abs(cx - gx);
    const dy = Math.abs((c - cx) / cols - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };
  const s = scratchFor(map);
  const gen = s.generation;
  const open = new Heap();
  s.seen[start] = gen;
  s.g[start] = 0;
  s.from[start] = -1;
  open.push(start, h(start));
  let expanded = 0;
  while (open.size > 0 && expanded < maxExpand) {
    const c: number = open.pop();
    if (s.closed[c] === gen) continue;
    s.closed[c] = gen;
    if (c === goal) return unwind(s, c, cols, to, map);
    expanded++;
    const cx: number = c % cols;
    const cy: number = (c - cx) / cols;
    const gc = s.g[c] ?? 0;
    for (const [dx, dy, cost] of STEPS) {
      if (!canStep(map, cx, cy, dx, dy)) continue;
      const n = (cy + dy) * cols + cx + dx;
      if (s.closed[n] === gen) continue;
      const g = gc + cost;
      if (s.seen[n] === gen && (s.g[n] ?? 0) <= g) continue;
      s.seen[n] = gen;
      s.g[n] = g;
      s.from[n] = c;
      open.push(n, g + h(n));
    }
  }
  return null;
}

function unwind(s: Scratch, end: number, cols: number, to: Vec2, map: GameMap): Vec2[] {
  const out: Vec2[] = [];
  let c = end;
  while (c >= 0) {
    const prev = s.from[c] ?? -1;
    // The start cell is where the minion already is.
    if (prev < 0) break;
    const cx = c % cols;
    out.push({ x: (cx + 0.5) * NAV.cellSize, y: ((c - cx) / cols + 0.5) * NAV.cellSize });
    c = prev;
  }
  out.reverse();
  if (map.navCell(to.x, to.y) === end) out[out.length - 1] = { x: to.x, y: to.y };
  return out;
}
