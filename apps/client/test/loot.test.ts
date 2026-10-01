import { DEFAULT_DROP_TUNING, ITEM_TIERS } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { LootAccumulator, simulateLoot, type LootSetup } from '../src/dev/loot/lootStats.js';

const BASE: LootSetup = { seed: 7, source: { level: 5, rare: false, boss: false }, kills: 3000, tuning: DEFAULT_DROP_TUNING, classId: null };

describe('loot simulator', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = simulateLoot(BASE);
    expect(simulateLoot(BASE)).toEqual(a);
    expect(JSON.stringify(simulateLoot({ ...BASE, seed: 8 }).tiers)).not.toBe(JSON.stringify(a.tiers));
  });

  it('gives the same result run in chunks as in one go', () => {
    const acc = new LootAccumulator(BASE);
    while (!acc.done) acc.step(137);
    expect(acc.report()).toEqual(simulateLoot(BASE));
  });

  it('keeps its counts consistent', () => {
    const r = simulateLoot({ ...BASE, source: { level: 6, rare: true, boss: false }, classId: 'mage' });
    const tierTotal = ITEM_TIERS.reduce((s, t) => s + r.tiers[t], 0);
    expect(tierTotal).toBe(r.drops);
    expect(r.kinds.gear + r.kinds.sigil + r.kinds.vessel + r.kinds.rune).toBe(r.drops);
    expect(r.affixCounts.reduce((s, n) => s + n, 0)).toBe(r.drops);
    expect(r.bases.reduce((s, b) => s + b.count, 0)).toBe(r.kinds.gear);
    // Rares drop 1 to 2 items each.
    expect(r.drops).toBeGreaterThanOrEqual(r.kills);
    expect(r.drops).toBeLessThanOrEqual(r.kills * 2);
    for (const a of r.affixes) {
      expect(a.tiers.reduce((s, n) => s + n, 0)).toBe(a.count);
      expect(a.min).toBeLessThanOrEqual(a.avg);
      expect(a.avg).toBeLessThanOrEqual(a.max);
    }
    expect(r.classWeapons?.usable).toBeLessThanOrEqual(r.classWeapons?.total ?? 0);
    expect(r.samples.length).toBe(20);
  });

  it('respects kind share overrides', () => {
    const r = simulateLoot({ ...BASE, tuning: { normalDropChance: 1, gearShare: 1, vesselShare: 0, runeShare: 0 } });
    expect(r.drops).toBe(BASE.kills);
    expect(r.kinds.gear).toBe(r.drops);
  });

  it('never rolls affix tiers above what item level allows', () => {
    const low = simulateLoot({ ...BASE, source: { level: 1, rare: true, boss: false } });
    expect(low.affixes.every((a) => a.tiers.slice(1).every((n) => n === 0))).toBe(true);
    expect(low.firsts.find((f) => f.label === 'Any T1 affix')?.firstKill).toBeNull();
  });
});
