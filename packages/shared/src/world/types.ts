import type { EnemyTypeId } from '../data/enemies.js';
import type { Vec2 } from '../sim/math.js';
import type { TownLayout } from './town.js';

export type ObstacleKind = 'rock' | 'tree' | 'pillar' | 'wall' | 'water' | 'house' | 'stall' | 'well' | 'fence' | 'chest' | 'crate' | 'cavewall';

export type Shape =
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'capsule'; ax: number; ay: number; bx: number; by: number; r: number }
  /** Rotated rectangle: centre, half extents and angle in radians. */
  | { type: 'box'; x: number; y: number; hw: number; hh: number; angle: number };

export interface Obstacle {
  kind: ObstacleKind;
  shape: Shape;
  blocksMove: boolean;
  /** Water blocks walking but not projectiles, so a river can be fought across. */
  blocksShots: boolean;
  /** Visual-only size hint for the renderer (tree canopy, rock height, roof height). */
  visual: number;
}

export interface Bridge {
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
}

/** `staging` is a dungeon entrance's antechamber; `dungeon` is the gate from there into the dungeon itself. */
export type PortalTarget = 'town' | 'wilds' | 'arena' | 'staging' | 'dungeon';

/** Identifies a dungeon: the same seed and level always generate the same staging room. */
export interface DungeonRef {
  seed: number;
  level: number;
}

export interface Portal {
  x: number;
  y: number;
  r: number;
  target: PortalTarget;
  label: string;
  /** Set on `staging` portals: which dungeon the entrance leads to. */
  dungeon?: DungeonRef;
}

export interface MonsterPack {
  x: number;
  y: number;
  types: EnemyTypeId[];
  count: number;
  rareLeader: boolean;
  /** Monster level: scales life and damage, and the item level of drops. */
  level: number;
  boss: boolean;
}

export type MapTheme = 'arena' | 'town' | 'wilds' | 'flat' | 'dungeon' | 'staging';

/** Ground areas drawn with a different surface: plazas, roads. */
export interface GroundPatch {
  /** `floor` is dungeon flagstone, laid as boxes over the dark rock. */
  kind: 'plaza' | 'road' | 'dirt' | 'floor';
  shape: Shape;
}

export interface WorldMap {
  name: string;
  theme: MapTheme;
  width: number;
  height: number;
  obstacles: Obstacle[];
  rivers: { path: Vec2[]; width: number }[];
  bridges: Bridge[];
  ground: GroundPatch[];
  portals: Portal[];
  spawn: Vec2;
  packs: MonsterPack[];
  /** Arena spawns endless waves; town spawns nothing; wilds spawn their packs once. */
  waves: boolean;
  /** No damage is dealt in safe maps. */
  safe: boolean;
  /** Ground tint so each instance of the wilds feels different. */
  groundTint: number;
  /** Render hints: which trees are broadleaf, and where lamp posts stand. */
  oaks?: Vec2[];
  lamps?: Vec2[];
  /** Visual-only props (barrels, graves, bones). No collision, so they never affect gameplay. */
  decor: Decor[];
}

export interface Decor {
  /** Client asset registry id. The simulation never reads it. */
  asset: string;
  x: number;
  y: number;
  angle: number;
  scale: number;
}

/** `flat` is an empty open field used by tests. */
export type MapDescriptor =
  | { kind: 'arena' }
  | { kind: 'town'; layout?: TownLayout }
  | { kind: 'flat' }
  | { kind: 'wilds'; seed: number }
  | ({ kind: 'staging' } & DungeonRef)
  /** `run` counts attempts from the same staging room, so every run gets a fresh layout. */
  | ({ kind: 'dungeon'; run: number } & DungeonRef);
