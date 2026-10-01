import { HOME_ZONE, scaledZone, type TownLayout, type WorldMap, type ZoneWorld } from '@rune/shared';
import { BufferAttribute, InstancedMesh, InterleavedBufferAttribute, Mesh, Texture, type Object3D } from 'three';
import { Effects } from '../../render/fx.js';
import { Minimap } from '../../render/minimap.js';
import { WorldScene } from '../../render/scene.js';

export interface WorldBenchScene {
  id: string;
  label: string;
  /** Generated afresh on every run, so the build time includes generating the zone's plan. */
  map: (town: TownLayout | undefined) => { def: WorldMap; zone: ZoneWorld | null };
  /** The walk, as points the camera moves between at WALK_SPEED. */
  path: (def: WorldMap) => { x: number; y: number }[];
}

/** Faster than a hero (220), so anything that would pop in on a real walk shows up here first. */
const WALK_SPEED = 360;

const SCENES: readonly WorldBenchScene[] = [
  {
    id: 'town',
    label: 'Home zone: across the town square and out of the east gate',
    map: (town) => scaledZone(HOME_ZONE, 7, 1, town),
    path: (def) => [
      { x: def.spawn.x, y: def.spawn.y },
      { x: def.spawn.x + 900, y: def.spawn.y - 300 },
      { x: def.spawn.x + 2600, y: def.spawn.y },
    ],
  },
  {
    id: 'wilds',
    label: 'Thornwood (forest zone): spawn to the far east edge',
    map: () => scaledZone('thornwood', 7, 1),
    path: (def) => [
      { x: def.spawn.x, y: def.spawn.y },
      { x: def.width * 0.5, y: def.height * 0.3 },
      { x: def.width - 300, y: def.height * 0.6 },
    ],
  },
  {
    id: 'big',
    label: 'Thornwood at twice the width and height (4x the area), never live',
    map: () => scaledZone('thornwood', 7, 2),
    path: (def) => [
      { x: def.spawn.x, y: def.spawn.y },
      { x: def.width * 0.5, y: def.height * 0.2 },
      { x: def.width - 300, y: def.height * 0.8 },
    ],
  },
  {
    id: 'huge',
    label: 'Thornwood at three times the width and height (9x the area), never live',
    map: () => scaledZone('thornwood', 7, 3),
    path: (def) => [
      { x: def.spawn.x, y: def.spawn.y },
      { x: def.width * 0.5, y: def.height * 0.2 },
      { x: def.width - 300, y: def.height * 0.8 },
    ],
  },
];

export const WORLD_BENCH_SCENES = SCENES;

export interface WorldBenchResult {
  scene: string;
  mapSize: string;
  /** Milliseconds to generate the zone's plan and build the WorldScene (synchronous part). */
  buildMs: number;
  /** The plan's part of `buildMs`. */
  genMs: number;
  /** Milliseconds from starting the build to the end of the first frame drawn with the models around the start (shader compiles included). */
  readyMs: number;
  frames: number;
  drawCalls: number;
  maxDrawCalls: number;
  triangles: number;
  /** Mean CPU milliseconds per frame in WorldScene.follow, the effects update and render. */
  renderMs: number;
  /** 95th percentile of the same. */
  renderP95: number;
  /** Mean JS heap growth per frame in bytes, counting only rises. Chrome only. */
  heapPerFrame: number | null;
  /** renderer.info.memory at the end of the walk, and the most seen during it. */
  geometries: number;
  maxGeometries: number;
  textures: number;
  /** Bytes of vertex, index and instance buffers held by the scene graph at the end, and the most during the walk. */
  bufferBytes: number;
  maxBufferBytes: number;
  /** Meshes in the scene graph at the end of the walk. */
  meshes: number;
  /** World chunks: total, built and drawn at the end, and builds and releases over the load and walk. */
  chunks: string;
}

interface ChromeMemory {
  usedJSHeapSize: number;
}

function heapNow(): number | null {
  const perf: Performance & { memory?: ChromeMemory } = performance;
  return perf.memory ? perf.memory.usedJSHeapSize : null;
}

/** Bytes of GPU-bound buffers reachable from `root`, each buffer counted once. */
export function sceneBuffers(root: Object3D): { bytes: number; meshes: number; textures: number } {
  const seen = new Set<unknown>();
  const textures = new Set<Texture>();
  let bytes = 0;
  let meshes = 0;
  const add = (a: BufferAttribute | InterleavedBufferAttribute | null | undefined): void => {
    if (!a) return;
    const key = a instanceof InterleavedBufferAttribute ? a.data : a;
    if (seen.has(key)) return;
    seen.add(key);
    bytes += a instanceof InterleavedBufferAttribute ? a.data.array.byteLength : a.array.byteLength;
  };
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    meshes++;
    const g = o.geometry;
    for (const a of Object.values(g.attributes)) if (a instanceof BufferAttribute || a instanceof InterleavedBufferAttribute) add(a);
    add(g.index);
    if (o instanceof InstancedMesh) {
      add(o.instanceMatrix);
      add(o.instanceColor);
    }
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const v of Object.values(m)) if (v instanceof Texture) textures.add(v);
    }
  });
  return { bytes, meshes, textures: textures.size };
}

/**
 * Measures the static world: a WorldScene and the effects system (for the world fires and the light
 * budget), with the camera walked along a path over the map, with no monsters or players. Built
 * for world streaming: draw calls, render CPU, buffers held and the load time before and after.
 */
export class WorldBench {
  readonly world: WorldScene;
  readonly fx: Effects;
  readonly minimap: Minimap | null;
  readonly scene: WorldBenchScene;
  readonly def: WorldMap;
  readonly zone: ZoneWorld | null;
  /** Milliseconds generating the zone's plan, part of `buildMs`. */
  readonly genMs: number;
  private readonly path: { x: number; y: number }[];
  private raf = 0;
  private last = performance.now();
  private readonly started = performance.now();
  readonly buildMs: number;
  /** Milliseconds from starting the build to the end of the first frame drawn with the models around the start. */
  readyMs: number | null = null;
  private loaded = false;
  private t0 = 0;
  /** Distance walked along the path; the camera stays at the start until a measure begins. */
  private walked = 0;
  private walking = false;
  private standFrames = 0;
  private sample: {
    frames: number;
    render: number[];
    calls: number;
    maxCalls: number;
    tris: number;
    heap: number;
    lastHeap: number | null;
    maxGeometries: number;
    maxBytes: number;
    done: (r: WorldBenchResult) => void;
  } | null = null;

  constructor(host: HTMLElement, fxLayer: HTMLElement, sceneId: string, town?: TownLayout, minimap?: HTMLCanvasElement) {
    this.scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0] ?? { id: 'none', label: 'none', map: () => scaledZone('thornwood', 7, 1), path: () => [] };
    const t0 = performance.now();
    const map = this.scene.map(town);
    this.genMs = performance.now() - t0;
    this.def = map.def;
    this.zone = map.zone;
    this.path = this.scene.path(this.def);
    this.world = new WorldScene(host, this.def, this.zone);
    this.fx = new Effects(this.world.scene, this.world, fxLayer);
    this.buildMs = performance.now() - t0;
    this.minimap = minimap ? new Minimap(minimap, this.def, `bench:${this.scene.id}:${performance.now()}`, this.zone) : null;
    // The first frame starts the chunks around the start; ready resolves once their models are in.
    this.frame(performance.now());
    this.t0 = t0;
    void this.world.ready.then(() => {
      this.loaded = true;
    });
  }

  /** Where the camera is after walking `d` along the path, and whether the path has ended. */
  private at(d: number): { x: number; y: number; end: boolean } {
    let left = d;
    for (let i = 0; i + 1 < this.path.length; i++) {
      const a = this.path[i];
      const b = this.path[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (left <= len) {
        const t = len > 0 ? left / len : 0;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, end: false };
      }
      left -= len;
    }
    const lastPoint = this.path[this.path.length - 1] ?? { x: 0, y: 0 };
    return { ...lastPoint, end: true };
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const wall = now - this.last;
    const dt = Math.min(0.1, wall / 1000);
    this.last = now;
    if (this.walking) this.walked += WALK_SPEED * dt;
    const pos = this.at(this.walked);
    const t0 = performance.now();
    this.fx.update(dt);
    this.world.follow(pos.x, pos.y, dt);
    this.world.render();
    const t1 = performance.now();
    if (this.loaded && this.readyMs === null) this.readyMs = t1 - this.t0;
    // Outside the timed part, like the game, which also redraws its minimap a few times a second.
    if (this.minimap && Math.floor(now / 100) !== Math.floor((now - wall) / 100)) this.minimap.update(pos.x, pos.y, [], -1);

    const s = this.sample;
    if (!s) return;
    const info = this.world.renderer.info;
    s.frames++;
    s.render.push(t1 - t0);
    s.calls += info.render.calls;
    s.maxCalls = Math.max(s.maxCalls, info.render.calls);
    s.tris += info.render.triangles;
    s.maxGeometries = Math.max(s.maxGeometries, info.memory.geometries);
    // Walking the scene graph is not free; every 20 frames is plenty to catch the peak.
    if (s.frames % 20 === 0) s.maxBytes = Math.max(s.maxBytes, sceneBuffers(this.world.scene).bytes);
    const heap = heapNow();
    if (heap !== null && s.lastHeap !== null && heap > s.lastHeap) s.heap += heap - s.lastHeap;
    s.lastHeap = heap;
    if (pos.end || (this.standFrames > 0 && s.frames >= this.standFrames)) {
      this.sample = null;
      this.walking = false;
      const held = sceneBuffers(this.world.scene);
      const sorted = [...s.render].sort((a, b) => a - b);
      s.done({
        scene: this.scene.id,
        mapSize: `${this.def.width}x${this.def.height}`,
        buildMs: this.buildMs,
        genMs: this.genMs,
        readyMs: this.readyMs ?? -1,
        frames: s.frames,
        drawCalls: Math.round(s.calls / s.frames),
        maxDrawCalls: s.maxCalls,
        triangles: Math.round(s.tris / s.frames),
        renderMs: s.render.reduce((a, b) => a + b, 0) / s.frames,
        renderP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        heapPerFrame: heap === null ? null : Math.round(s.heap / s.frames),
        geometries: info.memory.geometries,
        maxGeometries: s.maxGeometries,
        textures: info.memory.textures,
        bufferBytes: held.bytes,
        maxBufferBytes: Math.max(s.maxBytes, held.bytes),
        meshes: held.meshes,
        chunks: (() => {
          const c = this.world.chunkStats;
          const zone = this.zone ? `, ${c.filled} of ${this.zone.cols * this.zone.rows} zone chunks registered, ${this.zone.generatedChunks} generated` : '';
          return `${c.chunks} total, ${c.built} built, ${c.visible} drawn, ${c.builds} builds, ${c.releases} releases, ${c.late} late${zone}`;
        })(),
      });
    }
  };

  /**
   * Walks the path from the start once and reports what it cost; with `standFrames`, stands at the
   * start for that many frames instead, for the steady cost with no chunk building.
   */
  measure(standFrames = 0): Promise<WorldBenchResult> {
    this.walked = 0;
    this.walking = standFrames === 0;
    this.standFrames = standFrames;
    return new Promise((done) => {
      this.sample = { frames: 0, render: [], calls: 0, maxCalls: 0, tris: 0, heap: 0, lastHeap: heapNow(), maxGeometries: 0, maxBytes: 0, done };
    });
  }

  /** Puts the camera `d` units along the path without measuring, for screenshots. */
  seek(d: number): void {
    this.walked = d;
  }

  /** Milliseconds since the bench was created, for scripts waiting on the load. */
  get age(): number {
    return performance.now() - this.started;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.fx.dispose();
    this.world.dispose();
  }
}
