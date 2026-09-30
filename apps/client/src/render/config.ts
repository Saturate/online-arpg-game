import type { ElementId, ItemTier, SpellFx } from '@rune/shared';

/**
 * Camera and look. The camera is orthographic and locked: it follows the player but never rotates,
 * so screen directions always map to the same world directions. Yaw 45 gives the Diablo 2 diamond
 * view; yaw 0 with a steeper pitch gives a Realm of the Mad God style straight-on view.
 */
export const VIEW = {
  yawDegrees: 45,
  pitchDegrees: 52,
  /** World units visible from top to bottom of the screen. */
  viewHeight: 540,
  cameraDistance: 1800,
  shadowExtent: 900,
  shakeDecayPerSecond: 12,
  shakeOnHit: 7,
  correctionSmoothingPerSecond: 18,
} as const;

export const COLORS = {
  background: 0x07070b,
  floorBase: '#2a2622',
  wall: 0x3b3530,
  torch: 0xff9a40,
  selfRing: 0xffd36b,
  allyRing: 0x6bb6ff,
  playerProjectile: 0xb8c4d0,
  enemyBullet: 0xff2ee0,
  enemyBulletOutline: 0xffffff,
  rareOutline: 0xffc640,
  heal: 0x7dff8a,
  ward: 0x6ff0d0,
  damage: 0xffffff,
  mixed: 0xd0a0ff,
  shield: 0x6ff0d0,
  burningShield: 0xff8a3a,
} as const;

export const ELEMENT_COLORS: Record<ElementId, number> = {
  fire: 0xff6a2b,
  cold: 0x6ad0ff,
  lightning: 0xf5e663,
};

export const TIER_COLORS: Record<ItemTier, number> = {
  common: 0xc8c8c8,
  magic: 0x6b8cff,
  rare: 0xffd84a,
  relic: 0xff7a2a,
};

/** Hand-named items: a worn bronze gold, apart from rare yellow and relic orange, like D2's uniques. */
export const UNIQUE_COLOR = 0xc9a15c;

export function fxColor(fx: SpellFx, el: ElementId | null): number {
  if (el) return ELEMENT_COLORS[el];
  switch (fx) {
    case 'heal':
      return COLORS.heal;
    case 'ward':
      return COLORS.ward;
    case 'mixed':
      return COLORS.mixed;
    case 'damage':
      return COLORS.damage;
  }
}

export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export const FX = {
  damageNumberSeconds: 0.9,
  /** Low-quality projectile trail puffs per second, independent of frame rate. */
  trailHz: 30,
  /** Render smoothing snaps instead of blending when a reconcile moves the player further than this. */
  maxSmoothedCorrection: 100,
  torchCount: 10,
} as const;

/**
 * Draw order of see-through things. Roads and plazas are transparent ground meshes at order 0, and
 * three sorts the transparent pass by this before distance, so every ground effect is ordered above
 * them instead of being lifted higher, which would float it off the ground.
 */
export const RENDER_ORDER = {
  /** Selection rings, rare glows and loot pools. */
  groundMark: 1,
  /** Zones, novas, auras, telegraphs, hazards and scorch marks. */
  groundEffect: 2,
  /** Light pools, over the effects they light. */
  groundLight: 3,
  ribbons: 4,
  smoke: 5,
  glow: 6,
} as const;
