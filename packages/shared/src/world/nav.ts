import { NAV } from '../config/sim.js';
import type { Vec2 } from '../sim/math.js';
import type { GameMap } from './gamemap.js';

const UNREACHABLE = 0xffff;

const NEIGHBOURS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * A distance field toward the nearest target (players and minions). Enemies without line of sight
 * walk downhill on it, which routes them around rocks and over bridges instead of into the river.
 */
export class FlowField {
  private readonly dist: Uint16Array;
  private readonly queue: Int32Array;

  constructor(private readonly map: GameMap) {
    this.dist = new Uint16Array(map.navCols * map.navRows).fill(UNREACHABLE);
    this.queue = new Int32Array(map.navCols * map.navRows);
  }

  /** Diagonal steps are only allowed when both orthogonal neighbours are open, so paths never cut corners. */
  private canStep(cx: number, cy: number, dx: number, dy: number): boolean {
    const m = this.map;
    if (!m.isWalkable(cx + dx, cy + dy)) return false;
    if (dx !== 0 && dy !== 0) return m.isWalkable(cx + dx, cy) && m.isWalkable(cx, cy + dy);
    return true;
  }

  rebuild(targets: readonly Vec2[]): void {
    const cols = this.map.navCols;
    this.dist.fill(UNREACHABLE);
    let head = 0;
    let tail = 0;
    for (const t of targets) {
      const c = this.map.navCell(t.x, t.y);
      if (this.dist[c] === 0) continue;
      this.dist[c] = 0;
      this.queue[tail++] = c;
    }
    while (head < tail) {
      const c = this.queue[head++] ?? 0;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      const next = (this.dist[c] ?? 0) + 1;
      if (next > NAV.maxSearchSteps) continue;
      for (const [dx, dy] of NEIGHBOURS) {
        if (!this.canStep(cx, cy, dx, dy)) continue;
        const n = (cy + dy) * cols + (cx + dx);
        if ((this.dist[n] ?? 0) <= next) continue;
        this.dist[n] = next;
        this.queue[tail++] = n;
      }
    }
  }

  /** Unit direction toward the next cell downhill, or null when already at a target or unreachable. */
  direction(x: number, y: number): Vec2 | null {
    const cols = this.map.navCols;
    const c = this.map.navCell(x, y);
    const here = this.dist[c] ?? UNREACHABLE;
    if (here === 0 || here === UNREACHABLE) return null;
    const cx = c % cols;
    const cy = (c - cx) / cols;
    let best = here;
    let bx = 0;
    let by = 0;
    for (const [dx, dy] of NEIGHBOURS) {
      if (!this.canStep(cx, cy, dx, dy)) continue;
      const d = this.dist[(cy + dy) * cols + (cx + dx)] ?? UNREACHABLE;
      if (d < best) {
        best = d;
        bx = dx;
        by = dy;
      }
    }
    if (bx === 0 && by === 0) return null;
    // Aim at the neighbour's centre, not just its direction, so agents stay centred in corridors.
    const tx = (cx + bx + 0.5) * NAV.cellSize - x;
    const ty = (cy + by + 0.5) * NAV.cellSize - y;
    const len = Math.hypot(tx, ty) || 1;
    return { x: tx / len, y: ty / len };
  }
}
