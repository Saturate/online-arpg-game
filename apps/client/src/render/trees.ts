import { BufferAttribute, Color, ConeGeometry, CylinderGeometry, Euler, IcosahedronGeometry, Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural low-poly trees. Each tree is built from a seed out of tapered cylinders, cones and
 * lumpy icosahedrons, coloured per vertex and merged into a single geometry, so a forest is one
 * draw call per tree and no two trees match. Sizes are in world units with the base at y = 0.
 */

export type TreeKind = 'pine' | 'oak' | 'dead';

/** A handful of variants per kind is plenty; geometry is shared between trees that roll the same one. */
const VARIANTS = 10;
const cache = new Map<string, BufferGeometry>();

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function part(geo: BufferGeometry, color: Color, m: Matrix4, jitter: () => number, shade = 0.08): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(m);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  // Per-face shading noise gives the faceted look some life without a texture.
  for (let i = 0; i < n; i += 3) {
    const k = 1 - shade + jitter() * shade * 2;
    for (let v = 0; v < 3; v++) {
      colors[(i + v) * 3] = color.r * k;
      colors[(i + v) * 3 + 1] = color.g * k;
      colors[(i + v) * 3 + 2] = color.b * k;
    }
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

function transform(pos: Vector3, rot: Euler, scale: Vector3): Matrix4 {
  return new Matrix4().compose(pos, new Quaternion().setFromEuler(rot), scale);
}

/** A tapered segment from `from` in direction `dir`, returned with its tip. */
function limb(parts: BufferGeometry[], from: Vector3, dir: Vector3, length: number, r0: number, r1: number, color: Color, jitter: () => number): Vector3 {
  const geo = new CylinderGeometry(r1, r0, length, 6, 1);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  const mid = from.clone().addScaledVector(dir.clone().normalize(), length / 2);
  parts.push(part(geo, color, new Matrix4().compose(mid, q, new Vector3(1, 1, 1)), jitter));
  return from.clone().addScaledVector(dir.clone().normalize(), length);
}

function pine(r: () => number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const bark = new Color().setHSL(0.07, 0.35, 0.18 + r() * 0.06);
  const lean = new Vector3((r() - 0.5) * 0.12, 1, (r() - 0.5) * 0.12);
  limb(parts, new Vector3(0, 0, 0), lean, 1.1, 0.09, 0.05, bark, r);
  const tiers = 3 + Math.floor(r() * 3);
  const hue = 0.3 + r() * 0.06;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const w = 0.62 * (1 - t * 0.72) * (0.9 + r() * 0.2);
    const h = 0.55 * (1 - t * 0.3);
    const green = new Color().setHSL(hue + (r() - 0.5) * 0.03, 0.45 + r() * 0.15, 0.22 + t * 0.08 + r() * 0.04);
    const geo = new ConeGeometry(1, 1, 7 + Math.floor(r() * 3), 1);
    parts.push(part(geo, green, transform(new Vector3(lean.x * (0.35 + t), 0.42 + t * 1.05, lean.z * (0.35 + t)), new Euler(0, r() * 6, 0), new Vector3(w, h, w)), r));
  }
  return parts;
}

function oak(r: () => number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const bark = new Color().setHSL(0.07, 0.3, 0.2 + r() * 0.05);
  const top = limb(parts, new Vector3(0, 0, 0), new Vector3((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2), 0.75, 0.1, 0.07, bark, r);
  const tips: Vector3[] = [top];
  const branches = 2 + Math.floor(r() * 3);
  for (let i = 0; i < branches; i++) {
    const a = (Math.PI * 2 * i) / branches + r();
    tips.push(limb(parts, top.clone().multiplyScalar(0.85), new Vector3(Math.cos(a), 0.9 + r() * 0.6, Math.sin(a)), 0.35 + r() * 0.2, 0.05, 0.025, bark, r));
  }
  // Autumn-tinged oaks now and then keep a forest from being a single green.
  const autumn = r() < 0.18;
  const hue = autumn ? 0.08 + r() * 0.05 : 0.23 + r() * 0.07;
  for (const tip of tips) {
    const blobs = 2 + Math.floor(r() * 2);
    for (let b = 0; b < blobs; b++) {
      const s = 0.26 + r() * 0.16;
      const color = new Color().setHSL(hue + (r() - 0.5) * 0.04, 0.45 + r() * 0.2, 0.26 + r() * 0.1);
      parts.push(
        part(
          new IcosahedronGeometry(1, 1),
          color,
          transform(tip.clone().add(new Vector3((r() - 0.5) * 0.3, 0.1 + (r() - 0.3) * 0.2, (r() - 0.5) * 0.3)), new Euler(r() * 3, r() * 3, 0), new Vector3(s, s * 0.85, s)),
          r,
          0.12,
        ),
      );
    }
  }
  return parts;
}

function dead(r: () => number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const bark = new Color().setHSL(0.06, 0.12, 0.22 + r() * 0.08);
  const grow = (from: Vector3, dir: Vector3, length: number, radius: number, depth: number): void => {
    const tip = limb(parts, from, dir, length, radius, radius * 0.6, bark, r);
    if (depth === 0) return;
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const nd = dir.clone().normalize().multiplyScalar(0.7).add(new Vector3(Math.cos(a), 0.3 + r() * 0.5, Math.sin(a)).multiplyScalar(0.8));
      grow(tip, nd, length * (0.55 + r() * 0.2), radius * 0.55, depth - 1);
    }
  };
  grow(new Vector3(0, 0, 0), new Vector3((r() - 0.5) * 0.3, 1, (r() - 0.5) * 0.3), 0.7, 0.08, 2);
  return parts;
}

/** Unit-height tree geometry (roughly 2 tall for pines, 1.5 for oaks); scale it to the size you want. */
export function treeGeometry(kind: TreeKind, seed: number): BufferGeometry {
  const variant = Math.abs(Math.floor(seed)) % VARIANTS;
  const key = `${kind}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = rng(variant * 7919 + (kind === 'pine' ? 1 : kind === 'oak' ? 2 : 3));
  const parts = kind === 'pine' ? pine(r) : kind === 'oak' ? oak(r) : dead(r);
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  cache.set(key, merged);
  return merged;
}
