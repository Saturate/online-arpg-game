import { STREAMING, WILDS, WORLD } from '../config/sim.js';
import { ZONES } from '../data/zones.js';
import type { Vec2 } from '../sim/math.js';
import { Rng } from '../sim/rng.js';
import { addPathRiver, distToSegment, emptyMap, pillarRing, rock, scatterDecor, wall } from './gen.js';
import { GameMap } from './gamemap.js';
import { fitsIn, SCATTER_RULES, Space, type PlacementRules } from './placement.js';
import { DEFAULT_TOWN_LAYOUT, layoutToMap, type TownLayout } from './town.js';
import type { Decor, GroundPatch, Obstacle, Portal, Shape, WorldMap } from './types.js';
import { HOME_REGION, TOWN_WAYPOINT, WorldPlan, type RoadSide } from './worldPlan.js';
import { ZoneWorld, type ZoneSpec } from './zoneGen.js';

/**
 * The seamless world's map: the plan's roads, rivers with bridges where roads cross them, ridges,
 * ruins, the town in the middle, waypoints and chests, laid out once; forests, rocks, bones and
 * packs come per chunk from `ZoneWorld`, driven by the plan (biome, level, density by position).
 */

/** What every generated placement keeps off a road beyond the road's own half width. */
const ROAD_CLEARANCE = 34;

/** A ruin: an old graveyard on a plaza inside a ring of broken pillars, keeping 280 clear around it. */
export function addRuin(map: WorldMap, space: Space, rng: Rng, x: number, y: number, keepOutCircles: { x: number; y: number; r: number }[]): void {
  map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 200 } });
  const before = map.obstacles.length;
  pillarRing(map, x, y, 250, rng.int(8, 12), rng);
  if (rng.next() < 0.7) map.obstacles.push(wall(x - 300, y - 150, x - 300, y + 120));
  for (const o of map.obstacles.slice(before)) space.obstacle(o);
  scatterDecor(map, rng, x, y, 200, ['grave_grave_A', 'grave_grave_B', 'grave_gravestone', 'grave_gravemarker_A', 'grave_lantern_standing', 'grave_skull', 'grave_ribcage', 'grave_post_skull'], 16, (px, py) => space.conflicts(px, py, 0, SCATTER_RULES));
  keepOutCircles.push({ x, y, r: 280 });
}

/**
 * Where the town's streets leave it, in town coordinates: the end of a path near an edge with a
 * clear line to that edge (a gap in the fence). At most three, north, east, south and west in that
 * order of preference; a town with fewer gets the middle of its north, east and south edges, so a
 * builder's town always has its three roads.
 */
export function townExits(layout: TownLayout, town: WorldMap): { x: number; y: number; side: RoadSide; from: Vec2 }[] {
  const gm = new GameMap(town);
  const { width: w, height: h } = layout;
  const found = new Map<RoadSide, { x: number; y: number; side: RoadSide; from: Vec2; d: number }>();
  for (const path of layout.paths) {
    for (const end of [path.points[0], path.points[path.points.length - 1]]) {
      if (!end) continue;
      const sides: [RoadSide, number, Vec2][] = [
        ['north', end.y, { x: end.x, y: 0 }],
        ['east', w - end.x, { x: w, y: end.y }],
        ['south', h - end.y, { x: end.x, y: h }],
        ['west', end.x, { x: 0, y: end.y }],
      ];
      for (const [side, d, edge] of sides) {
        if (d > 260) continue;
        // Just inside the edge, where a collision test still means something.
        const inside = { x: Math.min(w - 25, Math.max(25, edge.x)), y: Math.min(h - 25, Math.max(25, edge.y)) };
        if (!gm.lineClear(end.x, end.y, inside.x, inside.y, 20, 'move')) continue;
        const best = found.get(side);
        if (!best || d < best.d) found.set(side, { ...edge, side, from: end, d });
      }
    }
  }
  const order: RoadSide[] = ['north', 'east', 'south', 'west'];
  const out = order.flatMap((s) => {
    const e = found.get(s);
    return e ? [{ x: e.x, y: e.y, side: e.side, from: e.from }] : [];
  });
  const fallback: Record<RoadSide, Vec2> = { north: { x: w / 2, y: 0 }, east: { x: w, y: h / 2 }, south: { x: w / 2, y: h }, west: { x: 0, y: h / 2 } };
  for (const side of order) {
    if (out.length >= 3) break;
    if (out.some((e) => e.side === side)) continue;
    const at = fallback[side];
    out.push({ ...at, side, from: at });
  }
  return out.slice(0, 3);
}

function shiftShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.type) {
    case 'circle':
      return { ...s, x: s.x + dx, y: s.y + dy };
    case 'capsule':
      return { ...s, ax: s.ax + dx, ay: s.ay + dy, bx: s.bx + dx, by: s.by + dy };
    case 'box':
      return { ...s, x: s.x + dx, y: s.y + dy };
  }
}

/** The town map moved to `at`, everything in it shifted alike. */
export function placeTown(town: WorldMap, at: Vec2): WorldMap {
  const p = (v: Vec2): Vec2 => ({ x: v.x + at.x, y: v.y + at.y });
  return {
    ...town,
    spawn: p(town.spawn),
    obstacles: town.obstacles.map((o): Obstacle => ({ ...o, shape: shiftShape(o.shape, at.x, at.y) })),
    ground: town.ground.map((g): GroundPatch => ({ ...g, shape: shiftShape(g.shape, at.x, at.y) })),
    decor: town.decor.map((d): Decor => ({ ...d, x: d.x + at.x, y: d.y + at.y })),
    portals: town.portals.map((o): Portal => ({ ...o, x: o.x + at.x, y: o.y + at.y })),
    ...(town.lamps ? { lamps: town.lamps.map(p) } : {}),
    ...(town.oaks ? { oaks: town.oaks.map(p) } : {}),
    ...(town.stash ? { stash: p(town.stash) } : {}),
    ...(town.trader ? { trader: p(town.trader) } : {}),
    ...(town.forge ? { forge: p(town.forge) } : {}),
  };
}

/** Where a segment crosses another, as a fraction along the first, or null. */
function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** A river bending round a sector past the home region, out to the map edge at both ends. */
function riverCourse(rng: Rng, c: Vec2, angle: number, width: number, height: number): { path: Vec2[]; width: number } {
  const radius = WORLD.hubRadius + rng.range(800, 1800);
  const half = WORLD.sectorHalf - 0.2;
  const wobble = rng.range(110, 170);
  const phase = rng.range(0, Math.PI * 2);
  const w = rng.range(80, 115);
  const path: Vec2[] = [];
  const at = (a: number, d: number): Vec2 => ({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d });
  const far = Math.hypot(width, height);
  for (let d = far; d > radius; d -= 120) path.push(at(angle - half + Math.sin(d / 400) * 0.03, d));
  for (let k = 0; k <= 40; k++) {
    const a = angle - half + (2 * half * k) / 40;
    path.push(at(a, radius + Math.sin(a * 7 + phase) * wobble));
  }
  for (let d = radius + 120; d < far; d += 120) path.push(at(angle + half + Math.sin(d / 400) * 0.03, d));
  // Only the stretch inside the map (and a little past it) is water.
  return { path: path.filter((p) => p.x > -200 && p.y > -200 && p.x < width + 200 && p.y < height + 200), width: w };
}

/**
 * Where a river's path crosses the roads, as distances along it, or null when the river would run
 * alongside a road (within a road's reach of its water) anywhere but at one of those crossings.
 */
function bridgesOver(path: readonly Vec2[], roads: readonly { ax: number; ay: number; bx: number; by: number; r: number }[]): number[] | null {
  const bridges: number[] = [];
  const along: number[] = [0];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const e of roads) {
      const t = crossing(a, b, { x: e.ax, y: e.ay }, { x: e.bx, y: e.by });
      if (t === null) continue;
      const s = (along[i] ?? 0) + t * len;
      if (!bridges.some((o) => Math.abs(o - s) < 260)) bridges.push(s);
    }
    along.push((along[i] ?? 0) + len);
  }
  // Within a bridge's reach of a crossing a road is meant to meet the water; nowhere else.
  for (const [i, p] of path.entries()) {
    const s = along[i] ?? 0;
    if (bridges.some((o) => Math.abs(o - s) < 230)) continue;
    for (const e of roads) if (distToSegment(p.x, p.y, e.ax, e.ay, e.bx, e.by) < e.r + 110) return null;
  }
  return bridges.sort((x, y) => x - y);
}

export interface WorldBuild {
  zone: ZoneWorld;
  plan: WorldPlan;
}

/** The world of a world copy, from its seed and the town layout. `size` is for tests and benches of bigger worlds. */
export function worldZone(seed: number, layout: TownLayout = DEFAULT_TOWN_LAYOUT, size: { width: number; height: number } = WORLD): WorldBuild {
  const { width, height } = size;
  const townMap = layoutToMap(layout);
  const origin = { x: Math.round((width - townMap.width) / 2), y: Math.round((height - townMap.height) / 2) };
  const exits = townExits(layout, townMap).map((e) => ({ ...e, x: e.x + origin.x, y: e.y + origin.y, from: { x: e.from.x + origin.x, y: e.from.y + origin.y } }));
  const townRect = { x: origin.x, y: origin.y, w: townMap.width, h: townMap.height };
  const plan = new WorldPlan({ seed, width, height, town: townRect, exits });
  const town = placeTown(townMap, origin);
  const home = ZONES[HOME_REGION];
  const map = emptyMap({ name: 'Emberwatch Marches', theme: 'wilds', width, height, spawn: town.spawn, waves: false, safe: false, groundTint: home.groundTint });
  map.safeZones = [townRect];
  map.townAt = origin;

  // Roads: every edge of the plan, and the town's street end out to its gate.
  const roads: { ax: number; ay: number; bx: number; by: number; r: number }[] = [];
  const road = (ax: number, ay: number, bx: number, by: number, r: number): void => {
    map.ground.push({ kind: 'road', shape: { type: 'capsule', ax, ay, bx, by, r } });
    roads.push({ ax, ay, bx, by, r: r + ROAD_CLEARANCE });
  };
  for (const e of exits) road(e.from.x, e.from.y, e.x, e.y, WORLD.trunkWidth);
  for (const e of plan.edges) road(e.ax, e.ay, e.bx, e.by, e.width);

  const scale = (width * height) / (WILDS.width * WILDS.height);
  const clearRects = [{ ...townRect, pad: 140 }];
  const space = new Space();
  for (const z of clearRects) space.keepOutRect(z);
  for (const r of roads) space.keepOutCapsule(r.ax, r.ay, r.bx, r.by, r.r);

  // Rivers: in most sectors a river bends round the sector past the home region, out to the map
  // edge at both ends, so the far half of a region lies over the water; every road crossing it gets
  // a bridge.
  const riverRng = Rng.stream(seed, 'world:rivers');
  const c = plan.centre;
  for (const r of plan.roads) {
    if (riverRng.next() > 0.8) continue;
    // A few courses are tried; one that would run alongside a road anywhere but at a bridge is dropped.
    for (let attempt = 0; attempt < 6; attempt++) {
      const river = riverCourse(riverRng, c, r.angle, width, height);
      const bridges = bridgesOver(river.path, roads);
      if (!bridges) continue;
      addPathRiver(map, river.path, river.width, bridges, 130);
      break;
    }
  }
  for (const r of map.rivers) space.river(r.path, r.width);
  for (const b of map.bridges) space.bridge(b.x, b.y, b.length);

  const push = (o: Obstacle): void => {
    map.obstacles.push(o);
    space.obstacle(o);
  };
  // Ridges along the borders between sectors, so each road's regions are their own: beyond the home
  // region a road is the way from one to the next. Rocks overlap, with a rare gap a hero can find.
  const ridgeRng = Rng.stream(seed, 'world:ridges');
  const ridgeRules: PlacementRules = { spacing: 4, riverPad: 40, keepOut: true, bridges: true };
  const borderRules: PlacementRules = { spacing: -30, riverPad: 40, keepOut: true, bridges: true };
  for (const r of plan.roads) {
    const a = r.angle + WORLD.sectorHalf;
    for (let d = WORLD.hubRadius + 500; d < Math.hypot(width, height) / 2; d += 64) {
      if (ridgeRng.next() < 0.04) continue;
      const side = ridgeRng.range(-30, 30);
      const x = c.x + Math.cos(a) * d - Math.sin(a) * side;
      const y = c.y + Math.sin(a) * d + Math.cos(a) * side;
      const rad = ridgeRng.range(44, 68);
      if (fitsIn(space, width, height, x, y, rad, borderRules)) push(rock(x, y, rad, ridgeRng));
    }
  }
  // Loose ridges out in the regions, as a zone always had, never in the home region.
  for (let n = 0; n < Math.round(WILDS.ridges * scale * 0.6); n++) {
    let x = ridgeRng.range(400, width - 400);
    let y = ridgeRng.range(400, height - 400);
    if (Math.hypot(x - c.x, y - c.y) < WORLD.hubRadius + 300) continue;
    let dir = ridgeRng.range(0, Math.PI * 2);
    const len = ridgeRng.int(6, 12);
    for (let k = 0; k < len; k++) {
      if (ridgeRng.next() > 0.2) {
        const rad = ridgeRng.range(34, 60);
        if (fitsIn(space, width, height, x, y, rad, ridgeRules)) push(rock(x, y, rad, ridgeRng));
      }
      dir += ridgeRng.range(-0.5, 0.5);
      x += Math.cos(dir) * 90;
      y += Math.sin(dir) * 90;
    }
  }

  const keepOutCircles: ZoneSpec['keepOutCircles'] = [];
  const ruinRng = Rng.stream(seed, 'ruins');
  const ruinRules: PlacementRules = { spacing: 46, riverPad: 40, keepOut: true, bridges: true };
  for (const spot of plan.spots) {
    if (spot.kind !== 'ruin') continue;
    for (let k = 0; k < 12; k++) {
      const a = ruinRng.range(0, Math.PI * 2);
      const d = k === 0 ? 0 : ruinRng.range(60, 360);
      const x = spot.x + Math.cos(a) * d;
      const y = spot.y + Math.sin(a) * d;
      if (!fitsIn(space, width, height, x, y, 280, ruinRules)) continue;
      addRuin(map, space, ruinRng, x, y, keepOutCircles);
      break;
    }
  }

  // The town, moved to the middle. Its own Wilds portal gives way to the roads; the rest (the Arena) stays.
  map.obstacles.push(...town.obstacles);
  map.ground.push(...town.ground);
  map.decor.push(...town.decor);
  map.lamps = [...(map.lamps ?? []), ...(town.lamps ?? [])];
  map.oaks = [...(map.oaks ?? []), ...(town.oaks ?? [])];
  if (town.stash) map.stash = town.stash;
  if (town.trader) map.trader = town.trader;
  if (town.forge) map.forge = town.forge;
  map.portals.push(...town.portals.filter((p) => p.target !== 'wilds' && p.target !== 'town'));

  // Waypoints: the town's beside the spawn, as before, then the plan's, a step off the road.
  const chunks = { cols: Math.ceil(width / STREAMING.chunkSize), rows: Math.ceil(height / STREAMING.chunkSize), size: STREAMING.chunkSize, spill: 0, obstacles: () => [] };
  const gm = new GameMap(map, chunks);
  const waypoints: NonNullable<WorldMap['waypoints']> = [];
  const addWaypoint = (id: string, name: string, x: number, y: number, behind: string | null): void => {
    const wp = gm.findOpen(x, y, 60);
    map.portals.push({ x: wp.x, y: wp.y, r: 46, target: 'waypoint', label: `Waypoint: ${name}`, waypoint: id });
    keepOutCircles.push({ x: wp.x, y: wp.y, r: 80 });
    waypoints.push({ id, name, x: wp.x, y: wp.y, level: plan.levelAt(wp.x, wp.y), behind });
  };
  addWaypoint(TOWN_WAYPOINT, layout.name || 'Emberwatch', town.spawn.x + 170, town.spawn.y - 90, null);
  for (const w of plan.waypoints) {
    const n = plan.node(w.node);
    const p = n?.parent === null || n?.parent === undefined ? undefined : plan.node(n.parent);
    if (!n) continue;
    const a = p ? Math.atan2(n.y - p.y, n.x - p.x) + Math.PI / 2 : 0;
    addWaypoint(w.id, w.name, n.x + Math.cos(a) * 140, n.y + Math.sin(a) * 140, n.behind);
  }
  map.waypoints = waypoints;

  // Chests at dead ends: a chest model on a patch of dirt, opened once by whoever reaches it first.
  const chests: NonNullable<WorldMap['chests']> = [];
  for (const spot of plan.spots) {
    if (spot.kind !== 'chest') continue;
    const at = gm.findOpen(spot.x, spot.y, 40);
    map.ground.push({ kind: 'dirt', shape: { type: 'circle', x: at.x, y: at.y, r: 70 } });
    map.decor.push({ asset: 'dungeon_chest', x: at.x, y: at.y, angle: Math.atan2(c.y - at.y, c.x - at.x), scale: 1.2 });
    keepOutCircles.push({ x: at.x, y: at.y, r: 90 });
    chests.push({ x: at.x, y: at.y, level: plan.levelAt(at.x, at.y) + 1 });
  }
  map.chests = chests;
  map.gates = plan.gates.flatMap((g) => {
    const n = plan.node(g.node);
    return n ? [{ id: g.id, x: n.x, y: n.y, angle: g.angle, region: g.region }] : [];
  });

  const spec: ZoneSpec = {
    seed,
    biome: home.biome,
    levels: WORLD.levels,
    scale,
    clearRects,
    keepClear: [townRect],
    spawnClear: { x: town.spawn.x, y: town.spawn.y, r: 380 },
    keepOutCircles,
    keepOutRects: [],
    keepOutCapsules: roads,
    camps: true,
    plan,
  };
  return { zone: new ZoneWorld(map, spec), plan };
}
