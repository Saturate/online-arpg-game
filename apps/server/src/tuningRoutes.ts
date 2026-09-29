import { isEmptyOverride, isEnemyTypeId, isMinionTypeId, parseEnemyOverride, parseMinionOverride, type EnemyOverride, type EnemyTypeId, type MinionOverride, type MinionTypeId, type TuningOverrides } from '@rune/shared';

/** What the tuning routes need from the running game; the room manager provides it. */
export interface TuningHooks {
  tuningOverrides(): TuningOverrides;
  /** `null` resets the type. Returns every override after the change. */
  setMonsterOverride(typeId: EnemyTypeId, override: EnemyOverride | null): TuningOverrides;
  setMinionOverride(typeId: MinionTypeId, override: MinionOverride | null): TuningOverrides;
}

export interface TuningRequest {
  method: string;
  path: string;
  body: () => Promise<unknown>;
  /** Changing numbers takes the settings permission; looking needs only staff access, checked before. */
  canEdit: boolean;
  log: (what: string) => void;
}

const ROUTE = /^\/api\/admin\/(monsters|minions)(?:\/([a-z_]{1,40}))?$/;

/**
 * GET /api/admin/monsters lists every override, PUT /api/admin/monsters/<type> replaces one type's
 * override, DELETE resets it; the same under /api/admin/minions. Null means the path is not ours.
 */
export async function tuningRoute(req: TuningRequest, hooks: TuningHooks): Promise<[number, unknown] | null> {
  const match = ROUTE.exec(req.path);
  if (!match) return null;
  const kind = match[1] === 'minions' ? 'minions' : 'monsters';
  const typeId = match[2];
  if (typeId === undefined) return req.method === 'GET' ? [200, hooks.tuningOverrides()[kind]] : [405, { error: 'Use PUT or DELETE on one type' }];
  if (req.method !== 'PUT' && req.method !== 'DELETE') return [405, { error: 'Use PUT or DELETE' }];
  if (!req.canEdit) return [403, { error: 'Your role cannot do that' }];

  if (kind === 'monsters') {
    if (!isEnemyTypeId(typeId)) return [404, { error: `No monster type ${typeId}` }];
    if (req.method === 'DELETE') {
      req.log(`monsters ${typeId} reset`);
      return [200, hooks.setMonsterOverride(typeId, null).monsters];
    }
    const o = parseEnemyOverride(typeId, await req.body());
    if (typeof o === 'string') return [400, { error: o }];
    req.log(`monsters ${typeId} ${JSON.stringify(o)}`);
    return [200, hooks.setMonsterOverride(typeId, isEmptyOverride(o) ? null : o).monsters];
  }
  if (!isMinionTypeId(typeId)) return [404, { error: `No minion type ${typeId}` }];
  if (req.method === 'DELETE') {
    req.log(`minions ${typeId} reset`);
    return [200, hooks.setMinionOverride(typeId, null).minions];
  }
  const o = parseMinionOverride(typeId, await req.body());
  if (typeof o === 'string') return [400, { error: o }];
  req.log(`minions ${typeId} ${JSON.stringify(o)}`);
  return [200, hooks.setMinionOverride(typeId, isEmptyOverride(o) ? null : o).minions];
}
