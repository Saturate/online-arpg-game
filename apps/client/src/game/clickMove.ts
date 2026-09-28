import { NAV, SIM, type GameMap, type Vec2 } from '@rune/shared';

/**
 * Click-to-move, D2 style. The client turns a destination into a direction every tick and sends
 * that as normal movement input, so the server and prediction need no changes: the path is only
 * a way of choosing which way to push the stick.
 */

/** Arrived when this close; closer than a step would make the hero jitter on the spot. */
const ARRIVE = 10;
/** Upper bound on A* work per click, so a click on an unreachable spot cannot stall a frame. */
const MAX_EXPANSIONS = 30_000;
/** How far ahead along the path to look for a straight shot, in waypoints. */
const LOOKAHEAD = 8;

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

function cellCentre(map: GameMap, c: number): Vec2 {
  const cx = c % map.navCols;
  const cy = (c - cx) / map.navCols;
  return { x: (cx + 0.5) * NAV.cellSize, y: (cy + 0.5) * NAV.cellSize };
}

/** Nearest walkable cell to a point, searching outward, so a click on a rock still walks up to it. */
function nearestWalkable(map: GameMap, x: number, y: number): number | null {
  const start = map.navCell(x, y);
  const sx = start % map.navCols;
  const sy = (start - sx) / map.navCols;
  for (let r = 0; r <= 6; r++) {
    let best: number | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !map.isWalkable(sx + dx, sy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = (sy + dy) * map.navCols + sx + dx;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * A* over the nav grid with 8-way moves. Diagonals may not cut a blocked corner, or the hero
 * would try to squeeze between two rocks the collision code will not let through.
 */
export function findPath(map: GameMap, from: Vec2, to: Vec2): Vec2[] | null {
  const start = nearestWalkable(map, from.x, from.y);
  const goal = nearestWalkable(map, to.x, to.y);
  if (start === null || goal === null) return null;
  if (start === goal) return [to];
  const cols = map.navCols;
  const gx = goal % cols;
  const gy = (goal - gx) / cols;
  const h = (c: number): number => {
    const cx = c % cols;
    const dx = Math.abs(cx - gx);
    const dy = Math.abs((c - cx) / cols - gy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  // A binary heap would be faster, but open sets stay small on these maps and this stays readable.
  const open: { c: number; f: number }[] = [{ c: start, f: h(start) }];
  const closed = new Set<number>();
  let expansions = 0;
  while (open.length > 0 && expansions++ < MAX_EXPANSIONS) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if ((open[i]?.f ?? Infinity) < (open[bi]?.f ?? Infinity)) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1] ?? { c: -1, f: Infinity };
    open.pop();
    if (!cur || closed.has(cur.c)) continue;
    if (cur.c === goal) {
      const cells: number[] = [goal];
      for (let c = came.get(goal); c !== undefined; c = came.get(c)) cells.push(c);
      cells.reverse();
      const points = cells.slice(1).map((c) => cellCentre(map, c));
      points[points.length - 1] = map.pointBlocked(to.x, to.y, SIM.playerRadius, 'move') ? cellCentre(map, goal) : to;
      return points;
    }
    closed.add(cur.c);
    const cx = cur.c % cols;
    const cy = (cur.c - cx) / cols;
    const base = g.get(cur.c) ?? 0;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.isWalkable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!map.isWalkable(cx + dx, cy) || !map.isWalkable(cx, cy + dy))) continue;
      const n = ny * cols + nx;
      if (closed.has(n)) continue;
      const ng = base + cost;
      if (ng >= (g.get(n) ?? Infinity)) continue;
      g.set(n, ng);
      came.set(n, cur.c);
      open.push({ c: n, f: ng + h(n) });
    }
  }
  return null;
}

export class ClickMover {
  private path: Vec2[] = [];
  private dest: Vec2 | null = null;
  private plannedAt = -Infinity;

  constructor(private map: GameMap) {}

  get moving(): boolean {
    return this.dest !== null;
  }

  setMap(map: GameMap): void {
    this.map = map;
    this.stop();
  }

  /** Called every tick while the button is held, so replanning is throttled. */
  moveTo(from: Vec2, to: Vec2, now: number): void {
    const same = this.dest !== null && Math.hypot(this.dest.x - to.x, this.dest.y - to.y) < 24;
    if (same && now - this.plannedAt < 400) return;
    if (!same && now - this.plannedAt < 90) {
      this.dest = to;
      return;
    }
    this.plannedAt = now;
    // Straight line first: most clicks are in the open and need no search at all.
    if (this.map.lineClear(from.x, from.y, to.x, to.y, SIM.playerRadius, 'move')) {
      this.path = [to];
      this.dest = to;
      return;
    }
    const path = findPath(this.map, from, to);
    this.path = path ?? [];
    this.dest = path ? to : null;
  }

  stop(): void {
    this.path = [];
    this.dest = null;
  }

  /** Unit direction toward the next point worth walking to, or zero when there. */
  direction(from: Vec2): Vec2 {
    if (!this.dest) return { x: 0, y: 0 };
    while (this.path.length > 1) {
      const p = this.path[0];
      if (!p || Math.hypot(p.x - from.x, p.y - from.y) > NAV.cellSize * 0.6) break;
      this.path.shift();
    }
    // String pulling: head for the farthest upcoming point in a clear straight line.
    let target = this.path[0];
    for (let i = Math.min(this.path.length, LOOKAHEAD) - 1; i > 0; i--) {
      const p = this.path[i];
      if (p && this.map.lineClear(from.x, from.y, p.x, p.y, SIM.playerRadius, 'move')) {
        target = p;
        this.path.splice(0, i);
        break;
      }
    }
    if (!target) {
      this.stop();
      return { x: 0, y: 0 };
    }
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const d = Math.hypot(dx, dy);
    if (this.path.length <= 1 && d < ARRIVE) {
      this.stop();
      return { x: 0, y: 0 };
    }
    return { x: dx / d, y: dy / d };
  }
}
