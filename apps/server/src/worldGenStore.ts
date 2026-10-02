import { isWorldGenValues, type WorldGenValues } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { events } from './eventLog.js';

/**
 * The generation numbers the public world was built with, by its seed (docs/features/world-map.md,
 * "Generation settings"). A world copy keeps the numbers it was made with; the public world's are
 * stored so a restart builds the same world again instead of taking whatever live tuning holds now.
 * Party worlds end with their party, which a restart ends too, so they are not stored.
 */
export class WorldGenStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_gen (
        seed INTEGER PRIMARY KEY,
        gen_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** The numbers stored for a public seed, or null when none are (or they no longer pass the ranges). */
  publicGen(seed: number): WorldGenValues | null {
    const r = this.db.prepare('SELECT gen_json FROM world_gen WHERE seed = ?').get(seed);
    const json = r?.gen_json;
    if (typeof json !== 'string') return null;
    try {
      const v: unknown = JSON.parse(json);
      if (isWorldGenValues(v)) return v;
    } catch {
      // Reported below with the out-of-range case.
    }
    events.warn('server', `[world] the stored generation numbers of public seed ${seed} are unreadable or out of range; the public world takes the current ones`);
    return null;
  }

  savePublic(seed: number, gen: WorldGenValues): void {
    this.db
      .prepare('INSERT INTO world_gen (seed, gen_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(seed) DO UPDATE SET gen_json = excluded.gen_json, updated_at = excluded.updated_at')
      .run(seed, JSON.stringify(gen), Date.now());
  }
}
