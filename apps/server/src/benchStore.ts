import { BENCH_LIMITS, EquippedTally, equippedSpells, isClassId, type BenchPick, type BenchSpell, type PlayerSave, type PopularSigil } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { events } from './eventLog.js';

/** Saves read per step of the boot count; each step parses this many, then yields to the game loop. */
export const SEED_CHUNK = 50;

function pickOf(r: Record<string, unknown>): BenchPick | null {
  const { id, text, class_id, multicast, account, at } = r;
  if (typeof id !== 'number' || typeof text !== 'string' || !isClassId(class_id) || typeof multicast !== 'number' || typeof account !== 'string' || typeof at !== 'number') return null;
  return { id, text, classId: class_id, multicast, account, at };
}

/**
 * The balance bench's server half (docs/features/live-tuning.md, "The balance bench"): admin picks
 * shared between admins, with who added each, and how many characters have each sigil equipped.
 * The count is a tally kept as characters are saved and deleted (AccountStore calls in with the
 * save it is writing), seeded once at boot in small steps, so answering the bench parses nothing.
 */
export class BenchStore {
  private readonly tally = new EquippedTally();
  private changedAt: number;
  private ready = false;
  private seeding: Promise<void> | null = null;
  /** Characters deleted while the boot count runs, so a row it reads later is not counted back in. */
  private readonly gone = new Set<number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.changedAt = now();
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
      .prepare('SELECT id, text, class_id, multicast, account, at FROM bench_picks ORDER BY id')
      .all()
      .flatMap((r) => pickOf(r) ?? []);
  }

  /** The new pick, or why not: the same spell is already listed, or the list is full. */
  add(spell: BenchSpell, by: { account: string; token: string | null }): BenchPick | 'duplicate' | 'full' {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM bench_picks').get();
    if (typeof count?.n === 'number' && count.n >= BENCH_LIMITS.picks) return 'full';
    const at = this.now();
    // The token's name is kept for the record but not sent back; the staff log names it too.
    const r = this.db.prepare('INSERT INTO bench_picks (text, class_id, multicast, account, token, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(spell.text, spell.classId, spell.multicast, by.account, by.token, at);
    if (Number(r.changes) === 0) return 'duplicate';
    return { id: Number(r.lastInsertRowid), ...spell, account: by.account, at };
  }

  pick(id: number): BenchPick | null {
    const row = this.db.prepare('SELECT id, text, class_id, multicast, account, at FROM bench_picks WHERE id = ?').get(id);
    return row ? pickOf(row) : null;
  }

  /** The removed pick, or null when there is none with that id. */
  remove(id: number): BenchPick | null {
    const pick = this.pick(id);
    if (!pick) return null;
    this.db.prepare('DELETE FROM bench_picks WHERE id = ?').run(id);
    return pick;
  }

  /** A character's save was written: what it has equipped replaces what it counted before. */
  noteSave(characterId: number, save: PlayerSave): void {
    this.tally.set(characterId, save.classId, equippedSpells(save));
    this.changedAt = this.now();
  }

  noteDelete(characterId: number): void {
    this.tally.remove(characterId);
    if (!this.ready) this.gone.add(characterId);
    this.changedAt = this.now();
  }

  /**
   * Counts the saves already stored, a few at a time with a yield between steps, by id so a step
   * never holds a statement open across a yield. A character saved or deleted meanwhile is already
   * up to date in the tally, so its row is skipped. Safe to call again: it runs once.
   */
  seed(): Promise<void> {
    this.seeding ??= this.runSeed();
    return this.seeding;
  }

  private async runSeed(): Promise<void> {
    const started = performance.now();
    const page = this.db.prepare('SELECT id, class_id, save_json FROM characters WHERE id > ? AND save_json IS NOT NULL ORDER BY id LIMIT ?');
    let after = 0;
    let counted = 0;
    for (;;) {
      const rows = page.all(after, SEED_CHUNK);
      for (const r of rows) {
        if (typeof r.id !== 'number') continue;
        after = r.id;
        if (this.tally.has(r.id) || this.gone.has(r.id) || !isClassId(r.class_id) || typeof r.save_json !== 'string') continue;
        let save: unknown;
        try {
          save = JSON.parse(r.save_json);
        } catch {
          // A save that does not parse is reported where it loads; here it only goes uncounted.
          continue;
        }
        this.tally.set(r.id, r.class_id, equippedSpells(save));
        counted++;
      }
      if (rows.length < SEED_CHUNK) break;
      await setImmediate();
    }
    this.ready = true;
    this.gone.clear();
    this.changedAt = this.now();
    events.log('server', `[bench] counted equipped sigils of ${counted} saves in ${Math.round(performance.now() - started)} ms`);
  }

  /** The most equipped sigils, from the tally; nothing is read or parsed. */
  mostEquipped(): { at: number; sigils: PopularSigil[]; ready: boolean } {
    return { at: this.changedAt, sigils: this.tally.top(), ready: this.ready };
  }
}
