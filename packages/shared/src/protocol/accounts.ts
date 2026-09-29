import { isClassId, type ClassId } from '../data/classes.js';
import type { Role } from './roles.js';
import { cleanChat } from './validate.js';

/** Account and character management runs over plain HTTP (see apps/server/src/http.ts); only play uses the socket. */

export const ACCOUNT_RULES = {
  usernamePattern: /^[A-Za-z0-9_]{3,16}$/,
  /** Letters first so names never look like ids or numbers in chat and party lists. */
  // The hyphen is escaped: browsers compile HTML pattern attributes with the v flag, where a bare
  // "-" in a class is a syntax error and the whole pattern is silently ignored.
  characterNamePattern: /^[A-Za-z][A-Za-z0-9_\-]{2,15}$/,
  passwordMin: 8,
  /** scrypt cost grows with input length; the cap keeps a login request from being a CPU bomb. */
  passwordMax: 128,
  maxCharacters: 12,
} as const;

export interface CharacterSummary {
  id: number;
  name: string;
  classId: ClassId;
  createdAt: number;
  /** Last time the character was saved; 0 means it has never entered the world. */
  playedAt: number;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface NewCharacter {
  name: string;
  classId: ClassId;
}

export interface SessionResponse {
  token: string;
  username: string;
}

export interface CharactersResponse {
  username: string;
  characters: CharacterSummary[];
  /** Decides whether the admin page link, town editor and dev tools show up. */
  role: Role;
  /** A guest account, kept only by this browser's session until it is claimed. */
  guest: boolean;
}

export interface ApiError {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCredentials(value: unknown): Credentials | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  const { username, password } = value;
  if (typeof username !== 'string' || !ACCOUNT_RULES.usernamePattern.test(username)) return 'Usernames are 3 to 16 letters, digits or underscores';
  if (typeof password !== 'string' || password.length < ACCOUNT_RULES.passwordMin || password.length > ACCOUNT_RULES.passwordMax) {
    return `Passwords are ${ACCOUNT_RULES.passwordMin} to ${ACCOUNT_RULES.passwordMax} characters`;
  }
  return { username, password };
}

export function parseNewCharacter(value: unknown): NewCharacter | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  const { name, classId } = value;
  if (typeof name !== 'string' || !ACCOUNT_RULES.characterNamePattern.test(name)) return 'Names are 3 to 16 characters, start with a letter, and use letters, digits, _ or -';
  if (!isClassId(classId)) return 'Unknown class';
  return { name, classId };
}

/** Tokens are 32 random bytes in base64url, so anything else is rejected before touching the database. */
export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// Admin API. Only accounts named in the server's ADMIN_USERS may call these.

/** Live-tunable server settings. Persisted, so they survive restarts and deploys. */
export interface ServerSettings {
  /** Multiplier on all kill XP. */
  xpRate: number;
  /** Multiplier on how often monsters drop and how many items rares and bosses drop. */
  lootRate: number;
  /** Shown to everyone as they enter the world; empty for none. */
  motd: string;
  registrationOpen: boolean;
  /** Seed of the public world. Only new copies use a changed seed; running ones keep theirs. */
  worldSeed: number;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { xpRate: 1, lootRate: 1, motd: '', registrationOpen: true, worldSeed: 1 };

/** motdMax matches CHAT_MAX_LENGTH, where cleanChat would cut it anyway. */
export const SETTINGS_LIMITS = { rateMin: 0, rateMax: 20, motdMax: 200, seedMax: 999_999 } as const;

/** Accepts a partial update and returns only the valid fields, or an error for the first bad one. */
export function parseSettingsPatch(value: unknown): Partial<ServerSettings> | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  const out: Partial<ServerSettings> = {};
  for (const key of ['xpRate', 'lootRate'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < SETTINGS_LIMITS.rateMin || v > SETTINGS_LIMITS.rateMax) return `${key} must be between ${SETTINGS_LIMITS.rateMin} and ${SETTINGS_LIMITS.rateMax}`;
    out[key] = v;
  }
  if (value.motd !== undefined) {
    if (typeof value.motd !== 'string' || value.motd.length > SETTINGS_LIMITS.motdMax) return `motd must be text up to ${SETTINGS_LIMITS.motdMax} characters`;
    // Sent as a system chat line, so it gets the same cleaning as chat.
    out.motd = cleanChat(value.motd) ?? '';
  }
  if (value.worldSeed !== undefined) {
    if (typeof value.worldSeed !== 'number' || !Number.isInteger(value.worldSeed) || value.worldSeed < 0 || value.worldSeed > SETTINGS_LIMITS.seedMax) return `worldSeed must be a whole number from 0 to ${SETTINGS_LIMITS.seedMax}`;
    out.worldSeed = value.worldSeed;
  }
  for (const key of ['registrationOpen'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return `${key} must be true or false`;
    out[key] = v;
  }
  return out;
}

export interface AdminOnlinePlayer {
  characterId: number;
  name: string;
  classId: ClassId;
  level: number;
  account: string;
  game: string | null;
  room: string;
}

export interface AdminOverview {
  build: string;
  uptimeSeconds: number;
  memoryMb: number;
  online: AdminOnlinePlayer[];
  games: { id: string; host: string; players: number; rooms: number }[];
  rooms: { id: string; name: string; players: number; monsters: number }[];
}

export interface AdminCharacter extends CharacterSummary {
  level: number;
}

export interface AdminAccount {
  id: number;
  username: string;
  createdAt: number;
  banned: boolean;
  guest: boolean;
  role: Role;
  characters: AdminCharacter[];
}
