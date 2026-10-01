import { ACCOUNT_RULES, buyPrice, convertCharacterSave, convertItemRolls, convertRuneRolls, emptyRuneRollsReport, placeReturned, runeRollsChanged, STASH_TABS, type RuneRollsReport, convertWorldWaypoints, isWorldFormat1, type WorldConversionReport, convertStash, convertStashTabs, convertTraderShelf, saveStashLayout, isStashFormat2, type StashTabsReport, DEFAULT_SERVER_SETTINGS, isRuneFormat2, isAssignableRole, isClassId, isGateId, isWaypointId, parseSettingsPatch, settingsConflict, PROGRESSION, ARENA, type AdminCharacter, type ArenaBoard, type LeaderboardEntry, type LeaderboardResponse, type SeasonWinners, type AssignableRole, type ServerSettings, type CharacterSummary, type ClassId, type ConversionReport, type Item, type ItemUid, type PlayerSave, type StashSave, type TraderShelfSave } from '@rune/shared';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdminTokenStore } from './adminTokens.js';
import { events } from './eventLog.js';
import { TuningStore } from './tuningStore.js';
import { TunablesStore } from './tunablesStore.js';

/** 2^15 with r=8 is about 32 MiB and 50 ms per hash: slow for guessing, fine for a login. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;
const SESSION_DAYS = 30;
/** A guest's session is their only key, so it lasts much longer. */
const GUEST_SESSION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The trader's shelf, shared by every player on the server. */
export type Market = TraderShelfSave;

export interface Account {
  id: number;
  username: string;
  /** As stored; owners come from ADMIN_USERS on top of this (see roleOf in http.ts). */
  role: AssignableRole;
}

function storedRole(v: unknown): AssignableRole {
  return isAssignableRole(v) ? v : 'player';
}

export type GrantResult =
  | { ok: true; item: Item; characterName: string }
  /** no_character: not this account's; never_played: no save yet; old_format: a v1 save not loaded since. */
  | { ok: false; error: 'no_character' | 'never_played' | 'unreadable' | 'old_format' };

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

/**
 * An account stash as loaded. `refundGold` is owed for Linger and Pierce runes a v1 stash held: the
 * stash has no gold of its own, so the joining character is paid, and it is written together with
 * the converted stash, so it is paid once.
 */
export interface LoadedStash {
  stash: StashSave;
  refundGold: number;
}

/** A single-grid stash split into tabs on load; logged so the server log shows where things went. */
function logTabsConversion(accountId: number, r: StashTabsReport): void {
  const stayed = r.stayed.map((x) => `${x.count} ${x.reason}`).join(', ') || 'none';
  events.log('conversion', `account ${accountId} stash converted to tabs: ${r.runesToTab} rune items (${r.runeUnitsToTab} runes) to the rune tab, ${r.sigilsToTab} sigils to the sigil tab; runes and sigils left in tab 1: ${stayed}`);
  for (const w of r.warnings) events.log('conversion', `  account ${accountId} stash tabs: ${w}`);
}

/** A pre-world save's waypoints converted on load; logged so the server log shows what each character got. */
function logWorldConversion(name: string, r: WorldConversionReport): void {
  const mapped = r.mapped.map((m) => `${m.from}->${m.to}`).join(', ') || 'none';
  events.log('conversion', `world waypoints of character ${name} converted: ${mapped}; dropped ${r.dropped.join(', ') || 'none'}; unknown kept ${r.unknown.join(', ') || 'none'}; gates opened (the old zones lay behind them) ${r.gatesGranted.join(', ') || 'none'}`);
  for (const w of r.warnings) events.log('conversion', `  world ${name}: ${w}`);
}

/** A v1 row converted on load; logged so the server log shows what each account got. */
function logConversion(what: string, r: ConversionReport): void {
  const mapped = r.runesMapped.map((m) => `${m.from}->${m.to} x${m.count}`).join(', ') || 'none';
  const refunded = r.runesRefunded.map((m) => `${m.from} x${m.count}`).join(', ') || 'none';
  const replaced = r.runesReplaced.map((m) => `${m.from} x${m.count}`).join(', ') || 'none';
  events.log('conversion', `v1 ${what} converted: ${r.starterSigils.length} starter sigils (replacing v1 runes ${replaced}), runes ${mapped}, refunded ${refunded} for ${r.gold} gold, ${r.runesReturned} returned (${r.runesPending} pending), ${r.testSigilsUnpacked} test sigils taken apart`);
  for (const w of r.warnings) events.log('conversion', `  v1 ${what}: ${w}`);
}

/** Sigils changed by the 2026-10-01 rune decisions on load; logged so the server log shows each one. */
function logRuneRolls(what: string, r: RuneRollsReport): void {
  if (!runeRollsChanged(r)) return;
  const rebuilt = r.startersRebuilt.map((s) => `${s.starter} sigil ${s.sigil} (bound runes ${s.runesRemoved.join(', ') || 'none'} removed, unbound ${s.runesReturned.join(', ') || 'none'} returned)`).join(', ') || 'none';
  const names = r.renamed.map((n) => `${n.from} -> ${n.to}`).join(', ') || 'none';
  events.log('conversion', `rune rolls of ${what}: "first rune is free" removed from sigils ${r.affixesRemoved.join(', ') || 'none'}; renamed ${names}; starters rebuilt: ${rebuilt}; runes retiered ${r.runesRetiered.length}`);
}

function parseSave(json: string, classId: ClassId): PlayerSave | null {
  try {
    const raw: unknown = JSON.parse(json);
    // v1 saves are converted before anything else reads them.
    const conversion = isRuneFormat2(raw) ? null : convertCharacterSave(raw);
    if (conversion) logConversion(`character ${conversion.save.name}`, conversion.report);
    const v: unknown = conversion ? conversion.save : raw;
    if (!isPlayerSave(v, classId)) return null;
    // Saves from before waypoints existed have none; the town's waypoint is everyone's without being
    // listed. Saves from before the seamless world list the old zones' ids, which are mapped once.
    const waypoints: unknown = Reflect.get(v, 'waypoints');
    const listed = Array.isArray(waypoints) ? waypoints.filter(isWaypointId) : [];
    const world = isWorldFormat1(v) ? null : convertWorldWaypoints(listed);
    if (world) logWorldConversion(v.name, world.report);
    const found = world ? world.waypoints : listed;
    // Saves from before gate bosses have no gates; a converted save gets the gates its old zones lay behind.
    const stored: unknown = Reflect.get(v, 'gates');
    const gates = [...new Set([...(Array.isArray(stored) ? stored.filter(isGateId) : []), ...(world?.gates ?? [])])];
    // Saves from before levels existed start at level 1.
    const level: unknown = Reflect.get(v, 'level');
    const xp: unknown = Reflect.get(v, 'xp');
    // Saves from before the stash have none, and saves from before tabs hold a grid; the account's
    // stash is loaded separately anyway. A layout that cannot be read throws, so the save is kept.
    const stash = saveStashLayout(Reflect.get(v, 'stash'));
    const rolls = convertRuneRolls(v.items);
    logRuneRolls(`character ${v.name}`, rolls.report);
    return {
      ...v,
      items: [...rolls.items, ...rolls.returned],
      inventory: placeReturned(v.inventory, rolls.returned),
      stash,
      // Saves from before gold have none.
      gold: typeof Reflect.get(v, 'gold') === 'number' && Number.isFinite(Reflect.get(v, 'gold')) ? Math.max(0, Math.floor(Number(Reflect.get(v, 'gold')))) : 0,
      waypoints: found,
      level: typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= PROGRESSION.maxLevel ? level : 1,
      xp: typeof xp === 'number' && Number.isFinite(xp) && xp >= 0 ? xp : 0,
      runeFormat: 2,
      worldFormat: 1,
      gates,
    };
  } catch (err) {
    events.error('save', 'save could not be read', err);
    return null;
  }
}

export interface ArenaRunRow {
  season: string;
  names: string[];
  classes: ClassId[];
  score: number;
  wave: number;
  seconds: number;
  finishedAt: number;
  staff: boolean;
}

export function boardOf(partySize: number): ArenaBoard {
  return partySize <= 1 ? 'solo' : 'party';
}

/** Fixed SQL fragments only, never player input, so building the query from them is safe. */
function boardWhere(board: ArenaBoard): string {
  return board === 'solo' ? 'party_size = 1' : 'party_size > 1';
}

function stringList(json: unknown): string[] {
  if (typeof json !== 'string') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function arenaEntry(r: Record<string, unknown> | null): LeaderboardEntry | null {
  if (!r) return null;
  const names = stringList(r.names_json);
  if (names.length === 0) return null;
  // A class that no longer exists drops the whole list, so the rest stay lined up with the names.
  const listed = stringList(r.classes_json);
  const classes = listed.filter(isClassId);
  return {
    names,
    classes: classes.length === listed.length ? classes : [],
    partySize: num(r.party_size),
    score: num(r.score),
    wave: num(r.wave),
    seconds: num(r.seconds),
    finishedAt: num(r.finished_at),
    staff: num(r.staff) === 1,
  };
}

export interface CharacterSaveRow {
  characterId: number;
  save: PlayerSave;
  accountId: number;
  stash: StashSave;
}

/** Temp copies made for `GET /api/admin/backup`; any left by a crash mid-download are removed at startup. */
const BACKUP_FILE = /^\.backup-[0-9a-f]{16}\.db$/;

export class AccountStore {
  private readonly db: DatabaseSync;
  /** Where backup copies are made: next to the database, so they land on the same volume. */
  readonly dataDir: string;
  readonly adminTokens: AdminTokenStore;

  constructor(path = process.env.DB_PATH ?? 'data/rune.db') {
    this.dataDir = path === ':memory:' ? tmpdir() : dirname(resolve(path));
    if (path !== ':memory:') {
      mkdirSync(this.dataDir, { recursive: true });
      for (const f of readdirSync(this.dataDir)) if (BACKUP_FILE.test(f)) rmSync(join(this.dataDir, f), { force: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- NORMAL survives a process crash in WAL mode; only a power cut can lose the last commits,
      -- and it spares every save a disk flush.
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
      -- One row per finished Arena run. Names and classes are copied in, not referenced, so a board
      -- keeps its history when a character is renamed or deleted.
      CREATE TABLE IF NOT EXISTS arena_runs (
        id INTEGER PRIMARY KEY,
        season TEXT NOT NULL,
        names_json TEXT NOT NULL,
        classes_json TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        score INTEGER NOT NULL,
        wave INTEGER NOT NULL,
        seconds INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        staff INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS arena_runs_board ON arena_runs(season, party_size, score DESC);
    `);
    // Columns added after launch, migrated in place so existing databases keep their data.
    const accountCols = this.db.prepare('PRAGMA table_info(accounts)').all().map((c) => str(row(c)?.name));
    if (!accountCols.includes('banned')) this.db.exec('ALTER TABLE accounts ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
    if (!accountCols.includes('role')) this.db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'player'");
    if (!accountCols.includes('stash_json')) this.db.exec('ALTER TABLE accounts ADD COLUMN stash_json TEXT');
    if (!accountCols.includes('is_guest')) this.db.exec('ALTER TABLE accounts ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
    const arenaCols = this.db.prepare('PRAGMA table_info(arena_runs)').all().map((c) => str(row(c)?.name));
    if (!arenaCols.includes('staff')) this.db.exec('ALTER TABLE arena_runs ADD COLUMN staff INTEGER NOT NULL DEFAULT 0');
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.adminTokens = new AdminTokenStore(this.db);
  }

  /** A new temp file name for a backup, in the data directory. */
  backupPath(): string {
    return join(this.dataDir, `.backup-${randomBytes(8).toString('hex')}.db`);
  }

  /**
   * A consistent copy of the whole database: VACUUM INTO reads one snapshot, so a save committing
   * meanwhile is either all in or all out. It runs on the main thread and blocks the game while it
   * copies (a few ms for a few MB); nothing else is mid-transaction, since every write is synchronous.
   */
  backupTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
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

  /**
   * A real change drops the account's admin tokens, up or down: a token checked against the role
   * alone would come back to life on re-promotion, with scopes picked for a role long gone.
   * Returns whether the role changed.
   */
  setRole(accountId: number, role: AssignableRole): boolean {
    const changed = num(this.db.prepare('UPDATE accounts SET role = ? WHERE id = ? AND role != ?').run(role, accountId, role).changes) > 0;
    if (changed) this.adminTokens.deleteForAccount(accountId);
    return changed;
  }

  setBanned(accountId: number, banned: boolean): boolean {
    const found = num(this.db.prepare('UPDATE accounts SET banned = ? WHERE id = ?').run(banned ? 1 : 0, accountId).changes) > 0;
    // Dropped rather than just hidden, so an unban does not bring old (possibly leaked) tokens back.
    if (found && banned) {
      this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
      this.adminTokens.deleteForAccount(accountId);
    }
    return found;
  }

  /** Usernames compare without case, as at registration. */
  accountByUsername(username: string): Account | null {
    const r = row(this.db.prepare('SELECT id, username, role FROM accounts WHERE username = ?').get(username));
    return r ? { id: num(r.id), username: str(r.username), role: storedRole(r.role) } : null;
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
      if (typeof patch === 'string') events.warn('server', `[settings] ignoring stored ${key}: ${patch}`);
      else Object.assign(out, patch);
    }
    // Each zoom field can pass alone yet clash with the others; the defaults always agree.
    const conflict = settingsConflict(out);
    if (conflict) {
      events.warn('server', `[settings] resetting stored zoom: ${conflict}`);
      for (const key of ['zoomDefault', 'zoomDungeon', 'zoomMin', 'zoomMax'] as const) out[key] = defaults[key];
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
    if (saveUnreadable) events.error('save', `character ${characterId} has an unreadable save; it is kept as is and the character cannot join`);
    return { id: num(r.id), accountId: num(r.account_id), name: str(r.name), classId, createdAt: num(r.created_at), playedAt: num(r.played_at), save, saveUnreadable };
  }

  /**
   * The account's shared stash; null when it has never been saved. 'unreadable' when the row is
   * damaged or holds an item that fails the shape check: the caller must not save over it.
   */
  loadStash(accountId: number): LoadedStash | null | 'unreadable' {
    const raw = row(this.db.prepare('SELECT stash_json FROM accounts WHERE id = ?').get(accountId))?.stash_json;
    if (typeof raw !== 'string') return null;
    try {
      const stored: unknown = JSON.parse(raw);
      // Two one-time conversions, in order: v1 runes to v2 items, then the single grid to tabs. Either
      // throws on data it cannot read, which lands below and refuses the join.
      const conversion = isRuneFormat2(stored) ? null : convertStash(stored);
      if (conversion) logConversion(`account ${accountId} stash`, conversion.report);
      const runes: unknown = conversion ? conversion.stash : stored;
      const tabs = convertStashTabs(runes);
      if (!isStashFormat2(runes)) logTabsConversion(accountId, tabs.report);
      if (!tabs.stash.items.every(isStoredItem)) return 'unreadable';
      const rolls = convertRuneRolls(tabs.stash.items);
      logRuneRolls(`account ${accountId} stash`, rolls.report);
      // Returned runes are unbound, so the rune tab takes them; past its cap they have no place and
      // go to the joining character as pending, like any account item that lost its place.
      const list = [...tabs.stash.runes.list];
      for (const r of rolls.returned) if (list.length < STASH_TABS.runeCap) list.push(r.uid);
      return { stash: { ...tabs.stash, runes: { kind: 'runes', list }, items: [...rolls.items, ...rolls.returned] }, refundGold: conversion?.report.gold ?? 0 };
    } catch (err) {
      events.error('save', `account ${accountId} stash could not be read`, err);
      return 'unreadable';
    }
  }

  /**
   * Adds one item to an offline character's save as pending (in `items` but in no grid or slot), so
   * the next login lays it out like any other pending item: stash first unless bound, then the bag,
   * and kept pending if nothing has room. Only the stored JSON's item list changes, in a
   * transaction that writes the row only if it is still the one read. The caller makes sure the
   * account is offline: a live session's next save would write over the row.
   */
  grantPendingItem(accountId: number, characterId: number, make: (newUid: () => ItemUid) => Item): GrantResult {
    let result: GrantResult = { ok: false, error: 'no_character' };
    this.transaction(() => {
      const r = row(this.db.prepare('SELECT name, class_id, save_json FROM characters WHERE id = ? AND account_id = ?').get(characterId, accountId));
      const classId = r?.class_id;
      if (!r || !isClassId(classId)) return;
      const json = r.save_json;
      if (typeof json !== 'string') {
        result = { ok: false, error: 'never_played' };
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        raw = null;
      }
      const items: unknown = isRecord(raw) ? raw.items : undefined;
      if (!isRecord(raw) || !Array.isArray(items) || !parseSave(json, classId)) {
        result = { ok: false, error: 'unreadable' };
        return;
      }
      // A v1 save converts on its first load; granting into it would mix the formats.
      if (!isRuneFormat2(raw)) {
        result = { ok: false, error: 'old_format' };
        return;
      }
      // Above every uid in the save, runes inside sigils included, so the new item collides with
      // nothing before the room gives everything fresh uids on load.
      let top = 0;
      for (const it of items) {
        if (!isRecord(it)) continue;
        if (typeof it.uid === 'number') top = Math.max(top, it.uid);
        if (Array.isArray(it.slots)) for (const r2 of it.slots) if (isRecord(r2) && typeof r2.uid === 'number') top = Math.max(top, r2.uid);
      }
      const item = make(() => ++top);
      const next = JSON.stringify({ ...raw, items: [...items, item] });
      const changed = num(this.db.prepare('UPDATE characters SET save_json = ? WHERE id = ? AND account_id = ? AND save_json = ?').run(next, characterId, accountId, json).changes);
      if (changed !== 1) throw new Error(`grant to character ${characterId}: the row changed while it was written`);
      result = { ok: true, item, characterName: str(r.name) };
    });
    return result;
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
   * Many saves in one transaction. Each commit waits for the disk: one by one, 64 saves stall every
   * room for about 250 ms on the Linux host, batched they take under 1 ms.
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
    if (typeof raw !== 'string') return { nextId: 1, stock: [], runeFormat: 2 };
    // Shelf items belong to nobody (their sellers were paid), so a damaged row may start a fresh
    // shelf; it is logged first, since the next trade writes over it.
    const fresh = (why: string): Market => {
      events.error('save', `trader shelf unreadable (${why}); starting an empty one. Old row: ${raw.slice(0, 200)}`);
      return { nextId: 1, stock: [], runeFormat: 2 };
    };
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return fresh('not JSON');
    }
    // A v1 shelf is readable data, not damage: a conversion failure stops the server rather than
    // starting a fresh shelf that the next trade would write over it.
    const conversion = isRuneFormat2(stored) ? null : convertTraderShelf(stored);
    if (conversion) logConversion('trader shelf', conversion.report);
    const v: unknown = conversion ? conversion.shelf : stored;
    if (!isRecord(v) || !Array.isArray(v.stock) || typeof v.nextId !== 'number') return fresh('bad shape');
    const rolls = emptyRuneRollsReport();
    const returned: Item[] = [];
    const stock = v.stock.flatMap((e: unknown) => {
      if (!isRecord(e) || typeof e.id !== 'number' || typeof e.price !== 'number' || !isStoredItem(e.item)) return [];
      const r = convertItemRolls(e.item, rolls);
      returned.push(...r.returned);
      return [{ id: e.id, price: buyPrice(r.item), item: r.item }];
    });
    logRuneRolls('the trader shelf', rolls);
    if (stock.length !== v.stock.length) events.error('save', `trader shelf: dropped ${v.stock.length - stock.length} unreadable entries`);
    // Never hand out an id already on the shelf, whatever the stored counter says.
    let nextId = Math.max(v.nextId, ...stock.map((e) => e.id + 1), 1);
    // Shelf items belong to nobody, so runes a shelf sigil hands back become entries of their own.
    for (const r of returned) {
      const item = { ...r, uid: 0 };
      stock.push({ id: nextId++, price: buyPrice(item), item });
    }
    return { nextId, stock, runeFormat: 2 };
  }

  /** Stores a finished run and returns its place on its season's board (1 is the top). */
  recordArenaRun(run: ArenaRunRow): number {
    const res = this.db
      .prepare('INSERT INTO arena_runs (season, names_json, classes_json, party_size, score, wave, seconds, finished_at, staff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.season, JSON.stringify(run.names), JSON.stringify(run.classes), run.names.length, run.score, run.wave, run.seconds, run.finishedAt, run.staff ? 1 : 0);
    const id = num(res.lastInsertRowid);
    // Ties go to whoever got there first, the same order the board lists them in.
    const ahead = row(
      this.db.prepare(`SELECT COUNT(*) AS n FROM arena_runs WHERE season = ? AND ${boardWhere(boardOf(run.names.length))} AND (score > ? OR (score = ? AND id < ?))`).get(run.season, run.score, run.score, id),
    );
    return num(ahead?.n) + 1;
  }

  /** The season's top runs on both boards, and the winners of every earlier season. */
  leaderboard(season: string): LeaderboardResponse {
    const top = (s: string, board: ArenaBoard, limit: number): LeaderboardEntry[] =>
      this.db
        .prepare(`SELECT * FROM arena_runs WHERE season = ? AND ${boardWhere(board)} ORDER BY score DESC, id ASC LIMIT ?`)
        .all(s, limit)
        .flatMap((r) => {
          const e = arenaEntry(row(r));
          return e ? [e] : [];
        });
    // Two years of past winners is plenty for a board on a wall.
    const earlier = this.db
      .prepare('SELECT DISTINCT season FROM arena_runs WHERE season < ? ORDER BY season DESC LIMIT 24')
      .all(season)
      .map((r) => str(row(r)?.season));
    const winners: SeasonWinners[] = earlier.map((s) => ({ season: s, solo: top(s, 'solo', 1)[0] ?? null, party: top(s, 'party', 1)[0] ?? null }));
    return { season, solo: top(season, 'solo', ARENA.leaderboardSize), party: top(season, 'party', ARENA.leaderboardSize), winners };
  }

  saveCharacter(characterId: number, save: PlayerSave): void {
    this.db.prepare('UPDATE characters SET save_json = ?, played_at = ? WHERE id = ?').run(JSON.stringify(save), Date.now(), characterId);
  }

  private tuningStore: TuningStore | null = null;
  /** Monster and minion overrides, kept in their own table by tuningStore.ts. */
  get tuning(): TuningStore {
    this.tuningStore ??= new TuningStore(this.db);
    return this.tuningStore;
  }

  private tunablesStore: TunablesStore | null = null;
  /** Live tuning overrides and their history, kept in their own tables by tunablesStore.ts. */
  get tunables(): TunablesStore {
    this.tunablesStore ??= new TunablesStore(this.db);
    return this.tunablesStore;
  }
}
