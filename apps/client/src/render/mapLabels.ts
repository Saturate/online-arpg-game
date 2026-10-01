/** Where the minimap and the world map write region names, and which names fit without overlapping. */

export interface LabelEdge<R extends string = string> {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly length: number;
  readonly region: R;
}

export interface RegionLabel<R extends string = string> {
  region: R;
  x: number;
  y: number;
}

/** Points along each road segment a label may sit on; the ends are left out, since a fork there can belong to the next region. */
const ALONG = [0.25, 0.5, 0.75] as const;

/**
 * One spot per region for its name: on one of its own roads, as near as possible to the middle of
 * its road network (the length-weighted centroid), and at least `margin` units outside the town so
 * the home region's name does not sit on the town's. A region's roads can bend round its centroid,
 * so the centroid itself can lie in the next region; snapping to the road keeps the name inside.
 */
export function regionLabels<R extends string>(edges: readonly LabelEdge<R>[], town: { x: number; y: number; w: number; h: number }, margin = 500): RegionLabel<R>[] {
  const sums = new Map<R, { x: number; y: number; w: number }>();
  for (const e of edges) {
    const s = sums.get(e.region) ?? { x: 0, y: 0, w: 0 };
    s.x += ((e.ax + e.bx) / 2) * e.length;
    s.y += ((e.ay + e.by) / 2) * e.length;
    s.w += e.length;
    sums.set(e.region, s);
  }
  const out: RegionLabel<R>[] = [];
  for (const [region, s] of sums) {
    if (s.w <= 0) continue;
    const cx = s.x / s.w;
    const cy = s.y / s.w;
    let best: RegionLabel<R> | null = null;
    let bestD = Infinity;
    for (const e of edges) {
      if (e.region !== region) continue;
      for (const t of ALONG) {
        const x = e.ax + (e.bx - e.ax) * t;
        const y = e.ay + (e.by - e.ay) * t;
        if (rectDistance(x, y, town) < margin) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestD) {
          bestD = d;
          best = { region, x, y };
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

function rectDistance(x: number, y: number, r: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export interface LabelBox {
  /** Centre on the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher wins a clash: the region you stand in, then discovered ones. */
  priority: number;
}

/**
 * The labels to draw, highest priority first, each skipped when it would overlap one already kept
 * (with `pad` pixels between) or run past the canvas edge. Returns indices into `boxes`.
 */
export function fitLabels(boxes: readonly LabelBox[], width: number, height: number, pad = 2): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => (boxes[b]?.priority ?? 0) - (boxes[a]?.priority ?? 0));
  const kept: number[] = [];
  for (const i of order) {
    const b = boxes[i];
    if (!b) continue;
    if (b.x - b.w / 2 < 0 || b.y - b.h / 2 < 0 || b.x + b.w / 2 > width || b.y + b.h / 2 > height) continue;
    const clash = kept.some((j) => {
      const k = boxes[j];
      return k !== undefined && Math.abs(k.x - b.x) * 2 < k.w + b.w + pad * 2 && Math.abs(k.y - b.y) * 2 < k.h + b.h + pad * 2;
    });
    if (!clash) kept.push(i);
  }
  return kept;
}
