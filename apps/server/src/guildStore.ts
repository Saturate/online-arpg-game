import { GUILD_LIMITS, isClassId, isGuildRank, type ClassId, type GuildLogEntry, type GuildLogKind, type GuildRank, GUILD_LOG_KINDS } from '@rune/shared';
import type { DatabaseSync } from 'node:sqlite';
import { events } from './eventLog.js';

/** One guild row with its members, as the guild service loads it at boot. */
export interface GuildRow {
  id: number;
  name: string;
  tag: string;
  motd: string;
  createdAt: number;
  stashJson: string;
  members: MemberRow[];
}

export interface MemberRow {
  accountId: number;
  rank: GuildRank;
  joinedAt: number;
}

/** An account's most recently played character, for the roster. */
export interface RosterCharacter {
  name: string;
  classId: ClassId;
  level: number;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isLogKind(v: unknown): v is GuildLogKind {
  return typeof v === 'string' && GUILD_LOG_KINDS.some((k) => k === v);
}

/**
 * Guild data in SQLite (docs/features/guilds.md): one row per guild with its stash as JSON, one row
 * per member account, and the guild log. Membership is by account and goes with the account
 * (ON DELETE CASCADE); the guild service repairs leadership after that. These methods never open
 * a transaction of their own, so a stash move can write its rows inside the same transaction as
 * the character involved (AccountStore.saveCharacterWith); `tx` is for writes with no character.
 */
export class GuildStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
        motd TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        stash_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_members (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        rank TEXT NOT NULL,
        joined_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guild_members_guild ON guild_members(guild_id);
      CREATE TABLE IF NOT EXISTS guild_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        account_id INTEGER,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guild_log_guild ON guild_log(guild_id, id);
    `);
  }

  /** For writes that involve no character; a stash move goes through AccountStore.saveCharacterWith instead. */
  tx(write: () => void): void {
    this.db.exec('BEGIN');
    try {
      write();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadAll(): GuildRow[] {
    const members = new Map<number, MemberRow[]>();
    for (const raw of this.db.prepare('SELECT account_id, guild_id, rank, joined_at FROM guild_members').all()) {
      const rank = raw.rank;
      if (!isGuildRank(rank)) {
        events.error('save', `[guild] member row of account ${num(raw.account_id)} in guild ${num(raw.guild_id)} has an unknown rank ${String(rank)}; skipped`);
        continue;
      }
      const list = members.get(num(raw.guild_id)) ?? [];
      list.push({ accountId: num(raw.account_id), rank, joinedAt: num(raw.joined_at) });
      members.set(num(raw.guild_id), list);
    }
    return this.db
      .prepare('SELECT id, name, tag, motd, created_at, stash_json FROM guilds ORDER BY id')
      .all()
      .map((r) => ({ id: num(r.id), name: str(r.name), tag: str(r.tag), motd: str(r.motd), createdAt: num(r.created_at), stashJson: str(r.stash_json), members: members.get(num(r.id)) ?? [] }));
  }

  /** The members as stored now: account deletion removes rows behind the service's back. */
  members(guildId: number): MemberRow[] {
    return this.db
      .prepare('SELECT account_id, rank, joined_at FROM guild_members WHERE guild_id = ?')
      .all(guildId)
      .flatMap((r) => (isGuildRank(r.rank) ? [{ accountId: num(r.account_id), rank: r.rank, joinedAt: num(r.joined_at) }] : []));
  }

  nameOrTagTaken(name: string, tag: string): 'name' | 'tag' | null {
    if (this.db.prepare('SELECT 1 FROM guilds WHERE name = ?').get(name)) return 'name';
    if (this.db.prepare('SELECT 1 FROM guilds WHERE tag = ?').get(tag)) return 'tag';
    return null;
  }

  /** Throws on a name or tag taken meanwhile (the UNIQUE columns), which rolls the founding back. */
  insertGuild(name: string, tag: string, createdAt: number, stashJson: string): number {
    const r = this.db.prepare('INSERT INTO guilds (name, tag, created_at, stash_json) VALUES (?, ?, ?, ?)').run(name, tag, createdAt, stashJson);
    return num(r.lastInsertRowid);
  }

  deleteGuild(id: number): void {
    this.db.prepare('DELETE FROM guilds WHERE id = ?').run(id);
  }

  addMember(guildId: number, accountId: number, rank: GuildRank, joinedAt: number): void {
    this.db.prepare('INSERT INTO guild_members (account_id, guild_id, rank, joined_at) VALUES (?, ?, ?, ?)').run(accountId, guildId, rank, joinedAt);
  }

  removeMember(accountId: number): void {
    this.db.prepare('DELETE FROM guild_members WHERE account_id = ?').run(accountId);
  }

  setRank(accountId: number, rank: GuildRank): void {
    const r = this.db.prepare('UPDATE guild_members SET rank = ? WHERE account_id = ?').run(rank, accountId);
    if (num(r.changes) !== 1) throw new Error(`guild member ${accountId} is gone`);
  }

  setMotd(guildId: number, motd: string): void {
    this.db.prepare('UPDATE guilds SET motd = ? WHERE id = ?').run(motd, guildId);
  }

  writeStash(guildId: number, json: string): void {
    const r = this.db.prepare('UPDATE guilds SET stash_json = ? WHERE id = ?').run(json, guildId);
    if (num(r.changes) !== 1) throw new Error(`guild ${guildId} is gone`);
  }

  /** Adds a log row and drops the oldest past GUILD_LIMITS.logKeep. */
  addLog(guildId: number, kind: GuildLogKind, actor: string, accountId: number | null, text: string, at: number): void {
    this.db.prepare('INSERT INTO guild_log (guild_id, at, kind, actor, account_id, text) VALUES (?, ?, ?, ?, ?, ?)').run(guildId, at, kind, actor, accountId, text);
    this.db.prepare('DELETE FROM guild_log WHERE guild_id = ? AND id <= (SELECT id FROM guild_log WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(guildId, guildId, GUILD_LIMITS.logKeep);
  }

  /** Newest first: up to `limit` entries older than `before` (an entry id), or the newest. */
  log(guildId: number, before: number | null, limit: number): { entries: GuildLogEntry[]; more: boolean } {
    const rows = this.db
      .prepare('SELECT id, at, kind, actor, text FROM guild_log WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(guildId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const entries = rows.flatMap((r) => (isLogKind(r.kind) ? [{ id: num(r.id), at: num(r.at), kind: r.kind, actor: str(r.actor), text: str(r.text) }] : []));
    return { entries: entries.slice(0, limit), more: rows.length > limit };
  }

  /** Each account's most recently played character, or none when it has no character left. */
  rosterCharacters(accountIds: readonly number[]): Map<number, RosterCharacter> {
    const out = new Map<number, RosterCharacter>();
    const q = this.db.prepare("SELECT name, class_id, CASE WHEN json_valid(save_json) THEN json_extract(save_json, '$.level') END AS level FROM characters WHERE account_id = ? ORDER BY played_at DESC, id DESC LIMIT 1");
    for (const id of accountIds) {
      const r = q.get(id);
      if (!r || !isClassId(r.class_id)) continue;
      out.set(id, { name: str(r.name), classId: r.class_id, level: typeof r.level === 'number' ? r.level : 1 });
    }
    return out;
  }

  /**
   * When each account last played: its newest character save, or when the account was made if it
   * never played. Every save (autosave, room change, logout) stamps played_at, so this is the last
   * login give or take half a minute.
   */
  lastActive(accountIds: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    const q = this.db.prepare('SELECT a.created_at AS created, MAX(c.played_at) AS played FROM accounts a LEFT JOIN characters c ON c.account_id = a.id WHERE a.id = ? GROUP BY a.id');
    for (const id of accountIds) {
      const r = q.get(id);
      if (r) out.set(id, Math.max(num(r.created), num(r.played)));
    }
    return out;
  }

  /** Usernames for the admin page. */
  usernames(accountIds: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    const q = this.db.prepare('SELECT username FROM accounts WHERE id = ?');
    for (const id of accountIds) {
      const r = q.get(id);
      if (r) out.set(id, str(r.username));
    }
    return out;
  }
}
