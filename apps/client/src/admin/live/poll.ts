import type { LiveRegionGrid, LiveWorld } from '@rune/shared';

/** The slowest a rate-limited page polls; it goes back to its own interval on the next success. */
export const MAX_POLL_MS = 30_000;

/** Doubles the wait while the server answers 429, up to MAX_POLL_MS; any other answer resets it. */
export function nextPollDelay(current: number, base: number, rateLimited: boolean): number {
  return rateLimited ? Math.min(MAX_POLL_MS, Math.max(base, current) * 2) : base;
}

/** Region grids by world copy, kept so the server sends each one once (`have` on `/api/admin/live`). */
export class RegionCache {
  private readonly grids = new Map<string, { hash: string; grid: LiveRegionGrid }>();

  /** The `have` query value, or '' when nothing is held. */
  have(): string {
    return [...this.grids].map(([game, g]) => `${game}:${g.hash}`).join(',');
  }

  /** Stores grids that came with the reply, fills in held ones, and forgets copies that closed. */
  resolve(worlds: readonly LiveWorld[]): LiveWorld[] {
    const open = new Set(worlds.map((w) => w.game));
    for (const game of this.grids.keys()) if (!open.has(game)) this.grids.delete(game);
    return worlds.map((w) => {
      if (w.planHash === null) return w;
      if (w.regions) {
        this.grids.set(w.game, { hash: w.planHash, grid: w.regions });
        return w;
      }
      const held = this.grids.get(w.game);
      return held && held.hash === w.planHash ? { ...w, regions: held.grid } : w;
    });
  }
}
