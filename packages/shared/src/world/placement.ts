import type { Vec2 } from '../sim/math.js';
import { distToSegment, distToShape } from './gen.js';
import { shapeBlocks, shapeBounds } from './gamemap.js';
import type { Obstacle } from './types.js';

/**
 * What a placement keeps clear of. `fits` in gen.ts answers the same questions with a scan over the
 * whole map; this index answers them from the few entries near the point, so generating one chunk
 * costs the same however big the zone is.
 */
export interface PlacementRules {
  /** Extra clearance from obstacles (other than water). */
  spacing: number;
  /** Clearance from a river's centre line beyond its half width. */
  riverPad: number;
  /** Whether keep-out circles and rectangles apply (scattered decor ignores them). */
  keepOut: boolean;
  /** Whether bridges keep `length / 2 + 80` clear, as `fits` does. */
  bridges: boolean;
}

/** The rules of `scatterDecor`: off obstacles by 14 and rivers by 10, nothing else. */
export const SCATTER_RULES: PlacementRules = { spacing: 14, riverPad: 10, keepOut: false, bridges: false };

/** `fits` from gen.ts, answered from `space`: inside the map with the same margin, and no rule broken. */
export function fitsIn(space: Space, width: number, height: number, x: number, y: number, r: number, rules: PlacementRules): boolean {
  return x >= r + 50 && y >= r + 50 && x <= width - r - 50 && y <= height - r - 50 && !space.conflicts(x, y, r, rules);
}

type Entry =
  | { t: 'circle'; x: number; y: number; r: number; mark: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; pad: number; mark: number }
  | { t: 'river'; ax: number; ay: number; bx: number; by: number; half: number; mark: number }
  | { t: 'bridge'; x: number; y: number; r: number; mark: number }
  | { t: 'obstacle'; o: Obstacle; mark: number };

const CELL = 128;
/** Wide enough that keys of neighbouring cells never collide, for maps up to 4 million units across. */
const KEY_SPAN = 32768;

/** A sparse grid of everything placements must keep clear of, indexed by bounds. */
export class Space {
  private readonly cells = new Map<number, Entry[]>();
  private stamp = 0;

  private key(cx: number, cy: number): number {
    return (cx + KEY_SPAN / 2) * KEY_SPAN + (cy + KEY_SPAN / 2);
  }

  private insert(e: Entry, x0: number, y0: number, x1: number, y1: number): void {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(e);
        else this.cells.set(k, [e]);
      }
    }
  }

  /** A circle new placements stay out of (by their own radius), like `Placement.avoid`. */
  keepOutCircle(x: number, y: number, r: number): void {
    this.insert({ t: 'circle', x, y, r, mark: 0 }, x - r, y - r, x + r, y + r);
  }

  /** A rectangle new placements stay out of, `pad` plus their radius, like `Placement.avoidRects`. */
  keepOutRect(r: { x: number; y: number; w: number; h: number; pad: number }): void {
    this.insert({ t: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, pad: r.pad, mark: 0 }, r.x - r.pad, r.y - r.pad, r.x + r.w + r.pad, r.y + r.h + r.pad);
  }

  river(path: readonly Vec2[], width: number): void {
    const half = width / 2;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (!a || !b) continue;
      this.insert({ t: 'river', ax: a.x, ay: a.y, bx: b.x, by: b.y, half, mark: 0 }, Math.min(a.x, b.x) - half, Math.min(a.y, b.y) - half, Math.max(a.x, b.x) + half, Math.max(a.y, b.y) + half);
    }
  }

  bridge(x: number, y: number, length: number): void {
    const r = length / 2;
    this.insert({ t: 'bridge', x, y, r, mark: 0 }, x - r, y - r, x + r, y + r);
  }

  obstacle(o: Obstacle): void {
    const b = shapeBounds(o.shape);
    this.insert({ t: 'obstacle', o, mark: 0 }, b.x0, b.y0, b.x1, b.y1);
  }

  private visit(x: number, y: number, reach: number, fn: (e: Entry) => boolean): boolean {
    const q = ++this.stamp;
    for (let cy = Math.floor((y - reach) / CELL); cy <= Math.floor((y + reach) / CELL); cy++) {
      for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) {
        for (const e of this.cells.get(this.key(cx, cy)) ?? []) {
          if (e.mark === q) continue;
          e.mark = q;
          if (fn(e)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Whether a circle of radius `r` at (x, y) breaks a rule against anything here: the same tests as
   * `fits` (bounds aside), so a placement checked here lands exactly where `fits` would allow it.
   */
  conflicts(x: number, y: number, r: number, rules: PlacementRules): boolean {
    // Every rule fails only within this distance of an entry's bounds.
    const reach = r + Math.max(rules.spacing, rules.riverPad, rules.bridges ? 80 : 0);
    return this.visit(x, y, reach, (e) => {
      switch (e.t) {
        case 'circle':
          return rules.keepOut && Math.hypot(x - e.x, y - e.y) < e.r + r;
        case 'rect':
          return rules.keepOut && x >= e.x - e.pad - r && y >= e.y - e.pad - r && x <= e.x + e.w + e.pad + r && y <= e.y + e.h + e.pad + r;
        case 'river':
          return distToSegment(x, y, e.ax, e.ay, e.bx, e.by) < e.half + r + rules.riverPad;
        case 'bridge':
          return rules.bridges && Math.hypot(x - e.x, y - e.y) < e.r + r + 80;
        case 'obstacle':
          return e.o.kind !== 'water' && distToShape(x, y, e.o.shape) < r + rules.spacing;
      }
    });
  }

  /** Whether an obstacle here blocks movement for a circle at (x, y), as `GameMap.pointBlocked` tests it. */
  blocks(x: number, y: number, radius: number): boolean {
    return this.visit(x, y, radius, (e) => e.t === 'obstacle' && e.o.blocksMove && shapeBlocks(e.o.shape, x, y, radius));
  }
}

