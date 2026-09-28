import { ENEMY_TYPE_IDS, familyOf, type EnemyTypeId } from './enemies.js';

/**
 * Which monsters live where. Zones ask for a pool by biome and monster level; low levels only get
 * the simple families, and the tricky ones (summoners, shamans, burrowers) unlock deeper in.
 */

export const BIOMES = ['meadow', 'forest', 'marsh', 'desert', 'crypt', 'cave', 'ruins'] as const;
export type Biome = (typeof BIOMES)[number];

export function isBiome(v: unknown): v is Biome {
  return typeof v === 'string' && BIOMES.some((b) => b === v);
}

interface Habitat {
  biomes: readonly Biome[];
  /** First monster level it appears at. */
  minLevel: number;
}

/** Bosses and adds that only appear through summons are left out, so they never fill a random pack. */
const HABITATS: Partial<Record<EnemyTypeId, Habitat>> = {
  chaser: { biomes: ['meadow', 'forest', 'ruins', 'crypt'], minLevel: 1 },
  shooter: { biomes: ['meadow', 'forest', 'ruins'], minLevel: 1 },
  spinner: { biomes: ['ruins', 'crypt', 'cave'], minLevel: 3 },
  plague_rat: { biomes: ['meadow', 'marsh', 'crypt', 'cave'], minLevel: 1 },
  blood_bat: { biomes: ['cave', 'crypt', 'forest'], minLevel: 2 },
  grave_brute: { biomes: ['crypt', 'ruins'], minLevel: 2 },
  ogre: { biomes: ['marsh', 'forest'], minLevel: 4 },
  bandit_archer: { biomes: ['meadow', 'forest', 'desert'], minLevel: 1 },
  bone_archer: { biomes: ['crypt', 'ruins', 'desert'], minLevel: 2 },
  frost_adept: { biomes: ['cave', 'ruins', 'crypt'], minLevel: 3 },
  pyromancer: { biomes: ['desert', 'ruins', 'meadow'], minLevel: 3 },
  storm_caller: { biomes: ['desert', 'meadow', 'ruins'], minLevel: 5 },
  necromancer: { biomes: ['crypt', 'ruins', 'marsh'], minLevel: 4 },
  tusked_boar: { biomes: ['meadow', 'forest'], minLevel: 1 },
  horned_charger: { biomes: ['desert', 'cave', 'ruins'], minLevel: 4 },
  bloated_corpse: { biomes: ['marsh', 'crypt'], minLevel: 2 },
  volatile: { biomes: ['desert', 'cave', 'ruins'], minLevel: 3 },
  tomb_guard: { biomes: ['crypt', 'ruins'], minLevel: 3 },
  fallen_shaman: { biomes: ['meadow', 'forest', 'desert', 'ruins'], minLevel: 3 },
  grave_priest: { biomes: ['crypt', 'marsh'], minLevel: 5 },
  ghoul: { biomes: ['crypt', 'marsh', 'forest'], minLevel: 2 },
  sand_burrower: { biomes: ['desert', 'cave'], minLevel: 3 },
  bone_spire: { biomes: ['crypt', 'ruins', 'cave'], minLevel: 4 },
  flame_totem: { biomes: ['desert', 'ruins'], minLevel: 5 },
  wraith: { biomes: ['crypt', 'marsh', 'ruins'], minLevel: 3 },
  banshee: { biomes: ['crypt', 'marsh'], minLevel: 6 },
  bog_spitter: { biomes: ['marsh', 'forest'], minLevel: 2 },
  venom_spider: { biomes: ['forest', 'cave', 'marsh'], minLevel: 2 },
  ooze: { biomes: ['marsh', 'cave'], minLevel: 3 },
};

/** Monster types that fit a biome at a monster level. Never empty. */
export function monsterPool(biome: Biome, level: number): readonly EnemyTypeId[] {
  const out = ENEMY_TYPE_IDS.filter((t) => {
    const h = HABITATS[t];
    return h !== undefined && h.biomes.includes(biome) && h.minLevel <= level;
  });
  // Every biome has a level 1 type, but guard anyway so a zone can never spawn nothing.
  return out.length > 0 ? out : ['chaser'];
}

const BOSSES: Record<Biome, EnemyTypeId> = {
  meadow: 'butcher',
  forest: 'broodmother',
  marsh: 'broodmother',
  desert: 'infernal',
  crypt: 'lich',
  cave: 'broodmother',
  ruins: 'lich',
};

/** The boss a biome builds up to. Low-level zones get the Butcher, the most readable fight. */
export function bossFor(biome: Biome, level: number): EnemyTypeId {
  if (level <= 2) return 'butcher';
  return BOSSES[biome];
}

/**
 * Relative pack size, so a zone can make swarms come in big groups and brutes in small ones. A
 * pack of N ordinary monsters becomes round(N * packScale).
 */
export function packScale(typeId: EnemyTypeId): number {
  switch (familyOf(typeId)) {
    case 'swarm':
      return 2.2;
    case 'brute':
    case 'charger':
    case 'totem':
      return 0.5;
    case 'summoner':
    case 'shaman':
      return 0.35;
    case 'boss':
      return 0.2;
    default:
      return 1;
  }
}
