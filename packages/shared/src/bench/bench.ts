import { isAffixId } from '../data/affixes.js';
import { CLASS_IDS, isClassId, type ClassId } from '../data/classes.js';
import { createStarterSigil, STARTER_SIGILS, type StarterSigilDef } from '../data/starterSigils.js';
import { affixValue, SIGIL_MAX_SLOTS, sigilCastDelayShare, sigilMisfireMultiplier, toRuneInstance, type AffixRoll, type RuneItem } from '../items/items.js';
import { compileRunes, compileSigilItem, DEFAULT_SIGIL_CONTEXT, type SigilCompile } from '../runes/v2/compile.js';
import { isRuneId } from '../runes/v2/runes.js';
import { formatRunes, tokenizeSpell } from '../runes/v2/tokenize.js';
import type { EquippedSigil } from '../sim/ecs.js';
import { BALANCE_SPELLS } from './spells.js';
import { measureRate, measureSkill, perForce, type EquipSkill, type SkillDpsResult, type SkillKind, type SkillRateResult } from './skillDps.js';

/**
 * The admin balance bench (docs/features/live-tuning.md, "The balance bench"): every kit, the
 * balance test's hand-picked spells, the sigils most equipped on the server and admin picks,
 * measured with the balance harness so the bench and the tests read the same numbers.
 */

/** Damage per Force as a multiple of the best kit's: past `soft` is marked, past `hard` the balance test fails. */
export const BENCH_MARKS = { soft: 2, hard: 5 } as const;

export const BENCH_LIMITS = { textMax: 400, picks: 200, popular: 20, multicastMax: 4 } as const;

/** A spell the bench measures from its rune text, compiled on a plain sigil of its class. */
export interface BenchSpell {
  text: string;
  classId: ClassId;
  multicast: number;
}

export type BenchSpec = { kind: 'kit'; kitId: string } | ({ kind: 'spell' } & BenchSpell);

export function benchSpecKey(spec: BenchSpec): string {
  return spec.kind === 'kit' ? `kit:${spec.kitId}` : `${spec.classId}|${spec.multicast}|${spec.text}`;
}

/** Novas, zones and dashes go off on the caster, so the target stands just outside the player's body. */
export const SELF_CENTRED_DISTANCE = 40;
const SELF_CENTRED_SPELL = new Set(['nova', 'zone', 'dash']);

/** Kits are measured as the parity test measures them: only nova and zone kits stand close. */
export function kitDistance(def: StarterSigilDef): number | undefined {
  const shape = def.runes[0]?.id;
  return shape === 'nova' || shape === 'zone' ? SELF_CENTRED_DISTANCE : undefined;
}

export function spellDistance(text: string): number | undefined {
  const shape = tokenizeSpell(text).runes[0]?.id;
  return SELF_CENTRED_SPELL.has(shape ?? 'bolt') ? SELF_CENTRED_DISTANCE : undefined;
}

/** The same path the game takes for a kit sigil: a new character's bound kit, clamped into the live tables. */
export function equipStarter(def: StarterSigilDef): EquipSkill {
  return (sim, pid) => {
    const p = sim.world.player.get(pid);
    if (!p) throw new Error('no player');
    const item = createStarterSigil(() => sim.newItemUid(), def, { bound: true });
    p.items.set(item.uid, item);
    return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMisfireMultiplier(item), castDelayShare: sigilCastDelayShare(item) };
  };
}

export function measureStarter(def: StarterSigilDef): SkillDpsResult {
  const distance = kitDistance(def);
  return measureSkill({ classId: def.classId, equip: equipStarter(def), ...(distance !== undefined ? { distance } : {}) });
}

export function compileBenchSpell(spell: BenchSpell): SigilCompile {
  return compileRunes(tokenizeSpell(spell.text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId: spell.classId, multicast: spell.multicast });
}

/** What a bench row casts: the compiled sigil as the harness equips it, its class and the target distance. */
export interface BenchCast {
  classId: ClassId;
  sigil: EquippedSigil;
  distance: number | undefined;
}

export function benchCast(spec: BenchSpec): BenchCast | string {
  if (spec.kind === 'kit') {
    const def = STARTER_SIGILS.find((s) => s.id === spec.kitId);
    if (!def) return `No kit ${spec.kitId}`;
    let uid = 1;
    const item = createStarterSigil(() => uid++, def, { bound: true });
    const compiled = compileSigilItem(item, def.classId);
    if (!compiled.ok) return compiled.errors.map((e) => e.message).join('; ');
    return { classId: def.classId, sigil: { uid: item.uid, compiled, misfireMultiplier: sigilMisfireMultiplier(item), castDelayShare: sigilCastDelayShare(item) }, distance: kitDistance(def) };
  }
  const compiled = compileBenchSpell(spec);
  if (!compiled.ok) return compiled.errors.map((e) => e.message).join('; ');
  return { classId: spec.classId, sigil: { uid: -1, compiled, misfireMultiplier: 1, castDelayShare: 1 }, distance: spellDistance(spec.text) };
}

export type BenchMeasure =
  | {
      ok: true;
      kind: SkillKind;
      /** Force per cast, or null for an aura or Bond. */
      force: number | null;
      spirit: number | null;
      casts: number | null;
      /** Damage per Force over the run; null when it deals no damage or costs no Force. */
      single: number | null;
      pack: number | null;
    }
  | { ok: false; error: string };

/**
 * One row's numbers under the tuning applied now. Kits go through the game's own kit path; spells
 * are compiled from their text, exactly as the balance test does.
 */
export function measureBenchSpec(spec: BenchSpec): BenchMeasure {
  try {
    let r: SkillRateResult;
    if (spec.kind === 'kit') {
      const def = STARTER_SIGILS.find((s) => s.id === spec.kitId);
      if (!def) return { ok: false, error: `No kit ${spec.kitId}` };
      const distance = kitDistance(def);
      r = measureRate({ classId: def.classId, equip: equipStarter(def), ...(distance !== undefined ? { distance } : {}) });
    } else {
      const compiled = compileBenchSpell(spec);
      if (!compiled.ok) return { ok: false, error: compiled.errors.map((e) => e.message).join('; ') };
      const distance = spellDistance(spec.text);
      r = measureRate({ classId: spec.classId, equip: () => ({ uid: -1, compiled, misfireMultiplier: 1, castDelayShare: 1 }), ...(distance !== undefined ? { distance } : {}) });
    }
    const deals = r.single !== null && (r.forcePerCast ?? 0) > 0;
    const pf = perForce(r);
    return { ok: true, kind: r.kind, force: r.forcePerCast, spirit: r.spiritReserved, casts: r.casts, single: deals ? pf.single : null, pack: deals ? pf.pack : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The reference the bench and the balance test divide by: the best damage kit to one target and to a pack. */
export function bestKit(kits: readonly BenchMeasure[]): { single: number; pack: number } | null {
  let single = 0;
  let pack = 0;
  for (const k of kits) {
    if (!k.ok || k.kind !== 'damage') continue;
    single = Math.max(single, k.single ?? 0);
    pack = Math.max(pack, k.pack ?? 0);
  }
  return single > 0 && pack > 0 ? { single, pack } : null;
}

export function benchMark(ratio: number | null): 'hard' | 'soft' | null {
  if (ratio === null) return null;
  return ratio > BENCH_MARKS.hard ? 'hard' : ratio > BENCH_MARKS.soft ? 'soft' : null;
}

export function kitSpecs(): BenchSpec[] {
  return STARTER_SIGILS.map((def) => ({ kind: 'kit', kitId: def.id }));
}

/** The balance test's spells; without a class it measures them on the mage. */
export function balanceSpecs(): (BenchSpec & { kind: 'spell' })[] {
  return BALANCE_SPELLS.map((s) => ({ kind: 'spell', text: s.text, classId: s.classId ?? 'mage', multicast: s.multicast ?? 1 }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * An admin pick as typed in: the text must read under the grammar and compile on its class, and
 * is stored as the grammar writes it back, so two spellings of one spell are one pick.
 */
export function checkBenchSpell(v: unknown): BenchSpell | string {
  if (!isRecord(v)) return 'Send { text, classId, multicast }';
  const { text, classId, multicast } = v;
  if (typeof text !== 'string' || text.trim() === '') return 'text is the rune text, like "bolt fire"';
  if (text.length > BENCH_LIMITS.textMax) return `text is at most ${BENCH_LIMITS.textMax} characters`;
  if (!isClassId(classId)) return `classId must be one of ${CLASS_IDS.join(', ')}`;
  const mc = multicast === undefined ? 1 : multicast;
  if (typeof mc !== 'number' || !Number.isInteger(mc) || mc < 1 || mc > BENCH_LIMITS.multicastMax) return `multicast must be a whole number from 1 to ${BENCH_LIMITS.multicastMax}`;
  const t = tokenizeSpell(text);
  const first = t.errors[0];
  if (first) return first.message;
  if (t.runes.length === 0) return 'No runes in that text';
  if (t.runes.length > SIGIL_MAX_SLOTS) return `A sigil holds at most ${SIGIL_MAX_SLOTS} runes`;
  const spell: BenchSpell = { text: formatRunes(t.runes), classId, multicast: mc };
  const compiled = compileBenchSpell(spell);
  if (!compiled.ok) return compiled.errors.map((e) => e.message).join('; ');
  return spell;
}

/** An admin pick as the server stores it, with who added it. */
export interface BenchPick extends BenchSpell {
  id: number;
  account: string;
  token: string | null;
  at: number;
}

/** A sigil as equipped on the server's characters: its runes and how many characters have it, never who. */
export interface PopularSigil extends BenchSpell {
  equipped: number;
}

export interface BenchState {
  picks: BenchPick[];
  popular: PopularSigil[];
  /** When the most-equipped list was counted. */
  popularAt: number;
}

function isBenchSpell(v: Record<string, unknown>): boolean {
  return typeof v.text === 'string' && isClassId(v.classId) && typeof v.multicast === 'number';
}

export function isBenchPick(v: unknown): v is BenchPick {
  return isRecord(v) && isBenchSpell(v) && typeof v.id === 'number' && typeof v.account === 'string' && (v.token === null || typeof v.token === 'string') && typeof v.at === 'number';
}

export function isBenchState(v: unknown): v is BenchState {
  if (!isRecord(v) || typeof v.popularAt !== 'number' || !Array.isArray(v.picks) || !Array.isArray(v.popular)) return false;
  return v.picks.every(isBenchPick) && v.popular.every((p) => isRecord(p) && isBenchSpell(p) && typeof p.equipped === 'number');
}

function storedAffixes(v: unknown): AffixRoll[] | null {
  if (!Array.isArray(v)) return null;
  const out: AffixRoll[] = [];
  for (const a of v) {
    if (!isRecord(a) || !isAffixId(a.id) || typeof a.tier !== 'number' || typeof a.value !== 'number' || !Number.isFinite(a.value)) return null;
    out.push({ id: a.id, tier: a.tier, value: a.value });
  }
  return out;
}

function storedRune(v: unknown): RuneItem | null {
  if (!isRecord(v) || v.kind !== 'rune' || typeof v.rune !== 'string' || !isRuneId(v.rune)) return null;
  const affixes = storedAffixes(v.affixes);
  return affixes ? { uid: 0, kind: 'rune', tier: 'common', name: '', ilvl: 1, rune: v.rune, count: 1, affixes } : null;
}

/** An equipped sigil's rune text and multicast, or null when the save holds something unreadable there. */
function equippedSpell(item: unknown): { text: string; multicast: number } | null {
  if (!isRecord(item) || item.kind !== 'sigil' || !Array.isArray(item.slots) || item.slots.length === 0) return null;
  const affixes = storedAffixes(item.affixes);
  if (!affixes) return null;
  const runes: RuneItem[] = [];
  for (const s of item.slots) {
    const r = storedRune(s);
    if (!r) return null;
    runes.push(r);
  }
  return { text: formatRunes(runes.map(toRuneInstance)), multicast: 1 + affixValue(affixes, 'multicast') };
}

/**
 * The sigils most equipped across saves, by rune text and multicast; each character counts a sigil
 * once. Only the runes are kept, so nothing names a player. Each is measured on the class most of
 * its holders play. Saves from before the rune rework (no `runeFormat: 2`) are skipped.
 */
export function mostEquipped(saves: Iterable<{ classId: unknown; save: unknown }>, limit: number = BENCH_LIMITS.popular): PopularSigil[] {
  const groups = new Map<string, { text: string; multicast: number; count: number; classes: Map<ClassId, number> }>();
  for (const { classId, save } of saves) {
    if (!isClassId(classId) || !isRecord(save) || save.runeFormat !== 2 || !Array.isArray(save.sigils) || !Array.isArray(save.items)) continue;
    const items = new Map<unknown, unknown>();
    for (const it of save.items) if (isRecord(it)) items.set(it.uid, it);
    const seen = new Set<string>();
    for (const uid of save.sigils) {
      if (typeof uid !== 'number') continue;
      const spell = equippedSpell(items.get(uid));
      if (!spell) continue;
      const key = `${spell.multicast}|${spell.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = groups.get(key) ?? { ...spell, count: 0, classes: new Map<ClassId, number>() };
      g.count++;
      g.classes.set(classId, (g.classes.get(classId) ?? 0) + 1);
      groups.set(key, g);
    }
  }
  const out: PopularSigil[] = [];
  for (const g of groups.values()) {
    let classId: ClassId = CLASS_IDS[0];
    let most = 0;
    for (const c of CLASS_IDS) {
      const n = g.classes.get(c) ?? 0;
      if (n > most) {
        most = n;
        classId = c;
      }
    }
    out.push({ text: g.text, classId, multicast: g.multicast, equipped: g.count });
  }
  out.sort((a, b) => b.equipped - a.equipped || (a.text < b.text ? -1 : a.text > b.text ? 1 : a.multicast - b.multicast));
  return out.slice(0, Math.max(0, limit));
}
