import { isBenchPick, isBenchState, type BenchPick, type BenchSpell } from '@rune/shared';
import { call, type ApiResult } from '../../net/api.js';

function checked<T>(r: ApiResult<unknown>, is: (v: unknown) => v is T, what: string): ApiResult<T> {
  if (!r.ok) return r;
  return is(r.data) ? { ok: true, data: r.data } : { ok: false, status: 0, error: `The server sent an unreadable ${what}` };
}

export const benchApi = {
  state: async (token: string) => checked(await call('GET', '/api/admin/bench', token), isBenchState, 'bench'),
  add: async (token: string, spell: BenchSpell): Promise<ApiResult<BenchPick>> => checked(await call('POST', '/api/admin/bench/picks', token, spell), isBenchPick, 'pick'),
  remove: async (token: string, id: number): Promise<ApiResult<unknown>> => call('DELETE', `/api/admin/bench/picks/${id}`, token),
};
