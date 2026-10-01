import { isClassId, isTunableValues, type BenchMeasure, type BenchSpec, type TunableValues } from '@rune/shared';

/** Messages between the bench tab and its worker; both sides check what they receive. */
export interface MeasureTask {
  setKey: string;
  spec: BenchSpec;
}

/** A new job replaces whatever the worker had queued, so it always works on what is on screen. */
export interface MeasureJob {
  t: 'job';
  sets: Record<string, TunableValues>;
  tasks: MeasureTask[];
}

export type WorkerReply = { t: 'result'; setKey: string; rowKey: string; measure: BenchMeasure; ms: number } | { t: 'idle' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

export function isBenchSpec(v: unknown): v is BenchSpec {
  if (!isRecord(v)) return false;
  if (v.kind === 'kit') return typeof v.kitId === 'string';
  return v.kind === 'spell' && typeof v.text === 'string' && isClassId(v.classId) && typeof v.multicast === 'number';
}

export function isMeasureJob(v: unknown): v is MeasureJob {
  if (!isRecord(v) || v.t !== 'job' || !isRecord(v.sets) || !Array.isArray(v.tasks)) return false;
  if (!Object.values(v.sets).every(isTunableValues)) return false;
  return v.tasks.every((t) => isRecord(t) && typeof t.setKey === 'string' && isBenchSpec(t.spec));
}

function isBenchMeasure(v: unknown): v is BenchMeasure {
  if (!isRecord(v)) return false;
  if (v.ok === false) return typeof v.error === 'string';
  const kinds: unknown[] = ['damage', 'movement', 'persistent', 'support'];
  return v.ok === true && kinds.includes(v.kind) && isNum(v.force) && isNum(v.spirit) && isNum(v.casts) && isNum(v.single) && isNum(v.pack);
}

export function isWorkerReply(v: unknown): v is WorkerReply {
  if (!isRecord(v)) return false;
  if (v.t === 'idle') return true;
  return v.t === 'result' && typeof v.setKey === 'string' && typeof v.rowKey === 'string' && typeof v.ms === 'number' && isBenchMeasure(v.measure);
}
