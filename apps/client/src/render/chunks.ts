import { STREAMING } from '@rune/shared';

/**
 * World streaming on the client (step 2, docs/features/world-streaming.md): the static world is cut
 * into the same square chunks the server sleeps monsters by, and only chunks near the camera are
 * built and drawn. This file is the pure part: chunk indexing, distances, and the rule that decides
 * which chunks to build, show, hide and release. Nothing here touches three.js.
 */

/** World units per chunk side, shared with the server's monster sleep. */
export const CHUNK_SIZE = STREAMING.chunkSize;

/**
 * Chunk coordinates are packed into one number. Border scenery reaches past the map edge, so
 * coordinates go negative; the offset keeps keys positive for about a million units each way.
 */
const OFFSET = 1024;
const SPAN = 2048;

export function chunkCoord(v: number, size = CHUNK_SIZE): number {
  return Math.floor(v / size);
}

export function chunkKey(cx: number, cy: number): number {
  return (cy + OFFSET) * SPAN + (cx + OFFSET);
}

export function keyCoords(key: number): { cx: number; cy: number } {
  return { cx: (key % SPAN) - OFFSET, cy: Math.floor(key / SPAN) - OFFSET };
}

export function chunkKeyAt(x: number, y: number, size = CHUNK_SIZE): number {
  return chunkKey(chunkCoord(x, size), chunkCoord(y, size));
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Ground distance from a point to the nearest point of a rectangle, 0 inside it. */
export function rectDistance(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

/** Grows `r` to cover a circle, in place. */
export function growRect(r: Rect, x: number, y: number, radius: number): void {
  r.x0 = Math.min(r.x0, x - radius);
  r.y0 = Math.min(r.y0, y - radius);
  r.x1 = Math.max(r.x1, x + radius);
  r.y1 = Math.max(r.y1, y + radius);
}

export function chunkRect(cx: number, cy: number, size = CHUNK_SIZE): Rect {
  return { x0: cx * size, y0: cy * size, x1: (cx + 1) * size, y1: (cy + 1) * size };
}

/**
 * How far from the camera focus the ground can be seen: the corner of the view's footprint on the
 * ground for an orthographic camera looking down at `pitch` radians, with `halfWidth` and
 * `halfHeight` the camera's half extents in world units before zoom.
 */
export function viewFootprint(halfWidth: number, halfHeight: number, zoom: number, pitch: number): number {
  const w = halfWidth / zoom;
  const d = halfHeight / zoom / Math.max(0.1, Math.sin(pitch));
  return Math.hypot(w, d);
}

/**
 * Reach added to the ground footprint: tall scenery (border mountains, buildings, trees) standing
 * outside the footprint still rises into the picture, and a model's own size puts parts of it past
 * its anchor. At the game's 52 degree pitch a point h high shows up to h / tan(52) = 0.78 h past
 * the footprint's edge, so a border peak about 400 high reaches in from 310 units beyond it.
 */
const TALL_REACH = 500;
/** The owner's brief: the camera sees roughly this far around the hero; the floor for the view radius. */
const MIN_VIEW = 1100;

/** Radii for one frame, all ground distances from the camera focus to a chunk's content bounds. */
export interface StreamRadii {
  /** The view's own ground footprint: a chunk appearing this close is visible pop-in. */
  view: number;
  /** Built chunks this close are drawn. */
  show: number;
  /** Drawn chunks stay drawn until they are this far: hysteresis so a walk along an edge never flickers. */
  hide: number;
  /** Chunks this close are built (models loaded, buffers made) ahead of being seen. */
  build: number;
  /** Built chunks this far have their buffers released; rebuilt when they come back inside `build`. */
  release: number;
}

export function streamRadii(footprint: number): StreamRadii {
  const show = Math.max(MIN_VIEW, footprint + TALL_REACH);
  // About a chunk between building and releasing, so walking back and forth over one border never
  // rebuilds; building 900 ahead of the view gives a hero (220 units a second) four seconds to
  // fetch a model the chunk is the first to use.
  return { view: footprint, show, hide: show + 400, build: show + 900, release: show + 1800 };
}

export type ChunkAction = 'build' | 'release' | 'show' | 'hide' | 'none';

export function chunkAction(built: boolean, visible: boolean, distance: number, r: StreamRadii): ChunkAction {
  if (!built) return distance <= r.build ? 'build' : 'none';
  if (distance > r.release) return 'release';
  if (!visible && distance <= r.show) return 'show';
  if (visible && distance > r.hide) return 'hide';
  return 'none';
}

/**
 * Items bucketed by chunk, for lists every frame would otherwise walk whole (the world's lights and
 * fires). `near` gathers the indices of the items in chunks within `radius` of a point, into a
 * caller's array, in the items' original order so a stable per-item seed or key stays stable.
 */
export class ChunkBuckets {
  private readonly buckets = new Map<number, number[]>();
  private readonly rects = new Map<number, Rect>();

  constructor(points: readonly { x: number; y: number }[], size = CHUNK_SIZE) {
    points.forEach((p, i) => {
      const cx = chunkCoord(p.x, size);
      const cy = chunkCoord(p.y, size);
      const key = chunkKey(cx, cy);
      let list = this.buckets.get(key);
      if (!list) {
        list = [];
        this.buckets.set(key, list);
        this.rects.set(key, chunkRect(cx, cy, size));
      }
      list.push(i);
    });
  }

  /** Writes the indices near (x, y) into `out`, sorted, and returns how many. */
  near(x: number, y: number, radius: number, out: number[]): number {
    out.length = 0;
    for (const [key, list] of this.buckets) {
      const r = this.rects.get(key);
      if (r && rectDistance(r, x, y) <= radius) for (const i of list) out.push(i);
    }
    out.sort((a, b) => a - b);
    return out.length;
  }
}

/**
 * Re-gathers a near list only when the focus has moved `slack` since the last gather; the caller
 * widens its radius by the same slack, so nothing that matters is missed in between.
 */
export class NearCache {
  readonly indices: number[] = [];
  private lastX = Infinity;
  private lastY = Infinity;
  private lastRadius = -1;

  constructor(
    private readonly buckets: ChunkBuckets,
    private readonly slack = 150,
  ) {}

  update(x: number, y: number, radius: number): readonly number[] {
    if (Math.hypot(x - this.lastX, y - this.lastY) > this.slack || radius !== this.lastRadius) {
      this.lastX = x;
      this.lastY = y;
      this.lastRadius = radius;
      this.buckets.near(x, y, radius + this.slack, this.indices);
    }
    return this.indices;
  }
}
