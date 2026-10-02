import { WORLD, WORLD_GEN } from '../config/sim.js';

/**
 * The numbers a world copy is generated with (docs/features/world-map.md, "Generation settings").
 * Live tuning changes the numbers new copies take (`WORLD_GEN`); a copy keeps the ones it was made
 * with, sends them in its map descriptor, and the server and every client build its map from them.
 * Ranges keep every build succeeding and within the server's budget: see the notes on each.
 */

export type WorldGenKey = keyof typeof WORLD_GEN;

/** Every number, resolved: what generation reads. */
export type WorldGen = { readonly [K in WorldGenKey]: number };

/** The numbers that differ from the code defaults, as a map descriptor and a store carry them. */
export type WorldGenValues = { [K in WorldGenKey]?: number };

export interface WorldGenSpec {
  label: string;
  min: number;
  max: number;
  int: boolean;
  group: 'Density' | 'Size and roads' | 'Levels';
  note?: string;
}

/**
 * Room for the regions past the home region along a trunk: the hub's own step, the crossroads, the
 * gate and the land past it each need a trunk step or more (450), so the home region keeps this far
 * inside the map's margin on every side. At 2600 the east road (the shortest, its gate facing the
 * nearest edge) ran out with one trunk node past its gate on 3 of 30 seeds; from 2800 none did.
 */
export const WORLD_GEN_ROOM_PAST_HOME = 3000;

/**
 * Ranges. Size: below 11000 no home region fits that is bigger than the town (2200 by 1700) by the
 * spurs' reach, with room past it; a home region under 1800 leaves its spurs no ground and the home
 * region without a boss. At 16000 a room is created in under twice the default's time, with 256
 * chunks instead of 169; nothing bigger was measured. Counts: up to about twice the defaults, which
 * at most doubles the world's monsters (4124 against 2049) and kept 8 players spread over the
 * densest worlds under 14 ms a tick at the 95th percentile (world-map.md, "Generation settings").
 */
export const WORLD_GEN_SPECS: Record<WorldGenKey, WorldGenSpec> = {
  size: { label: 'World size (width and height)', min: 11000, max: 16000, int: true, group: 'Size and roads', note: 'The home region keeps 3000 inside the map margin (650) of each side, so a smaller world needs a smaller home region.' },
  hubRadius: { label: 'Home region radius', min: 1800, max: 3400, int: true, group: 'Size and roads' },
  branchStepsMin: { label: 'Branch length, shortest (steps of 420)', min: 2, max: 8, int: true, group: 'Size and roads', note: 'A branch stops early where it would leave its sector or crowd another road.' },
  branchStepsMax: { label: 'Branch length, longest (steps of 420)', min: 2, max: 10, int: true, group: 'Size and roads', note: 'The branches at a road’s crossroads may run one step longer.' },
  midForks: { label: 'Branches between the crossroads and the gate', min: 0, max: 3, int: true, group: 'Size and roads' },
  sideValleyChance: { label: 'Side valley chance per long branch', min: 0, max: 1, int: false, group: 'Size and roads' },
  trunkWander: { label: 'Trunk winding (radians per step)', min: 0, max: 0.4, int: false, group: 'Size and roads' },
  branchWander: { label: 'Branch winding (radians per step)', min: 0, max: 0.5, int: false, group: 'Size and roads' },
  packs: { label: 'Monster packs in the world', min: 0, max: 450, int: true, group: 'Density', note: 'Packs keep 420 apart, so a small world holds fewer than asked.' },
  rareShare: { label: 'Dead ends with a rare pack (the rest a chest)', min: 0, max: 1, int: false, group: 'Density' },
  campsHome: { label: 'Camps in the home region', min: 0, max: 10, int: true, group: 'Density' },
  campsRegion: { label: 'Camps in each other region', min: 0, max: 10, int: true, group: 'Density' },
  dungeonsHome: { label: 'Dungeon entrances in the home region', min: 0, max: 3, int: true, group: 'Density' },
  dungeonsRegion: { label: 'Dungeon entrances in each other region', min: 0, max: 4, int: true, group: 'Density' },
  ruinsHome: { label: 'Ruins in the home region', min: 0, max: 4, int: true, group: 'Density' },
  ruinsRegion: { label: 'Ruins in each other region', min: 0, max: 4, int: true, group: 'Density' },
  forests: { label: 'Forests in the world', min: 0, max: 100, int: true, group: 'Density' },
  looseRocks: { label: 'Loose rocks in the world', min: 0, max: 1100, int: true, group: 'Density' },
  bones: { label: 'Bone piles in the world (decor)', min: 0, max: 700, int: true, group: 'Density' },
  ridges: { label: 'Loose ridges in the world', min: 0, max: 50, int: true, group: 'Density' },
  levelMin: { label: 'Monster level at the town gates', min: 1, max: 50, int: true, group: 'Levels' },
  levelMax: { label: 'Monster level at each road’s far end', min: 1, max: 50, int: true, group: 'Levels' },
  levelCurve: { label: 'Level climb (power of the distance)', min: 0.3, max: 3, int: false, group: 'Levels', note: 'Above 1 levels climb slowly near town and fast far out; below 1 the other way.' },
};

export const WORLD_GEN_KEYS: readonly WorldGenKey[] = Object.keys(WORLD_GEN_SPECS).filter((k): k is WorldGenKey => k in WORLD_GEN);

/** The code defaults, taken before live tuning can change `WORLD_GEN`. */
export const WORLD_GEN_DEFAULTS: WorldGen = Object.freeze({ ...WORLD_GEN });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function inRange(key: WorldGenKey, v: unknown): v is number {
  const s = WORLD_GEN_SPECS[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max && (!s.int || Number.isInteger(v));
}

/** The largest home region a world of `size` has room for. */
export function maxHubRadius(size: number): number {
  return Math.floor(size / 2 - WORLD.edgeMargin - WORLD_GEN_ROOM_PAST_HOME);
}

/** Rules between numbers, each with the keys it ties together. */
const RELATIONS: readonly { keys: readonly WorldGenKey[]; problem: (g: WorldGen) => string | null }[] = [
  { keys: ['levelMin', 'levelMax'], problem: (g) => (g.levelMin > g.levelMax ? `The level at the town gates (${g.levelMin}) is above the level at the far ends (${g.levelMax})` : null) },
  { keys: ['branchStepsMin', 'branchStepsMax'], problem: (g) => (g.branchStepsMin > g.branchStepsMax ? `The shortest branch (${g.branchStepsMin} steps) is longer than the longest (${g.branchStepsMax})` : null) },
  {
    keys: ['size', 'hubRadius'],
    problem: (g) => (g.hubRadius > maxHubRadius(g.size) ? `A home region of ${g.hubRadius} leaves no room for the regions past it in a world of ${g.size}: at most ${maxHubRadius(g.size)}` : null),
  },
];

/** Why a full set of numbers cannot generate a world, or null. */
export function worldGenProblem(gen: WorldGen): string | null {
  for (const r of RELATIONS) {
    const p = r.problem(gen);
    if (p !== null) return p;
  }
  return null;
}

/**
 * The full set from overrides: every number out of range is left at its default, and the numbers of
 * a broken rule (levels out of order, a home region too big for the world) go back to theirs
 * together, so whatever arrives, the result always generates. The server only ever sends valid sets.
 */
export function resolveWorldGen(over?: unknown): WorldGen {
  const out: Record<WorldGenKey, number> = { ...WORLD_GEN_DEFAULTS };
  if (isRecord(over)) {
    for (const k of WORLD_GEN_KEYS) {
      const v = over[k];
      if (inRange(k, v)) out[k] = v;
    }
  }
  for (const r of RELATIONS) if (r.problem(out) !== null) for (const k of r.keys) out[k] = WORLD_GEN_DEFAULTS[k];
  return out;
}

/** The numbers of a full set that differ from the code defaults. */
export function worldGenOverrides(gen: WorldGen): WorldGenValues {
  const out: WorldGenValues = {};
  for (const k of WORLD_GEN_KEYS) if (gen[k] !== WORLD_GEN_DEFAULTS[k]) out[k] = gen[k];
  return out;
}

/** What a new world copy is built with now: the numbers live tuning has in force. */
export function currentWorldGen(): WorldGenValues {
  return worldGenOverrides(resolveWorldGen(WORLD_GEN));
}

/** A stable text of a set, '' for the defaults: for map cache keys and comparing two copies' numbers. */
export function worldGenKey(over?: unknown): string {
  const g = worldGenOverrides(resolveWorldGen(over));
  return WORLD_GEN_KEYS.flatMap((k) => (g[k] === undefined ? [] : [`${k}=${g[k]}`])).join(',');
}

/** A stored or received set: only known keys with numbers in range. */
export function isWorldGenValues(v: unknown): v is WorldGenValues {
  if (!isRecord(v)) return false;
  return Object.entries(v).every(([k, n]) => WORLD_GEN_KEYS.some((key) => key === k && inRange(key, n)));
}

/** 8 hex digits of `worldGenKey`, '' for the defaults: a short tag for a copy's numbers, as in the client's fog keys. */
export function worldGenHash(over?: unknown): string {
  const key = worldGenKey(over);
  if (key === '') return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
