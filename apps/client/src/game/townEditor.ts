import { layoutToMap, PROP_DEFS, type Shape, type TownLayout, type TownProp, type TownPropKind, type Vec2 } from '@rune/shared';
import { BufferGeometry, Line, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, RingGeometry, Vector3, type Object3D } from 'three';
import type { WorldScene } from '../render/scene.js';
import { create } from 'zustand';

export type EditorTool = 'select' | 'place' | 'path' | 'plaza' | 'erase';

/** What the editor panel shows and controls. The editor itself lives outside React. */
interface EditorUiState {
  active: boolean;
  tool: EditorTool;
  placeKind: TownPropKind;
  brushWidth: number;
  snap: boolean;
  dirty: boolean;
  selection: string | null;
  canUndo: boolean;
}

let current: TownEditor | null = null;

/** The open editor, for the React panel's buttons. */
export function activeTownEditor(): TownEditor | null {
  return current;
}

export const useTownEditor = create<EditorUiState>(() => ({
  active: false,
  tool: 'select',
  placeKind: 'house',
  brushWidth: 110,
  snap: true,
  dirty: false,
  selection: null,
  canUndo: false,
}));

type Selection = { type: 'prop'; index: number } | { type: 'path'; index: number } | { type: 'plaza'; index: number } | { type: 'portal'; index: number } | { type: 'spawn' };

const SNAP = 20;
const ROTATE_STEP = Math.PI / 12;
const PAN_SPEED = 900;
const REBUILD_MS = 90;
const UNDO_LIMIT = 80;

function clone(layout: TownLayout): TownLayout {
  return structuredClone(layout);
}

function inside(s: Shape, x: number, y: number, pad: number): boolean {
  switch (s.type) {
    case 'circle':
      return Math.hypot(x - s.x, y - s.y) <= s.r + pad;
    case 'capsule': {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
      return Math.hypot(x - (s.ax + dx * t), y - (s.ay + dy * t)) <= s.r + pad;
    }
    case 'box': {
      const c = Math.cos(-s.angle);
      const sn = Math.sin(-s.angle);
      const lx = (x - s.x) * c - (y - s.y) * sn;
      const ly = (x - s.x) * sn + (y - s.y) * c;
      return Math.abs(lx) <= s.hw + pad && Math.abs(ly) <= s.hh + pad;
    }
  }
}

function outlinePoints(s: Shape): Vector3[] {
  const pts: Vector3[] = [];
  const h = 3;
  if (s.type === 'circle') {
    for (let i = 0; i < 32; i++) {
      const a = (Math.PI * 2 * i) / 32;
      pts.push(new Vector3(s.x + Math.cos(a) * s.r, h, s.y + Math.sin(a) * s.r));
    }
  } else if (s.type === 'box') {
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    for (const [lx, ly] of [
      [-s.hw, -s.hh],
      [s.hw, -s.hh],
      [s.hw, s.hh],
      [-s.hw, s.hh],
    ] as const) {
      pts.push(new Vector3(s.x + lx * c - ly * sn, h, s.y + lx * sn + ly * c));
    }
  } else {
    const ang = Math.atan2(s.by - s.ay, s.bx - s.ax);
    for (let i = 0; i <= 16; i++) {
      const a = ang + Math.PI / 2 + (Math.PI * i) / 16;
      pts.push(new Vector3(s.bx + Math.cos(a) * s.r, h, s.by + Math.sin(a) * s.r));
    }
    for (let i = 0; i <= 16; i++) {
      const a = ang - Math.PI / 2 + (Math.PI * i) / 16;
      pts.push(new Vector3(s.ax + Math.cos(a) * s.r, h, s.ay + Math.sin(a) * s.r));
    }
  }
  return pts;
}

/**
 * In-game town editor, in the spirit of Path of Exile's hideout editor. It edits a working copy of
 * the layout, previews it live by rebuilding the town geometry, and sends it to the server on save.
 */
export class TownEditor {
  layout: TownLayout;
  camera: Vec2;
  private original: TownLayout;
  private undo: string[] = [];
  private selection: Selection | null = null;
  private pendingAngle = 0;
  private drag: { offX: number; offY: number } | null = null;
  private brush: { kind: 'path'; points: Vec2[] } | { kind: 'plaza'; x: number; y: number; r: number } | null = null;
  private hover: Vec2 | null = null;
  private keys = new Set<string>();
  private zoom = 0.6;
  private rebuildAt = 0;
  private needsRebuild = false;
  private readonly abort = new AbortController();
  private readonly gizmos: Object3D[] = [];

  constructor(
    private readonly world: WorldScene,
    layout: TownLayout,
    start: Vec2,
    private readonly save: (layout: TownLayout) => void,
  ) {
    this.layout = clone(layout);
    this.original = clone(layout);
    this.camera = { ...start };
    world.setZoom(this.zoom);
    const canvas = world.canvas;
    const opts = { signal: this.abort.signal };
    canvas.addEventListener('mousedown', (e) => this.onDown(e), opts);
    window.addEventListener('mousemove', (e) => this.onMove(e), opts);
    window.addEventListener('mouseup', () => this.onUp(), opts);
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { ...opts, passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), opts);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), opts);
    useTownEditor.setState({ active: true, dirty: false, selection: null, canUndo: false });
    current = this;
  }

  dispose(): void {
    if (current === this) current = null;
    this.abort.abort();
    this.clearGizmos();
    this.world.setZoom(1);
    useTownEditor.setState({ active: false });
  }

  /** Called every frame by the game loop while editing. */
  update(dt: number): void {
    let px = 0;
    let py = 0;
    if (this.keys.has('KeyW')) py -= 1;
    if (this.keys.has('KeyS')) py += 1;
    if (this.keys.has('KeyA')) px -= 1;
    if (this.keys.has('KeyD')) px += 1;
    if (px !== 0 || py !== 0) {
      const b = this.world.basis;
      const len = Math.hypot(px, py);
      const speed = (PAN_SPEED / this.zoom) * dt;
      this.camera.x += ((b.right.x * px - b.up.x * py) / len) * speed;
      this.camera.y += ((b.right.y * px - b.up.y * py) / len) * speed;
      this.camera.x = Math.max(0, Math.min(this.layout.width, this.camera.x));
      this.camera.y = Math.max(0, Math.min(this.layout.height, this.camera.y));
    }
    const now = performance.now();
    if (this.needsRebuild && now >= this.rebuildAt) {
      this.needsRebuild = false;
      this.world.rebuildWorld(layoutToMap(this.layout));
    }
    this.drawGizmos();
  }

  // -------------------------------------------------------------------------------------------
  // Panel actions

  setTool(tool: EditorTool): void {
    this.brush = null;
    useTownEditor.setState({ tool });
  }

  setPlaceKind(kind: TownPropKind): void {
    useTownEditor.setState({ placeKind: kind, tool: 'place' });
  }

  undoLast(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.layout = JSON.parse(prev);
    this.selection = null;
    this.changed(false);
  }

  revert(): void {
    this.pushUndo();
    this.layout = clone(this.original);
    this.selection = null;
    this.changed(false);
  }

  saveLayout(): void {
    this.save(clone(this.layout));
    this.original = clone(this.layout);
    useTownEditor.setState({ dirty: false });
  }

  deleteSelected(): void {
    const sel = this.selection;
    if (!sel) return;
    this.pushUndo();
    if (sel.type === 'prop') this.layout.props.splice(sel.index, 1);
    else if (sel.type === 'path') this.layout.paths.splice(sel.index, 1);
    else if (sel.type === 'plaza') this.layout.plazas.splice(sel.index, 1);
    // Portals and the spawn point can be moved but never deleted: the town needs its exits.
    this.selection = null;
    this.changed();
  }

  // -------------------------------------------------------------------------------------------

  private snap(v: number): number {
    return useTownEditor.getState().snap ? Math.round(v / SNAP) * SNAP : v;
  }

  private ground(e: MouseEvent): Vec2 | null {
    const r = this.world.canvas.getBoundingClientRect();
    return this.world.screenToGround(e.clientX - r.left, e.clientY - r.top);
  }

  private pushUndo(): void {
    this.undo.push(JSON.stringify(this.layout));
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    useTownEditor.setState({ canUndo: true });
  }

  private changed(dirty = true): void {
    this.needsRebuild = true;
    this.rebuildAt = performance.now() + REBUILD_MS;
    useTownEditor.setState({ dirty: dirty || useTownEditor.getState().dirty, canUndo: this.undo.length > 0, selection: this.selectionLabel() });
  }

  private selectionLabel(): string | null {
    const sel = this.selection;
    if (!sel) return null;
    if (sel.type === 'prop') {
      const p = this.layout.props[sel.index];
      return p ? `${PROP_DEFS[p.kind].label}, scale ${p.scale.toFixed(2)}` : null;
    }
    if (sel.type === 'path') return 'Path';
    if (sel.type === 'plaza') return 'Plaza';
    if (sel.type === 'portal') return `Portal: ${this.layout.portals[sel.index]?.target ?? ''}`;
    return 'Spawn point';
  }

  private pick(x: number, y: number): Selection | null {
    const L = this.layout;
    const i = L.portals.findIndex((p) => Math.hypot(p.x - x, p.y - y) < 50);
    if (i >= 0) return { type: 'portal', index: i };
    if (Math.hypot(L.spawn.x - x, L.spawn.y - y) < 30) return { type: 'spawn' };
    for (let k = L.props.length - 1; k >= 0; k--) {
      const p = L.props[k];
      if (p && inside(PROP_DEFS[p.kind].shape(p), x, y, 6)) return { type: 'prop', index: k };
    }
    for (let k = L.paths.length - 1; k >= 0; k--) {
      const path = L.paths[k];
      if (!path) continue;
      for (let j = 0; j < path.points.length - 1; j++) {
        const a = path.points[j];
        const b = path.points[j + 1];
        if (a && b && inside({ type: 'capsule', ax: a.x, ay: a.y, bx: b.x, by: b.y, r: path.width / 2 }, x, y, 0)) return { type: 'path', index: k };
      }
    }
    for (let k = L.plazas.length - 1; k >= 0; k--) {
      const p = L.plazas[k];
      if (p && Math.hypot(p.x - x, p.y - y) <= p.r) return { type: 'plaza', index: k };
    }
    return null;
  }

  /** The anchor point of a selection, for dragging. */
  private anchor(sel: Selection): Vec2 | null {
    const L = this.layout;
    if (sel.type === 'prop') return L.props[sel.index] ?? null;
    if (sel.type === 'plaza') return L.plazas[sel.index] ?? null;
    if (sel.type === 'portal') return L.portals[sel.index] ?? null;
    if (sel.type === 'spawn') return L.spawn;
    return L.paths[sel.index]?.points[0] ?? null;
  }

  private moveSelection(sel: Selection, x: number, y: number): void {
    const L = this.layout;
    if (sel.type === 'path') {
      const path = L.paths[sel.index];
      const first = path?.points[0];
      if (!path || !first) return;
      const dx = x - first.x;
      const dy = y - first.y;
      for (const p of path.points) {
        p.x += dx;
        p.y += dy;
      }
      return;
    }
    const a = this.anchor(sel);
    if (!a) return;
    a.x = Math.max(0, Math.min(L.width, x));
    a.y = Math.max(0, Math.min(L.height, y));
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const g = this.ground(e);
    if (!g) return;
    const ui = useTownEditor.getState();
    const x = this.snap(g.x);
    const y = this.snap(g.y);
    switch (ui.tool) {
      case 'select': {
        this.selection = this.pick(g.x, g.y);
        const a = this.selection ? this.anchor(this.selection) : null;
        if (a) {
          this.pushUndo();
          this.drag = { offX: a.x - g.x, offY: a.y - g.y };
        }
        useTownEditor.setState({ selection: this.selectionLabel() });
        return;
      }
      case 'place': {
        this.pushUndo();
        const kind = ui.placeKind;
        const prop: TownProp = { kind, x, y, angle: this.pendingAngle, scale: 1, length: PROP_DEFS[kind].line ? 200 : 0 };
        this.layout.props.push(prop);
        this.selection = { type: 'prop', index: this.layout.props.length - 1 };
        this.changed();
        return;
      }
      case 'path':
        this.brush = { kind: 'path', points: [{ x, y }] };
        return;
      case 'plaza':
        this.brush = { kind: 'plaza', x, y, r: 40 };
        return;
      case 'erase': {
        const sel = this.pick(g.x, g.y);
        if (sel) {
          this.selection = sel;
          this.deleteSelected();
        }
        return;
      }
    }
  }

  private onMove(e: MouseEvent): void {
    const g = this.ground(e);
    this.hover = g;
    if (!g) return;
    if (this.drag && this.selection) {
      this.moveSelection(this.selection, this.snap(g.x + this.drag.offX), this.snap(g.y + this.drag.offY));
      this.changed();
    }
    const b = this.brush;
    if (b?.kind === 'path') {
      const last = b.points[b.points.length - 1];
      // Points every 50 units give smooth curves without bloating the saved layout.
      if (last && Math.hypot(g.x - last.x, g.y - last.y) > 50) b.points.push({ x: this.snap(g.x), y: this.snap(g.y) });
    } else if (b?.kind === 'plaza') {
      b.r = Math.max(30, Math.hypot(g.x - b.x, g.y - b.y));
    }
  }

  private onUp(): void {
    this.drag = null;
    const b = this.brush;
    this.brush = null;
    if (b?.kind === 'path' && b.points.length >= 2) {
      this.pushUndo();
      this.layout.paths.push({ points: b.points, width: useTownEditor.getState().brushWidth });
      this.changed();
    } else if (b?.kind === 'plaza') {
      this.pushUndo();
      this.layout.plazas.push({ x: b.x, y: b.y, r: Math.round(b.r) });
      this.changed();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoom = Math.max(0.2, Math.min(1.6, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    this.world.setZoom(this.zoom);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    const sel = this.selection;
    const p = sel?.type === 'prop' ? this.layout.props[sel.index] : undefined;
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault();
      this.undoLast();
      return;
    }
    switch (e.code) {
      case 'KeyQ':
      case 'KeyE': {
        const d = e.code === 'KeyQ' ? -ROTATE_STEP : ROTATE_STEP;
        if (p) {
          this.pushUndo();
          p.angle += d;
          this.changed();
        } else this.pendingAngle += d;
        return;
      }
      case 'BracketLeft':
      case 'BracketRight': {
        const up = e.code === 'BracketRight';
        if (p) {
          this.pushUndo();
          if (PROP_DEFS[p.kind].line) p.length = Math.max(40, p.length + (up ? 40 : -40));
          else p.scale = Math.max(0.4, Math.min(2.5, p.scale * (up ? 1.1 : 0.9)));
          this.changed();
        } else if (sel?.type === 'plaza') {
          const pl = this.layout.plazas[sel.index];
          if (pl) {
            this.pushUndo();
            pl.r = Math.max(30, pl.r * (up ? 1.1 : 0.9));
            this.changed();
          }
        } else useTownEditor.setState((s) => ({ brushWidth: Math.max(30, Math.min(300, s.brushWidth + (up ? 10 : -10))) }));
        return;
      }
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        return;
      case 'KeyG':
        useTownEditor.setState((s) => ({ snap: !s.snap }));
        return;
      case 'Digit1':
        this.setTool('select');
        return;
      case 'Digit2':
        this.setTool('place');
        return;
      case 'Digit3':
        this.setTool('path');
        return;
      case 'Digit4':
        this.setTool('plaza');
        return;
      case 'Digit5':
        this.setTool('erase');
        return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Gizmos

  private clearGizmos(): void {
    for (const g of this.gizmos) {
      this.world.overlay.remove(g);
      if (g instanceof Line || g instanceof Mesh) g.geometry.dispose();
    }
    this.gizmos.length = 0;
  }

  private addOutline(s: Shape, color: number): void {
    const loop = new LineLoop(new BufferGeometry().setFromPoints(outlinePoints(s)), new LineBasicMaterial({ color, depthTest: false }));
    loop.renderOrder = 20;
    this.world.overlay.add(loop);
    this.gizmos.push(loop);
  }

  private drawGizmos(): void {
    this.clearGizmos();
    const L = this.layout;
    const ui = useTownEditor.getState();
    for (const portal of L.portals) this.addOutline({ type: 'circle', x: portal.x, y: portal.y, r: 50 }, 0xb49cff);
    this.addOutline({ type: 'circle', x: L.spawn.x, y: L.spawn.y, r: 24 }, 0x7dff8a);

    const sel = this.selection;
    if (sel?.type === 'prop') {
      const p = L.props[sel.index];
      if (p) this.addOutline(PROP_DEFS[p.kind].shape(p), 0xffd36b);
    } else if (sel?.type === 'plaza') {
      const p = L.plazas[sel.index];
      if (p) this.addOutline({ type: 'circle', x: p.x, y: p.y, r: p.r }, 0xffd36b);
    } else if (sel?.type === 'path') {
      const path = L.paths[sel.index];
      if (path) this.addPathLine(path.points, 0xffd36b);
    } else if (sel) {
      const a = this.anchor(sel);
      if (a) this.addOutline({ type: 'circle', x: a.x, y: a.y, r: 56 }, 0xffd36b);
    }

    const h = this.hover;
    if (h && ui.tool === 'place') {
      const ghost: TownProp = { kind: ui.placeKind, x: this.snap(h.x), y: this.snap(h.y), angle: this.pendingAngle, scale: 1, length: 200 };
      this.addOutline(PROP_DEFS[ui.placeKind].shape(ghost), 0x9fd0ff);
    } else if (h && (ui.tool === 'path' || ui.tool === 'plaza')) {
      const ring = new Mesh(new RingGeometry(ui.tool === 'path' ? ui.brushWidth / 2 - 3 : 26, ui.tool === 'path' ? ui.brushWidth / 2 : 30, 32), new MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.8, depthTest: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(h.x, 3, h.y);
      ring.renderOrder = 20;
      this.world.overlay.add(ring);
      this.gizmos.push(ring);
    } else if (h && ui.tool === 'erase') {
      const target = this.pick(h.x, h.y);
      if (target?.type === 'prop') {
        const p = L.props[target.index];
        if (p) this.addOutline(PROP_DEFS[p.kind].shape(p), 0xff5a4a);
      }
    }
    const b = this.brush;
    if (b?.kind === 'path') this.addPathLine(b.points, 0x9fd0ff);
    if (b?.kind === 'plaza') this.addOutline({ type: 'circle', x: b.x, y: b.y, r: b.r }, 0x9fd0ff);
  }

  private addPathLine(points: Vec2[], color: number): void {
    if (points.length < 2) return;
    const line = new Line(
      new BufferGeometry().setFromPoints(points.map((p) => new Vector3(p.x, 4, p.y))),
      new LineBasicMaterial({ color, depthTest: false }),
    );
    line.renderOrder = 20;
    this.world.overlay.add(line);
    this.gizmos.push(line);
  }
}
