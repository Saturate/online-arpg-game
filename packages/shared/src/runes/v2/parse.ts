import { measureBudget } from './budget.js';
import {
  AFFIX_KEYS,
  affixesFor,
  DEFAULT_PULSE_SECONDS,
  DEFAULT_TIMER_SECONDS,
  DEFAULTS,
  isPersistentShape,
  isShapeId,
  PLAIN_MODIFIER_EFFECT,
  PROJECTILE_SHAPES,
  TRIGGERS_FOR_SHAPE,
  runeKind,
  runeName,
  SHAPERS_FOR_SHAPE,
  SHAPES,
  TRIGGER_RELEASE,
  type AffixKey,
  type EffectId,
  type InfusionId,
  type Release,
  type RuneInstance,
  type ShaperId,
  type ShapeId,
} from './runes.js';
import {
  DEFAULT_CONTEXT,
  MIN_RELEASE_SECONDS,
  RULES,
  MAX_COPIES,
  SPLIT_COUNT_RANGE,
  type GrammarContext,
  type GrammarError,
  type RuleKey,
} from './rules.js';

export interface ShaperUse {
  id: ShaperId;
  runeIndex: number;
  /** Split: copies. Chain/Bounce: count. Homing: strength. Stack: limit. Charge: stages. Link/Orbit: 1. */
  value: number;
}

export interface NodeRelease extends Release {
  runeIndex: number;
  source: 'affix' | 'rune';
}

export interface NodeStats {
  speed: number;
  size: number;
  duration: number;
  damage: number;
  pierce: number;
  bounce: number;
  homing: number;
}

export interface SpellNode {
  runeIndex: number;
  shape: ShapeId;
  /** 0 for the cast; each payload level adds one. */
  depth: number;
  /** Infusions written on this shape. */
  infusions: InfusionId[];
  /** Infusions it actually carries: its own, or the parent's when it has none. */
  effectiveInfusions: InfusionId[];
  effects: EffectId[];
  shapers: ShaperUse[];
  stats: NodeStats;
  /** Copies after Split (1 when unsplit). */
  copies: number;
  linked: boolean;
  release: NodeRelease | null;
  /** Shapes spawned when this one releases; cast together with each other. */
  payload: SpellNode[];
  /** True when this shape is cast alongside the previous shape in its group. */
  castTogether: boolean;
}

export interface SpellTree {
  /** Shapes cast together when the spell is cast. */
  roots: SpellNode[];
}

export interface SpellStats {
  depth: number;
  peakEntities: number;
  /** Every entity the cast ever spawns; shown next to the peak to make the difference visible. */
  lifetimeEntities: number;
  shapes: number;
  persistent: boolean;
}

export interface ParseResult {
  ok: boolean;
  tree: SpellTree | null;
  errors: GrammarError[];
  stats: SpellStats;
}

const AFFIX_KEY_LOOKUP: ReadonlyMap<string, AffixKey> = new Map(AFFIX_KEYS.map((k) => [k, k]));

const EMPTY_STATS: SpellStats = { depth: 0, peakEntities: 0, lifetimeEntities: 0, shapes: 0, persistent: false };

function newNode(runeIndex: number, shape: ShapeId, depth: number): SpellNode {
  return {
    runeIndex,
    shape,
    depth,
    infusions: [],
    effectiveInfusions: [],
    effects: [],
    shapers: [],
    stats: { speed: 0, size: 0, duration: 0, damage: 0, pierce: 0, bounce: 0, homing: 0 },
    copies: 1,
    linked: false,
    release: null,
    payload: [],
    castTogether: false,
  };
}

function releaseKindLabel(kind: Release['kind']): string {
  if (kind === 'after') return 'after X s';
  if (kind === 'every') return 'every X s';
  return releaseLabel({ kind, seconds: 0 });
}

const awaitingPayload = (node: SpellNode): boolean => node.release !== null && node.payload.length === 0;

function releaseLabel(r: Release): string {
  switch (r.kind) {
    case 'onhit':
      return 'on hit';
    case 'onexpire':
      return 'on expire';
    case 'onland':
      return 'on landing';
    case 'onrelease':
      return 'on release';
    case 'after':
      return `after ${r.seconds} s`;
    case 'every':
      return `every ${r.seconds} s`;
  }
}

function shaperValue(rune: RuneInstance, id: ShaperId): number {
  const a = rune.affixes;
  switch (id) {
    case 'split':
      return a.count ?? DEFAULTS.splitCount;
    case 'chain':
      return a.chain ?? DEFAULTS.chainCount;
    case 'bounce':
      return a.bounce ?? DEFAULTS.bounceCount;
    case 'homing':
      return a.homing ?? DEFAULTS.homingStrength;
    case 'stack':
      return a.stackLimit ?? DEFAULTS.stackLimit;
    case 'charge':
      return a.chargeStages ?? DEFAULTS.chargeStages;
    case 'link':
    case 'orbit':
      return 1;
  }
}

/** Parses a rune list left to right into a spell tree, collecting every rule it breaks. */
export function parseSpell(runes: readonly RuneInstance[], context: Partial<GrammarContext> = {}): ParseResult {
  const ctx: GrammarContext = { ...DEFAULT_CONTEXT, ...context };
  const errors: GrammarError[] = [];
  const fail = (rule: RuleKey, runeIndex: number, message: string): void => {
    errors.push({ rule: RULES[rule].id, runeIndex, message });
  };
  const label = (i: number): string => {
    const r = runes[i];
    return r ? `${runeName(r.id)} (rune ${i + 1})` : `rune ${i + 1}`;
  };

  if (runes.length === 0) {
    fail('EMPTY', -1, 'The spell has no runes.');
    return { ok: false, tree: null, errors, stats: EMPTY_STATS };
  }

  const roots: SpellNode[] = [];
  const all: SpellNode[] = [];
  let group: SpellNode[] = roots;
  let current: SpellNode | null = null;
  /** SPLIT_BEFORE_PAYLOAD: Split (and a Link right after it) waiting for the payload shape. */
  const pending: ShaperUse[] = [];

  const setRelease = (node: SpellNode, release: NodeRelease): void => {
    const shape = SHAPES[node.shape].name;
    const i = release.runeIndex;
    if (isPersistentShape(node.shape)) {
      fail('PERSISTENT_NO_RELEASE', i, `${shape} is persistent, so it cannot release a payload (${label(i)}).`);
    } else if (node.release) {
      fail(
        'ONE_RELEASE',
        i,
        `${shape} (rune ${node.runeIndex + 1}) already releases ${releaseLabel(node.release)}; ${label(i)} would add a second release.`,
      );
      return;
    } else if (!TRIGGERS_FOR_SHAPE[node.shape].includes(release.kind)) {
      const allowed = TRIGGERS_FOR_SHAPE[node.shape].map(releaseKindLabel);
      fail(
        'RELEASE_NOT_FOR_SHAPE',
        i,
        `${shape} cannot release ${releaseLabel(release)} (${label(i)}). ${shape} allows: ${allowed.join(', ') || 'nothing'}.`,
      );
    }
    if ((release.kind === 'every' || release.kind === 'after') && release.seconds < MIN_RELEASE_SECONDS) {
      fail('RELEASE_INTERVAL', i, `${label(i)} releases ${releaseLabel(release)}; the shortest allowed is ${MIN_RELEASE_SECONDS} s.`);
    }
    // Kept even when invalid so the rest of the spell still nests the way the player meant.
    node.release = release;
  };

  const addShaper = (node: SpellNode, use: ShaperUse): void => {
    const shape = SHAPES[node.shape].name;
    const i = use.runeIndex;
    const name = runeName(use.id);
    if (isPersistentShape(node.shape) && use.id === 'split') {
      fail('PERSISTENT_NO_SPLIT', i, `${shape} is persistent and cannot be split (${label(i)}).`);
      return;
    }
    if (isPersistentShape(node.shape) && use.id === 'charge') {
      fail('PERSISTENT_NO_CHARGE', i, `${shape} is persistent and cannot be charged (${label(i)}).`);
      return;
    }
    if (!SHAPERS_FOR_SHAPE[node.shape].includes(use.id)) {
      const allowed = SHAPERS_FOR_SHAPE[node.shape].map(runeName);
      fail(
        'SHAPER_NOT_FOR_SHAPE',
        i,
        `${name} does not work on ${shape} (${label(i)}). ${shape} takes: ${allowed.join(', ') || 'no shapers'}.`,
      );
      return;
    }
    if (use.id === 'charge' && node.depth > 0) {
      fail('CHARGE_ROOT_ONLY', i, `${label(i)} is on a payload ${shape}; only the cast itself can be held to charge.`);
      return;
    }
    const existing = node.shapers.find((s) => s.id === use.id);
    if (existing && use.id === 'split' && node.copies * use.value > MAX_COPIES) {
      fail('SPLIT_ONCE', i, `${label(i)} would make ${node.copies * use.value} copies of ${shape}; splits stop at ${MAX_COPIES}.`);
      return;
    }
    if (existing && (use.id === 'link' || use.id === 'orbit')) {
      fail('DUPLICATE_SHAPER', i, `${shape} already has ${name} (rune ${existing.runeIndex + 1}); ${label(i)} has nothing to add.`);
      return;
    }
    if (use.id === 'split' && (use.value < SPLIT_COUNT_RANGE.min || use.value > SPLIT_COUNT_RANGE.max)) {
      fail('SPLIT_COUNT', i, `${label(i)} asks for ${use.value} copies; Split makes ${SPLIT_COUNT_RANGE.min} to ${SPLIT_COUNT_RANGE.max}.`);
      return;
    }
    if (use.id === 'link' && !node.shapers.some((s) => s.id === 'split')) {
      fail(
        'LINK_NEEDS_SPLIT',
        i,
        `${label(i)} has no copies to join: ${shape} (rune ${node.runeIndex + 1}) has no Split before it. Link joins the copies of one shape, not shapes cast together.`,
      );
      return;
    }
    node.shapers.push(use);
    if (use.id === 'split') node.copies *= use.value;
    if (use.id === 'link') node.linked = true;
  };

  for (let i = 0; i < runes.length; i++) {
    const rune = runes[i];
    if (!rune) continue;
    const kind = runeKind(rune.id);
    const name = runeName(rune.id);

    const allowed = affixesFor(rune.id);
    for (const key of Object.keys(rune.affixes)) {
      const k = AFFIX_KEY_LOOKUP.get(key);
      if (k && !allowed.includes(k)) {
        const where = k === 'release' ? 'Release affixes only roll on shapes.' : `${name} rolls: ${allowed.join(', ') || 'no affixes'}.`;
        fail('AFFIX_NOT_ALLOWED', i, `${label(i)} cannot carry a ${k} affix. ${where}`);
      }
    }

    if (!current && kind !== 'shape') {
      if (i === 0) fail('FIRST_RUNE_SHAPE', 0, `The first rune must be a shape; ${label(0)} is ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}.`);
      continue;
    }

    if (isShapeId(rune.id)) {
      const shape: ShapeId = rune.id;
      let node: SpellNode;
      if (current && awaitingPayload(current)) {
        node = newNode(i, shape, current.depth + 1);
        current.payload.push(node);
        group = current.payload;
        if (node.depth > ctx.maxDepth) {
          fail('MAX_DEPTH', i, `${label(i)} sits ${node.depth} payload levels deep; the limit is ${ctx.maxDepth}.`);
        }
        if (shape === 'dash') fail('DASH_ROOT_ONLY', i, `${label(i)} is a payload, but Dash moves the caster and can only be cast directly.`);
      } else if (current) {
        node = newNode(i, shape, current.depth);
        node.castTogether = true;
        group.push(node);
        if (group.length > ctx.multicast) {
          const names = group.map((n) => SHAPES[n.shape].name).join(' + ');
          fail(
            'MULTICAST',
            i,
            `${label(i)} would be shape ${group.length} cast together (${names}), but multicast is ${ctx.multicast}. Put a trigger or release affix before it to make it a payload instead.`,
          );
        }
      } else {
        node = newNode(i, shape, 0);
        roots.push(node);
      }
      all.push(node);
      current = node;
      const a = rune.affixes;
      if (a.speed !== undefined) node.stats.speed += a.speed;
      if (a.size !== undefined) node.stats.size += a.size;
      if (a.duration !== undefined) node.stats.duration += a.duration;
      if (a.damage !== undefined) node.stats.damage += a.damage;
      if (a.pierce !== undefined) {
        if (PROJECTILE_SHAPES.includes(shape)) node.stats.pierce += a.pierce;
        else fail('AFFIX_NOT_ALLOWED', i, `${label(i)} does not fly, so it cannot pierce.`);
      }
      if (a.homing !== undefined) {
        if (SHAPERS_FOR_SHAPE[shape].includes('homing')) node.stats.homing += a.homing;
        else fail('AFFIX_NOT_ALLOWED', i, `${label(i)} cannot home; ${SHAPES[shape].name} does not take Homing.`);
      }
      if (a.bounce !== undefined) {
        if (SHAPERS_FOR_SHAPE[shape].includes('bounce')) node.stats.bounce += a.bounce;
        else fail('AFFIX_NOT_ALLOWED', i, `${label(i)} cannot bounce; ${SHAPES[shape].name} does not take Bounce.`);
      }
      for (const use of pending.splice(0)) addShaper(node, use);
      if (a.release) setRelease(node, { ...a.release, runeIndex: i, source: 'affix' });
      continue;
    }

    // Every non-shape rune from here on attaches to the nearest shape on its left.
    const target: SpellNode | null = current;
    if (!target) continue;

    switch (rune.id) {
      case 'fire':
      case 'cold':
      case 'lightning':
        // Doubled infusions stack for now (owner decision); each extra copy strengthens the element.
        target.infusions.push(rune.id);
        break;
      case 'impact':
      case 'ward':
      case 'restore':
        if (!target.effects.includes(rune.id)) target.effects.push(rune.id);
        break;
      case 'onhit':
      case 'onexpire':
      case 'onland':
      case 'timer':
      case 'pulse': {
        const kind = TRIGGER_RELEASE[rune.id];
        const fallback = rune.id === 'timer' ? DEFAULT_TIMER_SECONDS : rune.id === 'pulse' ? DEFAULT_PULSE_SECONDS : 0;
        setRelease(target, { kind, seconds: rune.affixes.seconds ?? fallback, runeIndex: i, source: 'rune' });
        break;
      }
      case 'swift':
      case 'large': {
        if (!ctx.plainModifierRunes) {
          fail(
            'PLAIN_MODIFIER_OFF',
            i,
            `${label(i)} is an affix now (write ${rune.id === 'swift' ? '[fast]' : '[large]'} on the shape), unless plain modifier runes are turned on.`,
          );
          break;
        }
        const effect = PLAIN_MODIFIER_EFFECT[rune.id];
        target.stats[effect.key] += effect.value;
        break;
      }
      case 'split':
      case 'link':
      case 'orbit':
      case 'homing':
      case 'bounce':
      case 'chain':
      case 'stack':
      case 'charge': {
        const use: ShaperUse = { id: rune.id, runeIndex: i, value: shaperValue(rune, rune.id) };
        const toPayload =
          awaitingPayload(target) && (use.id === 'split' || (use.id === 'link' && pending.some((p) => p.id === 'split')));
        if (toPayload) pending.push(use);
        else addShaper(target, use);
        break;
      }
      default:
        break;
    }
  }

  if (roots.length === 0) {
    return { ok: false, tree: null, errors, stats: EMPTY_STATS };
  }

  const finish = (node: SpellNode, inherited: InfusionId[]): void => {
    node.effectiveInfusions = node.infusions.length > 0 ? [...node.infusions] : [...inherited];
    const shape = SHAPES[node.shape].name;
    if (node.release && node.payload.length === 0) {
      const i = node.release.runeIndex;
      fail(
        'TRAILING_RELEASE',
        i,
        `${shape} (rune ${node.runeIndex + 1}) releases ${releaseLabel(node.release)} (${label(i)}), but no shape follows to be released.`,
      );
    }
    if (node.release?.kind === 'onrelease' && node.shape !== 'beam' && !node.shapers.some((s) => s.id === 'charge')) {
      fail(
        'ONRELEASE_NEEDS_HOLD',
        node.release.runeIndex,
        `${shape} releases on release, but nothing is held: add Charge to it, or use a Beam.`,
      );
    }
    for (const child of node.payload) finish(child, node.effectiveInfusions);
  };
  for (const root of roots) finish(root, []);

  const persistent = all.filter((n) => isPersistentShape(n.shape));
  if (persistent.length > 0 && all.length > 1) {
    const p = persistent[0];
    const other = all.find((n) => n !== p);
    if (p && other) {
      fail(
        'PERSISTENT_ALONE',
        p.runeIndex === 0 ? other.runeIndex : p.runeIndex,
        `${SHAPES[p.shape].name} (rune ${p.runeIndex + 1}) is persistent and must be the only shape, but ${SHAPES[other.shape].name} (rune ${other.runeIndex + 1}) is here too.`,
      );
    }
  }

  const tree: SpellTree = { roots };
  const budget = measureBudget(tree);
  if (budget.peak > ctx.liveCap) {
    fail(
      'ENTITY_CAP',
      -1,
      `At its peak this spell has ${budget.peak} entities alive at once; the limit is ${ctx.liveCap}.`,
    );
  }
  const stats: SpellStats = {
    depth: all.reduce((m, n) => Math.max(m, n.depth), 0),
    peakEntities: budget.peak,
    lifetimeEntities: budget.lifetime,
    shapes: all.length,
    persistent: persistent.length > 0,
  };
  return { ok: errors.length === 0, tree, errors, stats };
}
