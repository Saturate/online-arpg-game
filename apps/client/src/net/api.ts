import { isClassId, isItemShape, isLeaderboardResponse, isRole, type GrantRequest, type Item, type AdminAccount, type AdminCharacter, type AdminOnlinePlayer, type AdminOverview, type AssignableRole, type CharacterSummary, type CharactersResponse, type ClassId, type ServerSettings, type SessionResponse } from '@rune/shared';

/**
 * Account and character calls. Paths are same-origin: Vite proxies /api to the game server in dev,
 * and a production deploy serves both from one host, so no CORS is needed or allowed.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function call(method: string, path: string, token: string | null, body?: unknown): Promise<ApiResult<unknown>> {
  let res: Response;
  try {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server' };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON error page (proxy down, server restarting): fall through to the status text.
  }
  if (!res.ok) return { ok: false, status: res.status, error: isRecord(json) && typeof json.error === 'string' ? json.error : res.statusText || 'Request failed' };
  return { ok: true, data: json };
}

function isSession(v: unknown): v is SessionResponse {
  return isRecord(v) && typeof v.token === 'string' && typeof v.username === 'string';
}

function isCharacter(v: unknown): v is CharacterSummary {
  return isRecord(v) && typeof v.id === 'number' && typeof v.name === 'string' && isClassId(v.classId) && typeof v.createdAt === 'number' && typeof v.playedAt === 'number';
}

function isCharacters(v: unknown): v is CharactersResponse {
  return isRecord(v) && typeof v.username === 'string' && isRole(v.role) && typeof v.guest === 'boolean' && Array.isArray(v.characters) && v.characters.every(isCharacter);
}

function isOnlinePlayer(v: unknown): v is AdminOnlinePlayer {
  return (
    isRecord(v) &&
    typeof v.characterId === 'number' &&
    typeof v.name === 'string' &&
    isClassId(v.classId) &&
    typeof v.level === 'number' &&
    typeof v.account === 'string' &&
    (v.game === null || typeof v.game === 'string') &&
    typeof v.room === 'string'
  );
}

function isGameRow(v: unknown): v is AdminOverview['games'][number] {
  return isRecord(v) && typeof v.id === 'string' && typeof v.host === 'string' && typeof v.players === 'number' && typeof v.rooms === 'number';
}

function isRoomRow(v: unknown): v is AdminOverview['rooms'][number] {
  return isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.players === 'number' && typeof v.monsters === 'number';
}

function isOverview(v: unknown): v is AdminOverview {
  return (
    isRecord(v) &&
    typeof v.build === 'string' &&
    typeof v.uptimeSeconds === 'number' &&
    typeof v.memoryMb === 'number' &&
    Array.isArray(v.online) &&
    v.online.every(isOnlinePlayer) &&
    Array.isArray(v.games) &&
    v.games.every(isGameRow) &&
    Array.isArray(v.rooms) &&
    v.rooms.every(isRoomRow)
  );
}

function isAdminCharacter(v: unknown): v is AdminCharacter {
  return isCharacter(v) && isRecord(v) && typeof v.level === 'number';
}

function isAccounts(v: unknown): v is AdminAccount[] {
  return Array.isArray(v) && v.every((a) => isRecord(a) && typeof a.id === 'number' && typeof a.username === 'string' && typeof a.createdAt === 'number' && typeof a.banned === 'boolean' && typeof a.guest === 'boolean' && isRole(a.role) && Array.isArray(a.characters) && a.characters.every(isAdminCharacter));
}

function isSettings(v: unknown): v is ServerSettings {
  return isRecord(v) && typeof v.xpRate === 'number' && typeof v.lootRate === 'number' && typeof v.motd === 'string' && typeof v.registrationOpen === 'boolean' && typeof v.worldSeed === 'number' && typeof v.dayMinutes === 'number' && typeof v.nightBrightness === 'number' && (v.timeOfDay === 'cycle' || v.timeOfDay === 'hold') && typeof v.clockOffset === 'number' && typeof v.heldPhase === 'number' && typeof v.heroLight === 'number' && typeof v.heroLightRadius === 'number' && typeof v.lampLight === 'number';
}

function isClaimed(v: unknown): v is { username: string } {
  return isRecord(v) && typeof v.username === 'string';
}

function isOk(v: unknown): v is { ok: true } {
  return isRecord(v) && v.ok === true;
}

function isKicked(v: unknown): v is { kicked: boolean } {
  return isRecord(v) && typeof v.kicked === 'boolean';
}

function isReached(v: unknown): v is { reached: number } {
  return isRecord(v) && typeof v.reached === 'number';
}

export interface GrantResponse {
  item: Item;
  character: string;
}

function isGrantResponse(v: unknown): v is GrantResponse {
  return isRecord(v) && isItemShape(v.item) && typeof v.character === 'string';
}

export function narrow<T>(r: ApiResult<unknown>, guard: (v: unknown) => v is T): ApiResult<T> {
  if (!r.ok) return r;
  return guard(r.data) ? { ok: true, data: r.data } : { ok: false, status: 502, error: 'Unexpected server response' };
}

export const api = {
  register: async (username: string, password: string) => narrow(await call('POST', '/api/register', null, { username, password }), isSession),
  login: async (username: string, password: string) => narrow(await call('POST', '/api/login', null, { username, password }), isSession),
  guest: async () => narrow(await call('POST', '/api/guest', null, {}), isSession),
  claim: async (token: string, username: string, password: string) => narrow(await call('POST', '/api/claim', token, { username, password }), isClaimed),
  logout: (token: string) => call('POST', '/api/logout', token, {}),
  characters: async (token: string) => narrow(await call('GET', '/api/characters', token), isCharacters),
  createCharacter: async (token: string, name: string, classId: ClassId) => narrow(await call('POST', '/api/characters', token, { name, classId }), isCharacter),
  deleteCharacter: (token: string, id: number) => call('DELETE', `/api/characters/${id}`, token),
  /** No season means the current one. */
  leaderboard: async (season?: string) => narrow(await call('GET', `/api/arena/leaderboard${season ? `?season=${encodeURIComponent(season)}` : ''}`, null), isLeaderboardResponse),
};

export const adminApi = {
  overview: async (token: string) => narrow(await call('GET', '/api/admin/overview', token), isOverview),
  accounts: async (token: string) => narrow(await call('GET', '/api/admin/accounts', token), isAccounts),
  settings: async (token: string) => narrow(await call('GET', '/api/admin/settings', token), isSettings),
  saveSettings: async (token: string, patch: Partial<ServerSettings>) => narrow(await call('PUT', '/api/admin/settings', token, patch), isSettings),
  setRole: async (token: string, accountId: number, role: AssignableRole) => narrow(await call('POST', `/api/admin/accounts/${accountId}/role`, token, { role }), isOk),
  ban: async (token: string, accountId: number, banned: boolean) => narrow(await call('POST', `/api/admin/accounts/${accountId}/ban`, token, { banned }), isOk),
  goto: async (token: string, characterId: number) => narrow(await call('POST', '/api/admin/goto', token, { characterId }), isOk),
  kick: async (token: string, characterId: number) => narrow(await call('POST', '/api/admin/kick', token, { characterId }), isKicked),
  announce: async (token: string, text: string) => narrow(await call('POST', '/api/admin/announce', token, { text }), isReached),
  grant: async (token: string, req: GrantRequest) => narrow(await call('POST', '/api/admin/grant', token, req), isGrantResponse),
};
