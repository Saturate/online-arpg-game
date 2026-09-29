import {
  gearBase,
  rollDrops,
  Rng,
  type AffixId,
  type ClassId,
  type DropSource,
  type DropTuning,
  type GearCategory,
  type Item,
  type ItemTier,
} from '@rune/shared';

export interface LootSetup {
  seed: number;
  source: DropSource;
  kills: number;
  tuning: DropTuning;
  /** Counts how many weapon drops this class could actually wield. Drops themselves ignore class. */
  classId: ClassId | null;
}

export interface AffixRow {
  id: AffixId;
  count: number;
  /** Rolls per affix tier, index 0 is T1. */
  tiers: number[];
  min: number;
  max: number;
  avg: number;
}

export interface FirstSeen {
  label: string;
  /** Kill number (1-based) of the first drop, or null if it never dropped. */
  firstKill: number | null;
  count: number;
  /** Average kills per occurrence over the whole run; the expected wait for the next one. */
  killsPerDrop: number | null;
}

export interface LootReport {
  kills: number;
  drops: number;
  tiers: Record<ItemTier, number>;
  kinds: Record<Item['kind'], number>;
  slots: Partial<Record<GearCategory, number>>;
  bases: { id: string; name: string; count: number }[];
  affixes: AffixRow[];
  /** Index is the number of affixes on an item. */
  affixCounts: number[];
  firsts: FirstSeen[];
  corrupted: number;
  /** Weapon drops usable by the chosen class, out of all weapon drops. */
  classWeapons: { usable: number; total: number } | null;
  samples: Item[];
}

const SAMPLE_COUNT = 20;

interface Milestone {
  label: string;
  test: (item: Item) => boolean;
}

const MILESTONES: readonly Milestone[] = [
  { label: 'Rare or better', test: (i) => i.tier === 'rare' || i.tier === 'relic' },
  { label: 'Relic', test: (i) => i.tier === 'relic' },
  { label: 'Any T3 affix', test: (i) => i.affixes.some((a) => a.tier >= 2) },
  { label: 'Relic with a T3 affix', test: (i) => i.tier === 'relic' && i.affixes.some((a) => a.tier >= 2) },
  { label: '5-affix item', test: (i) => i.affixes.length >= 5 },
];

/**
 * Accumulates drop statistics kill by kill, so the tab can run a large simulation in chunks and
 * show progress without holding every item in memory.
 */
export class LootAccumulator {
  private readonly rng: Rng;
  private uid = 1;
  private killsDone = 0;
  private drops = 0;
  private corrupted = 0;
  private readonly tiers: Record<ItemTier, number> = { common: 0, magic: 0, rare: 0, relic: 0 };
  private readonly kinds: Record<Item['kind'], number> = { gear: 0, sigil: 0, vessel: 0, rune: 0 };
  private readonly slots: Partial<Record<GearCategory, number>> = {};
  private readonly bases = new Map<string, number>();
  private readonly affixes = new Map<AffixId, { count: number; tiers: number[]; min: number; max: number; sum: number }>();
  private readonly affixCounts: number[] = [];
  private readonly firsts: (Milestone & { firstKill: number | null; count: number })[] = MILESTONES.map((m) => ({ ...m, firstKill: null, count: 0 }));
  private readonly weapons = { usable: 0, total: 0 };
  private readonly samples: Item[] = [];

  constructor(readonly setup: LootSetup) {
    this.rng = Rng.stream(setup.seed, 'loot-sim');
  }

  get done(): boolean {
    return this.killsDone >= this.setup.kills;
  }

  get progress(): number {
    return this.setup.kills === 0 ? 1 : this.killsDone / this.setup.kills;
  }

  /** Runs up to `n` more kills. */
  step(n: number): void {
    const end = Math.min(this.setup.kills, this.killsDone + n);
    while (this.killsDone < end) {
      this.killsDone++;
      for (const item of rollDrops(this.rng, () => this.uid++, this.setup.source, this.setup.tuning)) this.add(item);
    }
  }

  private add(item: Item): void {
    this.drops++;
    this.tiers[item.tier]++;
    this.kinds[item.kind]++;
    this.affixCounts[item.affixes.length] = (this.affixCounts[item.affixes.length] ?? 0) + 1;
    if (item.kind === 'sigil' && item.corrupted) this.corrupted++;
    if (item.kind === 'gear') {
      this.slots[item.category] = (this.slots[item.category] ?? 0) + 1;
      this.bases.set(item.base, (this.bases.get(item.base) ?? 0) + 1);
      if (item.category === 'weapon' && this.setup.classId) {
        this.weapons.total++;
        const classes = gearBase(item.base)?.classes;
        if (!classes || classes.includes(this.setup.classId)) this.weapons.usable++;
      }
    }
    for (const a of item.affixes) {
      const row = this.affixes.get(a.id) ?? { count: 0, tiers: [], min: Infinity, max: -Infinity, sum: 0 };
      row.count++;
      row.tiers[a.tier] = (row.tiers[a.tier] ?? 0) + 1;
      row.min = Math.min(row.min, a.value);
      row.max = Math.max(row.max, a.value);
      row.sum += a.value;
      this.affixes.set(a.id, row);
    }
    for (const f of this.firsts) {
      if (!f.test(item)) continue;
      f.count++;
      f.firstKill ??= this.killsDone;
    }
    if (this.samples.length < SAMPLE_COUNT) this.samples.push(item);
  }

  report(): LootReport {
    const maxTier = Math.max(0, ...[...this.affixes.values()].map((r) => r.tiers.length));
    return {
      kills: this.killsDone,
      drops: this.drops,
      tiers: { ...this.tiers },
      kinds: { ...this.kinds },
      slots: { ...this.slots },
      bases: [...this.bases.entries()]
        .map(([id, count]) => ({ id, name: gearBase(id)?.name ?? id, count }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      affixes: [...this.affixes.entries()]
        .map(([id, r]) => ({ id, count: r.count, tiers: Array.from({ length: maxTier }, (_, i) => r.tiers[i] ?? 0), min: r.min, max: r.max, avg: r.sum / r.count }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      affixCounts: Array.from({ length: this.affixCounts.length }, (_, i) => this.affixCounts[i] ?? 0),
      firsts: this.firsts.map((f) => ({ label: f.label, firstKill: f.firstKill, count: f.count, killsPerDrop: f.count > 0 ? this.killsDone / f.count : null })),
      corrupted: this.corrupted,
      classWeapons: this.setup.classId ? { ...this.weapons } : null,
      samples: [...this.samples],
    };
  }
}

/** Whole run in one go; the tab uses the accumulator directly to stay responsive. */
export function simulateLoot(setup: LootSetup): LootReport {
  const acc = new LootAccumulator(setup);
  acc.step(setup.kills);
  return acc.report();
}
