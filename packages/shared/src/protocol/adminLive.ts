import type { ClassId } from '../data/classes.js';
import type { ServerEvent } from './adminTokens.js';
import type { Role } from './roles.js';

/**
 * `GET /api/admin/live`, the admin page's Live view (docs/features/admin-ui.md), and
 * `GET /api/admin/search`. Everything here needs `viewAdmin` except `log` and `staff`, which need
 * `serverLog` and are null for a caller without it: the server leaves them out, it does not just
 * hide them on the page.
 */

/** The server's tick budget: one simulation step every 50 ms. */
export const TICK_BUDGET_MS = 50;

/** Per-second tick time samples the health sparkline covers. */
export const TICK_HISTORY_SECONDS = 300;

/** How many lines each log tail carries. */
export const LIVE_TAIL = { log: 60, staff: 40 } as const;

export interface LivePlayer {
  characterId: number;
  accountId: number;
  account: string;
  name: string;
  classId: ClassId;
  level: number;
  /** The world copy's id, or null between rooms. */
  game: string | null;
  roomId: string;
  room: string;
  /** The world's region or the town, otherwise the room's name. */
  region: string;
  /** The party's leader and size, as "Bob's party (3)". */
  party: string | null;
  onlineSeconds: number;
}

export type LiveRoomKind = 'world' | 'dungeon' | 'antechamber' | 'arena' | 'arenaGate' | 'sandbox' | 'other';

export interface LiveRoom {
  id: string;
  name: string;
  kind: LiveRoomKind;
  game: string | null;
  players: number;
  monsters: number;
  minions: number;
  /** Projectiles, novas and ground zones alive right now. */
  spells: number;
  /** Mean and worst tick over the last few seconds, in ms. */
  tickMs: number;
  tickMaxMs: number;
}

export interface LiveHealth {
  build: string;
  uptimeSeconds: number;
  /** Resident set and JS heap. */
  memoryMb: number;
  heapMb: number;
  /** Whole-server tick (every room), mean and worst over the last 10 s. */
  tickMs: number;
  tickMaxMs: number;
  /** One sample per second, oldest first, at most TICK_HISTORY_SECONDS. */
  tickHistory: { mean: number[]; max: number[] };
  /** Open WebSocket connections, and how many of them have a character in the game. */
  connections: number;
  inGame: number;
  /** Messages per second over the last 10 s. */
  messagesIn: number;
  messagesOut: number;
}

export interface LiveWorldDot {
  x: number;
  y: number;
  name: string;
  inParty: boolean;
}

/** A coarse region grid of a world copy, so the minimap can tint regions without the world plan. */
export interface LiveRegionGrid {
  cols: number;
  rows: number;
  /** Row-major indexes into `names`. */
  cells: number[];
  names: string[];
}

export interface LiveWorld {
  game: string;
  name: string;
  width: number;
  height: number;
  town: { x: number; y: number; w: number; h: number } | null;
  regions: LiveRegionGrid | null;
  dots: LiveWorldDot[];
}

export interface AdminLive {
  health: LiveHealth;
  players: LivePlayer[];
  rooms: LiveRoom[];
  worlds: LiveWorld[];
  /** Newest first, without staff lines; null without `serverLog`. */
  log: ServerEvent[] | null;
  /** Staff changes, newest first, without token reads; null without `serverLog`. */
  staff: ServerEvent[] | null;
}

/** The query `GET /api/admin/search?q=` takes, after trimming. */
export const SEARCH_QUERY = { min: 2, max: 64 } as const;
export const SEARCH_LIMITS = { accounts: 20, log: 30 } as const;

export interface SearchAccount {
  id: number;
  username: string;
  role: Role;
  banned: boolean;
  guest: boolean;
  characters: { id: number; name: string; classId: ClassId; level: number }[];
}

export interface AdminSearch {
  accounts: SearchAccount[];
  /** Newest first; null without `serverLog`. */
  log: ServerEvent[] | null;
}
