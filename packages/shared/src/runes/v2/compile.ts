import { HEAT, SPELL } from '../../config/sim.js';
import { CLASSES, type ClassId } from '../../data/classes.js';
import { affixValue, hasAffix, sigilCapacity, toRuneInstance, type SigilItem } from '../../items/items.js';
import { NEUTRAL_TUNING, type ElementId, type FormId, type ReleaseTrigger, type SpellNode as EngineNode, type SpellProgram } from '../../sim/program.js';
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
 * Listed Force per rune, before payload depth, affinity and the sigil. The v1 numbers carried over,
 * except the trigger runes, which dropped from 4 (Pulse 6) to 2 (3) so the v1 payload skills keep
 * their hand-set prices; Orb and the phase 4 runes are new. Split is priced per copy (2 per copy,
 * so a Split of 3 costs the old 6). A release affix costs what its trigger rune would, so the affix
 * saves a slot, not Force.
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
  onhit: 2,
  onexpire: 2,
  timer: 2,
  pulse: 3,
  onland: 2,
  swift: 3,
  large: 3,
};
const SPLIT_FORCE_PER_COPY = 2;
const RELEASE_FORCE: Record<ReleaseKind, number> = { onhit: 2, onexpire: 2, after: 2, every: 3, onland: 2, onrelease: 2 };

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

const FORM_FOR_SHAPE: Partial<Record<ShapeId, FormId>> = { orb: 'orb', bolt: 'bolt', nova: 'nova', zone: 'zone', dash: 'dash', aura: 'aura', bond: 'bond' };

const TRIGGER_FOR_RELEASE: Partial<Record<ReleaseKind, ReleaseTrigger>> = { onhit: 'onhit', onexpire: 'onexpire', after: 'after', every: 'every', onland: 'onland' };

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

/** Plain-rune steps a signed roll is worth (HEAT.affixStepForce), a refund share when negative. */
function steps(value: number, step: number): number {
  const up = Math.log(1 + Math.abs(value) / 100) / Math.log(step);
  return value >= 0 ? up : -HEAT.affixRefundShare * up;
}

/**
 * Force of a shape's number affixes, before depth. Speed and size are priced at the affinity of the
 * plain rune they stand for (Swift, Large), everything else at the shape's own.
 */
function affixForce(rune: RuneInstance, affinity: (id: RuneId) => number): number {
  const a = rune.affixes;
  const st = SPELL.affixSteps;
  const own = affinity(rune.id);
  let force = 0;
  if (a.speed !== undefined) force += steps(a.speed, rune.id === 'dash' ? st.dashSpeed : st.speed) * affinity('swift');
  if (a.size !== undefined) force += steps(a.size, st.size) * affinity('large');
  if (a.duration !== undefined) force += steps(a.duration, st.duration) * own;
  if (a.damage !== undefined) force += steps(a.damage, st.damage) * own;
  if (a.pierce !== undefined && a.pierce > 0) force += (Math.log(1 + a.pierce / st.pierce) / Math.LN2) * own;
  return force * HEAT.affixStepForce;
}

/**
 * Force for one cast:
 *   (rune cost x affinity + affix cost) x payload share, summed, x the sigil's forceMultiplier
 * A shape's cost includes its release affix; a Split costs 2 per copy and is never discounted;
 * affinity is HEAT.affinityMultiplier for the class's affinity runes and HEAT.offAffinityMultiplier
 * otherwise; the payload share is HEAT.payloadForceFactor for anything below the cast; affix costs
 * are `affixForce`, and a rune never costs less than nothing. The first rune is free on a sigil that
 * rolled it. `forceMultiplier` is HEAT.costMultiplier and the sigil's Force cost affix. Rounded to 0.1.
 */
export function runeForce(runes: readonly RuneInstance[], tree: SpellTree | null, ctx: SigilCompileContext): number {
  const affinitySet = new Set<string>(CLASSES[ctx.classId].affinityRunes);
  const affinity = (id: RuneId): number => (affinitySet.has(id) ? HEAT.affinityMultiplier : HEAT.offAffinityMultiplier);
  const depths = runeDepths(runes, tree);
  let force = 0;
  runes.forEach((rune, i) => {
    if (i === 0 && ctx.firstRuneFree) return;
    let cost = rune.id === 'split' ? SPLIT_FORCE_PER_COPY * (rune.affixes.count ?? DEFAULTS.splitCount) : RUNE_FORCE[rune.id];
    if (rune.affixes.release) cost += RELEASE_FORCE[rune.affixes.release.kind];
    const share = (depths[i] ?? 0) > 0 && rune.id !== 'split' ? HEAT.payloadForceFactor : 1;
    force += Math.max(0, cost * affinity(rune.id) + affixForce(rune, affinity)) * share;
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
  const visit = (node: SpellNode): void => {
    const name = `${runeName(node.shape)} (rune ${node.runeIndex + 1})`;
    if (node.stats.homing > 0) out.push(error('ENGINE_NOT_READY', node.runeIndex, `${name} homes; homing does not run in the engine yet.`));
    if (node.stats.bounce > 0) out.push(error('ENGINE_NOT_READY', node.runeIndex, `${name} bounces; bouncing does not run in the engine yet.`));
    const release = node.release;
    if (release && node.payload.length > 0 && !TRIGGER_FOR_RELEASE[release.kind]) {
      out.push(error('ENGINE_NOT_READY', release.runeIndex, `${name} releases on release; holding a cast does not run in the engine yet.`));
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
  const attached = new Set<RuneId>([...elements, ...node.effects]);
  const combos = COMBOS.filter((c) => attached.has(c.runes[0]) && attached.has(c.runes[1])).map((c) => c.id);
  const trigger = node.release ? TRIGGER_FOR_RELEASE[node.release.kind] : undefined;
  // An orb rolls through everything unless it bursts on hit: that is what makes it an orb.
  const phase = form === 'orb' && trigger !== 'onhit';
  if (phase && node.stats.pierce > 0) notes.push(`${runeName(node.shape)} (rune ${node.runeIndex + 1}) already rolls through every enemy, so its pierce does nothing.`);
  const payload = trigger ? node.payload.map((child) => buildNode(child, ctx, notes)) : [];
  return {
    form,
    elements,
    effects: [...node.effects],
    copies: node.copies,
    pierce: node.stats.pierce,
    release: trigger && node.release ? { kind: trigger, seconds: node.release.seconds } : null,
    payload,
    depth: node.depth,
    combos,
    damageScale: ctx.damageMultiplier * splitScale * stackBonus,
    areaScale: ctx.areaMultiplier,
    tuning: {
      ...NEUTRAL_TUNING,
      speed: pct(node.stats.speed),
      radius: pct(node.stats.size),
      range: pct(node.stats.duration),
      damage: pct(node.stats.damage),
      phase: phase ? 1 : 0,
    },
  };
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
  const roots = tree.roots.map((r) => buildNode(r, ctx, notes));
  const program: SpellProgram = { roots, form: roots[0]?.form ?? 'bolt' };
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
