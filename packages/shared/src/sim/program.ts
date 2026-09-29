import { SIM, SPELL } from '../config/sim.js';
import type { EffectId, InfusionId } from '../runes/v2/runes.js';

/**
 * The engine contract: what `runes/v2/compile.ts` produces and what `sim/spells.ts` and
 * `sim/auras.ts` run. Nothing outside the compiler and the engine looks inside a program.
 */

export type ElementId = InfusionId;
export type { EffectId };

/** Forms the engine can spawn. */
export type FormId = 'orb' | 'bolt' | 'nova' | 'zone' | 'dash' | 'aura' | 'bond';

/** When a node lets its payload go. `after` and `every` carry their own seconds. */
export type ReleaseTrigger = 'onhit' | 'onexpire' | 'after' | 'every' | 'onland';

export interface SpellRelease {
  kind: ReleaseTrigger;
  /** Seconds for `after` (from spawn) and `every` (interval); 0 for the rest. */
  seconds: number;
}

export interface SpellNode {
  form: FormId;
  elements: ElementId[];
  effects: EffectId[];
  /** Copies spawned together wherever this node is spawned (Split). */
  copies: number;
  /** Extra enemies a projectile passes through before it is spent. */
  pierce: number;
  release: SpellRelease | null;
  /** Shapes spawned together when this node releases (a payload may hold several). */
  payload: SpellNode[];
  depth: number;
  combos: string[];
  /** Damage, heal and shield multiplier after split conservation, stacked infusions and the sigil. */
  damageScale: number;
  /** Radius multiplier from sigil affixes. */
  areaScale: number;
  /** Per-node numbers from the rune's affixes, as multipliers of the form's base values. */
  tuning: SpellTuning;
}

export interface SpellTuning {
  speed: number;
  /** Lifetime: a projectile's range, a zone's duration, a nova's expansion time. */
  range: number;
  damage: number;
  radius: number;
  /** 1 makes a projectile pass through everything it hits, like D2's Frozen Orb. */
  phase: number;
}

export const NEUTRAL_TUNING: SpellTuning = { speed: 1, range: 1, damage: 1, radius: 1, phase: 0 };

/** A compiled spell as the engine runs it. */
export interface SpellProgram {
  /** Shapes cast together when the sigil fires (multicast). A persistent program has exactly one. */
  roots: SpellNode[];
  /** The first root's form: tells an aura or a bond from a cast spell without looking further. */
  form: FormId;
}

/** Base numbers of a flying form. */
export function projectileBase(form: 'orb' | 'bolt'): { damage: number; speed: number; range: number; radius: number } {
  return form === 'orb' ? SPELL.orb : SPELL.bolt;
}

/** A rune affix percentage as a multiplier of the base value; never below a tenth. */
export function affixMultiplier(percent: number): number {
  return Math.max(0.1, 1 + percent / 100);
}

/**
 * Seconds a form lives, as `sim/spells.ts` runs it: whole ticks, since a form ends on the first tick
 * at or past its time and still releases on that tick. The compiler's entity budget and Force price
 * read this too, so the forge's numbers are the engine's numbers.
 */
export function formLifetime(form: FormId, speed: number, range: number): number {
  const ticks = (seconds: number): number => Math.ceil(seconds / SIM.dt - 1e-9) * SIM.dt;
  if (form === 'bolt' || form === 'orb') {
    const base = projectileBase(form);
    return ticks((base.range * range) / (base.speed * speed));
  }
  if (form === 'zone') return ticks(SPELL.zone.durationSeconds * range);
  if (form === 'nova') return ticks((SPELL.nova.durationSeconds * range) / speed);
  if (form === 'dash') return SPELL.dash.ticks * SIM.dt;
  return Number.POSITIVE_INFINITY;
}

export function nodeLifetime(node: SpellNode): number {
  return formLifetime(node.form, node.tuning.speed, node.tuning.range);
}

/**
 * How many times one copy of a form releases its payload over its life: an interval release once per
 * interval it lives through (the first at one interval, as the engine's pulse timer runs), an on-hit
 * projectile once per enemy it can hit, everything else once.
 */
export function releaseCount(form: FormId, release: SpellRelease | null, lifetime: number, pierce: number): number {
  if (!release) return 0;
  if (release.kind === 'onhit' && (form === 'bolt' || form === 'orb')) return 1 + pierce;
  if (release.kind === 'every') return Number.isFinite(lifetime) ? Math.max(1, Math.floor(lifetime / release.seconds + 1e-9)) : 1;
  return 1;
}

export function releases(node: SpellNode): number {
  return releaseCount(node.form, node.release, nodeLifetime(node), node.pierce);
}

/** Every entity one cast of this node ever spawns, including everything it releases. */
export function countEntities(node: SpellNode): number {
  const perRelease = node.payload.reduce((n, child) => n + countEntities(child), 0);
  return node.copies * (1 + releases(node) * perRelease);
}
