import { compileSigilItem, createStarterSigil, sigilCastDelay, sigilMisfireMultiplier, STARTER_SIGILS, type StarterSigilDef } from '../../src/index.js';
import v1 from '../fixtures/skill-baseline-v1.json' with { type: 'json' };
import { measureSkill, type EquipSkill, type SkillDpsResult } from './skillDps.js';

/** The same path the game takes for a starter kit sigil. */
export function equipStarter(def: StarterSigilDef): EquipSkill {
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const item = createStarterSigil(() => sim.newItemUid(), def, { bound: true });
    p.items.set(item.uid, item);
    return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMisfireMultiplier(item), castDelay: sigilCastDelay(item) };
  };
}

/** Novas and zones go off on the caster, so they are measured with the target just outside the player's body. */
const SELF_CENTRED_DISTANCE = 40;

export function distanceFor(def: StarterSigilDef): number | undefined {
  const shape = def.runes[0]?.id;
  return shape === 'nova' || shape === 'zone' ? SELF_CENTRED_DISTANCE : undefined;
}

export function measureStarter(def: StarterSigilDef): SkillDpsResult {
  const distance = distanceFor(def);
  return measureSkill({ classId: def.classId, equip: equipStarter(def), ...(distance !== undefined ? { distance } : {}) });
}

export interface ParityRow {
  id: string;
  v1: SkillDpsResult;
  v2: SkillDpsResult;
}

export function v1Result(id: string): SkillDpsResult {
  const old: unknown = Reflect.get(v1, id);
  if (typeof old !== 'object' || old === null) throw new Error(`no v1 baseline for ${id}`);
  const num = (k: string): number | null => {
    const v: unknown = Reflect.get(old, k);
    return typeof v === 'number' ? v : null;
  };
  const kind: unknown = Reflect.get(old, 'kind');
  if (kind !== 'damage' && kind !== 'movement' && kind !== 'persistent' && kind !== 'support') throw new Error(`bad kind for ${id}`);
  return {
    kind,
    distance: num('distance') ?? 0,
    forcePerCast: num('forcePerCast'),
    spiritReserved: num('spiritReserved'),
    dashDistance: num('dashDistance'),
    casts: num('casts'),
    single: num('single'),
    pack: num('pack'),
    perCast: num('perCast'),
    peakEntities: num('peakEntities'),
  };
}

export function parityRows(): ParityRow[] {
  return STARTER_SIGILS.map((def) => ({ id: def.id, v1: v1Result(def.id), v2: measureStarter(def) }));
}

/** Signed deviation of v2 from v1 as a fraction; null when either side has no number. */
export function deviation(v1n: number | null, v2n: number | null): number | null {
  if (v1n === null || v2n === null || v1n === 0) return null;
  return v2n / v1n - 1;
}

const pct = (d: number | null): string => (d === null ? '-' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`);
const n = (v: number | null): string => (v === null ? '-' : String(v));

export function parityTable(rows: readonly ParityRow[]): string {
  const head = ['skill', 'v1 Force', 'v2 Force', 'v1 single / pack', 'v2 single / pack', 'dev Force', 'dev single', 'dev pack'];
  const lines = rows.map((r) => {
    const f1 = r.v1.forcePerCast ?? r.v1.spiritReserved;
    const f2 = r.v2.forcePerCast ?? r.v2.spiritReserved;
    return [
      r.id,
      n(f1) + (r.v1.spiritReserved !== null ? ' sp' : ''),
      n(f2) + (r.v2.spiritReserved !== null ? ' sp' : ''),
      `${n(r.v1.single)} / ${n(r.v1.pack)}`,
      `${n(r.v2.single)} / ${n(r.v2.pack)}`,
      pct(deviation(f1, f2)),
      pct(deviation(r.v1.single, r.v2.single)),
      pct(deviation(r.v1.pack, r.v2.pack)),
    ];
  });
  const all = [head, ...lines];
  const widths = head.map((_, i) => Math.max(...all.map((l) => (l[i] ?? '').length)));
  return all.map((l) => l.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')).join('\n');
}
