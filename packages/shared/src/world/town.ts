import { Rng } from '../sim/rng.js';
import type { Vec2 } from '../sim/math.js';
import { emptyMap } from './gen.js';
import type { Obstacle, ObstacleKind, PortalTarget, Shape, WorldMap } from './types.js';

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

/** Oak versus pine is a render choice; the map only knows "tree". This hint rides on the visual size. */
export function isOakAt(def: WorldMap, x: number, y: number): boolean {
  return def.oaks?.some((o) => Math.abs(o.x - x) < 0.5 && Math.abs(o.y - y) < 0.5) ?? false;
}

/** Town portals lead to fixed places; dungeon portals only exist out in the Wilds. */
export type TownPortalTarget = Extract<PortalTarget, 'town' | 'wilds' | 'arena'>;

const PORTAL_LABELS: Record<TownPortalTarget, string> = { town: 'Town', wilds: 'The Wilds', arena: 'Arena (test)' };

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
    map.obstacles.push(o);
    if (p.kind === 'oak') map.oaks.push({ x: p.x, y: p.y });
  }
  map.decor = layout.decor.map((d) => ({ ...d }));
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
      { target: 'arena', x: width - 150, y: cy },
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

const LIMITS = { props: 600, paths: 80, pathPoints: 200, plazas: 20, portals: 20, decor: 800, minSize: 800, maxSize: 6000 } as const;

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
export function validateLayout(v: unknown): TownLayout | null {
  if (!isRecord(v) || v.version !== 1) return null;
  const width = num(v.width, LIMITS.minSize, LIMITS.maxSize);
  const height = num(v.height, LIMITS.minSize, LIMITS.maxSize);
  if (width === null || height === null) return null;
  const spawn = point(v.spawn, width, height);
  if (!spawn || !Array.isArray(v.props) || !Array.isArray(v.paths) || !Array.isArray(v.plazas) || !Array.isArray(v.portals)) return null;
  if (v.props.length > LIMITS.props || v.paths.length > LIMITS.paths || v.plazas.length > LIMITS.plazas || v.portals.length > LIMITS.portals) return null;

  const props: TownProp[] = [];
  for (const p of v.props) {
    if (!isRecord(p) || !isPropKind(p.kind)) return null;
    const pos = point(p, width, height);
    const angle = num(p.angle, -100, 100);
    const scale = num(p.scale, 0.3, 3);
    const length = num(p.length, 0, Math.max(width, height));
    if (!pos || angle === null || scale === null || length === null) return null;
    props.push({ kind: p.kind, x: pos.x, y: pos.y, angle, scale, length });
  }
  const paths: TownPath[] = [];
  for (const p of v.paths) {
    if (!isRecord(p) || !Array.isArray(p.points) || p.points.length < 2 || p.points.length > LIMITS.pathPoints) return null;
    const w = num(p.width, 20, 400);
    const pts = p.points.map((q) => point(q, width, height));
    if (w === null || pts.some((q) => q === null)) return null;
    paths.push({ width: w, points: pts.filter((q): q is Vec2 => q !== null) });
  }
  const plazas: TownPlaza[] = [];
  for (const p of v.plazas) {
    const pos = point(p, width, height);
    const r = isRecord(p) ? num(p.r, 20, 1500) : null;
    if (!pos || r === null) return null;
    plazas.push({ x: pos.x, y: pos.y, r });
  }
  const portals: TownPortal[] = [];
  for (const p of v.portals) {
    const pos = point(p, width, height);
    if (!pos || !isRecord(p) || !isPortalTarget(p.target)) return null;
    portals.push({ target: p.target, x: pos.x, y: pos.y });
  }
  // The town must keep its way out, or players would be stuck in it.
  if (!portals.some((p) => p.target === 'wilds')) return null;
  const decorIn = Array.isArray(v.decor) ? v.decor : [];
  if (decorIn.length > LIMITS.decor) return null;
  const decor: TownDecor[] = [];
  for (const d of decorIn) {
    const pos = point(d, width, height);
    if (!pos || !isRecord(d) || typeof d.asset !== 'string' || !/^[A-Za-z0-9_]{1,48}$/.test(d.asset)) return null;
    const angle = num(d.angle, -100, 100);
    const scale = num(d.scale, 0.2, 4);
    if (angle === null || scale === null) return null;
    decor.push({ asset: d.asset, x: pos.x, y: pos.y, angle, scale });
  }
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
