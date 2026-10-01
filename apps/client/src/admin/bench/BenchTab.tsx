import { BENCH_MARKS, can, CLASS_IDS, CLASSES, isClassId, type BenchSpell, type BenchState, type ClassId, type Role } from '@rune/shared';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { tunablesApi } from '../TunablesTab.js';
import { droppedNotice, pendingPatch, previewSet, tuningKey, useTuningDraft } from '../tuningDraft.js';
import { benchApi } from './benchApi.js';
import { buildRows, bestOf, filterViews, ROW_SOURCES, sideOf, SOURCE_NAMES, sortViews, type BenchRow, type RowSource, type RowView, type Sort, type SortKey } from './benchRows.js';
import { BenchTable } from './BenchTable.js';
import { PickForm } from './PickForm.js';
import { useBenchMeasure, type TuningSet } from './useBenchMeasure.js';
import './bench.css';

// The studio pulls in the game's renderer; only a watch needs it.
const WatchPanel = lazy(() => import('./WatchPanel.js'));

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

/**
 * The balance bench (docs/features/live-tuning.md, "The balance bench"): every kit, the balance
 * test's spells, the most equipped sigils and admin picks, with damage per Force against the best
 * kit; while the Tuning tab holds unsaved edits, each row shows before, after and the change.
 */
export function BenchTab({ token, role, notify, openTuning }: { token: string; role: Role; notify: (t: string) => void; openTuning: () => void }) {
  const canEdit = can(role, 'tuning');
  const { server, receive, edits } = useTuningDraft();
  const [bench, setBench] = useState<BenchState | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'x', desc: true });
  const [sources, setSources] = useState<ReadonlySet<RowSource>>(new Set(ROW_SOURCES));
  const [classId, setClassId] = useState<ClassId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [outliers, setOutliers] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [watching, setWatching] = useState<BenchRow | null>(null);

  const loadBench = useCallback(async () => {
    const r = await benchApi.state(token);
    if (r.ok) {
      setBench(r.data);
      setBenchError(null);
    } else setBenchError(r.error);
  }, [token]);

  useEffect(() => {
    // Fresh saved values every time the bench opens, so the preview is against what is live now;
    // an edit another admin's save has overtaken is dropped (receive) and named.
    void tunablesApi.state(token).then((r) => {
      if (!r.ok) return notify(r.error);
      const dropped = receive(r.data);
      if (dropped.length > 0) notify(droppedNotice(dropped));
    });
    void loadBench();
  }, [token, notify, receive, loadBench]);

  const specs = useMemo(() => new Map((server?.schema ?? []).map((s) => [s.path, s])), [server]);
  const live = useMemo(() => server?.values ?? {}, [server]);
  const pending = useMemo(() => pendingPatch(edits, specs, live), [edits, specs, live]);
  const { proposed, brokenTables } = useMemo(() => previewSet(live, pending.patch), [live, pending]);
  const liveKey = tuningKey(live);
  const proposedKey = tuningKey(proposed);
  const previewing = server !== null && liveKey !== proposedKey;

  const sets = useMemo((): TuningSet[] => {
    if (!server) return [];
    const out: TuningSet[] = [{ key: liveKey, values: live }];
    if (previewing) out.push({ key: proposedKey, values: proposed });
    return out;
  }, [server, liveKey, proposedKey, previewing, live, proposed]);

  const rows = useMemo(() => buildRows(bench), [bench]);
  const { measureOf, progress, failed } = useBenchMeasure(rows, sets);

  const views = useMemo((): RowView[] => {
    if (sets.length === 0) return [];
    const bestLive = bestOf(rows, (r) => measureOf(liveKey, r));
    const bestProposed = previewing ? bestOf(rows, (r) => measureOf(proposedKey, r)) : bestLive;
    return rows.map((row) => {
      const before = sideOf(measureOf(liveKey, row), bestLive);
      return { row, before, after: previewing ? sideOf(measureOf(proposedKey, row), bestProposed) : before };
    });
    // `progress` changes whenever a measurement arrives.
  }, [rows, sets, liveKey, proposedKey, previewing, measureOf, progress]);

  const shown = useMemo(() => sortViews(filterViews(views, { sources, classId, query, outliers, changed: previewing && changedOnly }), sort), [views, sources, classId, query, outliers, changedOnly, previewing, sort]);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' && key !== 'source' && key !== 'class' }));
  const toggleSource = (s: RowSource) =>
    setSources((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const add = async (spell: BenchSpell): Promise<boolean> => {
    setBusy(true);
    const r = await benchApi.add(token, spell);
    setBusy(false);
    if (!r.ok) {
      notify(r.error);
      return false;
    }
    notify(`Added ${r.data.text}`);
    await loadBench();
    return true;
  };

  const remove = async (id: number) => {
    const pick = bench?.picks.find((p) => p.id === id);
    if (!window.confirm(`Remove pick #${id}${pick ? ` (${pick.text}, added by ${pick.account})` : ''} for every admin?`)) return;
    setBusy(true);
    const r = await benchApi.remove(token, id);
    setBusy(false);
    notify(r.ok ? `Removed pick #${id}` : r.error);
    if (r.ok) await loadBench();
  };

  const closeWatch = useCallback(() => setWatching(null), []);

  if (!server) return <p className="muted">Loading the tuning numbers</p>;

  const counts = new Map<RowSource, number>(ROW_SOURCES.map((s) => [s, rows.filter((r) => r.source === s).length]));
  const outlierCount = views.filter((v) => (v.after.xSingle ?? 0) > BENCH_MARKS.soft || (v.after.xPack ?? 0) > BENCH_MARKS.soft).length;

  return (
    <div className="bn">
      <header className="bn-head">
        <h2>Balance bench</h2>
        <p className="bn-status" aria-live="polite">
          <span>{progress.done < progress.total ? `Measuring ${progress.done} of ${progress.total}` : `${rows.length} sigils measured`}</span>
          {progress.msPerRow !== null && <span className="muted">{progress.msPerRow.toFixed(1)} ms a row</span>}
          {outlierCount > 0 && <span className="badge gold">{outlierCount} past {BENCH_MARKS.soft}x</span>}
        </p>
        {previewing ? (
          <p className="bn-preview">
            Previewing {pending.count} unsaved edit{pending.count === 1 ? '' : 's'} from the Tuning tab: each number reads saved → with the edits.{' '}
            <button type="button" className="small" onClick={openTuning}>
              Edit in Tuning
            </button>
          </p>
        ) : (
          <p className="muted small bn-note">
            Damage per Force over a 10 s run at the 0.35 s cadence, as a multiple of the best kit under the same numbers. Edit numbers in the Tuning tab without saving to preview them here.
            {pending.bad > 0 && ` ${pending.bad} edit${pending.bad === 1 ? ' is' : 's are'} out of range and left out.`}
          </p>
        )}
        {brokenTables.length > 0 && (
          <p className="bn-error bn-note" role="status">
            Not previewed, as a Save would refuse it: {brokenTables.join('; ')}. Those affix tables are shown at their saved numbers.
          </p>
        )}
        {failed && <p className="bn-error">The measuring worker failed: {failed}. Reload the page.</p>}
      </header>

      <div className="bn-filters" role="group" aria-label="Filter rows">
        {ROW_SOURCES.map((s) => (
          <button key={s} type="button" className={sources.has(s) ? 'on' : ''} aria-pressed={sources.has(s)} onClick={() => toggleSource(s)}>
            {SOURCE_NAMES[s]} <span className="muted">{counts.get(s) ?? 0}</span>
          </button>
        ))}
        <select value={classId} aria-label="Class" onChange={(e) => setClassId(isClassId(e.target.value) ? e.target.value : 'all')}>
          <option value="all">Every class</option>
          {CLASS_IDS.map((c) => (
            <option key={c} value={c}>
              {CLASSES[c].name}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Filter by rune text" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter by rune text" />
        <label className="bn-check">
          <input type="checkbox" checked={outliers} onChange={(e) => setOutliers(e.target.checked)} /> Past {BENCH_MARKS.soft}x only
        </label>
        {previewing && (
          <label className="bn-check">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} /> Changed only
          </label>
        )}
      </div>

      {canEdit && <PickForm busy={busy} onAdd={add} />}
      {benchError && (
        <p className="bn-error">
          Most equipped and picks could not load: {benchError}{' '}
          <button type="button" className="small" onClick={() => void loadBench()}>
            Retry
          </button>
        </p>
      )}
      {bench && bench.popular.length === 0 && <p className="muted small">No saves hold an equipped sigil yet, so the most equipped list is empty.</p>}
      {bench && !bench.popularReady && <p className="muted small">The server is still counting the saves it had at start; the most equipped list fills in as it goes.</p>}
      {bench && bench.popular.length > 0 && <p className="muted small">Most equipped from every character's last save; it last changed {ago(bench.popularAt)}.</p>}

      <div className="bn-scroll">
        {shown.length === 0 ? <p className="muted">No row matches these filters.</p> : <BenchTable views={shown} sort={sort} onSort={onSort} previewing={previewing} canEdit={canEdit} onWatch={(v) => setWatching(v.row)} onRemove={(id) => void remove(id)} />}
      </div>

      {watching && (
        <Suspense fallback={null}>
          <WatchPanel row={watching} live={live} proposed={proposed} previewing={previewing} onClose={closeWatch} />
        </Suspense>
      )}
    </div>
  );
}
