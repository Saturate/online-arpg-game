import type { Vec2, WorldMap } from '@rune/shared';

/** Another player as drawn this frame, for a right-click on them. */
export interface TownPlayer {
  x: number;
  y: number;
  r: number;
  name: string;
  tag: string | null;
}

/** Whether a ground point is in a safe area: a safe map, or one of a map's town rectangles. */
export function inSafeArea(def: Pick<WorldMap, 'safe' | 'safeZones'>, p: Vec2): boolean {
  return def.safe || (def.safeZones ?? []).some((z) => p.x >= z.x && p.y >= z.y && p.x <= z.x + z.w && p.y <= z.y + z.h);
}

/**
 * The player under a right-click, only inside a safe area (town): nobody casts there, so the right
 * button is free to open their menu. Outside town it always casts, as before. The pick reaches a
 * little past the body, as the monster pick does, since players move.
 */
export function playerInTownAt(def: Pick<WorldMap, 'safe' | 'safeZones'>, players: readonly TownPlayer[], p: Vec2): TownPlayer | null {
  if (!inSafeArea(def, p)) return null;
  let best: TownPlayer | null = null;
  let bestD = Infinity;
  for (const pl of players) {
    const d = Math.hypot(pl.x - p.x, pl.y - p.y) - pl.r;
    if (d < 22 && d < bestD) {
      best = pl;
      bestD = d;
    }
  }
  return best;
}
