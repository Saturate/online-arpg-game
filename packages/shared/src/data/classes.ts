import type { ARMOR } from '../config/sim.js';
import type { RuneId } from '../runes/v2/runes.js';

export type ArmorType = keyof typeof ARMOR.values;

export type PrimaryAttackDef =
  | {
      kind: 'melee';
      damage: number;
      cooldown: number;
      range: number;
      /** Full arc width in radians. */
      arc: number;
    }
  | {
      kind: 'bolt';
      damage: number;
      cooldown: number;
      speed: number;
      range: number;
      radius: number;
    };

export interface ClassDef {
  id: ClassId;
  name: string;
  armor: ArmorType;
  life: number;
  moveSpeed: number;
  primary: PrimaryAttackDef;
  /** Runes this class casts for less Force (HEAT.affinityMultiplier). */
  affinityRunes: RuneId[];
  baseSpirit: number;
  color: number;
  /** Reserved for ascendancies, which are out of scope for the demo. */
  ascendancies: string[];
}

export const CLASS_IDS = ['warrior', 'ranger', 'mage', 'priest', 'binder'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const CLASSES: Record<ClassId, ClassDef> = {
  warrior: {
    id: 'warrior',
    name: 'Warrior',
    armor: 'heavy',
    life: 140,
    moveSpeed: 190,
    primary: { kind: 'melee', damage: 22, cooldown: 0.45, range: 70, arc: Math.PI * 0.6 },
    affinityRunes: ['impact'],
    baseSpirit: 100,
    color: 0xc0504d,
    ascendancies: [],
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    armor: 'light',
    life: 100,
    moveSpeed: 220,
    primary: { kind: 'bolt', damage: 9, cooldown: 0.2, speed: 700, range: 520, radius: 5 },
    affinityRunes: ['bolt', 'swift'],
    baseSpirit: 100,
    color: 0x6aa84f,
    ascendancies: [],
  },
  mage: {
    id: 'mage',
    name: 'Mage',
    armor: 'robe',
    life: 90,
    moveSpeed: 200,
    primary: { kind: 'bolt', damage: 20, cooldown: 0.5, speed: 380, range: 480, radius: 9 },
    affinityRunes: ['fire', 'cold', 'lightning'],
    baseSpirit: 100,
    color: 0x3d85c6,
    ascendancies: [],
  },
  priest: {
    id: 'priest',
    name: 'Priest',
    armor: 'robe',
    life: 95,
    moveSpeed: 200,
    primary: { kind: 'bolt', damage: 12, cooldown: 0.35, speed: 500, range: 460, radius: 7 },
    affinityRunes: ['ward', 'restore'],
    baseSpirit: 150,
    color: 0xf1c232,
    ascendancies: [],
  },
  binder: {
    id: 'binder',
    name: 'Binder',
    armor: 'robe',
    life: 95,
    moveSpeed: 200,
    primary: { kind: 'bolt', damage: 12, cooldown: 0.35, speed: 500, range: 460, radius: 7 },
    affinityRunes: ['bond'],
    baseSpirit: 120,
    color: 0x8e7cc3,
    ascendancies: [],
  },
};

export function isClassId(value: unknown): value is ClassId {
  return typeof value === 'string' && CLASS_IDS.some((id) => id === value);
}
