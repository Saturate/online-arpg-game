import {
  activeTunables,
  applyTunables,
  parseTunablePatch,
  TUNABLES,
  TUNING_HISTORY_LIMIT,
  tunableProblem,
  tunableSpec,
  type TunablesState,
  type TunableValues,
} from '@rune/shared';
import type { TunableChange, TunablesStore, TuningAuthor } from './tunablesStore.js';

/** What the live tuning routes need from the running game; the room manager provides it. */
export interface TunablesHooks {
  /** The overrides changed: rooms recompile equipped sigils and every client hears the new set. */
  tunablesChanged(): void;
}

export interface TunablesRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: () => Promise<unknown>;
  /** Changing numbers takes the `tuning` permission; looking needs only staff access, checked before. */
  canEdit: boolean;
  by: TuningAuthor;
  log: (what: string) => void;
}

/** Big enough for every tunable at once in one patch; other admin bodies stay at the small limit. */
export const TUNABLES_BODY_BYTES = 64 * 1024;

const fmt = (v: number | null): string => (v === null ? 'default' : String(v));

function state(): TunablesState {
  return { schema: [...TUNABLES], values: activeTunables() };
}

/** Saves the changes, applies the new set everywhere and logs one staff line for them. */
function commit(req: TunablesRequest, store: TunablesStore, hooks: TunablesHooks, changes: TunableChange[], revertOf: number | null): void {
  const next: TunableValues = activeTunables();
  for (const c of changes) {
    if (c.new === null) delete next[c.path];
    else next[c.path] = c.new;
  }
  store.commit(changes, req.by, revertOf);
  applyTunables(next);
  hooks.tunablesChanged();
  const what = changes.map((c) => `${c.path} ${fmt(c.old)} -> ${fmt(c.new)}`).join(', ');
  req.log(revertOf === null ? `tuning ${what}` : `tuning revert of #${revertOf}: ${what}`);
}

/**
 * GET /api/admin/tuning is the schema and the overrides in force, PATCH changes some (path to a
 * number, or null for the code default), GET .../history lists changes newest first, and POST
 * .../revert puts back the value from before one change. Null means the path is not ours.
 */
export async function tunablesRoute(req: TunablesRequest, store: TunablesStore, hooks: TunablesHooks): Promise<[number, unknown] | null> {
  const { method, path } = req;
  if (path === '/api/admin/tuning') {
    if (method === 'GET') return [200, state()];
    if (method !== 'PATCH') return [405, { error: 'Use GET or PATCH' }];
    if (!req.canEdit) return [403, { error: 'Your role cannot do that' }];
    const patch = parseTunablePatch(await req.body());
    if (typeof patch === 'string') return [400, { error: patch }];
    const current = activeTunables();
    const changes: TunableChange[] = [];
    for (const [p, value] of Object.entries(patch)) {
      const spec = tunableSpec(p);
      // A value equal to the code default is stored as no override, so "changed" always means different.
      const next = value === null || value === spec?.default ? null : value;
      const old = current[p] ?? null;
      if (next !== old) changes.push({ path: p, old, new: next });
    }
    if (changes.length > 0) commit(req, store, hooks, changes, null);
    return [200, state()];
  }
  if (path === '/api/admin/tuning/history') {
    if (method !== 'GET') return [405, { error: 'Use GET' }];
    const raw = req.query.get('limit');
    if (raw !== null && !/^\d{1,4}$/.test(raw)) return [400, { error: `limit must be a whole number up to ${TUNING_HISTORY_LIMIT.max}` }];
    return [200, store.history(raw === null ? TUNING_HISTORY_LIMIT.default : Number(raw))];
  }
  if (path === '/api/admin/tuning/revert') {
    if (method !== 'POST') return [405, { error: 'Use POST' }];
    if (!req.canEdit) return [403, { error: 'Your role cannot do that' }];
    const body = await req.body();
    const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return [400, { error: 'id must be a history id' }];
    const entry = store.entry(id);
    if (!entry) return [404, { error: `No change #${id}` }];
    const spec = tunableSpec(entry.path);
    if (!spec) return [409, { error: `${entry.path} is no longer tunable` }];
    // The range may have narrowed since; reverting must not sneak in a value the API would refuse now.
    const problem = entry.old === null ? null : tunableProblem(spec, entry.old);
    if (problem !== null) return [409, { error: `Cannot put back ${entry.old}: ${problem}` }];
    const old = activeTunables()[entry.path] ?? null;
    if (old === entry.old) return [409, { error: `${entry.path} is already ${fmt(entry.old)}` }];
    commit(req, store, hooks, [{ path: entry.path, old, new: entry.old }], id);
    return [200, state()];
  }
  return null;
}
