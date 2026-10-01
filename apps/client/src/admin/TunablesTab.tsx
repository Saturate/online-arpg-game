import {
  can,
  isTunableHistoryEntry,
  isTunablesState,
  TUNING_CATEGORIES,
  TUNING_CATEGORY_NAMES,
  tunableProblem,
  type Role,
  type TunableHistoryEntry,
  type TunableSpec,
  type TunablesState,
  type TuningCategory,
} from '@rune/shared';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { call, type ApiResult } from '../net/api.js';
import { searchId, type Jump } from './tabs.js';
import './tunables.css';

/** The server checks every value again; checking the reply keeps a bad response out of the editor. */
function stateOf(r: ApiResult<unknown>): ApiResult<TunablesState> {
  if (!r.ok) return r;
  return isTunablesState(r.data) ? { ok: true, data: r.data } : { ok: false, status: 0, error: 'The server sent an unreadable tuning list' };
}

function historyOf(r: ApiResult<unknown>): ApiResult<TunableHistoryEntry[]> {
  if (!r.ok) return r;
  return Array.isArray(r.data) && r.data.every(isTunableHistoryEntry) ? { ok: true, data: r.data } : { ok: false, status: 0, error: 'The server sent an unreadable history' };
}

const tunablesApi = {
  state: async (token: string) => stateOf(await call('GET', '/api/admin/tuning', token)),
  patch: async (token: string, patch: Record<string, number | null>) => stateOf(await call('PATCH', '/api/admin/tuning', token, patch)),
  history: async (token: string) => historyOf(await call('GET', '/api/admin/tuning/history', token)),
  revert: async (token: string, id: number) => stateOf(await call('POST', '/api/admin/tuning/revert', token, { id })),
};

type View = TuningCategory | 'changed';

const fmt = (n: number): string => String(Number(n.toPrecision(6)));
const fmtOrDefault = (n: number | null): string => (n === null ? 'default' : fmt(n));

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** What an edit box holds as a number to save, or a reason it cannot be saved. */
function parsed(spec: TunableSpec, text: string): number | string {
  if (text.trim() === '') return 'empty';
  const n = Number(text);
  return tunableProblem(spec, n) ?? n;
}

function Row({ spec, saved, edit, editable, onEdit }: { spec: TunableSpec; saved: number | undefined; edit: string | undefined; editable: boolean; onEdit: (text: string | undefined) => void }) {
  const live = saved ?? spec.default;
  const text = edit ?? fmt(live);
  const value = parsed(spec, text);
  const bad = typeof value === 'string';
  const unsaved = edit !== undefined && value !== live;
  return (
    <tr className={saved !== undefined ? 'tun-over' : ''} data-search-id={searchId('tuning', spec.path)}>
      <th scope="row" title={spec.note ?? spec.path}>
        {spec.label}
        <span className="mono tun-path">{spec.path}</span>
      </th>
      <td>
        <input
          type="number"
          step={spec.int ? 1 : 'any'}
          min={spec.min}
          max={spec.max}
          disabled={!editable}
          value={text}
          aria-label={spec.label}
          data-search-field
          className={bad ? 'tun-bad' : ''}
          title={bad ? value : `Allowed ${spec.min} to ${spec.max}`}
          onChange={(e) => onEdit(e.target.value)}
        />
      </td>
      <td className="muted small" title={`Allowed ${spec.min} to ${spec.max}`}>
        code {fmt(spec.default)}
      </td>
      <td>
        <div className="tun-mark">
          {saved !== undefined && <span className="badge gold" title={`Saved override ${fmt(saved)}`}>changed</span>}
          {unsaved && <span className="badge" title={`Live now: ${fmt(live)}`}>unsaved</span>}
          {editable && (saved !== undefined || unsaved) && (
            <button type="button" className="small" title="Back to the code default" onClick={() => onEdit(saved === undefined ? undefined : fmt(spec.default))}>
              reset
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Live tuning (docs/features/live-tuning.md): every spell shape and rune number with its code
 * default, edited and saved without a deploy, and the history of every change with revert.
 */
export function TunablesTab({ token, role, notify, focus }: { token: string; role: Role; notify: (t: string) => void; focus: Jump | null }) {
  const editable = can(role, 'tuning');
  const [server, setServer] = useState<TunablesState | null>(null);
  const [history, setHistory] = useState<TunableHistoryEntry[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>('runes');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // A jump from the search shows the number by its path (and any it is a prefix of).
  useEffect(() => {
    if (focus) setSearch(focus.target);
  }, [focus]);

  const loadHistory = useCallback(async () => {
    const h = await tunablesApi.history(token);
    if (h.ok) setHistory(h.data);
    else notify(h.error);
  }, [token, notify]);

  useEffect(() => {
    void tunablesApi.state(token).then((r) => (r.ok ? setServer(r.data) : notify(r.error)));
    void loadHistory();
  }, [token, notify, loadHistory]);

  const specs = useMemo(() => new Map((server?.schema ?? []).map((s) => [s.path, s])), [server]);
  const values = server?.values ?? {};

  /** Only edits that differ from what is live go to the server; the code default is sent as null. */
  const pending = useMemo(() => {
    const patch: Record<string, number | null> = {};
    let bad = 0;
    for (const [path, text] of Object.entries(edits)) {
      const spec = specs.get(path);
      if (!spec) continue;
      const v = parsed(spec, text);
      if (typeof v === 'string') {
        bad++;
        continue;
      }
      if (v !== (values[path] ?? spec.default)) patch[path] = v === spec.default ? null : v;
    }
    return { patch, count: Object.keys(patch).length, bad };
  }, [edits, specs, values]);

  if (!server) return <p className="muted">Loading</p>;

  const q = search.trim().toLowerCase();
  const shown = server.schema.filter((s) => {
    if (q !== '') return s.label.toLowerCase().includes(q) || s.path.toLowerCase().includes(q);
    if (view === 'changed') return values[s.path] !== undefined || edits[s.path] !== undefined;
    return s.category === view;
  });
  const changedIn = (c: TuningCategory) => server.schema.filter((s) => s.category === c && values[s.path] !== undefined).length;
  const totalChanged = Object.keys(values).length;

  const pick = (v: View) => {
    setView(v);
    setSearch('');
  };

  const setEdit = (path: string, text: string | undefined) => {
    const next = { ...edits };
    if (text === undefined) delete next[path];
    else next[path] = text;
    setEdits(next);
  };

  const applied = (r: ApiResult<TunablesState>, done: string) => {
    setBusy(false);
    if (!r.ok) return notify(r.error);
    setServer(r.data);
    setEdits({});
    notify(r.data.warning ?? done);
    void loadHistory();
  };

  const save = async () => {
    setBusy(true);
    applied(await tunablesApi.patch(token, pending.patch), `Saved ${pending.count} value${pending.count === 1 ? '' : 's'}; the next cast uses them`);
  };

  const revert = async (h: TunableHistoryEntry) => {
    setBusy(true);
    applied(await tunablesApi.revert(token, h.id), `${h.path} is back to ${fmtOrDefault(h.old)}`);
  };

  return (
    <div className="tun-layout">
      <aside className="tun-cats">
        <input type="search" placeholder="Search every number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tunables" />
        <ul>
          {TUNING_CATEGORIES.map((c) => (
            <li key={c}>
              <button type="button" className={q === '' && view === c ? 'on' : ''} onClick={() => pick(c)}>
                {TUNING_CATEGORY_NAMES[c]}
                {changedIn(c) > 0 && <span className="tun-count">{changedIn(c)}</span>}
              </button>
            </li>
          ))}
          <li>
            <button type="button" className={q === '' && view === 'changed' ? 'on' : ''} onClick={() => pick('changed')}>
              Everything changed
              {totalChanged > 0 && <span className="tun-count">{totalChanged}</span>}
            </button>
          </li>
        </ul>
      </aside>

      <section className="tun-edit">
        <header>
          <h2>{q !== '' ? `Search: ${search.trim()}` : view === 'changed' ? 'Everything changed' : TUNING_CATEGORY_NAMES[view]}</h2>
          {editable && (
            <div className="tun-actions">
              <button type="button" className="primary" disabled={pending.count === 0 || pending.bad > 0 || busy} onClick={() => void save()}>
                Save {pending.count > 0 ? pending.count : ''}
              </button>
              <button type="button" disabled={Object.keys(edits).length === 0 || busy} onClick={() => setEdits({})}>
                Discard
              </button>
            </div>
          )}
        </header>
        <p className="muted small">
          {editable ? 'Saved numbers reach every room on the next cast or spawn, and every player’s tooltips at once. Nothing is refused for balance.' : 'Your role can look but not change numbers; that takes the tuning permission.'}
          {pending.bad > 0 && <span className="badge red">{pending.bad} out of range</span>}
        </p>
        {shown.length === 0 ? (
          <p className="muted">Nothing here.</p>
        ) : (
          <table className="tun-table">
            <tbody>
              {shown.map((s, i) => (
                <Fragment key={s.path}>
                  {s.group !== undefined && s.group !== shown[i - 1]?.group && (
                    <tr className="tun-group">
                      <th colSpan={4} scope="rowgroup">
                        {s.group}
                      </th>
                    </tr>
                  )}
                  <Row spec={s} saved={values[s.path]} edit={edits[s.path]} editable={editable} onEdit={(t) => setEdit(s.path, t)} />
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="tun-history">
        <h2>History</h2>
        {history.length === 0 ? (
          <p className="muted small">No changes yet.</p>
        ) : (
          <ol>
            {history.map((h) => (
              <li key={h.id}>
                <div>
                  <b>{specs.get(h.path)?.label ?? h.path}</b> <span className="mono">{fmtOrDefault(h.old)} → {fmtOrDefault(h.new)}</span>
                </div>
                <div className="muted small">
                  #{h.id} {when(h.at)} by {h.account}
                  {h.token ? ` (token ${h.token})` : ''}
                  {h.revertOf !== null ? `, reverting #${h.revertOf}` : ''}
                </div>
                {editable && (
                  <button type="button" className="small" disabled={busy || (values[h.path] ?? null) === h.old} title={`Put back ${fmtOrDefault(h.old)}`} onClick={() => void revert(h)}>
                    revert
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
