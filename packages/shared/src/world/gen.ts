import type { Rng } from '../sim/rng.js';
import type { Vec2 } from '../sim/math.js';
import type { Bridge, Obstacle, Shape, WorldMap } from './types.js';

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function distToPath(px: number, py: number, path: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a && b) best = Math.min(best, distToSegment(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

/** Rough distance from a point to the edge of a shape, good enough for placement spacing. */
export function distToShape(px: number, py: number, s: Shape): number {
  switch (s.type) {
    case 'circle':
      return Math.hypot(px - s.x, py - s.y) - s.r;
    case 'capsule':
      return distToSegment(px, py, s.ax, s.ay, s.bx, s.by) - s.r;
    case 'box':
      return Math.hypot(px - s.x, py - s.y) - Math.max(s.hw, s.hh);
  }
}

export interface RiverSpec {
  /** x of the river's centre line as a function of y (rivers run north to south). */
  xAt: (y: number) => number;
  width: number;
  bridgeYs: number[];
  bridgeWidth: number;
}

/** A north-south river made of water capsules, with gaps where bridges cross. */
export function addRiver(map: WorldMap, spec: RiverSpec): void {
  const path: Vec2[] = [];
  for (let y = -60; y <= map.height + 60; y += 60) path.push({ x: spec.xAt(y), y });
  const r = spec.width / 2;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const midY = (a.y + b.y) / 2;
    if (spec.bridgeYs.some((by) => Math.abs(midY - by) < spec.bridgeWidth / 2)) continue;
    map.obstacles.push({ kind: 'water', shape: { type: 'capsule', ax: a.x, ay: a.y, bx: b.x, by: b.y, r }, blocksMove: true, blocksShots: false, visual: 0 });
  }
  map.rivers.push({ path, width: spec.width });
  for (const y of spec.bridgeYs) {
    const riverAngle = Math.atan2(60, spec.xAt(y + 30) - spec.xAt(y - 30));
    const bridge: Bridge = { x: spec.xAt(y), y, angle: riverAngle + Math.PI / 2, length: spec.width + 80, width: spec.bridgeWidth - 20 };
    map.bridges.push(bridge);
  }
}

export interface Placement {
  /** Extra clearance from existing obstacles. */
  spacing: number;
  /** Keep this far from any river centre line beyond its half width. */
  riverPad: number;
  avoid: { x: number; y: number; r: number }[];
}

/** Whether a new circular obstacle of radius `r` at (x, y) fits without crowding anything. */
export function fits(map: WorldMap, x: number, y: number, r: number, p: Placement): boolean {
  if (x < r + 50 || y < r + 50 || x > map.width - r - 50 || y > map.height - r - 50) return false;
  for (const a of p.avoid) if (Math.hypot(x - a.x, y - a.y) < a.r + r) return false;
  for (const river of map.rivers) if (distToPath(x, y, river.path) < river.width / 2 + r + p.riverPad) return false;
  for (const b of map.bridges) if (Math.hypot(x - b.x, y - b.y) < b.length / 2 + r + 80) return false;
  for (const o of map.obstacles) {
    if (o.kind === 'water') continue;
    if (distToShape(x, y, o.shape) < r + p.spacing) return false;
  }
  return true;
}

export function rock(x: number, y: number, r: number, rng: Rng): Obstacle {
  return { kind: 'rock', shape: { type: 'circle', x, y, r }, blocksMove: true, blocksShots: true, visual: r * (0.7 + rng.range(0, 0.6)) };
}

export function tree(x: number, y: number, rng: Rng): Obstacle {
  const trunk = 13 + rng.range(0, 6);
  return { kind: 'tree', shape: { type: 'circle', x, y, r: trunk }, blocksMove: true, blocksShots: true, visual: 42 + rng.range(0, 30) };
}

export function pillar(x: number, y: number, rng: Rng): Obstacle {
  return { kind: 'pillar', shape: { type: 'circle', x, y, r: 22 }, blocksMove: true, blocksShots: true, visual: 40 + rng.range(0, 80) };
}

export function wall(ax: number, ay: number, bx: number, by: number): Obstacle {
  return { kind: 'wall', shape: { type: 'capsule', ax, ay, bx, by, r: 16 }, blocksMove: true, blocksShots: true, visual: 50 };
}

/** A ring of broken pillars, with every third one missing so it can always be entered. */
export function pillarRing(map: WorldMap, cx: number, cy: number, radius: number, count: number, rng: Rng): void {
  for (let i = 0; i < count; i++) {
    if (i % 3 === 2) continue;
    const a = (Math.PI * 2 * i) / count + rng.range(0, 0.3);
    map.obstacles.push(pillar(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, rng));
  }
}

/** A cluster of decor around a point, skipping spots that overlap obstacles. */
export function scatterDecor(map: WorldMap, rng: Rng, cx: number, cy: number, radius: number, assets: readonly string[], count: number): void {
  for (let i = 0, placed = 0; i < count * 6 && placed < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * radius;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    if (x < 30 || y < 30 || x > map.width - 30 || y > map.height - 30) continue;
    if (map.obstacles.some((o) => o.kind !== 'water' && distToShape(x, y, o.shape) < 14)) continue;
    if (map.rivers.some((r) => distToPath(x, y, r.path) < r.width / 2 + 10)) continue;
    const asset = assets[rng.int(0, assets.length - 1)];
    if (!asset) continue;
    map.decor.push({ asset, x, y, angle: rng.range(0, Math.PI * 2), scale: rng.range(0.85, 1.2) });
    placed++;
  }
}

export function emptyMap(partial: Pick<WorldMap, 'name' | 'theme' | 'width' | 'height' | 'spawn' | 'waves' | 'safe' | 'groundTint'>): WorldMap {
  return { ...partial, obstacles: [], rivers: [], bridges: [], ground: [], portals: [], packs: [], decor: [] };
}
