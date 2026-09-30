import { AddEquation, Color, CustomBlending, DataTexture, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, LinearFilter, MeshBasicMaterial, OneFactor, OneMinusSrcColorFactor, PlaneGeometry, PointLight, RGBAFormat } from 'three';

import { ChunkBuckets, NearCache } from './chunks.js';
import { RENDER_ORDER } from './config.js';

/**
 * The light budget shared by torches, lanterns, fires and spells. Any number of sources ask for
 * light each frame; the few that matter most (priority, brightness, distance to the camera) get one
 * of a fixed pool of real point lights and everything else is drawn as a cheap pool of light on the
 * ground. The pool size never changes, because the light count is compiled into every
 * material's shader: adding or removing lights as you walk would recompile shaders mid-fight.
 *
 * Per frame, callers use `emitLight` with a stable key from `lightKey()`; the key is what lets a
 * source keep its real light across frames and fade it in or out instead of popping. Emits are read
 * by the next `LightBudget.update` and then cleared, so a source that stops emitting fades out.
 * Nothing here allocates per frame.
 */

/** Real point lights in the pool. Each one costs a loop iteration in every lit fragment. */
export const POOL_SIZE = 8;
/** Sources beyond this many per frame are dropped: statics plus emits. */
export const MAX_SOURCES = 512;
/** Seconds for a real light to fade fully in or out when a source wins or loses its slot. */
const FADE_SECONDS = 0.45;
/** Beyond this ground distance from the camera focus a source is off screen: no light, no pool. */
const CULL_RANGE = 1000;
/**
 * Falloff exponent of the real lights. Their intensity is scaled by height^DECAY, so `intensity`
 * is the light straight below the source and it falls off into a pool rather than a flat disc.
 */
const DECAY = 1.2;
/**
 * The most light the budget lets pile up where the hero stands (in units of a source's intensity
 * straight below it). A volley of spells or a crowd of torches is scaled down to this together, so
 * the fight never burns white; a single torch (3) stays under it.
 */
const LIGHT_CAP = 4;
/** How bright a ground pool is for a source of intensity 1; low, since it lays over the lit ground. */
const POOL_GAIN = 0.07;
/** A pool is drawn this share of its source's radius wide. */
const POOL_REACH = 0.7;

let nextKey = 1;
/** A fresh key for one light source. Keep it for the source's life; keys are never reused. */
export function lightKey(): number {
  return nextKey++;
}

/**
 * A key tied to a sim entity, so every client picks the same one without keeping a table: `channel`
 * tells apart several lights on one entity (0 to 7). Never collides with `lightKey()` keys.
 */
export function entityLightKey(entityId: number, channel = 0): number {
  return -2 - (entityId * 8 + (channel & 7));
}

/** A light that belongs to the world: lamps, torches, fires, waypoints. Flickers on its own. */
export interface StaticLight {
  x: number;
  y: number;
  height: number;
  color: number;
  intensity: number;
  radius: number;
  /** 0 steady, 0.1 a gentle torch flicker. */
  flicker: number;
  /** Tiers above brightness: a higher priority always wins a real light first. */
  priority: number;
  /** Share of the light kept by full day outdoors, 0 for lamps that are only lit at night. */
  day: number;
}

/**
 * How much a world light's flicker lifts or dims it at time `t`: two slow, unrelated sines seeded
 * by its position, a living flame and never a strobe. The flames drawn for a torch or fire read the
 * same value, so the fire and its light pulse together.
 */
export function staticFlicker(t: number, x: number, y: number, amount: number): number {
  const seed = x * 0.013 + y * 0.029;
  return 1 + amount * (Math.sin(t * 5.3 + seed) * 0.6 + Math.sin(t * 11.7 + seed * 2.3) * 0.4);
}

export class LightBudget {
  /** Add to the scene once; holds the pool lights and the ground pools. */
  readonly group = new Group();
  private readonly pool: PointLight[] = [];
  private readonly slotKey = new Int32Array(POOL_SIZE).fill(-1);
  private readonly slotWeight = new Float32Array(POOL_SIZE);
  private readonly slotLevel = new Float32Array(POOL_SIZE);
  /** Whether the slot's source was chosen this frame, so it fades toward 1 instead of 0. */
  private readonly slotChosen = new Uint8Array(POOL_SIZE);
  // Sources for this frame, statics first, then emits, as parallel arrays.
  private readonly key = new Int32Array(MAX_SOURCES);
  private readonly sx = new Float32Array(MAX_SOURCES);
  private readonly sy = new Float32Array(MAX_SOURCES);
  private readonly sh = new Float32Array(MAX_SOURCES);
  private readonly color = new Uint32Array(MAX_SOURCES);
  private readonly intensity = new Float32Array(MAX_SOURCES);
  private readonly radius = new Float32Array(MAX_SOURCES);
  private readonly priority = new Float32Array(MAX_SOURCES);
  private readonly day = new Float32Array(MAX_SOURCES);
  /** Effective intensity after day/night and flicker, and its score, filled in by update. */
  private readonly level = new Float32Array(MAX_SOURCES);
  private readonly score = new Float32Array(MAX_SOURCES);
  private readonly best = new Int32Array(POOL_SIZE);
  /** This frame's ground pools before drawing: their source index and strength. */
  private readonly poolSource = new Int32Array(MAX_SOURCES);
  private readonly poolStrength = new Float32Array(MAX_SOURCES);
  private statics: readonly StaticLight[] = [];
  private staticKeys = new Int32Array(0);
  /**
   * The world's lights near the camera focus, as indices into `statics`: a zone of any size only
   * scores the lights within reach instead of walking every lamp in it each frame.
   */
  private near: NearCache = new NearCache(new ChunkBuckets([]));
  /** Indices into `statics` written at the front of the source arrays this frame and the next. */
  private active: readonly number[] = [];
  private emitted = 0;
  private readonly pools: InstancedMesh;
  private readonly poolColor: InstancedBufferAttribute;
  private readonly tmp = new Color();
  /** Scale on every light from LIGHT_CAP, eased so a burst of spells dims the rest smoothly. */
  private crowd = 1;
  /** How many real lights and ground pools the last frame drew, for the perf readout and tests. */
  readonly stats = { real: 0, pools: 0, sources: 0, crowd: 1, poolLight: 0 };
  /** The clock of the last update, which the static flicker follows; world flames read it to match. */
  time = 0;

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new PointLight(0xffffff, 0, 1, DECAY);
      light.castShadow = false;
      this.pool.push(light);
      this.group.add(light);
    }
    const geo = new PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    // Screen blending rather than additive: one pool adds almost what additive would, but a pile
    // of overlapping pools (a volley of fireballs, a ring of torches) saturates softly instead of
    // burning the ground white.
    const mat = new MeshBasicMaterial({
      map: poolTexture(),
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcColorFactor,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.pools = new InstancedMesh(geo, mat, MAX_SOURCES);
    this.pools.instanceMatrix.setUsage(DynamicDrawUsage);
    this.poolColor = new InstancedBufferAttribute(new Float32Array(MAX_SOURCES * 3), 3);
    this.poolColor.setUsage(DynamicDrawUsage);
    this.pools.instanceColor = this.poolColor;
    this.pools.count = 0;
    // Bounds change every frame and the pools cover the view anyway.
    this.pools.frustumCulled = false;
    // Transparent roads and plazas draw at order 0 and ground effects just above; the pools light
    // all of them, so they draw after.
    this.pools.renderOrder = RENDER_ORDER.groundLight;
    this.group.add(this.pools);
  }

  /** The world's own lights; replaces the previous set when the map is rebuilt. */
  setStatic(lights: readonly StaticLight[]): void {
    this.statics = lights;
    this.staticKeys = new Int32Array(this.statics.length);
    for (let i = 0; i < this.staticKeys.length; i++) this.staticKeys[i] = lightKey();
    this.near = new NearCache(new ChunkBuckets(lights));
    // Until the first update gathers the near set, every light counts, as before streaming.
    this.active = lights.map((_, i) => i).slice(0, MAX_SOURCES);
  }

  /**
   * Asks for light this frame. `x, y` are ground coordinates, `height` above the ground; `radius`
   * is how far the light reaches. `priority` puts a source ahead of brighter ones (the hero's party,
   * big spells). `day` is the share it keeps by full daylight outdoors: 0 for night-only light, 1
   * for a spell that glows the same by day.
   */
  emit(key: number, x: number, y: number, height: number, color: number, intensity: number, radius: number, priority = 0, day = 0): void {
    const i = this.active.length + this.emitted;
    if (i >= MAX_SOURCES) return;
    this.write(i, key, x, y, height, color, intensity, radius, priority, day);
    this.emitted++;
  }

  /**
   * Picks the real lights and draws the pools. `dark` is how dark it is where the lights shine, 0
   * full day to 1 night (always 1 underground), from the night factor. `staticGain` scales the
   * world's own lights (the admin's lamp setting) and leaves emitted ones alone.
   */
  update(t: number, dt: number, focusX: number, focusY: number, dark: number, staticGain = 1): void {
    this.time = t;
    const active = this.active;
    const staticCount = active.length;
    for (let i = 0; i < staticCount; i++) {
      const at = active[i] ?? 0;
      const s = this.statics[at];
      if (!s) continue;
      const f = staticFlicker(t, s.x, s.y, s.flicker);
      this.write(i, this.staticKeys[at] ?? -1, s.x, s.y, s.height, s.color, s.intensity * f * staticGain, s.radius, s.priority, s.day);
    }
    const n = staticCount + this.emitted;
    this.emitted = 0;
    this.stats.sources = n;

    // Score every source and keep the top POOL_SIZE by insertion into a short sorted list.
    let bestCount = 0;
    let energy = 0;
    const cull2 = CULL_RANGE * CULL_RANGE;
    for (let i = 0; i < n; i++) {
      const dayShare = this.day[i] ?? 0;
      const lv = (this.intensity[i] ?? 0) * (dayShare + (1 - dayShare) * dark);
      const dx = (this.sx[i] ?? 0) - focusX;
      const dy = (this.sy[i] ?? 0) - focusY;
      const d2 = dx * dx + dy * dy;
      if (lv <= 0.001 || d2 > cull2) {
        this.level[i] = 0;
        this.score[i] = -1;
        continue;
      }
      this.level[i] = lv;
      const r = this.radius[i] ?? 1;
      const h = Math.max(1, this.sh[i] ?? 1);
      const d3 = Math.sqrt(d2 + h * h);
      if (d3 < r) energy += lv * Math.pow(h / d3, DECAY);
      const sc = (this.priority[i] ?? 0) * 1000 + (lv * r * r) / (d2 + r * r);
      this.score[i] = sc;
      let at: number;
      if (bestCount < POOL_SIZE) at = bestCount++;
      else if (sc <= (this.score[this.best[POOL_SIZE - 1] ?? 0] ?? 0)) continue;
      else at = POOL_SIZE - 1;
      while (at > 0 && (this.score[this.best[at - 1] ?? 0] ?? 0) < sc) {
        this.best[at] = this.best[at - 1] ?? 0;
        at--;
      }
      this.best[at] = i;
    }

    const crowdTarget = energy > LIGHT_CAP ? LIGHT_CAP / energy : 1;
    // Dims fast when a burst lands and recovers slowly, so it reads as a flare settling.
    this.crowd += (crowdTarget - this.crowd) * Math.min(1, dt * (crowdTarget < this.crowd ? 10 : 2));
    this.stats.crowd = this.crowd;

    // Slots keep their source while it stays chosen; others fade out on their last settings.
    this.slotChosen.fill(0);
    for (let b = 0; b < bestCount; b++) {
      const i = this.best[b] ?? 0;
      const slot = this.slotKey.indexOf(this.key[i] ?? -1);
      if (slot >= 0) {
        this.slotChosen[slot] = 1;
        this.setLight(slot, i);
      }
    }
    for (let b = 0; b < bestCount; b++) {
      const i = this.best[b] ?? 0;
      const k = this.key[i] ?? -1;
      if (this.slotKey.indexOf(k) >= 0) continue;
      const free = this.slotKey.indexOf(-1);
      // No free slot yet: it waits (drawn as a pool) while a losing light fades out.
      if (free < 0) break;
      this.slotKey[free] = k;
      this.slotWeight[free] = 0;
      this.slotChosen[free] = 1;
      this.setLight(free, i);
    }
    const step = dt / FADE_SECONDS;
    let real = 0;
    for (let s = 0; s < POOL_SIZE; s++) {
      const light = this.pool[s];
      if (!light) continue;
      if (this.slotKey[s] === -1) {
        light.intensity = 0;
        continue;
      }
      const w = Math.min(1, Math.max(0, (this.slotWeight[s] ?? 0) + (this.slotChosen[s] ? step : -step)));
      this.slotWeight[s] = w;
      if (w <= 0 && !this.slotChosen[s]) {
        this.slotKey[s] = -1;
        light.intensity = 0;
        continue;
      }
      light.intensity = (this.slotLevel[s] ?? 0) * w * this.crowd * Math.pow(Math.max(1, light.position.y), DECAY);
      real++;
    }
    this.stats.real = real;

    // Every visible source not fully covered by a real light gets a ground pool for the rest.
    let candidates = 0;
    for (let i = 0; i < n; i++) {
      const lv = this.level[i] ?? 0;
      if (lv <= 0) continue;
      const slot = this.slotKey.indexOf(this.key[i] ?? -1);
      const share = 1 - (slot >= 0 ? (this.slotWeight[slot] ?? 0) : 0);
      const strength = lv * share * POOL_GAIN * this.crowd;
      if (strength < 0.002) continue;
      this.poolStrength[candidates] = strength;
      this.poolSource[candidates++] = i;
    }
    this.spreadSpellPools(candidates, staticCount);
    const m = this.pools.instanceMatrix.array;
    const c = this.poolColor.array;
    let pools = 0;
    let poolLight = 0;
    for (let p = 0; p < candidates; p++) {
      const i = this.poolSource[p] ?? 0;
      const strength = this.poolStrength[p] ?? 0;
      if (strength < 0.002) continue;
      poolLight += strength;
      const r = (this.radius[i] ?? 1) * POOL_REACH;
      const o = pools * 16;
      m[o] = r;
      m[o + 1] = 0;
      m[o + 2] = 0;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = 1;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = 0;
      m[o + 9] = 0;
      m[o + 10] = r;
      m[o + 11] = 0;
      m[o + 12] = this.sx[i] ?? 0;
      m[o + 13] = 1.6;
      m[o + 14] = this.sy[i] ?? 0;
      m[o + 15] = 1;
      this.tmp.setHex(this.color[i] ?? 0xffffff);
      c[pools * 3] = this.tmp.r * strength;
      c[pools * 3 + 1] = this.tmp.g * strength;
      c[pools * 3 + 2] = this.tmp.b * strength;
      pools++;
    }
    this.pools.count = pools;
    this.pools.instanceMatrix.needsUpdate = true;
    this.poolColor.needsUpdate = true;
    this.stats.pools = pools;
    this.stats.poolLight = poolLight;
    // Gathered after this frame's sources are used: the next frame's emits are written after the
    // statics, so the count must not change between an emit and the update that reads it.
    const near = this.near.update(focusX, focusY, CULL_RANGE);
    this.active = near.length > MAX_SOURCES ? near.slice(0, MAX_SOURCES) : near;
  }

  /**
   * A crowd of spells piles up a pool each, and a dozen overlapping pools washed the ground a flat
   * pastel. Each spell pool is divided by the square root of how many spell pools overlap it, so a
   * cluster glows a little more than one pool instead of a dozen times more. The world's own lights
   * (the first `statics` sources) keep their pools as they are.
   */
  private spreadSpellPools(count: number, statics: number): void {
    for (let a = 0; a < count; a++) {
      const i = this.poolSource[a] ?? 0;
      if (i < statics) continue;
      const ax = this.sx[i] ?? 0;
      const ay = this.sy[i] ?? 0;
      const ar = (this.radius[i] ?? 1) * POOL_REACH;
      let overlap = 1;
      for (let b = 0; b < count; b++) {
        const j = this.poolSource[b] ?? 0;
        if (b === a || j < statics) continue;
        const dx = (this.sx[j] ?? 0) - ax;
        const dy = (this.sy[j] ?? 0) - ay;
        const reach = 0.5 * (ar + (this.radius[j] ?? 1) * POOL_REACH);
        if (dx * dx + dy * dy < reach * reach) overlap++;
      }
      if (overlap > 1) this.poolStrength[a] = (this.poolStrength[a] ?? 0) / Math.sqrt(overlap);
    }
  }

  /** The key holding each pool slot, -1 for free; for tests. */
  slotKeys(): readonly number[] {
    return Array.from(this.slotKey);
  }

  /** Forgets every source, for a new scene. The pool objects are kept and reused. */
  reset(): void {
    this.setStatic([]);
    this.emitted = 0;
    this.slotKey.fill(-1);
    this.slotWeight.fill(0);
    this.crowd = 1;
    for (const light of this.pool) light.intensity = 0;
    this.pools.count = 0;
  }

  private write(i: number, key: number, x: number, y: number, height: number, color: number, intensity: number, radius: number, priority: number, day: number): void {
    this.key[i] = key;
    this.sx[i] = x;
    this.sy[i] = y;
    this.sh[i] = height;
    this.color[i] = color;
    this.intensity[i] = intensity;
    this.radius[i] = radius;
    this.priority[i] = priority;
    this.day[i] = day;
  }

  private setLight(slot: number, i: number): void {
    const light = this.pool[slot];
    if (!light) return;
    light.position.set(this.sx[i] ?? 0, this.sh[i] ?? 0, this.sy[i] ?? 0);
    light.color.setHex(this.color[i] ?? 0xffffff);
    light.distance = this.radius[i] ?? 1;
    this.slotLevel[slot] = this.level[i] ?? 0;
  }
}

/** A soft round falloff, brightest in the middle; data rather than canvas so it builds anywhere. */
function poolTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const a = Math.max(0, 1 - d);
      const v = Math.round(255 * a * a * (3 - 2 * a) * a);
      const o = (y * size + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** The budget of the scene on screen. Only one world scene exists at a time. */
export const sceneLights = new LightBudget();

/** Shorthand for `sceneLights.emit`: ask for light this frame. See `LightBudget.emit`. */
export function emitLight(key: number, x: number, y: number, height: number, color: number, intensity: number, radius: number, priority = 0, day = 0): void {
  sceneLights.emit(key, x, y, height, color, intensity, radius, priority, day);
}
