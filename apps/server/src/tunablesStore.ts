import { parseTunableValues, TUNING_HISTORY_LIMIT, withoutBrokenAffixTables, type TunableHistoryEntry, type TunableValues } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { events } from './eventLog.js';

/** One number changing: null on either side is the code default. */
export interface TunableChange {
  path: string;
  old: number | null;
  new: number | null;
}

/** Who made a change, for the history: the account, and the API token's name when a script did. */
export interface TuningAuthor {
  account: string;
  token: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function entryOf(r: Record<string, unknown>): TunableHistoryEntry | null {
  const { id, path, old_value, new_value, account, token, at, revert_of } = r;
  if (typeof id !== 'number' || typeof path !== 'string' || typeof account !== 'string' || typeof at !== 'number') return null;
  return { id, path, old: num(old_value), new: num(new_value), account, token: typeof token === 'string' ? token : null, at, revertOf: num(revert_of) };
}

/**
 * Live tuning overrides (docs/features/live-tuning.md): one row per overridden path, and every
 * change ever made with who made it, so any change can be reverted. Its own tables and file so the
 * account code in accounts.ts stays untouched; AccountStore only hands over its database.
 */
export class TunablesStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tunable_values (
        path TEXT PRIMARY KEY,
        value REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tunable_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        old_value REAL,
        new_value REAL,
        account TEXT NOT NULL,
        token TEXT,
        at INTEGER NOT NULL,
        revert_of INTEGER
      );
    `);
  }

  /**
   * Every row is validated again, so a range narrowed since it was saved cannot let a bad number
   * through. An affix table those drops leave broken loses its other rows too, logged and deleted,
   * so the stored set is the one in force and no hidden value comes back with a later change.
   */
  load(): TunableValues {
    const raw: Record<string, unknown> = {};
    for (const r of this.db.prepare('SELECT path, value FROM tunable_values').all()) if (typeof r.path === 'string') raw[r.path] = r.value;
    const parsed = parseTunableValues(raw, (why) => events.warn('server', `[tuning] ignoring stored override: ${why}`));
    const { kept, dropped } = withoutBrokenAffixTables(parsed);
    const remove = this.db.prepare('DELETE FROM tunable_values WHERE path = ?');
    for (const d of dropped) {
      events.warn('server', `[tuning] dropping stored overrides ${d.paths.join(', ')}: ${d.why}`);
      for (const p of d.paths) remove.run(p);
    }
    return kept;
  }

  /** Writes the values and one history row per change in one transaction; returns the rows. */
  commit(changes: readonly TunableChange[], by: TuningAuthor, revertOf: number | null = null): TunableHistoryEntry[] {
    const at = Date.now();
    const out: TunableHistoryEntry[] = [];
    const upsert = this.db.prepare('INSERT INTO tunable_values (path, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const remove = this.db.prepare('DELETE FROM tunable_values WHERE path = ?');
    const log = this.db.prepare('INSERT INTO tunable_history (path, old_value, new_value, account, token, at, revert_of) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const c of changes) {
        if (c.new === null) remove.run(c.path);
        else upsert.run(c.path, c.new, at);
        const r = log.run(c.path, c.old, c.new, by.account, by.token, at, revertOf);
        out.push({ id: Number(r.lastInsertRowid), path: c.path, old: c.old, new: c.new, account: by.account, token: by.token, at, revertOf });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  /** Newest first. */
  history(limit: number = TUNING_HISTORY_LIMIT.default): TunableHistoryEntry[] {
    const n = Math.max(1, Math.min(TUNING_HISTORY_LIMIT.max, Math.floor(limit)));
    return this.db
      .prepare('SELECT id, path, old_value, new_value, account, token, at, revert_of FROM tunable_history ORDER BY id DESC LIMIT ?')
      .all(n)
      .flatMap((r) => entryOf(r) ?? []);
  }

  entry(id: number): TunableHistoryEntry | null {
    const r = this.db.prepare('SELECT id, path, old_value, new_value, account, token, at, revert_of FROM tunable_history WHERE id = ?').get(id);
    return r ? entryOf(r) : null;
  }
}
