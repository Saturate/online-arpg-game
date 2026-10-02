import type { GearCategory } from './gear.js';
import { ADDED_DAMAGE_SPREAD, CASTABLE_SHAPES, isPersistentShape, PROJECTILE_SHAPES, TRIGGERS_FOR_SHAPE, type InfusionId, type ReleaseKind, type RuneId, type ShapeId } from '../runes/v2/runes.js';

export type AffixTarget = 'sigil' | 'vessel' | 'enemy' | 'gear' | 'rune';
export type AffixSlot = 'prefix' | 'suffix';

export interface AffixTierDef {
  weight: number;
  min: number;
  max: number;
  /** The least item level that can roll this tier; without it the item's tier and level caps apply (ilvlAffixTier). */
  ilvl?: number;
}

export interface AffixDef {
  id: AffixId;
  /** `{v}` is replaced by the rolled value. */
  text: string;
  slot: AffixSlot;
  targets: readonly AffixTarget[];
  /** Affixes sharing a group are mutually exclusive on one item. */
  group: string;
  /** Word used in generated item names. */
  nameWord: string;
  /**
   * Tier index 0 is the weakest; stored rolls keep this index. Players read it numbered from the
   * best (Path of Exile style): the last index is T1 (affixTierLabel). Higher item tiers and levels
   * unlock higher tiers.
   */
  tiers: readonly AffixTierDef[];
  /** Values are rounded to this many decimals. */
  decimals?: number;
  /** Gear only: which item categories can roll it. Missing means every category. */
  slots?: readonly GearCategory[];
  /** Runes only: which runes can roll it. */
  runes?: readonly RuneId[];
  /** Shown with a sign ("-64% speed"), because old kit runes from saves go below zero. */
  signed?: boolean;
  /** `{v2}` in the text is the value times this: the high end of an "Adds {v} to {v2}" roll. */
  spread?: number;
}

export const AFFIX_IDS = [
  'heat_reduced',
  'split_efficiency',
  'max_depth',
  'spirit_reduced',
  'area_increased',
  'damage_increased',
  'hasted',
  'extra_projectiles',
  'reflects_projectiles',
  'armored',
  'regenerating',
  'attack_speed',
  'explodes_on_death',
  'taunts',
  'leech_for_master',
  'faster_respawn',
  'bodyguard',
  'hunter',
  'coward',
  'gear_life',
  'gear_armor',
  'gear_move',
  'gear_force',
  'gear_cooling',
  'gear_spirit',
  'gear_damage',
  'gear_cast',
  'gear_attack',
  'gear_regen',
  'gear_minion_damage',
  'gear_minion_life',
  'sigil_slots',
  'cast_delay',
  'multicast',
  'release_onhit',
  'release_onexpire',
  'release_after',
  'release_every',
  'release_onland',
  'rune_speed',
  'rune_size',
  'rune_duration',
  'rune_damage',
  'rune_pierce',
  'split_count',
  'rune_concentrated',
  'rune_added_fire',
  'rune_added_cold',
  'rune_added_lightning',
] as const;
export type AffixId = (typeof AFFIX_IDS)[number];

export const BEHAVIOUR_AFFIXES = ['bodyguard', 'hunter', 'coward'] as const;
export type BehaviourAffixId = (typeof BEHAVIOUR_AFFIXES)[number];

/**
 * Rune affixes have six tiers (owner, 2026-10-01): T6 to T2 split the old three tiers' range from
 * low to high, and T1 sits above it, rare even at the deepest levels. The weights keep each
 * affix's total weight at every item level what the old three tiers had (100 at level 1, 160 from
 * level 3, 185 at the top), so the mix of number affixes against release affixes does not move.
 */
export const RUNE_AFFIX_TIERS = 6;
const RUNE_TIER_WEIGHTS = [100, 35, 25, 15, 8, 2] as const;
const RUNE_TIER_ILVL = [1, 2, 3, 5, 8, 12] as const;

/**
 * The affix table. Built by a function so the game gets a copy live tuning may overwrite in place
 * (AFFIXES) and the code defaults stay readable beside it (codeAffixTiers), for the one-time
 * re-tier of old saves, which must not follow tuning.
 */
function buildAffixes(): Record<AffixId, AffixDef> {
  return {
    heat_reduced: {
      id: 'heat_reduced',
      text: '{v}% reduced Force cost',
      slot: 'prefix',
      targets: ['sigil'],
      group: 'heat',
      nameWord: 'Cool',
      tiers: [
        { weight: 100, min: 5, max: 12 },
        { weight: 60, min: 12, max: 20 },
        { weight: 25, min: 20, max: 30 },
      ],
    },
    split_efficiency: {
      id: 'split_efficiency',
      text: 'Splits keep +{v} damage efficiency',
      slot: 'suffix',
      targets: ['sigil'],
      group: 'split',
      nameWord: 'of Multitudes',
      decimals: 2,
      tiers: [
        { weight: 80, min: 0.05, max: 0.12 },
        { weight: 50, min: 0.12, max: 0.2 },
        { weight: 20, min: 0.2, max: 0.3 },
      ],
    },
    max_depth: {
      id: 'max_depth',
      text: '+{v} maximum payload depth',
      slot: 'suffix',
      targets: ['sigil'],
      group: 'depth',
      nameWord: 'of Recursion',
      tiers: [
        { weight: 0, min: 1, max: 1 },
        { weight: 15, min: 1, max: 1 },
        { weight: 25, min: 1, max: 1 },
      ],
    },
    spirit_reduced: {
      id: 'spirit_reduced',
      text: 'Persistent skill reserves {v}% less spirit',
      slot: 'prefix',
      targets: ['sigil'],
      group: 'spirit',
      nameWord: 'Frugal',
      tiers: [
        { weight: 80, min: 8, max: 15 },
        { weight: 50, min: 15, max: 25 },
        { weight: 20, min: 25, max: 35 },
      ],
    },
    area_increased: {
      id: 'area_increased',
      text: '{v}% increased area',
      slot: 'prefix',
      targets: ['sigil'],
      group: 'area',
      nameWord: 'Vast',
      tiers: [
        { weight: 100, min: 8, max: 15 },
        { weight: 60, min: 15, max: 25 },
        { weight: 25, min: 25, max: 40 },
      ],
    },
    damage_increased: {
      id: 'damage_increased',
      text: '{v}% increased damage',
      slot: 'prefix',
      targets: ['sigil'],
      group: 'damage',
      nameWord: 'Potent',
      tiers: [
        { weight: 100, min: 10, max: 20 },
        { weight: 60, min: 20, max: 35 },
        { weight: 25, min: 35, max: 55 },
      ],
    },
    hasted: {
      id: 'hasted',
      text: '{v}% increased movement speed',
      slot: 'prefix',
      targets: ['enemy', 'vessel'],
      group: 'speed',
      nameWord: 'Hasted',
      tiers: [
        { weight: 100, min: 20, max: 30 },
        { weight: 60, min: 30, max: 45 },
        { weight: 25, min: 45, max: 60 },
      ],
    },
    extra_projectiles: {
      id: 'extra_projectiles',
      text: '+{v} projectiles',
      slot: 'suffix',
      targets: ['enemy', 'vessel'],
      group: 'projectiles',
      nameWord: 'of Volleys',
      tiers: [
        { weight: 80, min: 1, max: 1 },
        { weight: 50, min: 1, max: 2 },
        { weight: 25, min: 2, max: 3 },
      ],
    },
    reflects_projectiles: {
      id: 'reflects_projectiles',
      text: '{v}% chance to reflect projectiles',
      slot: 'suffix',
      targets: ['enemy'],
      group: 'reflect',
      nameWord: 'of Mirrors',
      tiers: [
        { weight: 60, min: 20, max: 30 },
        { weight: 40, min: 30, max: 45 },
        { weight: 20, min: 45, max: 60 },
      ],
    },
    armored: {
      id: 'armored',
      text: '{v}% increased life',
      slot: 'prefix',
      targets: ['enemy', 'vessel'],
      group: 'life',
      nameWord: 'Armored',
      tiers: [
        { weight: 100, min: 30, max: 50 },
        { weight: 60, min: 50, max: 80 },
        { weight: 25, min: 80, max: 120 },
      ],
    },
    regenerating: {
      id: 'regenerating',
      text: 'Regenerates {v}% life per second',
      slot: 'suffix',
      targets: ['enemy', 'vessel'],
      group: 'regen',
      nameWord: 'of Renewal',
      decimals: 1,
      tiers: [
        { weight: 80, min: 1, max: 2 },
        { weight: 50, min: 2, max: 3 },
        { weight: 25, min: 3, max: 4.5 },
      ],
    },
    attack_speed: {
      id: 'attack_speed',
      text: '{v}% increased attack speed',
      slot: 'prefix',
      targets: ['vessel'],
      group: 'attack_speed',
      nameWord: 'Frenzied',
      tiers: [
        { weight: 100, min: 10, max: 20 },
        { weight: 60, min: 20, max: 30 },
        { weight: 25, min: 30, max: 40 },
      ],
    },
    explodes_on_death: {
      id: 'explodes_on_death',
      text: 'Explodes on death for {v}% of base damage',
      slot: 'suffix',
      targets: ['vessel'],
      group: 'explode',
      nameWord: 'of Cinders',
      tiers: [
        { weight: 60, min: 80, max: 110 },
        { weight: 40, min: 110, max: 150 },
        { weight: 20, min: 150, max: 200 },
      ],
    },
    taunts: {
      id: 'taunts',
      text: 'Taunts enemies within {v} units',
      slot: 'suffix',
      targets: ['vessel'],
      group: 'taunt',
      nameWord: 'of Provocation',
      tiers: [
        { weight: 60, min: 120, max: 150 },
        { weight: 40, min: 150, max: 180 },
        { weight: 20, min: 180, max: 220 },
      ],
    },
    leech_for_master: {
      id: 'leech_for_master',
      text: 'Leeches {v}% of damage dealt as life for its master',
      slot: 'suffix',
      targets: ['vessel'],
      group: 'leech',
      nameWord: 'of Devotion',
      tiers: [
        { weight: 60, min: 5, max: 8 },
        { weight: 40, min: 8, max: 12 },
        { weight: 20, min: 12, max: 16 },
      ],
    },
    faster_respawn: {
      id: 'faster_respawn',
      text: 'Respawns {v}% faster',
      slot: 'prefix',
      targets: ['vessel'],
      group: 'respawn',
      nameWord: 'Undying',
      tiers: [
        { weight: 80, min: 15, max: 25 },
        { weight: 50, min: 25, max: 35 },
        { weight: 25, min: 35, max: 50 },
      ],
    },
    bodyguard: {
      id: 'bodyguard',
      text: 'Bodyguard: stays near its master and intercepts projectiles',
      slot: 'prefix',
      targets: ['vessel'],
      group: 'behaviour',
      nameWord: 'Loyal',
      tiers: [{ weight: 40, min: 1, max: 1 }],
    },
    hunter: {
      id: 'hunter',
      text: 'Hunter: roams to engage rare enemies',
      slot: 'prefix',
      targets: ['vessel'],
      group: 'behaviour',
      nameWord: 'Hunting',
      tiers: [{ weight: 40, min: 1, max: 1 }],
    },
    gear_life: gearAffix('gear_life', '+{v} to maximum life', 'prefix', 'Hale', [[8, 15], [15, 28], [28, 45]]),
    gear_armor: gearAffix('gear_armor', '+{v} to armour', 'prefix', 'Iron', [[5, 10], [10, 20], [20, 35]], ['helmet', 'body', 'gloves', 'boots', 'belt']),
    gear_move: gearAffix('gear_move', '{v}% increased movement speed', 'prefix', 'Swift', [[4, 8], [8, 12], [12, 18]], ['boots']),
    gear_force: gearAffix('gear_force', '+{v} to maximum Force', 'prefix', 'Focused', [[20, 40], [40, 70], [70, 110]], ['helmet', 'amulet', 'ring', 'weapon']),
    gear_cooling: gearAffix('gear_cooling', '{v}% faster Force recovery', 'suffix', 'of Calm', [[6, 12], [12, 20], [20, 30]], ['body', 'amulet', 'ring', 'helmet']),
    gear_spirit: gearAffix('gear_spirit', '+{v} to spirit', 'suffix', 'of the Soul', [[5, 10], [10, 16], [16, 24]], ['amulet', 'body', 'weapon']),
    gear_damage: gearAffix('gear_damage', '{v}% increased damage', 'prefix', 'Cruel', [[6, 12], [12, 20], [20, 32]], ['weapon', 'ring', 'amulet', 'gloves']),
    gear_cast: gearAffix('gear_cast', '{v}% increased cast speed', 'suffix', 'of Haste', [[5, 9], [9, 14], [14, 20]], ['weapon', 'gloves', 'amulet']),
    gear_attack: gearAffix('gear_attack', '{v}% increased attack speed', 'suffix', 'of Fury', [[5, 9], [9, 14], [14, 20]], ['weapon', 'gloves', 'ring']),
    gear_regen: gearAffix('gear_regen', 'Regenerate {v} life per second', 'suffix', 'of Mending', [[1, 2], [2, 3.5], [3.5, 5]], ['body', 'belt', 'ring', 'amulet'], 1),
    gear_minion_damage: gearAffix('gear_minion_damage', 'Minions deal {v}% increased damage', 'prefix', 'Commanding', [[8, 15], [15, 25], [25, 40]], ['weapon', 'helmet', 'amulet']),
    gear_minion_life: gearAffix('gear_minion_life', 'Minions have {v}% increased life', 'suffix', 'of the Horde', [[8, 15], [15, 25], [25, 40]], ['body', 'belt', 'helmet']),
    sigil_slots: {
      id: 'sigil_slots',
      text: '+{v} rune slots',
      slot: 'suffix',
      targets: ['sigil'],
      group: 'slots',
      nameWord: 'of Chambers',
      tiers: [
        { weight: 70, min: 1, max: 1 },
        { weight: 45, min: 1, max: 2 },
        { weight: 25, min: 2, max: 3 },
      ],
    },
    cast_delay: {
      id: 'cast_delay',
      text: '{v}% reduced cast delay',
      slot: 'prefix',
      targets: ['sigil'],
      group: 'cast_delay',
      nameWord: 'Quick',
      tiers: [
        { weight: 80, min: 5, max: 10 },
        { weight: 50, min: 10, max: 18 },
        { weight: 20, min: 18, max: 25 },
      ],
    },
    // Rule-breaking rolls permit one of a kind (docs/features/runes.md), so these only reach +1 and only on rares.
    multicast: {
      id: 'multicast',
      text: '+{v} shape cast together (multicast)',
      slot: 'suffix',
      targets: ['sigil'],
      group: 'multicast',
      nameWord: 'of Echoes',
      tiers: [
        { weight: 0, min: 1, max: 1 },
        { weight: 0, min: 1, max: 1 },
        { weight: 15, min: 1, max: 1 },
      ],
    },
    release_onhit: releaseAffix('release_onhit', 'onhit', 'Releases its payload on hit', 'of Impact'),
    release_onexpire: releaseAffix('release_onexpire', 'onexpire', 'Releases its payload when it expires', 'of Endings'),
    release_after: {
      ...releaseAffix('release_after', 'after', 'Releases its payload after {v} s', 'of Fuses'),
      decimals: 1,
      tiers: [{ weight: 100, min: 0.3, max: 1.2 }],
    },
    release_every: {
      ...releaseAffix('release_every', 'every', 'Releases its payload every {v} s', 'of Pulses'),
      decimals: 2,
      // Faster pulses are the stronger roll, so the short intervals wait for higher item levels. T1
      // reaches the 0.18 s the old Frozen Orb kit pulsed at.
      tiers: runeTiers([[0.52, 0.6], [0.44, 0.51], [0.36, 0.43], [0.28, 0.35], [0.2, 0.27], [0.15, 0.19]]),
    },
    release_onland: releaseAffix('release_onland', 'onland', 'Releases its payload on landing', 'of Landing'),
    // T1 is "super good" (owner): it reaches the old kits' hand-set rolls (Fireball's +100% damage
    // Orb, Blink's +69% speed, Bone Spear's pierce 4) and stays rare by weight and item level. The
    // damage-per-Force cap is a report, not a limit; docs/features/runes.md, "Rolled runes".
    rune_speed: runeAffix('rune_speed', '{v}% speed', 'Fleet', shapesWhere((s) => s === 'orb' || s === 'bolt' || s === 'dash'), [[10, 17], [18, 25], [26, 33], [34, 41], [42, 50], [51, 70]]),
    rune_size: runeAffix('rune_size', '{v}% size', 'Broad', shapesWhere((s) => s !== 'dash' && s !== 'bond'), [[10, 17], [18, 25], [26, 33], [34, 41], [42, 50], [51, 75]]),
    rune_duration: runeAffix('rune_duration', '{v}% duration', 'Lasting', shapesWhere((s) => s === 'orb' || s === 'bolt' || s === 'zone'), [[15, 26], [27, 38], [39, 50], [51, 62], [63, 75], [76, 100]]),
    rune_damage: runeAffix('rune_damage', '{v}% damage', 'Honed', shapesWhere((s) => !isPersistentShape(s)), [[10, 18], [19, 27], [28, 36], [37, 45], [46, 55], [56, 100]]),
    // Whole numbers with few values: neighbouring tiers share an end.
    rune_pierce: {
      ...runeAffix('rune_pierce', 'Pierces {v} enemies', 'Piercing', shapesWhere((s) => PROJECTILE_SHAPES.includes(s)), [[1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [4, 4]]),
      signed: false,
    },
    split_count: {
      id: 'split_count',
      text: 'Makes {v} copies',
      slot: 'prefix',
      targets: ['rune'],
      group: 'split_count',
      nameWord: 'Manifold',
      runes: ['split'],
      // The grammar stops at 6 copies (SPLIT_COUNT_RANGE), so T1 cannot go past T2's best.
      tiers: runeTiers([[2, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 6]]),
    },
    // Every Concentrated drop rolls this (docs/features/runes.md); the tiers lift its amount with item level.
    rune_concentrated: {
      id: 'rune_concentrated',
      text: '{v}% more damage',
      slot: 'prefix',
      targets: ['rune'],
      group: 'rune_concentrated',
      nameWord: 'Dense',
      runes: ['concentrated'],
      // The grammar stops at 60% (CONCENTRATED.maxMore), so T1 cannot go past T2's best.
      tiers: runeTiers([[40, 43], [44, 47], [48, 51], [52, 55], [56, 60], [60, 60]]),
    },
    // Flat elemental damage on every hit, on top of the shape's base range and without converting it
    // (docs/features/runes.md, "Damage packets"). The roll is the low end; the high end is twice it.
    // Its average, 1.5x the roll, is about the share of a 16-damage Bolt hit the damage affix's tier
    // gives (T6 1 to 2 is +9 to 19%, T1 7 to 9 is +66 to 84%); Force prices it per shape.
    rune_added_fire: addedAffix('rune_added_fire', 'fire', 'Smouldering'),
    rune_added_cold: addedAffix('rune_added_cold', 'cold', 'Rimed'),
    rune_added_lightning: addedAffix('rune_added_lightning', 'lightning', 'Crackling'),
    coward: {
      id: 'coward',
      text: 'Coward: retreats at low life to heal',
      slot: 'prefix',
      targets: ['vessel'],
      group: 'behaviour',
      nameWord: 'Craven',
      tiers: [{ weight: 40, min: 1, max: 1 }],
    },
  };
}

export const AFFIXES: Record<AffixId, AffixDef> = buildAffixes();
const CODE_AFFIXES: Record<AffixId, AffixDef> = buildAffixes();

/** The affix's tiers as the code defines them, whatever live tuning has set. */
export function codeAffixTiers(id: AffixId): readonly AffixTierDef[] {
  return CODE_AFFIXES[id].tiers;
}

function gearAffix(
  id: AffixId,
  text: string,
  slot: AffixSlot,
  nameWord: string,
  ranges: readonly [number, number][],
  slots?: readonly GearCategory[],
  decimals = 0,
): AffixDef {
  return {
    id,
    text,
    slot,
    targets: ['gear'],
    group: id,
    nameWord,
    decimals,
    tiers: ranges.map(([min, max], i) => ({ weight: [100, 55, 22][i] ?? 10, min, max })),
    ...(slots ? { slots } : {}),
  };
}

function shapesWhere(pred: (s: ShapeId) => boolean): ShapeId[] {
  return CASTABLE_SHAPES.filter(pred);
}

/** Release affixes share one group, so a rune rolls at most one, and only shapes that accept that release. */
function releaseAffix(id: AffixId, kind: ReleaseKind, text: string, nameWord: string): AffixDef {
  return {
    id,
    text,
    slot: 'suffix',
    targets: ['rune'],
    group: 'release',
    nameWord,
    runes: shapesWhere((s) => TRIGGERS_FOR_SHAPE[s].includes(kind)),
    tiers: [{ weight: 100, min: 1, max: 1 }],
  };
}

/** Six rune tiers from the weakest (T6) to the best (T1), with their weights and item-level gates. */
function runeTiers(ranges: readonly (readonly [number, number])[]): AffixTierDef[] {
  if (ranges.length !== RUNE_AFFIX_TIERS) throw new Error(`a rune affix needs ${RUNE_AFFIX_TIERS} tiers`);
  return ranges.map(([min, max], i) => ({ weight: RUNE_TIER_WEIGHTS[i] ?? 0, min, max, ilvl: RUNE_TIER_ILVL[i] ?? 1 }));
}

function runeAffix(id: AffixId, text: string, nameWord: string, runes: readonly RuneId[], ranges: readonly (readonly [number, number])[]): AffixDef {
  return {
    id,
    text,
    slot: 'prefix',
    targets: ['rune'],
    group: id,
    nameWord,
    runes,
    signed: true,
    tiers: runeTiers(ranges),
  };
}

function addedAffix(id: AffixId, element: InfusionId, nameWord: string): AffixDef {
  return {
    ...runeAffix(id, `Adds {v} to {v2} ${element} damage`, nameWord, shapesWhere((s) => !isPersistentShape(s)), [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [7, 9]]),
    // One damage affix per rune: a damage roll or one added element (the grammar holds a shape to
    // the same). Stacked with a damage roll, adds doubled the most a shape could hit per Force.
    group: 'rune_damage',
    signed: false,
    spread: ADDED_DAMAGE_SPREAD,
  };
}

/** An affix's line with its value filled in, both ends for an "Adds X to Y" roll. */
export function affixText(def: AffixDef, value: string, high: string): string {
  return def.text.replace('{v}', value).replace('{v2}', high);
}

/** A roll's tier as players read it, counted from the best: the top tier is T1. */
export function affixTierLabel(id: AffixId, tier: number): string {
  return `T${Math.max(1, AFFIXES[id].tiers.length - tier)}`;
}

export function isAffixId(value: unknown): value is AffixId {
  return typeof value === 'string' && AFFIX_IDS.some((id) => id === value);
}
