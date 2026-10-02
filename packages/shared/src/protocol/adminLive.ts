import type { ClassId } from '../data/classes.js';
import type { ServerEvent } from './adminTokens.js';
import type { Role } from './roles.js';
import type { WorldGenValues } from '../world/worldGen.js';

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

/**
 * `GET /api/admin/live?have=i1:0a1b2c3d,i2:...`: the region grids the caller holds, by world copy and
 * plan checksum, so they are not sent again.
 */
export const LIVE_HAVE = { max: 32, pattern: /^[A-Za-z0-9_-]{1,32}:[0-9a-f]{1,16}$/ } as const;

/** Parses `have`; unreadable entries are dropped, so the worst case is a grid sent again. */
export function parseLiveHave(raw: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const part of raw.split(',').slice(0, LIVE_HAVE.max)) {
    if (!LIVE_HAVE.pattern.test(part)) continue;
    const at = part.indexOf(':');
    out.set(part.slice(0, at), part.slice(at + 1));
  }
  return out;
}

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
  kind: 'public' | 'party';
  /** The copy's seed: for the public world, the `worldSeed` setting it was made on. */
  seed: number;
  /** The generation numbers the copy was built with, those off the code defaults. */
  gen: WorldGenValues;
  /** Whether those are the numbers live tuning holds now, which a new copy or a rebuild would take. */
  genCurrent: boolean;
  width: number;
  height: number;
  town: { x: number; y: number; w: number; h: number } | null;
  /** The world plan's checksum; null for a world without a plan. */
  planHash: string | null;
  /**
   * Sent only when the caller does not already hold this copy's grid for `planHash` (the `have`
   * query); null otherwise, and for a world without a plan. It never changes while the room is open.
   */
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

/** One world copy in the reply of `POST /api/admin/worlds/rebuild` or `.../reroll`. */
export interface WorldRebuildCopy {
  game: string;
  name: string;
  seed: number;
  /** Whether its world room was open and rebuilt at once; a closed one builds anew when next entered. */
  open: boolean;
  /** Players carried into the rebuilt room. */
  players: number;
  /** The seed or the numbers changed, so the plan did: its dead bosses and opened chests were forgotten. */
  planChanged: boolean;
}

export interface WorldRebuildResult {
  copies: WorldRebuildCopy[];
  /** The numbers the copies were rebuilt with, those off the code defaults. */
  gen: WorldGenValues;
}
