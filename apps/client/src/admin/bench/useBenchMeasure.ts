import type { BenchMeasure, TunableValues } from '@rune/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BenchRow } from './benchRows.js';
import { isWorkerReply, type MeasureJob, type MeasureTask } from './protocol.js';

/** Typing a number should not start a measurement per key press. */
const DEBOUNCE_MS = 250;

export interface TuningSet {
  key: string;
  values: TunableValues;
}

export interface BenchProgress {
  done: number;
  total: number;
  /** Mean time one row took in the worker, over this page's measurements. */
  msPerRow: number | null;
}

const resultKey = (setKey: string, specKey: string): string => `${setKey}#${specKey}`;

/**
 * Measures the rows under each set in the bench worker, lazily: only what is not cached yet is
 * sent, kits first (every multiple needs that set's best kit), and a result is kept by tuning set
 * and rune text, so going back to an earlier edit costs nothing.
 */
export function useBenchMeasure(rows: readonly BenchRow[], sets: readonly TuningSet[]): { measureOf: (setKey: string, row: BenchRow) => BenchMeasure | undefined; progress: BenchProgress; failed: string | null } {
  const worker = useRef<Worker | null>(null);
  const results = useRef(new Map<string, BenchMeasure>());
  const timing = useRef({ ms: 0, n: 0 });
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    const w = new Worker(new URL('./measure.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<unknown>) => {
      const r = e.data;
      if (!isWorkerReply(r) || r.t !== 'result') return;
      results.current.set(resultKey(r.setKey, r.rowKey), r.measure);
      timing.current.ms += r.ms;
      timing.current.n++;
      // Results arrive a few ms apart; one render per frame keeps the table from redrawing for each.
      if (frame.current === 0) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          setVersion((v) => v + 1);
        });
      }
    };
    w.onerror = (e) => setFailed(e.message || 'The measuring worker stopped');
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      w.terminate();
      worker.current = null;
    };
  }, []);

  const unique = useMemo(() => {
    const seen = new Map<string, BenchRow>();
    for (const r of rows) if (!seen.has(r.specKey)) seen.set(r.specKey, r);
    const all = [...seen.values()];
    return [...all.filter((r) => r.source === 'kit'), ...all.filter((r) => r.source !== 'kit')];
  }, [rows]);

  const setsKey = sets.map((s) => s.key).join('|');
  useEffect(() => {
    const t = setTimeout(() => {
      const w = worker.current;
      if (!w) return;
      const tasks: MeasureTask[] = [];
      for (const r of unique) for (const s of sets) if (!results.current.has(resultKey(s.key, r.specKey))) tasks.push({ setKey: s.key, spec: r.spec });
      const job: MeasureJob = { t: 'job', sets: Object.fromEntries(sets.map((s) => [s.key, s.values])), tasks };
      w.postMessage(job);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // The sets are compared by key: a new object with the same numbers is the same set.
  }, [unique, setsKey]);

  const measureOf = useCallback((setKey: string, row: BenchRow) => results.current.get(resultKey(setKey, row.specKey)), []);

  const progress = useMemo((): BenchProgress => {
    let done = 0;
    for (const r of unique) for (const s of sets) if (results.current.has(resultKey(s.key, r.specKey))) done++;
    const { ms, n } = timing.current;
    return { done, total: unique.length * sets.length, msPerRow: n > 0 ? ms / n : null };
    // `version` is the signal that `results` changed.
  }, [unique, setsKey, version]);

  return { measureOf, progress, failed };
}
