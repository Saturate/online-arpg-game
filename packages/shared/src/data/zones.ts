import type { Biome } from './monsterPools.js';

/**
 * The overworld: a chain of zones with rising monster levels, D2 act style. The first zone has the
 * town built into its west edge, so leaving town is a walk, not a load. Each zone has a waypoint
 * that a character unlocks by visiting it once.
 */

export const ZONE_IDS = ['barrens', 'steppe', 'gloomvale', 'thornwood', 'dunes', 'hollows'] as const;
export type ZoneId = (typeof ZONE_IDS)[number];


export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** Monster levels from the entrance to the far end of the zone. */
  levels: readonly [number, number];
  /** Which monster pool the zone draws from. */
  biome: Biome;
  groundTint: number;
  /** Dead trees instead of green ones, for bleak places. */
  bleak: boolean;
}

export const ZONES: Record<ZoneId, ZoneDef> = {
  barrens: { id: 'barrens', name: 'Mossy Barrens', levels: [1, 3], biome: 'meadow', groundTint: 0x5c6b3e, bleak: false },
  steppe: { id: 'steppe', name: 'Ashen Steppe', levels: [4, 6], biome: 'ruins', groundTint: 0x6b6558, bleak: true },
  gloomvale: { id: 'gloomvale', name: 'Gloomvale', levels: [7, 10], biome: 'marsh', groundTint: 0x445244, bleak: true },
  thornwood: { id: 'thornwood', name: 'Thornwood', levels: [11, 14], biome: 'forest', groundTint: 0x3f5a34, bleak: false },
  dunes: { id: 'dunes', name: 'Sunscorched Dunes', levels: [15, 19], biome: 'desert', groundTint: 0x8a7448, bleak: true },
  hollows: { id: 'hollows', name: 'The Hollows', levels: [20, 25], biome: 'cave', groundTint: 0x4a4038, bleak: true },
};

/** The zone every instance starts in; it contains the town. */
export const HOME_ZONE: ZoneId = 'barrens';

export function isZoneId(v: unknown): v is ZoneId {
  return typeof v === 'string' && ZONE_IDS.some((z) => z === v);
}

export function nextZone(id: ZoneId): ZoneId | null {
  return ZONE_IDS[ZONE_IDS.indexOf(id) + 1] ?? null;
}

export function previousZone(id: ZoneId): ZoneId | null {
  const i = ZONE_IDS.indexOf(id);
  return i > 0 ? (ZONE_IDS[i - 1] ?? null) : null;
}

/** Most players an instance holds, like a D2 game. */
export const INSTANCE_CAPACITY = 6;
