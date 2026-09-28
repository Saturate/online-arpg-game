export type EnemyBehaviour = 'chaser' | 'shooter' | 'spinner';

interface EnemyBase {
  id: EnemyTypeId;
  name: string;
  life: number;
  moveSpeed: number;
  radius: number;
  contactDamage: number;
  contactCooldown: number;
  color: number;
}

export type EnemyDef =
  | (EnemyBase & { behaviour: 'chaser' })
  | (EnemyBase & {
      behaviour: 'shooter';
      preferredRange: number;
      fireCooldown: number;
      bullets: number;
      spread: number;
      bulletSpeed: number;
      bulletDamage: number;
      bulletRadius: number;
      bulletRange: number;
    })
  | (EnemyBase & {
      behaviour: 'spinner';
      preferredRange: number;
      fireCooldown: number;
      bullets: number;
      rotationPerVolley: number;
      bulletSpeed: number;
      bulletDamage: number;
      bulletRadius: number;
      bulletRange: number;
    });

export const ENEMY_TYPE_IDS = ['chaser', 'shooter', 'spinner'] as const;
export type EnemyTypeId = (typeof ENEMY_TYPE_IDS)[number];

export const ENEMIES: Record<EnemyTypeId, EnemyDef> = {
  chaser: {
    id: 'chaser',
    name: 'Chaser',
    behaviour: 'chaser',
    life: 40,
    moveSpeed: 125,
    radius: 13,
    contactDamage: 10,
    contactCooldown: 0.8,
    color: 0xd9534f,
  },
  shooter: {
    id: 'shooter',
    name: 'Shooter',
    behaviour: 'shooter',
    life: 55,
    moveSpeed: 95,
    radius: 14,
    contactDamage: 6,
    contactCooldown: 1,
    color: 0xe0913a,
    preferredRange: 300,
    fireCooldown: 1.5,
    bullets: 3,
    spread: 0.22,
    bulletSpeed: 270,
    bulletDamage: 9,
    bulletRadius: 6,
    bulletRange: 620,
  },
  spinner: {
    id: 'spinner',
    name: 'Spinner',
    behaviour: 'spinner',
    life: 90,
    moveSpeed: 55,
    radius: 18,
    contactDamage: 8,
    contactCooldown: 1,
    color: 0xb04fd0,
    preferredRange: 340,
    fireCooldown: 1,
    bullets: 8,
    rotationPerVolley: 0.3,
    bulletSpeed: 190,
    bulletDamage: 8,
    bulletRadius: 7,
    bulletRange: 560,
  },
};
