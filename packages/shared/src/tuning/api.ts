import { TUNING_CATEGORIES, type TunableSpec } from './registry.js';
import { isTunableValues, type TunableValues } from './values.js';

/** `GET /api/admin/tuning`: the schema and the overrides in force. */
export interface TunablesState {
  schema: TunableSpec[];
  values: TunableValues;
  /** Set when a change was saved and applied but a later step (reaching rooms or clients) failed. */
  warning?: string;
}

/** One change of one number. `old` and `new` are null when that side was the code default. */
export interface TunableHistoryEntry {
  id: number;
  path: string;
  old: number | null;
  new: number | null;
  account: string;
  /** The admin API token's name when a script made the change. */
  token: string | null;
  at: number;
  /** The history id this change reverted. */
  revertOf: number | null;
}

/** History rows are listed newest first, at most this many per call. */
export const TUNING_HISTORY_LIMIT = { default: 100, max: 500 } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNumberOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

function isTunableSpec(v: unknown): v is TunableSpec {
  return (
    isRecord(v) &&
    typeof v.path === 'string' &&
    TUNING_CATEGORIES.some((c) => c === v.category) &&
    typeof v.label === 'string' &&
    typeof v.default === 'number' &&
    typeof v.min === 'number' &&
    typeof v.max === 'number' &&
    typeof v.int === 'boolean' &&
    (v.note === undefined || typeof v.note === 'string')
  );
}

export function isTunablesState(v: unknown): v is TunablesState {
  return isRecord(v) && Array.isArray(v.schema) && v.schema.every(isTunableSpec) && isTunableValues(v.values) && (v.warning === undefined || typeof v.warning === 'string');
}

export function isTunableHistoryEntry(v: unknown): v is TunableHistoryEntry {
  return (
    isRecord(v) &&
    typeof v.id === 'number' &&
    typeof v.path === 'string' &&
    isNumberOrNull(v.old) &&
    isNumberOrNull(v.new) &&
    typeof v.account === 'string' &&
    (v.token === null || typeof v.token === 'string') &&
    typeof v.at === 'number' &&
    (v.revertOf === null || typeof v.revertOf === 'number')
  );
}
