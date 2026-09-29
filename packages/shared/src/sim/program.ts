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

/** Seconds a node lives, mirroring the runtime in `sim/spells.ts`. */
export function nodeLifetime(node: SpellNode): number {
  const t = node.tuning;
  if (node.form === 'bolt' || node.form === 'orb') {
    const base = projectileBase(node.form);
    return (base.range * t.range) / (base.speed * t.speed);
  }
  if (node.form === 'zone') return SPELL.zone.durationSeconds * t.range;
  if (node.form === 'nova') return (SPELL.nova.durationSeconds * t.range) / t.speed;
  if (node.form === 'dash') return SPELL.dash.ticks * SIM.dt;
  return 0;
}

/** How many times a node releases its payload over its lifetime. */
function releases(node: SpellNode): number {
  const r = node.release;
  if (!r) return 0;
  if (r.kind === 'onhit' && (node.form === 'bolt' || node.form === 'orb')) return 1 + node.pierce;
  if (r.kind === 'every') return Math.max(1, Math.floor(nodeLifetime(node) / r.seconds + 1e-9));
  return 1;
}

/** Every entity one cast of this node ever spawns, including everything it releases. */
export function countEntities(node: SpellNode): number {
  const perRelease = node.payload.reduce((n, child) => n + countEntities(child), 0);
  return node.copies * (1 + releases(node) * perRelease);
}
