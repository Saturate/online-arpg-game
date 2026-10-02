import { AILMENTS, AURA, HEAT, LINK, SPELL, WORLD_GEN } from '../config/sim.js';
import { AFFIX_IDS, AFFIXES, affixText, RUNE_AFFIX_TIERS, type AffixId } from '../data/affixes.js';
import { SIGIL_MAX_SLOTS } from '../items/items.js';
import { betterOf } from '../items/runeRolls.js';
import { RUNE_FORCE, RUNE_PRICE, RUNE_SPIRIT } from '../runes/v2/compile.js';
import { MIN_RELEASE_SECONDS, SPLIT_COUNT_RANGE } from '../runes/v2/rules.js';
import { CASTABLE_RUNES, CONCENTRATED, DEFAULTS, PLAIN_MODIFIER_EFFECT, runeName } from '../runes/v2/runes.js';
import { WORLD_GEN_DEFAULTS, WORLD_GEN_KEYS, WORLD_GEN_SPECS, worldGenProblem, type WorldGenKey } from '../world/worldGen.js';
import type { TunableValues } from './values.js';

/**
 * Live tuning (docs/features/live-tuning.md): every balance number an admin may change without a
 * deploy, with its code default and allowed range. The defaults stay in the config objects; an
 * override overwrites the number in place, so the sim, the compiler and the tooltips read it where
 * they always did. The server and every client apply the same overrides with `applyTunables`.
 */

export const TUNING_CATEGORIES = ['runes', 'sigils', 'force', 'spirit', 'shapes', 'spell', 'aura', 'bond', 'ailments', 'worldgen'] as const;
export type TuningCategory = (typeof TUNING_CATEGORIES)[number];

export const TUNING_CATEGORY_NAMES: Record<TuningCategory, string> = {
  shapes: 'Base shapes',
  spell: 'Spell engine',
  aura: 'Aura',
  bond: 'Bond',
  ailments: 'Ailments',
  force: 'Force prices',
  spirit: 'Spirit prices',
  runes: 'Rune balance',
  sigils: 'Sigil balance',
  worldgen: 'World generation',
};

export interface TunableSpec {
  /** Stable id, for example `spell.bolt.damage`; what the API and storage use. */
  path: string;
  category: TuningCategory;
  label: string;
  /** The code default, read from the config when this module loads. */
  default: number;
  min: number;
  max: number;
  /** Whole numbers only (tick counts, caps, copy counts). */
  int: boolean;
  note?: string;
  /** A heading inside the category, for example the starter a number belongs to. */
  group?: string;
}

export { isTunableValues, type TunableValues } from './values.js';

interface Slot {
  spec: TunableSpec;
  target: object;
  key: string;
}

interface Range {
  min?: number;
  max?: number;
  int?: boolean;
  label?: string;
  note?: string;
}

/** Rounds away float noise such as 10 x 0.35 = 3.5000000000000004. */
const tidy = (n: number): number => Number(n.toPrecision(6));

/**
 * Ranges are wide on purpose, from 0 to ten times the default: they stop typos and numbers that
 * break the engine (a zero tick interval, a slow above 100%), not unusual balance. The owner chose
 * no balance guard.
 */
function defaultRange(d: number): { min: number; max: number } {
  if (d < 0) return { min: tidy(10 * d), max: 0 };
  return { min: 0, max: tidy(Math.max(10 * d, 1)) };
}

const PI = tidy(Math.PI);
const TWO_PI = tidy(2 * Math.PI);
/** One sim tick: anything shorter is the same as zero to the engine, and zero divides by zero. */
const TICK = 0.05;

/** Paths whose default range would break something, and labels the key names do not make clear. */
const SPECIAL: Record<string, Range> = {
  'spell.splitSpreadRadians': { max: PI, label: 'Split fan angle (radians)' },
  'spell.splitRingOffset': { label: 'Split ring offset' },
  'spell.timerSeconds': { min: 0.1, max: 5, label: 'Timer rune default seconds' },
  'spell.pulseSeconds': { min: 0.1, max: 2.5, label: 'Pulse rune default interval' },
  'spell.pulseRotation': { max: TWO_PI, label: 'Interval spray rotation (radians)' },
  'spell.splitEfficiency': { label: 'Split damage conserved', note: 'Each copy of n gets this / n of the damage.' },
  'spell.stackedInfusionBonus': { label: 'Doubled infusion bonus damage' },
  'spell.bolt.speed': { min: 52 },
  'spell.orb.speed': { min: 28 },
  'spell.nova.durationSeconds': { min: TICK },
  'spell.zone.durationSeconds': { min: TICK },
  'spell.zone.tickSeconds': { min: TICK, label: 'Zone: seconds between damage ticks' },
  'spell.dash.ticks': { min: 1, max: 40, int: true, label: 'Dash: ticks it lasts' },
  // The live caps guard the server, not balance (measured in SPELL.liveCap's comment): at most 3x,
  // and a weight at least a quarter of its default, so tuning cannot let a room flood the tick.
  'spell.liveCap.max': { min: 1, max: 120, int: true, label: 'Live spell cap per caster' },
  'spell.liveCap.roomMax': { min: 1, max: 960, int: true, label: 'Live spell cap per room' },
  'spell.liveCap.projectile': { min: 0.25, label: 'Live cap weight: projectile' },
  'spell.liveCap.nova': { min: 0.25, label: 'Live cap weight: nova' },
  'spell.liveCap.zone': { min: 0.09, label: 'Live cap weight: zone' },
  'spell.affixSteps.speed': { min: 1.05, label: 'Affix price step: speed' },
  'spell.affixSteps.dashSpeed': { min: 1.05, label: 'Affix price step: dash speed' },
  'spell.affixSteps.size': { min: 1.05, label: 'Affix price step: size' },
  'spell.affixSteps.duration': { min: 1.05, label: 'Affix price step: duration' },
  'spell.affixSteps.damage': { min: 1.05, label: 'Affix price step: damage' },
  'spell.affixSteps.pierce': { min: 0.1, label: 'Affix price step: pierce' },
  'spell.forceKnockback': { label: 'Impact knockback' },
  'spell.shieldSeconds': { min: TICK, label: 'Ward shield seconds' },
  'spell.comboDamageBonus': { label: 'Frostfire bonus damage' },
  'spell.burningWardDamage': { label: 'Burning Ward damage per touch' },
  'aura.wardReduction': { max: 1 },
  'aura.forcePushPerTick': { label: 'Aura: Impact push per tick' },
  'bond.acquireConeRadians': { max: PI, label: 'Bond: acquire cone (radians)' },
  'bond.wardReduction': { max: 1 },
  'ailment.chill.slow': { max: 1 },
  'ailment.poison.maxStacks': { min: 1, int: true },
  'force.affixRefundShare': { max: 1 },
  'force.minForcePerCast': { max: 40 },
};

const SHAPE_NAMES = { bolt: 'Bolt', orb: 'Orb', nova: 'Nova', zone: 'Zone', dash: 'Dash' } as const;
type DamageShape = keyof typeof SHAPE_NAMES;
const DAMAGE_SHAPES: readonly DamageShape[] = ['bolt', 'orb', 'nova', 'zone', 'dash'];
for (const shape of DAMAGE_SHAPES) {
  const name = SHAPE_NAMES[shape];
  const note = 'Physical damage it rolls on every hit; infusions convert it. Its lowest at most its highest.';
  SPECIAL[`spell.${shape}.damageMin`] = { label: `${name}: lowest base damage`, note };
  SPECIAL[`spell.${shape}.damageMax`] = { label: `${name}: highest base damage`, note };
}

const slots: Slot[] = [];
const byPath = new Map<string, Slot>();

function humanise(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function add(path: string, category: TuningCategory, label: string, target: object, key: string, opts: { range?: Range; group?: string } = {}): void {
  const v: unknown = Reflect.get(target, key);
  if (typeof v !== 'number') throw new Error(`tunable ${path} is not a number`);
  const special = opts.range ?? SPECIAL[path] ?? {};
  const range = defaultRange(v);
  const spec: TunableSpec = {
    path,
    category,
    label: special.label ?? label,
    default: v,
    min: special.min ?? range.min,
    max: special.max ?? range.max,
    int: special.int ?? false,
    ...(special.note === undefined ? {} : { note: special.note }),
    ...(opts.group === undefined ? {} : { group: opts.group }),
  };
  if (spec.default < spec.min || spec.default > spec.max) throw new Error(`tunable ${path} default ${v} is outside ${spec.min} to ${spec.max}`);
  const slot = { spec, target, key };
  slots.push(slot);
  byPath.set(path, slot);
}

function isPlainObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every number in a config object, nested ones included, so a field added later is tunable by default. */
function walk(prefix: string, obj: object, each: (path: string, keys: string[], target: object, key: string) => void, keys: string[] = []): void {
  for (const key of Object.keys(obj)) {
    const v: unknown = Reflect.get(obj, key);
    const path = `${prefix}.${key}`;
    if (typeof v === 'number') each(path, [...keys, key], obj, key);
    else if (isPlainObject(v)) walk(path, v, each, [...keys, key]);
  }
}

const SHAPE_KEYS: ReadonlySet<string> = new Set(['bolt', 'orb', 'nova', 'zone', 'dash']);

walk('spell', SPELL, (path, keys, target, key) => {
  const head = keys[0] ?? '';
  const shape = SHAPE_KEYS.has(head);
  const label = shape ? `${capital(head)}: ${humanise(keys.slice(1).join(' '))}` : capital(humanise(keys.join(' ')));
  add(path, shape ? 'shapes' : 'spell', label, target, key);
});
walk('aura', AURA, (path, keys, target, key) => add(path, 'aura', `Aura: ${humanise(keys.join(' '))}`, target, key));
walk('bond', LINK, (path, keys, target, key) => add(path, 'bond', `Bond: ${humanise(keys.join(' '))}`, target, key));
walk('ailment', AILMENTS, (path, keys, target, key) => {
  const [name = '', ...rest] = keys;
  add(path, 'ailments', `${capital(name)}: ${humanise(rest.join(' '))}`, target, key);
});

/** HEAT's pricing numbers; the bar, cooling and misfires are admin settings or a later phase. */
const FORCE_PRICING = [
  ['affinityMultiplier', 'Class rune price multiplier'],
  ['offAffinityMultiplier', 'Off-class rune price multiplier'],
  ['payloadForceFactor', 'Payload first spawn share'],
  ['payloadRepeatShare', 'Payload repeat share from a flying shape'],
  ['payloadAffixShare', 'Payload rider and affix share'],
  ['minForcePerCast', 'Least Force per cast'],
  ['affixStepForce', 'Force per affix step'],
  ['affixRefundShare', 'Negative roll refund share'],
] as const satisfies readonly (readonly [keyof typeof HEAT, string])[];
for (const [key, label] of FORCE_PRICING) add(`force.${key}`, 'force', label, HEAT, key);

/** Aura and Bond never cost Force, and Split is priced per copy, so their listed Force means nothing. */
const UNPRICED: ReadonlySet<string> = new Set(['aura', 'bond', 'split']);
for (const id of CASTABLE_RUNES) if (!UNPRICED.has(id)) add(`force.rune.${id}`, 'force', `${runeName(id)} Force`, RUNE_FORCE, id);
add('force.splitPerCopy', 'force', 'Split Force per copy', RUNE_PRICE, 'splitForcePerCopy');

for (const id of CASTABLE_RUNES) if (RUNE_SPIRIT[id] !== undefined) add(`spirit.rune.${id}`, 'spirit', `${runeName(id)} spirit`, RUNE_SPIRIT, id);
add('spirit.concentratedShare', 'spirit', 'Concentrated share of the rest of the aura', RUNE_PRICE, 'concentratedSpiritShare');

add('rune.swift.speed', 'runes', 'Swift: % speed', PLAIN_MODIFIER_EFFECT.swift, 'value');
add('rune.large.size', 'runes', 'Large: % size', PLAIN_MODIFIER_EFFECT.large, 'value');
add('rune.concentrated.sizePercent', 'runes', 'Concentrated: % size', CONCENTRATED, 'sizePercent');
SPECIAL['rune.concentrated.defaultMore'] = { min: CONCENTRATED.minMore, max: CONCENTRATED.maxMore };
add('rune.concentrated.defaultMore', 'runes', 'Concentrated: % more damage without a roll', CONCENTRATED, 'defaultMore');
SPECIAL['rune.split.defaultCount'] = { min: SPLIT_COUNT_RANGE.min, max: SPLIT_COUNT_RANGE.max, int: true };
add('rune.split.defaultCount', 'runes', 'Split: copies without a count', DEFAULTS, 'splitCount');

/**
 * Affix roll tables (Rune balance and Sigil balance): each tier's lowest and highest roll, and for
 * the six rune tiers their weight and the least item level that rolls them. Paths name the tier as
 * players read it, from the best: `affix.rune_damage.t1.max` is T1's top damage roll. A change
 * reaches new drops, new kits and where extraction clamps; it never changes a stored roll.
 * Release flags (on hit, on expire, on landing) carry no number and are left out.
 */
const FLAG_AFFIXES: ReadonlySet<AffixId> = new Set(['release_onhit', 'release_onexpire', 'release_onland']);

/** The widest a roll may go per affix: past these the grammar refuses the spell or the number stops meaning anything. */
const AFFIX_LIMITS: Partial<Record<AffixId, { min: number; max: number }>> = {
  split_count: { min: SPLIT_COUNT_RANGE.min, max: SPLIT_COUNT_RANGE.max },
  rune_concentrated: { min: CONCENTRATED.minMore, max: CONCENTRATED.maxMore },
  release_every: { min: MIN_RELEASE_SECONDS, max: 10 },
  release_after: { min: MIN_RELEASE_SECONDS, max: 10 },
  rune_pierce: { min: 0, max: 20 },
  // Shares of a cost or a wait: at 100% the Force, spirit or cooldown would be gone.
  heat_reduced: { min: 0, max: 90 },
  spirit_reduced: { min: 0, max: 90 },
  cast_delay: { min: 0, max: 90 },
  sigil_slots: { min: 0, max: SIGIL_MAX_SLOTS },
  // Rule-breaking rolls stay small; compiling still checks every spell against depth and the entity cap.
  max_depth: { min: 0, max: 3 },
  multicast: { min: 0, max: 3 },
};

/** Monster levels stop at 50; dungeon caches drop a level above, so gates may sit a little past it. */
const MAX_GATE_LEVEL = 60;

export function affixTierPath(id: AffixId, tier: number, key: 'min' | 'max' | 'weight' | 'ilvl'): string {
  return `affix.${id}.t${AFFIXES[id].tiers.length - tier}.${key}`;
}

function affixGroup(id: AffixId): string {
  return `${capital(affixText(AFFIXES[id], '#', '#'))} (${id})`;
}

for (const id of AFFIX_IDS) {
  const def = AFFIXES[id];
  const rune = def.targets.includes('rune');
  if ((!rune && !def.targets.includes('sigil')) || FLAG_AFFIXES.has(id)) continue;
  const category: TuningCategory = rune ? 'runes' : 'sigils';
  const top = Math.max(...def.tiers.map((t) => t.max));
  const limits = AFFIX_LIMITS[id] ?? { min: 0, max: tidy(10 * top) };
  const int = (def.decimals ?? 0) === 0;
  // Listed from T1, the best, down, as the Tuning tab reads them.
  for (let tier = def.tiers.length - 1; tier >= 0; tier--) {
    const t = def.tiers[tier];
    if (!t) continue;
    const name = `T${def.tiers.length - tier}`;
    const opts = (range: Range) => ({ range, group: affixGroup(id) });
    add(affixTierPath(id, tier, 'min'), category, `${name}: lowest roll`, t, 'min', opts({ ...limits, int }));
    add(affixTierPath(id, tier, 'max'), category, `${name}: highest roll`, t, 'max', opts({ ...limits, int }));
    if (!rune || def.tiers.length !== RUNE_AFFIX_TIERS) continue;
    add(affixTierPath(id, tier, 'weight'), category, `${name}: drop weight`, t, 'weight', opts({ min: 0, max: 1000, int: true }));
    add(affixTierPath(id, tier, 'ilvl'), category, `${name}: least item level`, t, 'ilvl', opts({ min: 1, max: MAX_GATE_LEVEL, int: true }));
  }
}

/**
 * World generation (world/worldGen.ts): what new world copies are built with. A copy keeps the
 * numbers it was made with, so a change never moves a running world; the force rebuild does.
 */
export function worldGenPath(key: WorldGenKey): string {
  return `worldgen.${key}`;
}
for (const key of WORLD_GEN_KEYS) {
  const spec = WORLD_GEN_SPECS[key];
  add(worldGenPath(key), 'worldgen', spec.label, WORLD_GEN, key, { range: { min: spec.min, max: spec.max, int: spec.int, ...(spec.note === undefined ? {} : { note: spec.note }) }, group: spec.group });
}

/** Everything that can be tuned, in a stable order (by category, then as the config lists it). */
export const TUNABLES: readonly TunableSpec[] = TUNING_CATEGORIES.flatMap((c) => slots.filter((s) => s.spec.category === c).map((s) => s.spec));

export function tunableSpec(path: string): TunableSpec | undefined {
  return byPath.get(path)?.spec;
}

/** Why a value cannot be set at this path, or null when it can. */
export function tunableProblem(spec: TunableSpec, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${spec.path} must be a number`;
  if (spec.int && !Number.isInteger(v)) return `${spec.path} must be a whole number`;
  if (v < spec.min || v > spec.max) return `${spec.path} must be ${spec.min} to ${spec.max}`;
  return null;
}

let active: TunableValues = {};
let version = 0;

/**
 * Sets every tunable to its code default, then applies `values`. Entries for unknown paths or out
 * of range are skipped, so a client older or newer than the server keeps the rest. The same values
 * always give the same numbers, whatever was applied before.
 */
/**
 * Splits a set into what can be applied and the affix tables it would leave broken (a partial set:
 * one number of a table dropped as out of range on load or by an older client). A broken table keeps
 * its code defaults whole rather than half its tuning; `dropped` names each with the paths it loses.
 */
export function withoutBrokenAffixTables(values: Readonly<TunableValues>): { kept: TunableValues; dropped: { why: string; paths: string[] }[] } {
  const kept: TunableValues = { ...values };
  const dropped: { why: string; paths: string[] }[] = [];
  for (const id of AFFIX_IDS) {
    const why = affixTableProblem(id, kept);
    if (why === null) continue;
    const paths = Object.keys(kept).filter((p) => p.startsWith(`affix.${id}.`));
    for (const p of paths) delete kept[p];
    dropped.push({ why, paths });
  }
  return { kept, dropped };
}

export function applyTunables(values: Readonly<TunableValues>, onDropped?: (why: string) => void): void {
  for (const s of slots) Reflect.set(s.target, s.key, s.spec.default);
  const valid: TunableValues = {};
  for (const path of Object.keys(values).sort()) {
    const slot = byPath.get(path);
    const v = values[path];
    if (!slot || v === undefined || tunableProblem(slot.spec, v) !== null || v === slot.spec.default) continue;
    valid[path] = v;
  }
  const { kept, dropped } = withoutBrokenAffixTables(valid);
  for (const d of dropped) onDropped?.(`${d.why}; ${d.paths.join(', ')} left at the code table`);
  const next: TunableValues = {};
  for (const path of Object.keys(kept).sort()) {
    const slot = byPath.get(path);
    const v = kept[path];
    if (!slot || v === undefined) continue;
    Reflect.set(slot.target, slot.key, v);
    next[path] = v;
  }
  active = next;
  version++;
}

export function resetTunables(): void {
  applyTunables({});
}

/** The overrides in force now, as applied (a copy). */
export function activeTunables(): TunableValues {
  return { ...active };
}

/** Goes up on every apply, so a cache of compiled spells knows to rebuild. */
export function tunablesVersion(): number {
  return version;
}

/** The live number at a path, override or default. */
export function tunableValue(path: string): number | undefined {
  const slot = byPath.get(path);
  if (!slot) return undefined;
  const v: unknown = Reflect.get(slot.target, slot.key);
  return typeof v === 'number' ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * An admin's change: path to a number, or null to go back to the code default. All or nothing: one
 * bad entry refuses the whole patch with the reason.
 */
export function parseTunablePatch(v: unknown): Record<string, number | null> | string {
  if (!isRecord(v)) return 'The body must be an object of path to number or null';
  const keys = Object.keys(v);
  if (keys.length === 0) return 'Nothing to change';
  if (keys.length > TUNABLES.length) return 'Too many entries';
  const out: Record<string, number | null> = {};
  for (const path of keys) {
    const spec = tunableSpec(path);
    if (!spec) return `Unknown tunable ${path.slice(0, 80)}`;
    const value = v[path];
    if (value === null) {
      out[path] = null;
      continue;
    }
    const problem = tunableProblem(spec, value);
    if (problem !== null || typeof value !== 'number') return problem ?? `${path} must be a number`;
    out[path] = value;
  }
  return out;
}

/**
 * Stored or received overrides: bad entries are dropped (and reported), the rest kept, so one value a
 * later range refuses cannot cost the others. A path the game no longer has (the retired
 * `starter.*` numbers) or does not have yet (a newer server's) is dropped without a report.
 */
export function parseTunableValues(v: unknown, onBad?: (why: string) => void): TunableValues {
  if (!isRecord(v)) return {};
  const out: TunableValues = {};
  for (const [path, value] of Object.entries(v)) {
    const spec = tunableSpec(path);
    if (!spec) continue;
    const problem = tunableProblem(spec, value);
    if (problem !== null || typeof value !== 'number') {
      onBad?.(problem ?? `${path} is not a number`);
      continue;
    }
    if (value !== spec.default) out[path] = value;
  }
  return out;
}

/** The value a set of overrides gives a path: its override, else its code default. */
function valueIn(values: Readonly<TunableValues>, path: string): number | undefined {
  const v = values[path];
  return v ?? byPath.get(path)?.spec.default;
}

/**
 * Why one affix's tiers break under a set of overrides, or null: every tier's lowest roll at most
 * its highest, and the tiers in order from the weakest up without overlapping (neighbours may share
 * an end, as whole-number tiers must), so the tier a roll counts as, and its price, is never in
 * doubt. A better tier may not unlock at a lower item level than a worse one, and the weakest
 * unlocks at level 1 with a weight above 0, since a Concentrated rune must always find a roll.
 */
function affixTableProblem(id: AffixId, values: Readonly<TunableValues>): string | null {
  const def = AFFIXES[id];
  if (!byPath.has(affixTierPath(id, 0, 'min'))) return null;
  const lower = betterOf(id) === 'lower';
  let prev: { min: number; max: number; ilvl: number | undefined; name: string } | null = null;
  for (let tier = 0; tier < def.tiers.length; tier++) {
    const min = valueIn(values, affixTierPath(id, tier, 'min'));
    const max = valueIn(values, affixTierPath(id, tier, 'max'));
    if (min === undefined || max === undefined) continue;
    const ilvl = valueIn(values, affixTierPath(id, tier, 'ilvl'));
    const name = `${id} T${def.tiers.length - tier}`;
    if (min > max) return `${name}: its lowest roll ${min} is above its highest ${max}`;
    if (!prev && ilvl !== undefined && ilvl !== 1) return `${name} must unlock at item level 1, so every drop can roll the affix`;
    const weight = valueIn(values, affixTierPath(id, tier, 'weight'));
    if (!prev && weight !== undefined && weight <= 0) return `${name} must keep a weight above 0, so every drop can roll the affix`;
    if (prev) {
      // A shorter pulse is the better roll, so its tiers run downward.
      if (!lower && min < prev.max) return `${name} (${min} to ${max}) overlaps or sits below ${prev.name} (${prev.min} to ${prev.max})`;
      if (lower && max > prev.min) return `${name} (${min} to ${max}) overlaps or sits above ${prev.name} (${prev.min} to ${prev.max}); shorter is better here`;
      if (ilvl !== undefined && prev.ilvl !== undefined && ilvl < prev.ilvl) return `${name} unlocks at item level ${ilvl}, below ${prev.name} at ${prev.ilvl}`;
    }
    prev = { min, max, ilvl, name };
  }
  return null;
}

/** Why a whole set of overrides cannot be applied though each number is in range, or null. */
export function tunableSetProblem(values: Readonly<TunableValues>): string | null {
  for (const shape of DAMAGE_SHAPES) {
    const min = valueIn(values, `spell.${shape}.damageMin`);
    const max = valueIn(values, `spell.${shape}.damageMax`);
    if (min !== undefined && max !== undefined && min > max) return `${SHAPE_NAMES[shape]}: its lowest base damage ${min} is above its highest ${max}`;
  }
  for (const id of AFFIX_IDS) {
    const problem = affixTableProblem(id, values);
    if (problem !== null) return problem;
  }
  const gen: Record<WorldGenKey, number> = { ...WORLD_GEN_DEFAULTS };
  for (const key of WORLD_GEN_KEYS) gen[key] = values[worldGenPath(key)] ?? WORLD_GEN_DEFAULTS[key];
  return worldGenProblem(gen);
}
