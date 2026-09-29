import { DUNGEON, NAV } from '../config/sim.js';
import { Rng } from '../sim/rng.js';
import { bossFor, rollPack, type Biome } from '../data/monsterPools.js';
import { emptyMap } from './gen.js';
import type { DungeonRef, MonsterPack, Obstacle, WorldMap } from './types.js';

/**
 * Dungeons are carved out of solid rock on a grid that matches the nav grid, so walls line up with
 * pathfinding cells exactly. Rooms sit in a coarse grid of slots and are joined by a random spanning
 * tree plus a few extra corridors, which gives loops without making the layout a maze.
 */

const CELL = NAV.cellSize;

interface Room {
  slot: number;
  /** Cell bounds, inclusive start and exclusive end. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One place derives the name, so the entrance label, antechamber and dungeon always agree. */
export function dungeonName(seed: number): string {
  return DUNGEON.names[seed % DUNGEON.names.length] ?? 'The Depths';
}

function centre(r: Room): { cx: number; cy: number } {
  return { cx: Math.floor((r.x0 + r.x1) / 2), cy: Math.floor((r.y0 + r.y1) / 2) };
}

function cellPos(c: number): number {
  return c * CELL + CELL / 2;
}

/** Axis-aligned run of cells turned into a wall box. */
function wallBox(x0: number, y0: number, x1: number, y1: number): Obstacle {
  const hw = ((x1 - x0) * CELL) / 2;
  const hh = ((y1 - y0) * CELL) / 2;
  return { kind: 'cavewall', shape: { type: 'box', x: x0 * CELL + hw, y: y0 * CELL + hh, hw, hh, angle: 0 }, blocksMove: true, blocksShots: true, visual: DUNGEON.wallHeight };
}

/**
 * Only solid cells touching floor become walls: the rest of the rock is unreachable, so skipping it
 * keeps the obstacle count in the hundreds. Rows are merged into runs, then equal runs on consecutive
 * rows into rectangles.
 */
function wallsFromGrid(floor: Uint8Array, cols: number, rows: number): Obstacle[] {
  const isFloor = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && floor[y * cols + x] === 1;
  const edge = (x: number, y: number) => {
    if (isFloor(x, y)) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isFloor(x + dx, y + dy)) return true;
    return false;
  };
  const out: Obstacle[] = [];
  let open = new Map<string, { x0: number; x1: number; y0: number }>();
  for (let y = 0; y <= rows; y++) {
    const runs: { x0: number; x1: number }[] = [];
    if (y < rows) {
      for (let x = 0; x < cols; ) {
        if (!edge(x, y)) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < cols && edge(x, y)) x++;
        runs.push({ x0, x1: x });
      }
    }
    const next = new Map<string, { x0: number; x1: number; y0: number }>();
    for (const r of runs) {
      const key = `${r.x0}:${r.x1}`;
      next.set(key, open.get(key) ?? { ...r, y0: y });
    }
    for (const [key, r] of open) if (!next.has(key)) out.push(wallBox(r.x0, r.y0, r.x1, y));
    open = next;
  }
  return out;
}

export interface DungeonLayout {
  map: WorldMap;
  /** Room order by distance from the entrance; the last is the boss room. */
  depth: number[];
}

export function dungeonMap(ref: DungeonRef, run: number): WorldMap {
  return generateDungeon(ref, run).map;
}

export function generateDungeon(ref: DungeonRef, run: number): DungeonLayout {
  const rng = new Rng(Math.imul(ref.seed, 2654435761) ^ (run * 40503) ^ ref.level);
  // Dungeons are crypts or caves; the seed picks, so one entrance always leads to the same kind.
  const biome: Biome = ref.seed % 2 === 0 ? 'crypt' : 'cave';
  const { slotsX, slotsY, slotCells } = DUNGEON;
  const cols = slotsX * slotCells + 2;
  const rows = slotsY * slotCells + 2;
  const floor = new Uint8Array(cols * rows);
  const carve = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(1, y0); y < Math.min(rows - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(cols - 1, x1); x++) floor[y * cols + x] = 1;
  };

  const rooms: Room[] = [];
  for (let sy = 0; sy < slotsY; sy++) {
    for (let sx = 0; sx < slotsX; sx++) {
      const w = rng.int(DUNGEON.roomMin, DUNGEON.roomMax);
      const h = rng.int(DUNGEON.roomMin, DUNGEON.roomMax);
      const x0 = 1 + sx * slotCells + rng.int(1, slotCells - w - 1);
      const y0 = 1 + sy * slotCells + rng.int(1, slotCells - h - 1);
      rooms.push({ slot: sy * slotsX + sx, x0, y0, x1: x0 + w, y1: y0 + h });
    }
  }
  for (const r of rooms) carve(r.x0, r.y0, r.x1, r.y1);

  // Randomised depth-first spanning tree over the slot grid, from the entrance on the west edge.
  const start = rng.int(0, slotsY - 1) * slotsX;
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  const neighbours = (s: number): number[] => {
    const x = s % slotsX;
    const y = (s - x) / slotsX;
    const out: number[] = [];
    if (x > 0) out.push(s - 1);
    if (x < slotsX - 1) out.push(s + 1);
    if (y > 0) out.push(s - slotsX);
    if (y < slotsY - 1) out.push(s + slotsX);
    return out;
  };
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const s = stack[stack.length - 1] ?? start;
    const options = neighbours(s).filter((n) => !seen.has(n));
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const n = options[rng.int(0, options.length - 1)] ?? options[0] ?? s;
    link(s, n);
    seen.add(n);
    stack.push(n);
  }
  for (let i = 0; i < DUNGEON.extraLinks; i++) {
    const s = rng.int(0, rooms.length - 1);
    const options = neighbours(s).filter((n) => !(links.get(s) ?? []).includes(n));
    const n = options[rng.int(0, options.length - 1)];
    if (n !== undefined) link(s, n);
  }

  // L-shaped corridors between linked room centres.
  const half = Math.floor(DUNGEON.corridorCells / 2);
  for (const [a, list] of links) {
    for (const b of list) {
      if (b < a) continue;
      const ra = rooms[a];
      const rb = rooms[b];
      if (!ra || !rb) continue;
      const pa = centre(ra);
      const pb = centre(rb);
      const horizontalFirst = rng.next() < 0.5;
      const bend = horizontalFirst ? { x: pb.cx, y: pa.cy } : { x: pa.cx, y: pb.cy };
      for (const [p, q] of [
        [{ x: pa.cx, y: pa.cy }, bend],
        [bend, { x: pb.cx, y: pb.cy }],
      ] as const) {
        carve(Math.min(p.x, q.x) - half, Math.min(p.y, q.y) - half, Math.max(p.x, q.x) + half + 1, Math.max(p.y, q.y) + half + 1);
      }
    }
  }

  // Breadth-first depth over the room graph: packs get harder deeper in, the boss waits at the end.
  const depthOf = new Map([[start, 0]]);
  const order = [start];
  for (let i = 0; i < order.length; i++) {
    const s = order[i] ?? start;
    for (const n of links.get(s) ?? []) {
      if (depthOf.has(n)) continue;
      depthOf.set(n, (depthOf.get(s) ?? 0) + 1);
      order.push(n);
    }
  }
  const bossSlot = order[order.length - 1] ?? start;
  const maxDepth = depthOf.get(bossSlot) ?? 1;

  const startRoom = rooms[start];
  const bossRoom = rooms[bossSlot];
  if (!startRoom || !bossRoom) throw new Error('dungeon without rooms');
  const sc = centre(startRoom);
  const spawn = { x: cellPos(sc.cx), y: cellPos(sc.cy) };
  const map = emptyMap({
    name: dungeonName(ref.seed),
    theme: 'dungeon',
    width: cols * CELL,
    height: rows * CELL,
    spawn,
    waves: false,
    safe: false,
    groundTint: 0x2a2622,
  });

  // Floor patches are the carved area as merged row runs, so the renderer can lay flagstones.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; ) {
      if (floor[y * cols + x] !== 1) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < cols && floor[y * cols + x] === 1) x++;
      map.ground.push({ kind: 'floor', shape: { type: 'box', x: ((x0 + x) * CELL) / 2, y: y * CELL + CELL / 2, hw: ((x - x0) * CELL) / 2, hh: CELL / 2, angle: 0 } });
    }
  }
  map.obstacles.push(...wallsFromGrid(floor, cols, rows));

  map.portals.push({ x: spawn.x - 90, y: spawn.y, r: 40, target: 'wilds', label: 'Leave' });
  const bc = centre(bossRoom);
  map.portals.push({ x: cellPos(bossRoom.x1 - 3), y: cellPos(bc.cy), r: 44, target: 'wilds', label: 'Exit' });

  const lamps: { x: number; y: number }[] = [];
  const packs: MonsterPack[] = [];
  for (const room of rooms) {
    // Torches stand one cell in from two opposite corners.
    lamps.push({ x: cellPos(room.x0 + 1), y: cellPos(room.y0 + 1) }, { x: cellPos(room.x1 - 2), y: cellPos(room.y1 - 2) });
    const depth = depthOf.get(room.slot) ?? 0;
    for (let i = 0; i < 6; i++) {
      const assets = ['dungeon_barrel_large', 'dungeon_barrel_small_stack', 'dungeon_box_stacked', 'dungeon_crates_stacked', 'dungeon_rubble_half', 'dungeon_rubble_large', 'dungeon_candle_lit', 'grave_skull', 'grave_bone_A'];
      // Props hug the walls so the middle of each room stays clear for fighting.
      const alongX = rng.next() < 0.5;
      const x = alongX ? rng.range(room.x0 + 1, room.x1 - 1) : rng.next() < 0.5 ? room.x0 + 0.6 : room.x1 - 0.6;
      const y = alongX ? (rng.next() < 0.5 ? room.y0 + 0.6 : room.y1 - 0.6) : rng.range(room.y0 + 1, room.y1 - 1);
      map.decor.push({ asset: assets[rng.int(0, assets.length - 1)] ?? 'dungeon_rubble_half', x: x * CELL, y: y * CELL, angle: rng.range(0, Math.PI * 2), scale: rng.range(0.85, 1.15) });
    }
    if (room.slot === start) continue;
    const level = ref.level + Math.floor((depth / Math.max(1, maxDepth)) * DUNGEON.levelSpread);
    const c = centre(room);
    if (room.slot === bossSlot) {
      const escort = rollPack(rng, biome, level + 1);
      packs.push({ x: cellPos(c.cx), y: cellPos(c.cy), types: [bossFor(biome, level + 1), ...escort.types], count: Math.max(3, Math.round(escort.count * 0.6)), rareLeader: true, level: level + 1, boss: true });
      continue;
    }
    packs.push({ x: cellPos(c.cx), y: cellPos(c.cy), ...rollPack(rng, biome, level), rareLeader: rng.next() < DUNGEON.rareLeaderChance, level, boss: false });
  }
  map.lamps = lamps;
  map.packs = packs;
  return { map, depth: order };
}

/**
 * The antechamber: a small safe hall where a party gathers before a run. The sealed gate at the east
 * end opens once everyone inside is ready, and stays open for latecomers while a run is live.
 */
interface AntechamberOptions {
  name: string;
  seed: number;
  /** The way out, on the west wall. */
  back: { target: 'wilds' | 'town'; label: string };
  gateLabel: string;
}

/** A torch-lit hall with a narrowing throat toward the gate; dungeons and the Arena share it. */
function antechamber(o: AntechamberOptions): { map: WorldMap; rng: Rng } {
  const rng = new Rng(o.seed ^ 0x5eed);
  const width = 1400;
  const height = 900;
  const map = emptyMap({
    name: o.name,
    theme: 'staging',
    width,
    height,
    spawn: { x: 360, y: height / 2 },
    waves: false,
    safe: true,
    groundTint: 0x2a2622,
  });
  const cols = Math.round(width / CELL);
  const rows = Math.round(height / CELL);
  const floor = new Uint8Array(cols * rows);
  for (let y = 3; y < rows - 3; y++) for (let x = 2; x < cols - 7; x++) floor[y * cols + x] = 1;
  for (let y = 8; y < rows - 8; y++) for (let x = cols - 7; x < cols - 2; x++) floor[y * cols + x] = 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; ) {
      if (floor[y * cols + x] !== 1) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < cols && floor[y * cols + x] === 1) x++;
      map.ground.push({ kind: 'floor', shape: { type: 'box', x: ((x0 + x) * CELL) / 2, y: y * CELL + CELL / 2, hw: ((x - x0) * CELL) / 2, hh: CELL / 2, angle: 0 } });
    }
  }
  map.obstacles.push(...wallsFromGrid(floor, cols, rows));
  map.portals.push({ x: 180, y: height / 2, r: 40, target: o.back.target, label: o.back.label });
  map.portals.push({ x: (cols - 3) * CELL, y: height / 2, r: 50, target: 'dungeon', label: o.gateLabel });
  map.lamps = [
    { x: 200, y: 180 },
    { x: 200, y: height - 180 },
    { x: 800, y: 180 },
    { x: 800, y: height - 180 },
  ];
  return { map, rng };
}

export function stagingMap(ref: DungeonRef): WorldMap {
  const { map, rng } = antechamber({ name: `${dungeonName(ref.seed)}: Antechamber`, seed: ref.seed, back: { target: 'wilds', label: 'Back to the Wilds' }, gateLabel: 'Gate' });
  const height = map.height;
  for (const [asset, x, y] of [
    ['dungeon_banner_red', 520, 150],
    ['dungeon_banner_blue', 700, 150],
    ['dungeon_banner_red', 520, height - 150],
    ['dungeon_banner_blue', 700, height - 150],
    ['dungeon_table_long', 460, height / 2 - 150],
    ['dungeon_stool', 420, height / 2 - 110],
    ['dungeon_stool', 500, height / 2 - 110],
    ['dungeon_chest', 900, height / 2 + 170],
    ['dungeon_barrel_large', 300, 170],
    ['dungeon_crates_stacked', 300, height - 170],
  ] as const) {
    map.decor.push({ asset, x, y, angle: rng.range(-0.2, 0.2), scale: 1 });
  }
  return map;
}

/**
 * The Arena gate: the same hall, hung with red, a pile of the pit's dead by the gate, and the
 * champions' stone (the leaderboard) against the north wall.
 */
export function arenaGateMap(): WorldMap {
  const { map, rng } = antechamber({ name: 'Arena Gate', seed: 0xa7e7a, back: { target: 'town', label: 'Back to town' }, gateLabel: 'The Pit' });
  const height = map.height;
  const board = { x: 620, y: 190 };
  map.board = board;
  for (const [asset, x, y, scale] of [
    ['grave_gravestone', board.x, board.y, 2.4],
    ['dungeon_candle_lit', board.x - 50, board.y + 24, 1.2],
    ['dungeon_candle_lit', board.x + 50, board.y + 24, 1.2],
    ['dungeon_banner_red', 440, 150, 1],
    ['dungeon_banner_red', 800, 150, 1],
    ['dungeon_banner_red', 440, height - 150, 1],
    ['dungeon_banner_red', 800, height - 150, 1],
    ['grave_ribcage', 1010, height / 2 - 110, 1.2],
    ['grave_skull', 1040, height / 2 - 90, 1.4],
    ['grave_bone_A', 990, height / 2 + 100, 1.3],
    ['grave_skull', 1020, height / 2 + 120, 1.2],
    ['dungeon_rubble_half', 960, height / 2 + 150, 1],
    ['dungeon_barrel_large', 300, 170, 1],
    ['dungeon_crates_stacked', 300, height - 170, 1],
    ['dungeon_torch_lit', 1060, height / 2 - 150, 1],
    ['dungeon_torch_lit', 1060, height / 2 + 150, 1],
  ] as const) {
    map.decor.push({ asset, x, y, angle: rng.range(-0.2, 0.2), scale });
  }
  return map;
}

/**
 * The Arena pit: a round, torch-lit fighting floor carved out of rock like the dungeons, a small
 * underground colosseum. Pillars give some cover; there is no water and nothing to hide far behind.
 */
export function colosseumMap(): WorldMap {
  const rng = new Rng(0xc0105e);
  const cells = 44;
  const size = cells * CELL;
  const centreCell = cells / 2;
  const radiusCells = 17;
  const map = emptyMap({ name: 'The Pit', theme: 'arena', width: size, height: size, spawn: { x: size / 2, y: size / 2 }, waves: true, safe: false, groundTint: 0x2a2622 });
  const floor = new Uint8Array(cells * cells);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (Math.hypot(x + 0.5 - centreCell, y + 0.5 - centreCell) <= radiusCells) floor[y * cells + x] = 1;
    }
  }
  // Eight square pillars in a ring: cover to break line of sight, never a maze.
  const pillarRing = 9;
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8 + Math.PI / 8;
    const px = Math.round(centreCell + Math.cos(a) * pillarRing) - 1;
    const py = Math.round(centreCell + Math.sin(a) * pillarRing) - 1;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) floor[(py + dy) * cells + px + dx] = 0;
  }
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; ) {
      if (floor[y * cells + x] !== 1) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < cells && floor[y * cells + x] === 1) x++;
      map.ground.push({ kind: 'floor', shape: { type: 'box', x: ((x0 + x) * CELL) / 2, y: y * CELL + CELL / 2, hw: ((x - x0) * CELL) / 2, hh: CELL / 2, angle: 0 } });
    }
  }
  map.obstacles.push(...wallsFromGrid(floor, cells, cells));
  map.playArea = { x: size / 2, y: size / 2, r: (radiusCells - 1) * CELL };
  // Torches around the wall light the fight; between them it stays dark, and the hero's light matters.
  const torchRing = (radiusCells - 1.2) * CELL;
  map.lamps = Array.from({ length: 14 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 14;
    return { x: size / 2 + Math.cos(a) * torchRing, y: size / 2 + Math.sin(a) * torchRing };
  });
  const decor = ['grave_skull', 'grave_bone_A', 'grave_ribcage', 'dungeon_rubble_half', 'dungeon_banner_red'] as const;
  for (let i = 0; i < 18; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.55, 0.92) * (radiusCells - 1) * CELL;
    const asset = decor[i % decor.length] ?? 'grave_skull';
    map.decor.push({ asset, x: size / 2 + Math.cos(a) * d, y: size / 2 + Math.sin(a) * d, angle: rng.range(0, Math.PI * 2), scale: rng.range(0.9, 1.3) });
  }
  map.portals.push({ x: size / 2, y: size / 2 + (radiusCells - 2.5) * CELL, r: 40, target: 'town', label: 'Leave the pit' });
  return map;
}
