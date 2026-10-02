import { resolveWorldGen, worldGenOverrides, WORLD_GEN_KEYS, type WorldGenValues } from '@rune/shared';
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

  /**
   * The numbers stored for a public seed, or null when none are. Read number by number: one a later
   * range refuses (or a broken rule between two) goes back to its default and is reported, and the
   * rest are kept, so the world stays as close to the one built as the ranges allow.
   */
  publicGen(seed: number): WorldGenValues | null {
    const r = this.db.prepare('SELECT gen_json FROM world_gen WHERE seed = ?').get(seed);
    const json = r?.gen_json;
    if (typeof json !== 'string') return null;
    let v: unknown;
    try {
      v = JSON.parse(json);
    } catch {
      events.warn('server', `[world] the stored generation numbers of public seed ${seed} are unreadable; the public world takes the code defaults`);
      return {};
    }
    const full = resolveWorldGen(v);
    const stored = typeof v === 'object' && v !== null ? Object.entries(v) : [];
    const dropped = stored.filter(([k, n]) => !WORLD_GEN_KEYS.some((key) => key === k && full[key] === n)).map(([k, n]) => `${k} ${String(n)}`);
    if (dropped.length > 0) events.warn('server', `[world] stored generation numbers of public seed ${seed} left at their defaults: ${dropped.join(', ')}`);
    return worldGenOverrides(full);
  }

  savePublic(seed: number, gen: WorldGenValues): void {
    this.db
      .prepare('INSERT INTO world_gen (seed, gen_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(seed) DO UPDATE SET gen_json = excluded.gen_json, updated_at = excluded.updated_at')
      .run(seed, JSON.stringify(gen), Date.now());
  }
}
