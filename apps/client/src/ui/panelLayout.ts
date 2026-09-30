/**
 * Pure layout rules for movable panels: grid and edge snapping while dragging, and keeping a panel
 * on screen. Everything is in screen pixels (after UI scale), so a saved spot survives a change of
 * interface size. Kept free of React and the DOM so it can be tested.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect extends Point, Size {}

/** Panels land on this grid when nothing is close enough to snap to. */
export const PANEL_GRID = 8;
/** Space left between a panel and the screen edge or a neighbour it snaps to. */
export const PANEL_GAP = 8;
/** How close an edge has to come before it pulls the panel in. */
export const SNAP_DISTANCE = 12;

/** A panel stays fully on screen; one larger than the screen keeps its top left corner visible. */
export function clampToViewport(p: Point, size: Size, viewport: Size): Point {
  return {
    x: Math.max(0, Math.min(p.x, viewport.w - size.w)),
    y: Math.max(0, Math.min(p.y, viewport.h - size.h)),
  };
}

export function snapToGrid(v: number, grid = PANEL_GRID): number {
  return Math.round(v / grid) * grid;
}

/** True when two spans overlap or come within `slack` of each other. */
function near(a0: number, a1: number, b0: number, b1: number, slack: number): boolean {
  return a0 < b1 + slack && a1 > b0 - slack;
}

/**
 * Where one axis wants to go: the nearest candidate within SNAP_DISTANCE, or the grid. Candidates
 * are the two screen edges (inset by the gap) and, for each neighbour beside it on the other axis,
 * sitting against either side of it or lining up with its near and far edges.
 */
function snapAxis(pos: number, len: number, screen: number, neighbours: readonly { start: number; end: number }[]): number {
  const candidates = [PANEL_GAP, screen - len - PANEL_GAP];
  for (const n of neighbours) {
    candidates.push(n.end + PANEL_GAP, n.start - len - PANEL_GAP, n.start, n.end - len);
  }
  let best: number | null = null;
  let bestDist = SNAP_DISTANCE + 1;
  for (const c of candidates) {
    const d = Math.abs(c - pos);
    if (d <= SNAP_DISTANCE && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best ?? snapToGrid(pos);
}

/**
 * The position a dragged panel settles at: snapped on each axis to the screen edges or the open
 * panels around it, otherwise to the grid, and always clamped on screen.
 */
export function snapPanel(rect: Rect, others: readonly Rect[], viewport: Size): Point {
  const slack = PANEL_GAP + SNAP_DISTANCE;
  // Only panels level with this one pull it sideways, and only panels above or below it pull it
  // up or down; a window across the screen should not tug on it.
  const besideX = others.filter((o) => near(rect.y, rect.y + rect.h, o.y, o.y + o.h, slack)).map((o) => ({ start: o.x, end: o.x + o.w }));
  const besideY = others.filter((o) => near(rect.x, rect.x + rect.w, o.x, o.x + o.w, slack)).map((o) => ({ start: o.y, end: o.y + o.h }));
  const snapped = {
    x: snapAxis(rect.x, rect.w, viewport.w, besideX),
    y: snapAxis(rect.y, rect.h, viewport.h, besideY),
  };
  return clampToViewport(snapped, rect, viewport);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Saved positions; anything malformed is dropped, so a bad entry only resets that panel. */
export function parsePanelPositions(v: unknown): Record<string, Point> {
  const out: Record<string, Point> = {};
  if (!isRecord(v)) return out;
  for (const [id, p] of Object.entries(v)) {
    if (!isRecord(p)) continue;
    const { x, y } = p;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) out[id] = { x, y };
  }
  return out;
}

export interface PanelStore {
  unlocked: boolean;
  positions: Record<string, Point>;
}

/** The stored { unlocked, positions }; corrupt storage means locked, with every panel at its default. */
export function parsePanelStore(raw: string | null): PanelStore {
  if (!raw) return { unlocked: false, positions: {} };
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v)) return { unlocked: false, positions: {} };
    return { unlocked: v.unlocked === true, positions: parsePanelPositions(v.positions) };
  } catch {
    return { unlocked: false, positions: {} };
  }
}
