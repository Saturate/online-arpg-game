import { isClassId, type ClassId } from '../data/classes.js';

/** Account and character management runs over plain HTTP (see apps/server/src/http.ts); only play uses the socket. */

export const ACCOUNT_RULES = {
  usernamePattern: /^[A-Za-z0-9_]{3,16}$/,
  /** Letters first so names never look like ids or numbers in chat and party lists. */
  characterNamePattern: /^[A-Za-z][A-Za-z0-9_-]{2,15}$/,
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
