import { BENCH_MARKS, CLASSES } from '@rune/shared';
import { biggestChange, change, markOf, SOURCE_NAMES, type RowView, type Side, type Sort, type SortKey } from './benchRows.js';

const fmt = (n: number, digits = 2): string => n.toFixed(digits);

function Delta({ before, after }: { before: number | null | undefined; after: number | null | undefined }) {
  const c = change(before, after);
  if (c === null || Math.abs(c) < 0.0005) return null;
  // Up is neither good nor bad on a balance table, so the sign is shown in words and only the size in colour.
  return <span className={`bn-delta ${c > 0 ? 'up' : 'down'}`}>{`${c > 0 ? '+' : ''}${(c * 100).toFixed(1)}%`}</span>;
}

/** A number before and after the unsaved edits, or one number when they agree or nothing is previewed. */
function Pair({ before, after, previewing, digits = 2, suffix = '' }: { before: number | null | undefined; after: number | null | undefined; previewing: boolean; digits?: number; suffix?: string }) {
  const show = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${fmt(n, digits)}${suffix}`);
  if (!previewing) return <span>{show(after)}</span>;
  // Same tracks as a changed pair, so unchanged numbers line up with the proposed column.
  if (before === after)
    return (
      <span className="bn-pair">
        <span />
        <span />
        <span>{show(after)}</span>
      </span>
    );
  return (
    <span className="bn-pair">
      <span className="bn-before" title="Saved numbers">
        {show(before)}
      </span>
      <span aria-hidden="true">→</span>
      <span title="With the unsaved edits">{show(after)}</span>
      <Delta before={before} after={after} />
    </span>
  );
}

function Cost({ v, previewing }: { v: RowView; previewing: boolean }) {
  const b = v.before.m?.ok ? v.before.m : null;
  const a = v.after.m?.ok ? v.after.m : null;
  if (!a) return <span className="muted">-</span>;
  if (a.spirit !== null) return <Pair before={b?.spirit} after={a.spirit} previewing={previewing} digits={0} suffix=" sp" />;
  return <Pair before={b?.force} after={a.force} previewing={previewing} digits={1} />;
}

/** Damage per Force to one target or the pack, and the multiple of the best kit under the same numbers. */
function PerForce({ v, which, previewing }: { v: RowView; which: 'single' | 'pack'; previewing: boolean }) {
  const pick = (s: Side) => (which === 'single' ? s.xSingle : s.xPack);
  const a = v.after.m?.ok ? v.after.m : null;
  const b = v.before.m?.ok ? v.before.m : null;
  const x = pick(v.after);
  if (!a || a[which] === null) return <span className="muted">-</span>;
  const cls = x === null ? '' : x > BENCH_MARKS.hard ? 'bn-hard' : x > BENCH_MARKS.soft ? 'bn-soft' : '';
  return (
    <div className="bn-pf">
      <span className={`bn-x ${cls}`}>
        <Pair before={pick(v.before)} after={x} previewing={previewing} suffix="x" />
      </span>
      <span className="bn-sub">
        <Pair before={b?.[which]} after={a[which]} previewing={previewing} /> per Force
      </span>
    </div>
  );
}

function Mark({ v }: { v: RowView }) {
  const m = markOf(v.after);
  const was = markOf(v.before);
  if (m === null && was === null) return null;
  const label = (k: 'hard' | 'soft' | null) => (k === 'hard' ? `over ${BENCH_MARKS.hard}x` : k === 'soft' ? `over ${BENCH_MARKS.soft}x` : 'within');
  return (
    <span className={`badge ${m === 'hard' ? 'red' : m === 'soft' ? 'gold' : ''}`} title={m === was ? undefined : `Saved: ${label(was)}`}>
      {label(m)}
    </span>
  );
}

const COLUMNS: readonly { key: SortKey; label: string; title?: string }[] = [
  { key: 'source', label: 'Source' },
  { key: 'name', label: 'Sigil' },
  { key: 'class', label: 'Class' },
  { key: 'force', label: 'Force', title: 'Force per cast, or spirit reserved for an aura or Bond' },
  { key: 'single', label: 'One target', title: 'Damage per Force over a 10 s run at the 0.35 s cadence, as a multiple of the best kit' },
  { key: 'pack', label: 'Pack of 6', title: 'Damage per Force against a pack of six, as a multiple of the best kit' },
  { key: 'x', label: 'Mark', title: `Above ${BENCH_MARKS.soft}x the best kit is marked; above ${BENCH_MARKS.hard}x the balance test fails` },
  { key: 'change', label: 'Own change', title: "The largest change the unsaved edits make to this row's Force, spirit or damage per Force; its multiples also move when the best kit does" },
];

export interface BenchTableProps {
  views: readonly RowView[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  previewing: boolean;
  canEdit: boolean;
  onWatch: (v: RowView) => void;
  onRemove: (id: number) => void;
}

export function BenchTable({ views, sort, onSort, previewing, canEdit, onWatch, onRemove }: BenchTableProps) {
  return (
    <table className="bn-table">
      <thead>
        <tr>
          {COLUMNS.filter((c) => previewing || c.key !== 'change').map((c) => (
            <th key={c.key} scope="col" className={c.key === 'force' ? 'bn-num' : undefined} title={c.title} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
              <button type="button" className="bn-sort" onClick={() => onSort(c.key)}>
                {c.label}
                <span aria-hidden="true">{sort.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}</span>
              </button>
            </th>
          ))}
          <th scope="col">
            <span className="bn-sr">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {views.map((v) => {
          const m = v.after.m;
          const mark = markOf(v.after);
          const c = previewing ? biggestChange(v) : null;
          const big = c !== null && Math.abs(c) >= 0.0005 ? c : null;
          return (
            <tr key={v.row.id} className={mark === 'hard' ? 'bn-row-hard' : mark === 'soft' ? 'bn-row-soft' : ''}>
              <td>
                <span className={`bn-src bn-src-${v.row.source}`}>{SOURCE_NAMES[v.row.source]}</span>
              </td>
              <th scope="row">
                <span className="bn-name">
                  {v.row.name}
                  {v.row.multicast > 1 && <span className="muted"> multicast {v.row.multicast}</span>}
                  {v.row.pick && <span className="muted"> by {v.row.pick.account}</span>}
                </span>
                <span className="mono bn-text">{v.row.text}</span>
              </th>
              <td>{CLASSES[v.row.classId].name}</td>
              {m === undefined ? (
                <td colSpan={previewing ? 5 : 4} className="muted">
                  Measuring
                </td>
              ) : !m.ok ? (
                <td colSpan={previewing ? 5 : 4} className="bn-error">
                  Does not cast: {m.error}
                </td>
              ) : (
                <>
                  <td className="bn-num">
                    <Cost v={v} previewing={previewing} />
                  </td>
                  <td>
                    <PerForce v={v} which="single" previewing={previewing} />
                  </td>
                  <td>
                    <PerForce v={v} which="pack" previewing={previewing} />
                  </td>
                  <td>
                    <Mark v={v} />
                  </td>
                  {previewing && <td>{big === null ? <span className="bn-none" title="The edits leave this row's own numbers as they are">–</span> : <span className={`bn-delta ${big > 0 ? 'up' : 'down'}`}>{`${big > 0 ? '+' : ''}${(big * 100).toFixed(1)}%`}</span>}</td>}
                </>
              )}
              <td className="bn-actions">
                <button type="button" className="small" disabled={!m?.ok} onClick={() => onWatch(v)} aria-label={`Watch ${v.row.name}`}>
                  Watch
                </button>
                {canEdit && v.row.pick && (
                  <button type="button" className="small bn-remove" onClick={() => v.row.pick && onRemove(v.row.pick.id)} aria-label={`Remove ${v.row.name}`}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

