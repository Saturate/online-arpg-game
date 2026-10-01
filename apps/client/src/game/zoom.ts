import { DEFAULT_SERVER_SETTINGS, type ZoomSettings } from '@rune/shared';

/** Updated from the server's 'zoom' message; defaults until it arrives. */
export const zoomLimits: ZoomSettings = {
  zoomDefault: DEFAULT_SERVER_SETTINGS.zoomDefault,
  zoomDungeon: DEFAULT_SERVER_SETTINGS.zoomDungeon,
  zoomMin: DEFAULT_SERVER_SETTINGS.zoomMin,
  zoomMax: DEFAULT_SERVER_SETTINGS.zoomMax,
};

/** One wheel notch; ten notches take the default range end to end. */
export const ZOOM_STEP = 1.06;

/** The player's own zoom is kept as a factor on the area's default, so it carries between town and dungeons. */
export const ZOOM_SCALE_RANGE = { min: 0.25, max: 4 } as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The admin's limits, ordered even if a stale or odd message slipped through. */
function bounds(l: ZoomSettings): { lo: number; hi: number } {
  return { lo: Math.min(l.zoomMin, l.zoomMax), hi: Math.max(l.zoomMin, l.zoomMax) };
}

/** The camera zoom for this area and the player's factor, always inside the admin's limits. */
export function effectiveZoom(l: ZoomSettings, dungeon: boolean, scale: number): number {
  const { lo, hi } = bounds(l);
  const base = dungeon ? l.zoomDungeon : l.zoomDefault;
  return clamp(base * (Number.isFinite(scale) ? scale : 1), lo, hi);
}

/**
 * The new factor after one wheel step in (`step` -1) or out (1). It is taken from the zoom actually
 * shown, so pushing past a limit does not pile up factor that has to be scrolled back first.
 */
export function stepZoomScale(l: ZoomSettings, dungeon: boolean, scale: number, step: 1 | -1): number {
  const base = dungeon ? l.zoomDungeon : l.zoomDefault;
  const shown = effectiveZoom(l, dungeon, scale);
  const { lo, hi } = bounds(l);
  const next = clamp(step < 0 ? shown * ZOOM_STEP : shown / ZOOM_STEP, lo, hi);
  return clamp(base > 0 ? next / base : 1, ZOOM_SCALE_RANGE.min, ZOOM_SCALE_RANGE.max);
}
