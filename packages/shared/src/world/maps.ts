import { DUNGEON, WILDS } from '../config/sim.js';
import type { EnemyTypeId } from '../data/enemies.js';
import { Rng } from '../sim/rng.js';
import { addRiver, emptyMap, fits, pillarRing, rock, scatterDecor, tree, wall, type Placement } from './gen.js';
import { GameMap } from './gamemap.js';
import { dungeonMap, dungeonName, stagingMap } from './dungeon.js';
import { DEFAULT_TOWN_LAYOUT, layoutHash, layoutToMap } from './town.js';
import type { MapDescriptor, MonsterPack, WorldMap } from './types.js';

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

/** A generated wilderness. Every seed gives a different layout: rivers, ridges, forests, ruins and monster packs. */
function wildsMap(seed: number): WorldMap {
  const rng = new Rng(seed);
  const width = WILDS.width;
  const height = WILDS.height;
  const theme = THEMES[rng.int(0, THEMES.length - 1)] ?? THEMES[0];
  const spawn = { x: 320, y: rng.range(height * 0.3, height * 0.7) };
  const map = emptyMap({ name: theme?.name ?? 'The Wilds', theme: 'wilds', width, height, spawn, waves: false, safe: false, groundTint: theme?.tint ?? 0x5c6b3e });
  const camp = { x: spawn.x, y: spawn.y, r: 380 };
  map.ground.push({ kind: 'dirt', shape: { type: 'circle', x: spawn.x, y: spawn.y, r: 220 } });

  const riverCount = rng.int(1, 2);
  for (let i = 0; i < riverCount; i++) {
    const base = width * (0.35 + 0.35 * (riverCount === 1 ? 0.5 : i)) + rng.range(-200, 200);
    const a1 = rng.range(250, 420);
    const a2 = rng.range(90, 150);
    const p1 = rng.range(0, 6);
    const bridges = [rng.range(height * 0.12, height * 0.3), rng.range(height * 0.42, height * 0.58), rng.range(height * 0.7, height * 0.88)];
    addRiver(map, { xAt: (y) => base + Math.sin(y / a1 + p1) * 200 + Math.sin(y / a2) * 45, width: rng.range(80, 120), bridgeYs: bridges, bridgeWidth: 120 });
  }
  // A dirt road from camp heading east, crossing at the middle bridges.
  let rx = spawn.x;
  let ry = spawn.y;
  for (let k = 0; k < 12; k++) {
    const nx = rx + width / 12;
    const ny = Math.max(200, Math.min(height - 200, ry + rng.range(-260, 260)));
    map.ground.push({ kind: 'road', shape: { type: 'capsule', ax: rx, ay: ry, bx: nx, by: ny, r: 46 } });
    rx = nx;
    ry = ny;
  }

  const place: Placement = { spacing: 46, riverPad: 40, avoid: [camp] };

  // Ridges: chains of big rocks with gaps, which funnel movement without sealing areas off.
  for (let r = 0; r < WILDS.ridges; r++) {
    let x = rng.range(900, width - 400);
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
  for (let f = 0; f < WILDS.forests; f++) {
    const fx = rng.range(500, width - 300);
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
  for (let rr = 0; rr < WILDS.ruins; rr++) {
    const x = rng.range(1000, width - 400);
    const y = rng.range(400, height - 400);
    if (!fits(map, x, y, 280, place)) continue;
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 200 } });
    pillarRing(map, x, y, 250, rng.int(8, 12), rng);
    if (rng.next() < 0.7) map.obstacles.push(wall(x - 300, y - 150, x - 300, y + 120));
  }
  for (let k = 0, placed = 0; k < 5000 && placed < WILDS.looseRocks; k++) {
    const x = rng.range(100, width - 100);
    const y = rng.range(100, height - 100);
    const r = rng.range(14, 44);
    if (!fits(map, x, y, r, place)) continue;
    map.obstacles.push(rock(x, y, r, rng));
    placed++;
  }

  map.portals.push({ x: spawn.x - 120, y: spawn.y, r: 44, target: 'town', label: 'Town' });
  // The camp: tents, supplies and a weapon rack around the fire.
  scatterDecor(map, rng, spawn.x + 40, spawn.y + 60, 190, ['tent', 'barrel', 'crate_A_big', 'sack', 'weaponrack', 'resource_lumber', 'bucket_water'], 11);
  // Ruins turn into old graveyards; loose bones and dead trees are scattered across the wilds.
  for (const g of map.ground.filter((p) => p.kind === 'plaza')) {
    if (g.shape.type !== 'circle') continue;
    scatterDecor(map, rng, g.shape.x, g.shape.y, g.shape.r, ['grave_grave_A', 'grave_grave_B', 'grave_gravestone', 'grave_gravemarker_A', 'grave_lantern_standing', 'grave_skull', 'grave_ribcage', 'grave_post_skull'], 16);
  }
  for (let i = 0; i < 40; i++) {
    const x = rng.range(200, width - 200);
    const y = rng.range(200, height - 200);
    scatterDecor(map, rng, x, y, 60, ['grave_bone_A', 'grave_skull', 'grave_ribcage', 'grave_tree_dead_small', 'dungeon_rubble_half', 'grave_pumpkin_orange'], 2);
  }
  map.packs = placePacks(map, rng);
  placeEntrances(map, rng, seed);
  return map;
}

/** Dungeon entrances: a ring of rubble around a staging portal, out in reachable ground far from camp. */
function placeEntrances(map: WorldMap, rng: Rng, seed: number): void {
  const gm = new GameMap(map);
  const reach = reachable(gm, map.spawn.x, map.spawn.y);
  for (let attempt = 0, placed = 0; attempt < 2000 && placed < DUNGEON.entrances; attempt++) {
    const x = rng.range(300, map.width - 300);
    const y = rng.range(300, map.height - 300);
    const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
    if (d < DUNGEON.entranceMinDistance || !reach.has(gm.navCell(x, y)) || gm.pointBlocked(x, y, 90, 'move')) continue;
    if (map.packs.some((p) => Math.hypot(p.x - x, p.y - y) < 260) || map.portals.some((p) => Math.hypot(p.x - x, p.y - y) < 1200)) continue;
    const level = 2 + Math.floor(d / WILDS.levelDistance);
    // Derived from the Wilds seed so everyone in one instance shares the same antechamber.
    const dungeonSeed = ((Math.imul(seed + 1, 2246822519) + placed * 3266489917) >>> 0) % 1_000_000;
    map.portals.push({ x, y, r: 46, target: 'staging', label: dungeonName(dungeonSeed), dungeon: { seed: dungeonSeed, level } });
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 130 } });
    scatterDecor(map, rng, x, y, 170, ['dungeon_rubble_large', 'dungeon_rubble_half', 'grave_skull', 'dungeon_torch_lit'], 10);
    placed++;
  }
}

/**
 * Packs get harder with distance from the camp. Only positions reachable from the spawn are used,
 * so a pack can never be sealed behind a ridge or river.
 */
function placePacks(map: WorldMap, rng: Rng): MonsterPack[] {
  const gm = new GameMap(map);
  const reach = reachable(gm, map.spawn.x, map.spawn.y);
  const packs: MonsterPack[] = [];
  let farthest: { x: number; y: number; d: number } | null = null;
  for (let attempt = 0; attempt < 3000 && packs.length < WILDS.packs; attempt++) {
    const x = rng.range(200, map.width - 200);
    const y = rng.range(200, map.height - 200);
    const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
    if (d < WILDS.safeRadius || !reach.has(gm.navCell(x, y)) || gm.pointBlocked(x, y, 40, 'move')) continue;
    if (packs.some((p) => Math.hypot(p.x - x, p.y - y) < WILDS.packSpacing)) continue;
    const level = 1 + Math.floor(d / WILDS.levelDistance);
    const pool: EnemyTypeId[] = ['chaser'];
    if (level >= 2) pool.push('shooter');
    if (level >= 3) pool.push('spinner');
    const types = [pool[rng.int(0, pool.length - 1)] ?? 'chaser', pool[rng.int(0, pool.length - 1)] ?? 'chaser'];
    packs.push({ x, y, types, count: rng.int(3, 6 + level), rareLeader: rng.next() < WILDS.rareLeaderChance, level, boss: false });
    if (!farthest || d > farthest.d) farthest = { x, y, d };
  }
  if (farthest) {
    const level = 2 + Math.floor(farthest.d / WILDS.levelDistance);
    packs.push({ x: farthest.x, y: farthest.y, types: ['spinner', 'shooter'], count: 6, rareLeader: true, level, boss: true });
  }
  return packs;
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
  }
}

const cache = new Map<string, { def: WorldMap; game: GameMap }>();

export function mapKey(desc: MapDescriptor): string {
  if (desc.kind === 'wilds') return `wilds:${desc.seed}`;
  if (desc.kind === 'town') return `town:${layoutHash(desc.layout ?? DEFAULT_TOWN_LAYOUT)}`;
  if (desc.kind === 'staging') return `staging:${desc.seed}:${desc.level}`;
  if (desc.kind === 'dungeon') return `dungeon:${desc.seed}:${desc.level}:${desc.run}`;
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
