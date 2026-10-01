import { ENEMIES, ENEMY_TYPE_IDS, loadMap, type EnemyTypeId, type EntitySnap } from '@rune/shared';
import { ENEMY_ASSETS } from '../../render/characters.js';
import { EntityRenderer, type RenderItem } from '../../render/entities.js';
import { WorldScene } from '../../render/scene.js';

/** Every monster type the game draws from code: no model file in the registry. */
export const PROCEDURAL_ENEMIES: readonly EnemyTypeId[] = ENEMY_TYPE_IDS.filter((id) => ENEMY_ASSETS[id] === undefined);

export interface BenchResult {
  monsters: number;
  frames: number;
  drawCalls: number;
  triangles: number;
  /** Mean CPU milliseconds in EntityRenderer.render per frame. */
  entitiesMs: number;
  /** Mean CPU milliseconds in WorldScene.render (scene graph update and GL submission). */
  renderMs: number;
  /** Mean wall milliseconds between frames. */
  frameMs: number;
  /** Mean JS heap growth per frame in bytes, counting only rises (drops are collections). Chrome only. */
  heapPerFrame: number | null;
}

interface Walker {
  item: RenderItem;
  snap: Extract<EntitySnap, { k: 'enemy' }>;
  cx: number;
  cy: number;
  phase: number;
  speed: number;
  /** 0 idles, 1 walks a circle, 2 walks and runs in bursts. */
  mode: number;
}

interface ChromeMemory {
  usedJSHeapSize: number;
}

function heapNow(): number | null {
  const perf: Performance & { memory?: ChromeMemory } = performance;
  return perf.memory ? perf.memory.usedJSHeapSize : null;
}

const SPACING_X = 72;
const SPACING_Y = 48;

/**
 * A fixed scene for measuring procedural monsters: the real EntityRenderer and WorldScene on a
 * wilds map, `count` monsters of mixed types walking circles, attacking and taking hits on a
 * schedule. The snapshots are built once and moved in place, so the bench itself allocates nothing
 * per frame and the heap numbers belong to the renderer.
 */
export class RigBench {
  readonly world: WorldScene;
  private readonly entities: EntityRenderer;
  private readonly walkers: Walker[] = [];
  private readonly items: RenderItem[] = [];
  private readonly centre: { x: number; y: number };
  private raf = 0;
  private last = performance.now();
  private time = 0;
  private sample: { frames: number; entities: number; render: number; wall: number; heap: number; calls: number; tris: number; lastHeap: number | null; done: (r: BenchResult) => void; want: number } | null = null;

  constructor(host: HTMLElement, count: number, spread: boolean) {
    const loaded = loadMap({ kind: 'wilds', seed: 7 });
    const map = loaded.def;
    this.world = new WorldScene(host, map, loaded.zone);
    this.entities = new EntityRenderer(this.world.scene, this.world.camera);
    this.centre = { x: map.width / 2, y: map.height / 2 };
    this.populate(count, spread);
    this.raf = requestAnimationFrame(this.frame);
  }

  private populate(count: number, spread: boolean): void {
    const cols = 12;
    for (let i = 0; i < count; i++) {
      const type = PROCEDURAL_ENEMIES[i % PROCEDURAL_ENEMIES.length] ?? 'plague_rat';
      const def = ENEMIES[type];
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Spread mode puts every other monster a screen away, to measure off-screen cost.
      const far = spread && i % 2 === 1 ? 1400 : 0;
      const cx = this.centre.x + (col - (cols - 1) / 2) * SPACING_X + far;
      const cy = this.centre.y + (row - 4.5) * SPACING_Y;
      const snap: Extract<EntitySnap, { k: 'enemy' }> = {
        k: 'enemy',
        id: 1000 + i,
        x: cx,
        y: cy,
        r: def.radius,
        et: type,
        rare: false,
        dormant: false,
        boss: false,
        lvl: 1,
        ax: [],
        life: 100,
        maxLife: 100,
        st: 0,
        a: 0,
      };
      const item: RenderItem = { key: `s${snap.id}`, snap, x: cx, y: cy, isSelf: false, isAlly: false };
      this.walkers.push({ item, snap, cx, cy, phase: i * 0.7, speed: def.moveSpeed, mode: def.moveSpeed === 0 ? 0 : i % 5 === 0 ? 0 : i % 3 === 0 ? 2 : 1 });
      this.items.push(item);
    }
  }

  private step(dt: number): void {
    this.time += dt;
    const t = this.time;
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i];
      if (!w) continue;
      if (w.mode !== 0) {
        const burst = w.mode === 2 && Math.sin(t * 0.7 + w.phase) > 0.3 ? 1.6 : 1;
        // A circle of radius 18 walked at the monster's own speed.
        w.phase += ((w.speed * burst) / 18) * dt;
        w.item.x = w.cx + Math.cos(w.phase) * 18;
        w.item.y = w.cy + Math.sin(w.phase) * 18;
        w.snap.a = w.phase + Math.PI / 2;
      }
      w.snap.x = w.item.x;
      w.snap.y = w.item.y;
      // Staggered so a few attack and flinch every second, like a fight.
      const beat = Math.floor(t * 2 + i * 0.37);
      if (beat !== Math.floor((t - dt) * 2 + i * 0.37)) {
        if (beat % 5 === 0) this.entities.attack(w.item.key);
        else if (beat % 7 === 0) this.entities.flash(w.item.key);
      }
    }
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const wall = now - this.last;
    const dt = Math.min(0.1, wall / 1000);
    this.last = now;
    this.step(dt);
    const t0 = performance.now();
    this.entities.render(this.items, dt);
    const t1 = performance.now();
    this.world.follow(this.centre.x, this.centre.y, dt);
    this.world.render();
    const t2 = performance.now();
    const s = this.sample;
    if (!s) return;
    const info = this.world.renderer.info.render;
    s.frames++;
    s.entities += t1 - t0;
    s.render += t2 - t1;
    s.wall += wall;
    s.calls += info.calls;
    s.tris += info.triangles;
    const heap = heapNow();
    if (heap !== null && s.lastHeap !== null && heap > s.lastHeap) s.heap += heap - s.lastHeap;
    s.lastHeap = heap;
    if (s.frames >= s.want) {
      this.sample = null;
      s.done({
        monsters: this.walkers.length,
        frames: s.frames,
        drawCalls: Math.round(s.calls / s.frames),
        triangles: Math.round(s.tris / s.frames),
        entitiesMs: s.entities / s.frames,
        renderMs: s.render / s.frames,
        frameMs: s.wall / s.frames,
        heapPerFrame: heap === null ? null : Math.round(s.heap / s.frames),
      });
    }
  };

  /** Averages the next `frames` frames. */
  measure(frames: number): Promise<BenchResult> {
    return new Promise((done) => {
      this.sample = { frames: 0, entities: 0, render: 0, wall: 0, heap: 0, calls: 0, tris: 0, lastHeap: heapNow(), done, want: frames };
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.entities.render([], 0);
    this.world.dispose();
  }
}
