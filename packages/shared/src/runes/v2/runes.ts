/**
 * Rune data for the v2 spell grammar prototype (PLAN-runes.md). Pure data, no simulation.
 * Nothing here is wired into the game; the Spell Lab dev tab and grammarV2 tests use it.
 */

export const SHAPE_IDS = [
  'orb',
  'bolt',
  'beam',
  'nova',
  'zone',
  'dash',
  'arrow',
  'strike',
  'cleave',
  'throw',
  'trap',
  'aura',
  'bond',
] as const;
export const INFUSION_IDS = ['fire', 'cold', 'lightning'] as const;
export const SHAPER_IDS = ['split', 'link', 'orbit', 'homing', 'bounce', 'chain', 'stack', 'charge'] as const;
export const EFFECT_IDS = ['impact', 'ward', 'restore'] as const;
/** Triggers stay as plain common runes; each one is just another way to write a release affix. */
export const TRIGGER_IDS = ['onhit', 'onexpire', 'timer', 'pulse', 'onland'] as const;
/**
 * PLAN-runes.md open question 1: keep Swift and Large as plain runes as well as affixes?
 * They exist here but only parse when the context turns `plainModifierRunes` on.
 */
export const PLAIN_MODIFIER_IDS = ['swift', 'large'] as const;

export type ShapeId = (typeof SHAPE_IDS)[number];
export type InfusionId = (typeof INFUSION_IDS)[number];
export type ShaperId = (typeof SHAPER_IDS)[number];
export type EffectId = (typeof EFFECT_IDS)[number];
export type TriggerId = (typeof TRIGGER_IDS)[number];
export type PlainModifierId = (typeof PLAIN_MODIFIER_IDS)[number];
export type RuneId = ShapeId | InfusionId | ShaperId | EffectId | TriggerId | PlainModifierId;
export type RuneKind = 'shape' | 'infusion' | 'shaper' | 'effect' | 'trigger' | 'modifier';

export const RUNE_IDS: readonly RuneId[] = [
  ...SHAPE_IDS,
  ...INFUSION_IDS,
  ...SHAPER_IDS,
  ...EFFECT_IDS,
  ...TRIGGER_IDS,
  ...PLAIN_MODIFIER_IDS,
];

const RUNE_SET: ReadonlySet<string> = new Set(RUNE_IDS);
const SHAPE_SET: ReadonlySet<string> = new Set(SHAPE_IDS);
const INFUSION_SET: ReadonlySet<string> = new Set(INFUSION_IDS);
const SHAPER_SET: ReadonlySet<string> = new Set(SHAPER_IDS);
const EFFECT_SET: ReadonlySet<string> = new Set(EFFECT_IDS);
const TRIGGER_SET: ReadonlySet<string> = new Set(TRIGGER_IDS);
const MODIFIER_SET: ReadonlySet<string> = new Set(PLAIN_MODIFIER_IDS);

export const isRuneId = (s: string): s is RuneId => RUNE_SET.has(s);
export const isShapeId = (s: string): s is ShapeId => SHAPE_SET.has(s);
export const isInfusionId = (s: string): s is InfusionId => INFUSION_SET.has(s);
export const isShaperId = (s: string): s is ShaperId => SHAPER_SET.has(s);
export const isEffectId = (s: string): s is EffectId => EFFECT_SET.has(s);
export const isTriggerId = (s: string): s is TriggerId => TRIGGER_SET.has(s);
export const isPlainModifierId = (s: string): s is PlainModifierId => MODIFIER_SET.has(s);

export function runeKind(id: RuneId): RuneKind {
  if (isShapeId(id)) return 'shape';
  if (isInfusionId(id)) return 'infusion';
  if (isShaperId(id)) return 'shaper';
  if (isEffectId(id)) return 'effect';
  if (isTriggerId(id)) return 'trigger';
  return 'modifier';
}

export type ReleaseKind = 'onhit' | 'onexpire' | 'after' | 'every' | 'onland' | 'onrelease';

export interface Release {
  kind: ReleaseKind;
  /** Seconds for `after` and `every`; 0 for the rest. */
  seconds: number;
}

/**
 * Affixes a rolled rune instance may carry. Percent affixes are signed percentages
 * (`speed: -30` is 30% slower). Which rune may carry which key is in AFFIXES_FOR_KIND.
 */
export interface RuneAffixes {
  release?: Release;
  speed?: number;
  size?: number;
  duration?: number;
  damage?: number;
  /** Split: copy count. */
  count?: number;
  pierce?: number;
  bounce?: number;
  homing?: number;
  chain?: number;
  stackLimit?: number;
  chargeStages?: number;
  /** Timer and Pulse runes: the delay or interval in seconds. */
  seconds?: number;
}
export type AffixKey = keyof RuneAffixes;
export const AFFIX_KEYS: readonly AffixKey[] = [
  'release',
  'speed',
  'size',
  'duration',
  'damage',
  'count',
  'pierce',
  'bounce',
  'homing',
  'chain',
  'stackLimit',
  'chargeStages',
  'seconds',
];

export interface RuneInstance {
  id: RuneId;
  affixes: RuneAffixes;
}

export interface ShapeDef {
  name: string;
  family: 'spell' | 'weapon' | 'any' | 'persistent';
  /** Seconds one instance stays alive, used only for the live-entity budget. */
  lifetime: number;
  noun: string;
  plural: string;
  /** Verb for a root shape in the sentence ("Fires a cold orb"). */
  verb: string;
}

export const SHAPES: Record<ShapeId, ShapeDef> = {
  orb: { name: 'Orb', family: 'spell', lifetime: 2, noun: 'orb', plural: 'orbs', verb: 'Fires' },
  bolt: { name: 'Bolt', family: 'spell', lifetime: 1, noun: 'bolt', plural: 'bolts', verb: 'Fires' },
  // A channelled beam lives while the button is held; 2 s is the budget's assumption.
  beam: { name: 'Beam', family: 'spell', lifetime: 2, noun: 'beam', plural: 'beams', verb: 'Channels' },
  nova: { name: 'Nova', family: 'spell', lifetime: 0.4, noun: 'nova', plural: 'novas', verb: 'Casts' },
  zone: { name: 'Zone', family: 'spell', lifetime: 3, noun: 'zone', plural: 'zones', verb: 'Places' },
  dash: { name: 'Dash', family: 'any', lifetime: 0.3, noun: 'dash', plural: 'dashes', verb: 'Performs' },
  arrow: { name: 'Arrow', family: 'weapon', lifetime: 1, noun: 'arrow', plural: 'arrows', verb: 'Shoots' },
  strike: { name: 'Strike', family: 'weapon', lifetime: 0.2, noun: 'strike', plural: 'strikes', verb: 'Performs' },
  cleave: { name: 'Cleave', family: 'weapon', lifetime: 0.25, noun: 'cleave', plural: 'cleaves', verb: 'Performs' },
  throw: { name: 'Throw', family: 'weapon', lifetime: 1.2, noun: 'thrown blade', plural: 'thrown blades', verb: 'Throws' },
  trap: { name: 'Trap', family: 'weapon', lifetime: 6, noun: 'trap', plural: 'traps', verb: 'Sets' },
  aura: { name: 'Aura', family: 'persistent', lifetime: Number.POSITIVE_INFINITY, noun: 'aura', plural: 'auras', verb: 'Holds' },
  bond: { name: 'Bond', family: 'persistent', lifetime: Number.POSITIVE_INFINITY, noun: 'bond', plural: 'bonds', verb: 'Holds' },
};

export const isPersistentShape = (shape: ShapeId): boolean => SHAPES[shape].family === 'persistent';

const NAMES: Record<Exclude<RuneId, ShapeId>, string> = {
  fire: 'Fire',
  cold: 'Cold',
  lightning: 'Lightning',
  split: 'Split',
  link: 'Link',
  orbit: 'Orbit',
  homing: 'Homing',
  bounce: 'Bounce',
  chain: 'Chain',
  stack: 'Stack',
  charge: 'Charge',
  impact: 'Impact',
  ward: 'Ward',
  restore: 'Restore',
  onhit: 'On Hit',
  onexpire: 'On Expire',
  timer: 'Timer',
  pulse: 'Pulse',
  onland: 'On Land',
  swift: 'Swift',
  large: 'Large',
};

export function runeName(id: RuneId): string {
  return isShapeId(id) ? SHAPES[id].name : NAMES[id];
}

/** Which shapers each shape accepts. A shaper missing here is an error naming the rune. */
export const SHAPERS_FOR_SHAPE: Record<ShapeId, readonly ShaperId[]> = {
  orb: ['split', 'link', 'orbit', 'homing', 'bounce', 'chain', 'stack', 'charge'],
  bolt: ['split', 'link', 'orbit', 'homing', 'bounce', 'chain', 'stack', 'charge'],
  arrow: ['split', 'link', 'orbit', 'homing', 'bounce', 'chain', 'stack', 'charge'],
  throw: ['split', 'link', 'homing', 'bounce', 'chain', 'stack', 'charge'],
  beam: ['split', 'link', 'chain', 'stack', 'charge'],
  zone: ['split', 'link', 'orbit', 'stack', 'charge'],
  trap: ['split', 'link', 'stack', 'charge'],
  // A split nova makes several rings (owner decision: allowed for now, limit later if too strong).
  nova: ['split', 'stack', 'charge'],
  strike: ['split', 'chain', 'charge'],
  cleave: ['split', 'charge'],
  dash: ['charge'],
  aura: [],
  bond: [],
};

/** Which release kinds each shape accepts, whether written as an affix or a trigger rune. */
export const TRIGGERS_FOR_SHAPE: Record<ShapeId, readonly ReleaseKind[]> = {
  orb: ['onhit', 'onexpire', 'after', 'every', 'onrelease'],
  bolt: ['onhit', 'onexpire', 'after', 'every', 'onrelease'],
  beam: ['after', 'every', 'onrelease'],
  zone: ['onexpire', 'after', 'every', 'onrelease'],
  nova: ['onexpire', 'after', 'onrelease'],
  arrow: ['onhit', 'onexpire', 'after', 'onrelease'],
  throw: ['onhit', 'onexpire', 'after', 'onrelease'],
  trap: ['onhit', 'onexpire', 'after', 'onrelease'],
  strike: ['onhit', 'onrelease'],
  cleave: ['onhit', 'onrelease'],
  dash: ['onhit', 'onland', 'after', 'onrelease'],
  aura: [],
  bond: [],
};

/** Shapes that fly and so can pierce. */
export const PROJECTILE_SHAPES: readonly ShapeId[] = ['orb', 'bolt', 'arrow', 'throw'];

export const TRIGGER_RELEASE: Record<TriggerId, ReleaseKind> = {
  onhit: 'onhit',
  onexpire: 'onexpire',
  timer: 'after',
  pulse: 'every',
  onland: 'onland',
};

/** Seconds a Timer or Pulse rune uses when it carries no `seconds` affix. */
export const DEFAULT_TIMER_SECONDS = 0.5;
export const DEFAULT_PULSE_SECONDS = 0.25;

/** Which affix keys each rune may carry. Anything else is an error. */
export function affixesFor(id: RuneId): readonly AffixKey[] {
  if (isShapeId(id)) return ['release', 'speed', 'size', 'duration', 'damage', 'pierce', 'bounce', 'homing'];
  switch (id) {
    case 'split':
      return ['count'];
    case 'link':
      return ['damage'];
    case 'homing':
      return ['homing'];
    case 'bounce':
      return ['bounce'];
    case 'chain':
      return ['chain'];
    case 'stack':
      return ['stackLimit'];
    case 'charge':
      return ['chargeStages'];
    case 'timer':
    case 'pulse':
      return ['seconds'];
    default:
      return [];
  }
}

/** What a bare `(n)` count means on each rune in the text box; missing means it is not allowed. */
export const COUNT_AFFIX: Partial<Record<RuneId, AffixKey>> = {
  split: 'count',
  stack: 'stackLimit',
  charge: 'chargeStages',
  chain: 'chain',
  bounce: 'bounce',
  homing: 'homing',
  timer: 'seconds',
  pulse: 'seconds',
};

/** Plain-rune effect when `plainModifierRunes` is on: the same numbers as the matching affix words. */
export const PLAIN_MODIFIER_EFFECT: Record<PlainModifierId, { key: 'speed' | 'size'; value: number }> = {
  swift: { key: 'speed', value: 30 },
  large: { key: 'size', value: 50 },
};

export const DEFAULTS = {
  splitCount: 2,
  chainCount: 2,
  bounceCount: 1,
  homingStrength: 1,
  stackLimit: 2,
  chargeStages: 3,
} as const;
