import { ADMIN_TOKEN_PATTERN, isAssignableRole, isTokenScope, type AdminTokenInfo, type AssignableRole, type TokenScope } from '@rune/shared';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Admin API tokens, one row each in `admin_tokens`. Only a SHA-256 hash of the secret part is
 * stored: the secret is 32 random bytes, so a fast hash is enough (nothing to guess), and a leaked
 * database or backup cannot be replayed. The id in front of the secret finds the row, and the hashes
 * are compared in constant time. Rows go with their account (the foreign key cascades) and are
 * deleted when it is banned, as sessions are.
 */

export interface TokenCaller {
  tokenId: string;
  name: string;
  scopes: readonly TokenScope[];
  account: { id: number; username: string; role: AssignableRole };
}

function secretHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
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

function scopesOf(json: unknown): TokenScope[] {
  if (typeof json !== 'string') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isTokenScope) : [];
  } catch {
    return [];
  }
}

export class AdminTokenStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_tokens (
        id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        secret_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS admin_tokens_account ON admin_tokens(account_id);
    `);
    db.prepare('DELETE FROM admin_tokens WHERE expires_at < ?').run(Date.now());
  }

  count(accountId: number): number {
    return num(row(this.db.prepare('SELECT COUNT(*) AS n FROM admin_tokens WHERE account_id = ? AND expires_at > ?').get(accountId, Date.now()))?.n);
  }

  create(accountId: number, name: string, scopes: readonly TokenScope[], expiresAt: number): { token: string; id: string } {
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO admin_tokens (id, account_id, name, scopes_json, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, accountId, name, JSON.stringify(scopes), secretHash(secret), Date.now(), expiresAt);
    return { token: `arpg_${id}_${secret}`, id };
  }

  /** The token's row and its creator, or null when unknown, wrong, expired or the creator is banned. Marks it used. */
  authenticate(token: string, now = Date.now()): TokenCaller | null {
    const m = ADMIN_TOKEN_PATTERN.exec(token);
    const id = m?.[1];
    const secret = m?.[2];
    if (!id || !secret) return null;
    const r = row(
      this.db
        .prepare('SELECT t.id, t.name, t.scopes_json, t.secret_hash, a.id AS account_id, a.username, a.role FROM admin_tokens t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND t.expires_at > ? AND a.banned = 0')
        .get(id, now),
    );
    const stored = r?.secret_hash;
    // Hash anyway on a miss, so a known id does not answer faster than an unknown one.
    const given = secretHash(secret);
    if (!r || !(stored instanceof Uint8Array) || stored.length !== given.length || !timingSafeEqual(given, stored)) return null;
    this.db.prepare('UPDATE admin_tokens SET last_used_at = ? WHERE id = ?').run(now, id);
    const role = r.role;
    return { tokenId: id, name: str(r.name), scopes: scopesOf(r.scopes_json), account: { id: num(r.account_id), username: str(r.username), role: isAssignableRole(role) ? role : 'player' } };
  }

  /** One account's tokens, or everyone's for null. Expired ones are listed until the next restart removes them. */
  list(accountId: number | null): AdminTokenInfo[] {
    const sql = 'SELECT t.id, t.name, t.scopes_json, t.created_at, t.expires_at, t.last_used_at, a.username FROM admin_tokens t JOIN accounts a ON a.id = t.account_id';
    const rows = accountId === null ? this.db.prepare(`${sql} ORDER BY t.created_at DESC`).all() : this.db.prepare(`${sql} WHERE t.account_id = ? ORDER BY t.created_at DESC`).all(accountId);
    return rows.flatMap((raw) => {
      const r = row(raw);
      if (!r) return [];
      const lastUsed = r.last_used_at;
      return [{ id: str(r.id), name: str(r.name), scopes: scopesOf(r.scopes_json), createdBy: str(r.username), createdAt: num(r.created_at), expiresAt: num(r.expires_at), lastUsedAt: lastUsed === null || lastUsed === undefined ? null : num(lastUsed) }];
    });
  }

  /** The revoked token's name and creator, or null. `accountId` null revokes anyone's (the owner). */
  revoke(id: string, accountId: number | null): { name: string; createdBy: string } | null {
    const r = row(this.db.prepare('SELECT t.name, t.account_id, a.username FROM admin_tokens t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(id));
    if (!r || (accountId !== null && num(r.account_id) !== accountId)) return null;
    this.db.prepare('DELETE FROM admin_tokens WHERE id = ?').run(id);
    return { name: str(r.name), createdBy: str(r.username) };
  }

  deleteForAccount(accountId: number): void {
    this.db.prepare('DELETE FROM admin_tokens WHERE account_id = ?').run(accountId);
  }
}
