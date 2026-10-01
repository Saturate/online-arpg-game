import type { EntitySnap, Obstacle, WorldMap, ZoneWorld } from '@rune/shared';
import { cssColor, TIER_COLORS, VIEW } from './config.js';

/**
 * Longest side of the drawn minimap in pixels. The map is turned to match the camera, so a square
 * map becomes a diamond and needs a wider box than the old 200 north-up square to stay readable.
 */
const FRAME = 220;
/** Fog cell size in minimap pixels. */
const CELL = 2;
/**
 * The fewest minimap pixels per world unit. Today's zones fit the frame whole above it (the home
 * zone is about 0.031); a zone too big for that shows a frame-sized window around the hero instead
 * of shrinking to a smudge.
 */
export const MIN_SCALE = 0.025;
/** Side of one tile of the drawn layout and fog, in minimap pixels. */
export const TILE = 256;
/** How far around the hero the map uncovers, in world units: roughly what the camera shows. */
const REVEAL_RADIUS = 650;
/**
 * Explored cells per map, kept for the session so walking back into a room keeps what you found.
 * Maps are generated per game, so a new game starts dark again, like D2.
 */
const explored = new Map<string, Uint8Array>();

/**
 * How far to turn the north-up map so up on the minimap is up on screen. The camera looks along
 * (-sin yaw, -cos yaw) on the ground (see GameScene's basis); turning the canvas by +yaw (clockwise,
 * since canvas y points down) maps that direction onto (0, -1).
 */
export function minimapRotation(yawDegrees: number): number {
  return (yawDegrees * Math.PI) / 180;
}

/**
 * Minimap pixels per world unit for a map, and whether it shows the whole map or a window around
 * the hero (when the whole map would need fewer than MIN_SCALE pixels per unit).
 */
export function minimapScale(width: number, height: number, angle: number, frame = FRAME): { scale: number; windowed: boolean } {
  const turned = rotatedBounds(width, height, angle);
  const fit = frame / Math.max(turned.w, turned.h);
  return fit >= MIN_SCALE ? { scale: fit, windowed: false } : { scale: MIN_SCALE, windowed: true };
}

/**
 * The tiles (column, row) of a `cols` by `rows` grid of `tile`-pixel tiles that a circle of `radius`
 * pixels around (px, py) touches. The window is square once turned, so its circumcircle covers it
 * at any angle.
 */
export function tilesNear(px: number, py: number, radius: number, cols: number, rows: number, tile = TILE): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  const c0 = Math.max(0, Math.floor((px - radius) / tile));
  const c1 = Math.min(cols - 1, Math.floor((px + radius) / tile));
  const r0 = Math.max(0, Math.floor((py - radius) / tile));
  const r1 = Math.min(rows - 1, Math.floor((py + radius) / tile));
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) out.push({ col, row });
  return out;
}

/** The box a w by h rectangle fills once turned by `angle`. */
export function rotatedBounds(w: number, h: number, angle: number): { w: number; h: number } {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  return { w: w * c + h * s, h: w * s + h * c };
}

/**
 * Where a point of the north-up map (in its pixels, `mapW` by `mapH`) lands on the turned canvas
 * (`outW` by `outH`): turned by `angle` around the map's centre, which sits at the canvas centre.
 */
export function rotatePoint(x: number, y: number, mapW: number, mapH: number, outW: number, outH: number, angle: number): { x: number; y: number } {
  return rotateAround(x, y, mapW / 2, mapH / 2, outW, outH, angle);
}

/** Where a point of the north-up map lands on the turned canvas when (px, py) sits at the canvas centre. */
export function rotateAround(x: number, y: number, px: number, py: number, outW: number, outH: number, angle: number): { x: number; y: number } {
  const dx = x - px;
  const dy = y - py;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: dx * c - dy * s + outW / 2, y: dx * s + dy * c + outH / 2 };
}

/**
 * Corner map. The static layout is drawn once per room, in tiles of offscreen canvases, so a huge
 * map never needs one giant texture; each update only blits the tiles in the frame and draws dots,
 * so it costs almost nothing per frame. Unexplored ground is covered by fog, tiled the same way,
 * that lifts as the hero walks, and nothing under the fog is shown.
 *
 * The layout and fog stay north-up offscreen and are turned by the camera's yaw with one transform
 * when blitted, so WASD up is up on the map. Markers are placed at their turned positions but drawn
 * upright, so a monster square does not become a diamond. A map that fits the frame at MIN_SCALE or
 * more is shown whole (every zone today, as one tile); a bigger one shows a window around the hero.
 */
export class Minimap {
  private readonly scale: number;
  private readonly windowed: boolean;
  private readonly w: number;
  private readonly h: number;
  private readonly tileCols: number;
  private readonly tileRows: number;
  /** Layout and fog tiles, made when first drawn; row-major. */
  private readonly baseTiles: (HTMLCanvasElement | null)[];
  private readonly fogTiles: (HTMLCanvasElement | null)[];
  private readonly cols: number;
  private readonly seen: Uint8Array;
  private lastReveal = new Map<string, { x: number; y: number }>();
  private readonly angle: number;
  /** The turned canvas: the whole turned map, or the window. */
  private readonly outW: number;
  private readonly outH: number;
  /** The north-up map pixel at the canvas centre: the map's centre, or the hero in a window. */
  private pivotX: number;
  private pivotY: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly def: WorldMap,
    /** Identifies this map across room changes, so its explored area is remembered. */
    memoryKey: string,
    /** A generated zone, whose chunks' trees and rocks a tile draws (generating them) when it is first drawn. */
    private readonly zone: ZoneWorld | null = null,
    /** Camera yaw; the camera never turns during play, so this is fixed per minimap. */
    yawDegrees: number = VIEW.yawDegrees,
  ) {
    this.angle = minimapRotation(yawDegrees);
    const { scale, windowed } = minimapScale(def.width, def.height, this.angle);
    this.scale = scale;
    this.windowed = windowed;
    this.w = Math.round(def.width * this.scale);
    this.h = Math.round(def.height * this.scale);
    const turned = rotatedBounds(def.width, def.height, this.angle);
    this.outW = windowed ? FRAME : Math.ceil(turned.w * this.scale);
    this.outH = windowed ? FRAME : Math.ceil(turned.h * this.scale);
    this.pivotX = this.w / 2;
    this.pivotY = this.h / 2;
    canvas.width = this.outW;
    canvas.height = this.outH;
    this.tileCols = Math.max(1, Math.ceil(this.w / TILE));
    this.tileRows = Math.max(1, Math.ceil(this.h / TILE));
    this.baseTiles = new Array<HTMLCanvasElement | null>(this.tileCols * this.tileRows).fill(null);
    this.fogTiles = new Array<HTMLCanvasElement | null>(this.tileCols * this.tileRows).fill(null);

    this.cols = Math.ceil(this.w / CELL);
    const rows = Math.ceil(this.h / CELL);
    const known = explored.get(memoryKey);
    this.seen = known?.length === this.cols * rows ? known : new Uint8Array(this.cols * rows);
    explored.set(memoryKey, this.seen);
    // Small or safe maps have nothing to discover.
    if (def.theme === 'arena' || def.theme === 'flat' || def.theme === 'town') this.seen.fill(1);
    for (const z of def.safeZones ?? []) this.revealRect(z.x, z.y, z.w, z.h);
  }

  private tileSize(col: number, row: number): { w: number; h: number } {
    return { w: Math.min(TILE, this.w - col * TILE), h: Math.min(TILE, this.h - row * TILE) };
  }

  private baseTile(col: number, row: number): HTMLCanvasElement {
    const i = row * this.tileCols + col;
    const have = this.baseTiles[i];
    if (have) return have;
    const c = document.createElement('canvas');
    const size = this.tileSize(col, row);
    c.width = Math.max(1, size.w);
    c.height = Math.max(1, size.h);
    const g = c.getContext('2d');
    if (g) {
      g.translate(-col * TILE, -row * TILE);
      this.drawBase(g, col, row);
    }
    this.baseTiles[i] = c;
    return c;
  }

  /** A fog tile, dark with every cell already seen cleared. */
  private fogTile(col: number, row: number): HTMLCanvasElement {
    const i = row * this.tileCols + col;
    const have = this.fogTiles[i];
    if (have) return have;
    const c = document.createElement('canvas');
    const size = this.tileSize(col, row);
    c.width = Math.max(1, size.w);
    c.height = Math.max(1, size.h);
    this.fogTiles[i] = c;
    const g = c.getContext('2d');
    if (!g) return c;
    g.fillStyle = '#0b0a09';
    g.fillRect(0, 0, c.width, c.height);
    // Cells are CELL pixels and TILE is a multiple of CELL, so each cell belongs to one tile.
    const perTile = TILE / CELL;
    const rows = this.seen.length / this.cols;
    for (let cy = row * perTile; cy < Math.min(rows, (row + 1) * perTile); cy++) {
      for (let cx = col * perTile; cx < Math.min(this.cols, (col + 1) * perTile); cx++) {
        if (this.seen[cy * this.cols + cx]) g.clearRect(cx * CELL - col * TILE, cy * CELL - row * TILE, CELL, CELL);
      }
    }
    return c;
  }

  private clearCell(i: number): void {
    const cx = (i % this.cols) * CELL;
    const cy = Math.floor(i / this.cols) * CELL;
    const col = Math.floor(cx / TILE);
    const row = Math.floor(cy / TILE);
    // A tile not made yet clears its seen cells when it is.
    const tile = this.fogTiles[row * this.tileCols + col];
    tile?.getContext('2d')?.clearRect(cx - col * TILE, cy - row * TILE, CELL, CELL);
  }

  private cellAt(x: number, y: number): number {
    const cx = Math.floor((x * this.scale) / CELL);
    const cy = Math.floor((y * this.scale) / CELL);
    return cx < 0 || cy < 0 || cx >= this.cols ? -1 : cy * this.cols + cx;
  }

  private isSeen(x: number, y: number): boolean {
    const i = this.cellAt(x, y);
    return i >= 0 && this.seen[i] === 1;
  }

  private revealRect(x: number, y: number, w: number, h: number): void {
    const step = CELL / this.scale;
    for (let yy = y; yy <= y + h; yy += step) for (let xx = x; xx <= x + w; xx += step) this.mark(this.cellAt(xx, yy));
  }

  private mark(i: number): void {
    if (i < 0 || i >= this.seen.length || this.seen[i]) return;
    this.seen[i] = 1;
    this.clearCell(i);
  }

  /** `who` keys the last reveal per viewer, since party members uncover the map too. */
  private reveal(who: string, x: number, y: number): void {
    // Only after moving a little; the circle is the same otherwise.
    const last = this.lastReveal.get(who);
    if (last && Math.hypot(last.x - x, last.y - y) < 40) return;
    this.lastReveal.set(who, { x, y });
    const step = CELL / this.scale;
    for (let dy = -REVEAL_RADIUS; dy <= REVEAL_RADIUS; dy += step) {
      for (let dx = -REVEAL_RADIUS; dx <= REVEAL_RADIUS; dx += step) {
        if (dx * dx + dy * dy <= REVEAL_RADIUS * REVEAL_RADIUS) this.mark(this.cellAt(x + dx, y + dy));
      }
    }
  }

  /** A zone's chunk obstacles that can show on a tile: those of every chunk whose square, grown by its spill, meets it. */
  private chunkObstacles(col: number, row: number): Obstacle[] {
    const zone = this.zone;
    if (!zone) return [];
    const x0 = (col * TILE) / this.scale - zone.spill;
    const x1 = ((col + 1) * TILE) / this.scale + zone.spill;
    const y0 = (row * TILE) / this.scale - zone.spill;
    const y1 = ((row + 1) * TILE) / this.scale + zone.spill;
    const out: Obstacle[] = [];
    for (let cy = Math.max(0, Math.floor(y0 / zone.size)); cy <= Math.min(zone.rows - 1, Math.floor(y1 / zone.size)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 / zone.size)); cx <= Math.min(zone.cols - 1, Math.floor(x1 / zone.size)); cx++) out.push(...zone.obstacles(cx, cy));
    }
    return out;
  }

  /** Draws the layout in map pixels; a tile translates `g` first and the canvas clips the rest. */
  private drawBase(g: CanvasRenderingContext2D, col: number, row: number): void {
    const s = this.scale;
    g.fillStyle = cssColor(this.def.groundTint);
    g.globalAlpha = 0.55;
    g.fillRect(0, 0, this.w, this.h);
    g.globalAlpha = 1;
    for (const patch of this.def.ground) {
      g.fillStyle = patch.kind === 'plaza' ? '#9a9080' : patch.kind === 'floor' ? '#6e655a' : '#8a7050';
      if (patch.shape.type === 'box') {
        const b = patch.shape;
        // Floor runs are one cell tall; overlap by a pixel so rows do not leave hairline gaps.
        g.fillRect((b.x - b.hw) * s, (b.y - b.hh) * s, b.hw * 2 * s, b.hh * 2 * s + 1);
      } else if (patch.shape.type === 'circle') {
        g.beginPath();
        g.arc(patch.shape.x * s, patch.shape.y * s, patch.shape.r * s, 0, Math.PI * 2);
        g.fill();
      } else if (patch.shape.type === 'capsule') {
        g.strokeStyle = '#8a7050';
        g.lineWidth = patch.shape.r * 2 * s;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(patch.shape.ax * s, patch.shape.ay * s);
        g.lineTo(patch.shape.bx * s, patch.shape.by * s);
        g.stroke();
      }
    }
    for (const river of this.def.rivers) {
      g.strokeStyle = '#3a7ab0';
      g.lineWidth = Math.max(2, river.width * s);
      g.beginPath();
      river.path.forEach((p, i) => (i === 0 ? g.moveTo(p.x * s, p.y * s) : g.lineTo(p.x * s, p.y * s)));
      g.stroke();
    }
    for (const b of this.def.bridges) {
      g.fillStyle = '#b08a5a';
      g.beginPath();
      g.arc(b.x * s, b.y * s, 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const o of [...this.def.obstacles, ...this.chunkObstacles(col, row)]) {
      // Rock is the background underground; the carved floor already shows the layout.
      if (o.kind === 'water' || o.kind === 'cavewall') continue;
      g.fillStyle = o.kind === 'tree' ? '#2a4a22' : o.kind === 'house' || o.kind === 'stall' ? '#8a4a3a' : '#5a5650';
      const sh = o.shape;
      if (sh.type === 'circle') {
        g.beginPath();
        g.arc(sh.x * s, sh.y * s, Math.max(1, sh.r * s * (o.kind === 'tree' ? 2.4 : 1)), 0, Math.PI * 2);
        g.fill();
      } else if (sh.type === 'box') {
        g.save();
        g.translate(sh.x * s, sh.y * s);
        g.rotate(sh.angle);
        g.fillRect(-sh.hw * s, -sh.hh * s, sh.hw * 2 * s, sh.hh * 2 * s);
        g.restore();
      } else {
        g.strokeStyle = g.fillStyle;
        g.lineWidth = Math.max(1, sh.r * 2 * s);
        g.beginPath();
        g.moveTo(sh.ax * s, sh.ay * s);
        g.lineTo(sh.bx * s, sh.by * s);
        g.stroke();
      }
    }
  }

  /** A point in north-up map pixels to the turned canvas. */
  private toCanvas(mx: number, my: number): { x: number; y: number } {
    return rotateAround(mx, my, this.pivotX, this.pivotY, this.outW, this.outH, this.angle);
  }

  /**
   * A party member's marker: a ringed dot, or an arrow on the edge pointing at them when they stand
   * past the drawn map (spawn and arrival points can sit on or beyond its border).
   */
  private drawAlly(g: CanvasRenderingContext2D, mx: number, my: number): void {
    const inset = 5;
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    const { x, y } = this.toCanvas(mx, my);
    let cx: number;
    let cy: number;
    if (this.windowed) {
      // In a window the edge is the frame's own.
      cx = Math.min(this.outW - inset, Math.max(inset, x));
      cy = Math.min(this.outH - inset, Math.max(inset, y));
    } else {
      // Clamped to the map's own edge before turning, so the arrow sits on the turned map's border.
      const clamped = this.toCanvas(Math.min(this.w - inset, Math.max(inset, mx)), Math.min(this.h - inset, Math.max(inset, my)));
      cx = clamped.x;
      cy = clamped.y;
    }
    if (Math.abs(cx - x) < 1e-6 && Math.abs(cy - y) < 1e-6) {
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      return;
    }
    const a = Math.atan2(y - cy, x - cx);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
    g.lineTo(cx + Math.cos(a + 2.5) * 4, cy + Math.sin(a + 2.5) * 4);
    g.lineTo(cx + Math.cos(a - 2.5) * 4, cy + Math.sin(a - 2.5) * 4);
    g.closePath();
    g.fill();
    g.stroke();
  }

  /**
   * `party` names the player's party members; in the same map they share their vision, D2 style.
   * `far` are same-room members from the party status, drawn when the snapshot does not carry them.
   */
  update(selfX: number, selfY: number, entities: Iterable<EntitySnap>, selfId: number, party: ReadonlySet<string> = new Set(), far: readonly { name: string; x: number; y: number }[] = []): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const s = this.scale;
    this.reveal('self', selfX, selfY);
    const list = [...entities];
    for (const e of list) if (e.k === 'player' && e.id !== selfId && party.has(e.name)) this.reveal(`p${e.id}`, e.x, e.y);
    if (this.windowed) {
      this.pivotX = selfX * s;
      this.pivotY = selfY * s;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.outW, this.outH);
    g.translate(this.outW / 2, this.outH / 2);
    g.rotate(this.angle);
    g.translate(-this.pivotX, -this.pivotY);
    const reach = Math.hypot(this.outW, this.outH) / 2;
    for (const { col, row } of tilesNear(this.pivotX, this.pivotY, reach, this.tileCols, this.tileRows)) {
      g.drawImage(this.baseTile(col, row), col * TILE, row * TILE);
      g.drawImage(this.fogTile(col, row), col * TILE, row * TILE);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const p of this.def.portals) {
      if (!this.isSeen(p.x, p.y)) continue;
      const at = this.toCanvas(p.x * s, p.y * s);
      g.fillStyle = '#b49cff';
      g.beginPath();
      g.arc(at.x, at.y, 4, 0, Math.PI * 2);
      g.fill();
    }
    for (const e of list) {
      const ally = e.k === 'player' && party.has(e.name);
      // Party members always show, even under fog; everything else only once explored.
      if (e.id === selfId || (!ally && !this.isSeen(e.x, e.y))) continue;
      if (e.k === 'enemy') g.fillStyle = e.rare ? '#ffc640' : '#e04040';
      else if (e.k === 'player') g.fillStyle = ally ? '#7ad69a' : '#6bb6ff';
      else if (e.k === 'minion') g.fillStyle = '#b49cff';
      else if (e.k === 'loot') g.fillStyle = cssColor(TIER_COLORS[e.tier]);
      else continue;
      if (ally) {
        this.drawAlly(g, e.x * s, e.y * s);
        continue;
      }
      const at = this.toCanvas(e.x * s, e.y * s);
      g.fillRect(at.x - 1.5, at.y - 1.5, e.k === 'enemy' && e.rare ? 4 : 3, e.k === 'enemy' && e.rare ? 4 : 3);
    }
    const near = new Set(list.flatMap((e) => (e.k === 'player' ? [e.name] : [])));
    for (const m of far) {
      if (near.has(m.name)) continue;
      g.fillStyle = '#7ad69a';
      this.drawAlly(g, m.x * s, m.y * s);
    }
    const self = this.toCanvas(selfX * s, selfY * s);
    g.fillStyle = '#ffd36b';
    g.strokeStyle = '#000';
    g.beginPath();
    g.arc(self.x, self.y, 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
