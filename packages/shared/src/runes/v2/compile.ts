import { HEAT, SPELL } from '../../config/sim.js';
import { CLASSES, type ClassId } from '../../data/classes.js';
import { affixValue, sigilCapacity, toRuneInstance, type SigilItem } from '../../items/items.js';
import { affixMultiplier, NEUTRAL_TUNING, releaseCount, type EffectId, type ElementId, type PerCastRolls, type ReleaseTrigger, type SpellNode as EngineNode, type SpellProgram } from '../../sim/program.js';
import { hasAdded, noAdded, rangeMean, shapeBaseRange, shapeDamage, type AddedDamage, type ShapeDamage } from '../../sim/damage.js';
import { engineForm, lifetime } from './budget.js';
import { implicitOf, parseSpell, type SpellNode, type SpellTree } from './parse.js';
import { DEFAULT_CONTEXT, RULES, type GrammarError, type RuleKey } from './rules.js';
import {
  ADDED_DAMAGE_SPREAD,
  ADDED_KEYS,
  COMBOS,
  CONCENTRATED,
  INFUSION_IDS,
  DEFAULTS,
  isCastableRune,
  isPersistentShape,
  isShapeId,
  runeKind,
  runeName,
  type ReleaseKind,
  type RuneId,
  type RuneInstance,
  type RuneKind,
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
  concentrated: 5,
};

/**
 * The trigger rune each release affix stands for, so the affix costs what that rune costs and
 * follows a live change of its price. Release on release has no rune of its own yet; it is priced
 * like On Hit.
 */
const RELEASE_RUNE: Record<ReleaseKind, TriggerId> = { onhit: 'onhit', onexpire: 'onexpire', after: 'timer', every: 'pulse', onland: 'onland', onrelease: 'onhit' };

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
  /** The least Concentrated reserves; it reserves RUNE_PRICE.concentratedSpiritShare of the rest when that is more. */
  concentrated: 10,
};

export const RUNE_PRICE = {
  /** Split's Force per copy it makes, so a Split of 3 costs the old 6. */
  splitForcePerCopy: 2,
  /**
   * Concentrated multiplies every element on an aura, so a flat price let a three-element aura reach
   * 1.31x the damage per spirit. As a share of the rest of the aura it costs the same per damage for
   * any mix: a 60% roll gives 1.6 / 1.35, at most 1.19x the damage per spirit.
   */
  concentratedSpiritShare: 0.35,
} as const;

/**
 * Runes that only change the shape they sit on. On a payload they pay HEAT.payloadAffixShare like a
 * number affix does, so a plain Large costs what +50% size does and an element costs what it adds.
 */
const RIDER_KINDS: ReadonlySet<RuneKind> = new Set<RuneKind>(['infusion', 'effect', 'modifier']);

const TRIGGER_FOR_RELEASE: Partial<Record<ReleaseKind, ReleaseTrigger>> = { onhit: 'onhit', onexpire: 'onexpire', after: 'after', every: 'every', onland: 'onland' };

const round1 = (n: number): number => Math.round(n * 10) / 10;

function error(rule: RuleKey, runeIndex: number, message: string): GrammarError {
  return { rule: RULES[rule].id, runeIndex, message };
}

/**
 * The shape every rune attaches to: a shape itself, a shaper or release where the grammar put it (a
 * pending Split goes to its payload), anything else to the nearest shape on its left.
 */
function runeNodes(runes: readonly RuneInstance[], tree: SpellTree | null): (SpellNode | undefined)[] {
  const byIndex = new Map<number, SpellNode>();
  const shapes = new Map<number, SpellNode>();
  const visit = (node: SpellNode): void => {
    byIndex.set(node.runeIndex, node);
    shapes.set(node.runeIndex, node);
    for (const s of node.shapers) byIndex.set(s.runeIndex, node);
    if (node.release) byIndex.set(node.release.runeIndex, node);
    for (const child of node.payload) visit(child);
  };
  for (const root of tree?.roots ?? []) visit(root);
  let last: SpellNode | undefined;
  return runes.map((_, i) => {
    const shape = shapes.get(i);
    if (shape) last = shape;
    return byIndex.get(i) ?? last;
  });
}

/** A Split's copies: the fewest a cast rolls (what the engine node is built at), or their average (what Force prices). */
function splitCopies(s: { value: number; max: number }, at: 'min' | 'average'): number {
  return at === 'min' ? s.value : (s.value + s.max) / 2;
}

/** A node's copies at the fewest or on average over its ranged Splits. */
function nodeCopies(node: SpellNode, at: 'min' | 'average'): number {
  if (at === 'min') return node.copies;
  return node.shapers.reduce((n, s) => (s.id === 'split' ? n * splitCopies(s, at) : n), 1);
}

/** A node's pierce at its least or on average over a ranged roll. */
function nodePierce(node: SpellNode, at: 'min' | 'average'): number {
  return at === 'min' ? node.stats.pierce : (node.stats.pierce + node.stats.pierceMax) / 2;
}

/** Damage multiplier of a node from its Splits (each conserves damage on its own, as v1 did) and doubled infusions. */
function nodeScale(node: SpellNode, splitEfficiencyBonus: number, at: 'min' | 'average' = 'min'): number {
  const efficiency = SPELL.splitEfficiency + splitEfficiencyBonus;
  let scale = 1;
  for (const s of node.shapers) if (s.id === 'split') scale *= efficiency / splitCopies(s, at);
  const extra = node.effectiveInfusions.length - new Set(node.effectiveInfusions).size;
  return scale * (1 + extra * SPELL.stackedInfusionBonus);
}

/**
 * Damage-only multiplier of a node: its damage roll and Concentrated. Heals, shields and the strength
 * of Ward and Restore auras leave it out; at damageScale a Concentrated Ward aura, with Large to win
 * back the area, gave a party 51% damage reduction.
 */
function damageTuning(node: SpellNode, at: 'min' | 'average' = 'min'): number {
  const damage = at === 'min' ? node.stats.damage : (node.stats.damage + node.stats.damageMax) / 2;
  return affixMultiplier(damage) * (1 + node.stats.concentration / 100);
}

function isProjectileShape(node: SpellNode): boolean {
  return node.shape === 'bolt' || node.shape === 'orb';
}

/** How many times one copy of a parse node releases its payload on average, by the engine's lifetimes. */
function nodeReleases(node: SpellNode): number {
  const r = node.release;
  if (!r || node.payload.length === 0) return 0;
  const trigger = TRIGGER_FOR_RELEASE[r.kind];
  const form = engineForm(node.shape) ?? 'bolt';
  return releaseCount(form, { kind: trigger ?? 'onexpire', seconds: r.seconds }, lifetime(node), nodePierce(node, 'average'));
}

/** A trigger rune's implicit: how hard the payload it releases hits, 1 for a release affix. */
function payloadDamage(node: SpellNode): number {
  return (node.release?.quality ?? 100) / 100;
}

/**
 * What one release of a payload node can land, as a share of one plain copy of its shape: its
 * copies at their conserved damage and its damage affix. Projectile copies released on an interval
 * spray a full ring. From a flying parent (Frozen Orb) the ring's centre sweeps past a target, so it
 * faces about one fan gap of it (splitSpreadRadians of the circle per copy). From a parent that
 * stays put (a Zone on the pack) the ring starts inside the target and every copy lands.
 */
function releaseWeight(node: SpellNode, parent: SpellNode, splitEfficiencyBonus: number): number {
  const copies = nodeCopies(node, 'average');
  const ringed = parent.release?.kind === 'every' && copies > 1 && isProjectileShape(node) && isProjectileShape(parent);
  const aimed = ringed ? (copies * SPELL.splitSpreadRadians) / (2 * Math.PI) : copies;
  return nodeScale(node, splitEfficiencyBonus, 'average') * damageTuning(node, 'average') * payloadDamage(parent) * aimed;
}

/**
 * The share of its listed Force each rune on a shape pays. The cast pays in full. A payload pays
 * HEAT.payloadForceFactor for its first spawn, since it only goes off when the cast lands, and for
 * every further spawn its full price weighted by `releaseWeight`: an interval release, a piercing
 * on-hit shape or a split parent spawns its payload many times per cast, and each spawn is damage the
 * cast did not pay for otherwise. Spawns from a flying parent pay HEAT.payloadRepeatShare of that,
 * since it carries them along and past the target; a parent that stays put (a Zone, a Nova) drops
 * every one of them on the same spot.
 */
function nodeShares(tree: SpellTree | null, ctx: SigilCompileContext): Map<SpellNode, number> {
  const shares = new Map<SpellNode, number>();
  const visit = (node: SpellNode, spawns: number): void => {
    const perRelease = spawns * nodeCopies(node, 'average') * nodeReleases(node);
    const repeatShare = isProjectileShape(node) ? HEAT.payloadRepeatShare : 1;
    for (const child of node.payload) {
      const extra = Math.max(0, perRelease - 1) * repeatShare * releaseWeight(child, node, ctx.splitEfficiencyBonus);
      shares.set(child, HEAT.payloadForceFactor + extra);
      visit(child, perRelease);
    }
  };
  for (const root of tree?.roots ?? []) {
    shares.set(root, 1);
    visit(root, 1);
  }
  return shares;
}

/** Plain-rune steps a signed roll is worth (HEAT.affixStepForce), a refund share when negative. */
function steps(value: number, step: number): number {
  const up = Math.log(1 + Math.abs(value) / 100) / Math.log(step);
  return value >= 0 ? up : -HEAT.affixRefundShare * up;
}

/** An "Adds X to Y" roll as the damage percent it equals on its shape's base hit (a phase 4 shape prices as a Bolt). */
export function addedPercent(rune: RuneInstance, low: number): number {
  const base = shapeBaseRange((isShapeId(rune.id) ? engineForm(rune.id) : null) ?? 'bolt');
  const mean = base ? rangeMean(base) : 0;
  const average = (low * (1 + ADDED_DAMAGE_SPREAD)) / 2;
  return mean > 0 ? (100 * average) / mean : 0;
}

/** The engine's added damage from the parse node's low ends. */
function addedDamage(node: SpellNode): AddedDamage {
  const out = noAdded();
  for (const el of INFUSION_IDS) {
    const low = node.stats.added[el];
    if (low > 0) out[el] = { min: low, max: low * ADDED_DAMAGE_SPREAD };
  }
  return out;
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
  // Ranged rolls are priced at their average (docs/features/runes.md, "Ranged rolls").
  const damage = a.damage === undefined ? undefined : (a.damage + Math.max(a.damage, a.damageMax ?? a.damage)) / 2;
  const pierce = a.pierce === undefined ? undefined : (a.pierce + Math.max(a.pierce, a.pierceMax ?? a.pierce)) / 2;
  if (a.speed !== undefined) force += steps(a.speed, rune.id === 'dash' ? st.dashSpeed : st.speed) * affinity('swift');
  if (a.size !== undefined) force += steps(a.size, st.size) * affinity('large');
  if (a.duration !== undefined) force += steps(a.duration, st.duration) * own;
  if (damage !== undefined) force += steps(damage, st.damage) * own;
  if (pierce !== undefined && pierce > 0) force += (Math.log(1 + pierce / st.pierce) / Math.LN2) * own;
  // Concentrated's damage is priced like a damage roll of the same size, on top of its base cost.
  // Its area loss gives nothing back: on a Bolt or a lone target it costs the spell almost nothing.
  if (rune.id === 'concentrated') force += steps(a.concentration ?? CONCENTRATED.defaultMore, st.damage) * own;
  return force * HEAT.affixStepForce;
}

/**
 * Force of a shape's "Adds" rolls, before depth: each pays a step (HEAT.affixStepForce) per
 * SPELL.affixSteps.added multiple of its shape's average base hit, on a log scale like a damage roll.
 */
/**
 * Force of a rune's implicit above or below the neutral roll, before depth (docs/features/runes.md,
 * "Implicits"). A shape's base damage, an infusion's conversion (its share of the base), an
 * effect's strength and a trigger's payload damage price like a damage roll of the same size, on
 * the same log scale (a weaker roll refunds half, as a drawback does). Swift and Large cost their
 * listed Force times the roll, as they give that much of their effect. A Timer's fuse and
 * Concentrated's focus cost nothing; a Pulse's rate prices itself through the releases it adds, and
 * a Split's extra copies through its price per copy. Persistent shapes price spirit, not Force.
 */
function implicitForce(rune: RuneInstance, node: SpellNode | undefined, affinity: (id: RuneId) => number): number {
  const q = implicitOf(rune);
  if (rune.implicit === undefined || q === 100) return 0;
  const own = affinity(rune.id);
  const asDamage = steps(q - 100, SPELL.affixSteps.damage) * own * HEAT.affixStepForce;
  switch (runeKind(rune.id)) {
    case 'shape':
      return isPersistentShape(isShapeId(rune.id) ? rune.id : 'orb') ? 0 : asDamage;
    case 'infusion':
      return asDamage / Math.max(1, new Set(node?.effectiveInfusions ?? []).size);
    case 'effect':
      return asDamage;
    case 'trigger':
      return rune.id === 'onhit' || rune.id === 'onexpire' || rune.id === 'onland' ? asDamage : 0;
    case 'modifier':
      return rune.id === 'swift' || rune.id === 'large' ? (RUNE_FORCE[rune.id] * (q - 100) * own) / 100 : 0;
    case 'shaper':
      return 0;
  }
}

function addedForce(rune: RuneInstance, affinity: (id: RuneId) => number): number {
  let force = 0;
  for (const el of INFUSION_IDS) {
    const low = rune.affixes[ADDED_KEYS[el]];
    if (low !== undefined && low > 0) force += steps(addedPercent(rune, low), SPELL.affixSteps.added);
  }
  return force * affinity(rune.id) * HEAT.affixStepForce;
}

/**
 * Force for one cast:
 *   (rune cost x affinity x its share + affix cost x affix share), summed per rune, x forceMultiplier
 * A shape's cost includes its release affix; a Split costs 2 per copy and is never discounted;
 * affinity is HEAT.affinityMultiplier for the class's affinity runes and HEAT.offAffinityMultiplier
 * otherwise; shares are `nodeShares` (1 for the cast, less for a payload that goes off once, more for
 * one that goes off many times). Affix costs are `affixForce`. On a payload, affixes and rider runes
 * (RIDER_KINDS) pay at least HEAT.payloadAffixShare: they make the payload as much stronger as they
 * would the cast whenever it lands, and at the payload's base share they were near free. A rune never costs
 * less than nothing. `forceMultiplier` is
 * HEAT.costMultiplier and the sigil's Force cost affix. At least HEAT.minForcePerCast, rounded to 0.1.
 */
export function runeForce(runes: readonly RuneInstance[], tree: SpellTree | null, ctx: SigilCompileContext): number {
  const affinitySet = new Set<string>(CLASSES[ctx.classId].affinityRunes);
  const affinity = (id: RuneId): number => (affinitySet.has(id) ? HEAT.affinityMultiplier : HEAT.offAffinityMultiplier);
  const nodes = runeNodes(runes, tree);
  const shares = nodeShares(tree, ctx);
  let force = 0;
  runes.forEach((rune, i) => {
    const node = nodes[i];
    // A Split pays per copy it makes on average: a ranged count and its implicit extra copies included.
    const split = node?.shapers.find((s) => s.runeIndex === i && s.id === 'split');
    const copies = split ? splitCopies(split, 'average') : (rune.affixes.count ?? DEFAULTS.splitCount);
    let cost = rune.id === 'split' ? RUNE_PRICE.splitForcePerCopy * copies : RUNE_FORCE[rune.id];
    if (rune.affixes.release) cost += RUNE_FORCE[RELEASE_RUNE[rune.affixes.release.kind]];
    const share = rune.id === 'split' || !node ? 1 : (shares.get(node) ?? 1);
    const affixes = affixForce(rune, affinity);
    const raised = Math.max(share, HEAT.payloadAffixShare);
    // An implicit pays where it acts (a trigger's payload damage at its payload's share), and a gain
    // on a payload at least its full price, like added damage: implicits multiply everything else on
    // the shape, and at the riders' half every rune of the worst payload chain at T1 reached 4.7x the
    // best kit's damage per Force (4.5x at the full price).
    const implicitAt = runeKind(rune.id) === 'trigger' && node?.payload[0] ? (shares.get(node.payload[0]) ?? 1) : share;
    const implicit = implicitForce(rune, node, affinity);
    const implicitShare = implicit > 0 ? Math.max(implicitAt, HEAT.payloadAddedShare) : implicitAt;
    // Added damage on a payload pays at least HEAT.payloadAddedShare: at the riders' half it stacked
    // with Concentrated and doubled infusions to about 4x the best kit's damage per Force.
    const added = addedForce(rune, affinity) * Math.max(share, HEAT.payloadAddedShare);
    const baseShare = RIDER_KINDS.has(runeKind(rune.id)) ? raised : share;
    // Only gains pay the higher share; a drawback on a payload gives back at the payload's own share.
    const affixShare = affixes > 0 ? raised : share;
    force += Math.max(0, cost * affinity(rune.id) * baseShare + affixes * affixShare + implicit * implicitShare + added);
  });
  return Math.max(HEAT.minForcePerCast, round1(force * ctx.forceMultiplier));
}

/**
 * Spirit reserved: each rune's price, times its implicit for the runes whose implicit is a strength
 * (the aura's area, the bond's strength, an element's share, an effect's strength, Swift and Large),
 * so a stronger rune reserves as much more as it gives. Concentrated's share follows the rest.
 */
function runeSpirit(runes: readonly RuneInstance[], mult: number): number {
  let rest = 0;
  let concentrated = 0;
  for (const r of runes) {
    if (r.id === 'concentrated') concentrated++;
    else rest += (RUNE_SPIRIT[r.id] ?? 0) * (r.id === 'split' ? 1 : implicitOf(r) / 100);
  }
  const each = Math.max(RUNE_SPIRIT.concentrated ?? 0, rest * RUNE_PRICE.concentratedSpiritShare);
  return Math.round((rest + concentrated * each) * mult);
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

/** Each element's conversion from its infusions' implicits, averaged where an element is doubled; neutral elements are left out. */
function nodeConversion(node: SpellNode): Partial<Record<ElementId, number>> {
  const out: Partial<Record<ElementId, number>> = {};
  for (const el of new Set(node.effectiveInfusions)) {
    const q = node.effectiveInfusions.flatMap((e, i) => (e === el ? [node.effectiveQuality[i] ?? 100] : []));
    const k = q.reduce((a, b) => a + b, 0) / Math.max(1, q.length) / 100;
    if (k !== 1) out[el] = k;
  }
  return out;
}

function nodeEffectPower(node: SpellNode): Partial<Record<EffectId, number>> {
  const out: Partial<Record<EffectId, number>> = {};
  for (const e of node.effects) {
    const q = node.effectQuality[e] ?? 100;
    if (q !== 100) out[e] = q / 100;
  }
  return out;
}

/** The ranged rolls a cast of this node rolls, or null when every number is fixed. */
function perCastRolls(node: SpellNode): PerCastRolls | null {
  const splits = node.shapers.filter((s) => s.id === 'split' && s.max > s.value).map((s) => ({ min: s.value, max: s.max }));
  const damage = node.stats.damageMax > node.stats.damage ? { min: node.stats.damage, max: node.stats.damageMax } : undefined;
  const pierce = node.stats.pierceMax > node.stats.pierce ? { min: node.stats.pierce, max: node.stats.pierceMax } : undefined;
  if (splits.length === 0 && !damage && !pierce) return null;
  return { splits, ...(damage ? { damage } : {}), ...(pierce ? { pierce } : {}) };
}

function buildNode(node: SpellNode, ctx: SigilCompileContext, notes: string[], payloadScale = 1): EngineNode {
  const form = engineForm(node.shape) ?? 'bolt';
  const elements = [...new Set(node.effectiveInfusions)];
  const attached = new Set<RuneId>([...elements, ...node.effects]);
  const combos = COMBOS.filter((c) => attached.has(c.runes[0]) && attached.has(c.runes[1])).map((c) => c.id);
  const trigger = node.release ? TRIGGER_FOR_RELEASE[node.release.kind] : undefined;
  // An orb rolls through everything unless it bursts on hit: that is what makes it an orb.
  const phase = form === 'orb' && trigger !== 'onhit';
  if (phase && node.stats.pierce > 0) notes.push(`${runeName(node.shape)} (rune ${node.runeIndex + 1}) already rolls through every enemy, so its pierce does nothing.`);
  // Same test as the engine's isOffensive; an aura only damages through its elements.
  const damages = elements.length > 0 || (form !== 'aura' && (node.effects.includes('impact') || (!node.effects.includes('restore') && !node.effects.includes('ward'))));
  if (node.concentratedAt !== null && !damages) {
    notes.push(`Concentrated (rune ${node.concentratedAt + 1}) only adds damage, and ${runeName(node.shape)} (rune ${node.runeIndex + 1}) deals none: it only shrinks it.`);
  }
  const added = addedDamage(node);
  if (hasAdded(added) && !damages) {
    notes.push(`${runeName(node.shape)} (rune ${node.runeIndex + 1}) deals no damage, so its added damage does nothing.`);
  }
  const payload = trigger ? node.payload.map((child) => buildNode(child, ctx, notes, payloadDamage(node))) : [];
  // The shape rune's implicit: an aura's area, a bond's strength, every other shape's base damage.
  const quality = node.stats.base / 100;
  const conversion = nodeConversion(node);
  const power = nodeEffectPower(node);
  const perCast = perCastRolls(node);
  return {
    form,
    elements,
    added,
    effects: [...node.effects],
    copies: node.copies,
    pierce: node.stats.pierce,
    release: trigger && node.release ? { kind: trigger, seconds: node.release.seconds } : null,
    payload,
    depth: node.depth,
    combos,
    damageScale: ctx.damageMultiplier * nodeScale(node, ctx.splitEfficiencyBonus) * (form === 'bond' ? quality : 1),
    areaScale: ctx.areaMultiplier,
    tuning: {
      ...NEUTRAL_TUNING,
      speed: affixMultiplier(node.stats.speed),
      radius: affixMultiplier(node.stats.size) * (form === 'aura' ? quality : 1),
      range: affixMultiplier(node.stats.duration),
      damage: damageTuning(node) * payloadScale,
      phase: phase ? 1 : 0,
    },
    ...(form !== 'aura' && form !== 'bond' && quality !== 1 ? { baseScale: quality } : {}),
    ...(Object.keys(conversion).length > 0 ? { conversion } : {}),
    ...(Object.keys(power).length > 0 ? { effectPower: power } : {}),
    ...(perCast ? { perCast } : {}),
  };
}

/**
 * What one shape of a parsed spell deals on a plain sigil (no sigil affixes), for the sentence: its
 * rolls, Splits, doubled infusions and Frostfire, as the engine would run it. Null when it deals none
 * or is not in the engine yet.
 */
export function parsedShapeDamage(node: SpellNode): ShapeDamage | null {
  if (!engineForm(node.shape)) return null;
  return shapeDamage({ ...buildNode(node, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage' }, []), payload: [] });
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
  };
}

export function compileSigilItem(item: SigilItem, classId: ClassId): SigilCompile {
  // Every sigil casts the rolls its runes store, as stored: rolls beyond the drop tables (old kit
  // sigils) keep them inside the sigil and clamp only on the way out (items/runeRolls.ts).
  return compileRunes(item.slots.map(toRuneInstance), sigilCompileContext(item, classId));
}
