import type { GearCategory } from './gear.js';

export type AffixTarget = 'sigil' | 'vessel' | 'enemy' | 'gear';
export type AffixSlot = 'prefix' | 'suffix';

export interface AffixTierDef {
  weight: number;
  min: number;
  max: number;
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
  /** Tier index 0 is the weakest. Higher item tiers unlock higher affix tiers. */
  tiers: readonly AffixTierDef[];
  /** Values are rounded to this many decimals. */
  decimals?: number;
  /** Gear only: which item categories can roll it. Missing means every category. */
  slots?: readonly GearCategory[];
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
] as const;
export type AffixId = (typeof AFFIX_IDS)[number];

export const BEHAVIOUR_AFFIXES = ['bodyguard', 'hunter', 'coward'] as const;
export type BehaviourAffixId = (typeof BEHAVIOUR_AFFIXES)[number];

export const AFFIXES: Record<AffixId, AffixDef> = {
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
    text: '+{v} maximum sub-spell depth',
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

export function isAffixId(value: unknown): value is AffixId {
  return typeof value === 'string' && AFFIX_IDS.some((id) => id === value);
}
