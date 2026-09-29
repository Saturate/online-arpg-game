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
  /** Length of one day and night, in minutes. */
  dayMinutes: number;
  /** How much light is left at the darkest point of night, 0 (pitch) to 1 (as bright as day). */
  nightBrightness: number;
  /** 'cycle' runs the clock; 'hold' stops it at heldPhase. */
  timeOfDay: 'cycle' | 'hold';
  /** Added to the running clock, 0 to 1 of a day, so an admin can set the time without stopping it. */
  clockOffset: number;
  /** Where the clock stands while held, 0 to 1 of a day. */
  heldPhase: number;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { xpRate: 1, lootRate: 1, motd: '', registrationOpen: true, worldSeed: 1, dayMinutes: 20, nightBrightness: 0.6, timeOfDay: 'cycle', clockOffset: 0, heldPhase: 0.25 };

/** What clients need to light the world; sent on join and whenever an admin changes it. */
export type Lighting = Pick<ServerSettings, 'dayMinutes' | 'nightBrightness' | 'timeOfDay' | 'clockOffset' | 'heldPhase'>;

/** Where in the day the world is (0 to 1), shared by clients and the admin page so both agree. */
export function dayPhaseAt(now: number, l: Lighting): number {
  if (l.timeOfDay === 'hold') return l.heldPhase;
  return (((now / 1000 / (l.dayMinutes * 60) + l.clockOffset) % 1) + 1) % 1;
}

/** Phase 0 is 06:00, so the day runs 06:00 to about 19:10, dusk to 21:40, night until 03:40, dawn until 06:00. */
export function hourOfPhase(phase: number): number {
  return (phase * 24 + 6) % 24;
}

export function phaseOfHour(hour: number): number {
  return ((((hour - 6) / 24) % 1) + 1) % 1;
}

/** motdMax matches CHAT_MAX_LENGTH, where cleanChat would cut it anyway. */
export const SETTINGS_LIMITS = { rateMin: 0, rateMax: 20, motdMax: 200, seedMax: 999_999, dayMinutesMin: 2, dayMinutesMax: 240 } as const;

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
  if (value.dayMinutes !== undefined) {
    if (typeof value.dayMinutes !== 'number' || !Number.isFinite(value.dayMinutes) || value.dayMinutes < SETTINGS_LIMITS.dayMinutesMin || value.dayMinutes > SETTINGS_LIMITS.dayMinutesMax)
      return `dayMinutes must be between ${SETTINGS_LIMITS.dayMinutesMin} and ${SETTINGS_LIMITS.dayMinutesMax}`;
    out.dayMinutes = value.dayMinutes;
  }
  if (value.nightBrightness !== undefined) {
    if (typeof value.nightBrightness !== 'number' || !Number.isFinite(value.nightBrightness) || value.nightBrightness < 0 || value.nightBrightness > 1) return 'nightBrightness must be between 0 and 1';
    out.nightBrightness = value.nightBrightness;
  }
  if (value.timeOfDay !== undefined) {
    if (value.timeOfDay !== 'cycle' && value.timeOfDay !== 'hold') return 'timeOfDay must be cycle or hold';
    out.timeOfDay = value.timeOfDay;
  }
  for (const key of ['clockOffset', 'heldPhase'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) return `${key} must be at least 0 and below 1`;
    out[key] = v;
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
