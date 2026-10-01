import { BENCH_LIMITS, isClassId, mostEquipped, type BenchPick, type BenchSpell, type PopularSigil } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { events } from './eventLog.js';

/** How long the most-equipped list is served before the saves are counted again. */
export const POPULAR_TTL_MS = 3 * 60_000;

function pickOf(r: Record<string, unknown>): BenchPick | null {
  const { id, text, class_id, multicast, account, token, at } = r;
  if (typeof id !== 'number' || typeof text !== 'string' || !isClassId(class_id) || typeof multicast !== 'number' || typeof account !== 'string' || typeof at !== 'number') return null;
  return { id, text, classId: class_id, multicast, account, token: typeof token === 'string' ? token : null, at };
}

/**
 * The balance bench's server half (docs/features/live-tuning.md, "The balance bench"): admin picks
 * shared between admins, with who added each, and the sigils most equipped in the saves. Its own
 * table, like the tuning stores; AccountStore only hands over its database.
 */
export class BenchStore {
  private popular: { at: number; sigils: PopularSigil[] } | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bench_picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        class_id TEXT NOT NULL,
        multicast INTEGER NOT NULL,
        account TEXT NOT NULL,
        token TEXT,
        at INTEGER NOT NULL,
        UNIQUE (text, class_id, multicast)
      );
    `);
  }

  /** Oldest first, so the list reads in the order admins built it. */
  picks(): BenchPick[] {
    return this.db
      .prepare('SELECT id, text, class_id, multicast, account, token, at FROM bench_picks ORDER BY id')
      .all()
      .flatMap((r) => pickOf(r) ?? []);
  }

  /** The new pick, or why not: the same spell is already listed, or the list is full. */
  add(spell: BenchSpell, by: { account: string; token: string | null }): BenchPick | 'duplicate' | 'full' {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM bench_picks').get();
    if (typeof count?.n === 'number' && count.n >= BENCH_LIMITS.picks) return 'full';
    const at = this.now();
    const r = this.db.prepare('INSERT INTO bench_picks (text, class_id, multicast, account, token, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(spell.text, spell.classId, spell.multicast, by.account, by.token, at);
    if (Number(r.changes) === 0) return 'duplicate';
    return { id: Number(r.lastInsertRowid), ...spell, account: by.account, token: by.token, at };
  }

  /** The removed pick, or null when there is none with that id. */
  remove(id: number): BenchPick | null {
    const row = this.db.prepare('SELECT id, text, class_id, multicast, account, token, at FROM bench_picks WHERE id = ?').get(id);
    const pick = row ? pickOf(row) : null;
    if (!pick) return null;
    this.db.prepare('DELETE FROM bench_picks WHERE id = ?').run(id);
    return pick;
  }

  /**
   * The sigils most equipped across every character's save, counted at most every POPULAR_TTL_MS.
   * Only rune text, class and a count leave here: the query reads no names.
   */
  mostEquipped(): { at: number; sigils: PopularSigil[] } {
    const now = this.now();
    if (this.popular && now - this.popular.at < POPULAR_TTL_MS) return this.popular;
    const started = performance.now();
    const rows = this.db.prepare('SELECT class_id, save_json FROM characters WHERE save_json IS NOT NULL').iterate();
    const saves = (function* () {
      for (const r of rows) {
        if (typeof r.save_json !== 'string') continue;
        let save: unknown;
        try {
          save = JSON.parse(r.save_json);
        } catch {
          // A save that does not parse is reported where it loads; here it only goes uncounted.
          continue;
        }
        yield { classId: r.class_id, save };
      }
    })();
    this.popular = { at: now, sigils: mostEquipped(saves) };
    const ms = performance.now() - started;
    if (ms > 200) events.warn('server', `[bench] counting equipped sigils took ${Math.round(ms)} ms`);
    return this.popular;
  }
}
