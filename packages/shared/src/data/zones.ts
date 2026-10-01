import type { Biome } from './monsterPools.js';

/**
 * The regions of the seamless world (`world/worldPlan.ts`), which were zones of their own before:
 * each is a theme (name, monster biome, ground colour). Their levels are the bands the zones had;
 * in the world a region's monster levels come from its distance from town instead.
 */

export const ZONE_IDS = ['barrens', 'steppe', 'gloomvale', 'thornwood', 'dunes', 'hollows'] as const;
export type ZoneId = (typeof ZONE_IDS)[number];


export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** The band this theme had as a zone of its own, before the world. */
  levels: readonly [number, number];
  /** Which monster pool the zone draws from. */
  biome: Biome;
  groundTint: number;
  /** Dead trees instead of green ones, for bleak places. */
  bleak: boolean;
}

export const ZONES: Record<ZoneId, ZoneDef> = {
  barrens: { id: 'barrens', name: 'Mossy Barrens', levels: [1, 3], biome: 'meadow', groundTint: 0x66703f, bleak: false },
  steppe: { id: 'steppe', name: 'Ashen Steppe', levels: [4, 6], biome: 'ruins', groundTint: 0x736c5c, bleak: true },
  gloomvale: { id: 'gloomvale', name: 'Gloomvale', levels: [7, 10], biome: 'marsh', groundTint: 0x4d5a4a, bleak: true },
  thornwood: { id: 'thornwood', name: 'Thornwood', levels: [11, 14], biome: 'forest', groundTint: 0x4a5e3a, bleak: false },
  dunes: { id: 'dunes', name: 'Sunscorched Dunes', levels: [15, 19], biome: 'desert', groundTint: 0x958050, bleak: true },
  hollows: { id: 'hollows', name: 'The Hollows', levels: [20, 25], biome: 'cave', groundTint: 0x544a40, bleak: true },
};

export function isZoneId(v: unknown): v is ZoneId {
  return typeof v === 'string' && ZONE_IDS.some((z) => z === v);
}

/** Most players a world holds; the public world opens another copy once one is full. */
export const INSTANCE_CAPACITY = 8;
