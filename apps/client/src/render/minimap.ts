import { ZONES, type EntitySnap, type Obstacle, type WorldMap, type ZoneId, type ZoneWorld } from '@rune/shared';
import { cssColor, TIER_COLORS, VIEW } from './config.js';
import { FogGrid, readFog, writeFog, type FogRecord, type FogStorage } from './fog.js';
import { fitLabels, regionLabels, type LabelBox, type RegionLabel } from './mapLabels.js';

/**
 * Longest side of the drawn minimap in pixels. The map is turned to match the camera, so a square
 * map becomes a diamond and needs a wider box than the old 200 north-up square to stay readable.
 */
const FRAME = 220;
/**
 * Longest side of the world map's canvas in pixels. CSS shrinks it to fit the screen; 880 keeps it
 * sharp at the 1600 by 900 the game is tuned for, and the whole 13000 unit world turned 45 degrees
 * still gets about 0.048 pixels per unit, twice the corner map's.
 */
export const LARGE_FRAME = 880;
/** Fog cell size in corner minimap pixels; the cell in world units follows from the corner map's scale. */
const CELL = 2;
/**
 * The fewest minimap pixels per world unit. Today's zones fit the frame whole above it (the home
 * zone is about 0.031); a zone too big for that shows a frame-sized window around the hero instead
 * of shrinking to a smudge.
 */
export const MIN_SCALE = 0.025;
/** Side of one tile of the drawn layout, in minimap pixels. */
export const TILE = 256;
/** How far around the hero the map uncovers, in world units: roughly what the camera shows. */
const REVEAL_RADIUS = 650;
/** Region colour cells, in world units: fine enough for the blended borders to read, coarse enough to look up once. */
const REGION_CELL = 250;
/** How long new exploration waits before it is written to storage; a crash loses at most this much walking. */
const SAVE_MS = 2000;
const FOG_COLOUR = { r: 11, g: 10, b: 9 } as const;
/**
 * Explored ground per map for maps not kept between sessions (dungeons, the Arena, a replay): walking
 * back into a room this session keeps what you found. Their maps are generated per run, so a new
 * run starts dark again, like D2.
 */
const explored = new Map<string, FogRecord>();

/** A gate's state for this character: sealed until its boss dies, then open. */
type GateState = 'sealed' | 'open';

export interface MinimapOptions {
  /** Camera yaw; the camera never turns during play, so this is fixed per minimap. */
  yawDegrees?: number;
  /** The world map's canvas, drawn while `setLargeOpen(true)`. */
  large?: HTMLCanvasElement | null;
  /** Where the explored map is remembered between sessions (the world, per character); session memory when absent. */
  persist?: { storage: FogStorage; key: string } | null;
}

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
  const fit = fitScale(width, height, angle, frame);
  return fit >= MIN_SCALE ? { scale: fit, windowed: false } : { scale: MIN_SCALE, windowed: true };
}

/** Pixels per world unit that fit the whole turned map in `frame`. */
export function fitScale(width: number, height: number, angle: number, frame: number): number {
  const turned = rotatedBounds(width, height, angle);
  return frame / Math.max(turned.w, turned.h);
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

/** One drawing of the map: the corner minimap, or the world map. Each has its own scale and layout tiles. */
class MapView {
  readonly scale: number;
  readonly windowed: boolean;
  /** The north-up map in pixels. */
  readonly w: number;
  readonly h: number;
  /** The turned canvas: the whole turned map, or the window. */
  readonly outW: number;
  readonly outH: number;
  readonly tileCols: number;
  readonly tileRows: number;
  /** Layout tiles, made when first drawn; row-major. */
  readonly tiles: (HTMLCanvasElement | null)[];
  /** The north-up map pixel at the canvas centre: the map's centre, or the hero in a window. */
  pivotX: number;
  pivotY: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    def: WorldMap,
    readonly angle: number,
    readonly large: boolean,
  ) {
    const fit = large ? { scale: fitScale(def.width, def.height, angle, LARGE_FRAME), windowed: false } : minimapScale(def.width, def.height, angle);
    this.scale = fit.scale;
    this.windowed = fit.windowed;
    this.w = Math.round(def.width * this.scale);
    this.h = Math.round(def.height * this.scale);
    const turned = rotatedBounds(def.width, def.height, angle);
    this.outW = this.windowed ? FRAME : Math.ceil(turned.w * this.scale);
    this.outH = this.windowed ? FRAME : Math.ceil(turned.h * this.scale);
    this.pivotX = this.w / 2;
    this.pivotY = this.h / 2;
    canvas.width = this.outW;
    canvas.height = this.outH;
    this.tileCols = Math.max(1, Math.ceil(this.w / TILE));
    this.tileRows = Math.max(1, Math.ceil(this.h / TILE));
    this.tiles = new Array<HTMLCanvasElement | null>(this.tileCols * this.tileRows).fill(null);
  }

  /** A world spot to the turned canvas. */
  toCanvas(x: number, y: number): { x: number; y: number } {
    return rotateAround(x * this.scale, y * this.scale, this.pivotX, this.pivotY, this.outW, this.outH, this.angle);
  }
}

/**
 * Corner map and world map. The static layout is drawn once per view, in tiles of offscreen
 * canvases, so a huge map never needs one giant texture; each update only blits the tiles in the
 * frame, the fog and the markers, so it costs almost nothing per frame.
 *
 * Fog is one bit per cell (`FogGrid`), shared by both views and drawn as a canvas of one pixel per
 * cell, scaled up with smoothing so the explored edge is soft. Uncovering a cell clears one pixel.
 * In the world the grid, the regions entered and the waypoints found are kept in localStorage per
 * character and world seed, so the map is still explored after a relog.
 *
 * Both views stay north-up offscreen and are turned by the camera's yaw with one transform when
 * blitted, so WASD up is up on the map. Markers and names are placed at their turned positions but
 * drawn upright. A map that fits the corner frame at MIN_SCALE or more is shown whole there (every
 * zone today); a bigger one (the world) shows a window around the hero. The world map always shows
 * the whole map.
 */
export class Minimap {
  private readonly corner: MapView;
  private readonly large: MapView | null;
  private largeOpen = false;
  /** What the world map last drew; it redraws only when this changes. */
  private largeDrawn = '';
  private readonly fog: FogGrid;
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly record: FogRecord;
  private readonly discovered: Set<string>;
  private readonly found: Set<string>;
  private readonly gates = new Map<string, GateState>();
  private gatesKey = '';
  private readonly labels: (RegionLabel<ZoneId | 'town'> & { name: string; town: boolean })[] = [];
  /** Region per REGION_CELL square, row-major, looked up once for every tile of both views. */
  private regionGrid: ZoneId[] | null = null;
  private here: string | null = null;
  private lastReveal = new Map<string, { x: number; y: number }>();
  private readonly persist: { storage: FogStorage; key: string } | null;
  private dirty = false;
  private lastSave = 0;
  /** Bumped whenever the fog, regions, waypoints or gates change, for the world map's redraw check. */
  private version = 0;
  private readonly textWidths = new Map<string, number>();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly def: WorldMap,
    /** Identifies this map across room changes, so its explored area is remembered this session. */
    memoryKey: string,
    /** A generated zone, whose chunks' trees and rocks a tile draws (generating them) when it is first drawn. */
    private readonly zone: ZoneWorld | null = null,
    options: MinimapOptions = {},
  ) {
    const angle = minimapRotation(options.yawDegrees ?? VIEW.yawDegrees);
    this.corner = new MapView(canvas, def, angle, false);
    this.large = options.large ? new MapView(options.large, def, angle, true) : null;
    this.persist = options.persist ?? null;

    const cell = CELL / this.corner.scale;
    const cols = Math.ceil(def.width / cell);
    const rows = Math.ceil(def.height / cell);
    const stored = this.persist ? readFog(this.persist.storage, this.persist.key, cols, rows, cell) : null;
    const session = explored.get(memoryKey);
    const known = stored ?? (session?.grid.cols === cols && session.grid.rows === rows ? session : null);
    this.record = known ?? { grid: new FogGrid(cols, rows, cell), regions: [], waypoints: [] };
    explored.set(memoryKey, this.record);
    this.fog = this.record.grid;
    this.discovered = new Set(this.record.regions);
    this.found = new Set(this.record.waypoints);

    // Small or safe maps have nothing to discover.
    if (def.theme === 'arena' || def.theme === 'flat' || def.theme === 'town') this.fog.fill();
    for (const z of def.safeZones ?? []) this.fog.markRect(z.x, z.y, z.w, z.h, []);
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = cols;
    this.fogCanvas.height = rows;
    this.paintFog();

    const plan = zone?.plan;
    if (plan) {
      for (const l of regionLabels(plan.edges, plan.town)) this.labels.push({ ...l, name: ZONES[l.region].name, town: false });
      const town = def.safeZones?.[0];
      const townName = def.waypoints?.find((w) => w.id === 'town')?.name;
      if (town && townName) this.labels.push({ region: 'town', x: town.x + town.w / 2, y: town.y + town.h / 2, name: townName, town: true });
    }
  }

  /** Waypoints this character has found, from the server's waypoint menu and activation events; the world map fills them in. */
  addFoundWaypoints(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.found.has(id)) continue;
      this.found.add(id);
      changed = true;
    }
    if (!changed) return;
    this.record.waypoints = [...this.found];
    this.changed();
  }

  /**
   * The gates this character has opened (the snapshot's `self.gates`, once gate bosses land); every
   * other gate is drawn sealed. Null until then: gates are drawn as plain passes. Cheap to call on
   * every snapshot, since only a change redraws the world map.
   */
  setOpenGates(open: readonly string[] | null): void {
    const key = open === null ? '' : `|${[...open].sort().join(',')}`;
    if (key === this.gatesKey) return;
    this.gatesKey = key;
    this.gates.clear();
    if (open !== null) for (const gate of this.def.gates ?? []) this.gates.set(gate.id, open.includes(gate.id) ? 'open' : 'sealed');
    this.version++;
  }

  /** Called every update with the world map's state; a fresh open draws at once. */
  setLargeOpen(open: boolean): void {
    if (open === this.largeOpen) return;
    this.largeOpen = open;
    this.largeDrawn = '';
  }

  /** Writes unsaved exploration now: on leaving the room. */
  flush(): void {
    if (!this.dirty || !this.persist) return;
    this.dirty = false;
    this.lastSave = Date.now();
    writeFog(this.persist.storage, this.persist.key, this.record, this.lastSave);
  }

  private changed(): void {
    this.version++;
    this.dirty = true;
  }

  /** The whole fog canvas from the grid: dark where unexplored, clear where seen. */
  private paintFog(): void {
    const g = this.fogCanvas.getContext('2d');
    if (!g) return;
    const img = g.createImageData(this.fog.cols, this.fog.rows);
    for (let i = 0; i < this.fog.size; i++) {
      if (this.fog.has(i)) continue;
      img.data[i * 4] = FOG_COLOUR.r;
      img.data[i * 4 + 1] = FOG_COLOUR.g;
      img.data[i * 4 + 2] = FOG_COLOUR.b;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  private clearFog(cells: readonly number[]): void {
    if (cells.length === 0) return;
    const g = this.fogCanvas.getContext('2d');
    for (const i of cells) g?.clearRect(i % this.fog.cols, Math.floor(i / this.fog.cols), 1, 1);
    this.changed();
  }

  /** `who` keys the last reveal per viewer, since party members uncover the map too. */
  private reveal(who: string, x: number, y: number): void {
    // Only after moving a little; the circle is the same otherwise.
    const last = this.lastReveal.get(who);
    if (last && Math.hypot(last.x - x, last.y - y) < 40) return;
    this.lastReveal.set(who, { x, y });
    const fresh: number[] = [];
    this.fog.markCircle(x, y, REVEAL_RADIUS, fresh);
    this.clearFog(fresh);
    const plan = this.zone?.plan;
    if (!plan) return;
    const region = plan.regionAt(x, y);
    if (who === 'self') this.here = region;
    if (!this.discovered.has(region)) {
      this.discovered.add(region);
      this.record.regions = [...this.discovered];
      this.changed();
    }
  }

  private regionAtCell(cx: number, cy: number): ZoneId | null {
    const plan = this.zone?.plan;
    if (!plan) return null;
    const cols = Math.ceil(this.def.width / REGION_CELL);
    if (!this.regionGrid) {
      const rows = Math.ceil(this.def.height / REGION_CELL);
      const grid: ZoneId[] = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid.push(plan.regionAt((x + 0.5) * REGION_CELL, (y + 0.5) * REGION_CELL));
      this.regionGrid = grid;
    }
    return this.regionGrid[cy * cols + cx] ?? null;
  }

  private tile(v: MapView, col: number, row: number): HTMLCanvasElement {
    const i = row * v.tileCols + col;
    const have = v.tiles[i];
    if (have) return have;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.min(TILE, v.w - col * TILE));
    c.height = Math.max(1, Math.min(TILE, v.h - row * TILE));
    const g = c.getContext('2d');
    if (g) {
      g.translate(-col * TILE, -row * TILE);
      this.drawBase(g, v, col, row);
    }
    v.tiles[i] = c;
    return c;
  }

  /** A zone's chunk obstacles that can show on a tile: those of every chunk whose square, grown by its spill, meets it. */
  private chunkObstacles(v: MapView, col: number, row: number): Obstacle[] {
    const zone = this.zone;
    if (!zone) return [];
    const x0 = (col * TILE) / v.scale - zone.spill;
    const x1 = ((col + 1) * TILE) / v.scale + zone.spill;
    const y0 = (row * TILE) / v.scale - zone.spill;
    const y1 = ((row + 1) * TILE) / v.scale + zone.spill;
    const out: Obstacle[] = [];
    for (let cy = Math.max(0, Math.floor(y0 / zone.size)); cy <= Math.min(zone.rows - 1, Math.floor(y1 / zone.size)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 / zone.size)); cx <= Math.min(zone.cols - 1, Math.floor(x1 / zone.size)); cx++) out.push(...zone.obstacles(cx, cy));
    }
    return out;
  }

  /** Draws the layout in map pixels; a tile translates `g` first and the canvas clips the rest. */
  private drawBase(g: CanvasRenderingContext2D, v: MapView, col: number, row: number): void {
    const s = v.scale;
    g.fillStyle = cssColor(this.def.groundTint);
    g.globalAlpha = 0.55;
    g.fillRect(0, 0, v.w, v.h);
    // The world colours each region as its ground is drawn; only the cells under this tile.
    if (this.zone?.plan) {
      const x0 = Math.max(0, Math.floor((col * TILE) / s / REGION_CELL));
      const x1 = Math.min(Math.ceil(this.def.width / REGION_CELL) - 1, Math.floor(((col + 1) * TILE) / s / REGION_CELL));
      const y0 = Math.max(0, Math.floor((row * TILE) / s / REGION_CELL));
      const y1 = Math.min(Math.ceil(this.def.height / REGION_CELL) - 1, Math.floor(((row + 1) * TILE) / s / REGION_CELL));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const region = this.regionAtCell(cx, cy);
          if (!region) continue;
          g.fillStyle = cssColor(ZONES[region].groundTint);
          g.fillRect(cx * REGION_CELL * s, cy * REGION_CELL * s, REGION_CELL * s + 1, REGION_CELL * s + 1);
        }
      }
    }
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
        // The world's roads are 40 to 52 wide, about a pixel on the corner map; kept at 1.5 so they read as the way out.
        g.lineWidth = Math.max(patch.kind === 'road' ? (v.large ? 2 : 1.5) : 0, patch.shape.r * 2 * s);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(patch.shape.ax * s, patch.shape.ay * s);
        g.lineTo(patch.shape.bx * s, patch.shape.by * s);
        g.stroke();
      }
    }
    for (const river of this.def.rivers) {
      g.strokeStyle = '#3a6a90';
      g.lineWidth = Math.max(2, river.width * s);
      g.beginPath();
      river.path.forEach((p, i) => (i === 0 ? g.moveTo(p.x * s, p.y * s) : g.lineTo(p.x * s, p.y * s)));
      g.stroke();
    }
    for (const b of this.def.bridges) {
      g.fillStyle = '#b08a5a';
      g.beginPath();
      g.arc(b.x * s, b.y * s, v.large ? 3.5 : 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const o of [...this.def.obstacles, ...this.chunkObstacles(v, col, row)]) {
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

  /**
   * A party member's marker: a ringed dot, or an arrow on the edge pointing at them when they stand
   * past the drawn map (spawn and arrival points can sit on or beyond its border).
   */
  private drawAlly(g: CanvasRenderingContext2D, v: MapView, wx: number, wy: number): void {
    const inset = 5;
    const mx = wx * v.scale;
    const my = wy * v.scale;
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    const { x, y } = v.toCanvas(wx, wy);
    let cx: number;
    let cy: number;
    if (v.windowed) {
      // In a window the edge is the frame's own.
      cx = Math.min(v.outW - inset, Math.max(inset, x));
      cy = Math.min(v.outH - inset, Math.max(inset, y));
    } else {
      // Clamped to the map's own edge before turning, so the arrow sits on the turned map's border.
      const clamped = v.toCanvas(Math.min(v.w - inset, Math.max(inset, mx)) / v.scale, Math.min(v.h - inset, Math.max(inset, my)) / v.scale);
      cx = clamped.x;
      cy = clamped.y;
    }
    const r = v.large ? 3.5 : 2.5;
    if (Math.abs(cx - x) < 1e-6 && Math.abs(cy - y) < 1e-6) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
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

  private textWidth(g: CanvasRenderingContext2D, font: string, text: string): number {
    const key = `${font}|${text}`;
    const have = this.textWidths.get(key);
    if (have !== undefined) return have;
    const w = g.measureText(text).width;
    this.textWidths.set(key, w);
    return w;
  }

  /** Region names, upright at their spots; dim until the region has been entered. */
  private drawLabels(g: CanvasRenderingContext2D, v: MapView): void {
    if (this.labels.length === 0) return;
    const size = v.large ? 15 : 10;
    const font = `700 ${size}px Cinzel, serif`;
    const townFont = `700 ${size + 2}px Cinzel, serif`;
    const boxes: LabelBox[] = [];
    const placed: { x: number; y: number; font: string; text: string; known: boolean }[] = [];
    for (const l of this.labels) {
      // The corner frame names the town under the map already, and in town the name would sit on the hero.
      if (l.town && !v.large) continue;
      const at = v.toCanvas(l.x, l.y);
      if (at.x < -200 || at.y < -40 || at.x > v.outW + 200 || at.y > v.outH + 40) continue;
      const f = l.town ? townFont : font;
      g.font = f;
      const known = l.town || this.discovered.has(l.region);
      const priority = l.town ? 4 : l.region === this.here ? 3 : known ? 2 : 1;
      boxes.push({ x: at.x, y: at.y, w: this.textWidth(g, f, l.name), h: size + 2, priority });
      placed.push({ x: at.x, y: at.y, font: f, text: l.name, known });
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const i of fitLabels(boxes, v.outW, v.outH)) {
      const p = placed[i];
      if (!p) continue;
      g.font = p.font;
      g.globalAlpha = p.known ? 0.95 : 0.4;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      g.strokeText(p.text, p.x, p.y);
      g.fillStyle = p.known ? '#d9c79a' : '#8c826e';
      g.fillText(p.text, p.x, p.y);
    }
    g.globalAlpha = 1;
  }

  /** Waypoints, dungeon entrances and other portals once explored, and the gates across the roads. */
  private drawPlaces(g: CanvasRenderingContext2D, v: MapView): void {
    const big = v.large;
    for (const p of this.def.portals) {
      if (!this.fog.seenAt(p.x, p.y)) continue;
      const at = v.toCanvas(p.x, p.y);
      g.lineWidth = 1.5;
      if (p.target === 'waypoint') {
        // Found ones filled, the rest a hollow ring until touched, as the waypoint menu lists them.
        const r = big ? 5 : 3.5;
        const found = p.waypoint !== undefined && (p.waypoint === 'town' || this.found.has(p.waypoint));
        g.beginPath();
        g.moveTo(at.x, at.y - r);
        g.lineTo(at.x + r, at.y);
        g.lineTo(at.x, at.y + r);
        g.lineTo(at.x - r, at.y);
        g.closePath();
        g.strokeStyle = found ? '#000' : '#8fb0d0';
        g.fillStyle = '#8fb0d0';
        if (found) g.fill();
        g.stroke();
      } else if (p.target === 'staging') {
        const r = big ? 4.5 : 3;
        g.fillStyle = '#7a2a22';
        g.strokeStyle = '#d08a5a';
        g.fillRect(at.x - r, at.y - r, r * 2, r * 2);
        g.strokeRect(at.x - r, at.y - r, r * 2, r * 2);
      } else {
        g.fillStyle = '#b49cff';
        g.beginPath();
        g.arc(at.x, at.y, big ? 5 : 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const gate of this.def.gates ?? []) {
      if (!this.fog.seenAt(gate.x, gate.y)) continue;
      const state = this.gates.get(gate.id);
      const half = (big ? 8 : 5) / v.scale;
      // Across the road: the gate's heading is along it.
      const nx = -Math.sin(gate.angle) * half;
      const ny = Math.cos(gate.angle) * half;
      const a = v.toCanvas(gate.x + nx, gate.y + ny);
      const b = v.toCanvas(gate.x - nx, gate.y - ny);
      g.lineCap = 'butt';
      g.strokeStyle = '#000';
      g.lineWidth = big ? 6 : 4.5;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.strokeStyle = state === 'sealed' ? '#b0402e' : state === 'open' ? '#7f9a5e' : '#a08a60';
      g.lineWidth = big ? 3.5 : 2.5;
      g.stroke();
    }
  }

  private drawSelf(g: CanvasRenderingContext2D, v: MapView, x: number, y: number): void {
    const at = v.toCanvas(x, y);
    g.fillStyle = '#ffd36b';
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(at.x, at.y, v.large ? 4.5 : 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  /** Layout tiles and fog under the view's turn. */
  private drawGround(g: CanvasRenderingContext2D, v: MapView): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, v.outW, v.outH);
    g.translate(v.outW / 2, v.outH / 2);
    g.rotate(v.angle);
    g.translate(-v.pivotX, -v.pivotY);
    const reach = Math.hypot(v.outW, v.outH) / 2;
    for (const { col, row } of tilesNear(v.pivotX, v.pivotY, reach, v.tileCols, v.tileRows)) g.drawImage(this.tile(v, col, row), col * TILE, row * TILE);
    // Only the fog cells round the window, so a windowed map does not scale the whole grid every draw.
    const cellPx = this.fog.cell * v.scale;
    const sx0 = Math.max(0, Math.floor((v.pivotX - reach) / cellPx) - 1);
    const sy0 = Math.max(0, Math.floor((v.pivotY - reach) / cellPx) - 1);
    const sx1 = Math.min(this.fog.cols, Math.ceil((v.pivotX + reach) / cellPx) + 1);
    const sy1 = Math.min(this.fog.rows, Math.ceil((v.pivotY + reach) / cellPx) + 1);
    if (sx1 > sx0 && sy1 > sy0) {
      g.imageSmoothingEnabled = true;
      g.drawImage(this.fogCanvas, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 * cellPx, sy0 * cellPx, (sx1 - sx0) * cellPx, (sy1 - sy0) * cellPx);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * `party` names the player's party members; in the same map they share their vision, D2 style.
   * `far` are same-room members from the party status, drawn when the snapshot does not carry them.
   */
  update(selfX: number, selfY: number, entities: Iterable<EntitySnap>, selfId: number, party: ReadonlySet<string> = new Set(), far: readonly { name: string; x: number; y: number }[] = []): void {
    this.reveal('self', selfX, selfY);
    const list = [...entities];
    for (const e of list) if (e.k === 'player' && e.id !== selfId && party.has(e.name)) this.reveal(`p${e.id}`, e.x, e.y);
    if (this.dirty && Date.now() - this.lastSave > SAVE_MS) this.flush();

    const allies: { name: string; x: number; y: number }[] = list.flatMap((e) => (e.k === 'player' && e.id !== selfId && party.has(e.name) ? [{ name: e.name, x: e.x, y: e.y }] : []));
    const near = new Set(list.flatMap((e) => (e.k === 'player' ? [e.name] : [])));
    for (const m of far) if (!near.has(m.name)) allies.push(m);

    this.drawCorner(selfX, selfY, list, selfId, party, allies);
    if (this.largeOpen && this.large) this.drawLarge(this.large, selfX, selfY, allies);
  }

  private drawCorner(selfX: number, selfY: number, list: readonly EntitySnap[], selfId: number, party: ReadonlySet<string>, allies: readonly { x: number; y: number }[]): void {
    const v = this.corner;
    const g = v.canvas.getContext('2d');
    if (!g) return;
    if (v.windowed) {
      v.pivotX = selfX * v.scale;
      v.pivotY = selfY * v.scale;
    }
    this.drawGround(g, v);
    this.drawLabels(g, v);
    this.drawPlaces(g, v);
    for (const e of list) {
      // Party members are drawn below with their arrows; everything else only once explored.
      if (e.id === selfId || (e.k === 'player' && party.has(e.name)) || !this.fog.seenAt(e.x, e.y)) continue;
      if (e.k === 'enemy') g.fillStyle = e.rare ? '#ffc640' : '#e04040';
      else if (e.k === 'player') g.fillStyle = '#6bb6ff';
      else if (e.k === 'minion') g.fillStyle = '#b49cff';
      else if (e.k === 'loot') g.fillStyle = cssColor(TIER_COLORS[e.tier]);
      else continue;
      const at = v.toCanvas(e.x, e.y);
      const size = e.k === 'enemy' && e.rare ? 4 : 3;
      g.fillRect(at.x - 1.5, at.y - 1.5, size, size);
    }
    g.fillStyle = '#7ad69a';
    for (const m of allies) this.drawAlly(g, v, m.x, m.y);
    this.drawSelf(g, v, selfX, selfY);
  }

  /** The world map: the explored world, places and the party, without monsters or loot. Redrawn only when something on it moved or changed. */
  private drawLarge(v: MapView, selfX: number, selfY: number, allies: readonly { x: number; y: number }[]): void {
    // A pixel of movement on the world map is about 20 units; anything less draws the same picture.
    const px = (n: number) => Math.round(n * v.scale);
    const key = `${this.version}|${px(selfX)},${px(selfY)}|${allies.map((a) => `${px(a.x)},${px(a.y)}`).join(';')}`;
    if (key === this.largeDrawn) return;
    this.largeDrawn = key;
    const g = v.canvas.getContext('2d');
    if (!g) return;
    this.drawGround(g, v);
    this.drawLabels(g, v);
    this.drawPlaces(g, v);
    g.fillStyle = '#7ad69a';
    for (const m of allies) this.drawAlly(g, v, m.x, m.y);
    this.drawSelf(g, v, selfX, selfY);
  }
}
