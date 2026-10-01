import { readFileSync } from 'node:fs';
import { DEFAULT_TOWN_LAYOUT, layoutToMap } from '@rune/shared';
import { Box3, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { assetById } from '../src/render/assets.js';
import { placementMatrix } from '../src/render/propBatch.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * A model's bounds as the asset registry places it: scaled to its height, feet on the ground. Read
 * from the vertex positions of every mesh primitive (the POSITION accessors only, not normals),
 * and only for models whose nodes carry no transform of their own, which the test checks.
 */
function registryBounds(id: string): Box3 {
  const def = assetById(id);
  if (!def) throw new Error(`no asset ${id}`);
  const gltf: unknown = JSON.parse(readFileSync(new URL(`../public${def.url}`, import.meta.url), 'utf8'));
  if (!isRecord(gltf)) throw new Error('not a gltf');
  for (const node of list(gltf.nodes)) {
    if (isRecord(node) && (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined || node.matrix !== undefined)) throw new Error(`${id} has node transforms; measure it through the loader instead`);
  }
  const accessors = list(gltf.accessors);
  const box = new Box3();
  for (const mesh of list(gltf.meshes)) {
    for (const prim of isRecord(mesh) ? list(mesh.primitives) : []) {
      const attrs = isRecord(prim) ? prim.attributes : undefined;
      const index = isRecord(attrs) ? attrs.POSITION : undefined;
      const a = typeof index === 'number' ? accessors[index] : undefined;
      if (!isRecord(a)) continue;
      const min = list(a.min).map(Number);
      const max = list(a.max).map(Number);
      box.expandByPoint(new Vector3(min[0], min[1], min[2]));
      box.expandByPoint(new Vector3(max[0], max[1], max[2]));
    }
  }
  if (box.isEmpty()) throw new Error(`${id}: no vertex positions`);
  const size = box.getSize(new Vector3());
  const scale = def.height / size.y;
  box.translate(new Vector3(0, -box.min.y, 0));
  return new Box3(box.min.clone().multiplyScalar(scale), box.max.clone().multiplyScalar(scale));
}

describe('segment placement', () => {
  const fence = registryBounds('fence_wood_straight');
  const size = fence.getSize(new Vector3());
  const center = fence.getCenter(new Vector3());

  it('the wood fence model is off its origin, on the edge of a hex tile', () => {
    // What made every town fence draw about 40 units beside the line that blocks walking.
    expect(Math.abs(center.x)).toBeGreaterThan(40);
  });

  it('draws every town fence tile on its collision line', () => {
    const map = layoutToMap(DEFAULT_TOWN_LAYOUT);
    const fences = map.obstacles.filter((o) => o.kind === 'fence');
    expect(fences.length).toBeGreaterThan(4);
    for (const f of fences) {
      if (f.shape.type !== 'capsule') continue;
      const { ax, ay, bx, by } = f.shape;
      const angle = Math.atan2(by - ay, bx - ax);
      // A tile in the middle of the fence, as props.ts tileAlong places them.
      const p = { x: (ax + bx) / 2, y: (ay + by) / 2, angle, fit: { length: 46 } };
      const m = placementMatrix(p, size, center, new Matrix4());
      const drawn = fence.clone().applyMatrix4(m);
      const mid = drawn.getCenter(new Vector3());
      expect(Math.hypot(mid.x - p.x, mid.z - p.y), `fence tile at ${Math.round(p.x)},${Math.round(p.y)}`).toBeLessThan(0.5);
      // Its long side follows the fence, and it stays as thin as the model across it.
      const along = Math.abs(Math.cos(angle)) > 0.5 ? drawn.max.x - drawn.min.x : drawn.max.z - drawn.min.z;
      const across = Math.abs(Math.cos(angle)) > 0.5 ? drawn.max.z - drawn.min.z : drawn.max.x - drawn.min.x;
      expect(along).toBeCloseTo(46, 0);
      expect(across).toBeLessThan(8);
    }
  });

  it('places other fits by their origin, as decor footprints expect', () => {
    const at = placementMatrix({ x: 100, y: 200, angle: 0, fit: { scale: 1 } }, size, center, new Matrix4());
    const origin = new Vector3().applyMatrix4(at);
    expect(origin.x).toBeCloseTo(100, 5);
    expect(origin.z).toBeCloseTo(200, 5);
  });
});
