import { AURA, SPELL } from '../config/sim.js';
import { isOffensive, type ElementId, type FormId, type SpellNode, type SpellProgram } from './program.js';
import type { Rng } from './rng.js';

/**
 * Damage packets (docs/features/runes.md, "Damage packets"): every hit carries an amount per damage
 * type instead of one number and an element tag. Nothing resists a type yet; the packet is there so
 * resistances can read their own share later.
 */

export const DAMAGE_TYPES = ['physical', 'fire', 'cold', 'lightning', 'poison'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
export type DamagePacket = Record<DamageType, number>;

export interface DamageRange {
  min: number;
  max: number;
}

/** Flat damage a rune's "Adds X to Y" affixes put on top of a shape's hit, per element. */
export type AddedDamage = Record<ElementId, DamageRange>;

export function isDamageType(v: unknown): v is DamageType {
  return typeof v === 'string' && DAMAGE_TYPES.some((t) => t === v);
}

export function emptyPacket(): DamagePacket {
  return { physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
}

export function packetOf(type: DamageType, amount: number): DamagePacket {
  const p = emptyPacket();
  p[type] = amount;
  return p;
}

/** A monster's or minion's hit: physical unless the attack carries an element. */
export function hitPacket(amount: number, element: ElementId | null | undefined): DamagePacket {
  return packetOf(element ?? 'physical', amount);
}

export function packetTotal(p: Readonly<DamagePacket>): number {
  let total = 0;
  for (const t of DAMAGE_TYPES) total += p[t];
  return total;
}

export function scalePacket(p: Readonly<DamagePacket>, k: number): DamagePacket {
  const out = emptyPacket();
  for (const t of DAMAGE_TYPES) out[t] = p[t] * k;
  return out;
}

/** The type carrying most of the hit (the first in DAMAGE_TYPES on a tie), or null for an empty packet. */
export function dominantType(p: Readonly<DamagePacket>): DamageType | null {
  let best: DamageType | null = null;
  for (const t of DAMAGE_TYPES) if (p[t] > 0 && (best === null || p[t] > p[best])) best = t;
  return best;
}

/**
 * The element a floating number is coloured by: the type carrying most of the hit when it is an
 * element, else none. A tie goes to the element listed first in `order` (the shape's infusions, so
 * `bolt cold fire` reads cold), then to DAMAGE_TYPES order.
 */
export function hitElement(p: Readonly<DamagePacket>, order: readonly ElementId[] = []): ElementId | null {
  let top = 0;
  for (const t of DAMAGE_TYPES) top = Math.max(top, p[t]);
  if (top <= 0) return null;
  const tied = DAMAGE_TYPES.filter((t) => p[t] === top);
  const t = order.find((el) => tied.includes(el)) ?? tied[0];
  return t === 'fire' || t === 'cold' || t === 'lightning' ? t : null;
}

export function noAdded(): AddedDamage {
  return { fire: { min: 0, max: 0 }, cold: { min: 0, max: 0 }, lightning: { min: 0, max: 0 } };
}

export function hasAdded(added: Readonly<AddedDamage>): boolean {
  return added.fire.max > 0 || added.cold.max > 0 || added.lightning.max > 0;
}

// A set check refuses a min above its max (tunableSetProblem); ordering here keeps a half-applied set
// from ever rolling a range backwards.
function ordered(a: number, b: number): DamageRange {
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/**
 * The physical range a shape rolls on every hit, read live from SPELL. Null for Aura and Bond, which
 * deal damage only through their elements.
 */
export function shapeBaseRange(form: FormId): DamageRange | null {
  switch (form) {
    case 'orb':
    case 'bolt':
    case 'nova':
    case 'zone':
    case 'dash':
      return ordered(SPELL[form].damageMin, SPELL[form].damageMax);
    case 'aura':
    case 'bond':
      return null;
  }
}

export function rangeMean(r: Readonly<DamageRange>): number {
  return (r.min + r.max) / 2;
}

/**
 * Each type's range on one hit, before the spell's multipliers: the base physical range, converted in
 * equal shares to the infusions the shape carries (all of it to one infusion, half each to two), plus
 * the added damage, which converts nothing.
 */
export function hitRanges(base: Readonly<DamageRange>, elements: readonly ElementId[], added: Readonly<AddedDamage>): Record<DamageType, DamageRange> {
  const out: Record<DamageType, DamageRange> = {
    physical: { min: 0, max: 0 },
    fire: { ...added.fire },
    cold: { ...added.cold },
    lightning: { ...added.lightning },
    poison: { min: 0, max: 0 },
  };
  const kinds = [...new Set(elements)];
  if (kinds.length === 0) {
    out.physical = { ...base };
    return out;
  }
  for (const el of kinds) {
    out[el] = { min: out[el].min + base.min / kinds.length, max: out[el].max + base.max / kinds.length };
  }
  return out;
}

function roll(rng: Rng, r: Readonly<DamageRange>): number {
  return r.max > r.min ? r.min + (r.max - r.min) * rng.next() : r.min;
}

/**
 * One hit's packet before multipliers. The base is rolled once and then converted, so a shape with two
 * infusions splits one roll; each added element rolls on its own. Ranges with nothing to roll draw
 * nothing. Rolls come from the sim's damage stream, so the same seed and casts give the same hits and
 * no combat roll (misfires, reflects) moves when a hit rolls.
 */
export function rollHit(rng: Rng, base: Readonly<DamageRange>, elements: readonly ElementId[], added: Readonly<AddedDamage>): DamagePacket {
  const p = emptyPacket();
  const physical = roll(rng, base);
  const kinds = [...new Set(elements)];
  if (kinds.length === 0) p.physical = physical;
  else for (const el of kinds) p[el] += physical / kinds.length;
  for (const el of ['fire', 'cold', 'lightning'] as const) if (added[el].max > 0) p[el] += roll(rng, added[el]);
  return p;
}

/** The average hit of a set of ranges, as a packet. */
export function meanPacket(ranges: Readonly<Record<DamageType, DamageRange>>): DamagePacket {
  const p = emptyPacket();
  for (const t of DAMAGE_TYPES) p[t] = rangeMean(ranges[t]);
  return p;
}

/** One type's share of a hit, for tooltips and the sentence. */
export interface DamagePart {
  type: DamageType;
  min: number;
  max: number;
}

export function scaleRanges(ranges: Readonly<Record<DamageType, DamageRange>>, k: number): Record<DamageType, DamageRange> {
  const out = { ...ranges };
  for (const t of DAMAGE_TYPES) out[t] = { min: ranges[t].min * k, max: ranges[t].max * k };
  return out;
}

/** The types a set of ranges deals, in DAMAGE_TYPES order, leaving out the ones at zero. */
export function damageParts(ranges: Readonly<Record<DamageType, DamageRange>>): DamagePart[] {
  return DAMAGE_TYPES.filter((t) => ranges[t].max > 0).map((t) => ({ type: t, min: ranges[t].min, max: ranges[t].max }));
}

/** "12 to 20": rounded, one number when both ends round alike. */
export function formatDamageRange(min: number, max: number): string {
  const lo = Math.round(min);
  const hi = Math.round(max);
  return lo === hi ? String(lo) : `${lo} to ${hi}`;
}

/** "12 to 20 physical and 4 to 8 fire damage". */
export function formatDamageParts(parts: readonly DamagePart[]): string {
  const words = parts.map((p) => `${formatDamageRange(p.min, p.max)} ${p.type}`);
  const list = words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
  return `${list} damage`;
}

/** How often a shape's damage lands: once per hit, per zone tick, or per second for an aura. */
export type DamageCadence = { per: 'hit' } | { per: 'tick'; seconds: number } | { per: 'second' };

/** What one shape of a compiled spell deals, before the caster's gear and Bond bonuses. */
export interface ShapeDamage {
  form: FormId;
  copies: number;
  /** 0 for the cast, one more per payload level. */
  depth: number;
  cadence: DamageCadence;
  parts: DamagePart[];
}

/**
 * A compiled shape's damage with its sigil, rolls, Splits, doubled infusions and Frostfire, as the
 * engine deals it to an enemy without gear or Bond bonuses. Null for a shape that deals none.
 */
export function shapeDamage(node: SpellNode): ShapeDamage | null {
  const frostfire = node.combos.includes('frostfire') ? 1 + SPELL.comboDamageBonus : 1;
  const scale = node.damageScale * node.tuning.damage * frostfire;
  if (node.form === 'aura') {
    // Each element burns on its own every second; the aura's effects deal nothing.
    const kinds = [...new Set(node.elements)];
    if (kinds.length === 0) return null;
    const each = AURA.elementDps * node.damageScale * node.tuning.damage;
    return { form: node.form, copies: 1, depth: node.depth, cadence: { per: 'second' }, parts: kinds.map((type) => ({ type, min: each, max: each })) };
  }
  const base = shapeBaseRange(node.form);
  if (!base || !isOffensive(node)) return null;
  const parts = damageParts(scaleRanges(hitRanges(base, node.elements, node.added), scale));
  if (parts.length === 0) return null;
  const cadence: DamageCadence = node.form === 'zone' ? { per: 'tick', seconds: SPELL.zone.tickSeconds / node.tuning.speed } : { per: 'hit' };
  return { form: node.form, copies: node.copies, depth: node.depth, cadence, parts };
}

/** Every damaging shape of a spell, the cast first and each payload after its parent. */
export function programDamage(program: SpellProgram): ShapeDamage[] {
  const out: ShapeDamage[] = [];
  const visit = (node: SpellNode): void => {
    const d = shapeDamage(node);
    if (d) out.push(d);
    for (const child of node.payload) visit(child);
  };
  for (const root of program.roots) visit(root);
  return out;
}
