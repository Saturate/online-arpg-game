import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Object3D,
} from 'three';
import type { MotionProfile, RigMotion } from './motion.js';

/**
 * Building blocks for the procedural models. A model is built facing +x with its feet at y = 0
 * and a nominal radius of 1, then scaled to the entity's collision radius. Limbs hang off pivot
 * groups so the animator can swing them without knowing the model's shape.
 */

/** What an extra part is, so the animator knows how to move it. */
export type ExtraKind = 'leg' | 'wing' | 'tentacle' | 'strand' | 'flame' | 'orbit' | 'claw' | 'segment' | 'tongue';

export interface Rig {
  root: Group;
  body: Object3D;
  legL: Object3D | null;
  legR: Object3D | null;
  armL: Object3D | null;
  armR: Object3D | null;
  head: Object3D | null;
  /** A lower jaw or lid that opens on its own, for bites. */
  jaw: Object3D | null;
  tail: Object3D | null;
  /** Parts that sway, flap or orbit; each carries `userData.kind` (an ExtraKind). */
  extras: Object3D[];
  profile: MotionProfile;
  /** Leg length in model units, so a walk cycle covers the ground it should. 0 for legless rigs. */
  legLength: number;
  /** GPU resources this copy owns: the skeleton and its bone texture. Shared geometry is not listed. */
  owned: { dispose(): void }[];
  /** Animation state, created on the first frame the rig is driven. */
  motion: RigMotion | null;
}

const materials = new Map<string, MeshStandardMaterial>();

export interface MatOptions {
  emissive?: number;
  intensity?: number;
  metal?: number;
  rough?: number;
  opacity?: number;
}

/** Materials are cached per colour so a screen full of props shares a handful of them. */
export function mat(color: number, opts: MatOptions = {}): MeshStandardMaterial {
  const key = `${color}|${opts.emissive ?? 0}|${opts.intensity ?? 0}|${opts.metal ?? 0}|${opts.rough ?? 0.8}|${opts.opacity ?? 1}`;
  let m = materials.get(key);
  if (!m) {
    m = new MeshStandardMaterial({
      color,
      emissive: opts.emissive ?? 0,
      emissiveIntensity: opts.intensity ?? 1,
      metalness: opts.metal ?? 0,
      roughness: opts.rough ?? 0.8,
      flatShading: true,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      ...((opts.opacity ?? 1) < 1 ? { side: DoubleSide } : {}),
    });
    materials.set(key, m);
  }
  return m;
}

/** Tintable models clone their materials, since hit flashes and ailments change them per entity. */
export function uniqueMaterials(root: Object3D): void {
  root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) o.material = o.material.clone();
  });
}

export function tint(color: number, amount: number): number {
  return new Color(color).offsetHSL(0, 0, amount).getHex();
}

export const G = {
  sphere: new SphereGeometry(1, 12, 9),
  sphereLow: new IcosahedronGeometry(1, 1),
  box: new BoxGeometry(1, 1, 1),
  cyl: new CylinderGeometry(1, 1, 1, 8),
  taper: new CylinderGeometry(0.55, 1, 1, 8),
  cone: new ConeGeometry(1, 1, 8),
  cone4: new ConeGeometry(1, 1, 4),
  capsule: new CapsuleGeometry(1, 1, 4, 8),
  octa: new OctahedronGeometry(1, 0),
  torus: new TorusGeometry(1, 0.14, 6, 18),
  halfTorus: new TorusGeometry(1, 0.08, 5, 14, Math.PI),
  plane: new PlaneGeometry(1, 1),
};

export function mesh(geo: BufferGeometry, material: MeshStandardMaterial, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): Mesh {
  const m = new Mesh(geo, material);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  return m;
}

/** A limb hanging from a pivot, so rotating the pivot swings the limb. */
export function limb(length: number, thickness: number, material: MeshStandardMaterial, x: number, y: number, z: number, geo: BufferGeometry = G.taper): Group {
  const pivot = new Group();
  pivot.position.set(x, y, z);
  pivot.userData.length = length;
  const m = mesh(geo, material, 0, -length / 2, 0, thickness, length, thickness);
  m.rotation.x = Math.PI;
  pivot.add(m);
  return pivot;
}

/** Marks a part for the animator. `side` is +1 on the +z side and -1 on the -z side. */
export function extra<T extends Object3D>(rig: Rig, o: T, kind: ExtraKind, phase = 0, side = 0): T {
  o.userData.kind = kind;
  o.userData.phase = phase;
  o.userData.side = side;
  rig.extras.push(o);
  return o;
}

export function emptyRig(profile: MotionProfile): Rig {
  const root = new Group();
  const body = new Group();
  root.add(body);
  return { root, body, legL: null, legR: null, armL: null, armR: null, head: null, jaw: null, tail: null, extras: [], profile, legLength: 0, owned: [], motion: null };
}

export function eyes(parent: Object3D, x: number, y: number, z: number, glow: number, size = 0.06): void {
  parent.add(mesh(G.sphere, mat(0x000000, { emissive: glow, intensity: 2.2 }), x, y, z, size, size, size));
  parent.add(mesh(G.sphere, mat(0x000000, { emissive: glow, intensity: 2.2 }), x, y, -z, size, size, size));
}
