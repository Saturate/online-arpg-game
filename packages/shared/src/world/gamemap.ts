import { GROUND, NAV } from '../config/sim.js';
import { clamp, type Vec2 } from '../sim/math.js';
import type { Obstacle, Shape, WorldMap } from './types.js';

export type CollisionMask = 'move' | 'shots';

const HASH_CELL = 120;
/** Number of push-out passes. Two is enough to settle a unit wedged between two shapes. */
const RESOLVE_PASSES = 2;

function shapeBounds(s: Shape): { x0: number; y0: number; x1: number; y1: number } {
  switch (s.type) {
    case 'circle':
      return { x0: s.x - s.r, y0: s.y - s.r, x1: s.x + s.r, y1: s.y + s.r };
    case 'capsule':
      return {
        x0: Math.min(s.ax, s.bx) - s.r,
        y0: Math.min(s.ay, s.by) - s.r,
        x1: Math.max(s.ax, s.bx) + s.r,
        y1: Math.max(s.ay, s.by) + s.r,
      };
    case 'box': {
      const e = Math.hypot(s.hw, s.hh);
      return { x0: s.x - e, y0: s.y - e, x1: s.x + e, y1: s.y + e };
    }
  }
}

/**
 * Signed-ish distance data for a point against a shape: the closest point on the shape surface and
 * whether the point is inside. Circles and capsules are handled as a core plus radius.
 */
function closest(s: Shape, px: number, py: number): { cx: number; cy: number; pad: number; inside: boolean } {
  if (s.type === 'circle') return { cx: s.x, cy: s.y, pad: s.r, inside: false };
  if (s.type === 'capsule') {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((px - s.ax) * dx + (py - s.ay) * dy) / len2, 0, 1);
    return { cx: s.ax + dx * t, cy: s.ay + dy * t, pad: s.r, inside: false };
  }
  // Box: work in the box's local frame.
  const cos = Math.cos(-s.angle);
  const sin = Math.sin(-s.angle);
  const lx = (px - s.x) * cos - (py - s.y) * sin;
  const ly = (px - s.x) * sin + (py - s.y) * cos;
  const inside = Math.abs(lx) < s.hw && Math.abs(ly) < s.hh;
  let qx = clamp(lx, -s.hw, s.hw);
  let qy = clamp(ly, -s.hh, s.hh);
  if (inside) {
    // Push out through the nearest face.
    if (s.hw - Math.abs(lx) < s.hh - Math.abs(ly)) qx = Math.sign(lx || 1) * s.hw;
    else qy = Math.sign(ly || 1) * s.hh;
  }
  const c2 = Math.cos(s.angle);
  const s2 = Math.sin(s.angle);
  return { cx: s.x + qx * c2 - qy * s2, cy: s.y + qx * s2 + qy * c2, pad: 0, inside };
}

/**
 * Collision and navigation data for one map. Built once per map; the static spatial hash keeps
 * every query to the handful of obstacles near the point.
 */
export class GameMap {
  readonly width: number;
  readonly height: number;
  readonly navCols: number;
  readonly navRows: number;
  readonly walkable: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly grid: Obstacle[][];
  private readonly roads: Shape[];

  constructor(readonly def: WorldMap) {
    this.width = def.width;
    this.height = def.height;
    this.cols = Math.ceil(def.width / HASH_CELL) + 1;
    this.rows = Math.ceil(def.height / HASH_CELL) + 1;
    this.grid = Array.from({ length: this.cols * this.rows }, () => []);
    this.roads = def.ground.filter((g) => g.kind === 'road').map((g) => g.shape);
    for (const o of def.obstacles) {
      const b = shapeBounds(o.shape);
      const cx0 = clamp(Math.floor(b.x0 / HASH_CELL), 0, this.cols - 1);
      const cy0 = clamp(Math.floor(b.y0 / HASH_CELL), 0, this.rows - 1);
      const cx1 = clamp(Math.floor(b.x1 / HASH_CELL), 0, this.cols - 1);
      const cy1 = clamp(Math.floor(b.y1 / HASH_CELL), 0, this.rows - 1);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.grid[cy * this.cols + cx]?.push(o);
    }

    const cell = NAV.cellSize;
    this.navCols = Math.ceil(def.width / cell);
    this.navRows = Math.ceil(def.height / cell);
    this.walkable = new Uint8Array(this.navCols * this.navRows);
    for (let cy = 0; cy < this.navRows; cy++) {
      for (let cx = 0; cx < this.navCols; cx++) {
        const blocked = this.pointBlocked((cx + 0.5) * cell, (cy + 0.5) * cell, NAV.agentRadius, 'move');
        this.walkable[cy * this.navCols + cx] = blocked ? 0 : 1;
      }
    }
  }

  private nearby(x: number, y: number, pad: number): Set<Obstacle> {
    const out = new Set<Obstacle>();
    const cx0 = clamp(Math.floor((x - pad) / HASH_CELL), 0, this.cols - 1);
    const cy0 = clamp(Math.floor((y - pad) / HASH_CELL), 0, this.rows - 1);
    const cx1 = clamp(Math.floor((x + pad) / HASH_CELL), 0, this.cols - 1);
    const cy1 = clamp(Math.floor((y + pad) / HASH_CELL), 0, this.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) for (const o of this.grid[cy * this.cols + cx] ?? []) out.add(o);
    }
    return out;
  }

  pointBlocked(x: number, y: number, radius: number, mask: CollisionMask): boolean {
    if (x < radius || y < radius || x > this.width - radius || y > this.height - radius) return true;
    for (const o of this.nearby(x, y, radius)) {
      if (!(mask === 'move' ? o.blocksMove : o.blocksShots)) continue;
      const c = closest(o.shape, x, y);
      if (c.inside) return true;
      const reach = c.pad + radius;
      if ((x - c.cx) ** 2 + (y - c.cy) ** 2 < reach * reach) return true;
    }
    return false;
  }

  /**
   * Pushes a circle out of every blocking obstacle it overlaps, then clamps to the map. Sliding
   * falls out naturally: only the penetrating component of the motion is removed.
   */
  resolveCircle(pos: Vec2, radius: number, mask: CollisionMask = 'move'): Vec2 {
    let x = pos.x;
    let y = pos.y;
    for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
      let moved = false;
      for (const o of this.nearby(x, y, radius)) {
        if (!(mask === 'move' ? o.blocksMove : o.blocksShots)) continue;
        const c = closest(o.shape, x, y);
        let dx = x - c.cx;
        let dy = y - c.cy;
        const reach = c.pad + radius;
        const d2 = dx * dx + dy * dy;
        if (!c.inside && d2 >= reach * reach) continue;
        let d = Math.sqrt(d2);
        if (c.inside) {
          // Inside a box: the closest face point is where we exit, pointing outward from the centre.
          dx = -dx;
          dy = -dy;
        }
        if (d < 1e-6) {
          // Dead centre has no direction; push along +x so the result stays deterministic.
          dx = 1;
          dy = 0;
          d = 1;
        }
        x = c.cx + (dx / d) * reach;
        y = c.cy + (dy / d) * reach;
        moved = true;
      }
      if (!moved) break;
    }
    return { x: clamp(x, radius, this.width - radius), y: clamp(y, radius, this.height - radius) };
  }

  /** True when a straight line between two points is clear of obstacles, inflated by `pad`. */
  lineClear(ax: number, ay: number, bx: number, by: number, pad: number, mask: CollisionMask): boolean {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / Math.max(16, pad)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.pointBlocked(ax + (bx - ax) * t, ay + (by - ay) * t, pad, mask)) return false;
    }
    return true;
  }

  /** Movement speed multiplier at a point: faster on roads and paths. */
  speedAt(x: number, y: number): number {
    for (const r of this.roads) {
      const c = closest(r, x, y);
      if (c.inside || (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.pad * c.pad) return 1 + GROUND.roadSpeedBonus;
    }
    return 1;
  }

  navCell(x: number, y: number): number {
    const cx = clamp(Math.floor(x / NAV.cellSize), 0, this.navCols - 1);
    const cy = clamp(Math.floor(y / NAV.cellSize), 0, this.navRows - 1);
    return cy * this.navCols + cx;
  }

  isWalkable(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.navCols && cy < this.navRows && this.walkable[cy * this.navCols + cx] === 1;
  }

  /** Nearest free spot to (x, y), searching outward in rings. Used for spawns and portal arrivals. */
  findOpen(x: number, y: number, radius: number): Vec2 {
    if (!this.pointBlocked(x, y, radius, 'move')) return { x, y };
    for (let ring = 1; ring < 40; ring++) {
      const d = ring * 20;
      const steps = 8 + ring * 2;
      for (let k = 0; k < steps; k++) {
        const a = (Math.PI * 2 * k) / steps;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        if (!this.pointBlocked(px, py, radius, 'move')) return { x: px, y: py };
      }
    }
    return { x, y };
  }
}
