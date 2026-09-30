/**
 * Spell effect quality, a client setting. Low keeps the plain readable shapes spells had before the
 * effects work and only a few particles; Medium adds the shaders, trails and statuses; High raises
 * the particle counts. Every level keeps the same edges and colours, so a spell reads the same at any
 * setting and only its richness changes.
 */
export const VFX_QUALITIES = ['low', 'medium', 'high'] as const;
export type VfxQuality = (typeof VFX_QUALITIES)[number];

export interface QualityLevel {
  /** Additive particles (embers, sparks, glints, cores) alive at once, plus per-frame sprites. */
  glowCapacity: number;
  /** Alpha-blended particles (smoke, mist, dust, debris) alive at once. */
  smokeCapacity: number;
  /** Scorch marks on the ground alive at once. */
  groundCapacity: number;
  /** Multiplier on every emitter's particle count. */
  spawnScale: number;
  /** Most particles one frame may start, so a burst of deaths cannot fill the pool in one go. */
  maxSpawnPerFrame: number;
  /** Shader materials for zones, novas, orbs, auras and tethers; off draws the plain shapes. */
  shaders: boolean;
  /** Ribbon trails behind player projectiles. */
  ribbons: boolean;
  /** Flames, frost and sparks on monsters with a status. */
  statusParticles: boolean;
  /** Spell light through the shared light budget (real lights for the strongest, pools for the rest). */
  groundLight: boolean;
  /** Embers, sparks, smoke and heat shimmer on the world's torches and fires; off keeps only their flames. */
  fireParticles: boolean;
  /** Smoothed frame time the budget starts cutting ambient particles above: about 48 fps, so a 60 Hz display never throttles. */
  frameBudgetMs: number;
}

export const QUALITY: Record<VfxQuality, QualityLevel> = {
  low: { glowCapacity: 400, smokeCapacity: 120, groundCapacity: 0, spawnScale: 0.35, maxSpawnPerFrame: 40, shaders: false, ribbons: false, statusParticles: false, groundLight: false, fireParticles: false, frameBudgetMs: 21 },
  medium: { glowCapacity: 1600, smokeCapacity: 500, groundCapacity: 160, spawnScale: 0.6, maxSpawnPerFrame: 120, shaders: true, ribbons: true, statusParticles: true, groundLight: true, fireParticles: true, frameBudgetMs: 21 },
  high: { glowCapacity: 3200, smokeCapacity: 1000, groundCapacity: 320, spawnScale: 1, maxSpawnPerFrame: 240, shaders: true, ribbons: true, statusParticles: true, groundLight: true, fireParticles: true, frameBudgetMs: 21 },
};

export function isVfxQuality(v: unknown): v is VfxQuality {
  return VFX_QUALITIES.some((q) => q === v);
}

export const QUALITY_LABELS: Record<VfxQuality, string> = { low: 'Low', medium: 'Medium', high: 'High' };
