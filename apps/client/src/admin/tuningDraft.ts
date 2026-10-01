import { tunableProblem, type TunableSpec, type TunablesState, type TunableValues } from '@rune/shared';
import { create } from 'zustand';

/**
 * The Tuning tab's state, held outside the tab so unsaved edits survive switching to the balance
 * bench, which previews them (docs/features/live-tuning.md, "The balance bench").
 */
export interface TuningDraft {
  /** The schema and saved overrides, as the server last sent them. */
  server: TunablesState | null;
  /** Edit box text per path, saved or not. */
  edits: Record<string, string>;
  setServer: (s: TunablesState) => void;
  setEdits: (e: Record<string, string>) => void;
}

export const useTuningDraft = create<TuningDraft>((set) => ({
  server: null,
  edits: {},
  setServer: (server) => set({ server }),
  setEdits: (edits) => set({ edits }),
}));

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

export function pendingPatch(edits: Readonly<Record<string, string>>, specs: ReadonlyMap<string, TunableSpec>, values: Readonly<TunableValues>): Pending {
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

/** One stable string per set, whatever order its paths were written in: the bench caches by it. */
export function tuningKey(values: Readonly<TunableValues>): string {
  return Object.keys(values)
    .sort()
    .map((p) => `${p}=${values[p]}`)
    .join(';');
}
