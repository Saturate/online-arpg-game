import type { Rng } from '../sim/rng.js';
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
  // Second roster: beasts, insects, flyers, elementals, golems and ambushers.
  dire_wolf: { biomes: ['meadow', 'forest', 'ruins'], minLevel: 1 },
  hellhound: { biomes: ['desert', 'cave', 'ruins'], minLevel: 5 },
  grave_hound: { biomes: ['crypt', 'ruins'], minLevel: 3 },
  giant_scorpion: { biomes: ['desert', 'cave'], minLevel: 3 },
  thorn_beast: { biomes: ['forest', 'meadow'], minLevel: 3 },
  cave_spider: { biomes: ['cave', 'crypt', 'forest'], minLevel: 2 },
  lizardman: { biomes: ['marsh', 'desert', 'forest'], minLevel: 2 },
  scarab: { biomes: ['desert', 'crypt'], minLevel: 1 },
  carrion_beetle: { biomes: ['desert', 'crypt', 'marsh'], minLevel: 3 },
  vulture: { biomes: ['meadow', 'desert', 'ruins'], minLevel: 1 },
  harpy: { biomes: ['ruins', 'meadow', 'cave'], minLevel: 3 },
  fire_slime: { biomes: ['desert', 'cave', 'ruins'], minLevel: 2 },
  frost_slime: { biomes: ['cave', 'marsh', 'crypt'], minLevel: 2 },
  fire_elemental: { biomes: ['desert', 'ruins', 'cave'], minLevel: 6 },
  frost_elemental: { biomes: ['cave', 'crypt', 'marsh'], minLevel: 6 },
  storm_elemental: { biomes: ['meadow', 'ruins', 'desert'], minLevel: 5 },
  will_o_wisp: { biomes: ['marsh', 'forest', 'meadow'], minLevel: 2 },
  earth_golem: { biomes: ['cave', 'ruins', 'forest'], minLevel: 7 },
  bone_golem: { biomes: ['crypt', 'ruins'], minLevel: 6 },
  iron_golem: { biomes: ['ruins', 'cave'], minLevel: 8 },
  treant: { biomes: ['forest', 'marsh'], minLevel: 4 },
  spore_man: { biomes: ['forest', 'marsh', 'cave'], minLevel: 2 },
  bog_lurker: { biomes: ['marsh'], minLevel: 2 },
  gargoyle: { biomes: ['ruins', 'crypt'], minLevel: 3 },
  mimic: { biomes: ['crypt', 'cave', 'ruins'], minLevel: 4 },
  sand_worm: { biomes: ['desert'], minLevel: 6 },
  mummy: { biomes: ['desert', 'crypt'], minLevel: 3 },
  ice_wraith: { biomes: ['cave', 'crypt'], minLevel: 5 },
  imp: { biomes: ['desert', 'ruins', 'cave'], minLevel: 3 },
  cultist: { biomes: ['crypt', 'ruins', 'marsh', 'meadow'], minLevel: 4 },
  hellspawn: { biomes: ['cave', 'desert', 'ruins'], minLevel: 8 },
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
  forest: 'treant_king',
  marsh: 'broodmother',
  desert: 'sand_wyrm',
  crypt: 'lich',
  cave: 'frost_giant',
  ruins: 'infernal',
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
    case 'flyer':
      return 1.4;
    case 'beast':
      return 1.3;
    case 'elemental':
      return 0.7;
    case 'lurker':
      return 0.6;
    case 'brute':
    case 'charger':
    case 'totem':
      return 0.5;
    case 'golem':
      return 0.45;
    case 'summoner':
    case 'shaman':
      return 0.35;
    case 'boss':
      return 0.2;
    default:
      return 1;
  }
}

/**
 * One or two types from the biome's pool at this level. Pack size follows the types: swarms come
 * in crowds, brutes and summoners in small groups.
 */
export function rollPack(rng: Rng, biome: Biome, level: number): { types: EnemyTypeId[]; count: number } {
  const pool = monsterPool(biome, level);
  const a = pool[rng.int(0, pool.length - 1)] ?? 'chaser';
  const b = rng.next() < 0.6 ? (pool[rng.int(0, pool.length - 1)] ?? a) : a;
  const base = rng.int(3, 6 + Math.min(6, level));
  const count = Math.max(1, Math.round(base * ((packScale(a) + packScale(b)) / 2)));
  return { types: a === b ? [a] : [a, b], count };
}
