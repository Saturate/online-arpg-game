import { isClassId, type ClassId } from '../data/classes.js';

/** Live state of an Arena run, sent to everyone inside whenever it changes. */
export interface ArenaStatus {
  t: 'arena';
  wave: number;
  score: number;
  /** Players still standing, and everyone who is in the run. */
  alive: number;
  inside: number;
  /** Whole seconds until the next wave, during a breather; null while monsters are up. */
  nextWaveIn: number | null;
}

export type ArenaBoard = 'solo' | 'party';

/** The score screen at the end of a run. */
export interface ArenaResult {
  t: 'arenaResult';
  score: number;
  wave: number;
  seconds: number;
  kills: number;
  party: { name: string; cls: ClassId }[];
  season: string;
  board: ArenaBoard;
  /** Place on this season's board, or null when the run was not recorded (it ended before wave 1). */
  rank: number | null;
  /** Seconds until everyone still here is sent back to the Arena gate. */
  returnIn: number;
}

export interface LeaderboardEntry {
  names: string[];
  classes: ClassId[];
  partySize: number;
  score: number;
  wave: number;
  seconds: number;
  finishedAt: number;
  /**
   * Someone in the party has dev tools (builder and up), who can give themselves gear anywhere. Such
   * runs stay on the board, marked, rather than hidden, since the owner plays too.
   */
  staff: boolean;
}

export interface SeasonWinners {
  season: string;
  solo: LeaderboardEntry | null;
  party: LeaderboardEntry | null;
}

export interface LeaderboardResponse {
  season: string;
  solo: LeaderboardEntry[];
  party: LeaderboardEntry[];
  /** The best solo and party run of every earlier season, newest first. */
  winners: SeasonWinners[];
}

/** Seasons are calendar months in UTC, so everyone agrees on when one ends. */
export function seasonOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isSeason(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return false;
  const month = Number(v.slice(5));
  return month >= 1 && month <= 12;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEntry(v: unknown): v is LeaderboardEntry {
  return (
    isRecord(v) &&
    Array.isArray(v.names) &&
    v.names.every((n) => typeof n === 'string') &&
    Array.isArray(v.classes) &&
    v.classes.every(isClassId) &&
    typeof v.partySize === 'number' &&
    typeof v.score === 'number' &&
    typeof v.wave === 'number' &&
    typeof v.seconds === 'number' &&
    typeof v.staff === 'boolean' &&
    typeof v.finishedAt === 'number'
  );
}

function isWinners(v: unknown): v is SeasonWinners {
  return isRecord(v) && isSeason(v.season) && (v.solo === null || isEntry(v.solo)) && (v.party === null || isEntry(v.party));
}

/** For the client: the board comes over plain HTTP, so its shape is checked before use. */
export function isLeaderboardResponse(v: unknown): v is LeaderboardResponse {
  return isRecord(v) && isSeason(v.season) && Array.isArray(v.solo) && v.solo.every(isEntry) && Array.isArray(v.party) && v.party.every(isEntry) && Array.isArray(v.winners) && v.winners.every(isWinners);
}
