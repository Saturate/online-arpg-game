import { DUNGEON, NAV, STREAMING, WILDS } from '../config/sim.js';
import { bossFor, rollPack, type Biome } from '../data/monsterPools.js';
import { Rng } from '../sim/rng.js';
import { CAMPS, placeCamps } from './camps.js';
import { dungeonName } from './dungeon.js';
import { inRect, rock, scatterDecor, tree } from './gen.js';
import { GameMap, type ChunkObstacleSource } from './gamemap.js';
import { fitsIn, SCATTER_RULES, Space, type PlacementRules } from './placement.js';
import type { Decor, MonsterPack, Obstacle, SafeZone, WorldMap } from './types.js';
import type { WorldPlan } from './worldPlan.js';

/**
 * World streaming step 3: a generated zone (a Wilds or an overworld zone) is a cheap zone-wide plan
 * plus content generated per chunk on demand.
 *
 * The plan holds everything that crosses chunks or must be decided for the whole zone at once:
 * rivers and bridges, the road, ridges, ruins, the town, gates, the waypoint, dungeon entrances,
 * camps, the boss, and how many forests, rocks, bone piles and packs each chunk gets. A chunk's
 * content is a pure function of the plan and the chunk's coordinates: its forests (whose trees may
 * reach up to `SPILL` into its neighbours), loose rocks, scattered bones and monster packs, each from
 * its own random stream.
 *
 * Spacing across chunk borders: chunks are generated in four phases by the parity of their
 * coordinates, and a chunk keeps clear of what its neighbours of earlier phases placed. Every
 * neighbour of a chunk has a different phase, and chunks that are not neighbours are a whole chunk
 * apart, more than any two spills and a spacing together, so every spacing rule holds across borders
 * exactly as inside a chunk. Generating one chunk alone gives exactly what a whole-zone build gives
 * for it, since the earlier phases it reads are themselves pure.
 */

/** How far a chunk's obstacles reach past its edge at most: a forest's spread of 320 plus a trunk. */
export const SPILL = 345;

/** What a chunk's trees and rocks keep clear of, as generation always has (`Placement` in gen.ts). */
const SCENERY: PlacementRules = { spacing: 46, riverPad: 40, keepOut: true, bridges: true };

const BONES = ['grave_bone_A', 'grave_skull', 'grave_ribcage', 'grave_tree_dead_small', 'dungeon_rubble_half', 'grave_pumpkin_orange'] as const;

/** The zone-wide numbers a chunk generator needs beyond the plan's map. */
export interface ZoneSpec {
  seed: number;
  biome: Biome;
  levels: readonly [number, number];
  /** Counts in WILDS are for the standard Wilds; a zone gets this many times as many. */
  scale: number;
  /** The zone's counts outright, in place of WILDS's times `scale`: the world's generation numbers. */
  counts?: { packs: number; forests: number; rocks: number; bones: number };
  /** Areas left alone (a town), with the margin generation keeps from them. */
  clearRects: { x: number; y: number; w: number; h: number; pad: number }[];
  /** The town as a safe zone, for camps. */
  keepClear: SafeZone[];
  /** Nothing is generated within this circle around the spawn. */
  spawnClear: { x: number; y: number; r: number };
  /** Kept clear by the layout: ruins, the waypoint, gate roads. */
  keepOutCircles: { x: number; y: number; r: number }[];
  keepOutRects: { x: number; y: number; w: number; h: number; pad: number }[];
  /** Kept clear by the layout: the world's roads. */
  keepOutCapsules?: { ax: number; ay: number; bx: number; by: number; r: number }[];
  /** Overworld zones have camps; a bare Wilds has its own camp at the spawn instead. */
  camps: boolean;
  /**
   * The seamless world's plan. When set it decides by position what `biome` and `levels` decide
   * for a single zone: biome, monster level, how many packs and forests a chunk gets and how big
   * packs are; and the boss, dungeon, rare and camp spots come from it instead of random tries.
   */
  plan?: WorldPlan;
}

/** Per chunk, how many of each thing it places. */
interface Quotas {
  forests: Uint16Array;
  rocks: Uint16Array;
  bones: Uint16Array;
  packs: Uint16Array;
}

/** Monster level rises with distance from the spawn, across the zone's band. */
export function levelFunction(map: WorldMap, levels: readonly [number, number]): (x: number, y: number) => number {
  const far = Math.max(1, Math.hypot(map.width, map.height) - 400);
  return (x, y) => {
    const t = Math.min(1, Math.hypot(x - map.spawn.x, y - map.spawn.y) / far);
    return Math.round(levels[0] + (levels[1] - levels[0]) * t);
  };
}

/** Nav cells reachable from a point, 4-connected, as one byte per cell. */
export function reachableCells(gm: GameMap, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(gm.navCols * gm.navRows);
  const start = gm.navCell(x, y);
  seen[start] = 1;
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
      if (seen[n] === 1) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return seen;
}

/** Splits `total` over chunks in proportion to `weights` (largest remainder, ties to the lower index). */
function apportion(total: number, weights: readonly number[]): Uint16Array {
  const out = new Uint16Array(weights.length);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return out;
  const fractions: { i: number; f: number }[] = [];
  let given = 0;
  for (const [i, w] of weights.entries()) {
    const exact = (total * w) / sum;
    const whole = Math.floor(exact);
    out[i] = whole;
    given += whole;
    fractions.push({ i, f: exact - whole });
  }
  fractions.sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; k < total - given; k++) {
    const pick = fractions[k];
    if (pick) out[pick.i] = (out[pick.i] ?? 0) + 1;
  }
  return out;
}

/** The phase a chunk is generated in: every neighbour of a chunk is in a different one. */
function phase(cx: number, cy: number): number {
  return (cx & 1) + 2 * (cy & 1);
}

/**
 * A generated zone: its plan (`def`, packs left out) and the content of each chunk, generated the
 * first time anything asks for it and kept. The server and every client build the same one from the
 * map descriptor, so the map message carries nothing but the seed.
 */
export class ZoneWorld implements ChunkObstacleSource {
  readonly size = STREAMING.chunkSize;
  readonly spill = SPILL;
  readonly cols: number;
  readonly rows: number;
  /** The plan as a map: everything zone-wide. Chunk content and every pack are not in it. */
  readonly def: WorldMap;
  private readonly spec: ZoneSpec;
  private readonly levelAt: (x: number, y: number) => number;
  private readonly biomeAt: (x: number, y: number) => Biome;
  /** The world plan behind this map, for the region of a spot; null for a single zone. */
  readonly plan: WorldPlan | null;
  /** Nav cells reachable from the spawn past the plan's barriers (rivers, ridges, ruins, the town). */
  private readonly reach: Uint8Array;
  private readonly navCols: number;
  private readonly navRows: number;
  private readonly space = new Space();
  private readonly quotas: Quotas;
  /** Packs the plan places (the boss, guarded camps), by chunk. */
  private readonly planPacks: MonsterPack[][];
  private readonly allPlanPacks: MonsterPack[];
  private readonly entrances: { x: number; y: number }[];
  private readonly openCamps: { x: number; y: number }[];
  private readonly obstacleCache: (Obstacle[] | undefined)[];
  private readonly packCache: (MonsterPack[] | undefined)[];
  private readonly decorCache: (Decor[] | undefined)[];
  private generated = 0;

  /** Finishes the plan of `map` (rivers, ridges, ruins, town, gates and waypoint already laid out). */
  constructor(map: WorldMap, spec: ZoneSpec) {
    this.spec = spec;
    this.cols = Math.max(1, Math.ceil(map.width / this.size));
    this.rows = Math.max(1, Math.ceil(map.height / this.size));
    const plan = spec.plan ?? null;
    this.plan = plan;
    this.levelAt = plan ? (x, y) => plan.levelAt(x, y) : levelFunction(map, spec.levels);
    this.biomeAt = plan ? (x, y) => plan.biomeAt(x, y) : () => spec.biome;
    const gm = new GameMap(map);
    this.navCols = gm.navCols;
    this.navRows = gm.navRows;
    this.reach = reachableCells(gm, map.spawn.x, map.spawn.y);
    const reach = { has: (cell: number): boolean => this.reach[cell] === 1 };

    map.packs = [];
    // The plan's obstacles, water and bridges, indexed for everything placed from here on.
    for (const o of map.obstacles) this.space.obstacle(o);
    for (const r of map.rivers) this.space.river(r.path, r.width);
    for (const b of map.bridges) this.space.bridge(b.x, b.y, b.length);
    if (plan) this.placePlanned(map, gm, plan);
    else this.placeBoss(map, gm);
    this.entrances = plan ? this.placePlannedEntrances(map, gm, plan) : this.placeEntrances(map, gm);
    if (spec.camps) {
      const before = map.obstacles.length;
      const campRules: PlacementRules = { spacing: 8, riverPad: 40, keepOut: false, bridges: true };
      const spots = plan?.spots.filter((p) => p.kind === 'camp');
      placeCamps(map, spec.seed, gm, reach, spec.keepClear, this.levelAt, this.biomeAt, spec.scale, (x, y, r) => fitsIn(this.space, map.width, map.height, x, y, r, campRules), spots);
      // The tents.
      for (const o of map.obstacles.slice(before)) this.space.obstacle(o);
    }
    this.openCamps = (map.camps ?? []).filter((c) => !c.guarded);
    this.allPlanPacks = map.packs;
    this.planPacks = Array.from({ length: this.cols * this.rows }, () => []);
    for (const p of map.packs) this.planPacks[this.chunkIndex(p.x, p.y)]?.push(p);
    this.def = { ...map, packs: [] };

    this.indexKeepOuts(map);
    this.quotas = this.apportionAll(map);
    const n = this.cols * this.rows;
    this.obstacleCache = new Array<Obstacle[] | undefined>(n);
    this.packCache = new Array<MonsterPack[] | undefined>(n);
    this.decorCache = new Array<Decor[] | undefined>(n);
  }

  private chunkIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
    return cy * this.cols + cx;
  }

  private navCell(x: number, y: number): number {
    const cx = Math.min(this.navCols - 1, Math.max(0, Math.floor(x / NAV.cellSize)));
    const cy = Math.min(this.navRows - 1, Math.max(0, Math.floor(y / NAV.cellSize)));
    return cy * this.navCols + cx;
  }

  /**
   * The boss holds the far end with an escort, over an ordinary pack, as the farthest pack always
   * had it. The spot is the farthest of a few hundred tries that the plan lets a pack stand on.
   */
  private placeBoss(map: WorldMap, gm: GameMap): void {
    const rng = Rng.stream(this.spec.seed, 'boss');
    let best: { x: number; y: number; d: number } | null = null;
    for (let i = 0; i < 400; i++) {
      const x = rng.range(200, map.width - 200);
      const y = rng.range(200, map.height - 200);
      const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
      if (best && d <= best.d) continue;
      if (d < WILDS.safeRadius || this.reach[gm.navCell(x, y)] !== 1 || gm.pointBlocked(x, y, 60, 'move')) continue;
      if (this.spec.clearRects.some((z) => inRect(x, y, z, z.pad + WILDS.aggroRadius))) continue;
      best = { x, y, d };
    }
    if (!best) return;
    const biome = this.biomeAt(best.x, best.y);
    const under = this.levelAt(best.x, best.y);
    map.packs.push({ x: best.x, y: best.y, ...rollPack(rng, biome, under), rareLeader: rng.next() < WILDS.rareLeaderChance, level: under, boss: false });
    const level = under + 1;
    const escort = rollPack(rng, biome, level);
    map.packs.push({ x: best.x, y: best.y, types: [bossFor(biome, level), ...escort.types], count: Math.max(3, Math.round(escort.count * 0.6)), rareLeader: true, level, boss: true });
    this.spec.keepOutCircles.push({ x: best.x, y: best.y, r: 60 });
  }

  /** The nearest spot within `range` of (x, y) that is reachable and open for a circle of `r`, or null. */
  private openNear(gm: GameMap, rng: Rng, x: number, y: number, r: number, range: number): { x: number; y: number } | null {
    for (let k = 0; k < 40; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = k === 0 ? 0 : (range * k) / 40;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      if (px < 200 || py < 200 || px > gm.width - 200 || py > gm.height - 200) continue;
      if (this.reach[gm.navCell(px, py)] === 1 && !gm.pointBlocked(px, py, r, 'move')) return { x: px, y: py };
    }
    return null;
  }

  /** The world's bosses (one per region, at its deepest end) and its rare packs at dead ends. */
  private placePlanned(map: WorldMap, gm: GameMap, plan: WorldPlan): void {
    const rng = Rng.stream(this.spec.seed, 'boss');
    for (const spot of plan.spots) {
      if (spot.kind !== 'boss' && spot.kind !== 'rare') continue;
      const at = this.openNear(gm, rng, spot.x, spot.y, 60, 360);
      if (!at || map.packs.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < WILDS.packSpacing)) continue;
      const biome = this.biomeAt(at.x, at.y);
      const under = this.levelAt(at.x, at.y);
      if (spot.kind === 'rare') {
        // A dead end's reward: a rare leader a level up, with a bigger crowd than the road's packs.
        const level = under + 1;
        const pack = rollPack(rng, biome, level);
        map.packs.push({ x: at.x, y: at.y, types: pack.types, count: Math.max(2, Math.round(pack.count * plan.packScale(at.x, at.y) * 1.25)), rareLeader: true, level, boss: false });
        this.spec.keepOutCircles.push({ x: at.x, y: at.y, r: 60 });
        continue;
      }
      map.packs.push({ x: at.x, y: at.y, ...rollPack(rng, biome, under), rareLeader: rng.next() < WILDS.rareLeaderChance, level: under, boss: false });
      const level = under + 1;
      const escort = rollPack(rng, biome, level);
      map.packs.push({ x: at.x, y: at.y, types: [bossFor(biome, level), ...escort.types], count: Math.max(3, Math.round(escort.count * 0.6)), rareLeader: true, level, boss: true });
      this.spec.keepOutCircles.push({ x: at.x, y: at.y, r: 60 });
    }
  }

  /** The world's dungeon entrances, at the dead ends the plan gave them. */
  private placePlannedEntrances(map: WorldMap, gm: GameMap, plan: WorldPlan): { x: number; y: number }[] {
    const rng = Rng.stream(this.spec.seed, 'entrances');
    const out: { x: number; y: number }[] = [];
    for (const spot of plan.spots) {
      if (spot.kind !== 'dungeon') continue;
      const at = this.openNear(gm, rng, spot.x, spot.y, 90, 320);
      if (!at || map.portals.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < 500)) continue;
      this.addEntrance(map, rng, at.x, at.y, out.length);
      out.push(at);
    }
    return out;
  }

  /** A ring of rubble around a staging portal; `index` makes the dungeon's seed. */
  private addEntrance(map: WorldMap, rng: Rng, x: number, y: number, index: number): void {
    const level = this.levelAt(x, y) + 1;
    // Derived from the map seed so everyone in one instance shares the same antechamber.
    const dungeonSeed = ((Math.imul(this.spec.seed + 1, 2246822519) + index * 3266489917) >>> 0) % 1_000_000;
    map.portals.push({ x, y, r: 46, target: 'staging', label: dungeonName(dungeonSeed), dungeon: { seed: dungeonSeed, level } });
    map.ground.push({ kind: 'plaza', shape: { type: 'circle', x, y, r: 130 } });
    scatterDecor(map, rng, x, y, 170, ['dungeon_rubble_large', 'dungeon_rubble_half', 'grave_skull', 'dungeon_torch_lit'], 10, (px, py) => this.space.conflicts(px, py, 0, SCATTER_RULES));
    // The rubble ring reaches 170 out; trees and rocks generated later keep off it.
    this.spec.keepOutCircles.push({ x, y, r: 170 });
  }

  /** Dungeon entrances: a ring of rubble around a staging portal, out in reachable ground far from the spawn. */
  private placeEntrances(map: WorldMap, gm: GameMap): { x: number; y: number }[] {
    const rng = Rng.stream(this.spec.seed, 'entrances');
    const out: { x: number; y: number }[] = [];
    for (let attempt = 0, placed = 0; attempt < 2000 && placed < DUNGEON.entrances; attempt++) {
      const x = rng.range(300, map.width - 300);
      const y = rng.range(300, map.height - 300);
      const d = Math.hypot(x - map.spawn.x, y - map.spawn.y);
      if (d < DUNGEON.entranceMinDistance || this.reach[gm.navCell(x, y)] !== 1 || gm.pointBlocked(x, y, 90, 'move')) continue;
      if (this.spec.clearRects.some((z) => inRect(x, y, z, z.pad))) continue;
      if (map.packs.some((p) => Math.hypot(p.x - x, p.y - y) < 260) || map.portals.some((p) => Math.hypot(p.x - x, p.y - y) < 1200)) continue;
      this.addEntrance(map, rng, x, y, placed);
      out.push({ x, y });
      placed++;
    }
    return out;
  }

  /** What chunk content keeps out of, once the plan has placed everything of its own. */
  private indexKeepOuts(map: WorldMap): void {
    const s = this.space;
    const c = this.spec.spawnClear;
    s.keepOutCircle(c.x, c.y, c.r);
    for (const k of this.spec.keepOutCircles) s.keepOutCircle(k.x, k.y, k.r);
    for (const camp of map.camps ?? []) s.keepOutCircle(camp.x, camp.y, CAMPS.radius + 8);
    for (const r of this.spec.clearRects) s.keepOutRect(r);
    for (const r of this.spec.keepOutRects) s.keepOutRect(r);
    for (const k of this.spec.keepOutCapsules ?? []) s.keepOutCapsule(k.ax, k.ay, k.bx, k.by, k.r);
  }

  /** The chunk's square clipped to `[m, size - m]` of the map on both axes, or null when empty. */
  private span(cx: number, cy: number, m: number): { x0: number; y0: number; x1: number; y1: number } | null {
    const x0 = Math.max(m, cx * this.size);
    const x1 = Math.min(this.def.width - m, (cx + 1) * this.size);
    const y0 = Math.max(m, cy * this.size);
    const y1 = Math.min(this.def.height - m, (cy + 1) * this.size);
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }

  /** The part of a chunk's span where `ok` holds, by a 4 by 4 sample, times its area. */
  private usableArea(cx: number, cy: number, m: number, ok: (x: number, y: number) => boolean): number {
    const s = this.span(cx, cy, m);
    if (!s) return 0;
    let hits = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        if (ok(s.x0 + ((i + 0.5) / 4) * (s.x1 - s.x0), s.y0 + ((j + 0.5) / 4) * (s.y1 - s.y0))) hits++;
      }
    }
    return (hits / 16) * (s.x1 - s.x0) * (s.y1 - s.y0);
  }

  /**
   * The zone's counts are the ones the whole-zone generator always used (WILDS counts times the
   * zone's scale) or the world's own, spread over the chunks by how much of each can take them, so
   * a town or a river does not thin out the rest of the zone.
   */
  private apportionAll(map: WorldMap): Quotas {
    const { scale } = this.spec;
    const counts = this.spec.counts ?? { packs: Math.round(WILDS.packs * scale), forests: Math.round(WILDS.forests * scale), rocks: Math.round(WILDS.looseRocks * scale), bones: Math.round(40 * scale) };
    const n = this.cols * this.rows;
    const each = (fn: (cx: number, cy: number) => number): number[] => Array.from({ length: n }, (_, i) => fn(i % this.cols, Math.floor(i / this.cols)));
    const area = (m: number) => (cx: number, cy: number) => {
      const s = this.span(cx, cy, m);
      return s ? (s.x1 - s.x0) * (s.y1 - s.y0) : 0;
    };
    const inMap = (x: number, y: number, r: number): boolean => x >= r + 50 && y >= r + 50 && x <= map.width - r - 50 && y <= map.height - r - 50;
    const rockFits = (x: number, y: number): boolean => inMap(x, y, 20) && !this.space.conflicts(x, y, 20, SCENERY);
    const packFits = (x: number, y: number): boolean => this.packSpotOpen(x, y);
    const boneFits = (x: number, y: number): boolean => !this.spec.clearRects.some((z) => inRect(x, y, z, z.pad));
    // The pack under each boss is one of the zone's packs.
    const packs = Math.max(0, counts.packs - this.allPlanPacks.filter((p) => p.boss).length);
    // A world weighs each chunk by its middle: thicker forest off the roads and in wooded regions, more packs further out.
    const plan = this.spec.plan;
    const mid = (cx: number, cy: number): [number, number] => [Math.min(map.width, (cx + 0.5) * this.size), Math.min(map.height, (cy + 0.5) * this.size)];
    const forestWeight = (cx: number, cy: number): number => (plan ? plan.forestWeight(...mid(cx, cy)) : 1);
    const packWeight = (cx: number, cy: number): number => (plan ? plan.packWeight(...mid(cx, cy)) : 1);
    return {
      forests: apportion(counts.forests, each((cx, cy) => area(300)(cx, cy) * forestWeight(cx, cy))),
      rocks: apportion(counts.rocks, each((cx, cy) => this.usableArea(cx, cy, 100, rockFits))),
      bones: apportion(counts.bones, each((cx, cy) => this.usableArea(cx, cy, 200, boneFits))),
      packs: apportion(packs, each((cx, cy) => this.usableArea(cx, cy, 200, packFits) * packWeight(cx, cy))),
    };
  }

  /** Whether the plan lets a pack stand here: away from the spawn and the town, reachable, on open ground. */
  private packSpotOpen(x: number, y: number): boolean {
    const { spawn, width, height } = this.def;
    if (Math.hypot(x - spawn.x, y - spawn.y) < WILDS.safeRadius || this.reach[this.navCell(x, y)] !== 1) return false;
    if (x < 40 || y < 40 || x > width - 40 || y > height - 40 || this.space.blocks(x, y, 40)) return false;
    return !this.spec.clearRects.some((z) => inRect(x, y, z, z.pad + WILDS.aggroRadius));
  }

  private inChunks(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  /** Calls `fn` with each chunk of the 3 by 3 block around (cx, cy) inside the zone. */
  private around(cx: number, cy: number, fn: (nx: number, ny: number) => void): void {
    for (let ny = cy - 1; ny <= cy + 1; ny++) for (let nx = cx - 1; nx <= cx + 1; nx++) if (this.inChunks(nx, ny)) fn(nx, ny);
  }

  /** Whether a spot can be walked to from the spawn past the plan's barriers (rivers, ridges, ruins, the town). */
  reachable(x: number, y: number): boolean {
    return this.reach[this.navCell(x, y)] === 1;
  }

  /** How many chunks have had their obstacles generated, for tests and the bench. */
  get generatedChunks(): number {
    return this.generated;
  }

  /** A chunk's trees and rocks. Some may stand up to `SPILL` past its edge. */
  obstacles(cx: number, cy: number): readonly Obstacle[] {
    if (!this.inChunks(cx, cy)) return [];
    const i = cy * this.cols + cx;
    const hit = this.obstacleCache[i];
    if (hit) return hit;
    const out = this.makeObstacles(cx, cy);
    this.obstacleCache[i] = out;
    this.generated++;
    return out;
  }

  private makeObstacles(cx: number, cy: number): Obstacle[] {
    const local = new Space();
    const mine = phase(cx, cy);
    this.around(cx, cy, (nx, ny) => {
      if (phase(nx, ny) < mine) for (const o of this.obstacles(nx, ny)) local.obstacle(o);
    });
    const { width, height } = this.def;
    const fitsHere = (x: number, y: number, r: number): boolean =>
      x >= r + 50 && y >= r + 50 && x <= width - r - 50 && y <= height - r - 50 && !this.space.conflicts(x, y, r, SCENERY) && !local.conflicts(x, y, r, SCENERY);
    const rng = Rng.stream(this.spec.seed, `chunk:${cx},${cy}:scenery`);
    const i = cy * this.cols + cx;
    const out: Obstacle[] = [];
    const forestSpan = this.span(cx, cy, 300);
    for (let f = 0; forestSpan && f < (this.quotas.forests[i] ?? 0); f++) {
      const fx = rng.range(forestSpan.x0, forestSpan.x1);
      const fy = rng.range(forestSpan.y0, forestSpan.y1);
      const count = rng.int(12, 26);
      for (let k = 0, placed = 0; k < count * 8 && placed < count; k++) {
        const x = fx + rng.range(-320, 320);
        const y = fy + rng.range(-260, 260);
        if (!fitsHere(x, y, 24)) continue;
        const t = tree(x, y, rng);
        out.push(t);
        local.obstacle(t);
        placed++;
      }
    }
    const rockSpan = this.span(cx, cy, 100);
    const rocks = this.quotas.rocks[i] ?? 0;
    for (let k = 0, placed = 0; rockSpan && k < rocks * 60 && placed < rocks; k++) {
      const x = rng.range(rockSpan.x0, rockSpan.x1);
      const y = rng.range(rockSpan.y0, rockSpan.y1);
      const r = rng.range(14, 44);
      if (!fitsHere(x, y, r)) continue;
      const o = rock(x, y, r, rng);
      out.push(o);
      local.obstacle(o);
      placed++;
    }
    return out;
  }

  /** The obstacles that can reach into a chunk: its own and its neighbours'. */
  private obstaclesAround(cx: number, cy: number): Space {
    const s = new Space();
    this.around(cx, cy, (nx, ny) => {
      for (const o of this.obstacles(nx, ny)) s.obstacle(o);
    });
    return s;
  }

  /** The monster packs standing in a chunk: the plan's (boss, camp guards) first, then its own. */
  packs(cx: number, cy: number): readonly MonsterPack[] {
    if (!this.inChunks(cx, cy)) return [];
    const i = cy * this.cols + cx;
    const hit = this.packCache[i];
    if (hit) return hit;
    const out = [...(this.planPacks[i] ?? []), ...this.makePacks(cx, cy)];
    this.packCache[i] = out;
    return out;
  }

  private makePacks(cx: number, cy: number): MonsterPack[] {
    const i = cy * this.cols + cx;
    const wanted = this.quotas.packs[i] ?? 0;
    const span = this.span(cx, cy, 200);
    if (!span || wanted === 0) return [];
    const blockers = this.obstaclesAround(cx, cy);
    const near: MonsterPack[] = [...this.allPlanPacks];
    const mine = phase(cx, cy);
    this.around(cx, cy, (nx, ny) => {
      if (phase(nx, ny) < mine) near.push(...this.packs(nx, ny));
    });
    const rng = Rng.stream(this.spec.seed, `chunk:${cx},${cy}:packs`);
    const out: MonsterPack[] = [];
    for (let attempt = 0; attempt < wanted * 150 && out.length < wanted; attempt++) {
      const x = rng.range(span.x0, span.x1);
      const y = rng.range(span.y0, span.y1);
      if (!this.packSpotOpen(x, y) || blockers.blocks(x, y, 40)) continue;
      const crowded = (p: { x: number; y: number }, gap: number): boolean => Math.hypot(p.x - x, p.y - y) < gap;
      if (near.some((p) => crowded(p, WILDS.packSpacing)) || out.some((p) => crowded(p, WILDS.packSpacing))) continue;
      // An unguarded camp stays unguarded; an entrance keeps its approach clear.
      if (this.openCamps.some((c) => crowded(c, CAMPS.unguardedPackGap)) || this.entrances.some((e) => crowded(e, 260))) continue;
      const level = this.levelAt(x, y);
      const pack = rollPack(rng, this.biomeAt(x, y), level);
      const count = this.plan ? Math.max(1, Math.round(pack.count * this.plan.packScale(x, y))) : pack.count;
      out.push({ x, y, types: pack.types, count, rareLeader: rng.next() < WILDS.rareLeaderChance, level, boss: false });
    }
    return out;
  }

  /** Visual-only decor of a chunk: scattered bones and dead saplings. The server never asks. */
  decor(cx: number, cy: number): readonly Decor[] {
    if (!this.inChunks(cx, cy)) return [];
    const i = cy * this.cols + cx;
    const hit = this.decorCache[i];
    if (hit) return hit;
    const out = this.makeDecor(cx, cy);
    this.decorCache[i] = out;
    return out;
  }

  private makeDecor(cx: number, cy: number): Decor[] {
    const i = cy * this.cols + cx;
    const span = this.span(cx, cy, 200);
    const wanted = this.quotas.bones[i] ?? 0;
    if (!span || wanted === 0) return [];
    const local = this.obstaclesAround(cx, cy);
    const { width, height } = this.def;
    const rng = Rng.stream(this.spec.seed, `chunk:${cx},${cy}:decor`);
    const out: Decor[] = [];
    for (let n = 0; n < wanted; n++) {
      const x = rng.range(span.x0, span.x1);
      const y = rng.range(span.y0, span.y1);
      if (this.spec.clearRects.some((z) => inRect(x, y, z, z.pad))) continue;
      // Two pieces within 60 of the spot, as `scatterDecor` places them.
      for (let k = 0, placed = 0; k < 12 && placed < 2; k++) {
        const a = rng.range(0, Math.PI * 2);
        const d = Math.sqrt(rng.next()) * 60;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        if (px < 30 || py < 30 || px > width - 30 || py > height - 30) continue;
        if (this.space.conflicts(px, py, 0, SCATTER_RULES) || local.conflicts(px, py, 0, SCATTER_RULES)) continue;
        const asset = BONES[rng.int(0, BONES.length - 1)] ?? 'grave_bone_A';
        out.push({ asset, x: px, y: py, angle: rng.range(0, Math.PI * 2), scale: rng.range(0.85, 1.2) });
        placed++;
      }
    }
    return out;
  }

  /** The zone as one map, every chunk generated: the plan's obstacles first, then each chunk's in order. */
  whole(): WorldMap {
    const obstacles = [...this.def.obstacles];
    const decor = [...this.def.decor];
    const packs: MonsterPack[] = [];
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        obstacles.push(...this.obstacles(cx, cy));
        decor.push(...this.decor(cx, cy));
        packs.push(...this.packs(cx, cy));
      }
    }
    return { ...this.def, obstacles, decor, packs };
  }
}

/** The decor assets chunks scatter, for the client's check that none of them is a light. */
export const CHUNK_DECOR_ASSETS: readonly string[] = BONES;
