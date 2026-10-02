import { GATES, STREAMING, WORLD } from '../config/sim.js';
import type { EnemyTypeId } from '../data/enemies.js';
import { ZONES, type ZoneId } from '../data/zones.js';
import type { Vec2 } from '../sim/math.js';
import { Rng } from '../sim/rng.js';
import { addPathRiver, distToSegment, emptyMap, pillarRing, rock, scatterDecor, wall } from './gen.js';
import { GameMap } from './gamemap.js';
import { fitsIn, SCATTER_RULES, Space, type PlacementRules } from './placement.js';
import { DEFAULT_TOWN_LAYOUT, layoutToMap, type TownLayout } from './town.js';
import type { Decor, GateInfo, GroundPatch, Obstacle, Portal, Shape, WorldMap } from './types.js';
import { resolveWorldGen, type WorldGen } from './worldGen.js';
import { HOME_REGION, TOWN_WAYPOINT, WorldPlan, type RoadSide } from './worldPlan.js';
import { ZoneWorld, type ZoneSpec } from './zoneGen.js';

/**
 * The seamless world's map: the plan's roads, rivers with bridges where roads cross them, ridges,
 * ruins, the town in the middle, waypoints and chests, laid out once; forests, rocks, bones and
 * packs come per chunk from `ZoneWorld`, driven by the plan (biome, level, density by position).
 */

/**
 * How far a river's bank keeps from a gate node: past the arch's depth and the boss's stand, so no
 * bridge lands under the arch and the walls out from its legs stand on dry ground.
 */
const RIVER_GATE_CLEAR = 320;

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
function riverCourse(rng: Rng, c: Vec2, angle: number, width: number, height: number, hubRadius: number): { path: Vec2[]; width: number } {
  const radius = hubRadius + rng.range(800, 1800);
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

/**
 * Each road's gate boss, by the road's first region. Bosses the road does not already end in, so
 * the fight at the gate is not a rehearsal of the one at the far end: the Pale Lich (seen only in
 * dungeons before) at the mouth of the Hollows, the Butcher on the old steppe road into the Dunes,
 * the Broodmother where the Thornwood closes in.
 */
const GATE_BOSS: Partial<Record<ZoneId, EnemyTypeId>> = { gloomvale: 'lich', steppe: 'butcher', thornwood: 'broodmother' };

/** Half the gap between the arch's legs: the trunk's half width plus the road's clearance and a little. */
const GATE_LEG = WORLD.trunkWidth + ROAD_CLEARANCE + 10;
/** Broken walls run this far along the seal from each leg before the ridge of rocks takes over. */
const GATE_WALL = 340;
/** Wall pieces along the seal: short enough that a chord of the line stays on it where it bends. */
const WALL_PIECE = 68;
/** The step of the seal's trace; a ridge rock's centre strays up to a third of it off the line. */
const TRACE_STEP = 24;
/** Ridge rocks: their range of sizes and the smallest one tried where a big one would touch a road or bridge. */
const RIDGE_ROCK: readonly [number, number] = [44, 62];
const RIDGE_ROCK_MIN = 22;
/**
 * Where ridge rocks may stand: off roads (with their clearance), bridges, the town and the map's
 * margin, but over rivers and against other rocks, so the ridge runs on across the water and
 * through whatever stood on the line first. Every piece blocks as it is drawn.
 */
const RIDGE_RULES: PlacementRules = { spacing: -1e6, riverPad: -1e6, keepOut: true, bridges: true };
/** Whether a wall piece would stand in a river. */
const OVER_WATER: PlacementRules = { spacing: -1e6, riverPad: 0, keepOut: false, bridges: false };
/** A spot is already walled when it lies this deep inside another obstacle (not water). */
const COVERED: PlacementRules = { spacing: -12, riverPad: -1e6, keepOut: false, bridges: false };

/**
 * The seal's line from the gate node outward, one way: the edge of the land behind `gateId`
 * followed step by step (the next point is where the circle of one step round the last one crosses
 * from behind to not behind, sweeping from the behind side), until it leaves the map or comes back
 * to `stop`. It runs between the roads as the rule does, then along the sector border or another
 * gate's land wherever this gate's land meets them, so walling it walls every way in but the road.
 * `behindLeft`: whether the land behind lies to the left of `heading`.
 */
export function traceSeal(plan: WorldPlan, gateId: string, from: Vec2, heading: number, behindLeft: boolean, width: number, height: number, stop: Vec2 | null = null): Vec2[] {
  const behind = (x: number, y: number): boolean => plan.gateAt(x, y) === gateId;
  const side = behindLeft ? 1 : -1;
  const out: Vec2[] = [{ x: from.x, y: from.y }];
  let p = from;
  let h = heading;
  const SAMPLES = 24;
  const at = (a: number): boolean => behind(p.x + Math.cos(a) * TRACE_STEP, p.y + Math.sin(a) * TRACE_STEP);
  for (let n = 0; n < 2400; n++) {
    // Sweep from the behind side across the heading to the far side; the line lies where it changes.
    const angle = (k: number): number => h + side * (Math.PI / 2 - (k * 2 * Math.PI) / SAMPLES);
    let prev = at(angle(0));
    let lo = -1;
    for (let k = 1; k <= SAMPLES; k++) {
      const cur = at(angle(k));
      if (prev && !cur) {
        lo = k - 1;
        break;
      }
      prev = cur;
    }
    if (lo < 0) break;
    let a0 = angle(lo);
    let a1 = angle(lo + 1);
    for (let k = 0; k < 7; k++) {
      const mid = (a0 + a1) / 2;
      if (at(mid)) a0 = mid;
      else a1 = mid;
    }
    h = (a0 + a1) / 2;
    p = { x: p.x + Math.cos(h) * TRACE_STEP, y: p.y + Math.sin(h) * TRACE_STEP };
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) break;
    out.push(p);
    if (stop && n > 4 && Math.hypot(p.x - stop.x, p.y - stop.y) < TRACE_STEP * 1.5) break;
  }
  return out;
}

/** The point `s` along a polyline, and the line's heading there; past its end, its last point. */
function along(line: readonly Vec2[], cum: readonly number[], s: number): { x: number; y: number; heading: number } {
  let i = 1;
  while (i < line.length - 1 && (cum[i] ?? 0) < s) i++;
  const a = line[i - 1] ?? line[0] ?? { x: 0, y: 0 };
  const b = line[i] ?? a;
  const len = (cum[i] ?? 0) - (cum[i - 1] ?? 0);
  const t = len > 0 ? Math.max(0, Math.min(1, (s - (cum[i - 1] ?? 0)) / len)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: Math.atan2(b.y - a.y, b.x - a.x) };
}

/**
 * A gate's pass: a ruined arch across the road whose legs block, broken walls along the seal's line
 * out from each leg, then a ridge of overlapping rocks along the rest of the line (where
 * `WorldPlan.gateAt` changes) to the map's edge, across rivers too, so the only way through that
 * the seal lets a character without the gate take is under the arch, and that is the only opening
 * drawn. The rule itself is the plan's, not these pieces: they draw it, and block as drawn for those
 * who have the gate.
 */
function addGatePass(map: WorldMap, space: Space, plan: WorldPlan, gate: WorldPlan['gates'][number], width: number, height: number): GateInfo | null {
  const g = plan.node(gate.node);
  const road = plan.roads[gate.road];
  if (!g || !road) return null;
  const rng = Rng.stream(plan.seed, `world:gate:${gate.id}`);
  const nx = -Math.sin(gate.angle);
  const ny = Math.cos(gate.angle);
  const push = (o: Obstacle): void => {
    map.obstacles.push(o);
    space.obstacle(o);
  };
  // Decor turns its model's x axis to the angle, and the arch spans along its x: a quarter turn off
  // the road's heading lays the span across the road, its face toward the town.
  const across = gate.angle + Math.PI / 2;
  map.decor.push({ asset: 'grave_arch', x: g.x, y: g.y, angle: across, scale: 2.35 });
  map.ground.push({ kind: 'dirt', shape: { type: 'circle', x: g.x - Math.cos(gate.angle) * 120, y: g.y - Math.sin(gate.angle) * 120, r: 210 } });

  const placeRock = (x: number, y: number, want: number): void => {
    if (space.conflicts(x, y, 0, COVERED)) return;
    for (let r = want; r >= RIDGE_ROCK_MIN; r *= 0.75) {
      if (!fitsIn(space, width, height, x, y, r, RIDGE_RULES)) continue;
      push(rock(x, y, r, rng));
      return;
    }
  };
  let first: Vec2 | null = null;
  for (const side of [1, -1]) {
    const lx = g.x + nx * GATE_LEG * side;
    const ly = g.y + ny * GATE_LEG * side;
    push({ kind: 'decor', shape: { type: 'circle', x: lx, y: ly, r: 18 }, blocksMove: true, blocksShots: true, visual: 200 });
    map.decor.push({ asset: 'grave_post_skull', x: lx - Math.cos(gate.angle) * 40, y: ly - Math.sin(gate.angle) * 40, angle: across, scale: 1 });
    // Heading +n the land behind (ahead along the road) is on the right; heading -n, on the left.
    const line = traceSeal(plan, gate.id, g, gate.angle + (side * Math.PI) / 2, side < 0, width, height, first);
    first ??= line[line.length - 1] ?? null;
    const cum: number[] = [0];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      cum.push((cum[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0));
    }
    const total = cum[cum.length - 1] ?? 0;
    // Walls from the leg, each a chord of the line; over water the ridge's rocks stand in for them.
    let prev: Vec2 = { x: lx, y: ly };
    let s = GATE_LEG;
    while (s < Math.min(total, GATE_LEG + GATE_WALL)) {
      // A piece is a chord, so it is shortened where the line turns under it until it keeps to the line.
      let end = Math.min(s + WALL_PIECE, total);
      let next = along(line, cum, end);
      while (end - s > TRACE_STEP && line.some((q, i) => (cum[i] ?? 0) > s && (cum[i] ?? 0) < end && distToSegment(q.x, q.y, prev.x, prev.y, next.x, next.y) > 8)) {
        end = s + (end - s) / 2;
        next = along(line, cum, end);
      }
      s = end;
      const mx = (prev.x + next.x) / 2;
      const my = (prev.y + next.y) / 2;
      const half = Math.hypot(next.x - prev.x, next.y - prev.y) / 2;
      if (!space.conflicts(mx, my, half, OVER_WATER)) push(wall(prev.x, prev.y, next.x, next.y));
      else for (let k = 0; k <= 2; k++) placeRock(prev.x + ((next.x - prev.x) * k) / 2, prev.y + ((next.y - prev.y) * k) / 2, 30);
      prev = next;
    }
    // Rocks overlapping along the rest of the line, a little off it either way so it reads as rubble.
    let r = rng.range(RIDGE_ROCK[0], RIDGE_ROCK[1]);
    s += r * 0.6;
    while (s < total) {
      const p = along(line, cum, s);
      const off = rng.range(-0.35, 0.35) * TRACE_STEP;
      placeRock(p.x - Math.sin(p.heading) * off, p.y + Math.cos(p.heading) * off, r);
      const next = rng.range(RIDGE_ROCK[0], RIDGE_ROCK[1]);
      s += (r + next) * 0.62;
      r = next;
    }
  }

  const inner = road.regions[0] ?? g.region;
  return {
    id: gate.id,
    x: g.x,
    y: g.y,
    angle: gate.angle,
    region: gate.region,
    name: `${ZONES[inner].name} Gate`,
    boss: GATE_BOSS[inner] ?? 'butcher',
    level: plan.levelAt(g.x, g.y) + GATES.levelBonus,
    bossX: g.x - Math.cos(gate.angle) * GATES.standBack,
    bossY: g.y - Math.sin(gate.angle) * GATES.standBack,
  };
}

export interface WorldBuild {
  zone: ZoneWorld;
  plan: WorldPlan;
}

/**
 * The world of a world copy, from its seed, the town layout and its generation numbers. `size` is
 * for tests and benches of worlds past the size range; it overrides the numbers' size.
 */
export function worldZone(seed: number, layout: TownLayout = DEFAULT_TOWN_LAYOUT, gen: WorldGen = resolveWorldGen(), size?: { width: number; height: number }): WorldBuild {
  const { width, height } = size ?? { width: gen.size, height: gen.size };
  const townMap = layoutToMap(layout);
  const origin = { x: Math.round((width - townMap.width) / 2), y: Math.round((height - townMap.height) / 2) };
  const exits = townExits(layout, townMap).map((e) => ({ ...e, x: e.x + origin.x, y: e.y + origin.y, from: { x: e.from.x + origin.x, y: e.from.y + origin.y } }));
  const townRect = { x: origin.x, y: origin.y, w: townMap.width, h: townMap.height };
  const plan = new WorldPlan({ seed, width, height, town: townRect, exits, gen });
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

  const clearRects = [{ ...townRect, pad: 140 }];
  const space = new Space();
  for (const z of clearRects) space.keepOutRect(z);
  for (const r of roads) space.keepOutCapsule(r.ax, r.ay, r.bx, r.by, r.r);

  // Rivers: in most sectors a river bends round the sector past the home region, out to the map
  // edge at both ends, so the far half of a region lies over the water; every road crossing it gets
  // a bridge.
  const riverRng = Rng.stream(seed, 'world:rivers');
  const gateNodes = plan.gates.flatMap((g) => plan.node(g.node) ?? []);
  const nearGate = (path: readonly Vec2[], reach: number): boolean =>
    path.some((a, i) => {
      const b = path[i + 1];
      return b !== undefined && gateNodes.some((n) => distToSegment(n.x, n.y, a.x, a.y, b.x, b.y) < reach);
    });
  const c = plan.centre;
  for (const r of plan.roads) {
    if (riverRng.next() > 0.8) continue;
    // A few courses are tried; one that would run alongside a road anywhere but at a bridge is dropped,
    // and so is one through a gate's pass, which gets tries of its own so gates do not cost rivers.
    for (let attempt = 0, nearGates = 0; attempt < 6 && nearGates < 8; attempt++) {
      const river = riverCourse(riverRng, c, r.angle, width, height, gen.hubRadius);
      if (nearGate(river.path, river.width / 2 + RIVER_GATE_CLEAR)) {
        nearGates++;
        attempt--;
        continue;
      }
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
    for (let d = gen.hubRadius + 500; d < Math.hypot(width, height) / 2; d += 64) {
      if (ridgeRng.next() < 0.04) continue;
      const side = ridgeRng.range(-30, 30);
      const x = c.x + Math.cos(a) * d - Math.sin(a) * side;
      const y = c.y + Math.sin(a) * d + Math.cos(a) * side;
      const rad = ridgeRng.range(44, 68);
      if (fitsIn(space, width, height, x, y, rad, borderRules)) push(rock(x, y, rad, ridgeRng));
    }
  }
  // Gates before the loose ridges, so nothing else takes the spots their walls and ridges need.
  const gates = plan.gates.flatMap((g) => addGatePass(map, space, plan, g, width, height) ?? []);

  // Loose ridges out in the regions, as a zone always had, never in the home region.
  for (let n = 0; n < gen.ridges; n++) {
    let x = ridgeRng.range(400, width - 400);
    let y = ridgeRng.range(400, height - 400);
    if (Math.hypot(x - c.x, y - c.y) < gen.hubRadius + 300) continue;
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
  map.gates = gates.map((g) => {
    // The boss stands on open ground; packs and camps keep their distance from it.
    const at = gm.findOpen(g.bossX, g.bossY, 40);
    keepOutCircles.push({ x: at.x, y: at.y, r: 260 });
    return { ...g, bossX: at.x, bossY: at.y };
  });

  const spec: ZoneSpec = {
    seed,
    biome: home.biome,
    levels: plan.levels,
    scale: 1,
    counts: { packs: gen.packs, forests: gen.forests, rocks: gen.looseRocks, bones: gen.bones },
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
