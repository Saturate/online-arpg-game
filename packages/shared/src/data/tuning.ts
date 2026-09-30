import { ENEMIES, ENEMY_TYPE_IDS, isEnemyTypeId, type Ability, type AbilityKind, type EnemyDef, type EnemyTypeId } from './enemies.js';
import { isMinionTypeId, MINION_DEFS, MINION_TYPE_IDS, type MinionDef, type MinionTypeId } from './minions.js';

/**
 * Admin overrides for monster and minion numbers, stored by the server and applied to new spawns
 * without a deploy. The code in enemies.ts and minions.ts stays the default; an override only lists
 * what differs from it, and the admin page exports overridden types back into that source format.
 */

export type TuningKind = 'monsters' | 'minions';

export interface NumberSpec {
  label: string;
  min: number;
  max: number;
  /** Whole numbers only (bullet counts, summon caps). */
  int?: boolean;
}

export const ENEMY_STAT_KEYS = [
  'life',
  'moveSpeed',
  'radius',
  'contactDamage',
  'contactCooldown',
  'xp',
  'preferredRange',
  'fireCooldown',
  'bullets',
  'spread',
  'rotationPerVolley',
  'bulletSpeed',
  'bulletDamage',
  'bulletRadius',
  'bulletRange',
] as const;
export type EnemyStatKey = (typeof ENEMY_STAT_KEYS)[number];

/** Limits are generous on purpose: they stop typos and broken numbers, not unusual tuning. */
export const ENEMY_STATS: Record<EnemyStatKey, NumberSpec> = {
  life: { label: 'Life', min: 1, max: 100_000 },
  moveSpeed: { label: 'Move speed', min: 0, max: 1000 },
  radius: { label: 'Radius', min: 4, max: 80 },
  contactDamage: { label: 'Contact damage', min: 0, max: 2000 },
  contactCooldown: { label: 'Contact cooldown', min: 0.1, max: 30 },
  xp: { label: 'XP multiplier', min: 0, max: 20 },
  preferredRange: { label: 'Preferred range', min: 0, max: 1500 },
  fireCooldown: { label: 'Fire cooldown', min: 0.1, max: 30 },
  bullets: { label: 'Bullets', min: 1, max: 64, int: true },
  spread: { label: 'Spread', min: 0, max: 3.2 },
  rotationPerVolley: { label: 'Rotation per volley', min: -6.3, max: 6.3 },
  bulletSpeed: { label: 'Bullet speed', min: 10, max: 3000 },
  bulletDamage: { label: 'Bullet damage', min: 0, max: 2000 },
  bulletRadius: { label: 'Bullet radius', min: 1, max: 60 },
  bulletRange: { label: 'Bullet range', min: 50, max: 4000 },
};

const BASE_STATS: readonly EnemyStatKey[] = ['life', 'moveSpeed', 'radius', 'contactDamage', 'contactCooldown', 'xp'];
const BULLET_STATS: readonly EnemyStatKey[] = ['preferredRange', 'fireCooldown', 'bullets', 'bulletSpeed', 'bulletDamage', 'bulletRadius', 'bulletRange'];

/** The numbers a type has, in the order the admin page shows them. */
export function enemyStatKeys(def: EnemyDef): readonly EnemyStatKey[] {
  switch (def.behaviour) {
    case 'chaser':
      return BASE_STATS;
    case 'shooter':
      return [...BASE_STATS, ...BULLET_STATS, 'spread'];
    case 'spinner':
      return [...BASE_STATS, ...BULLET_STATS, 'rotationPerVolley'];
    case 'monster':
      return [...BASE_STATS, 'preferredRange'];
  }
}

export const ABILITY_NUMBER_KEYS = [
  'cooldown',
  'range',
  'windup',
  'radius',
  'damage',
  'bullets',
  'spread',
  'speed',
  'homing',
  'extra',
  'count',
  'cap',
  'duration',
  'width',
  'minRange',
  'percent',
  'dps',
  'distance',
] as const;
export type AbilityNumberKey = (typeof ABILITY_NUMBER_KEYS)[number];

export const ABILITY_NUMBERS: Record<AbilityNumberKey, NumberSpec> = {
  cooldown: { label: 'Cooldown', min: 0, max: 120 },
  range: { label: 'Range', min: 0, max: 3000 },
  windup: { label: 'Telegraph', min: 0, max: 10 },
  radius: { label: 'Radius', min: 1, max: 600 },
  damage: { label: 'Damage', min: 0, max: 2000 },
  bullets: { label: 'Bullets', min: 1, max: 64, int: true },
  spread: { label: 'Spread', min: 0, max: 3.2 },
  speed: { label: 'Speed', min: 1, max: 3000 },
  homing: { label: 'Homing', min: 0, max: 10 },
  extra: { label: 'Extra blasts', min: 0, max: 20, int: true },
  count: { label: 'Count', min: 1, max: 20, int: true },
  cap: { label: 'Cap', min: 1, max: 40, int: true },
  duration: { label: 'Duration', min: 0.05, max: 30 },
  width: { label: 'Width', min: 1, max: 200 },
  minRange: { label: 'Min range', min: 0, max: 3000 },
  percent: { label: 'Heal percent', min: 0, max: 100 },
  dps: { label: 'Damage per second', min: 0, max: 1000 },
  distance: { label: 'Distance', min: 0, max: 2000 },
};

const COMMON: readonly AbilityNumberKey[] = ['cooldown', 'range', 'windup'];

/** Every number each ability kind reads, after the cooldown, range and telegraph they all have. */
export const ABILITY_FIELDS: Record<AbilityKind, readonly AbilityNumberKey[]> = {
  slam: [...COMMON, 'radius', 'damage'],
  shoot: [...COMMON, 'bullets', 'spread', 'speed', 'damage', 'radius', 'homing'],
  ring: [...COMMON, 'bullets', 'speed', 'damage', 'radius'],
  blast: [...COMMON, 'radius', 'damage', 'extra'],
  summon: [...COMMON, 'count', 'cap'],
  charge: [...COMMON, 'speed', 'duration', 'damage', 'width'],
  leap: [...COMMON, 'minRange', 'radius', 'damage', 'duration'],
  explode: [...COMMON, 'radius', 'damage'],
  heal: [...COMMON, 'radius', 'percent'],
  raise: [...COMMON, 'radius', 'count'],
  pool: [...COMMON, 'radius', 'dps', 'duration'],
  blink: [...COMMON, 'distance'],
};

export const MINION_STAT_KEYS = ['life', 'damage', 'moveSpeed', 'radius', 'attackCooldown', 'attackRange', 'projectileSpeed', 'kiteDistance'] as const;
export type MinionStatKey = (typeof MINION_STAT_KEYS)[number];

export const MINION_STATS: Record<MinionStatKey, NumberSpec> = {
  life: { label: 'Life', min: 1, max: 100_000 },
  damage: { label: 'Damage', min: 0, max: 2000 },
  moveSpeed: { label: 'Move speed', min: 0, max: 1000 },
  radius: { label: 'Radius', min: 4, max: 80 },
  attackCooldown: { label: 'Attack cooldown', min: 0.05, max: 30 },
  attackRange: { label: 'Attack range', min: 1, max: 2000 },
  // Above zero: an arrow's lifetime is its range over its speed.
  projectileSpeed: { label: 'Projectile speed', min: 10, max: 3000 },
  kiteDistance: { label: 'Kite distance', min: 0, max: 1500 },
};

/**
 * Character models in the client's asset registry (category 'monster' in render/assets.ts). Kept
 * here so the server can reject an unknown id; a client test keeps the two lists equal.
 */
export const MONSTER_MODEL_IDS = [
  'skel_minion',
  'skel_rogue',
  'skel_mage',
  'skel_warrior',
  'mon_grave_brute',
  'mon_ogre',
  'mon_bandit_archer',
  'mon_bone_archer',
  'mon_frost_adept',
  'mon_pyromancer',
  'mon_storm_caller',
  'mon_necromancer',
  'mon_tomb_guard',
  'mon_grave_priest',
  'mon_ghoul',
  'mon_butcher',
  'mon_lich',
  'mon_grave_hound',
  'minion_brute',
  'minion_archer',
  'minion_hound',
  'minion_hound_leader',
] as const;
export type MonsterModelId = (typeof MONSTER_MODEL_IDS)[number];

export function isMonsterModelId(v: unknown): v is MonsterModelId {
  return typeof v === 'string' && MONSTER_MODEL_IDS.some((m) => m === v);
}

/**
 * Which model file each type is drawn with by default; types left out use a procedural model built
 * in code (render/models.ts). Here rather than in the client so the server knows which types a
 * height override can apply to. render/characters.ts reads it.
 */
export const ENEMY_MODELS: Partial<Record<EnemyTypeId, MonsterModelId>> = {
  chaser: 'skel_minion',
  shooter: 'skel_rogue',
  spinner: 'skel_mage',
  grave_brute: 'mon_grave_brute',
  ogre: 'mon_ogre',
  bandit_archer: 'mon_bandit_archer',
  bone_archer: 'mon_bone_archer',
  frost_adept: 'mon_frost_adept',
  pyromancer: 'mon_pyromancer',
  storm_caller: 'mon_storm_caller',
  necromancer: 'mon_necromancer',
  tomb_guard: 'mon_tomb_guard',
  grave_priest: 'mon_grave_priest',
  ghoul: 'mon_ghoul',
  butcher: 'mon_butcher',
  lich: 'mon_lich',
  grave_hound: 'mon_grave_hound',
};
export const MINION_MODELS: Partial<Record<MinionTypeId, MonsterModelId>> = {
  zombie_brute: 'minion_brute',
  skeleton_archer: 'minion_archer',
  hound: 'minion_hound',
};

/** Model height in world units; heroes are 54. */
export const MODEL_HEIGHT = { min: 8, max: 400 } as const;

/**
 * An ability's overridden numbers. The kind is stored with them because patches are keyed by the
 * ability's index: if the code later reorders or replaces abilities, a patch whose kind no longer
 * matches is dropped instead of landing on a different ability.
 */
export type AbilityPatch = { kind: AbilityKind } & Partial<Record<AbilityNumberKey, number>>;

export type EnemyOverride = Partial<Record<EnemyStatKey, number>> & {
  /** Keyed by the ability's index in the type's list, as text since it travels as JSON. */
  abilities?: Partial<Record<string, AbilityPatch>>;
  model?: MonsterModelId;
  height?: number;
};

export type MinionOverride = Partial<Record<MinionStatKey, number>> & {
  model?: MonsterModelId;
  height?: number;
};

export interface TuningOverrides {
  monsters: Partial<Record<EnemyTypeId, EnemyOverride>>;
  minions: Partial<Record<MinionTypeId, MinionOverride>>;
}

export interface ModelOverride {
  model?: MonsterModelId;
  height?: number;
}

/** What every game client needs to draw overridden types: only models and heights, never stats. */
export interface ModelOverrides {
  monsters: Partial<Record<EnemyTypeId, ModelOverride>>;
  minions: Partial<Record<MinionTypeId, ModelOverride>>;
}

export function emptyTuning(): TuningOverrides {
  return { monsters: {}, minions: {} };
}

// ---------------------------------------------------------------------------------------------
// Reading defaults

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A named number on a definition, or undefined when this variant does not have it. */
function numberField(obj: object, key: string): number | undefined {
  const v: unknown = Object.entries(obj).find(([k]) => k === key)?.[1];
  return typeof v === 'number' ? v : undefined;
}

/** The code default of one stat. XP is a multiplier, so a type without one is worth 1. */
export function enemyStatDefault(def: EnemyDef, key: EnemyStatKey): number {
  return numberField(def, key) ?? (key === 'xp' ? 1 : 0);
}

/** Optional ability numbers (homing) read as 0 when the ability does not set them. */
export function abilityDefault(a: Ability, key: AbilityNumberKey): number {
  return numberField(a, key) ?? 0;
}

export function minionStatDefault(def: MinionDef, key: MinionStatKey): number {
  return def[key];
}

// ---------------------------------------------------------------------------------------------
// Validation, in the style of protocol/validate.ts: every field is typed, finite and in range, and
// anything unknown is refused rather than dropped, so a typo in a request is never silently lost.

function checkNumber(field: string, spec: NumberSpec, v: unknown): number | string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${field} must be a number`;
  if (spec.int === true && !Number.isInteger(v)) return `${field} must be a whole number`;
  if (v < spec.min || v > spec.max) return `${field} must be between ${spec.min} and ${spec.max}`;
  return v;
}

function isOneOf<K extends string>(keys: readonly K[], v: string): v is K {
  return keys.some((k) => k === v);
}

/** `defaultModel` is the type's own model file; without one or a chosen model, a height has nothing to size. */
function parseModelFields(value: Record<string, unknown>, out: { model?: MonsterModelId; height?: number }, defaultModel: MonsterModelId | undefined): string | null {
  if (value.model !== undefined) {
    if (!isMonsterModelId(value.model)) return 'model must be a monster model from the asset registry';
    out.model = value.model;
  }
  if (value.height !== undefined) {
    const h = checkNumber('height', { label: 'Height', ...MODEL_HEIGHT }, value.height);
    if (typeof h === 'string') return h;
    if (out.model === undefined && defaultModel === undefined) return 'height needs a model: this type is drawn procedurally, so pick a model first';
    out.height = h;
  }
  return null;
}

/** Ability indexes as JSON keys: plain decimal, so "01" and "1" cannot both name ability 1. */
const ABILITY_INDEX = /^(0|[1-9]\d?)$/;

/** Minimum time between two uses of an ability that fires bullets, so a tuning slip cannot make it fire every tick. */
export const MIN_BULLET_INTERVAL = 0.1;

/**
 * Checks a request's override for one type. `stale` switches to the loading rules: an ability patch
 * that no longer fits the code (its kind changed, or the ability is gone) is reported and dropped,
 * keeping the rest of the type's override, instead of failing the whole type.
 */
export function parseEnemyOverride(typeId: EnemyTypeId, value: unknown, stale?: (why: string) => void): EnemyOverride | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  const def = ENEMIES[typeId];
  const stats = enemyStatKeys(def);
  const out: EnemyOverride = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'abilities' || key === 'model' || key === 'height') continue;
    if (!isOneOf(ENEMY_STAT_KEYS, key) || !stats.includes(key)) return `${typeId} has no field "${key}"`;
    const n = checkNumber(key, ENEMY_STATS[key], v);
    if (typeof n === 'string') return n;
    out[key] = n;
  }
  const modelError = parseModelFields(value, out, ENEMY_MODELS[typeId]);
  if (modelError) return modelError;
  if (value.abilities !== undefined) {
    if (!isRecord(value.abilities)) return 'abilities must be an object keyed by ability index';
    const list = def.behaviour === 'monster' ? def.abilities : [];
    const abilities: Partial<Record<string, AbilityPatch>> = {};
    for (const [index, patch] of Object.entries(value.abilities)) {
      if (!ABILITY_INDEX.test(index)) return `ability index "${index}" must be a plain number like 0 or 1`;
      if (!isRecord(patch)) return `abilities.${index} must be an object`;
      const ability = list[Number(index)];
      const mismatch = !ability ? `${typeId} has no ability ${index}` : patch.kind !== ability.kind ? `abilities.${index} is for a ${String(patch.kind)} ability, but ability ${index} is a ${ability.kind}` : null;
      if (mismatch || !ability) {
        if (!stale) return mismatch ?? `${typeId} has no ability ${index}`;
        stale(mismatch ?? `${typeId} has no ability ${index}`);
        continue;
      }
      const fields = ABILITY_FIELDS[ability.kind];
      const parsed: AbilityPatch = { kind: ability.kind };
      for (const [key, v] of Object.entries(patch)) {
        if (key === 'kind') continue;
        if (!isOneOf(ABILITY_NUMBER_KEYS, key) || !fields.includes(key)) return `a ${ability.kind} ability has no field "${key}"`;
        const n = checkNumber(`abilities.${index}.${key}`, ABILITY_NUMBERS[key], v);
        if (typeof n === 'string') return n;
        parsed[key] = n;
      }
      const pace = abilityPaceError(ability, parsed, index);
      if (pace) return pace;
      abilities[index] = parsed;
    }
    out.abilities = abilities;
  }
  return normalizeEnemyOverride(typeId, out);
}

const BULLET_KINDS: ReadonlySet<AbilityKind> = new Set(['shoot', 'ring']);

/**
 * A cooldown of 0 is only allowed where the code uses it (a suicide explode fires once and dies);
 * bullet abilities also need cooldown plus telegraph of at least MIN_BULLET_INTERVAL.
 */
function abilityPaceError(a: Ability, patch: AbilityPatch, index: string): string | null {
  const cooldown = patch.cooldown ?? a.cooldown;
  const windup = patch.windup ?? a.windup;
  if (patch.cooldown !== undefined && patch.cooldown < MIN_BULLET_INTERVAL && a.cooldown > 0) return `abilities.${index}.cooldown must be at least ${MIN_BULLET_INTERVAL} for this ability`;
  if (BULLET_KINDS.has(a.kind) && cooldown + windup < MIN_BULLET_INTERVAL) return `abilities.${index}: cooldown plus telegraph must be at least ${MIN_BULLET_INTERVAL} for an ability that fires bullets`;
  return null;
}

export function parseMinionOverride(typeId: MinionTypeId, value: unknown): MinionOverride | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  const out: MinionOverride = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'model' || key === 'height') continue;
    if (!isOneOf(MINION_STAT_KEYS, key)) return `${typeId} has no field "${key}"`;
    const n = checkNumber(key, MINION_STATS[key], v);
    if (typeof n === 'string') return n;
    out[key] = n;
  }
  const modelError = parseModelFields(value, out, MINION_MODELS[typeId]);
  if (modelError) return modelError;
  return normalizeMinionOverride(typeId, out);
}

/** Drops values equal to the code default, so "overridden" always means "differs from the code". */
export function normalizeEnemyOverride(typeId: EnemyTypeId, o: EnemyOverride): EnemyOverride {
  const def = ENEMIES[typeId];
  const out: EnemyOverride = {};
  for (const key of enemyStatKeys(def)) {
    const v = o[key];
    if (v !== undefined && v !== enemyStatDefault(def, key)) out[key] = v;
  }
  if (o.abilities && def.behaviour === 'monster') {
    const abilities: Partial<Record<string, AbilityPatch>> = {};
    def.abilities.forEach((a, i) => {
      const patch = o.abilities?.[String(i)];
      if (!patch || patch.kind !== a.kind) return;
      const kept: AbilityPatch = { kind: a.kind };
      let changed = false;
      for (const key of ABILITY_FIELDS[a.kind]) {
        const v = patch[key];
        if (v !== undefined && v !== abilityDefault(a, key)) {
          kept[key] = v;
          changed = true;
        }
      }
      if (changed) abilities[String(i)] = kept;
    });
    if (Object.keys(abilities).length > 0) out.abilities = abilities;
  }
  if (o.model !== undefined) out.model = o.model;
  if (o.height !== undefined) out.height = o.height;
  return out;
}

export function normalizeMinionOverride(typeId: MinionTypeId, o: MinionOverride): MinionOverride {
  const def = MINION_DEFS[typeId];
  const out: MinionOverride = {};
  for (const key of MINION_STAT_KEYS) {
    const v = o[key];
    if (v !== undefined && v !== def[key]) out[key] = v;
  }
  if (o.model !== undefined) out.model = o.model;
  if (o.height !== undefined) out.height = o.height;
  return out;
}

export function isEmptyOverride(o: EnemyOverride | MinionOverride): boolean {
  return Object.keys(o).length === 0;
}

/** Stored or sent overrides, one type at a time, skipping (and reporting) types that no longer pass. */
export function parseTuningOverrides(value: unknown, warn: (why: string) => void = () => undefined): TuningOverrides {
  const out = emptyTuning();
  if (!isRecord(value)) return out;
  const monsters = isRecord(value.monsters) ? value.monsters : {};
  for (const [id, raw] of Object.entries(monsters)) {
    if (!isEnemyTypeId(id)) {
      warn(`unknown monster type ${id}`);
      continue;
    }
    const o = parseEnemyOverride(id, raw, (why) => warn(`${id}: dropped an ability patch: ${why}`));
    if (typeof o === 'string') warn(`${id}: ${o}`);
    else if (!isEmptyOverride(o)) out.monsters[id] = o;
  }
  const minions = isRecord(value.minions) ? value.minions : {};
  for (const [id, raw] of Object.entries(minions)) {
    if (!isMinionTypeId(id)) {
      warn(`unknown minion type ${id}`);
      continue;
    }
    const o = parseMinionOverride(id, raw);
    if (typeof o === 'string') warn(`${id}: ${o}`);
    else if (!isEmptyOverride(o)) out.minions[id] = o;
  }
  return out;
}

function modelOf(o: { model?: MonsterModelId; height?: number } | undefined): ModelOverride | null {
  if (!o || (o.model === undefined && o.height === undefined)) return null;
  const m: ModelOverride = {};
  if (o.model !== undefined) m.model = o.model;
  if (o.height !== undefined) m.height = o.height;
  return m;
}

export function modelOverridesOf(t: TuningOverrides): ModelOverrides {
  const out: ModelOverrides = { monsters: {}, minions: {} };
  for (const id of ENEMY_TYPE_IDS) {
    const m = modelOf(t.monsters[id]);
    if (m) out.monsters[id] = m;
  }
  for (const id of MINION_TYPE_IDS) {
    const m = modelOf(t.minions[id]);
    if (m) out.minions[id] = m;
  }
  return out;
}

function unknownModelKey(raw: Record<string, unknown>): string | null {
  const key = Object.keys(raw).find((k) => k !== 'model' && k !== 'height');
  return key === undefined ? null : `unknown field "${key}"`;
}

/** The client's check on the 'models' message: only model and height, only known types and models. */
export function parseModelOverrides(value: unknown): ModelOverrides | string {
  if (!isRecord(value) || !isRecord(value.monsters) || !isRecord(value.minions)) return 'Expected monsters and minions';
  const out: ModelOverrides = { monsters: {}, minions: {} };
  for (const [id, raw] of Object.entries(value.monsters)) {
    if (!isEnemyTypeId(id) || !isRecord(raw)) return `bad monster entry ${id}`;
    const m: ModelOverride = {};
    const err = unknownModelKey(raw) ?? parseModelFields(raw, m, ENEMY_MODELS[id]);
    if (err) return err;
    out.monsters[id] = m;
  }
  for (const [id, raw] of Object.entries(value.minions)) {
    if (!isMinionTypeId(id) || !isRecord(raw)) return `bad minion entry ${id}`;
    const m: ModelOverride = {};
    const err = unknownModelKey(raw) ?? parseModelFields(raw, m, MINION_MODELS[id]);
    if (err) return err;
    out.minions[id] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Applying overrides

function pickNumbers<K extends string>(keys: readonly K[], o: Partial<Record<K, number>> | undefined): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  if (!o) return out;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function resolveAbility(a: Ability, patch: AbilityPatch | undefined): Ability {
  if (!patch || patch.kind !== a.kind) return a;
  // Only the kind's own fields, so a patch can never add a number the ability does not read.
  return Object.assign({}, a, pickNumbers(ABILITY_FIELDS[a.kind], patch));
}

export function resolveEnemy(def: EnemyDef, o: EnemyOverride | undefined): EnemyDef {
  if (!o) return def;
  const stats = pickNumbers(enemyStatKeys(def), o);
  if (def.behaviour !== 'monster') return Object.assign({}, def, stats);
  const abilities = def.abilities.map((a, i) => resolveAbility(a, o.abilities?.[String(i)]));
  return Object.assign({}, def, stats, { abilities });
}

export function resolveMinion(def: MinionDef, o: MinionOverride | undefined): MinionDef {
  return o ? Object.assign({}, def, pickNumbers(MINION_STAT_KEYS, o)) : def;
}

/** Slowest shot the simulation will fire. A ranged shot lives range / speed seconds, so zero would never expire. */
export const MIN_PROJECTILE_SPEED = 10;

/**
 * The definitions a simulation spawns from: the code's, with the admin's overrides on top. Resolved
 * once per type and kept, so spawning stays as cheap as reading ENEMIES. A change makes a new
 * instance; monsters already alive keep the definition they spawned with.
 */
export class MonsterTuning {
  private readonly enemies = new Map<EnemyTypeId, EnemyDef>();
  private readonly minionDefs = new Map<MinionTypeId, MinionDef>();

  constructor(readonly overrides: TuningOverrides = emptyTuning()) {}

  enemy(typeId: EnemyTypeId): EnemyDef {
    let d = this.enemies.get(typeId);
    if (!d) {
      d = resolveEnemy(ENEMIES[typeId], this.overrides.monsters[typeId]);
      this.enemies.set(typeId, d);
    }
    return d;
  }

  minion(typeId: MinionTypeId): MinionDef {
    let d = this.minionDefs.get(typeId);
    if (!d) {
      d = resolveMinion(MINION_DEFS[typeId], this.overrides.minions[typeId]);
      this.minionDefs.set(typeId, d);
    }
    return d;
  }
}

export const BASE_TUNING = new MonsterTuning();
