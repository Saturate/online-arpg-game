import { Box3, BufferGeometry, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type Group, type Material } from 'three';
import { assetById, instantiate } from './assets.js';
import { withOccluderFade } from './occluderFade.js';

/** How a placement is sized: to a footprint radius, a box, a length along its x axis, or a height. */
export type Fit = { radius: number } | { box: { w: number; d: number } } | { length: number } | { height: number } | { scale: number };

export interface Placement {
  x: number;
  y: number;
  angle: number;
  fit: Fit;
  /** Extra uniform scale on top of the fit, for variety. */
  jitter?: number;
  /** Tall things (buildings, walls): cut a see-through hole when they stand between camera and hero. */
  fade?: boolean;
}

/** A rectangle of the texture atlas, in UV units. */
export interface UvRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * The fire gradient of the KayKit dungeon atlas. The lit torch and candle model their flame as
 * solid triangles painted from it; the world fires draw real flames there instead (props.ts
 * FLAMES), so those triangles are cut out.
 */
const KAYKIT_FIRE: UvRect = { u0: 0.9, u1: 0.96, v0: 0.5, v1: 0.7 };
const BAKED_FLAMES: Record<string, UvRect> = { dungeon_torch_lit: KAYKIT_FIRE, dungeon_candle_lit: KAYKIT_FIRE };

/**
 * A copy of `geometry` without the triangles whose UV centre falls inside `rect`. Attributes are
 * shared with the source; only the index is new. Returns the source when nothing matches.
 */
export function withoutUvRect(geometry: BufferGeometry, rect: UvRect): BufferGeometry {
  const uv = geometry.getAttribute('uv');
  if (!uv) return geometry;
  const index = geometry.getIndex();
  const count = index ? index.count : geometry.getAttribute('position').count;
  const at = (i: number): number => (index ? index.getX(i) : i);
  const kept: number[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
    const v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
    if (u >= rect.u0 && u <= rect.u1 && v >= rect.v0 && v <= rect.v1) continue;
    kept.push(a, b, c);
  }
  if (kept.length === count) return geometry;
  const out = new BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) out.setAttribute(name, attr);
  out.setIndex(kept);
  out.computeBoundingSphere();
  return out;
}

const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();
const tmpMatrix = new Matrix4();
const up = new Vector3(0, 1, 0);

/** Anything that takes prop placements: one batch, or the world's chunks, which hand each to its chunk's batch. */
export interface Placer {
  add(assetId: string, p: Placement): void;
}

interface AssetParts {
  size: Vector3;
  meshes: { geometry: BufferGeometry; material: Material; local: Matrix4 }[];
}

/**
 * The meshes of each asset as a batch draws them, measured once. Chunks build and rebuild their
 * batches as the camera comes and goes; a rebuild must not clone and measure the model again.
 */
const partsCache = new Map<string, Promise<AssetParts | null>>();

function assetParts(id: string): Promise<AssetParts | null> {
  let p = partsCache.get(id);
  if (!p) {
    const def = assetById(id);
    p = def
      ? instantiate(def).then(
          (inst) => {
            inst.root.updateMatrixWorld(true);
            const size = new Box3().setFromObject(inst.root).getSize(new Vector3());
            const meshes: AssetParts['meshes'] = [];
            const baked = BAKED_FLAMES[id];
            inst.root.traverse((o) => {
              if (!(o instanceof Mesh) || !o.visible || Array.isArray(o.material)) return;
              meshes.push({ geometry: baked ? withoutUvRect(o.geometry, baked) : o.geometry, material: o.material, local: o.matrixWorld.clone() });
            });
            return { size, meshes };
          },
          () => null,
        )
      : Promise.resolve(null);
    partsCache.set(id, p);
  }
  return p;
}

/** One see-through copy per source material, shared by every chunk's batch of that asset. */
const fadeCopies = new WeakMap<Material, Material>();

function fadeCopy(m: Material): Material {
  let c = fadeCopies.get(m);
  if (!c) {
    // A copy so the same asset elsewhere (the asset viewer, decor) keeps its normal material.
    c = withOccluderFade(m.clone());
    fadeCopies.set(m, c);
  }
  return c;
}

/**
 * Collects prop placements per asset and turns each asset into one InstancedMesh per sub-mesh
 * once its file has loaded. Hundreds of barrels or graves cost a handful of draw calls. The world
 * keeps one batch per chunk (see chunks.ts), so what is off screen can be skipped and released.
 */
export class PropBatch implements Placer {
  private readonly placements = new Map<string, Placement[]>();

  add(assetId: string, p: Placement): void {
    const list = this.placements.get(assetId) ?? [];
    list.push(p);
    this.placements.set(assetId, list);
  }

  get size(): number {
    return this.placements.size;
  }

  /**
   * Loads every asset used and adds the instanced meshes to `group`. Missing assets are skipped.
   * The meshes share their geometry and material with every other batch of the asset; only their
   * instance buffers are their own (InstancedMesh.dispose releases them).
   */
  async build(group: Group, isCancelled: () => boolean): Promise<void> {
    await Promise.all(
      [...this.placements].map(async ([id, list]) => {
        const parts = await assetParts(id);
        if (!parts || isCancelled()) return;
        const { size, meshes } = parts;
        // Segment assets are not all modelled along x; turn them so their long side follows the line.
        const alongZ = size.z > size.x;
        const fade = list.some((p) => p.fade === true);
        for (const m of meshes) {
          const im = new InstancedMesh(m.geometry, fade ? fadeCopy(m.material) : m.material, list.length);
          list.forEach((p, i) => {
            const s = fitScale(p.fit, size) * (p.jitter ?? 1);
            tmpPos.set(p.x, 0, p.y);
            tmpQuat.setFromAxisAngle(up, -p.angle + ('length' in p.fit && alongZ ? Math.PI / 2 : 0));
            tmpScale.setScalar(s);
            im.setMatrixAt(i, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale).multiply(m.local));
          });
          im.castShadow = true;
          im.receiveShadow = true;
          im.computeBoundingSphere();
          group.add(im);
        }
      }),
    );
  }
}

/** How far a placement reaches from its anchor on the ground, roughly, for its chunk's bounds. */
export function placementReach(assetId: string, p: Placement): number {
  const f = p.fit;
  const k = p.jitter ?? 1;
  if ('radius' in f) return f.radius * 1.3 * k;
  if ('box' in f) return (Math.hypot(f.box.w, f.box.d) / 2) * k;
  if ('length' in f) return (f.length / 2) * k;
  if ('height' in f) return f.height * 0.6 * k;
  return (assetById(assetId)?.height ?? 60) * f.scale * k;
}

function fitScale(fit: Fit, size: Vector3): number {
  if ('scale' in fit) return fit.scale;
  if ('height' in fit) return size.y > 0 ? fit.height / size.y : 1;
  if ('length' in fit) {
    const long = Math.max(size.x, size.z);
    return long > 0 ? fit.length / long : 1;
  }
  if ('radius' in fit) {
    const foot = Math.max(size.x, size.z);
    return foot > 0 ? (fit.radius * 2) / foot : 1;
  }
  const sx = size.x > 0 ? fit.box.w / size.x : 1;
  const sz = size.z > 0 ? fit.box.d / size.z : 1;
  return Math.min(sx, sz);
}
