import { decorFootprint, layoutHash, layoutToMap, PROP_DEFS, TOWN_DECOR_ASSETS, type Shape, type TownDecor, type TownLayout, type TownProp, type Vec2 } from '@rune/shared';
import { BufferGeometry, Line, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, RingGeometry, Vector3, type Object3D } from 'three';
import { isLitDecor } from '../render/props.js';
import type { WorldScene } from '../render/scene.js';
import { create } from 'zustand';
import {
  cycleClick,
  cycleKey,
  hideInMap,
  keyExists,
  layerRows,
  parseKey,
  pickAll,
  pickShapes,
  refKey,
  shiftKeys,
  stationsOf,
  type CycleState,
  type DecorLook,
  type LayerRow,
  type ObjectRef,
  type Station,
} from './townEditorPick.js';
import { decorInfo, type PlaceItem } from './townPalette.js';

export type EditorTool = 'select' | 'place' | 'path' | 'plaza' | 'erase';

/** What the editor panel shows and controls. The editor itself lives outside React. */
interface EditorUiState {
  active: boolean;
  tool: EditorTool;
  /** What the place tool puts down: a layout prop kind or a decor asset from the palette. */
  place: PlaceItem;
  brushWidth: number;
  snap: boolean;
  dirty: boolean;
  selection: string | null;
  /** Whether the selected decor piece blocks walking; null when the selection is not decor. */
  selectionSolid: boolean | null;
  /** Key of the selected object, so the layer list can mark its row. */
  selectedKey: string | null;
  canUndo: boolean;
  /** Bumped when objects are added or removed, so the layer list rebuilds its rows. */
  layerVersion: number;
  /**
   * Editor-only flags, never part of the layout: hidden objects are left out of the preview and
   * locked ones let clicks through. They live here rather than on the editor so they survive the
   * editor reopening after a save.
   */
  hidden: ReadonlySet<string>;
  locked: ReadonlySet<string>;
  /** Hash of the layout the flags were set on; a different town clears them. */
  flagsFor: string | null;
  /** "2 of 4" after a click over stacked objects, at the click in client pixels. */
  cycle: { index: number; total: number; x: number; y: number } | null;
  /** The Alt+click list of everything under the cursor. */
  pickMenu: { x: number; y: number; items: { key: string; label: string }[] } | null;
}

let current: TownEditor | null = null;

/** The open editor, for the React panel's buttons. */
export function activeTownEditor(): TownEditor | null {
  return current;
}

export const useTownEditor = create<EditorUiState>(() => ({
  active: false,
  tool: 'select',
  place: { type: 'prop', kind: 'house' },
  brushWidth: 110,
  snap: true,
  dirty: false,
  selection: null,
  selectionSolid: null,
  selectedKey: null,
  canUndo: false,
  layerVersion: 0,
  hidden: new Set(),
  locked: new Set(),
  flagsFor: null,
  cycle: null,
  pickMenu: null,
}));

type Selection = ObjectRef;

/** The hint follows the cursor only while it stays near the click that made it. */
const CYCLE_HINT_PX = 24;
/** Screen pixels the cursor must travel before a press on an object becomes a drag. */
const DRAG_START_PX = 4;

function decorLook(asset: string): DecorLook {
  const info = decorInfo(asset);
  const kind = isLitDecor(asset) ? 'light' : info.group === 'Nature' ? 'nature' : info.group === 'Buildings' ? 'building' : 'other';
  return { label: info.label, kind, height: info.height };
}

/** A new decor piece blocks walking when its asset usually does (buildings, walls, big clutter). */
function newDecor(asset: string, x: number, y: number, angle: number): TownDecor {
  return TOWN_DECOR_ASSETS[asset]?.solid ? { asset, x, y, angle, scale: 1, solid: true } : { asset, x, y, angle, scale: 1 };
}

const SNAP = 20;
const ROTATE_STEP = Math.PI / 12;
const PAN_SPEED = 900;
const REBUILD_MS = 90;
const UNDO_LIMIT = 80;

function clone(layout: TownLayout): TownLayout {
  return structuredClone(layout);
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
  private undo: { layout: string; hidden: string[]; locked: string[] }[] = [];
  private selection: Selection | null = null;
  private pendingAngle = 0;
  /**
   * A drag only starts once the cursor leaves the click spot, so the clicks of a cycle neither
   * nudge the object onto the grid nor cost an undo step.
   */
  private drag: { offX: number; offY: number; sx: number; sy: number; moved: boolean } | null = null;
  private cycleState: CycleState | null = null;
  private highlight: string | null = null;
  private stations: Map<string, Station> = new Map();
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
    const hash = layoutHash(layout);
    const keep = useTownEditor.getState().flagsFor === hash;
    const prune = (keys: ReadonlySet<string>) => (keep ? new Set([...keys].filter((k) => keyExists(this.layout, k))) : new Set<string>());
    const hidden = prune(useTownEditor.getState().hidden);
    useTownEditor.setState({ active: true, dirty: false, selection: null, selectedKey: null, canUndo: false, hidden, locked: prune(useTownEditor.getState().locked), flagsFor: hash, cycle: null, pickMenu: null });
    this.stations = stationsOf(this.layout);
    current = this;
    if (hidden.size > 0) this.needsRebuild = true;
  }

  dispose(): void {
    if (current === this) current = null;
    this.abort.abort();
    this.clearGizmos();
    this.world.setZoom(1);
    // Flags carry over to the next editor only for this exact layout (the one just saved). Unsaved
    // deletes have already shifted the flags onto indices the reopened town does not have.
    const saved = layoutHash(this.original);
    useTownEditor.setState({ active: false, flagsFor: layoutHash(this.layout) === saved ? saved : null, cycle: null, pickMenu: null });
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
      this.world.rebuildWorld(hideInMap(layoutToMap(this.layout), this.layout, useTownEditor.getState().hidden));
    }
    this.drawGizmos();
  }

  // -------------------------------------------------------------------------------------------
  // Panel actions

  setTool(tool: EditorTool): void {
    this.brush = null;
    useTownEditor.setState({ tool });
  }

  setPlace(item: PlaceItem): void {
    this.brush = null;
    useTownEditor.setState({ place: item, tool: 'place' });
  }

  /** Makes the selected decor piece block walking, or stop blocking it (key B). */
  toggleSolid(): void {
    const sel = this.selection;
    const d = sel?.type === 'decor' ? this.layout.decor[sel.index] : undefined;
    if (!d || !TOWN_DECOR_ASSETS[d.asset]) return;
    this.pushUndo();
    // The key is left out rather than set false, so the saved layout only grows for solid pieces.
    if (d.solid) delete d.solid;
    else d.solid = true;
    this.changed();
  }

  undoLast(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.layout = JSON.parse(prev.layout);
    useTownEditor.setState({ hidden: new Set(prev.hidden), locked: new Set(prev.locked) });
    this.selection = null;
    this.changed(false);
  }

  revert(): void {
    this.pushUndo();
    this.layout = clone(this.original);
    const s = useTownEditor.getState();
    const prune = (keys: ReadonlySet<string>) => new Set([...keys].filter((k) => keyExists(this.layout, k)));
    useTownEditor.setState({ hidden: prune(s.hidden), locked: prune(s.locked) });
    this.selection = null;
    this.changed(false);
  }

  saveLayout(): void {
    this.save(clone(this.layout));
    this.original = clone(this.layout);
    useTownEditor.setState({ dirty: false, flagsFor: layoutHash(this.layout) });
  }

  deleteSelected(): void {
    const sel = this.selection;
    if (!sel) return;
    // Portals and the spawn point can be moved but never deleted: the town needs its exits.
    if (sel.type === 'portal' || sel.type === 'spawn') return;
    this.pushUndo();
    if (sel.type === 'prop') this.layout.props.splice(sel.index, 1);
    else if (sel.type === 'decor') this.layout.decor.splice(sel.index, 1);
    else if (sel.type === 'path') this.layout.paths.splice(sel.index, 1);
    else this.layout.plazas.splice(sel.index, 1);
    const s = useTownEditor.getState();
    useTownEditor.setState({ hidden: shiftKeys(s.hidden, sel), locked: shiftKeys(s.locked, sel) });
    this.selection = null;
    this.cycleState = null;
    this.changed();
  }

  // -------------------------------------------------------------------------------------------
  // Layer list

  /** Rows for the layer list; the panel rebuilds them when `layerVersion` changes. */
  layers(): LayerRow[] {
    return layerRows(this.layout, decorLook, this.stations);
  }

  /** Selects an object from the layer list or the Alt+click menu; locked ones too, on purpose. */
  selectKey(key: string): void {
    const ref = parseKey(key);
    if (!ref || !keyExists(this.layout, key)) return;
    this.selection = ref;
    this.cycleState = null;
    useTownEditor.setState({ tool: 'select', pickMenu: null, cycle: null });
    this.publishSelection();
  }

  /** Double click in the layer list: centre the camera on the object. */
  focusKey(key: string): void {
    const ref = parseKey(key);
    const a = ref ? this.anchor(ref) : null;
    if (!a) return;
    this.camera.x = a.x;
    this.camera.y = a.y;
  }

  setHighlight(key: string | null): void {
    this.highlight = key;
  }

  toggleHidden(key: string): void {
    const s = useTownEditor.getState();
    const hidden = new Set(s.hidden);
    if (!hidden.delete(key)) hidden.add(key);
    // A hidden object cannot be seen to be dragged, so it lets go of the selection.
    if (hidden.has(key) && this.selection && refKey(this.selection) === key) this.selection = null;
    useTownEditor.setState({ hidden });
    this.cycleState = null;
    this.needsRebuild = true;
    this.rebuildAt = performance.now();
    this.publishSelection();
  }

  toggleLocked(key: string): void {
    const locked = new Set(useTownEditor.getState().locked);
    if (!locked.delete(key)) locked.add(key);
    useTownEditor.setState({ locked });
    this.cycleState = null;
  }

  closePickMenu(): void {
    useTownEditor.setState({ pickMenu: null });
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
    const s = useTownEditor.getState();
    this.undo.push({ layout: JSON.stringify(this.layout), hidden: [...s.hidden], locked: [...s.locked] });
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    useTownEditor.setState({ canUndo: true });
  }

  /** `rows` is false while dragging, so the layer list is not rebuilt on every mouse move. */
  private changed(dirty = true, rows = true): void {
    this.needsRebuild = true;
    this.rebuildAt = performance.now() + REBUILD_MS;
    this.stations = stationsOf(this.layout);
    const s = useTownEditor.getState();
    useTownEditor.setState({ dirty: dirty || s.dirty, canUndo: this.undo.length > 0, layerVersion: s.layerVersion + (rows ? 1 : 0) });
    this.publishSelection();
  }

  private publishSelection(): void {
    const sel = this.selection;
    const d = sel?.type === 'decor' ? this.layout.decor[sel.index] : undefined;
    const solid = d && TOWN_DECOR_ASSETS[d.asset] ? d.solid === true : null;
    useTownEditor.setState({ selection: this.selectionLabel(), selectionSolid: solid, selectedKey: sel ? refKey(sel) : null });
  }

  private selectionLabel(): string | null {
    const sel = this.selection;
    if (!sel) return null;
    const station = this.stations.get(refKey(sel));
    const role = station ? ` (${station})` : '';
    if (sel.type === 'prop') {
      const p = this.layout.props[sel.index];
      return p ? `${PROP_DEFS[p.kind].label}${role}, scale ${p.scale.toFixed(2)}` : null;
    }
    if (sel.type === 'decor') {
      const d = this.layout.decor[sel.index];
      return d ? `${decorLook(d.asset).label}${role}, scale ${d.scale.toFixed(2)}` : null;
    }
    if (sel.type === 'path') return 'Path';
    if (sel.type === 'plaza') return 'Plaza';
    if (sel.type === 'portal') return `Portal: ${this.layout.portals[sel.index]?.target ?? ''}`;
    return 'Spawn point';
  }

  /** Everything a click at a ground point can pick, front to back; hidden and locked objects let it through. */
  private candidates(x: number, y: number): Selection[] {
    const { hidden, locked } = useTownEditor.getState();
    return pickAll(this.layout, x, y, { look: decorLook, stations: this.stations, skip: (k) => hidden.has(k) || locked.has(k) });
  }

  private pick(x: number, y: number): Selection | null {
    return this.candidates(x, y)[0] ?? null;
  }

  private outlineOf(ref: Selection, color: number): void {
    if (ref.type === 'path') {
      const path = this.layout.paths[ref.index];
      if (path) this.addPathLine(path.points, color);
      return;
    }
    if (ref.type === 'prop') {
      const p = this.layout.props[ref.index];
      if (p) this.addOutline(PROP_DEFS[p.kind].shape(p), color);
      return;
    }
    for (const s of pickShapes(this.layout, ref, { look: decorLook, stations: this.stations })) this.addOutline(s, color);
  }

  /** The anchor point of a selection, for dragging. */
  private anchor(sel: Selection): Vec2 | null {
    const L = this.layout;
    if (sel.type === 'prop') return L.props[sel.index] ?? null;
    if (sel.type === 'decor') return L.decor[sel.index] ?? null;
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
    if (ui.pickMenu) useTownEditor.setState({ pickMenu: null });
    const x = this.snap(g.x);
    const y = this.snap(g.y);
    switch (ui.tool) {
      case 'select': {
        const under = this.candidates(g.x, g.y);
        if (e.altKey) {
          e.preventDefault();
          const rows = new Map(this.layers().map((r) => [r.key, r.label]));
          const items = under.map((ref) => {
            const key = refKey(ref);
            return { key, label: rows.get(key) ?? key };
          });
          useTownEditor.setState({ pickMenu: items.length > 0 ? { x: e.clientX, y: e.clientY, items } : null, cycle: null });
          return;
        }
        this.cycleState = cycleClick(this.cycleState, e.clientX, e.clientY, under.map(refKey), this.selection ? refKey(this.selection) : null);
        const key = this.cycleState ? cycleKey(this.cycleState) : null;
        this.selection = key ? parseKey(key) : null;
        const a = this.selection ? this.anchor(this.selection) : null;
        if (a) this.drag = { offX: a.x - g.x, offY: a.y - g.y, sx: e.clientX, sy: e.clientY, moved: false };
        const c = this.cycleState;
        useTownEditor.setState({ cycle: c && c.keys.length > 1 ? { index: c.index, total: c.keys.length, x: e.clientX, y: e.clientY } : null });
        this.publishSelection();
        return;
      }
      case 'place': {
        this.pushUndo();
        const item = ui.place;
        if (item.type === 'decor') {
          this.layout.decor.push(newDecor(item.asset, x, y, this.pendingAngle));
          this.selection = { type: 'decor', index: this.layout.decor.length - 1 };
        } else {
          const prop: TownProp = { kind: item.kind, x, y, angle: this.pendingAngle, scale: 1, length: PROP_DEFS[item.kind].line ? 200 : 0 };
          this.layout.props.push(prop);
          this.selection = { type: 'prop', index: this.layout.props.length - 1 };
        }
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
    const hint = useTownEditor.getState().cycle;
    if (hint && Math.hypot(e.clientX - hint.x, e.clientY - hint.y) > CYCLE_HINT_PX) useTownEditor.setState({ cycle: null });
    const g = this.ground(e);
    this.hover = g;
    if (!g) return;
    const drag = this.drag;
    if (drag && this.selection && (drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > DRAG_START_PX)) {
      if (!drag.moved) {
        drag.moved = true;
        this.pushUndo();
      }
      this.moveSelection(this.selection, this.snap(g.x + drag.offX), this.snap(g.y + drag.offY));
      this.changed(true, false);
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
    // The layer list shows positions; it catches up once, when the drag ends.
    if (this.drag?.moved) useTownEditor.setState((s) => ({ layerVersion: s.layerVersion + 1 }));
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
    const p = sel?.type === 'prop' ? this.layout.props[sel.index] : sel?.type === 'decor' ? this.layout.decor[sel.index] : undefined;
    const line = sel?.type === 'prop' && p !== undefined && 'kind' in p && PROP_DEFS[p.kind].line;
    if (e.code === 'Escape' && useTownEditor.getState().pickMenu) {
      this.closePickMenu();
      return;
    }
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
          if (line && 'length' in p) p.length = Math.max(40, p.length + (up ? 40 : -40));
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
      case 'KeyB':
        this.toggleSolid();
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
    if (sel?.type === 'spawn' || sel?.type === 'portal') {
      const a = this.anchor(sel);
      if (a) this.addOutline({ type: 'circle', x: a.x, y: a.y, r: 56 }, 0xffd36b);
    } else if (sel) this.outlineOf(sel, 0xffd36b);

    const lit = this.highlight ? parseKey(this.highlight) : null;
    if (lit && (!sel || refKey(sel) !== this.highlight) && keyExists(L, refKey(lit))) this.outlineOf(lit, 0x7fd8ff);

    const h = this.hover;
    if (h && ui.tool === 'select' && !this.drag) {
      // What a click here would pick, so a station's larger target is visible before clicking.
      const next = this.pick(h.x, h.y);
      if (next && (!sel || refKey(next) !== refKey(sel)) && refKey(next) !== this.highlight) this.outlineOf(next, 0x6f7f8f);
    }
    if (h && ui.tool === 'place') {
      const x = this.snap(h.x);
      const y = this.snap(h.y);
      const item = ui.place;
      if (item.type === 'prop') this.addOutline(PROP_DEFS[item.kind].shape({ kind: item.kind, x, y, angle: this.pendingAngle, scale: 1, length: 200 }), 0x9fd0ff);
      else {
        const foot = decorFootprint(newDecor(item.asset, x, y, this.pendingAngle));
        this.addOutline(foot ?? { type: 'circle', x, y, r: 16 }, 0x9fd0ff);
      }
    } else if (h && (ui.tool === 'path' || ui.tool === 'plaza')) {
      const ring = new Mesh(new RingGeometry(ui.tool === 'path' ? ui.brushWidth / 2 - 3 : 26, ui.tool === 'path' ? ui.brushWidth / 2 : 30, 32), new MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.8, depthTest: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(h.x, 3, h.y);
      ring.renderOrder = 20;
      this.world.overlay.add(ring);
      this.gizmos.push(ring);
    } else if (h && ui.tool === 'erase') {
      const target = this.pick(h.x, h.y);
      if (target && target.type !== 'portal' && target.type !== 'spawn') this.outlineOf(target, 0xff5a4a);
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
