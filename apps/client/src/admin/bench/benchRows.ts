import {
  balanceSpecs,
  benchMark,
  benchSpecKey,
  bestKit,
  formatRunes,
  STARTER_SIGILS,
  type BenchMeasure,
  type BenchPick,
  type BenchSpec,
  type BenchState,
  type ClassId,
} from '@rune/shared';

export const ROW_SOURCES = ['kit', 'balance', 'popular', 'pick'] as const;
export type RowSource = (typeof ROW_SOURCES)[number];

export const SOURCE_NAMES: Record<RowSource, string> = { kit: 'Kit', balance: 'Balance test', popular: 'Most equipped', pick: 'Admin pick' };

export interface BenchRow {
  /** Unique per row; the same spell can be listed by two sources. */
  id: string;
  source: RowSource;
  spec: BenchSpec;
  /** The measurement's cache key: the same spell measures once whatever lists it. */
  specKey: string;
  name: string;
  text: string;
  classId: ClassId;
  multicast: number;
  /** Characters with it equipped, for the most-equipped rows. */
  equipped?: number;
  pick?: BenchPick;
}

function row(source: RowSource, spec: BenchSpec, name: string, text: string, classId: ClassId, multicast: number): BenchRow {
  const specKey = benchSpecKey(spec);
  return { id: `${source}:${specKey}`, source, spec, specKey, name, text, classId, multicast };
}

/** Every kit, the balance test's spells, the most equipped sigils, then the admin picks. */
export function buildRows(state: BenchState | null): BenchRow[] {
  const rows: BenchRow[] = STARTER_SIGILS.map((def) => row('kit', { kind: 'kit', kitId: def.id }, def.name, formatRunes(def.runes), def.classId, 1));
  balanceSpecs().forEach((s, i) => rows.push(row('balance', s, `Balance #${i + 1}`, s.text, s.classId, s.multicast)));
  for (const p of state?.popular ?? []) rows.push({ ...row('popular', { kind: 'spell', text: p.text, classId: p.classId, multicast: p.multicast }, `${p.equipped} equipped`, p.text, p.classId, p.multicast), equipped: p.equipped });
  for (const p of state?.picks ?? []) rows.push({ ...row('pick', { kind: 'spell', text: p.text, classId: p.classId, multicast: p.multicast }, `Pick #${p.id}`, p.text, p.classId, p.multicast), pick: p });
  return rows;
}

/** One tuning set's view of a row: its measurement and its damage per Force against that set's best kit. */
export interface Side {
  m: BenchMeasure | undefined;
  /** Multiple of the best kit's damage per Force, to one target and to the pack. */
  xSingle: number | null;
  xPack: number | null;
}

export interface Best {
  single: number;
  pack: number;
}

export function sideOf(m: BenchMeasure | undefined, best: Best | null): Side {
  if (!m || !m.ok || !best) return { m, xSingle: null, xPack: null };
  return { m, xSingle: m.single === null ? null : m.single / best.single, xPack: m.pack === null ? null : m.pack / best.pack };
}

/** The best kit under one set, or null until every kit of it is measured. */
export function bestOf(rows: readonly BenchRow[], measureOf: (r: BenchRow) => BenchMeasure | undefined): Best | null {
  const kits = rows.filter((r) => r.source === 'kit').map(measureOf);
  if (kits.length === 0 || kits.some((m) => m === undefined)) return null;
  return bestKit(kits.flatMap((m) => (m ? [m] : [])));
}

export interface RowView {
  row: BenchRow;
  before: Side;
  /** The same as `before` when nothing is being previewed. */
  after: Side;
}

/** The higher of the two multiples, which decides the row's mark. */
export function worstX(s: Side): number | null {
  if (s.xSingle === null && s.xPack === null) return null;
  return Math.max(s.xSingle ?? 0, s.xPack ?? 0);
}

export function markOf(s: Side): 'hard' | 'soft' | null {
  return benchMark(worstX(s));
}

/** After against before as a share (0.1 is +10%); null when either side has no number or before is 0. */
export function change(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined || after === null || after === undefined || before === 0) return null;
  return after / before - 1;
}

const ok = (s: Side) => (s.m?.ok ? s.m : null);

/** The largest change of Force, spirit, single or pack damage per Force, by size, keeping its sign. */
export function biggestChange(v: RowView): number | null {
  const b = ok(v.before);
  const a = ok(v.after);
  if (!b || !a) return null;
  let best: number | null = null;
  for (const c of [change(b.force, a.force), change(b.spirit, a.spirit), change(b.single, a.single), change(b.pack, a.pack)]) {
    if (c !== null && (best === null || Math.abs(c) > Math.abs(best))) best = c;
  }
  return best;
}

export const SORT_KEYS = ['source', 'name', 'class', 'force', 'single', 'pack', 'x', 'change'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort {
  key: SortKey;
  desc: boolean;
}

function sortValue(v: RowView, key: SortKey): number | string | null {
  const a = ok(v.after);
  switch (key) {
    case 'source':
      return ROW_SOURCES.indexOf(v.row.source);
    case 'name':
      return v.row.text;
    case 'class':
      return v.row.classId;
    case 'force':
      return a ? (a.force ?? a.spirit) : null;
    case 'single':
      return v.after.xSingle;
    case 'pack':
      return v.after.xPack;
    case 'x':
      return worstX(v.after);
    case 'change': {
      const c = biggestChange(v);
      return c === null ? null : Math.abs(c);
    }
  }
}

/** Rows without a number go last whichever way the column is sorted; ties keep the listing order. */
export function sortViews(views: readonly RowView[], sort: Sort): RowView[] {
  const indexed = views.map((v, i) => ({ v, i, k: sortValue(v, sort.key) }));
  indexed.sort((x, y) => {
    if (x.k === null || y.k === null) return x.k === y.k ? x.i - y.i : x.k === null ? 1 : -1;
    const c = typeof x.k === 'number' && typeof y.k === 'number' ? x.k - y.k : String(x.k).localeCompare(String(y.k));
    return (sort.desc ? -c : c) || x.i - y.i;
  });
  return indexed.map((x) => x.v);
}

export interface Filter {
  sources: ReadonlySet<RowSource>;
  classId: ClassId | 'all';
  query: string;
  outliers: boolean;
  changed: boolean;
}

export function filterViews(views: readonly RowView[], f: Filter): RowView[] {
  const q = f.query.trim().toLowerCase();
  return views.filter((v) => {
    if (!f.sources.has(v.row.source)) return false;
    if (f.classId !== 'all' && v.row.classId !== f.classId) return false;
    if (q !== '' && !v.row.text.toLowerCase().includes(q) && !v.row.name.toLowerCase().includes(q)) return false;
    if (f.outliers && markOf(v.after) === null && markOf(v.before) === null) return false;
    if (f.changed) {
      const c = biggestChange(v);
      if (c === null || Math.abs(c) < 0.0005) return false;
    }
    return true;
  });
}
