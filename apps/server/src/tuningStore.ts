import { parseTuningOverrides, type TuningKind, type TuningOverrides } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Admin monster and minion overrides, one row per type. Its own table and file so the account and
 * save code in accounts.ts stays untouched; AccountStore only hands over its database.
 */
export class TuningStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tuning_overrides (
        kind TEXT NOT NULL,
        type_id TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, type_id)
      );
    `);
  }

  /** Every row is validated again, so a limit lowered since it was saved cannot let a bad number through. */
  load(): TuningOverrides {
    const raw: Record<TuningKind, Record<string, unknown>> = { monsters: {}, minions: {} };
    for (const r of this.db.prepare('SELECT kind, type_id, patch_json FROM tuning_overrides').all()) {
      const kind = r.kind;
      const typeId = r.type_id;
      const json = r.patch_json;
      if ((kind !== 'monsters' && kind !== 'minions') || typeof typeId !== 'string' || typeof json !== 'string') continue;
      try {
        const patch: unknown = JSON.parse(json);
        raw[kind][typeId] = patch;
      } catch {
        console.warn(`[tuning] ignoring unreadable ${kind} override for ${typeId}`);
      }
    }
    return parseTuningOverrides(raw, (why) => console.warn(`[tuning] ignoring stored override: ${why}`));
  }

  /** `null` resets the type to its code defaults. */
  save(kind: TuningKind, typeId: string, patch: object | null): void {
    if (patch === null) this.db.prepare('DELETE FROM tuning_overrides WHERE kind = ? AND type_id = ?').run(kind, typeId);
    else
      this.db
        .prepare('INSERT INTO tuning_overrides (kind, type_id, patch_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, type_id) DO UPDATE SET patch_json = excluded.patch_json, updated_at = excluded.updated_at')
        .run(kind, typeId, JSON.stringify(patch), Date.now());
  }
}
