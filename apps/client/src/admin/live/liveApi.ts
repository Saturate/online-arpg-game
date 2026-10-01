import { isClassId, isRole, type AdminLive, type AdminSearch, type LiveHealth, type LivePlayer, type LiveRoom, type LiveRoomKind, type LiveWorld, type SearchAccount, type ServerEvent, type ServerLogResponse } from '@rune/shared';
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
  return str(v.game) && str(v.name) && num(v.width) && num(v.height) && (v.town === null || isRect(v.town)) && (v.planHash === null || str(v.planHash)) && regionsOk && dotsOk;
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

export const liveApi = {
  live: async (token: string, have = '') => narrow(await call('GET', `/api/admin/live${have ? `?have=${encodeURIComponent(have)}` : ''}`, token), isAdminLive),
  search: async (token: string, q: string) => narrow(await call('GET', `/api/admin/search?q=${encodeURIComponent(q)}`, token), isSearch),
  log: async (token: string, since: number) => narrow(await call('GET', `/api/admin/log?since=${since}`, token), isLogResponse),
};
