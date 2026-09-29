import { SPELL } from '../config/sim.js';
import type { EffectId, InfusionId, TriggerId } from '../runes/v2/runes.js';

/**
 * The engine contract: what `runes/v2/compile.ts` produces and what `sim/spells.ts` and
 * `sim/auras.ts` run. Nothing outside the compiler and the engine looks inside a program.
 */

export type ElementId = InfusionId;
export type { EffectId, TriggerId };

/** Forms the engine can spawn. An Orb runs as a slow, big bolt until it has its own form. */
export type FormId = 'bolt' | 'nova' | 'zone' | 'dash' | 'aura' | 'bond';
export type ModifierId = 'swift' | 'large' | 'linger' | 'pierce';

export interface SpellNode {
  form: FormId;
  elements: ElementId[];
  effects: EffectId[];
  modifiers: Record<ModifierId, number>;
  /** Copies spawned together at the point this node is spawned. */
  castSplit: number;
  branch: SpellBranch | null;
  depth: number;
  combos: string[];
  /** Damage multiplier after split conservation and affixes. */
  damageScale: number;
  /** Radius multiplier from sigil affixes. */
  areaScale: number;
  /** Per-node numbers from the rune's affixes, as multipliers of the form's base values. */
  tuning: SpellTuning;
}

export interface SpellTuning {
  speed: number;
  range: number;
  damage: number;
  radius: number;
  /** 1 makes a projectile pass through everything it hits, like D2's Frozen Orb. */
  phase: number;
}

export const NEUTRAL_TUNING: SpellTuning = { speed: 1, range: 1, damage: 1, radius: 1, phase: 0 };

export type SpellBranch =
  | { trigger: TriggerId; action: 'split'; count: number; node: SpellNode }
  | { trigger: TriggerId; action: 'form'; node: SpellNode };

/** A compiled spell as the engine runs it. */
export type SpellProgram = SpellNode;

/** Seconds a node lives, mirroring the runtime in `sim/spells.ts`. */
export function nodeLifetime(node: SpellNode): number {
  const m = node.modifiers;
  const t = node.tuning;
  if (node.form === 'bolt') {
    const speed = SPELL.bolt.speed * SPELL.modifiers.swiftSpeed ** m.swift * t.speed;
    return (SPELL.bolt.range * SPELL.modifiers.lingerDuration ** m.linger * t.range) / speed;
  }
  if (node.form === 'zone') return SPELL.zone.durationSeconds * SPELL.modifiers.lingerDuration ** m.linger * t.range;
  return 0;
}

/** How many times a node's trigger can fire over its lifetime. */
function triggerFires(node: SpellNode, trigger: TriggerId): number {
  if (trigger === 'onhit' && node.form === 'bolt') return 1 + node.modifiers.pierce * SPELL.modifiers.pierceHits;
  if (trigger === 'pulse') return Math.max(1, Math.floor(nodeLifetime(node) / SPELL.pulseSeconds));
  return 1;
}

/** Worst case entity count for one cast, including every recursive trigger. */
export function countEntities(node: SpellNode): number {
  let perInstance = 1;
  const b = node.branch;
  if (b) {
    const perFire = b.action === 'split' ? b.count * countEntities(b.node) : countEntities(b.node);
    // A triggered split replaces the node, so it fires once; Pulse keeps the node and fires repeatedly.
    perInstance += (b.action === 'split' && b.trigger !== 'pulse' ? 1 : triggerFires(node, b.trigger)) * perFire;
  }
  return node.castSplit * perInstance;
}
