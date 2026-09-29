import type { EntitySnap, WorldMap } from '@rune/shared';
import { cssColor, TIER_COLORS } from './config.js';

const SIZE = 200;
/** Fog cell size in minimap pixels. */
const CELL = 2;
/** How far around the hero the map uncovers, in world units: roughly what the camera shows. */
const REVEAL_RADIUS = 650;
/**
 * Explored cells per map, kept for the session so walking back into a room keeps what you found.
 * Maps are generated per game, so a new game starts dark again, like D2.
 */
const explored = new Map<string, Uint8Array>();

/**
 * Corner map. The static layout is drawn once per room into an offscreen canvas; each update only
 * blits it and draws dots, so it costs almost nothing per frame. Unexplored ground is covered by
 * fog that lifts as the hero walks, and nothing under the fog is shown.
 */
export class Minimap {
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly w: number;
  private readonly h: number;
  private readonly fog: HTMLCanvasElement;
  private readonly cols: number;
  private readonly seen: Uint8Array;
  private lastReveal = new Map<string, { x: number; y: number }>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly def: WorldMap,
    /** Identifies this map across room changes, so its explored area is remembered. */
    memoryKey: string,
  ) {
    this.scale = SIZE / Math.max(def.width, def.height);
    this.w = Math.round(def.width * this.scale);
    this.h = Math.round(def.height * this.scale);
    canvas.width = this.w;
    canvas.height = this.h;
    this.base = document.createElement('canvas');
    this.base.width = this.w;
    this.base.height = this.h;
    this.drawBase();

    this.cols = Math.ceil(this.w / CELL);
    const rows = Math.ceil(this.h / CELL);
    const known = explored.get(memoryKey);
    this.seen = known?.length === this.cols * rows ? known : new Uint8Array(this.cols * rows);
    explored.set(memoryKey, this.seen);
    this.fog = document.createElement('canvas');
    this.fog.width = this.w;
    this.fog.height = this.h;
    const g = this.fog.getContext('2d');
    if (g) {
      g.fillStyle = '#0b0a09';
      g.fillRect(0, 0, this.w, this.h);
    }
    // Small or safe maps have nothing to discover.
    if (def.theme === 'arena' || def.theme === 'flat' || def.theme === 'town') this.seen.fill(1);
    for (const z of def.safeZones ?? []) this.revealRect(z.x, z.y, z.w, z.h);
    for (let i = 0; i < this.seen.length; i++) if (this.seen[i]) this.clearCell(i);
  }

  private clearCell(i: number): void {
    const g = this.fog.getContext('2d');
    g?.clearRect((i % this.cols) * CELL, Math.floor(i / this.cols) * CELL, CELL, CELL);
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

  private drawBase(): void {
    const g = this.base.getContext('2d');
    if (!g) return;
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
    for (const o of this.def.obstacles) {
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

  /** `party` names the player's party members; in the same map they share their vision, D2 style. */
  update(selfX: number, selfY: number, entities: Iterable<EntitySnap>, selfId: number, party: ReadonlySet<string> = new Set()): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const s = this.scale;
    this.reveal('self', selfX, selfY);
    const list = [...entities];
    for (const e of list) if (e.k === 'player' && e.id !== selfId && party.has(e.name)) this.reveal(`p${e.id}`, e.x, e.y);
    g.clearRect(0, 0, this.w, this.h);
    g.drawImage(this.base, 0, 0);
    g.drawImage(this.fog, 0, 0);
    for (const p of this.def.portals) {
      if (!this.isSeen(p.x, p.y)) continue;
      g.fillStyle = '#b49cff';
      g.beginPath();
      g.arc(p.x * s, p.y * s, 4, 0, Math.PI * 2);
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
      g.fillRect(e.x * s - 1.5, e.y * s - 1.5, e.k === 'enemy' && e.rare ? 4 : 3, e.k === 'enemy' && e.rare ? 4 : 3);
    }
    g.fillStyle = '#ffd36b';
    g.strokeStyle = '#000';
    g.beginPath();
    g.arc(selfX * s, selfY * s, 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
