import { describe, expect, it } from 'vitest';
import { deviation, parityRows, parityTable } from './harness/parity.js';

// Vitest runs in Node; the shared package builds without Node's types.
declare const console: { log(message: string): void };

/**
 * The balance pass: every class's kit sigil against the v1 skill it replaced
 * (fixtures/skill-baseline-v1.json, recorded before the rework and never rewritten).
 */
const FORCE_TOLERANCE = 0.15;
const DAMAGE_TOLERANCE = 0.1;
const DASH_TOLERANCE = 0.05;

/**
 * Kits whose hand-set rolls were clamped into the drop tables (2026-10-01, docs/features/runes.md,
 * "Kit sigils at table rolls") or that the owner buffed before that: each is held to the numbers
 * measured at its table rolls instead of v1's, within the same bands. Their kind and cast rate
 * still answer to v1.
 */
const TABLE_ROLLS: Readonly<Record<string, { force: number; single: number; pack: number; dash?: number }>> = {
  fireball: { force: 19.9, single: 967.2, pack: 3996.1 },
  frozen_orb: { force: 23.6, single: 950.4, pack: 3235.2 },
  blink: { force: 15, single: 348, pack: 1044, dash: 285 },
  flame_cleave: { force: 17.8, single: 650.8, pack: 3881.9 },
  multishot: { force: 16.7, single: 166.7, pack: 500 },
};

describe('kit sigils against the v1 baseline', () => {
  const rows = parityRows();

  it('prints the table', () => {
    console.log(`\n${parityTable(rows)}\n`);
    expect(rows.length).toBe(20);
  });

  it('keep the kind of skill each one was', () => {
    for (const r of rows) expect(r.v2.kind, r.id).toBe(r.v1.kind);
  });

  it('cost what they cost in v1 (or at their table rolls), within 15%', () => {
    for (const r of rows) {
      const before = TABLE_ROLLS[r.id]?.force ?? r.v1.forcePerCast;
      const d = deviation(before, r.v2.forcePerCast);
      if (before !== null) expect(Math.abs(d ?? Infinity), `${r.id} Force ${before} -> ${r.v2.forcePerCast}`).toBeLessThanOrEqual(FORCE_TOLERANCE);
    }
  });

  it('reserve the spirit they reserved in v1', () => {
    for (const r of rows) if (r.v1.spiritReserved !== null) expect(r.v2.spiritReserved, r.id).toBe(r.v1.spiritReserved);
  });

  it('deal their v1 damage (or their damage at table rolls) to one target and to a pack, within 10%', () => {
    for (const r of rows) {
      for (const key of ['single', 'pack'] as const) {
        const before = TABLE_ROLLS[r.id]?.[key] ?? r.v1[key];
        if (before === null) continue;
        const d = deviation(before, r.v2[key]);
        expect(Math.abs(d ?? Infinity), `${r.id} ${key} ${before} -> ${r.v2[key]}`).toBeLessThanOrEqual(DAMAGE_TOLERANCE);
      }
    }
  });

  it('cast at the v1 rate and move as far', () => {
    for (const r of rows) {
      expect(r.v2.casts, r.id).toBe(r.v1.casts);
      const dash = TABLE_ROLLS[r.id]?.dash ?? r.v1.dashDistance;
      if (dash === null) continue;
      const d = deviation(dash, r.v2.dashDistance);
      expect(Math.abs(d ?? Infinity), `${r.id} dash`).toBeLessThanOrEqual(DASH_TOLERANCE);
    }
  });
});
