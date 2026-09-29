import { parseTuningOverrides, type EnemyOverride, type EnemyTypeId, type MinionOverride, type MinionTypeId, type TuningOverrides } from '@rune/shared';
import { call, type ApiResult } from '../../net/api.js';

/** The server re-validates on its side; parsing here keeps a bad response from reaching the editor. */
function overridesOf(r: ApiResult<unknown>, kind: 'monsters'): ApiResult<TuningOverrides['monsters']>;
function overridesOf(r: ApiResult<unknown>, kind: 'minions'): ApiResult<TuningOverrides['minions']>;
function overridesOf(r: ApiResult<unknown>, kind: 'monsters' | 'minions'): ApiResult<TuningOverrides['monsters'] | TuningOverrides['minions']> {
  if (!r.ok) return r;
  return { ok: true, data: parseTuningOverrides({ [kind]: r.data })[kind] };
}

export const tuningApi = {
  monsters: async (token: string) => overridesOf(await call('GET', '/api/admin/monsters', token), 'monsters'),
  minions: async (token: string) => overridesOf(await call('GET', '/api/admin/minions', token), 'minions'),
  saveMonster: async (token: string, id: EnemyTypeId, o: EnemyOverride) => overridesOf(await call('PUT', `/api/admin/monsters/${id}`, token, o), 'monsters'),
  saveMinion: async (token: string, id: MinionTypeId, o: MinionOverride) => overridesOf(await call('PUT', `/api/admin/minions/${id}`, token, o), 'minions'),
  resetMonster: async (token: string, id: EnemyTypeId) => overridesOf(await call('DELETE', `/api/admin/monsters/${id}`, token), 'monsters'),
  resetMinion: async (token: string, id: MinionTypeId) => overridesOf(await call('DELETE', `/api/admin/minions/${id}`, token), 'minions'),
};
