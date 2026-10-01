import { STREAMING, WILDS, ZONE_SIZE } from '../config/sim.js';
import type { Biome } from '../data/monsterPools.js';
import { Rng } from '../sim/rng.js';
import { addRiver, emptyMap, fits, pillarRing, rock, scatterDecor, tree, wall, type Placement } from './gen.js';
import { fitsIn, SCATTER_RULES, Space, type PlacementRules } from './placement.js';
import { GameMap } from './gamemap.js';
import { arenaGateMap, colosseumMap, dungeonMap, stagingMap } from './dungeon.js';
import { ZoneWorld, type ZoneSpec } from './zoneGen.js';
import { DEFAULT_TOWN_LAYOUT, layoutHash, layoutToMap } from './town.js';
import type { MapDescriptor, Obstacle, SafeZone, WorldMap } from './types.js';
import type { Vec2 } from '../sim/math.js';
import { HOME_ZONE, nextZone, previousZone, ZONES, type ZoneId } from '../data/zones.js';
import type { TownLayout } from './town.js';

/**
 * The old open Arena field, kept as a fixture for tests: one river with bridges, walls, rocks, a
 * forest and ruins give movement, pathing and line-of-sight tests something to work against. No
 * room in the game uses it.
 */
function testgroundMap(): WorldMap {
  const rng = new Rng(7);
  const width = 2800;
  const height = 2000;
  const map = emptyMap({ name: 'Testground', theme: 'flat', width, height, spawn: { x: width / 2, y: height / 2 }, waves: true, safe: false, groundTint: 0x6a6048 });
  const plaza = { x: width / 2, y: height / 2, r: 300 };
  map.ground.push({ kind: 'plaza', shape: { type: 'circle', x: plaza.x, y: plaza.y, r: plaza.r } });
  addRiver(map, { xAt: (y) => 1980 + Math.sin(y / 330) * 170 + Math.sin(y / 120) * 38, width: 78, bridgeYs: [520, 1470], bridgeWidth: 110 });
  pillarRing(map, plaza.x, plaza.y, 360, 10, rng);
  for (const [ax, ay, bx, by] of [
    [380, 260, 700, 260],
    [380, 260, 380, 520],
    [1150, 1650, 1450, 1720],
    [2350, 300, 2600, 460],
    [2400, 1400, 2400, 1700],
  ] as const) {
    map.obstacles.push(wall(ax, ay, bx, by));
  }
  const place: Placement = { spacing: 50, riverPad: 30, avoid: [{ ...plaza, r: plaza.r + 40 }] };
  let n = 0;
  for (let i = 0; i < 2000 && n < 46; i++) {
    const x = rng.range(80, 900);
    const y = rng.range(80, height - 80);
    if (!fits(map, x, y, 24, place)) continue;
    map.obstacles.push(tree(x, y, rng));
    n++;
  }
  n = 0;
  for (let i = 0; i < 3000 && n < 34; i++) {
    const x = rng.range(100, width - 100);
    const y = rng.range(100, height - 100);
    const r = 18 + rng.range(0, 38);
    if (!fits(map, x, y, r, place)) continue;
    map.obstacles.push(rock(x, y, r, rng));
    n++;
  }
  map.portals.push({ x: 140, y: height / 2, r: 40, target: 'town', label: 'Town' });
  scatterDecor(map, rng, plaza.x, plaza.y, 420, ['dungeon_rubble_half', 'dungeon_rubble_large', 'grave_skull', 'grave_bone_A'], 14);
  return map;
}

const THEMES = [
  { name: 'Mossy Barrens', tint: 0x5c6b3e },
  { name: 'Ashen Steppe', tint: 0x6b6558 },
  { name: 'Sunscorched Flats', tint: 0x7d6a45 },
  { name: 'Gloomvale', tint: 0x445244 },
];

interface WildsOptions {
  name: string;
  tint: number;
  width: number;
  height: number;
  spawn: Vec2;
  /** Monster level near the spawn and at the far end. */
  levels: readonly [number, number];
  /** Areas the generator leaves untouched, like a town built into the map. */
  keepClear: SafeZone[];
  /** A camp at the spawn: fire, tents and a town portal. Zones with a town do not need one. */
  camp: boolean;
  seed: number;
  biome: Biome;
}

/**
 * The zone-wide part of a generated wilderness: rivers, the road, ridges and ruins (and the camp of
 * a bare Wilds). Every seed gives a different layout. Forests, loose rocks, bones and packs are
 * generated per chunk by `ZoneWorld` from the spec this returns.
 *
 * Rivers, the road and the ridges draw from the seed's main stream exactly as the whole-zone
 * generator did, so they are where they always were; ruins and the camp have streams of their own.
 */
function wildsPlan(o: WildsOptions): { map: WorldMap; spec: ZoneSpec } {
  const rng = new Rng(o.seed);
  const { width, height, spawn } = o;
  const map = emptyMap({ name: o.name, theme: 'wilds', width, height, spawn, waves: false, safe: false, groundTint: o.tint });
  const camp = { x: spawn.x, y: spawn.y, r: 380 };
  if (o.camp) map.ground.push({ kind: 'dirt', shape: { type: 'circle', x: spawn.x, y: spawn.y, r: 220 } });
  const clearRects = o.keepClear.map((z) => ({ ...z, pad: 140 }));
  // Rivers and ridges start east of anything kept clear, so a town is never cut in half.
  const west = Math.max(0, ...o.keepClear.map((z) => z.x + z.w)) + 700;

  const riverCount = rng.int(1, 2);
  for (let i = 0; i < riverCount; i++) {
    const span = width - west - 400;
    const base = west + span * (riverCount === 1 ? 0.45 : 0.25 + 0.5 * i) + rng.range(-200, 200);
    const a1 = rng.range(250, 420);
    const a2 = rng.range(90, 150);
    const p1 = rng.range(0, 6);
    const bridges = [rng.range(height * 0.12, height * 0.3), rng.range(height * 0.42, height * 0.58), rng.range(height * 0.7, height * 0.88)];
    addRiver(map, { xAt: (y) => base + Math.sin(y / a1 + p1) * 200 + Math.sin(y / a2) * 45, width: rng.range(80, 120), bridgeYs: bridges, bridgeWidth: 120 });
  }
  // A dirt road from the spawn heading east, crossing at the middle bridges.
  let rx = spawn.x;
  let ry = spawn.y;
  for (let k = 0; k < 12; k++) {
    const nx = rx + (width - spawn.x) / 12;
    const ny = Math.max(200, Math.min(height - 200, ry + rng.range(-260, 260)));
    map.ground.push({ kind: 'road', shape: { type: 'capsule', ax: rx, ay: ry, bx: nx, by: ny, r: 46 } });
    rx = nx;
    ry = ny;
  }

  // Counts in WILDS are for the standard map size; bigger maps get proportionally more.
  const scale = (width * height) / (WILDS.width * WILDS.height);
  // What `fits` scanned the whole map for, indexed, so the plan's cost does not grow with the square
  // of a zone's size. Same answers: ridges land exactly where they always did.
  const space = new Space();
  space.keepOutCircle(camp.x, camp.y, camp.r);
  for (const z of clearRects) space.keepOutRect(z);
  for (const r of map.rivers) space.river(r.path, r.width);
  for (const b of map.bridges) space.bridge(b.x, b.y, b.length);
  const ridgeRules: PlacementRules = { spacing: 4, riverPad: 40, keepOut: true, bridges: true };
  const ruinRules: PlacementRules = { spacing: 46, riverPad: 40, keepOut: true, bridges: true };
  const push = (o: Obstacle): void => {
    map.obstacles.push(o);
    space.obstacle(o);
  };

  // Ridges: chains of big rocks with gaps, which funnel movement without sealing areas off. They
  // run across chunks, so they are planned whole; at this point the map holds only water and ridges.
  for (let r = 0; r < Math.round(WILDS.ridges * scale); r++) {
    let x = rng.range(Math.min(west, width - 500), width - 400);
    let y = rng.range(300, height - 300);
    let dir = rng.range(0, Math.PI * 2);
    const len = rng.int(6, 12);
    for (let k = 0; k < len; k++) {
      if (rng.next() > 0.2) {
        const rad = rng.range(34, 60);
        if (fitsIn(space, width, height, x, y, rad, ridgeRules)) push(rock(x, y, rad, rng));
      }
      dir += rng.range(-0.5, 0.5);
      x += Math.cos(dir) * 90;
      y += Math.sin(dir) * 90;
    }
  }
  // Ruins turn into old graveyards. A ruin keeps 280 clear around it, as it always had to find.
  const ruinRng = Rng.stream(o.seed, 'ruins');
  const keepOutCircles: ZoneSpec['keepOutCircles'] = [];
  for (let rr = 0; rr < Math.round(WILDS.ruins * scale); rr++) {
    const x = ruinRng.range(Math.min(west, width - 500), width - 400);
    const y = ruinRng.range(400, height - 400);
    if (!fitsIn(space, width, height, x, y, 280, ruinRules)) continue;
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 200 } });
    const before = map.obstacles.length;
    pillarRing(map, x, y, 250, ruinRng.int(8, 12), ruinRng);
    if (ruinRng.next() < 0.7) map.obstacles.push(wall(x - 300, y - 150, x - 300, y + 120));
    for (const o of map.obstacles.slice(before)) space.obstacle(o);
    scatterDecor(map, ruinRng, x, y, 200, ['grave_grave_A', 'grave_grave_B', 'grave_gravestone', 'grave_gravemarker_A', 'grave_lantern_standing', 'grave_skull', 'grave_ribcage', 'grave_post_skull'], 16, (px, py) => space.conflicts(px, py, 0, SCATTER_RULES));
    keepOutCircles.push({ x, y, r: 280 });
  }
  if (o.camp) {
    map.portals.push({ x: spawn.x - 120, y: spawn.y, r: 44, target: 'town', label: 'Town' });
    // The camp: tents, supplies and a weapon rack around the fire.
    scatterDecor(map, Rng.stream(o.seed, 'camp'), spawn.x + 40, spawn.y + 60, 190, ['tent', 'barrel', 'crate_A_big', 'sack', 'weaponrack', 'resource_lumber', 'bucket_water'], 11);
  }
  const spec: ZoneSpec = { seed: o.seed, biome: o.biome, levels: o.levels, scale, clearRects, keepClear: o.keepClear, spawnClear: camp, keepOutCircles, keepOutRects: [], camps: false };
  return { map, spec };
}

/** A standalone Wilds with its own camp, used by the tests and the arena-side tools. */
function wildsZone(seed: number): ZoneWorld {
  const rng = new Rng(seed);
  const theme = THEMES[rng.int(0, THEMES.length - 1)] ?? THEMES[0];
  const spawn = { x: 320, y: rng.range(WILDS.height * 0.3, WILDS.height * 0.7) };
  const { map, spec } = wildsPlan({
    name: theme?.name ?? 'The Wilds',
    tint: theme?.tint ?? 0x5c6b3e,
    width: WILDS.width,
    height: WILDS.height,
    spawn,
    levels: [1, 1 + Math.floor(WILDS.width / WILDS.levelDistance)],
    keepClear: [],
    camp: true,
    seed,
    biome: 'meadow',
  });
  return new ZoneWorld(map, spec);
}

/**
 * An overworld zone. The home zone has the town at its top-left corner, fenced, with the east and
 * south gates opening straight onto the wilderness, so leaving town is a walk. Every zone has a
 * waypoint near where you arrive, and transitions to its neighbours at the west and east edges.
 */
function overworldZone(zoneId: ZoneId, seed: number, layout: TownLayout | undefined, size: { width: number; height: number } = ZONE_SIZE): ZoneWorld {
  const zone = ZONES[zoneId];
  const town = zoneId === HOME_ZONE ? layoutToMap(layout ?? DEFAULT_TOWN_LAYOUT) : null;
  const width = (town?.width ?? 0) + size.width;
  const height = Math.max(size.height, town?.height ?? 0);
  const spawn = town ? town.spawn : { x: 260, y: height / 2 };
  const keepClear: SafeZone[] = town ? [{ x: 0, y: 0, w: town.width, h: town.height }] : [];
  const { map, spec } = wildsPlan({ name: zone.name, tint: zone.groundTint, width, height, spawn, levels: zone.levels, keepClear, camp: false, seed, biome: zone.biome });
  map.safeZones = keepClear;

  if (town) {
    map.obstacles.push(...town.obstacles);
    map.ground.push(...town.ground);
    map.decor.push(...town.decor);
    map.lamps = [...(map.lamps ?? []), ...(town.lamps ?? [])];
    map.oaks = [...(map.oaks ?? []), ...(town.oaks ?? [])];
    if (town.stash) map.stash = town.stash;
    if (town.trader) map.trader = town.trader;
    if (town.forge) map.forge = town.forge;
    // The town's own Wilds portal is replaced by the open gates; the rest (the Arena) stays.
    map.portals.push(...town.portals.filter((p) => p.target !== 'wilds' && p.target !== 'town'));
  }
  // Only open spots are looked up here, so nav cells are never needed: no chunk source, no obstacles in chunks.
  const gm = new GameMap(map, { cols: Math.ceil(width / STREAMING.chunkSize), rows: Math.ceil(height / STREAMING.chunkSize), size: STREAMING.chunkSize, spill: 0, obstacles: () => [] });
  const wp = gm.findOpen(spawn.x + (town ? 170 : 150), spawn.y - 90, 60);
  map.portals.push({ x: wp.x, y: wp.y, r: 46, target: 'waypoint', label: `Waypoint: ${zone.name}`, zone: zoneId });
  spec.keepOutCircles.push({ x: wp.x, y: wp.y, r: 80 });
  const prev = previousZone(zoneId);
  if (prev) addGate(map, spec, 'west', spawn.y, prev);
  const next = nextZone(zoneId);
  if (next) addGate(map, spec, 'east', gm.findOpen(width - 130, height / 2, 60).y, next);
  // Camps, the boss and the entrances are planned by the zone, after the waypoint and gates, so they keep clear of them.
  return new ZoneWorld(map, { ...spec, camps: true });
}

/**
 * A zone `scale` times the usual width and height, for the world streaming benches, so a much bigger
 * zone can be measured without changing the live ones; generated afresh, never from the cache.
 * Nothing in the game builds it.
 */
export function scaledZone(zoneId: ZoneId, seed: number, scale: number, layout?: TownLayout): { def: WorldMap; game: GameMap; zone: ZoneWorld } {
  const zone = overworldZone(zoneId, seed, layout, { width: ZONE_SIZE.width * scale, height: ZONE_SIZE.height * scale });
  return { def: zone.def, game: new GameMap(zone.def, zone), zone };
}

/** How far inside the map edge a gate's trigger sits, and how deep the cleared road into it runs. */
const GATE = { inset: 40, triggerRadius: 60, road: 280, halfWidth: 75 } as const;

/**
 * A zone exit, D2 style: a stone arch on the map edge with lanterns and a dirt road leading out.
 * Walking through the arch changes zone. The road is kept clear of obstacles so the gate can always
 * be walked into from the zone side: the plan's are removed, and chunks keep out of it.
 */
function addGate(map: WorldMap, spec: ZoneSpec, side: 'west' | 'east', y: number, zone: ZoneId): void {
  const dir = side === 'west' ? 1 : -1;
  const edge = side === 'west' ? 0 : map.width;
  const x = edge + dir * GATE.inset;
  const inner = edge + dir * GATE.road;
  const [minX, maxX] = [Math.min(edge, inner), Math.max(edge, inner)];
  const inCorridor = (px: number, py: number): boolean => px >= minX - 40 && px <= maxX + 40 && Math.abs(py - y) <= GATE.halfWidth + 40;
  map.obstacles = map.obstacles.filter((o) => {
    const c = o.shape.type === 'capsule' ? { x: (o.shape.ax + o.shape.bx) / 2, y: (o.shape.ay + o.shape.by) / 2 } : o.shape;
    return !inCorridor(c.x, c.y);
  });
  map.decor = map.decor.filter((d) => !inCorridor(d.x, d.y));
  spec.keepOutRects.push({ x: minX - 40, y: y - GATE.halfWidth - 40, w: maxX - minX + 80, h: (GATE.halfWidth + 40) * 2, pad: 0 });
  // The road runs on past the edge into the gap in the border forest, so the gate leads somewhere.
  map.ground.push({ kind: 'dirt', shape: { type: 'capsule', ax: edge - dir * 360, ay: y, bx: inner, by: y, r: GATE.halfWidth * 0.7 } });
  // The arch spans the road, so it faces along it.
  map.decor.push({ asset: 'grave_arch', x: x + dir * 12, y, angle: Math.PI / 2, scale: 1.6 });
  map.lamps = [...(map.lamps ?? []), { x: x + dir * 40, y: y - GATE.halfWidth }, { x: x + dir * 40, y: y + GATE.halfWidth }];
  map.portals.push({ x, y, r: GATE.triggerRadius, target: 'zone', label: ZONES[zone].name, zone });
}

/** Where a player lands when entering a zone by waypoint or from a neighbouring zone. */
export function zoneArrival(desc: Extract<MapDescriptor, { kind: 'zone' }>, from: ZoneId | 'waypoint'): Vec2 {
  const { def, game } = loadMap(desc);
  const portal = from === 'waypoint' ? def.portals.find((p) => p.target === 'waypoint') : def.portals.find((p) => p.target === 'zone' && p.zone === from);
  if (!portal) return def.spawn;
  // Step off the portal toward the middle of the map, so arriving does not trigger it again.
  const dir = portal.x < def.width / 2 ? 1 : -1;
  return game.findOpen(portal.x + dir * (portal.r + 70), portal.y, 20);
}

function flatMap(): WorldMap {
  return emptyMap({ name: 'Sandbox', theme: 'flat', width: 2800, height: 2000, spawn: { x: 1400, y: 1000 }, waves: true, safe: false, groundTint: 0x606060 });
}

/** The generated zone behind a descriptor, or null for a map built whole (town, dungeons, the Arena). */
function zoneWorld(desc: MapDescriptor): ZoneWorld | null {
  if (desc.kind === 'wilds') return wildsZone(desc.seed);
  if (desc.kind === 'zone') return overworldZone(desc.zone, desc.seed, desc.layout);
  return null;
}

/**
 * Builds a map from scratch and whole, skipping the cache: a generated zone has every chunk in it.
 * For tests and tools; `loadMap` is what the game uses.
 */
export function buildMap(desc: MapDescriptor): WorldMap {
  switch (desc.kind) {
    case 'arena':
      return colosseumMap();
    case 'testground':
      return testgroundMap();
    case 'arenaGate':
      return arenaGateMap();
    case 'town':
      return layoutToMap(desc.layout ?? DEFAULT_TOWN_LAYOUT);
    case 'flat':
      return flatMap();
    case 'staging':
      return stagingMap(desc);
    case 'dungeon':
      return dungeonMap(desc, desc.run);
    case 'wilds':
    case 'zone':
      return zoneWorld(desc)?.whole() ?? flatMap();
  }
}

export interface LoadedMap {
  /** The map; for a generated zone, its plan only (no chunk content, no packs). */
  def: WorldMap;
  /** Collision and navigation; a generated zone's builds its chunks as they are asked about. */
  game: GameMap;
  /** A generated zone's chunks, or null for a map built whole. */
  zone: ZoneWorld | null;
}

const cache = new Map<string, LoadedMap>();

export function mapKey(desc: MapDescriptor): string {
  if (desc.kind === 'wilds') return `wilds:${desc.seed}`;
  if (desc.kind === 'town') return `town:${layoutHash(desc.layout ?? DEFAULT_TOWN_LAYOUT)}`;
  if (desc.kind === 'staging') return `staging:${desc.seed}:${desc.level}`;
  if (desc.kind === 'dungeon') return `dungeon:${desc.seed}:${desc.level}:${desc.run}`;
  if (desc.kind === 'zone') return `zone:${desc.zone}:${desc.seed}${desc.zone === HOME_ZONE ? `:${layoutHash(desc.layout ?? DEFAULT_TOWN_LAYOUT)}` : ''}`;
  return desc.kind;
}

/**
 * Deterministic: the same descriptor always yields the same map, on the server and on every client.
 * A generated zone comes back as its plan, with chunks generated when first needed; the server and
 * the clients each build theirs from the same seed, so nothing about them goes over the network.
 */
export function loadMap(desc: MapDescriptor): LoadedMap {
  const key = mapKey(desc);
  const hit = cache.get(key);
  if (hit) return hit;
  const zone = zoneWorld(desc);
  const def = zone ? zone.def : buildMap(desc);
  const entry: LoadedMap = { def, game: new GameMap(def, zone), zone };
  // Instances come and go; keep the cache small so a long-running server does not grow forever.
  if (cache.size > 32) {
    const first = cache.keys().next().value;
    if (first !== undefined && first !== 'arena' && first !== 'flat') cache.delete(first);
  }
  cache.set(key, entry);
  return entry;
}
