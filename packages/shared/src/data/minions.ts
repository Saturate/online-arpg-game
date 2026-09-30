import type { Ability } from './enemies.js';

export type MinionDefaultBehaviour = 'guard' | 'kite' | 'hunt';

export const MINION_TYPE_IDS = ['zombie_brute', 'skeleton_archer', 'wraith', 'hound'] as const;
export type MinionTypeId = (typeof MINION_TYPE_IDS)[number];

export interface MinionDef {
  id: MinionTypeId;
  name: string;
  life: number;
  moveSpeed: number;
  radius: number;
  damage: number;
  attackCooldown: number;
  attackRange: number;
  ranged: boolean;
  projectileSpeed: number;
  /** Kiting minions back off when an enemy is closer than this. */
  kiteDistance: number;
  defaultBehaviour: MinionDefaultBehaviour;
  color: number;
  /**
   * Cooldown abilities in the monster ability format, so a minion that does what a monster does
   * shares its data. Only `leap` is read so far (the Hound pack's Leader).
   */
  abilities?: readonly Ability[];
  /** One vessel binds a pack: a Leader and packmates (sim/minions.ts, HOUND_PACK). */
  pack?: boolean;
}

export const MINION_DEFS: Record<MinionTypeId, MinionDef> = {
  zombie_brute: {
    id: 'zombie_brute',
    name: 'Zombie Brute',
    life: 220,
    moveSpeed: 150,
    radius: 17,
    damage: 14,
    attackCooldown: 1,
    attackRange: 30,
    ranged: false,
    projectileSpeed: 0,
    kiteDistance: 0,
    defaultBehaviour: 'guard',
    color: 0x6b8e4e,
  },
  skeleton_archer: {
    id: 'skeleton_archer',
    name: 'Skeleton Archer',
    life: 90,
    moveSpeed: 180,
    radius: 12,
    damage: 10,
    attackCooldown: 0.9,
    attackRange: 330,
    ranged: true,
    projectileSpeed: 480,
    kiteDistance: 170,
    defaultBehaviour: 'kite',
    color: 0xd8d0b8,
  },
  wraith: {
    id: 'wraith',
    name: 'Wraith',
    life: 110,
    moveSpeed: 265,
    radius: 13,
    damage: 12,
    attackCooldown: 0.5,
    attackRange: 26,
    ranged: false,
    projectileSpeed: 0,
    kiteDistance: 0,
    defaultBehaviour: 'hunt',
    color: 0x7fa8d8,
  },
  // The owner's brother's dog, the Grave Hound's model in the ally tint. These are the Leader's
  // base numbers; the Leader and its packmates scale them (HOUND_PACK in config/sim.ts).
  hound: {
    id: 'hound',
    name: 'Hound',
    life: 130,
    moveSpeed: 205,
    radius: 17,
    damage: 11,
    attackCooldown: 0.8,
    attackRange: 24,
    ranged: false,
    projectileSpeed: 0,
    kiteDistance: 0,
    defaultBehaviour: 'hunt',
    color: 0x6f7a62,
    // The Grave Hound's pounce with a longer reach (480 against 400), no telegraph since it is an ally.
    abilities: [{ kind: 'leap', cooldown: 6, range: 480, windup: 0.25, minRange: 110, radius: 60, damage: 24, duration: 0.5 }],
    pack: true,
  },
};

export const STANCES = ['aggressive', 'defensive', 'follow'] as const;
export type Stance = (typeof STANCES)[number];

export function isMinionTypeId(value: unknown): value is MinionTypeId {
  return typeof value === 'string' && MINION_TYPE_IDS.some((id) => id === value);
}
