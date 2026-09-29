import { ACCOUNT_RULES, buyPrice, DEFAULT_SERVER_SETTINGS, isLegacyTestSigil, HOME_ZONE, isAssignableRole, isClassId, isZoneId, parseSettingsPatch, PROGRESSION, type AdminCharacter, type AssignableRole, type ServerSettings, type CharacterSummary, type ClassId, type Item, type PlayerSave, type StashSave, type TraderEntry } from '@rune/shared';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 2^15 with r=8 is about 32 MiB and 50 ms per hash: slow for guessing, fine for a login. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;
const SESSION_DAYS = 30;
/** A guest's session is their only key, so it lasts much longer. */
const GUEST_SESSION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The trader's shelf, shared by every player on the server. */
export interface Market {
  nextId: number;
  stock: TraderEntry[];
}

export interface Account {
  id: number;
  username: string;
  /** As stored; owners come from ADMIN_USERS on top of this (see roleOf in http.ts). */
  role: AssignableRole;
}

function storedRole(v: unknown): AssignableRole {
  return isAssignableRole(v) ? v : 'player';
}

export interface StoredCharacter extends CharacterSummary {
  accountId: number;
  save: PlayerSave | null;
  /** A save exists but could not be read. It must not be overwritten by a fresh start. */
  saveUnreadable: boolean;
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

/** Same spirit as isPlayerSave: the server wrote these, so this catches old or damaged rows, not attacks. */
function isStoredItem(v: unknown): v is Item {
  return isRecord(v) && typeof v.uid === 'number' && (v.kind === 'gear' || v.kind === 'sigil' || v.kind === 'vessel' || v.kind === 'rune') && typeof v.name === 'string' && typeof v.tier === 'string';
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
    if (!isPlayerSave(v, classId)) return null;
    // Saves from before waypoints existed have none; everyone owns the town's.
    const waypoints: unknown = Reflect.get(v, 'waypoints');
    const found = Array.isArray(waypoints) ? waypoints.filter(isZoneId) : [];
    // Saves from before levels existed start at level 1.
    const level: unknown = Reflect.get(v, 'level');
    const xp: unknown = Reflect.get(v, 'xp');
    // Saves from before the stash have none; the account's stash is loaded separately anyway.
    const stash: unknown = Reflect.get(v, 'stash');
    return {
      ...v,
      stash: Array.isArray(stash) ? stash.map((c: unknown) => (typeof c === 'number' ? c : null)) : [],
      // Saves from before gold have none.
      gold: typeof Reflect.get(v, 'gold') === 'number' && Number.isFinite(Reflect.get(v, 'gold')) ? Math.max(0, Math.floor(Number(Reflect.get(v, 'gold')))) : 0,
      waypoints: found.includes(HOME_ZONE) ? found : [HOME_ZONE, ...found],
      level: typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= PROGRESSION.maxLevel ? level : 1,
      xp: typeof xp === 'number' && Number.isFinite(xp) && xp >= 0 ? xp : 0,
    };
  } catch {
    return null;
  }
}

export interface CharacterSaveRow {
  characterId: number;
  save: PlayerSave;
  accountId: number;
  stash: StashSave;
}

export class AccountStore {
  private readonly db: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? 'data/rune.db') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- In WAL mode NORMAL still survives a process crash; only a power cut can lose the last
      -- commits. FULL made every save wait on a disk flush.
      PRAGMA synchronous = NORMAL;
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Columns added after launch, migrated in place so existing databases keep their data.
    const accountCols = this.db.prepare('PRAGMA table_info(accounts)').all().map((c) => str(row(c)?.name));
    if (!accountCols.includes('banned')) this.db.exec('ALTER TABLE accounts ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
    if (!accountCols.includes('role')) this.db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'player'");
    if (!accountCols.includes('stash_json')) this.db.exec('ALTER TABLE accounts ADD COLUMN stash_json TEXT');
    if (!accountCols.includes('is_guest')) this.db.exec('ALTER TABLE accounts ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
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
      return { id: num(res.lastInsertRowid), username, role: 'player' };
    } catch {
      return 'taken';
    }
  }

  /**
   * A guest account: a generated name and a random password nobody knows, so the session token is
   * the only way in. It can be claimed later with a real username and password.
   */
  async registerGuest(): Promise<Account> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = `Guest${randomBytes(4).toString('hex').slice(0, 6)}`;
      if (this.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(name)) continue;
      const salt = randomBytes(16);
      const hash = await hashPassword(randomBytes(24).toString('base64url'), salt);
      try {
        const res = this.db.prepare('INSERT INTO accounts (username, password_salt, password_hash, created_at, is_guest) VALUES (?, ?, ?, ?, 1)').run(name, salt, hash, Date.now());
        return { id: num(res.lastInsertRowid), username: name, role: 'player' };
      } catch {
        // Lost a race for the name; roll another.
      }
    }
    throw new Error('Could not pick a free guest name');
  }

  /**
   * Guests nobody claimed pile up forever otherwise. A guest counts as idle when neither the
   * account nor any of its characters has been played for `idleMs`; its characters, sessions and
   * stash go with it (the foreign keys cascade). Accounts in `keep` (online right now) are spared.
   */
  deleteIdleGuests(idleMs: number, keep: ReadonlySet<number>, now = Date.now()): number {
    const cutoff = now - idleMs;
    const idle = this.db
      .prepare('SELECT a.id FROM accounts a LEFT JOIN characters c ON c.account_id = a.id WHERE a.is_guest = 1 GROUP BY a.id HAVING MAX(a.created_at, COALESCE(MAX(c.played_at), 0)) < ?')
      .all(cutoff)
      .map((r) => num(row(r)?.id))
      .filter((id) => !keep.has(id));
    const del = this.db.prepare('DELETE FROM accounts WHERE id = ? AND is_guest = 1');
    for (const id of idle) del.run(id);
    return idle.length;
  }

  isGuest(accountId: number): boolean {
    return num(row(this.db.prepare('SELECT is_guest FROM accounts WHERE id = ?').get(accountId))?.is_guest) === 1;
  }

  /** Turns a guest into a normal account under a chosen name and password; characters stay. */
  async claimGuest(accountId: number, username: string, password: string): Promise<'taken' | 'not_guest' | null> {
    if (!this.isGuest(accountId)) return 'not_guest';
    if (this.db.prepare('SELECT 1 FROM accounts WHERE username = ? AND id != ?').get(username, accountId)) return 'taken';
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt);
    try {
      this.db.prepare('UPDATE accounts SET username = ?, password_salt = ?, password_hash = ?, is_guest = 0 WHERE id = ? AND is_guest = 1').run(username, salt, hash, accountId);
      return null;
    } catch {
      return 'taken';
    }
  }

  /** 'banned' only once the password checked out, so a ban never reveals that an account exists. */
  async verify(username: string, password: string): Promise<Account | 'banned' | null> {
    const r = row(this.db.prepare('SELECT id, username, password_salt, password_hash, banned, role FROM accounts WHERE username = ?').get(username));
    const salt = r?.password_salt;
    const stored = r?.password_hash;
    if (!r || !(salt instanceof Uint8Array) || !(stored instanceof Uint8Array)) {
      // Hash anyway so an unknown username takes as long as a wrong password and cannot be probed by timing.
      await hashPassword(password, randomBytes(16));
      return null;
    }
    const hash = await hashPassword(password, Buffer.from(salt));
    if (hash.length !== stored.length || !timingSafeEqual(hash, stored)) return null;
    return num(r.banned) === 1 ? 'banned' : { id: num(r.id), username: str(r.username), role: storedRole(r.role) };
  }

  createSession(accountId: number): string {
    const token = randomBytes(32).toString('base64url');
    const days = this.isGuest(accountId) ? GUEST_SESSION_DAYS : SESSION_DAYS;
    this.db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), accountId, Date.now() + days * DAY_MS);
    return token;
  }

  accountForToken(token: string): Account | null {
    const r = row(
      this.db
        // A ban takes effect on the next request, since every API call and world join goes through here.
        .prepare('SELECT a.id, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.banned = 0')
        .get(tokenHash(token), Date.now()),
    );
    return r ? { id: num(r.id), username: str(r.username), role: storedRole(r.role) } : null;
  }

  setRole(accountId: number, role: AssignableRole): boolean {
    return num(this.db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, accountId).changes) > 0;
  }

  setBanned(accountId: number, banned: boolean): boolean {
    const found = num(this.db.prepare('UPDATE accounts SET banned = ? WHERE id = ?').run(banned ? 1 : 0, accountId).changes) > 0;
    // Dropped rather than just hidden, so an unban does not bring old (possibly leaked) tokens back.
    if (found && banned) this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    return found;
  }

  accountById(accountId: number): Account | null {
    const r = row(this.db.prepare('SELECT id, username, role FROM accounts WHERE id = ?').get(accountId));
    return r ? { id: num(r.id), username: str(r.username), role: storedRole(r.role) } : null;
  }

  accountForCharacter(characterId: number): Account | null {
    const r = row(this.db.prepare('SELECT a.id, a.username, a.role FROM characters c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?').get(characterId));
    return r ? { id: num(r.id), username: str(r.username), role: storedRole(r.role) } : null;
  }

  usernameExists(username: string): boolean {
    return this.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username) !== undefined;
  }

  /** Every account with its characters, for the admin page. Level comes from the save, 1 if never played. */
  listAccounts(): { id: number; username: string; createdAt: number; banned: boolean; guest: boolean; role: AssignableRole; characters: AdminCharacter[] }[] {
    const chars = new Map<number, AdminCharacter[]>();
    // Level is read in SQL so the page does not parse every full save (inventories and all) per request.
    const query = "SELECT id, account_id, name, class_id, created_at, played_at, CASE WHEN json_valid(save_json) THEN json_extract(save_json, '$.level') END AS level FROM characters ORDER BY played_at DESC";
    for (const raw of this.db.prepare(query).all()) {
      const r = row(raw);
      const classId = r?.class_id;
      if (!r || !isClassId(classId)) continue;
      const level = typeof r.level === 'number' ? r.level : 1;
      const list = chars.get(num(r.account_id)) ?? [];
      list.push({ id: num(r.id), name: str(r.name), classId, createdAt: num(r.created_at), playedAt: num(r.played_at), level });
      chars.set(num(r.account_id), list);
    }
    return this.db
      .prepare('SELECT id, username, created_at, banned, role, is_guest FROM accounts ORDER BY id')
      .all()
      .flatMap((raw) => {
        const r = row(raw);
        return r ? [{ id: num(r.id), username: str(r.username), createdAt: num(r.created_at), banned: num(r.banned) === 1, guest: num(r.is_guest) === 1, role: storedRole(r.role), characters: chars.get(num(r.id)) ?? [] }] : [];
      });
  }

  /** Defaults cover a fresh database and any field a stored row lacks or has corrupted. */
  loadSettings(): ServerSettings {
    const defaults = DEFAULT_SERVER_SETTINGS;
    const r = row(this.db.prepare("SELECT value FROM settings WHERE key = 'server'").get());
    const raw = r?.value;
    if (typeof raw !== 'string') return { ...defaults };
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return { ...defaults };
    }
    if (!isRecord(stored)) return { ...defaults };
    // Field by field, so one value that no longer passes (say, after a limit is lowered) does not reset the rest.
    const out = { ...defaults };
    for (const key of Object.keys(DEFAULT_SERVER_SETTINGS)) {
      const patch = parseSettingsPatch({ [key]: stored[key] });
      if (typeof patch === 'string') console.warn(`[settings] ignoring stored ${key}: ${patch}`);
      else Object.assign(out, patch);
    }
    return out;
  }

  saveSettings(settings: ServerSettings): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('server', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
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
    const saveUnreadable = typeof json === 'string' && !save;
    if (saveUnreadable) console.error(`character ${characterId} has an unreadable save; it is kept as is and the character cannot join`);
    return { id: num(r.id), accountId: num(r.account_id), name: str(r.name), classId, createdAt: num(r.created_at), playedAt: num(r.played_at), save, saveUnreadable };
  }

  /**
   * The account's shared stash; null when it has never been saved. 'unreadable' when the row is
   * damaged or holds an item that fails the shape check: the caller must not save over it.
   */
  loadStash(accountId: number): StashSave | null | 'unreadable' {
    const raw = row(this.db.prepare('SELECT stash_json FROM accounts WHERE id = ?').get(accountId))?.stash_json;
    if (typeof raw !== 'string') return null;
    try {
      const v: unknown = JSON.parse(raw);
      if (!isRecord(v) || !Array.isArray(v.items) || !Array.isArray(v.cells)) return 'unreadable';
      const items = v.items.filter(isStoredItem);
      if (items.length !== v.items.length) return 'unreadable';
      const cells = v.cells.map((c: unknown) => (typeof c === 'number' ? c : null));
      return { items, cells };
    } catch {
      return 'unreadable';
    }
  }

  saveCharacterAndStash(characterId: number, save: PlayerSave, accountId: number, stash: StashSave, market?: Market): void {
    this.transaction(() => {
      this.writeCharacterAndStash(characterId, save, accountId, stash);
      // A trade saves the trader's stock in the same transaction, so a crash cannot leave the item
      // both sold and still in the bag, or bought and still on the shelf.
      if (market) this.db.prepare("INSERT INTO settings (key, value) VALUES ('trader', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(market));
    });
  }

  /**
   * Many saves in one transaction. Each commit waits for the disk, so the autosave used to stall
   * every room for about 250 ms on the Linux host saving players one by one; batched it is under 1 ms.
   */
  saveMany(saves: readonly CharacterSaveRow[]): void {
    if (saves.length === 0) return;
    this.transaction(() => {
      for (const s of saves) this.writeCharacterAndStash(s.characterId, s.save, s.accountId, s.stash);
    });
  }

  private writeCharacterAndStash(characterId: number, save: PlayerSave, accountId: number, stash: StashSave): void {
    this.saveCharacter(characterId, save);
    this.db.prepare('UPDATE accounts SET stash_json = ? WHERE id = ?').run(JSON.stringify(stash), accountId);
  }

  private transaction(write: () => void): void {
    this.db.exec('BEGIN');
    try {
      write();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The trader's shared stock; empty when never saved. A damaged row starts a fresh shelf. */
  loadMarket(): Market {
    const raw = row(this.db.prepare("SELECT value FROM settings WHERE key = 'trader'").get())?.value;
    if (typeof raw !== 'string') return { nextId: 1, stock: [] };
    // Shelf items belong to nobody (their sellers were paid), so a damaged row may start a fresh
    // shelf; it is logged first, since the next trade writes over it.
    const fresh = (why: string): Market => {
      console.error(`trader shelf unreadable (${why}); starting an empty one. Old row: ${raw.slice(0, 200)}`);
      return { nextId: 1, stock: [] };
    };
    try {
      const v: unknown = JSON.parse(raw);
      if (!isRecord(v) || !Array.isArray(v.stock) || typeof v.nextId !== 'number') return fresh('bad shape');
      const stock = v.stock.flatMap((e: unknown) =>
        isRecord(e) && typeof e.id === 'number' && typeof e.price === 'number' && isStoredItem(e.item) && !isLegacyTestSigil(e.item) ? [{ id: e.id, price: buyPrice(e.item), item: e.item }] : [],
      );
      if (stock.length !== v.stock.length) console.error(`trader shelf: dropped ${v.stock.length - stock.length} unreadable entries`);
      // Never hand out an id already on the shelf, whatever the stored counter says.
      const nextId = Math.max(v.nextId, ...stock.map((e) => e.id + 1), 1);
      return { nextId, stock };
    } catch {
      return fresh('not JSON');
    }
  }

  saveCharacter(characterId: number, save: PlayerSave): void {
    this.db.prepare('UPDATE characters SET save_json = ?, played_at = ? WHERE id = ?').run(JSON.stringify(save), Date.now(), characterId);
  }
}
