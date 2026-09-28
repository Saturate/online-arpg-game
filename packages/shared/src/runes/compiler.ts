import { HEAT, SPELL } from '../config/sim.js';
import { CLASSES, type ClassId } from '../data/classes.js';
import {
  COMBOS,
  isEffectId,
  isElementId,
  isFormId,
  isModifierId,
  isRuneId,
  isTriggerId,
  RUNES,
  TRIGGERS_FOR_FORM,
  type EffectId,
  type ElementId,
  type FormId,
  type ModifierId,
  type RuneId,
  type TriggerId,
} from '../data/runes.js';

export interface SpellNode {
  form: FormId;
  elements: ElementId[];
  effects: EffectId[];
  modifiers: Record<ModifierId, number>;
  /** Copies produced by an untriggered Split at the point this node is spawned. */
  castSplit: number;
  branch: SpellBranch | null;
  depth: number;
  combos: string[];
  /** Damage multiplier after split conservation and affixes. */
  damageScale: number;
  /** Radius multiplier from affixes. Large is kept separately in `modifiers`. */
  areaScale: number;
  /** Hand tuning from a prebaked skill; only ever set on the root node. */
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

export type DudReason =
  | 'empty'
  | 'unknown_rune'
  | 'over_capacity'
  | 'no_form_first'
  | 'orphan_form'
  | 'trailing_trigger'
  | 'trigger_needs_action'
  | 'trigger_form_mismatch'
  | 'persistent_trigger'
  | 'persistent_split'
  | 'persistent_subspell'
  | 'split_dash'
  | 'too_deep'
  | 'entity_cap';

export type CompileResult =
  | {
      ok: true;
      program: SpellNode;
      heat: number;
      spirit: number;
      worstCaseEntities: number;
      combos: string[];
      persistent: boolean;
    }
  | { ok: false; dud: DudReason; heat: number };

/** Sigil affix effects that change compilation. Neutral values are 0 bonus and multiplier 1. */
export interface CompileMods {
  maxDepthBonus: number;
  splitEfficiencyBonus: number;
  heatMultiplier: number;
  spiritMultiplier: number;
  areaMultiplier: number;
  damageMultiplier: number;
}

export const NEUTRAL_MODS: CompileMods = {
  maxDepthBonus: 0,
  splitEfficiencyBonus: 0,
  heatMultiplier: 1,
  spiritMultiplier: 1,
  areaMultiplier: 1,
  damageMultiplier: 1,
};

export interface CompileContext {
  classId: ClassId;
  capacity: number;
  mods: CompileMods;
  tuning?: Partial<SpellTuning>;
  /** Prebaked skills may exceed the default entity cap; player-built ones may not. */
  maxEntities?: number;
}

function emptyModifiers(): Record<ModifierId, number> {
  return { swift: 0, large: 0, linger: 0, pierce: 0 };
}

function newNode(form: FormId, depth: number, mods: CompileMods): SpellNode {
  return {
    form,
    elements: [],
    effects: [],
    modifiers: emptyModifiers(),
    castSplit: 1,
    branch: null,
    depth,
    combos: [],
    damageScale: mods.damageMultiplier,
    areaScale: mods.areaMultiplier,
    tuning: NEUTRAL_TUNING,
  };
}

function splitCount(): number {
  return RUNES.split.params?.count ?? SPELL.splitDefaultCount;
}

/**
 * Heat is computed separately from parsing so duds still get a cost: every rune is charged at the
 * depth it would sit at, with depth increasing after each Trigger + Split/Form pair.
 */
export function computeHeat(runes: readonly RuneId[], classId: ClassId, heatMultiplier: number): number {
  const affinity = new Set(CLASSES[classId].affinityRunes);
  let depth = 0;
  let heat = 0;
  for (let i = 0; i < runes.length; i++) {
    const id = runes[i];
    if (id === undefined) continue;
    const next = runes[i + 1];
    const mult = affinity.has(id) ? HEAT.affinityMultiplier : HEAT.offAffinityMultiplier;
    heat += RUNES[id].heatCost * (1 + HEAT.depthHeatFactor * depth) * mult;
    if (isTriggerId(id) && next !== undefined) {
      if (next === 'split') {
        const splitMult = affinity.has('split') ? HEAT.affinityMultiplier : HEAT.offAffinityMultiplier;
        heat += RUNES.split.heatCost * (1 + HEAT.depthHeatFactor * depth) * splitMult;
        depth++;
        i++;
      } else if (isFormId(next)) {
        depth++;
      }
    }
  }
  return Math.round(heat * heatMultiplier * 10) / 10;
}

function computeSpirit(runes: readonly RuneId[], mult: number): number {
  let spirit = 0;
  for (const id of runes) spirit += RUNES[id].spiritCost ?? 0;
  return Math.round(spirit * mult);
}

export function compile(rawRunes: readonly unknown[], ctx: CompileContext): CompileResult {
  const runes: RuneId[] = [];
  for (const r of rawRunes) {
    if (!isRuneId(r)) return { ok: false, dud: 'unknown_rune', heat: 0 };
    runes.push(r);
  }
  const heat = computeHeat(runes, ctx.classId, ctx.mods.heatMultiplier);
  const dud = (reason: DudReason): CompileResult => ({ ok: false, dud: reason, heat });

  if (runes.length > ctx.capacity) return dud('over_capacity');
  const first = runes[0];
  if (first === undefined) return dud('empty');
  if (!isFormId(first)) return dud('no_form_first');

  const persistent = RUNES[first].persistent === true;
  const maxDepth = SPELL.maxDepth + ctx.mods.maxDepthBonus;
  const efficiency = SPELL.splitEfficiency + ctx.mods.splitEfficiencyBonus;
  const root = newNode(first, 0, ctx.mods);
  root.tuning = { ...NEUTRAL_TUNING, ...ctx.tuning };
  let current = root;

  for (let i = 1; i < runes.length; i++) {
    const id = runes[i];
    if (id === undefined) continue;

    if (isElementId(id)) {
      if (!current.elements.includes(id)) current.elements.push(id);
      continue;
    }
    if (isEffectId(id)) {
      if (!current.effects.includes(id)) current.effects.push(id);
      continue;
    }
    if (isModifierId(id)) {
      current.modifiers[id]++;
      continue;
    }
    if (id === 'split') {
      if (persistent) return dud('persistent_split');
      if (current.form === 'dash') return dud('split_dash');
      const n = splitCount();
      current.castSplit *= n;
      current.damageScale *= efficiency / n;
      continue;
    }
    if (isFormId(id)) return dud('orphan_form');

    // Trigger
    if (persistent) return dud('persistent_trigger');
    const next = runes[i + 1];
    if (next === undefined) return dud('trailing_trigger');
    if (!TRIGGERS_FOR_FORM[current.form].includes(id)) return dud('trigger_form_mismatch');
    if (current.depth + 1 > maxDepth) return dud('too_deep');

    if (next === 'split') {
      if (current.form === 'dash') return dud('split_dash');
      const n = splitCount();
      const copies: SpellNode = {
        ...newNode(current.form, current.depth + 1, ctx.mods),
        elements: [...current.elements],
        effects: [...current.effects],
        modifiers: { ...current.modifiers },
        damageScale: current.damageScale * (efficiency / n),
        // Pulse sprays are shards, not copies of the orb, so they do not inherit its hand tuning.
        tuning: id === 'pulse' ? NEUTRAL_TUNING : current.tuning,
      };
      current.branch = { trigger: id, action: 'split', count: n, node: copies };
      current = copies;
      i++;
      continue;
    }
    if (isFormId(next)) {
      if (RUNES[next].persistent) return dud('persistent_subspell');
      const child = newNode(next, current.depth + 1, ctx.mods);
      current.branch = { trigger: id, action: 'form', node: child };
      current = child;
      i++;
      continue;
    }
    return dud('trigger_needs_action');
  }

  resolveInheritance(root, []);
  const combos = new Set<string>();
  collectCombos(root, combos);

  const worstCaseEntities = countEntities(root);
  if (worstCaseEntities > (ctx.maxEntities ?? SPELL.maxEntities)) return dud('entity_cap');

  return {
    ok: true,
    program: root,
    heat: persistent ? 0 : heat,
    spirit: persistent ? computeSpirit(runes, ctx.mods.spiritMultiplier) : 0,
    worstCaseEntities,
    combos: [...combos],
    persistent,
  };
}

/** Sub-spells inherit the parent's element unless they have their own. */
function resolveInheritance(node: SpellNode, parentElements: ElementId[]): void {
  if (node.elements.length === 0 && parentElements.length > 0) node.elements = [...parentElements];
  if (node.branch) resolveInheritance(node.branch.node, node.elements);
}

function collectCombos(node: SpellNode, out: Set<string>): void {
  const attached = new Set<RuneId>([...node.elements, ...node.effects]);
  for (const combo of COMBOS) {
    if (attached.has(combo.runes[0]) && attached.has(combo.runes[1])) {
      node.combos.push(combo.id);
      out.add(combo.id);
    }
  }
  if (node.branch) collectCombos(node.branch.node, out);
}

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

/** Human-readable description of a compiled spell, for tooltips and the debug overlay. */
export function describeSpell(node: SpellNode): string {
  const parts: string[] = [];
  const mods = Object.entries(node.modifiers)
    .filter(([, n]) => n > 0)
    .map(([m, n]) => (n > 1 ? `${m}x${n}` : m));
  let s = [...node.elements, ...node.effects, ...mods, node.form].join(' ');
  if (node.castSplit > 1) s += ` x${node.castSplit}`;
  parts.push(s);
  const b = node.branch;
  if (b) {
    parts.push(b.action === 'split' ? `-${b.trigger}-> split x${b.count} [${describeSpell(b.node)}]` : `-${b.trigger}-> ${describeSpell(b.node)}`);
  }
  return parts.join(' ');
}
