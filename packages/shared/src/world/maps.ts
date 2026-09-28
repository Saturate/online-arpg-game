import { DUNGEON, WILDS, ZONE_SIZE } from '../config/sim.js';
import { bossFor, rollPack, type Biome } from '../data/monsterPools.js';
import { Rng } from '../sim/rng.js';
import { addRiver, emptyMap, fits, inRect, pillarRing, rock, scatterDecor, tree, wall, type Placement } from './gen.js';
import { GameMap } from './gamemap.js';
import { dungeonMap, dungeonName, stagingMap } from './dungeon.js';
import { DEFAULT_TOWN_LAYOUT, layoutHash, layoutToMap } from './town.js';
import type { MapDescriptor, MonsterPack, SafeZone, WorldMap } from './types.js';
import type { Vec2 } from '../sim/math.js';
import { HOME_ZONE, nextZone, previousZone, ZONES, type ZoneId } from '../data/zones.js';
import type { TownLayout } from './town.js';

/** Test arena: one river, rocks, a forest and ruins. Endless waves. */
function arenaMap(): WorldMap {
  const rng = new Rng(7);
  const width = 2800;
  const height = 2000;
  const map = emptyMap({ name: 'Arena', theme: 'arena', width, height, spawn: { x: width / 2, y: height / 2 }, waves: true, safe: false, groundTint: 0x6a6048 });
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

/** A generated wilderness. Every seed gives a different layout: rivers, ridges, forests, ruins and monster packs. */
function generateWilds(o: WildsOptions): WorldMap {
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

  const place: Placement = { spacing: 46, riverPad: 40, avoid: [camp], avoidRects: clearRects };
  // Counts in WILDS are for the standard map size; bigger maps get proportionally more.
  const scale = (width * height) / (WILDS.width * WILDS.height);

  // Ridges: chains of big rocks with gaps, which funnel movement without sealing areas off.
  for (let r = 0; r < Math.round(WILDS.ridges * scale); r++) {
    let x = rng.range(Math.min(west, width - 500), width - 400);
    let y = rng.range(300, height - 300);
    let dir = rng.range(0, Math.PI * 2);
    const len = rng.int(6, 12);
    for (let k = 0; k < len; k++) {
      if (rng.next() > 0.2) {
        const rad = rng.range(34, 60);
        if (fits(map, x, y, rad, { ...place, spacing: 4 })) map.obstacles.push(rock(x, y, rad, rng));
      }
      dir += rng.range(-0.5, 0.5);
      x += Math.cos(dir) * 90;
      y += Math.sin(dir) * 90;
    }
  }
  for (let f = 0; f < Math.round(WILDS.forests * scale); f++) {
    const fx = rng.range(300, width - 300);
    const fy = rng.range(300, height - 300);
    const count = rng.int(12, 26);
    for (let k = 0, placed = 0; k < count * 8 && placed < count; k++) {
      const x = fx + rng.range(-320, 320);
      const y = fy + rng.range(-260, 260);
      if (!fits(map, x, y, 24, place)) continue;
      map.obstacles.push(tree(x, y, rng));
      placed++;
    }
  }
  for (let rr = 0; rr < Math.round(WILDS.ruins * scale); rr++) {
    const x = rng.range(Math.min(west, width - 500), width - 400);
    const y = rng.range(400, height - 400);
    if (!fits(map, x, y, 280, place)) continue;
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 200 } });
    pillarRing(map, x, y, 250, rng.int(8, 12), rng);
    if (rng.next() < 0.7) map.obstacles.push(wall(x - 300, y - 150, x - 300, y + 120));
  }
  for (let k = 0, placed = 0; k < 5000 && placed < Math.round(WILDS.looseRocks * scale); k++) {
    const x = rng.range(100, width - 100);
    const y = rng.range(100, height - 100);
    const r = rng.range(14, 44);
    if (!fits(map, x, y, r, place)) continue;
    map.obstacles.push(rock(x, y, r, rng));
    placed++;
  }

  if (o.camp) {
    map.portals.push({ x: spawn.x - 120, y: spawn.y, r: 44, target: 'town', label: 'Town' });
    // The camp: tents, supplies and a weapon rack around the fire.
    scatterDecor(map, rng, spawn.x + 40, spawn.y + 60, 190, ['tent', 'barrel', 'crate_A_big', 'sack', 'weaponrack', 'resource_lumber', 'bucket_water'], 11);
  }
  // Ruins turn into old graveyards; loose bones and dead trees are scattered across the wilds.
  for (const g of map.ground.filter((p) => p.kind === 'plaza')) {
    if (g.shape.type !== 'circle') continue;
    scatterDecor(map, rng, g.shape.x, g.shape.y, g.shape.r, ['grave_grave_A', 'grave_grave_B', 'grave_gravestone', 'grave_gravemarker_A', 'grave_lantern_standing', 'grave_skull', 'grave_ribcage', 'grave_post_skull'], 16);
  }
  for (let i = 0; i < Math.round(40 * scale); i++) {
    const x = rng.range(200, width - 200);
    const y = rng.range(200, height - 200);
    if (clearRects.some((z) => inRect(x, y, z, z.pad))) continue;
    scatterDecor(map, rng, x, y, 60, ['grave_bone_A', 'grave_skull', 'grave_ribcage', 'grave_tree_dead_small', 'dungeon_rubble_half', 'grave_pumpkin_orange'], 2);
  }
  const levelAt = levelFunction(map, o.levels);
  map.packs = placePacks(map, rng, levelAt, clearRects, scale, o.biome);
  placeEntrances(map, rng, o.seed, levelAt, clearRects);
  return map;
}

/** Monster level rises with distance from the spawn, across the zone's band. */
function levelFunction(map: WorldMap, levels: readonly [number, number]): (x: number, y: number) => number {
  const far = Math.max(1, Math.hypot(map.width, map.height) - 400);
  return (x, y) => {
    const t = Math.min(1, Math.hypot(x - map.spawn.x, y - map.spawn.y) / far);
    return Math.round(levels[0] + (levels[1] - levels[0]) * t);
  };
}

/** A standalone Wilds with its own camp, used by the tests and the arena-side tools. */
function wildsMap(seed: number): WorldMap {
  const rng = new Rng(seed);
  const theme = THEMES[rng.int(0, THEMES.length - 1)] ?? THEMES[0];
  const spawn = { x: 320, y: rng.range(WILDS.height * 0.3, WILDS.height * 0.7) };
  return generateWilds({
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
}

/**
 * An overworld zone. The home zone has the town at its top-left corner, fenced, with the east and
 * south gates opening straight onto the wilderness, so leaving town is a walk. Every zone has a
 * waypoint near where you arrive, and transitions to its neighbours at the west and east edges.
 */
function zoneMap(zoneId: ZoneId, seed: number, layout: TownLayout | undefined): WorldMap {
  const zone = ZONES[zoneId];
  const town = zoneId === HOME_ZONE ? layoutToMap(layout ?? DEFAULT_TOWN_LAYOUT) : null;
  const width = (town?.width ?? 0) + ZONE_SIZE.width;
  const height = Math.max(ZONE_SIZE.height, town?.height ?? 0);
  const spawn = town ? town.spawn : { x: 260, y: height / 2 };
  const keepClear: SafeZone[] = town ? [{ x: 0, y: 0, w: town.width, h: town.height }] : [];
  const map = generateWilds({ name: zone.name, tint: zone.groundTint, width, height, spawn, levels: zone.levels, keepClear, camp: false, seed, biome: zone.biome });
  map.safeZones = keepClear;

  if (town) {
    map.obstacles.push(...town.obstacles);
    map.ground.push(...town.ground);
    map.decor.push(...town.decor);
    map.lamps = [...(map.lamps ?? []), ...(town.lamps ?? [])];
    map.oaks = [...(map.oaks ?? []), ...(town.oaks ?? [])];
    // The town's own Wilds portal is replaced by the open gates; the rest (the Arena) stays.
    map.portals.push(...town.portals.filter((p) => p.target !== 'wilds' && p.target !== 'town'));
  }
  const gm = new GameMap(map);
  const wp = gm.findOpen(spawn.x + (town ? 170 : 150), spawn.y - 90, 60);
  map.portals.push({ x: wp.x, y: wp.y, r: 46, target: 'waypoint', label: `Waypoint: ${zone.name}`, zone: zoneId });
  const prev = previousZone(zoneId);
  if (prev) map.portals.push({ x: 110, y: spawn.y, r: 50, target: 'zone', label: ZONES[prev].name, zone: prev });
  const next = nextZone(zoneId);
  if (next) {
    const exit = gm.findOpen(width - 130, height / 2, 60);
    map.portals.push({ x: exit.x, y: exit.y, r: 50, target: 'zone', label: ZONES[next].name, zone: next });
  }
  return map;
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

/**
 * Packs get harder with distance from the spawn. Only positions reachable from the spawn are used,
 * so a pack can never be sealed behind a ridge or river.
 */
function placePacks(map: WorldMap, rng: Rng, levelAt: (x: number, y: number) => number, clear: NonNullable<Placement['avoidRects']>, scale: number, biome: Biome): MonsterPack[] {
  const gm = new GameMap(map);
  const reach = reachable(gm, map.spawn.x, map.spawn.y);
  const packs: MonsterPack[] = [];
  const wanted = Math.round(WILDS.packs * scale);
  let farthest: { x: number; y: number; d: number } | null = null;
  for (let attempt = 0; attempt < 4000 && packs.length < wanted; attempt++) {
    const x = rng.range(200, map.width - 200);
    const y = rng.range(200, map.height - 200);
    const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
    if (d < WILDS.safeRadius || !reach.has(gm.navCell(x, y)) || gm.pointBlocked(x, y, 40, 'move')) continue;
    // Packs keep out of aggro range of a town, so nobody gets jumped at the gate.
    if (clear.some((z) => inRect(x, y, z, z.pad + WILDS.aggroRadius))) continue;
    if (packs.some((p) => Math.hypot(p.x - x, p.y - y) < WILDS.packSpacing)) continue;
    const level = levelAt(x, y);
    packs.push({ x, y, ...rollPack(rng, biome, level), rareLeader: rng.next() < WILDS.rareLeaderChance, level, boss: false });
    if (!farthest || d > farthest.d) farthest = { x, y, d };
  }
  if (farthest) {
    // The zone's boss holds the far end, with an escort drawn from the local pool.
    const level = levelAt(farthest.x, farthest.y) + 1;
    const escort = rollPack(rng, biome, level);
    packs.push({ x: farthest.x, y: farthest.y, types: [bossFor(biome, level), ...escort.types], count: Math.max(3, Math.round(escort.count * 0.6)), rareLeader: true, level, boss: true });
  }
  return packs;
}


/** Dungeon entrances: a ring of rubble around a staging portal, out in reachable ground far from the spawn. */
function placeEntrances(map: WorldMap, rng: Rng, seed: number, levelAt: (x: number, y: number) => number, clear: NonNullable<Placement['avoidRects']>): void {
  const gm = new GameMap(map);
  const reach = reachable(gm, map.spawn.x, map.spawn.y);
  for (let attempt = 0, placed = 0; attempt < 2000 && placed < DUNGEON.entrances; attempt++) {
    const x = rng.range(300, map.width - 300);
    const y = rng.range(300, map.height - 300);
    const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
    if (d < DUNGEON.entranceMinDistance || !reach.has(gm.navCell(x, y)) || gm.pointBlocked(x, y, 90, 'move')) continue;
    if (clear.some((z) => inRect(x, y, z, z.pad))) continue;
    if (map.packs.some((p) => Math.hypot(p.x - x, p.y - y) < 260) || map.portals.some((p) => Math.hypot(p.x - x, p.y - y) < 1200)) continue;
    const level = levelAt(x, y) + 1;
    // Derived from the map seed so everyone in one instance shares the same antechamber.
    const dungeonSeed = ((Math.imul(seed + 1, 2246822519) + placed * 3266489917) >>> 0) % 1_000_000;
    map.portals.push({ x, y, r: 46, target: 'staging', label: dungeonName(dungeonSeed), dungeon: { seed: dungeonSeed, level } });
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 130 } });
    scatterDecor(map, rng, x, y, 170, ['dungeon_rubble_large', 'dungeon_rubble_half', 'grave_skull', 'dungeon_torch_lit'], 10);
    placed++;
  }
}

function reachable(gm: GameMap, x: number, y: number): Set<number> {
  const start = gm.navCell(x, y);
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const c = queue.pop() ?? 0;
    const cx = c % gm.navCols;
    const cy = (c - cx) / gm.navCols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (!gm.isWalkable(cx + dx, cy + dy)) continue;
      const n = (cy + dy) * gm.navCols + cx + dx;
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

function flatMap(): WorldMap {
  return emptyMap({ name: 'Flat', theme: 'flat', width: 2800, height: 2000, spawn: { x: 1400, y: 1000 }, waves: true, safe: false, groundTint: 0x606060 });
}

function buildMap(desc: MapDescriptor): WorldMap {
  switch (desc.kind) {
    case 'arena':
      return arenaMap();
    case 'town':
      return layoutToMap(desc.layout ?? DEFAULT_TOWN_LAYOUT);
    case 'flat':
      return flatMap();
    case 'wilds':
      return wildsMap(desc.seed);
    case 'staging':
      return stagingMap(desc);
    case 'dungeon':
      return dungeonMap(desc, desc.run);
    case 'zone':
      return zoneMap(desc.zone, desc.seed, desc.layout);
  }
}

const cache = new Map<string, { def: WorldMap; game: GameMap }>();

export function mapKey(desc: MapDescriptor): string {
  if (desc.kind === 'wilds') return `wilds:${desc.seed}`;
  if (desc.kind === 'town') return `town:${layoutHash(desc.layout ?? DEFAULT_TOWN_LAYOUT)}`;
  if (desc.kind === 'staging') return `staging:${desc.seed}:${desc.level}`;
  if (desc.kind === 'dungeon') return `dungeon:${desc.seed}:${desc.level}:${desc.run}`;
  if (desc.kind === 'zone') return `zone:${desc.zone}:${desc.seed}${desc.zone === HOME_ZONE ? `:${layoutHash(desc.layout ?? DEFAULT_TOWN_LAYOUT)}` : ''}`;
  return desc.kind;
}

/** Deterministic: the same descriptor always yields the same map, on the server and on every client. */
export function loadMap(desc: MapDescriptor): { def: WorldMap; game: GameMap } {
  const key = mapKey(desc);
  const hit = cache.get(key);
  if (hit) return hit;
  const def = buildMap(desc);
  const entry = { def, game: new GameMap(def) };
  // Instances come and go; keep the cache small so a long-running server does not grow forever.
  if (cache.size > 32) {
    const first = cache.keys().next().value;
    if (first !== undefined && first !== 'arena' && first !== 'flat') cache.delete(first);
  }
  cache.set(key, entry);
  return entry;
}
