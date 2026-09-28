import { ACCOUNT_RULES, isClassId, type CharacterSummary, type ClassId, type PlayerSave } from '@rune/shared';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 2^15 with r=8 is about 32 MiB and 50 ms per hash: slow for guessing, fine for a login. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Account {
  id: number;
  username: string;
}

export interface StoredCharacter extends CharacterSummary {
  accountId: number;
  save: PlayerSave | null;
}

function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((ok, fail) => {
    scrypt(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? fail(err) : ok(key)));
  });
}

/** Only token hashes are stored, so a leaked database cannot be replayed as live sessions. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function row(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Saves are written only by this server from `Simulation.exportPlayer`, so a shape check is enough:
 * it catches a save from an older build, not a hostile one.
 */
function isPlayerSave(v: unknown, classId: ClassId): v is PlayerSave {
  return (
    isRecord(v) &&
    v.classId === classId &&
    typeof v.name === 'string' &&
    Array.isArray(v.items) &&
    Array.isArray(v.inventory) &&
    Array.isArray(v.sigils) &&
    Array.isArray(v.warband) &&
    isRecord(v.gear) &&
    typeof v.stance === 'string'
  );
}

function parseSave(json: string, classId: ClassId): PlayerSave | null {
  try {
    const v: unknown = JSON.parse(json);
    return isPlayerSave(v, classId) ? v : null;
  } catch {
    return null;
  }
}

export class AccountStore {
  private readonly db: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? 'data/rune.db') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt BLOB NOT NULL,
        password_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS characters (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        class_id TEXT NOT NULL,
        save_json TEXT,
        created_at INTEGER NOT NULL,
        played_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS characters_account ON characters(account_id);
    `);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  close(): void {
    this.db.close();
  }

  async register(username: string, password: string): Promise<Account | 'taken'> {
    if (this.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username)) return 'taken';
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt);
    // Re-checked after the await: two registrations for the same name can race through the hash.
    try {
      const res = this.db.prepare('INSERT INTO accounts (username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?)').run(username, salt, hash, Date.now());
      return { id: num(res.lastInsertRowid), username };
    } catch {
      return 'taken';
    }
  }

  async verify(username: string, password: string): Promise<Account | null> {
    const r = row(this.db.prepare('SELECT id, username, password_salt, password_hash FROM accounts WHERE username = ?').get(username));
    const salt = r?.password_salt;
    const stored = r?.password_hash;
    if (!r || !(salt instanceof Uint8Array) || !(stored instanceof Uint8Array)) {
      // Hash anyway so an unknown username takes as long as a wrong password and cannot be probed by timing.
      await hashPassword(password, randomBytes(16));
      return null;
    }
    const hash = await hashPassword(password, Buffer.from(salt));
    return hash.length === stored.length && timingSafeEqual(hash, stored) ? { id: num(r.id), username: str(r.username) } : null;
  }

  createSession(accountId: number): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), accountId, Date.now() + SESSION_DAYS * DAY_MS);
    return token;
  }

  accountForToken(token: string): Account | null {
    const r = row(
      this.db
        .prepare('SELECT a.id, a.username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?')
        .get(tokenHash(token), Date.now()),
    );
    return r ? { id: num(r.id), username: str(r.username) } : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  listCharacters(accountId: number): CharacterSummary[] {
    return this.db
      .prepare('SELECT id, name, class_id, created_at, played_at FROM characters WHERE account_id = ? ORDER BY played_at DESC, id')
      .all(accountId)
      .flatMap((raw) => {
        const r = row(raw);
        const classId = r?.class_id;
        if (!r || !isClassId(classId)) return [];
        return [{ id: num(r.id), name: str(r.name), classId, createdAt: num(r.created_at), playedAt: num(r.played_at) }];
      });
  }

  createCharacter(accountId: number, name: string, classId: ClassId): CharacterSummary | 'taken' | 'limit' {
    const count = num(row(this.db.prepare('SELECT COUNT(*) AS n FROM characters WHERE account_id = ?').get(accountId))?.n);
    if (count >= ACCOUNT_RULES.maxCharacters) return 'limit';
    const createdAt = Date.now();
    try {
      const res = this.db.prepare('INSERT INTO characters (account_id, name, class_id, created_at) VALUES (?, ?, ?, ?)').run(accountId, name, classId, createdAt);
      return { id: num(res.lastInsertRowid), name, classId, createdAt, playedAt: 0 };
    } catch {
      return 'taken';
    }
  }

  /** Scoped by account so one player can never read or delete another's character by guessing ids. */
  deleteCharacter(accountId: number, characterId: number): boolean {
    return num(this.db.prepare('DELETE FROM characters WHERE id = ? AND account_id = ?').run(characterId, accountId).changes) > 0;
  }

  loadCharacter(accountId: number, characterId: number): StoredCharacter | null {
    const r = row(this.db.prepare('SELECT id, account_id, name, class_id, save_json, created_at, played_at FROM characters WHERE id = ? AND account_id = ?').get(characterId, accountId));
    const classId = r?.class_id;
    if (!r || !isClassId(classId)) return null;
    const json = r.save_json;
    const save = typeof json === 'string' ? parseSave(json, classId) : null;
    if (typeof json === 'string' && !save) console.warn(`character ${characterId} has an unreadable save, starting fresh`);
    return { id: num(r.id), accountId: num(r.account_id), name: str(r.name), classId, createdAt: num(r.created_at), playedAt: num(r.played_at), save };
  }

  saveCharacter(characterId: number, save: PlayerSave): void {
    this.db.prepare('UPDATE characters SET save_json = ?, played_at = ? WHERE id = ?').run(JSON.stringify(save), Date.now(), characterId);
  }
}
