import type { CharacterSummary, CharactersResponse, ClassId, SessionResponse } from '@rune/shared';

/**
 * Account and character calls. Paths are same-origin: Vite proxies /api to the game server in dev,
 * and a production deploy serves both from one host, so no CORS is needed or allowed.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<ApiResult<unknown>> {
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
  return isRecord(v) && typeof v.id === 'number' && typeof v.name === 'string' && typeof v.classId === 'string';
}

function isCharacters(v: unknown): v is CharactersResponse {
  return isRecord(v) && typeof v.username === 'string' && Array.isArray(v.characters) && v.characters.every(isCharacter);
}

function narrow<T>(r: ApiResult<unknown>, guard: (v: unknown) => v is T): ApiResult<T> {
  if (!r.ok) return r;
  return guard(r.data) ? { ok: true, data: r.data } : { ok: false, status: 502, error: 'Unexpected server response' };
}

export const api = {
  register: async (username: string, password: string) => narrow(await call('POST', '/api/register', null, { username, password }), isSession),
  login: async (username: string, password: string) => narrow(await call('POST', '/api/login', null, { username, password }), isSession),
  logout: (token: string) => call('POST', '/api/logout', token, {}),
  characters: async (token: string) => narrow(await call('GET', '/api/characters', token), isCharacters),
  createCharacter: async (token: string, name: string, classId: ClassId) => narrow(await call('POST', '/api/characters', token, { name, classId }), isCharacter),
  deleteCharacter: (token: string, id: number) => call('DELETE', `/api/characters/${id}`, token),
};
