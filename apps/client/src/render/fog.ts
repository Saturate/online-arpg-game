/**
 * Explored ground for the minimap and the world map, as one bit per cell, and its memory between
 * sessions. A cell is a square of `cell` world units; the minimap picks the size so a cell is two of
 * its pixels, which for the 13000 unit world is 80 units and a 163 by 163 grid (3.3 KB of bits).
 */
export class FogGrid {
  readonly bits: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    /** Side of a cell in world units. */
    readonly cell: number,
    bits?: Uint8Array,
  ) {
    const bytes = Math.ceil((cols * rows) / 8);
    this.bits = bits?.length === bytes ? bits : new Uint8Array(bytes);
  }

  get size(): number {
    return this.cols * this.rows;
  }

  has(i: number): boolean {
    return i >= 0 && i < this.size && ((this.bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
  }

  /** Marks a cell; true when it was not marked before. */
  set(i: number): boolean {
    if (i < 0 || i >= this.size || this.has(i)) return false;
    this.bits[i >> 3] = (this.bits[i >> 3] ?? 0) | (1 << (i & 7));
    return true;
  }

  /** The cell under a world spot, or -1 off the grid. */
  index(x: number, y: number): number {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    return cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows ? -1 : cy * this.cols + cx;
  }

  seenAt(x: number, y: number): boolean {
    return this.has(this.index(x, y));
  }

  fill(): void {
    for (let i = 0; i < this.size; i++) this.set(i);
  }

  /** Marks every cell whose middle lies within `r` of (x, y); the newly marked go into `out`. */
  markCircle(x: number, y: number, r: number, out: number[]): void {
    const c = this.cell;
    const c0 = Math.max(0, Math.floor((x - r) / c));
    const c1 = Math.min(this.cols - 1, Math.floor((x + r) / c));
    const r0 = Math.max(0, Math.floor((y - r) / c));
    const r1 = Math.min(this.rows - 1, Math.floor((y + r) / c));
    for (let cy = r0; cy <= r1; cy++) {
      const dy = (cy + 0.5) * c - y;
      for (let cx = c0; cx <= c1; cx++) {
        const dx = (cx + 0.5) * c - x;
        const i = cy * this.cols + cx;
        if (dx * dx + dy * dy <= r * r && this.set(i)) out.push(i);
      }
    }
  }

  /** Marks every cell a rectangle touches. */
  markRect(x: number, y: number, w: number, h: number, out: number[]): void {
    const c = this.cell;
    const c0 = Math.max(0, Math.floor(x / c));
    const c1 = Math.min(this.cols - 1, Math.floor((x + w) / c));
    const r0 = Math.max(0, Math.floor(y / c));
    const r1 = Math.min(this.rows - 1, Math.floor((y + h) / c));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) if (this.set(cy * this.cols + cx)) out.push(cy * this.cols + cx);
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.has(i)) n++;
    return n;
  }
}

export function encodeBits(bits: Uint8Array): string {
  let s = '';
  // In slices: String.fromCharCode with thousands of arguments overflows the stack on some engines.
  for (let i = 0; i < bits.length; i += 4096) s += String.fromCharCode(...bits.subarray(i, i + 4096));
  return btoa(s);
}

/** Null when `text` is not base64 of exactly `bytes` bytes. */
export function decodeBits(text: string, bytes: number): Uint8Array | null {
  let s: string;
  try {
    s = atob(text);
  } catch {
    return null;
  }
  if (s.length !== bytes) return null;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** What a character remembers of one world: explored cells, the regions entered and the waypoints found. */
export interface FogRecord {
  grid: FogGrid;
  regions: string[];
  waypoints: string[];
}

/** The part of `Storage` the fog uses, so tests can hand in a plain object. */
export interface FogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'rune.fog.';
const INDEX_KEY = 'rune.fog.index';
/**
 * Worlds remembered per browser. Every party world has a seed of its own, so without a cap a
 * player in many parties would fill localStorage (about 4.5 KB a world) with worlds long closed.
 */
export const FOG_KEEP = 16;

export function fogKey(characterId: number, seed: number): string {
  return `${PREFIX}${characterId}.${seed}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length < 40);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A remembered world, or null when there is none, it is corrupt, or its grid has another shape. */
export function readFog(storage: FogStorage, key: string, cols: number, rows: number, cell: number): FogRecord | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.v !== 1 || v.c !== cols || v.r !== rows || typeof v.b !== 'string') return null;
  const bits = decodeBits(v.b, Math.ceil((cols * rows) / 8));
  if (!bits) return null;
  return { grid: new FogGrid(cols, rows, cell, bits), regions: isStringArray(v.g) ? v.g : [], waypoints: isStringArray(v.w) ? v.w : [] };
}

function readIndex(storage: FogStorage): { key: string; at: number }[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.flatMap((e: unknown) => (isRecord(e) && typeof e.key === 'string' && e.key.startsWith(PREFIX) && typeof e.at === 'number' ? [{ key: e.key, at: e.at }] : []));
  } catch {
    return [];
  }
}

/** Saves a world and forgets the least recently saved past FOG_KEEP. Quietly does nothing when storage refuses. */
export function writeFog(storage: FogStorage, key: string, rec: FogRecord, now: number): void {
  const { grid } = rec;
  try {
    storage.setItem(key, JSON.stringify({ v: 1, c: grid.cols, r: grid.rows, b: encodeBits(grid.bits), g: rec.regions, w: rec.waypoints }));
    const index = [{ key, at: now }, ...readIndex(storage).filter((e) => e.key !== key)].sort((a, b) => b.at - a.at);
    for (const old of index.slice(FOG_KEEP)) storage.removeItem(old.key);
    storage.setItem(INDEX_KEY, JSON.stringify(index.slice(0, FOG_KEEP)));
  } catch {
    // Full or blocked storage: the map is remembered for this session only.
  }
}

/** The browser's localStorage, or null where touching it throws (blocked site data, some private windows). */
export function browserStorage(): FogStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
