import { Rng } from '../sim/rng.js';
import type { Vec2 } from '../sim/math.js';
import { emptyMap } from './gen.js';
import { TOWN_DECOR_ASSETS, type TownDecorSpec } from './townDecorAssets.js';
import type { Obstacle, ObstacleKind, PortalTarget, Shape, WorldMap } from './types.js';

export { TOWN_DECOR_ASSETS, type TownDecorSpec } from './townDecorAssets.js';

/**
 * Town layouts are data, edited in game with the town editor (like a PoE hideout) and saved by the
 * server as JSON. Everything here is plain numbers so a layout survives a JSON round trip.
 */

export const TOWN_PROP_KINDS = ['house', 'cottage', 'stall', 'well', 'chest', 'crate', 'pine', 'oak', 'rock', 'pillar', 'lamp', 'fence', 'wall'] as const;
export type TownPropKind = (typeof TOWN_PROP_KINDS)[number];

export interface TownProp {
  kind: TownPropKind;
  x: number;
  y: number;
  angle: number;
  scale: number;
  /** Length for line props (fence, wall); ignored otherwise. */
  length: number;
  /**
   * The model a house, cottage or pillar wears, one of `propModels(kind)`. Absent means the pick by
   * position in the town (`townPropModel`); the editor writes it down before a prop moves, so a
   * house keeps its look wherever it is dragged.
   */
  model?: string;
}

export interface TownPath {
  points: Vec2[];
  width: number;
}

export interface TownPlaza {
  x: number;
  y: number;
  r: number;
}

export interface TownPortal {
  target: TownPortalTarget;
  x: number;
  y: number;
}

export interface TownDecor {
  asset: string;
  x: number;
  y: number;
  angle: number;
  scale: number;
  /**
   * Blocks walking (and shots, if tall), with a footprint from `TOWN_DECOR_ASSETS`. Absent means
   * visual only, which is what every layout saved before the palette has, so old towns keep
   * exactly their old collision.
   */
  solid?: true;
}

export interface TownLayout {
  version: 1;
  name: string;
  width: number;
  height: number;
  spawn: Vec2;
  props: TownProp[];
  paths: TownPath[];
  plazas: TownPlaza[];
  portals: TownPortal[];
  /** Visual-only props from the asset registry, placed with the editor's decor tool. */
  decor: TownDecor[];
}

interface PropDef {
  label: string;
  obstacle: ObstacleKind | null;
  blocksShots: boolean;
  /** Collision and footprint shape for a placed prop. */
  shape: (p: TownProp) => Shape;
  visual: (p: TownProp) => number;
  line?: boolean;
}

function box(p: TownProp, hw: number, hh: number): Shape {
  return { type: 'box', x: p.x, y: p.y, hw: hw * p.scale, hh: hh * p.scale, angle: p.angle };
}

function circle(p: TownProp, r: number): Shape {
  return { type: 'circle', x: p.x, y: p.y, r: r * p.scale };
}

function line(p: TownProp, r: number): Shape {
  const half = p.length / 2;
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  return { type: 'capsule', ax: p.x - c * half, ay: p.y - s * half, bx: p.x + c * half, by: p.y + s * half, r };
}

export const PROP_DEFS: Record<TownPropKind, PropDef> = {
  house: { label: 'House', obstacle: 'house', blocksShots: true, shape: (p) => box(p, 130, 90), visual: (p) => 110 * p.scale },
  cottage: { label: 'Cottage', obstacle: 'house', blocksShots: true, shape: (p) => box(p, 80, 60), visual: (p) => 85 * p.scale },
  stall: { label: 'Market stall', obstacle: 'stall', blocksShots: true, shape: (p) => box(p, 42, 26), visual: () => 45 },
  well: { label: 'Well', obstacle: 'well', blocksShots: true, shape: (p) => circle(p, 34), visual: () => 40 },
  chest: { label: 'Chest', obstacle: 'chest', blocksShots: true, shape: (p) => box(p, 22, 14), visual: () => 20 },
  crate: { label: 'Crates', obstacle: 'crate', blocksShots: true, shape: (p) => box(p, 18, 18), visual: (p) => 30 * p.scale },
  pine: { label: 'Pine tree', obstacle: 'tree', blocksShots: true, shape: (p) => circle(p, 16), visual: (p) => 60 * p.scale },
  oak: { label: 'Oak tree', obstacle: 'tree', blocksShots: true, shape: (p) => circle(p, 17), visual: (p) => 62 * p.scale },
  rock: { label: 'Rock', obstacle: 'rock', blocksShots: true, shape: (p) => circle(p, 30), visual: (p) => 30 * p.scale },
  pillar: { label: 'Pillar', obstacle: 'pillar', blocksShots: true, shape: (p) => circle(p, 22), visual: (p) => 90 * p.scale },
  lamp: { label: 'Lamp post', obstacle: null, blocksShots: false, shape: (p) => circle(p, 8), visual: () => 70 },
  fence: { label: 'Fence', obstacle: 'fence', blocksShots: false, shape: (p) => line(p, 8), visual: () => 30, line: true },
  wall: { label: 'Stone wall', obstacle: 'wall', blocksShots: true, shape: (p) => line(p, 16), visual: (p) => 50 * p.scale, line: true },
};

/** Every building model a house or cottage can wear; the default pick for a big house runs over all six. */
export const HOUSE_MODELS = ['building_home_A_red', 'building_home_B_red', 'building_home_A_blue', 'building_home_B_yellow', 'building_tavern_red', 'building_blacksmith_blue'] as const;
/** A small house picks between the two narrow homes only, which fill a cottage's footprint without squashing. */
const SMALL_HOUSE_MODELS = ['building_home_B_red', 'building_home_B_yellow'] as const;
export const PILLAR_MODELS = ['dungeon_column', 'dungeon_pillar', 'dungeon_pillar_decorated'] as const;

/** The models a prop kind can be given; empty for kinds with one look. */
export function propModels(kind: TownPropKind): readonly string[] {
  if (kind === 'house' || kind === 'cottage') return HOUSE_MODELS;
  if (kind === 'pillar') return PILLAR_MODELS;
  return [];
}

/**
 * The renderer's per-position variation (0 to 999). It lives here so the town's default model
 * picks, which the editor writes into layouts, are the same numbers the renderer would use.
 */
export function lookHash(x: number, y: number): number {
  return Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) % 1000;
}

/** A house's model by its look hash and footprint, as the renderer has always picked it. */
export function pickHouseModel(h: number, hw: number, hh: number): string {
  const list = Math.max(hw, hh) < 100 ? SMALL_HOUSE_MODELS : HOUSE_MODELS;
  return list[h % list.length] ?? 'building_home_A_red';
}

export function pickPillarModel(h: number): string {
  return PILLAR_MODELS[h % PILLAR_MODELS.length] ?? 'dungeon_column';
}

/**
 * The model a town prop is drawn with: its stored one, else the pick by its position in the town
 * (not in the world, so the town looks the same wherever the world places it; before the world it
 * stood at the origin). Null for kinds with one look.
 */
export function townPropModel(p: TownProp): string | null {
  const models = propModels(p.kind);
  if (models.length === 0) return null;
  if (p.model !== undefined && models.includes(p.model)) return p.model;
  const h = lookHash(p.x, p.y);
  if (p.kind === 'pillar') return pickPillarModel(h);
  const s = PROP_DEFS[p.kind].shape(p);
  return s.type === 'box' ? pickHouseModel(h, s.hw, s.hh) : pickHouseModel(h, 0, 0);
}

export function isTownDecorAsset(asset: string): boolean {
  return Object.hasOwn(TOWN_DECOR_ASSETS, asset);
}

/**
 * The spec of a placeable asset. Own keys only: a plain index would find `constructor`,
 * `toString` and the rest on Object.prototype, and a layout naming them would pass validation.
 */
export function decorSpec(asset: string): TownDecorSpec | undefined {
  return Object.hasOwn(TOWN_DECOR_ASSETS, asset) ? TOWN_DECOR_ASSETS[asset] : undefined;
}

/** A point `(ox, oz)` of a placed piece's model, turned and scaled like the model is (PropBatch turns by -angle in three's frame, +angle on the map). */
function placed(d: TownDecor, ox: number, oz: number): { x: number; y: number } {
  const c = Math.cos(d.angle);
  const s = Math.sin(d.angle);
  return { x: d.x + (ox * c - oz * s) * d.scale, y: d.y + (ox * s + oz * c) * d.scale };
}

/** The ground a placed piece covers: its model's footprint box. Null for an asset with no spec. */
export function decorFootprint(d: TownDecor): Shape | null {
  const spec = decorSpec(d.asset);
  if (!spec) return null;
  const at = placed(d, spec.ox, spec.oz);
  return { type: 'box', x: at.x, y: at.y, hw: (spec.w / 2) * d.scale, hh: (spec.d / 2) * d.scale, angle: d.angle };
}

/**
 * The thinnest a solid piece blocks, as half its thickness: the fence prop's radius. Movement steps
 * up to 20 units at a time, so a hero (radius 14) touching a thinner piece can cross its middle in
 * one step and be pushed out the far side: a dash went through the graveyard's split fence (half
 * thickness 0.9) and the wood fence (2).
 */
const MIN_SOLID_HALF = 8;

/**
 * What a solid piece blocks: a little inside its footprint (roofs and branches overhang), a circle
 * for round things, and only the trunk for a tree, so heroes can walk under the canopy's edge.
 */
export function decorCollision(d: TownDecor): Shape | null {
  const spec = decorSpec(d.asset);
  if (!spec) return null;
  const at = placed(d, spec.ox, spec.oz);
  const inset = 0.85;
  if (spec.shape === 'trunk') return { type: 'circle', x: at.x, y: at.y, r: Math.max(8, Math.min(spec.w, spec.d) * 0.2) * d.scale };
  if (spec.shape === 'round') return { type: 'circle', x: at.x, y: at.y, r: (Math.min(spec.w, spec.d) / 2) * inset * d.scale };
  // Each side on its own: a long thin piece is only thickened, a small one grows both ways.
  const hw = Math.max(MIN_SOLID_HALF, (spec.w / 2) * inset * d.scale);
  const hh = Math.max(MIN_SOLID_HALF, (spec.d / 2) * inset * d.scale);
  return { type: 'box', x: at.x, y: at.y, hw, hh, angle: d.angle };
}

/** Oak versus pine is a render choice; the map only knows "tree". This hint rides on the visual size. */
export function isOakAt(def: WorldMap, x: number, y: number): boolean {
  return def.oaks?.some((o) => Math.abs(o.x - x) < 0.5 && Math.abs(o.y - y) < 0.5) ?? false;
}

/** Town portals lead to fixed places; dungeon portals only exist out in the Wilds. */
export type TownPortalTarget = Extract<PortalTarget, 'town' | 'wilds' | 'arena'>;

const PORTAL_LABELS: Record<TownPortalTarget, string> = { town: 'Town', wilds: 'The Wilds', arena: 'Arena' };

export function layoutToMap(layout: TownLayout): WorldMap {
  const map = emptyMap({
    name: layout.name,
    theme: 'town',
    width: layout.width,
    height: layout.height,
    spawn: layout.spawn,
    waves: false,
    safe: true,
    groundTint: 0x6a7446,
  });
  map.oaks = [];
  map.lamps = [];
  for (const plaza of layout.plazas) map.ground.push({ kind: 'plaza', shape: { type: 'circle', x: plaza.x, y: plaza.y, r: plaza.r } });
  for (const path of layout.paths) {
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i];
      const b = path.points[i + 1];
      if (a && b) map.ground.push({ kind: 'road', shape: { type: 'capsule', ax: a.x, ay: a.y, bx: b.x, by: b.y, r: path.width / 2 } });
    }
  }
  for (const p of layout.props) {
    const def = PROP_DEFS[p.kind];
    if (p.kind === 'lamp') {
      map.lamps.push({ x: p.x, y: p.y });
      continue;
    }
    if (!def.obstacle) continue;
    const o: Obstacle = { kind: def.obstacle, shape: def.shape(p), blocksMove: true, blocksShots: def.blocksShots, visual: def.visual(p) };
    const model = townPropModel(p);
    // Hashed in town coordinates, so `placeTown` moving the town leaves every prop looking the same.
    const seed = lookHash(p.x, p.y);
    o.look = model === null ? { seed } : { model, seed };
    map.obstacles.push(o);
    if (p.kind === 'oak') map.oaks.push({ x: p.x, y: p.y });
  }
  for (const d of layout.decor) {
    const shape = d.solid ? decorCollision(d) : null;
    const spec = decorSpec(d.asset);
    if (shape && spec) map.obstacles.push({ kind: 'decor', shape, blocksMove: true, blocksShots: spec.h * d.scale >= 45, visual: spec.h * d.scale });
  }
  map.decor = layout.decor.map((d) => ({ asset: d.asset, x: d.x, y: d.y, angle: d.angle, scale: d.scale }));
  // The chest nearest the spawn is the stash; a town built without one gets one beside the spawn.
  const chests = layout.props.filter((p) => p.kind === 'chest').sort((a, b) => Math.hypot(a.x - layout.spawn.x, a.y - layout.spawn.y) - Math.hypot(b.x - layout.spawn.x, b.y - layout.spawn.y));
  const chest = chests[0];
  if (chest) map.stash = { x: chest.x, y: chest.y };
  else {
    map.stash = { x: layout.spawn.x - 150, y: layout.spawn.y + 70 };
    map.obstacles.push({ kind: 'chest', shape: PROP_DEFS.chest.shape(prop('chest', map.stash.x, map.stash.y)), blocksMove: true, blocksShots: false, visual: 30 });
  }
  // The stall nearest the spawn is the trader's; a town without one gets the trader by the spawn.
  const stalls = layout.props.filter((p) => p.kind === 'stall').sort((a, b) => Math.hypot(a.x - layout.spawn.x, a.y - layout.spawn.y) - Math.hypot(b.x - layout.spawn.x, b.y - layout.spawn.y));
  const stall = stalls[0];
  map.trader = stall ? { x: stall.x, y: stall.y } : { x: layout.spawn.x + 160, y: layout.spawn.y + 70 };
  // The forge is the weapon rack nearest the spawn, so builders move it with the decor tool; a town
  // without one gets a rack placed beside the spawn.
  const racks = layout.decor.filter((d) => d.asset === 'weaponrack').sort((a, b) => Math.hypot(a.x - layout.spawn.x, a.y - layout.spawn.y) - Math.hypot(b.x - layout.spawn.x, b.y - layout.spawn.y));
  const rack = racks[0];
  map.forge = rack ? { x: rack.x, y: rack.y } : { x: layout.spawn.x + 200, y: layout.spawn.y + 190 };
  if (!rack) map.decor.push({ asset: 'weaponrack', x: map.forge.x, y: map.forge.y, angle: 0, scale: 1 });
  for (const portal of layout.portals) map.portals.push({ x: portal.x, y: portal.y, r: portal.target === 'wilds' ? 70 : 60, target: portal.target, label: PORTAL_LABELS[portal.target] });
  return map;
}

function prop(kind: TownPropKind, x: number, y: number, angle = 0, scale = 1, length = 0): TownProp {
  return { kind, x, y, angle, scale, length };
}

/** The shipped town, used until a layout has been saved from the editor. */
function defaultLayout(): TownLayout {
  const rng = new Rng(11);
  const width = 2200;
  const height = 1700;
  const cx = 1100;
  const cy = 850;
  const props: TownProp[] = [
    prop('well', cx, cy),
    prop('chest', cx + 90, cy - 60, 0.3),
    prop('house', 560, 420, 0.12, 1.05),
    prop('house', 1620, 390, -0.08, 1.1),
    prop('house', 520, 1280, -0.1, 1),
    prop('house', 1660, 1290, 0.1, 1.05),
    prop('cottage', 800, 250, 0.05),
    prop('cottage', 1420, 1500, 0),
    prop('cottage', 300, 820, Math.PI / 2),
    prop('stall', cx - 200, cy - 170, 0.6),
    prop('stall', cx + 210, cy - 160, -0.6),
    prop('stall', cx - 220, cy + 150, -0.6),
    prop('stall', cx + 200, cy + 190, 0.5),
    prop('crate', cx + 260, cy - 90, 0.4),
    prop('crate', cx - 280, cy + 60, 1.1),
    prop('lamp', 960, 700),
    prop('lamp', 1240, 700),
    prop('lamp', 960, 1000),
    prop('lamp', 1240, 1000),
    prop('fence', (60 + cx - 90) / 2, 60, 0, 1, cx - 150),
    prop('fence', (cx + 90 + width - 60) / 2, 60, 0, 1, width - 150 - cx),
    prop('fence', (60 + cx - 80) / 2, height - 60, 0, 1, cx - 140),
    prop('fence', (cx + 80 + width - 60) / 2, height - 60, 0, 1, width - 140 - cx),
    prop('fence', 60, height / 2, Math.PI / 2, 1, height - 120),
    prop('fence', width - 60, (60 + cy - 90) / 2, Math.PI / 2, 1, cy - 150),
    prop('fence', width - 60, (cy + 90 + height - 60) / 2, Math.PI / 2, 1, height - 150 - cy),
  ];
  for (let i = 0, n = 0; i < 1500 && n < 26; i++) {
    const edge = rng.next() < 0.5;
    const x = edge ? rng.range(110, width - 110) : rng.next() < 0.5 ? rng.range(110, 260) : rng.range(width - 260, width - 110);
    const y = edge ? (rng.next() < 0.5 ? rng.range(110, 220) : rng.range(height - 220, height - 110)) : rng.range(110, height - 110);
    if (Math.abs(x - cx) < 120 || Math.abs(y - cy) < 120) continue;
    if (props.some((p) => Math.hypot(p.x - x, p.y - y) < 120)) continue;
    props.push(prop(rng.next() < 0.6 ? 'pine' : 'oak', x, y, rng.range(0, 6), rng.range(0.85, 1.25)));
    n++;
  }
  return {
    version: 1,
    name: 'Emberwatch',
    width,
    height,
    spawn: { x: cx, y: cy + 160 },
    props,
    paths: [
      { points: [{ x: cx, y: cy }, { x: cx, y: 140 }], width: 140 },
      { points: [{ x: cx, y: cy }, { x: 2060, y: cy }], width: 140 },
      { points: [{ x: cx, y: cy }, { x: cx, y: 1600 }], width: 120 },
      { points: [{ x: cx, y: cy }, { x: 150, y: cy + 60 }], width: 120 },
    ],
    plazas: [{ x: cx, y: cy, r: 280 }],
    portals: [
      { target: 'wilds', x: cx, y: 150 },
      // Off the roads and away from the gates, so walking out of town never drops you in the Arena.
      { target: 'arena', x: cx - 200, y: cy + 350 },
    ],
    decor: [
      ...[
        [cx - 250, cy - 120, 'barrel'],
        [cx - 262, cy - 96, 'sack'],
        [cx + 250, cy - 205, 'crate_B_small'],
        [cx + 262, cy + 230, 'barrel'],
        [cx - 180, cy + 210, 'bucket_water'],
        [cx - 40, cy + 300, 'wheelbarrow'],
        [cx + 330, cy + 40, 'weaponrack'],
        [cx + 150, cy - 300, 'flag_red'],
        [cx - 150, cy - 300, 'flag_red'],
        [480, 560, 'resource_lumber'],
        [1700, 520, 'barrel'],
        [1720, 540, 'barrel'],
        [600, 1150, 'crate_A_big'],
        [1560, 1170, 'sack'],
        [1580, 1190, 'sack'],
      ].map(([x, y, asset]) => ({ asset: String(asset), x: Number(x), y: Number(y), angle: rng.range(0, 6), scale: 1 })),
    ],
  };
}

export const DEFAULT_TOWN_LAYOUT: TownLayout = defaultLayout();

// ---------------------------------------------------------------------------------------------
// Validation: layouts come from a client editor, so the server checks every field.

/**
 * Solid decor is collision the server steps against every tick; lit decor is a light and a fire
 * each, which the light budget and the fire draw handle, but not without end.
 */
const LIMITS = { props: 600, paths: 80, pathPoints: 200, plazas: 20, portals: 20, decor: 800, solidDecor: 400, litDecor: 160, minSize: 800, maxSize: 6000 } as const;

export const TOWN_LIMITS = LIMITS;

export interface ValidateOptions {
  /**
   * What to do with decor whose asset the game does not know. A save from the editor is rejected
   * (`reject`, the default); a town loaded from disk drops the piece instead (`drop`), so an asset
   * removed from the game later cannot throw the whole live town away for the default one. A prop
   * model the game does not know is treated alike: rejected on a save, dropped (back to the pick by
   * position) on a load.
   */
  unknownDecor?: 'reject' | 'drop';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function point(v: unknown, w: number, h: number): Vec2 | null {
  if (!isRecord(v)) return null;
  const x = num(v.x, 0, w);
  const y = num(v.y, 0, h);
  return x === null || y === null ? null : { x, y };
}

function isPropKind(v: unknown): v is TownPropKind {
  return typeof v === 'string' && TOWN_PROP_KINDS.some((k) => k === v);
}

function isPortalTarget(v: unknown): v is TownPortalTarget {
  return v === 'town' || v === 'wilds' || v === 'arena';
}

/** Returns a clean layout, or null if anything is out of bounds or malformed. */
export function validateLayout(v: unknown, opts: ValidateOptions = {}): TownLayout | null {
  const result = checkLayout(v, opts);
  return typeof result === 'string' ? null : result;
}

/**
 * The same check as `validateLayout`, but a refusal says what is wrong, for the admin API: a staff
 * script sending a whole layout needs to know which piece to fix.
 */
export function checkLayout(v: unknown, opts: ValidateOptions = {}): TownLayout | string {
  if (!isRecord(v)) return 'The layout must be a JSON object';
  if (v.version !== 1) return 'version must be 1';
  const width = num(v.width, LIMITS.minSize, LIMITS.maxSize);
  const height = num(v.height, LIMITS.minSize, LIMITS.maxSize);
  if (width === null || height === null) return `width and height must be numbers from ${LIMITS.minSize} to ${LIMITS.maxSize}`;
  const spawn = point(v.spawn, width, height);
  if (!spawn) return 'spawn must be a point inside the town';
  if (!Array.isArray(v.props) || !Array.isArray(v.paths) || !Array.isArray(v.plazas) || !Array.isArray(v.portals)) return 'props, paths, plazas and portals must be lists';
  if (v.props.length > LIMITS.props) return `At most ${LIMITS.props} props`;
  if (v.paths.length > LIMITS.paths) return `At most ${LIMITS.paths} paths`;
  if (v.plazas.length > LIMITS.plazas) return `At most ${LIMITS.plazas} plazas`;
  if (v.portals.length > LIMITS.portals) return `At most ${LIMITS.portals} portals`;

  const props: TownProp[] = [];
  for (const [i, p] of v.props.entries()) {
    if (!isRecord(p) || !isPropKind(p.kind)) return `props[${i}]: unknown kind`;
    const pos = point(p, width, height);
    if (!pos) return `props[${i}]: x and y must lie inside the town`;
    const angle = num(p.angle, -100, 100);
    const scale = num(p.scale, 0.3, 3);
    const length = num(p.length, 0, Math.max(width, height));
    if (angle === null) return `props[${i}]: angle must be a number from -100 to 100`;
    if (scale === null) return `props[${i}]: scale must be a number from 0.3 to 3`;
    if (length === null) return `props[${i}]: length must be a number from 0 to ${Math.max(width, height)}`;
    const clean: TownProp = { kind: p.kind, x: pos.x, y: pos.y, angle, scale, length };
    if (p.model !== undefined) {
      if (typeof p.model === 'string' && propModels(p.kind).includes(p.model)) clean.model = p.model;
      else if (opts.unknownDecor !== 'drop') return `props[${i}]: model is not one the game has for a ${p.kind}`;
    }
    props.push(clean);
  }
  const paths: TownPath[] = [];
  for (const [i, p] of v.paths.entries()) {
    if (!isRecord(p) || !Array.isArray(p.points) || p.points.length < 2 || p.points.length > LIMITS.pathPoints) return `paths[${i}]: needs 2 to ${LIMITS.pathPoints} points`;
    const w = num(p.width, 20, 400);
    if (w === null) return `paths[${i}]: width must be a number from 20 to 400`;
    const pts = p.points.map((q) => point(q, width, height));
    if (pts.some((q) => q === null)) return `paths[${i}]: every point must lie inside the town`;
    paths.push({ width: w, points: pts.filter((q): q is Vec2 => q !== null) });
  }
  const plazas: TownPlaza[] = [];
  for (const [i, p] of v.plazas.entries()) {
    const pos = point(p, width, height);
    if (!pos) return `plazas[${i}]: x and y must lie inside the town`;
    const r = isRecord(p) ? num(p.r, 20, 1500) : null;
    if (r === null) return `plazas[${i}]: r must be a number from 20 to 1500`;
    plazas.push({ x: pos.x, y: pos.y, r });
  }
  const portals: TownPortal[] = [];
  for (const [i, p] of v.portals.entries()) {
    const pos = point(p, width, height);
    if (!pos) return `portals[${i}]: x and y must lie inside the town`;
    if (!isRecord(p) || !isPortalTarget(p.target)) return `portals[${i}]: target must be town, wilds or arena`;
    portals.push({ target: p.target, x: pos.x, y: pos.y });
  }
  // The town must keep its way out, or players would be stuck in it.
  if (!portals.some((p) => p.target === 'wilds')) return 'The town needs a portal to the wilds';
  const decorIn = Array.isArray(v.decor) ? v.decor : [];
  if (decorIn.length > LIMITS.decor) return `At most ${LIMITS.decor} decor pieces`;
  const decor: TownDecor[] = [];
  let solid = 0;
  let lit = 0;
  for (const [i, d] of decorIn.entries()) {
    const pos = point(d, width, height);
    if (!pos) return `decor[${i}]: x and y must lie inside the town`;
    if (!isRecord(d) || typeof d.asset !== 'string' || !/^[A-Za-z0-9_]{1,48}$/.test(d.asset)) return `decor[${i}]: asset must be 1 to 48 letters, digits or _`;
    const angle = num(d.angle, -100, 100);
    const scale = num(d.scale, 0.2, 4);
    if (angle === null) return `decor[${i}]: angle must be a number from -100 to 100`;
    if (scale === null) return `decor[${i}]: scale must be a number from 0.2 to 4`;
    if (d.solid !== undefined && typeof d.solid !== 'boolean') return `decor[${i}]: solid must be true or false`;
    const spec = decorSpec(d.asset);
    if (!spec) {
      if (opts.unknownDecor === 'drop') continue;
      return `decor[${i}]: unknown asset ${d.asset}`;
    }
    if (spec.lit) lit++;
    // Only `true` is kept, so a layout without solid pieces serialises exactly as before.
    if (d.solid === true) {
      solid++;
      decor.push({ asset: d.asset, x: pos.x, y: pos.y, angle, scale, solid: true });
    } else decor.push({ asset: d.asset, x: pos.x, y: pos.y, angle, scale });
  }
  if (solid > LIMITS.solidDecor) return `At most ${LIMITS.solidDecor} solid decor pieces`;
  if (lit > LIMITS.litDecor) return `At most ${LIMITS.litDecor} lit decor pieces`;
  const name = typeof v.name === 'string' ? v.name.replace(/[^\p{L}\p{N} '-]/gu, '').slice(0, 32) || 'Town' : 'Town';
  return { version: 1, name, width, height, spawn, props, paths, plazas, portals, decor };
}

/** Stable short hash of a layout, so map caches and clients notice when the town changed. */
export function layoutHash(layout: TownLayout): string {
  const json = JSON.stringify(layout);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}
