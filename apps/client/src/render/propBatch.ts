import { Box3, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type Group, type Material } from 'three';
import { assetById, instantiate } from './assets.js';

/** How a placement is sized: to a footprint radius, a box, a length along its x axis, or a height. */
export type Fit = { radius: number } | { box: { w: number; d: number } } | { length: number } | { height: number } | { scale: number };

export interface Placement {
  x: number;
  y: number;
  angle: number;
  fit: Fit;
  /** Extra uniform scale on top of the fit, for variety. */
  jitter?: number;
}

const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();
const up = new Vector3(0, 1, 0);

/**
 * Collects prop placements per asset and turns each asset into one InstancedMesh per sub-mesh
 * once its file has loaded. Hundreds of barrels or graves cost a handful of draw calls.
 */
export class PropBatch {
  private readonly placements = new Map<string, Placement[]>();

  add(assetId: string, p: Placement): void {
    const list = this.placements.get(assetId) ?? [];
    list.push(p);
    this.placements.set(assetId, list);
  }

  /** Loads every asset used and adds the instanced meshes to `group`. Missing assets are skipped. */
  async build(group: Group, isCancelled: () => boolean): Promise<void> {
    await Promise.all(
      [...this.placements].map(async ([id, list]) => {
        const def = assetById(id);
        if (!def) return;
        const inst = await instantiate(def).catch(() => null);
        if (!inst || isCancelled()) return;
        inst.root.updateMatrixWorld(true);
        const size = new Box3().setFromObject(inst.root).getSize(new Vector3());
        const meshes: { geometry: Mesh['geometry']; material: Material; local: Matrix4 }[] = [];
        inst.root.traverse((o) => {
          if (!(o instanceof Mesh) || !o.visible || Array.isArray(o.material)) return;
          meshes.push({ geometry: o.geometry, material: o.material, local: o.matrixWorld.clone() });
        });
        // Segment assets are not all modelled along x; turn them so their long side follows the line.
        const alongZ = size.z > size.x;
        for (const m of meshes) {
          const im = new InstancedMesh(m.geometry, m.material, list.length);
          list.forEach((p, i) => {
            const s = fitScale(p.fit, size) * (p.jitter ?? 1);
            tmpPos.set(p.x, 0, p.y);
            tmpQuat.setFromAxisAngle(up, -p.angle + ('length' in p.fit && alongZ ? Math.PI / 2 : 0));
            tmpScale.setScalar(s);
            im.setMatrixAt(i, new Matrix4().compose(tmpPos, tmpQuat, tmpScale).multiply(m.local));
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
