import { describe, expect, it } from 'vitest';
import { deviation, parityRows, parityTable } from './harness/parity.js';

// Vitest runs in Node; the shared package builds without Node's types.
declare const console: { log(message: string): void };

/**
 * The balance pass: every starter sigil against the v1 skill it replaced
 * (fixtures/skill-baseline-v1.json, recorded before the rework and never rewritten).
 */
const FORCE_TOLERANCE = 0.15;
const DAMAGE_TOLERANCE = 0.1;
const DASH_TOLERANCE = 0.05;

/**
 * Starters the owner buffed on purpose (2026-10-01, docs/features/runes.md): their damage is held to
 * the numbers measured when the buff went in instead of v1's, which was far below every other
 * starter. Their Force, cast rate and kind still answer to v1.
 */
const RETUNED: Readonly<Record<string, { single: number; pack: number }>> = {
  flame_cleave: { single: 650.4, pack: 3230.6 },
  multishot: { single: 430.1, pack: 1290.2 },
};

describe('v2 starter sigils against the v1 baseline', () => {
  const rows = parityRows();

  it('prints the table', () => {
    console.log(`\n${parityTable(rows)}\n`);
    expect(rows.length).toBe(20);
  });

  it('keep the kind of skill each one was', () => {
    for (const r of rows) expect(r.v2.kind, r.id).toBe(r.v1.kind);
  });

  it('cost what they cost in v1, within 15%', () => {
    for (const r of rows) {
      const d = deviation(r.v1.forcePerCast, r.v2.forcePerCast);
      if (r.v1.forcePerCast !== null) expect(Math.abs(d ?? Infinity), `${r.id} Force ${r.v1.forcePerCast} -> ${r.v2.forcePerCast}`).toBeLessThanOrEqual(FORCE_TOLERANCE);
    }
  });

  it('reserve the spirit they reserved in v1', () => {
    for (const r of rows) if (r.v1.spiritReserved !== null) expect(r.v2.spiritReserved, r.id).toBe(r.v1.spiritReserved);
  });

  it('deal their v1 damage (or their retuned damage) to one target and to a pack, within 10%', () => {
    for (const r of rows) {
      for (const key of ['single', 'pack'] as const) {
        const before = RETUNED[r.id]?.[key] ?? r.v1[key];
        if (before === null) continue;
        const d = deviation(before, r.v2[key]);
        expect(Math.abs(d ?? Infinity), `${r.id} ${key} ${before} -> ${r.v2[key]}`).toBeLessThanOrEqual(DAMAGE_TOLERANCE);
      }
    }
  });

  it('cast at the v1 rate and move as far', () => {
    for (const r of rows) {
      expect(r.v2.casts, r.id).toBe(r.v1.casts);
      if (r.v1.dashDistance === null) continue;
      const d = deviation(r.v1.dashDistance, r.v2.dashDistance);
      expect(Math.abs(d ?? Infinity), `${r.id} dash`).toBeLessThanOrEqual(DASH_TOLERANCE);
    }
  });
});
