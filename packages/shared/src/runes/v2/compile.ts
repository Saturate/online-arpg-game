import { HEAT, SPELL } from '../../config/sim.js';
import { CLASSES, type ClassId } from '../../data/classes.js';
import { affixValue, hasAffix, sigilCapacity, toRuneInstance, type SigilItem } from '../../items/items.js';
import { NEUTRAL_TUNING, type ElementId, type FormId, type SpellBranch, type SpellNode as EngineNode, type SpellProgram } from '../../sim/program.js';
import { parseSpell, type SpellNode, type SpellTree } from './parse.js';
import { DEFAULT_CONTEXT, RULES, type GrammarError, type RuleKey } from './rules.js';
import {
  COMBOS,
  DEFAULTS,
  isCastableRune,
  isPersistentShape,
  runeName,
  type ReleaseKind,
  type RuneId,
  type RuneInstance,
  type ShapeId,
  type TriggerId,
} from './runes.js';

/**
 * The spell compiler: a rune list and the sigil holding it become the engine's program, its Force
 * or spirit price, and every rule it breaks, named. The grammar (parse.ts) decides what a list
 * means; this file decides what the engine can run and what it costs.
 */

export interface SigilCompileContext {
  classId: ClassId;
  /** Rune slots the sigil has. */
  slots: number;
  /** Shapes cast together in one group. */
  multicast: number;
  /** Payload levels allowed below the cast. */
  maxDepth: number;
  /** Everything a cast costs is multiplied by this (the sigil's Force cost wand stat). */
  forceMultiplier: number;
  spiritMultiplier: number;
  damageMultiplier: number;
  areaMultiplier: number;
  splitEfficiencyBonus: number;
  /** The first rune costs no Force (a rare sigil roll). */
  firstRuneFree: boolean;
}

export const DEFAULT_SIGIL_CONTEXT: Omit<SigilCompileContext, 'classId'> = {
  slots: 10,
  multicast: DEFAULT_CONTEXT.multicast,
  maxDepth: DEFAULT_CONTEXT.maxDepth,
  forceMultiplier: HEAT.costMultiplier,
  spiritMultiplier: 1,
  damageMultiplier: 1,
  areaMultiplier: 1,
  splitEfficiencyBonus: 0,
  firstRuneFree: false,
};

export type SigilCompile =
  | {
      ok: true;
      tree: SpellTree;
      program: SpellProgram;
      force: number;
      spirit: number;
      persistent: boolean;
      peakEntities: number;
      /** Things that run differently from how they read, for the editor to show. */
      notes: string[];
    }
  | { ok: false; errors: GrammarError[]; force: number };

/**
 * Listed Force per rune, before depth, affinity and the sigil. The v1 numbers carried over; Orb
 * and the phase 4 runes are new. Split is priced per copy (2 per copy, so a Split of 3 costs the
 * old 6). A release affix costs what its trigger rune would, so the affix saves a slot, not Force.
 */
export const RUNE_FORCE: Record<RuneId, number> = {
  orb: 10,
  bolt: 8,
  beam: 12,
  nova: 14,
  zone: 16,
  dash: 12,
  arrow: 8,
  strike: 6,
  cleave: 8,
  throw: 8,
  trap: 10,
  aura: 0,
  bond: 0,
  fire: 4,
  cold: 4,
  lightning: 5,
  split: 0,
  link: 6,
  orbit: 6,
  homing: 4,
  bounce: 4,
  chain: 6,
  stack: 6,
  charge: 6,
  impact: 5,
  ward: 5,
  restore: 6,
  onhit: 4,
  onexpire: 4,
  timer: 4,
  pulse: 6,
  onland: 4,
  swift: 3,
  large: 3,
};
const SPLIT_FORCE_PER_COPY = 2;
const RELEASE_FORCE: Record<ReleaseKind, number> = { onhit: 4, onexpire: 4, after: 4, every: 6, onland: 4, onrelease: 4 };

/** Spirit a persistent skill reserves per rune in it (the v1 numbers, Bond taking Link's). */
export const RUNE_SPIRIT: Partial<Record<RuneId, number>> = {
  aura: 30,
  bond: 25,
  fire: 10,
  cold: 10,
  lightning: 10,
  impact: 10,
  ward: 12,
  restore: 12,
  swift: 5,
  large: 8,
};

const FORM_FOR_SHAPE: Partial<Record<ShapeId, FormId>> = { orb: 'bolt', bolt: 'bolt', nova: 'nova', zone: 'zone', dash: 'dash', aura: 'aura', bond: 'bond' };

/** Orb is a slow, big bolt until the engine has its own shape. */
const ORB_BASE = { speed: 0.55, radius: 2, range: 1.3 } as const;

const TRIGGER_FOR_RELEASE: Partial<Record<ReleaseKind, TriggerId>> = { onhit: 'onhit', onexpire: 'onexpire', after: 'timer', every: 'pulse', onland: 'onland' };

/** Each extra copy of an infusion adds this much damage: doubled runes stack for now (owner decision). */
const STACKED_INFUSION_BONUS = 0.25;

const round1 = (n: number): number => Math.round(n * 10) / 10;

function error(rule: RuleKey, runeIndex: number, message: string): GrammarError {
  return { rule: RULES[rule].id, runeIndex, message };
}

/** Payload depth of every rune: the depth of the shape it attaches to (a pending Split, its payload's). */
function runeDepths(runes: readonly RuneInstance[], tree: SpellTree | null): number[] {
  const byIndex = new Map<number, number>();
  const visit = (node: SpellNode): void => {
    byIndex.set(node.runeIndex, node.depth);
    for (const s of node.shapers) byIndex.set(s.runeIndex, node.depth);
    if (node.release) byIndex.set(node.release.runeIndex, node.depth);
    for (const child of node.payload) visit(child);
  };
  for (const root of tree?.roots ?? []) visit(root);
  let last = 0;
  return runes.map((_, i) => {
    const d = byIndex.get(i);
    if (d !== undefined) last = d;
    return d ?? last;
  });
}

/**
 * Force for one cast. Every rune is charged at the payload depth it sits at:
 *   rune cost x (1 + HEAT.depthHeatFactor x depth) x affinity
 * where a shape's cost includes its release affix, a Split costs 2 per copy, affinity is
 * HEAT.affinityMultiplier for the class's affinity runes and HEAT.offAffinityMultiplier otherwise,
 * and the first rune is free on a sigil that rolled it. The sum is multiplied by the sigil's
 * `forceMultiplier` (HEAT.costMultiplier and its Force cost affix) and rounded to 0.1.
 */
export function runeForce(runes: readonly RuneInstance[], tree: SpellTree | null, ctx: SigilCompileContext): number {
  const affinity = new Set<string>(CLASSES[ctx.classId].affinityRunes);
  const depths = runeDepths(runes, tree);
  let force = 0;
  runes.forEach((rune, i) => {
    if (i === 0 && ctx.firstRuneFree) return;
    let cost = rune.id === 'split' ? SPLIT_FORCE_PER_COPY * (rune.affixes.count ?? DEFAULTS.splitCount) : RUNE_FORCE[rune.id];
    if (rune.affixes.release) cost += RELEASE_FORCE[rune.affixes.release.kind];
    const mult = affinity.has(rune.id) ? HEAT.affinityMultiplier : HEAT.offAffinityMultiplier;
    force += cost * (1 + HEAT.depthHeatFactor * (depths[i] ?? 0)) * mult;
  });
  return round1(force * ctx.forceMultiplier);
}

function runeSpirit(runes: readonly RuneInstance[], mult: number): number {
  let spirit = 0;
  for (const r of runes) spirit += RUNE_SPIRIT[r.id] ?? 0;
  return Math.round(spirit * mult);
}

/** Everything the engine cannot run yet, named. Empty when the tree is castable. */
function engineGaps(runes: readonly RuneInstance[], tree: SpellTree): GrammarError[] {
  const out: GrammarError[] = [];
  runes.forEach((r, i) => {
    if (!isCastableRune(r.id)) out.push(error('RUNE_NOT_CASTABLE', i, `${runeName(r.id)} (rune ${i + 1}) is not in the game yet; nothing can cast it.`));
  });
  if (tree.roots.length > 1) {
    const second = tree.roots[1];
    out.push(error('ENGINE_NOT_READY', second?.runeIndex ?? -1, 'Shapes cast together (multicast) do not run in the engine yet.'));
  }
  const visit = (node: SpellNode): void => {
    const name = `${runeName(node.shape)} (rune ${node.runeIndex + 1})`;
    if (node.stats.homing > 0) out.push(error('ENGINE_NOT_READY', node.runeIndex, `${name} homes; homing does not run in the engine yet.`));
    if (node.stats.bounce > 0) out.push(error('ENGINE_NOT_READY', node.runeIndex, `${name} bounces; bouncing does not run in the engine yet.`));
    if (node.payload.length > 1) {
      const second = node.payload[1];
      out.push(error('ENGINE_NOT_READY', second?.runeIndex ?? node.runeIndex, `${name} releases several shapes at once; that does not run in the engine yet.`));
    }
    for (const child of node.payload) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return out;
}

const pct = (v: number): number => Math.max(0.1, 1 + v / 100);

function buildNode(node: SpellNode, ctx: SigilCompileContext, notes: string[]): EngineNode {
  const form = FORM_FOR_SHAPE[node.shape] ?? 'bolt';
  const elements: ElementId[] = [];
  let stackBonus = 1;
  for (const el of node.effectiveInfusions) {
    if (elements.includes(el)) stackBonus += STACKED_INFUSION_BONUS;
    else elements.push(el);
  }
  const efficiency = SPELL.splitEfficiency + ctx.splitEfficiencyBonus;
  // Each Split conserves damage on its own, as v1 did, so two Splits of 3 keep (1.2 / 3)^2 each.
  let splitScale = 1;
  for (const s of node.shapers) if (s.id === 'split') splitScale *= efficiency / s.value;
  const base = node.shape === 'orb' ? ORB_BASE : { speed: 1, radius: 1, range: 1 };
  const attached = new Set<RuneId>([...elements, ...node.effects]);
  const combos = COMBOS.filter((c) => attached.has(c.runes[0]) && attached.has(c.runes[1])).map((c) => c.id);
  const out: EngineNode = {
    form,
    elements,
    effects: [...node.effects],
    modifiers: { swift: 0, large: 0, linger: 0, pierce: node.stats.pierce / SPELL.modifiers.pierceHits },
    castSplit: node.copies,
    branch: null,
    depth: node.depth,
    combos,
    damageScale: ctx.damageMultiplier * splitScale * stackBonus,
    areaScale: ctx.areaMultiplier,
    tuning: {
      ...NEUTRAL_TUNING,
      speed: base.speed * pct(node.stats.speed),
      radius: base.radius * pct(node.stats.size),
      range: base.range * pct(node.stats.duration),
      damage: pct(node.stats.damage),
    },
  };

  const release = node.release;
  const child = node.payload[0];
  const trigger = release ? TRIGGER_FOR_RELEASE[release.kind] : undefined;
  if (release && child && trigger) {
    if (release.kind === 'after' && release.seconds !== SPELL.timerSeconds) notes.push(`"after ${release.seconds} s" runs at the engine's ${SPELL.timerSeconds} s for now.`);
    if (release.kind === 'every' && release.seconds !== SPELL.pulseSeconds) notes.push(`"every ${release.seconds} s" runs at the engine's ${SPELL.pulseSeconds} s for now.`);
    const built = buildNode(child, ctx, notes);
    let branch: SpellBranch;
    if (trigger === 'pulse' && built.castSplit > 1) {
      // A pulse sprays split copies in a rotating ring (Frozen Orb); elsewhere copies fan out as cast.
      const count = built.castSplit;
      branch = { trigger, action: 'split', count, node: { ...built, castSplit: 1 } };
    } else {
      branch = { trigger, action: 'form', node: built };
    }
    out.branch = branch;
  }
  return out;
}

/** Compiles a rune list for a sigil. `force` is filled in on failure too: a dud still costs to cast. */
export function compileRunes(runes: readonly RuneInstance[], ctx: SigilCompileContext): SigilCompile {
  const parsed = parseSpell(runes, { multicast: ctx.multicast, maxDepth: ctx.maxDepth, liveCap: SPELL.liveCap.max, plainModifierRunes: true });
  const force = runeForce(runes, parsed.tree, ctx);
  const errors: GrammarError[] = [];
  if (runes.length > ctx.slots) {
    errors.push(error('OVER_CAPACITY', ctx.slots, `The sigil has ${ctx.slots} slots; the spell uses ${runes.length} runes.`));
  }
  errors.push(...parsed.errors);
  const tree = parsed.tree;
  if (tree) errors.push(...engineGaps(runes, tree));
  const root = tree?.roots[0];
  if (errors.length > 0 || !parsed.ok || !tree || !root) {
    return { ok: false, errors: errors.length > 0 ? errors : [error('EMPTY', -1, 'The spell has no runes.')], force };
  }
  const notes: string[] = [];
  const program = buildNode(root, ctx, notes);
  const persistent = isPersistentShape(root.shape);
  return {
    ok: true,
    tree,
    program,
    force: persistent ? 0 : force,
    spirit: persistent ? runeSpirit(runes, ctx.spiritMultiplier) : 0,
    persistent,
    peakEntities: parsed.stats.peakEntities,
    notes: [...new Set(notes)],
  };
}

/** The wand stats a sigil's affixes give the compiler. */
export function sigilCompileContext(item: SigilItem, classId: ClassId): SigilCompileContext {
  const a = item.affixes;
  return {
    classId,
    slots: sigilCapacity(item),
    multicast: DEFAULT_CONTEXT.multicast + affixValue(a, 'multicast'),
    maxDepth: DEFAULT_CONTEXT.maxDepth + affixValue(a, 'max_depth'),
    forceMultiplier: HEAT.costMultiplier * (1 - affixValue(a, 'heat_reduced') / 100),
    spiritMultiplier: 1 - affixValue(a, 'spirit_reduced') / 100,
    damageMultiplier: 1 + affixValue(a, 'damage_increased') / 100,
    areaMultiplier: 1 + affixValue(a, 'area_increased') / 100,
    splitEfficiencyBonus: affixValue(a, 'split_efficiency'),
    firstRuneFree: hasAffix(a, 'first_rune_free'),
  };
}

export function compileSigilItem(item: SigilItem, classId: ClassId): SigilCompile {
  return compileRunes(item.slots.map(toRuneInstance), sigilCompileContext(item, classId));
}
