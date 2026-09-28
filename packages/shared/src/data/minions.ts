export type MinionDefaultBehaviour = 'guard' | 'kite' | 'hunt';

export const MINION_TYPE_IDS = ['zombie_brute', 'skeleton_archer', 'wraith'] as const;
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
};

export const STANCES = ['aggressive', 'defensive', 'follow'] as const;
export type Stance = (typeof STANCES)[number];

export function isMinionTypeId(value: unknown): value is MinionTypeId {
  return typeof value === 'string' && MINION_TYPE_IDS.some((id) => id === value);
}
