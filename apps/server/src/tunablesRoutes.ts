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
import { events } from './eventLog.js';
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
  /** False when this account has made too many changes in the last minute. */
  allowWrite: () => boolean;
  by: TuningAuthor;
  log: (what: string) => void;
}

/** Big enough for every tunable at once in one patch; other admin bodies stay at the small limit. */
export const TUNABLES_BODY_BYTES = 64 * 1024;

const fmt = (v: number | null): string => (v === null ? 'default' : String(v));

function state(warning?: string): TunablesState {
  return { schema: [...TUNABLES], values: activeTunables(), ...(warning === undefined ? {} : { warning }) };
}

/**
 * Saves the changes, applies the new set and logs one staff line for them. The change is stored and
 * applied before the rooms and clients hear of it, so if that last step fails the reply still says
 * it was saved, with a warning, rather than an error for a change that took effect.
 */
function commit(req: TunablesRequest, store: TunablesStore, hooks: TunablesHooks, changes: TunableChange[], revertOf: number | null): string | undefined {
  const next: TunableValues = activeTunables();
  for (const c of changes) {
    if (c.new === null) delete next[c.path];
    else next[c.path] = c.new;
  }
  store.commit(changes, req.by, revertOf);
  applyTunables(next);
  const what = changes.map((c) => `${c.path} ${fmt(c.old)} -> ${fmt(c.new)}`).join(', ');
  req.log(revertOf === null ? `tuning ${what}` : `tuning revert of #${revertOf}: ${what}`);
  try {
    hooks.tunablesChanged();
    return undefined;
  } catch (err) {
    events.error('error', '[tuning] a change was saved and applied, but updating rooms or clients failed', err);
    return 'Saved and applied, but updating running rooms or clients failed; see the server log';
  }
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
    if (!req.allowWrite()) return [429, { error: 'Too many tuning changes; wait a minute' }];
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
    return [200, state(changes.length > 0 ? commit(req, store, hooks, changes, null) : undefined)];
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
    if (!req.allowWrite()) return [429, { error: 'Too many tuning changes; wait a minute' }];
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
    // As in a PATCH, the code default is stored as no override.
    const target = entry.old === spec.default ? null : entry.old;
    const old = activeTunables()[entry.path] ?? null;
    if (old === target) return [409, { error: `${entry.path} is already ${fmt(target)}` }];
    return [200, state(commit(req, store, hooks, [{ path: entry.path, old, new: target }], id))];
  }
  return null;
}
