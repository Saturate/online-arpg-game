import type { EnemyTypeId } from '../data/enemies.js';
import type { Vec2 } from '../sim/math.js';
import type { TownLayout } from './town.js';

/** `decor` is a town editor piece marked solid: it blocks like the rest, and its model is drawn from the map's decor. */
export type ObstacleKind = 'rock' | 'tree' | 'pillar' | 'wall' | 'water' | 'house' | 'stall' | 'well' | 'fence' | 'chest' | 'crate' | 'cavewall' | 'decor';

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

/**
 * `staging` is a dungeon entrance's antechamber; `dungeon` is the gate from an antechamber (a
 * dungeon's or the Arena gate) into the run itself; `arena` leads from town to the Arena gate;
 * `waypoint` opens the waypoint menu; `wilds` leads back out into the world.
 */
export type PortalTarget = 'town' | 'wilds' | 'arena' | 'staging' | 'dungeon' | 'waypoint';

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
  /** Set on `waypoint` portals: which waypoint this is. */
  waypoint?: string;
  /** Hidden and closed until the room's boss dies (`Simulation.cleared`): a dungeon's exit. */
  sealed?: 'boss';
}

/** Axis-aligned area where nobody can be hurt or targeted: the town inside the first zone. */
export interface SafeZone {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** Safe areas inside an otherwise dangerous map. */
  safeZones?: SafeZone[];
  /** Ground tint so each instance of the wilds feels different. */
  groundTint: number;
  /** Render hints: which trees are broadleaf, and where lamp posts stand. */
  oaks?: Vec2[];
  lamps?: Vec2[];
  /** Visual-only props (barrels, graves, bones). No collision, so they never affect gameplay. */
  decor: Decor[];
  /** Where the stash chest stands; only maps with a town have one. */
  stash?: Vec2;
  /** Where the trader stands; only maps with a town have one. */
  trader?: Vec2;
  /** Where sigils are inscribed with runes; only maps with a town have one. */
  forge?: Vec2;
  /** The Arena leaderboard stone; only the Arena gate has one. */
  board?: Vec2;
  /**
   * The ground players can actually reach, when the map is carved out of rock that has no colliders
   * of its own (the Arena pit). Waves only spawn inside it.
   */
  playArea?: { x: number; y: number; r: number };
  /** Generated camps in a zone (`camps.ts`): where each fire burns and whether a pack holds it. */
  camps?: { x: number; y: number; guarded: boolean }[];
  /** The world's waypoints, in the order the menu lists them. */
  waypoints?: WaypointInfo[];
  /** Chests at the world's dead ends: each opens once per world copy, for the first to reach it. */
  chests?: { x: number; y: number; level: number }[];
  /** The world's gates: narrow passes a gate boss holds, sealed for each character until they kill it (`sim/gates.ts`). */
  gates?: GateInfo[];
  /** Where the town layout's origin sits in this map; the town editor works in town coordinates. */
  townAt?: Vec2;
}

export interface GateInfo {
  id: string;
  /** The gate node, where the seal crosses the road. */
  x: number;
  y: number;
  /** The road's heading through the gate, away from town. */
  angle: number;
  /** The region it leads into. */
  region: string;
  /** What the HUD calls it: the first region's name and "Gate". */
  name: string;
  boss: EnemyTypeId;
  level: number;
  /** Where the boss stands, on the town side of the seal. */
  bossX: number;
  bossY: number;
}

export interface WaypointInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  /** Monster level around it, for the menu. */
  level: number;
  /** The gate it lies behind, if any: travel there needs that gate opened. */
  behind: string | null;
}

export interface Decor {
  /** Client asset registry id. The simulation never reads it. */
  asset: string;
  x: number;
  y: number;
  angle: number;
  scale: number;
}

/**
 * `flat` is an empty open field, used by tests and the builders' sandbox. `arena` is the pit an
 * Arena run is fought in. `testground` is a fixed field with a river and walls, for tests.
 */
export type MapDescriptor =
  | { kind: 'arena' }
  /** A fixed open field with a river and walls, for tests only. */
  | { kind: 'testground' }
  /** The antechamber in front of the Arena: ready check and leaderboard. */
  | { kind: 'arenaGate' }
  | { kind: 'town'; layout?: TownLayout }
  | { kind: 'flat' }
  | { kind: 'wilds'; seed: number }
  /** A world copy's one seamless map: the town in the middle and every region around it. */
  | { kind: 'world'; seed: number; layout?: TownLayout }
  | ({ kind: 'staging' } & DungeonRef)
  /** `run` counts attempts from the same staging room, so every run gets a fresh layout. */
  | ({ kind: 'dungeon'; run: number } & DungeonRef);
