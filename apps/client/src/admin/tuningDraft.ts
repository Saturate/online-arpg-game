import { tunableProblem, withoutBrokenAffixTables, type TunableSpec, type TunablesState, type TunableValues } from '@rune/shared';
import { create } from 'zustand';

/**
 * The Tuning tab's state, held outside the tab so unsaved edits survive switching to the balance
 * bench, which previews them (docs/features/live-tuning.md, "The balance bench").
 */
/** An unsaved edit: the box's text, and the saved override it was made against (null: the code default). */
export interface DraftEdit {
  text: string;
  base: number | null;
}

export interface TuningDraft {
  /** The schema and saved overrides, as the server last sent them. */
  server: TunablesState | null;
  edits: Record<string, DraftEdit>;
  /**
   * Takes a fresh copy of the saved values. An edit whose saved value changed since it began is
   * dropped, so a stale draft cannot put back a number another admin has saved since; the dropped
   * paths are returned for a notice.
   */
  receive: (s: TunablesState) => string[];
  /** Sets or clears one edit; an edit equal to the saved value is no edit and is dropped. */
  edit: (spec: TunableSpec, text: string | undefined) => void;
  clearEdits: () => void;
}

const savedOf = (s: TunablesState | null, path: string): number | null => s?.values[path] ?? null;

export const useTuningDraft = create<TuningDraft>((set, get) => ({
  server: null,
  edits: {},
  receive: (server) => {
    const dropped: string[] = [];
    const edits: Record<string, DraftEdit> = {};
    for (const [path, e] of Object.entries(get().edits)) {
      if (savedOf(server, path) === e.base) edits[path] = e;
      else dropped.push(path);
    }
    set({ server, edits });
    return dropped;
  },
  edit: (spec, text) => {
    const { server, edits } = get();
    const next = { ...edits };
    const saved = savedOf(server, spec.path);
    if (text === undefined || parsed(spec, text) === (saved ?? spec.default)) delete next[spec.path];
    else next[spec.path] = { text, base: edits[spec.path]?.base ?? saved };
    set({ edits: next });
  },
  clearEdits: () => set({ edits: {} }),
}));

/** The notice for edits `receive` dropped. */
export function droppedNotice(paths: readonly string[]): string {
  return `${paths.length} unsaved edit${paths.length === 1 ? ' was' : 's were'} dropped because another change saved ${paths.length === 1 ? 'that number' : 'those numbers'} since: ${paths.join(', ')}`;
}

/** What an edit box holds as a number to save, or a reason it cannot be saved. */
export function parsed(spec: TunableSpec, text: string): number | string {
  if (text.trim() === '') return 'empty';
  const n = Number(text);
  return tunableProblem(spec, n) ?? n;
}

export interface Pending {
  /** Only edits that differ from what is live; the code default is sent as null. */
  patch: Record<string, number | null>;
  count: number;
  /** Edits that cannot be saved (out of range or empty); they are left out of the patch. */
  bad: number;
}

export function pendingPatch(edits: Readonly<Record<string, DraftEdit>>, specs: ReadonlyMap<string, TunableSpec>, values: Readonly<TunableValues>): Pending {
  const patch: Record<string, number | null> = {};
  let bad = 0;
  for (const [path, { text }] of Object.entries(edits)) {
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
}

/** The set the saved overrides and the unsaved patch make together: what a Save would put in force. */
export function proposedValues(values: Readonly<TunableValues>, patch: Readonly<Record<string, number | null>>): TunableValues {
  const next: TunableValues = { ...values };
  for (const [path, v] of Object.entries(patch)) {
    if (v === null) delete next[path];
    else next[path] = v;
  }
  return next;
}

/**
 * What the bench previews: the saved set with the edits, except an affix table the edits leave
 * out of order or overlapping, which a Save would refuse; that table keeps its saved numbers, and
 * `brokenTables` says why for a notice.
 */
export function previewSet(live: Readonly<TunableValues>, patch: Readonly<Record<string, number | null>>): { proposed: TunableValues; brokenTables: string[] } {
  const { kept, dropped } = withoutBrokenAffixTables(proposedValues(live, patch));
  for (const d of dropped) {
    // Paths are `affix.<id>.t<n>.<key>`, so the first two parts name the table.
    const table = d.paths[0]?.split('.').slice(0, 2).join('.');
    if (table === undefined) continue;
    for (const [path, v] of Object.entries(live)) if (path.startsWith(`${table}.`)) kept[path] = v;
  }
  return { proposed: kept, brokenTables: dropped.map((d) => d.why) };
}

/** One stable string per set, whatever order its paths were written in: the bench caches by it. */
export function tuningKey(values: Readonly<TunableValues>): string {
  return Object.keys(values)
    .sort()
    .map((p) => `${p}=${values[p]}`)
    .join(';');
}
