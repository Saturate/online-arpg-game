import { BufferGeometry, Group, InstancedMesh, Mesh, type Object3D } from 'three';
import { chunkAction, chunkCoord, chunkKey, chunkRect, CHUNK_SIZE, growRect, rectDistance, type Rect, type StreamRadii } from './chunks.js';
import { PropBatch, placementReach, type Placement, type Placer } from './propBatch.js';

/**
 * Static content never moves, so its matrices are computed once and three skips them every frame
 * after (it otherwise recomposes and remultiplies every object's matrix each frame).
 */
function freeze(root: Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/** Chunks outside the view but inside the build radius built per frame, at most. */
const PREFETCH_PER_FRAME = 1;

/** Per-frame animation of something in the world: water, portals, fires, canopy fading around the player. */
export type Anim = (t: number, px: number, py: number) => void;

/** Builds part of a chunk's meshes into its group, and adds the animations they need while drawn. */
export type ChunkBuilder = (group: Group, anims: Anim[]) => void;

interface Chunk {
  /** The chunk's own square grown to cover everything anchored in it, for its distance to the camera. */
  bounds: Rect;
  batch: PropBatch;
  builders: ChunkBuilder[];
  /** Small landmarks built once at load (portals, fires): attached while the chunk is built, never released. */
  persistent: { object: Object3D; anim: Anim | null }[];
  group: Group | null;
  /** The chunk's model batch, kept under `props` rather than its own group (see `props`). */
  props: Group | null;
  anims: Anim[];
  visible: boolean;
  /** The model batch still loading, or null. */
  pending: Promise<void> | null;
  /** Bumped on release, so a batch that finishes loading after it adds nothing. */
  generation: number;
  /** Distance to the focus at the last update, minus the view's footprint: negative when in view. */
  inView: number;
}

/**
 * The static world cut into chunks (chunks.ts has the rules). Content is registered at load as
 * data: prop placements, builder functions and a few prebuilt landmarks, each anchored at the chunk
 * under its position. Meshes exist only for chunks near the camera: built ahead of the view, drawn
 * when close, hidden past a wider radius and released past a wider one still, so the cost of the
 * world follows what is near the camera rather than the zone's size.
 */
export class WorldChunks implements Placer {
  readonly group = new Group();
  /** Chunks' own meshes: ground, trees, landmarks. Mostly untextured. */
  private readonly base = new Group();
  /**
   * Every chunk's model batches, after all the chunks' own meshes. The shadow pass draws in scene
   * graph order through one shared depth material, and each switch between a textured model and an
   * untextured mesh changes that material's program; chunk after chunk of interleaved switches
   * cost about 45 KB of garbage a frame in town.
   */
  private readonly props = new Group();
  /** Geometry shared between chunks (tree variants, decor shapes): never disposed with a chunk. */
  readonly shared = new WeakSet<BufferGeometry>();
  /**
   * `late` counts pop-in: a chunk drawn, or its models arriving, while it was already inside the
   * view's footprint, after the first frame of the zone.
   */
  readonly stats = { chunks: 0, built: 0, visible: 0, builds: 0, releases: 0, late: 0 };
  private readonly chunks = new Map<number, Chunk>();
  private disposed = false;
  private first = true;
  /** Chunks loading at the zone's first frame: their models arriving is the zone load, not pop-in. */
  private readonly initial = new Set<Chunk>();
  private resolveReady: () => void = () => {};
  /** Resolves once the chunks in view at the first update have their models. */
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(private readonly size = CHUNK_SIZE) {
    this.group.add(this.base, this.props);
  }

  private chunkAt(x: number, y: number, reach: number): Chunk {
    const cx = chunkCoord(x, this.size);
    const cy = chunkCoord(y, this.size);
    const key = chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (!c) {
      c = { bounds: chunkRect(cx, cy, this.size), batch: new PropBatch(), builders: [], persistent: [], group: null, props: null, anims: [], visible: false, pending: null, generation: 0, inView: Infinity };
      this.chunks.set(key, c);
      this.stats.chunks = this.chunks.size;
    }
    if (reach > 0) growRect(c.bounds, x, y, reach);
    return c;
  }

  add(assetId: string, p: Placement): void {
    this.chunkAt(p.x, p.y, placementReach(assetId, p)).batch.add(assetId, p);
  }

  /** Content built when its chunk comes near and released with it; `reach` is how far it spreads from (x, y). */
  build(x: number, y: number, reach: number, fn: ChunkBuilder): void {
    this.chunkAt(x, y, reach).builders.push(fn);
  }

  /** Grows the bounds of the chunk under (x, y) to cover a circle, for content registered by a shared builder. */
  reach(x: number, y: number, reach: number): void {
    this.chunkAt(x, y, reach);
  }

  /** A prebuilt object kept for the world's life, drawn and animated only while its chunk is. */
  attach(x: number, y: number, reach: number, object: Object3D, anim: Anim | null = null): void {
    this.chunkAt(x, y, reach).persistent.push({ object, anim });
  }

  update(t: number, px: number, py: number, radii: StreamRadii): void {
    if (this.disposed) return;
    let built = 0;
    let visible = 0;
    let prefetch = PREFETCH_PER_FRAME;
    const first = this.first;
    this.first = false;
    const loading: Promise<void>[] | null = first ? [] : null;
    for (const c of this.chunks.values()) {
      const d = rectDistance(c.bounds, px, py);
      c.inView = d - radii.view;
      let action = chunkAction(c.group !== null, c.visible, d, radii);
      // A chunk about to be seen is built at once; the ring ahead of the view is built a few a
      // frame, so arriving in a zone does not build everything within the prefetch radius in one go.
      if (action === 'build' && (d <= radii.show || prefetch-- > 0)) {
        this.buildChunk(c);
        action = chunkAction(true, false, d, radii);
      }
      if (action === 'release') this.release(c);
      else if (action === 'show' || action === 'hide') {
        c.visible = action === 'show';
        if (c.visible && !first && c.inView <= 0) this.stats.late++;
        // Out of the scene graph rather than invisible: three still walks invisible objects every
        // frame to update their matrices.
        if (c.group && c.props && c.visible) {
          this.base.add(c.group);
          this.props.add(c.props);
        } else if (c.group && c.props) {
          this.base.remove(c.group);
          this.props.remove(c.props);
        }
      }
      if (c.group) built++;
      if (!c.visible) continue;
      visible++;
      if (loading && c.pending) {
        loading.push(c.pending);
        this.initial.add(c);
      }
      for (const a of c.anims) a(t, px, py);
    }
    this.stats.built = built;
    this.stats.visible = visible;
    if (loading) void Promise.all(loading).then(() => this.resolveReady());
  }

  private buildChunk(c: Chunk): void {
    const group = new Group();
    const anims: Anim[] = [];
    for (const b of c.builders) b(group, anims);
    freeze(group);
    for (const p of c.persistent) {
      group.add(p.object);
      if (p.anim) anims.push(p.anim);
    }
    c.group = group;
    // The batch adds its meshes to a group of its own, frozen once they are in.
    const props = new Group();
    c.props = props;
    c.anims = anims;
    c.visible = false;
    this.stats.builds++;
    if (c.batch.size > 0) {
      const generation = c.generation;
      const alive = () => !this.disposed && c.generation === generation;
      const pending = c.batch.build(props, () => !alive()).then(() => {
        if (!alive()) return;
        freeze(props);
        c.pending = null;
        if (c.visible && !this.first && c.inView <= 0 && !this.initial.has(c)) this.stats.late++;
      });
      c.pending = pending;
    }
  }

  private release(c: Chunk): void {
    const group = c.group;
    if (!group) return;
    for (const p of c.persistent) group.remove(p.object);
    this.base.remove(group);
    this.disposeTree(group);
    if (c.props) {
      this.props.remove(c.props);
      this.disposeTree(c.props);
    }
    c.group = null;
    c.props = null;
    c.anims = [];
    c.visible = false;
    c.pending = null;
    c.generation++;
    this.stats.releases++;
  }

  /** Frees the GPU buffers a chunk owns: instance buffers and geometry nobody else uses. */
  private disposeTree(root: Object3D): void {
    root.traverse((o) => {
      if (o instanceof InstancedMesh) o.dispose();
      else if (o instanceof Mesh && o.geometry instanceof BufferGeometry && !this.shared.has(o.geometry)) o.geometry.dispose();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chunks.values()) {
      this.release(c);
      for (const p of c.persistent) this.disposeTree(p.object);
    }
    this.resolveReady();
  }
}
