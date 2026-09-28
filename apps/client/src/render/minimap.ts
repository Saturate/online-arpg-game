import type { EntitySnap, WorldMap } from '@rune/shared';
import { cssColor, TIER_COLORS } from './config.js';

const SIZE = 200;

/**
 * Corner map. The static layout is drawn once per room into an offscreen canvas; each update only
 * blits it and draws dots, so it costs almost nothing per frame.
 */
export class Minimap {
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly def: WorldMap,
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

  update(selfX: number, selfY: number, entities: Iterable<EntitySnap>, selfId: number): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const s = this.scale;
    g.clearRect(0, 0, this.w, this.h);
    g.drawImage(this.base, 0, 0);
    for (const p of this.def.portals) {
      g.fillStyle = '#b49cff';
      g.beginPath();
      g.arc(p.x * s, p.y * s, 4, 0, Math.PI * 2);
      g.fill();
    }
    for (const e of entities) {
      if (e.id === selfId) continue;
      if (e.k === 'enemy') g.fillStyle = e.rare ? '#ffc640' : '#e04040';
      else if (e.k === 'player') g.fillStyle = '#6bb6ff';
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
