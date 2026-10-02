import { GUILD_LOG_KINDS, isClassId, isGuildRank, type AdminGuildDetail, type AdminGuildMember, type AdminGuildSummary, type GuildLogEntry } from '@rune/shared';
import { call, narrow } from '../net/api.js';

/** The admin page's guild routes (apps/server/src/http.ts), with their answers narrowed before use. */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function isLeader(v: unknown): v is AdminGuildSummary['leader'] {
  return v === null || (isRecord(v) && num(v.accountId) && str(v.username) && (v.character === null || str(v.character)));
}

export function isGuildSummary(v: unknown): v is AdminGuildSummary {
  return isRecord(v) && num(v.id) && str(v.name) && str(v.tag) && num(v.createdAt) && num(v.members) && isLeader(v.leader) && num(v.tabs) && num(v.items) && typeof v.stashReadable === 'boolean';
}

function isMember(v: unknown): v is AdminGuildMember {
  return isRecord(v) && num(v.accountId) && str(v.username) && isGuildRank(v.rank) && num(v.joinedAt) && (v.character === null || str(v.character)) && (v.classId === null || isClassId(v.classId)) && num(v.level) && num(v.lastActive) && typeof v.online === 'boolean';
}

export function isLogEntry(v: unknown): v is GuildLogEntry {
  return isRecord(v) && num(v.id) && num(v.at) && GUILD_LOG_KINDS.some((k) => k === v.kind) && str(v.actor) && str(v.text);
}

function isTabRow(v: unknown): v is AdminGuildDetail['tabList'][number] {
  return isRecord(v) && num(v.id) && str(v.name) && num(v.items);
}

export function isGuildDetail(v: unknown): v is AdminGuildDetail {
  return isGuildSummary(v) && isRecord(v) && str(v.motd) && Array.isArray(v.roster) && v.roster.every(isMember) && Array.isArray(v.tabList) && v.tabList.every(isTabRow) && Array.isArray(v.log) && v.log.every(isLogEntry) && typeof v.moreLog === 'boolean';
}

function isGuildList(v: unknown): v is AdminGuildSummary[] {
  return Array.isArray(v) && v.every(isGuildSummary);
}

function isOk(v: unknown): v is { ok: true } {
  return isRecord(v) && v.ok === true;
}

export const guildsApi = {
  list: async (token: string) => narrow(await call('GET', '/api/admin/guilds', token), isGuildList),
  detail: async (token: string, id: number, before: number | null) => narrow(await call('GET', `/api/admin/guilds/${id}${before === null ? '' : `?before=${before}`}`, token), isGuildDetail),
  setLeader: async (token: string, id: number, accountId: number) => narrow(await call('POST', `/api/admin/guilds/${id}/leader`, token, { accountId }), isOk),
  /** A guild left without a Leader: this account (in no guild yet) joins it as Leader. */
  assignLeader: async (token: string, id: number, username: string) => narrow(await call('POST', `/api/admin/guilds/${id}/leader`, token, { username }), isOk),
};
