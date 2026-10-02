import { isClassId, isRole, isWorldGenValues, type AdminLive, type WorldRebuildCopy, type WorldRebuildFailure, type WorldRebuildResult, type AdminSearch, type LiveHealth, type LivePlayer, type LiveRoom, type LiveRoomKind, type LiveWorld, type SearchAccount, type ServerEvent, type ServerLogResponse } from '@rune/shared';
import { call, narrow } from '../../net/api.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const numList = (v: unknown): v is number[] => Array.isArray(v) && v.every(num);
const listOf = <T>(v: unknown, guard: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(guard);

const ROOM_KINDS: readonly LiveRoomKind[] = ['world', 'dungeon', 'antechamber', 'arena', 'arenaGate', 'sandbox', 'other'];
const EVENT_KINDS = ['conversion', 'save', 'error', 'staff', 'players', 'server'] as const;

export function isServerEvent(v: unknown): v is ServerEvent {
  return isRecord(v) && num(v.id) && num(v.at) && str(v.text) && EVENT_KINDS.some((k) => k === v.kind);
}

function isPlayer(v: unknown): v is LivePlayer {
  return isRecord(v) && num(v.characterId) && num(v.accountId) && str(v.account) && str(v.name) && isClassId(v.classId) && num(v.level) && (v.game === null || str(v.game)) && str(v.roomId) && str(v.room) && str(v.region) && (v.party === null || str(v.party)) && num(v.onlineSeconds);
}

function isRoom(v: unknown): v is LiveRoom {
  return isRecord(v) && str(v.id) && str(v.name) && ROOM_KINDS.some((k) => k === v.kind) && (v.game === null || str(v.game)) && num(v.players) && num(v.monsters) && num(v.minions) && num(v.spells) && num(v.tickMs) && num(v.tickMaxMs);
}

function isHealth(v: unknown): v is LiveHealth {
  if (!isRecord(v) || !isRecord(v.tickHistory)) return false;
  return str(v.build) && num(v.uptimeSeconds) && num(v.memoryMb) && num(v.heapMb) && num(v.tickMs) && num(v.tickMaxMs) && numList(v.tickHistory.mean) && numList(v.tickHistory.max) && num(v.connections) && num(v.inGame) && num(v.messagesIn) && num(v.messagesOut);
}

function isRect(v: unknown): v is { x: number; y: number; w: number; h: number } {
  return isRecord(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h);
}

function isWorld(v: unknown): v is LiveWorld {
  if (!isRecord(v)) return false;
  const r = v.regions;
  const regionsOk = r === null || (isRecord(r) && num(r.cols) && num(r.rows) && numList(r.cells) && Array.isArray(r.names) && r.names.every(str));
  const dotsOk = Array.isArray(v.dots) && v.dots.every((d) => isRecord(d) && num(d.x) && num(d.y) && str(d.name) && typeof d.inParty === 'boolean');
  const kindOk = v.kind === 'public' || v.kind === 'party';
  return str(v.game) && str(v.name) && kindOk && num(v.seed) && isWorldGenValues(v.gen) && typeof v.genCurrent === 'boolean' && num(v.width) && num(v.height) && (v.town === null || isRect(v.town)) && (v.planHash === null || str(v.planHash)) && regionsOk && dotsOk;
}

const eventsOrNull = (v: unknown): boolean => v === null || listOf(v, isServerEvent);

export function isAdminLive(v: unknown): v is AdminLive {
  return isRecord(v) && isHealth(v.health) && listOf(v.players, isPlayer) && listOf(v.rooms, isRoom) && listOf(v.worlds, isWorld) && eventsOrNull(v.log) && eventsOrNull(v.staff);
}

function isSearchAccount(v: unknown): v is SearchAccount {
  return isRecord(v) && num(v.id) && str(v.username) && isRole(v.role) && typeof v.banned === 'boolean' && typeof v.guest === 'boolean' && Array.isArray(v.characters) && v.characters.every((c) => isRecord(c) && num(c.id) && str(c.name) && isClassId(c.classId) && num(c.level));
}

function isSearch(v: unknown): v is AdminSearch {
  return isRecord(v) && listOf(v.accounts, isSearchAccount) && eventsOrNull(v.log);
}

function isLogResponse(v: unknown): v is ServerLogResponse {
  return isRecord(v) && num(v.startedAt) && num(v.next) && typeof v.missed === 'boolean' && listOf(v.entries, isServerEvent);
}

function isRebuildCopy(v: unknown): v is WorldRebuildCopy {
  return isRecord(v) && str(v.game) && str(v.name) && num(v.seed) && typeof v.open === 'boolean' && num(v.players) && typeof v.planChanged === 'boolean';
}

function isRebuildFailure(v: unknown): v is WorldRebuildFailure {
  return isRecord(v) && str(v.game) && str(v.name) && str(v.reason);
}

export function isWorldRebuildResult(v: unknown): v is WorldRebuildResult {
  return isRecord(v) && listOf(v.copies, isRebuildCopy) && listOf(v.failed, isRebuildFailure) && isWorldGenValues(v.gen);
}

export const liveApi = {
  live: async (token: string, have = '') => narrow(await call('GET', `/api/admin/live${have ? `?have=${encodeURIComponent(have)}` : ''}`, token), isAdminLive),
  search: async (token: string, q: string) => narrow(await call('GET', `/api/admin/search?q=${encodeURIComponent(q)}`, token), isSearch),
  log: async (token: string, since: number) => narrow(await call('GET', `/api/admin/log?since=${since}`, token), isLogResponse),
  /** Every copy without `game`; a public copy brings every public copy on its seed. */
  rebuild: async (token: string, game?: string) => narrow(await call('POST', '/api/admin/worlds/rebuild', token, game === undefined ? {} : { game }), isWorldRebuildResult),
  /** A random seed, or `seed` pinned. */
  reroll: async (token: string, game: string, seed?: number) => narrow(await call('POST', '/api/admin/worlds/reroll', token, seed === undefined ? { game } : { game, seed }), isWorldRebuildResult),
};

/** One line for the admin after a rebuild or reroll: what moved, and which copies forgot their bosses and chests. */
export function rebuildSummary(r: WorldRebuildResult, verb: string): string {
  const failed = r.failed.map((f) => `${f.name} was left as it was: ${f.reason}`).join('; ');
  if (r.copies.length === 0) return failed || 'No world copy to rebuild';
  const players = r.copies.reduce((n, c) => n + c.players, 0);
  const fresh = r.copies.filter((c) => c.planChanged).map((c) => c.name);
  const closed = r.copies.filter((c) => !c.open).length;
  const parts = [`${verb} ${r.copies.length} world cop${r.copies.length === 1 ? 'y' : 'ies'}, ${players} player${players === 1 ? '' : 's'} carried over`];
  if (closed > 0) parts.push(`${closed} closed, built anew when next entered`);
  parts.push(fresh.length > 0 ? `new ground in ${fresh.join(', ')}: dead bosses and opened chests there are forgotten` : 'the ground is unchanged, so bosses and chests stay as they were');
  if (failed) parts.push(failed);
  return parts.join('; ');
}
