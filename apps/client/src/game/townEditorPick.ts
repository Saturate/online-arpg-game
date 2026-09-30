import { decorCollision, decorFootprint, PROP_DEFS, type Shape, type TownLayout, type TownPropKind, type WorldMap } from '@rune/shared';

/**
 * The town editor's picking and layer logic, kept free of three.js and the DOM so it can be tested:
 * what is under the cursor and in which order, click cycling, the layer list and its search, and
 * the editor-only hide and lock flags.
 */

export type ObjectRef =
  { type: 'prop'; index: number } | { type: 'decor'; index: number } | { type: 'path'; index: number } | { type: 'plaza'; index: number } | { type: 'portal'; index: number } | { type: 'spawn' };

export type IndexedType = Exclude<ObjectRef['type'], 'spawn'>;

const INDEXED: readonly IndexedType[] = ['prop', 'decor', 'path', 'plaza', 'portal'];

export function refKey(ref: ObjectRef): string {
  return ref.type === 'spawn' ? 'spawn' : `${ref.type}:${ref.index}`;
}

export function parseKey(key: string): ObjectRef | null {
  if (key === 'spawn') return { type: 'spawn' };
  const [type, n] = key.split(':');
  const index = Number(n);
  const t = INDEXED.find((k) => k === type);
  return t && Number.isInteger(index) && index >= 0 ? { type: t, index } : null;
}

/** Whether a key still names something in the layout (undo and delete shrink the arrays). */
export function keyExists(layout: TownLayout, key: string): boolean {
  const ref = parseKey(key);
  if (!ref) return false;
  switch (ref.type) {
    case 'spawn':
      return true;
    case 'prop':
      return ref.index < layout.props.length;
    case 'decor':
      return ref.index < layout.decor.length;
    case 'path':
      return ref.index < layout.paths.length;
    case 'plaza':
      return ref.index < layout.plazas.length;
    case 'portal':
      return ref.index < layout.portals.length;
  }
}

// ---------------------------------------------------------------------------------------------
// Stations

export type Station = 'forge' | 'stash' | 'trader';

function nearest<T extends { x: number; y: number }>(items: readonly T[], match: (t: T) => boolean, x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  items.forEach((t, i) => {
    if (!match(t)) return;
    const d = Math.hypot(t.x - x, t.y - y);
    // Strictly nearer only, so a tie goes to the earlier one, as the stable sort in layoutToMap does.
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Which objects the game turns into stations, by the same nearest-the-spawn rule as `layoutToMap`. */
export function stationsOf(layout: TownLayout): Map<string, Station> {
  const out = new Map<string, Station>();
  const { x, y } = layout.spawn;
  const chest = nearest(layout.props, (p) => p.kind === 'chest', x, y);
  if (chest >= 0) out.set(`prop:${chest}`, 'stash');
  const stall = nearest(layout.props, (p) => p.kind === 'stall', x, y);
  if (stall >= 0) out.set(`prop:${stall}`, 'trader');
  const rack = nearest(layout.decor, (d) => d.asset === 'weaponrack', x, y);
  if (rack >= 0) out.set(`decor:${rack}`, 'forge');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Picking

/** How the editor sees a decor asset; the client fills this in from its asset registry. */
export interface DecorLook {
  label: string;
  kind: 'building' | 'nature' | 'light' | 'other';
  /** Model height in world units, which also sizes its pick circle. */
  height: number;
}

export type DecorLookup = (asset: string) => DecorLook;

export const PICK = {
  /** Slack around every footprint, so thin props are not a pixel hunt. */
  pad: 6,
  /**
   * Extra reach around stations. The forge is a thin weapon rack and the stash a small chest, both
   * next to other clutter; the bigger target is editor-only and does not touch the gameplay reach.
   */
  stationPad: 26,
  portalR: 60,
  spawnR: 30,
  /** Decor has no collision shape; its pick circle comes from the model height, within these bounds. */
  decorMin: 12,
  decorMax: 70,
} as const;

export interface PickContext {
  look: DecorLookup;
  stations: ReadonlyMap<string, Station>;
  /** Keys the click must pass through: hidden and locked objects. */
  skip: (key: string) => boolean;
}

function grow(s: Shape, pad: number): Shape {
  if (s.type === 'circle') return { ...s, r: s.r + pad };
  if (s.type === 'capsule') return { ...s, r: s.r + pad };
  return { ...s, hw: s.hw + pad, hh: s.hh + pad };
}

export function insideShape(s: Shape, x: number, y: number): boolean {
  switch (s.type) {
    case 'circle':
      return Math.hypot(x - s.x, y - s.y) <= s.r;
    case 'capsule': {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
      return Math.hypot(x - (s.ax + dx * t), y - (s.ay + dy * t)) <= s.r;
    }
    case 'box': {
      const c = Math.cos(-s.angle);
      const sn = Math.sin(-s.angle);
      const lx = (x - s.x) * c - (y - s.y) * sn;
      const ly = (x - s.x) * sn + (y - s.y) * c;
      return Math.abs(lx) <= s.hw && Math.abs(ly) <= s.hh;
    }
  }
}

function shapeArea(s: Shape): number {
  if (s.type === 'circle') return Math.PI * s.r * s.r;
  if (s.type === 'box') return 4 * s.hw * s.hh;
  return Math.hypot(s.bx - s.ax, s.by - s.ay) * 2 * s.r + Math.PI * s.r * s.r;
}

/**
 * The shapes a click must land in to pick an object, already grown by the pick padding. Paths have
 * one capsule per segment; everything else has one shape.
 */
export function pickShapes(layout: TownLayout, ref: ObjectRef, ctx: Pick<PickContext, 'look' | 'stations'>): Shape[] {
  const station = ctx.stations.has(refKey(ref));
  const pad = station ? PICK.stationPad : PICK.pad;
  switch (ref.type) {
    case 'prop': {
      const p = layout.props[ref.index];
      return p ? [grow(PROP_DEFS[p.kind].shape(p), pad)] : [];
    }
    case 'decor': {
      const d = layout.decor[ref.index];
      if (!d) return [];
      // A building or a wall placed as decor is clicked anywhere on its footprint; smaller pieces
      // keep the round target sized from their height.
      const foot = decorFootprint(d);
      if (foot?.type === 'box' && Math.max(foot.hw, foot.hh) > PICK.decorMax) return [grow(foot, pad)];
      const r = Math.max(PICK.decorMin, Math.min(PICK.decorMax, ctx.look(d.asset).height * 0.45)) * d.scale;
      return [{ type: 'circle', x: d.x, y: d.y, r: r + pad }];
    }
    case 'portal': {
      const p = layout.portals[ref.index];
      return p ? [{ type: 'circle', x: p.x, y: p.y, r: PICK.portalR }] : [];
    }
    case 'spawn':
      return [{ type: 'circle', x: layout.spawn.x, y: layout.spawn.y, r: PICK.spawnR }];
    case 'path': {
      const path = layout.paths[ref.index];
      if (!path) return [];
      const out: Shape[] = [];
      for (let j = 0; j < path.points.length - 1; j++) {
        const a = path.points[j];
        const b = path.points[j + 1];
        if (a && b) out.push({ type: 'capsule', ax: a.x, ay: a.y, bx: b.x, by: b.y, r: path.width / 2 });
      }
      return out;
    }
    case 'plaza': {
      const p = layout.plazas[ref.index];
      return p ? [{ type: 'circle', x: p.x, y: p.y, r: p.r }] : [];
    }
  }
}

/**
 * Everything under a ground point, front to back. Stations, portals and the spawn come first, then
 * props and decor smallest first (a barrel on a plaza sits inside it, and small things are what
 * gets lost behind a house), then paths and plazas, which are flat on the ground. Within a tie the
 * later object wins, since it was placed on top.
 */
export function pickAll(layout: TownLayout, x: number, y: number, ctx: PickContext): ObjectRef[] {
  const hits: { ref: ObjectRef; rank: number; area: number; order: number }[] = [];
  const consider = (ref: ObjectRef, rank: number, order: number) => {
    const key = refKey(ref);
    if (ctx.skip(key)) return;
    const shapes = pickShapes(layout, ref, ctx);
    if (!shapes.some((s) => insideShape(s, x, y))) return;
    const station = ctx.stations.has(key);
    hits.push({ ref, rank: station ? 0 : rank, area: shapes.reduce((a, s) => a + shapeArea(s), 0), order });
  };
  layout.portals.forEach((_, i) => consider({ type: 'portal', index: i }, 0, i));
  consider({ type: 'spawn' }, 0, 0);
  layout.props.forEach((_, i) => consider({ type: 'prop', index: i }, 1, i));
  layout.decor.forEach((_, i) => consider({ type: 'decor', index: i }, 1, i));
  layout.paths.forEach((_, i) => consider({ type: 'path', index: i }, 2, i));
  layout.plazas.forEach((_, i) => consider({ type: 'plaza', index: i }, 3, i));
  hits.sort((a, b) => a.rank - b.rank || a.area - b.area || b.order - a.order);
  return hits.map((h) => h.ref);
}

// ---------------------------------------------------------------------------------------------
// Click cycling

/** Screen pixels a click may drift and still count as "the same spot". */
export const CYCLE_SLOP_PX = 6;

export interface CycleState {
  sx: number;
  sy: number;
  keys: string[];
  index: number;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}

/**
 * The next selection for a click at screen point (sx, sy) over `keys` (front to back). A click at
 * the same spot over the same objects steps to the next one and wraps around; anything else starts
 * over at the front, unless the current selection is under the cursor, which is kept so an object
 * chosen in the layer list can be dragged from a crowded spot.
 */
export function cycleClick(prev: CycleState | null, sx: number, sy: number, keys: readonly string[], selectedKey: string | null): CycleState | null {
  if (keys.length === 0) return null;
  if (prev && Math.hypot(sx - prev.sx, sy - prev.sy) <= CYCLE_SLOP_PX && sameSet(prev.keys, keys)) {
    // The earlier order is kept, so a cycle visits each object once even if sizes changed.
    return { sx: prev.sx, sy: prev.sy, keys: prev.keys, index: (prev.index + 1) % prev.keys.length };
  }
  const held = selectedKey === null ? -1 : keys.indexOf(selectedKey);
  return { sx, sy, keys: [...keys], index: Math.max(0, held) };
}

export function cycleKey(c: CycleState): string | null {
  return c.keys[c.index] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Layers

export const LAYER_GROUPS = ['Stations', 'Buildings', 'Props', 'Lights and decor', 'Nature', 'Ground'] as const;
export type LayerGroup = (typeof LAYER_GROUPS)[number];

export interface LayerRow {
  key: string;
  group: LayerGroup;
  label: string;
  /** Position, to tell apart the dozen "Pine tree" rows. */
  detail: string;
}

const PROP_GROUP: Record<TownPropKind, LayerGroup> = {
  house: 'Buildings',
  cottage: 'Buildings',
  stall: 'Buildings',
  well: 'Buildings',
  chest: 'Props',
  crate: 'Props',
  pillar: 'Props',
  fence: 'Props',
  wall: 'Props',
  lamp: 'Lights and decor',
  pine: 'Nature',
  oak: 'Nature',
  rock: 'Nature',
};

const DECOR_GROUP: Record<DecorLook['kind'], LayerGroup> = { building: 'Buildings', nature: 'Nature', light: 'Lights and decor', other: 'Lights and decor' };

const STATION_LABEL: Record<Station, string> = { forge: 'Forge (weapon rack)', stash: 'Stash (chest)', trader: 'Trader (market stall)' };
const STATION_ORDER: Record<Station, number> = { forge: 0, stash: 1, trader: 2 };
const PORTAL_LABEL: Record<TownLayout['portals'][number]['target'], string> = { wilds: 'Portal: The Wilds', arena: 'Arena entrance', town: 'Portal: Town' };

function at(x: number, y: number): string {
  return `${Math.round(x)}, ${Math.round(y)}`;
}

/**
 * Every town object as a layer row, grouped in `LAYER_GROUPS` order. Stations lead (forge, stash,
 * trader, then portals and the spawn, which is where the town waypoint stands); other groups are
 * sorted by name, then by the order they were placed.
 */
export function layerRows(layout: TownLayout, look: DecorLookup, stations: ReadonlyMap<string, Station>): LayerRow[] {
  const rows: (LayerRow & { order: number })[] = [];
  layout.props.forEach((p, i) => {
    const key = `prop:${i}`;
    const st = stations.get(key);
    if (st) rows.push({ key, group: 'Stations', label: STATION_LABEL[st], detail: at(p.x, p.y), order: STATION_ORDER[st] });
    else rows.push({ key, group: PROP_GROUP[p.kind], label: PROP_DEFS[p.kind].label, detail: at(p.x, p.y), order: i });
  });
  layout.decor.forEach((d, i) => {
    const key = `decor:${i}`;
    const st = stations.get(key);
    const l = look(d.asset);
    if (st) rows.push({ key, group: 'Stations', label: STATION_LABEL[st], detail: at(d.x, d.y), order: STATION_ORDER[st] });
    else rows.push({ key, group: DECOR_GROUP[l.kind], label: l.label, detail: at(d.x, d.y), order: layout.props.length + i });
  });
  layout.portals.forEach((p, i) => rows.push({ key: `portal:${i}`, group: 'Stations', label: PORTAL_LABEL[p.target], detail: at(p.x, p.y), order: 10 + i }));
  rows.push({ key: 'spawn', group: 'Stations', label: 'Spawn point and waypoint', detail: at(layout.spawn.x, layout.spawn.y), order: 100 });
  layout.paths.forEach((p, i) => rows.push({ key: `path:${i}`, group: 'Ground', label: `Path ${i + 1}`, detail: `${p.points.length} points`, order: i }));
  layout.plazas.forEach((p, i) => rows.push({ key: `plaza:${i}`, group: 'Ground', label: `Plaza ${i + 1}`, detail: at(p.x, p.y), order: 1000 + i }));
  const g = (r: LayerRow) => LAYER_GROUPS.indexOf(r.group);
  rows.sort((a, b) => g(a) - g(b) || (a.group === 'Stations' || a.group === 'Ground' ? 0 : a.label.localeCompare(b.label)) || a.order - b.order);
  return rows.map(({ key, group, label, detail }) => ({ key, group, label, detail }));
}

/** Case-insensitive search: every word must appear in the row's name, group or station role. */
export function filterRows(rows: readonly LayerRow[], query: string): LayerRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const text = `${r.label} ${r.group}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function groupRows(rows: readonly LayerRow[]): { group: LayerGroup; rows: LayerRow[] }[] {
  return LAYER_GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Hide and lock

/**
 * Keys after removing `removed` from its array: its own key goes and the later ones of the same
 * type move down one, so the flags stay on the objects they were set on.
 */
export function shiftKeys(keys: ReadonlySet<string>, removed: ObjectRef): Set<string> {
  if (removed.type === 'spawn') return new Set(keys);
  const out = new Set<string>();
  for (const k of keys) {
    const ref = parseKey(k);
    if (!ref || ref.type !== removed.type) {
      out.add(k);
      continue;
    }
    if (ref.index === removed.index) continue;
    out.add(ref.index > removed.index ? `${ref.type}:${ref.index - 1}` : k);
  }
  return out;
}

function sameShape(a: Shape, b: Shape): boolean {
  if (a.type === 'circle' && b.type === 'circle') return a.x === b.x && a.y === b.y && a.r === b.r;
  if (a.type === 'box' && b.type === 'box') return a.x === b.x && a.y === b.y && a.hw === b.hw && a.hh === b.hh && a.angle === b.angle;
  if (a.type === 'capsule' && b.type === 'capsule') return a.ax === b.ax && a.ay === b.ay && a.bx === b.bx && a.by === b.by && a.r === b.r;
  return false;
}

function dropFirst<T>(list: T[], match: (t: T) => boolean): void {
  const i = list.findIndex(match);
  if (i >= 0) list.splice(i, 1);
}

/**
 * The editor's preview of `map` (built from `layout` by `layoutToMap`) with hidden objects left
 * out. Filtering the built map rather than the layout keeps the station fallbacks from kicking in:
 * hiding the forge's rack must not conjure a spare rack by the spawn.
 */
export function hideInMap(map: WorldMap, layout: TownLayout, hidden: ReadonlySet<string>): WorldMap {
  if (hidden.size === 0) return map;
  const out: WorldMap = {
    ...map,
    obstacles: [...map.obstacles],
    ground: [...map.ground],
    decor: [...map.decor],
    portals: [...map.portals],
    lamps: [...(map.lamps ?? [])],
    oaks: [...(map.oaks ?? [])],
  };
  const stations = stationsOf(layout);
  for (const key of hidden) {
    const ref = parseKey(key);
    if (!ref) continue;
    if (ref.type === 'prop') {
      const p = layout.props[ref.index];
      if (!p) continue;
      if (p.kind === 'lamp') dropFirst(out.lamps ?? [], (l) => l.x === p.x && l.y === p.y);
      else {
        const s = PROP_DEFS[p.kind].shape(p);
        dropFirst(out.obstacles, (o) => sameShape(o.shape, s));
      }
      if (p.kind === 'oak') dropFirst(out.oaks ?? [], (o) => o.x === p.x && o.y === p.y);
    } else if (ref.type === 'decor') {
      const d = layout.decor[ref.index];
      if (!d) continue;
      dropFirst(out.decor, (e) => e.asset === d.asset && e.x === d.x && e.y === d.y && e.angle === d.angle && e.scale === d.scale);
      const block = d.solid ? decorCollision(d) : null;
      if (block) dropFirst(out.obstacles, (o) => o.kind === 'decor' && sameShape(o.shape, block));
      // The forge's fire is drawn at the station spot, so it goes with the rack.
      if (stations.get(key) === 'forge') delete out.forge;
    } else if (ref.type === 'plaza') {
      const p = layout.plazas[ref.index];
      if (p) dropFirst(out.ground, (g) => g.kind === 'plaza' && sameShape(g.shape, { type: 'circle', x: p.x, y: p.y, r: p.r }));
    } else if (ref.type === 'path') {
      for (const s of pickShapes(layout, ref, { look: () => ({ label: '', kind: 'other', height: 0 }), stations })) dropFirst(out.ground, (g) => g.kind === 'road' && sameShape(g.shape, s));
    } else if (ref.type === 'portal') {
      const p = layout.portals[ref.index];
      if (p) dropFirst(out.portals, (q) => q.x === p.x && q.y === p.y && q.target === p.target);
    }
  }
  return out;
}
