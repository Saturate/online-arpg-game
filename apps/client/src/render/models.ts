import type { ClassId, EnemyTypeId, MinionTypeId } from '@rune/shared';
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

/**
 * Procedural low-poly character models. Every model is built facing +x with its feet at y = 0 and
 * a nominal radius of 1, then scaled to the entity's collision radius. Limbs hang off pivot groups
 * so the animator can swing them without knowing the model's shape.
 */

export interface Rig {
  root: Group;
  body: Group;
  legL: Object3D | null;
  legR: Object3D | null;
  armL: Object3D | null;
  armR: Object3D | null;
  head: Object3D | null;
  tail: Object3D | null;
  /** Things that sway or orbit: tentacles, cloak wisps, soul orbs. */
  extras: Object3D[];
  style: 'biped' | 'hop' | 'float' | 'hover';
  /** Stride length in world units per animation cycle. */
  stride: number;
}

const materials = new Map<string, MeshStandardMaterial>();

/** Materials are cached per colour so a screen full of chasers shares a handful of them. */
export function mat(color: number, opts: { emissive?: number; intensity?: number; metal?: number; rough?: number; opacity?: number } = {}): MeshStandardMaterial {
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

const G = {
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

function mesh(geo: BufferGeometry, material: MeshStandardMaterial, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): Mesh {
  const m = new Mesh(geo, material);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  return m;
}

/** A limb hanging from a pivot, so rotating the pivot swings the limb. */
function limb(length: number, thickness: number, material: MeshStandardMaterial, x: number, y: number, z: number, geo: BufferGeometry = G.taper): Group {
  const pivot = new Group();
  pivot.position.set(x, y, z);
  const m = mesh(geo, material, 0, -length / 2, 0, thickness, length, thickness);
  m.rotation.x = Math.PI;
  pivot.add(m);
  return pivot;
}

function emptyRig(style: Rig['style'], stride: number): Rig {
  const root = new Group();
  const body = new Group();
  root.add(body);
  return { root, body, legL: null, legR: null, armL: null, armR: null, head: null, tail: null, extras: [], style, stride };
}

interface HumanoidSpec {
  skin: number;
  torso: number;
  legs: number;
  robe?: number;
  bulk?: number;
  hunch?: number;
  armLength?: number;
}

/** Shared humanoid skeleton: players, zombies and skeletons are all variations of this. */
function humanoid(spec: HumanoidSpec): Rig {
  const rig = emptyRig('biped', 3.2);
  const b = rig.body;
  const bulk = spec.bulk ?? 1;
  const skin = mat(spec.skin);
  const torsoMat = mat(spec.torso);
  const legMat = mat(spec.legs);
  const hip = 1.35;

  const torso = new Group();
  torso.position.y = hip;
  torso.rotation.z = -(spec.hunch ?? 0);
  b.add(torso);
  torso.add(mesh(G.capsule, torsoMat, 0, 0.75, 0, 0.55 * bulk, 0.55, 0.62 * bulk));
  if (spec.robe !== undefined) {
    // Robes replace visible legs with a flared skirt; the legs still swing underneath for motion.
    b.add(mesh(G.cone, mat(spec.robe), 0, 0.85, 0, 0.85 * bulk, 1.7, 0.85 * bulk));
  }
  const head = new Group();
  head.position.set(0.05, 1.95, 0);
  head.add(mesh(G.sphere, skin, 0, 0, 0, 0.42, 0.46, 0.42));
  torso.add(head);
  rig.head = head;

  const arm = spec.armLength ?? 1.15;
  rig.armL = limb(arm, 0.2 * bulk, torsoMat, 0, 1.45, 0.75 * bulk);
  rig.armR = limb(arm, 0.2 * bulk, torsoMat, 0, 1.45, -0.75 * bulk);
  torso.add(rig.armL, rig.armR);
  for (const a of [rig.armL, rig.armR]) a.add(mesh(G.sphere, skin, 0, -arm - 0.08, 0, 0.17, 0.17, 0.17));

  rig.legL = limb(hip, 0.26 * bulk, legMat, 0, hip, 0.3 * bulk);
  rig.legR = limb(hip, 0.26 * bulk, legMat, 0, hip, -0.3 * bulk);
  b.add(rig.legL, rig.legR);
  for (const l of [rig.legL, rig.legR]) l.add(mesh(G.box, mat(0x2a1e14), 0.12, -hip, 0, 0.42, 0.14, 0.26));
  return rig;
}

export function playerModel(cls: ClassId, color: number): Rig {
  switch (cls) {
    case 'warrior': {
      const rig = humanoid({ skin: 0xd8b08c, torso: 0x8a8f99, legs: 0x4a3a2a, bulk: 1.15 });
      const metal = mat(0xb8bec8, { metal: 0.7, rough: 0.35 });
      rig.head?.add(mesh(G.sphere, metal, 0, 0.1, 0, 0.47, 0.4, 0.47));
      rig.head?.add(mesh(G.cone, mat(0xe8dcc0), -0.05, 0.45, 0.4, 0.08, 0.4, 0.08));
      rig.head?.add(mesh(G.cone, mat(0xe8dcc0), -0.05, 0.45, -0.4, 0.08, 0.4, 0.08));
      rig.armL?.add(mesh(G.box, mat(color, { metal: 0.3 }), 0.25, -0.8, 0.12, 0.12, 0.95, 0.75));
      const sword = new Group();
      sword.position.set(0.1, -1.2, 0);
      sword.add(mesh(G.box, metal, 0.9, 0, 0, 1.6, 0.1, 0.18), mesh(G.box, mat(0x5a3d22), 0, 0, 0, 0.14, 0.14, 0.5));
      rig.armR?.add(sword);
      const cape = mesh(G.plane, mat(color, { opacity: 0.95 }), -0.55, 1.2, 0, 1, 1.5, 1);
      cape.rotation.y = Math.PI / 2;
      rig.body.children[0]?.add(cape);
      return rig;
    }
    case 'ranger': {
      const rig = humanoid({ skin: 0xd8b08c, torso: 0x3f6b3a, legs: 0x5a4a32 });
      rig.head?.add(mesh(G.cone, mat(0x2f5a2c), -0.05, 0.25, 0, 0.5, 0.8, 0.5));
      const bow = mesh(G.halfTorus, mat(0x7a5230), 0.25, -0.9, 0, 0.8, 0.8, 0.8);
      bow.rotation.set(0, 0, Math.PI / 2);
      rig.armL?.add(bow);
      rig.body.children[0]?.add(mesh(G.cyl, mat(0x6b4a2a), -0.6, 1.2, 0.2, 0.2, 1, 0.2));
      return rig;
    }
    case 'mage': {
      const rig = humanoid({ skin: 0xe0c0a0, torso: 0x3d68c8, legs: 0x2c4a8a, robe: 0x3d68c8 });
      const hat = mesh(G.cone, mat(0x2c4a9a), 0, 0.55, 0, 0.55, 1.1, 0.55);
      hat.rotation.z = -0.2;
      rig.head?.add(hat, mesh(G.cyl, mat(0x2c4a9a), 0, 0.2, 0, 0.75, 0.06, 0.75));
      const staff = new Group();
      staff.position.set(0.05, -1.1, 0);
      staff.add(mesh(G.cyl, mat(0x5a3d22), 0, 0.6, 0, 0.07, 2.4, 0.07));
      staff.add(mesh(G.octa, mat(0x88ccff, { emissive: 0x3388ff, intensity: 1.6 }), 0, 1.95, 0, 0.26, 0.34, 0.26));
      rig.armR?.add(staff);
      return rig;
    }
    case 'priest': {
      const rig = humanoid({ skin: 0xe8c9a8, torso: 0xe8e0cc, legs: 0xc8b890, robe: 0xe8e0cc });
      rig.body.children[0]?.add(mesh(G.box, mat(0xd8b050, { metal: 0.6, rough: 0.4 }), 0.35, 0.95, 0, 0.05, 1.1, 0.25));
      const halo = mesh(G.torus, mat(0xffe9a0, { emissive: 0xffd060, intensity: 1.8 }), 0, 0.6, 0, 0.42, 0.42, 0.42);
      halo.rotation.x = Math.PI / 2;
      rig.head?.add(halo);
      rig.extras.push(halo);
      const mace = new Group();
      mace.position.set(0, -1.1, 0);
      mace.add(mesh(G.cyl, mat(0x5a3d22), 0, 0.3, 0, 0.07, 0.9, 0.07), mesh(G.octa, mat(0xd8b050, { metal: 0.6 }), 0, 0.85, 0, 0.26, 0.26, 0.26));
      rig.armR?.add(mace);
      return rig;
    }
    case 'binder': {
      const rig = humanoid({ skin: 0xc8b8b0, torso: 0x5a3c80, legs: 0x3a2850, robe: 0x5a3c80 });
      rig.head?.add(mesh(G.cone, mat(0x2a1c3c), -0.08, 0.2, 0, 0.55, 0.9, 0.55));
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0xb49cff, intensity: 2 }), 0.36, 0.02, 0.13, 0.06, 0.06, 0.06));
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0xb49cff, intensity: 2 }), 0.36, 0.02, -0.13, 0.06, 0.06, 0.06));
      for (let i = 0; i < 2; i++) {
        const orb = mesh(G.sphere, mat(0xb49cff, { emissive: 0x7b4dff, intensity: 2 }), 0, 0, 0, 0.18, 0.18, 0.18);
        orb.userData.orbit = i * Math.PI;
        rig.body.add(orb);
        rig.extras.push(orb);
      }
      const staff = new Group();
      staff.position.set(0.05, -1.1, 0);
      staff.add(mesh(G.cyl, mat(0x3a3028), 0, 0.6, 0, 0.07, 2.3, 0.07), mesh(G.sphere, mat(0xe8e0d0), 0, 1.85, 0, 0.24, 0.26, 0.22));
      rig.armR?.add(staff);
      return rig;
    }
  }
}

export function enemyModel(type: EnemyTypeId, color: number): Rig {
  switch (type) {
    case 'chaser': {
      // A fallen-style imp: hunched, big horned head, glowing eyes, short hopping legs and a tail.
      const rig = emptyRig('hop', 2.2);
      const skin = mat(color, { rough: 0.7 });
      const dark = mat(0x3a1410);
      const eye = mat(0xffe060, { emissive: 0xffc020, intensity: 2.5 });
      const b = rig.body;
      b.add(mesh(G.sphereLow, skin, 0, 0.95, 0, 0.6, 0.55, 0.55));
      const head = new Group();
      head.position.set(0.45, 1.45, 0);
      head.add(mesh(G.sphereLow, skin, 0, 0, 0, 0.5, 0.45, 0.5));
      head.add(mesh(G.sphere, eye, 0.4, 0.05, 0.18, 0.08, 0.08, 0.08), mesh(G.sphere, eye, 0.4, 0.05, -0.18, 0.08, 0.08, 0.08));
      for (const s of [1, -1]) {
        const horn = mesh(G.cone, dark, -0.05, 0.45, s * 0.28, 0.1, 0.5, 0.1);
        horn.rotation.x = s * 0.5;
        head.add(horn);
      }
      b.add(head);
      rig.head = head;
      rig.armL = limb(0.75, 0.13, skin, 0.3, 1.2, 0.5);
      rig.armR = limb(0.75, 0.13, skin, 0.3, 1.2, -0.5);
      rig.armR.add(mesh(G.box, mat(0x9a9aa0, { metal: 0.6 }), 0.35, -0.8, 0, 0.7, 0.08, 0.2));
      b.add(rig.armL, rig.armR);
      rig.legL = limb(0.6, 0.16, dark, 0, 0.6, 0.28);
      rig.legR = limb(0.6, 0.16, dark, 0, 0.6, -0.28);
      b.add(rig.legL, rig.legR);
      const tail = new Group();
      tail.position.set(-0.5, 0.9, 0);
      const t1 = mesh(G.cone, skin, -0.35, 0, 0, 0.1, 0.8, 0.1);
      t1.rotation.z = Math.PI / 2 + 0.4;
      tail.add(t1);
      b.add(tail);
      rig.tail = tail;
      return rig;
    }
    case 'shooter': {
      // Goblin archer: big ears, hood, bow drawn forward.
      const rig = humanoid({ skin: 0x7a9a4a, torso: 0x6b4a2a, legs: 0x4a3420, hunch: 0.2 });
      rig.root.scale.setScalar(0.85);
      for (const s of [1, -1]) {
        const ear = mesh(G.cone, mat(0x7a9a4a), -0.05, 0.1, s * 0.45, 0.12, 0.5, 0.12);
        ear.rotation.x = s * 1.2;
        rig.head?.add(ear);
      }
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0xff5020, intensity: 2 }), 0.36, 0.05, 0.14, 0.06, 0.06, 0.06));
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0xff5020, intensity: 2 }), 0.36, 0.05, -0.14, 0.06, 0.06, 0.06));
      const bow = mesh(G.halfTorus, mat(0x5a3a20), 0.3, -0.9, 0, 0.9, 0.9, 0.9);
      bow.rotation.set(0, 0, Math.PI / 2);
      rig.armL?.add(bow);
      if (rig.armL) rig.armL.rotation.z = Math.PI / 2.4;
      return rig;
    }
    case 'spinner': {
      // A watcher: a floating eye with a lid and waving tentacles.
      const rig = emptyRig('float', 0);
      const b = rig.body;
      const flesh = mat(color, { rough: 0.6 });
      b.add(mesh(G.sphere, flesh, 0, 1.6, 0, 0.95, 0.9, 0.95));
      const eyeball = mesh(G.sphere, mat(0xf0e8e0, { rough: 0.3 }), 0.55, 1.62, 0, 0.55, 0.55, 0.55);
      const iris = mesh(G.sphere, mat(0xff3050, { emissive: 0xff2040, intensity: 1.8 }), 0.98, 1.62, 0, 0.12, 0.26, 0.26);
      const pupil = mesh(G.sphere, mat(0x000000), 1.07, 1.62, 0, 0.05, 0.13, 0.13);
      b.add(eyeball, iris, pupil);
      rig.head = b;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6;
        const t = limb(1.1, 0.14, flesh, Math.cos(a) * 0.5, 1.0, Math.sin(a) * 0.5, G.cone);
        t.userData.phase = a;
        b.add(t);
        rig.extras.push(t);
      }
      return rig;
    }
  }
}

export function minionModel(type: MinionTypeId, color: number): Rig {
  switch (type) {
    case 'zombie_brute': {
      const rig = humanoid({ skin: 0x7a8a5a, torso: color, legs: 0x3a3a2a, bulk: 1.35, hunch: 0.35, armLength: 1.5 });
      rig.stride = 2.4;
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0x80ff40, intensity: 1.5 }), 0.36, 0.05, 0.14, 0.06, 0.06, 0.06));
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0x80ff40, intensity: 1.5 }), 0.36, 0.05, -0.14, 0.06, 0.06, 0.06));
      return rig;
    }
    case 'skeleton_archer': {
      const rig = humanoid({ skin: 0xe8e0c8, torso: 0xd8d0b8, legs: 0xd8d0b8, bulk: 0.7 });
      rig.head?.add(mesh(G.sphere, mat(0x000000), 0.3, 0.05, 0.14, 0.09, 0.09, 0.09), mesh(G.sphere, mat(0x000000), 0.3, 0.05, -0.14, 0.09, 0.09, 0.09));
      const bow = mesh(G.halfTorus, mat(0x6b4a2a), 0.3, -0.9, 0, 0.9, 0.9, 0.9);
      bow.rotation.set(0, 0, Math.PI / 2);
      rig.armL?.add(bow);
      return rig;
    }
    case 'wraith': {
      const rig = emptyRig('hover', 0);
      const cloak = mat(color, { opacity: 0.85, emissive: 0x2040a0, intensity: 0.5 });
      const b = rig.body;
      const body = mesh(G.cone, cloak, 0, 1.3, 0, 0.8, 2.2, 0.8);
      body.rotation.x = Math.PI;
      b.add(body);
      const hood = new Group();
      hood.position.set(0.1, 2.35, 0);
      hood.add(mesh(G.sphere, cloak, 0, 0, 0, 0.5, 0.55, 0.5));
      hood.add(mesh(G.sphere, mat(0x000000, { emissive: 0x9fd0ff, intensity: 3 }), 0.4, 0, 0.14, 0.07, 0.07, 0.07));
      hood.add(mesh(G.sphere, mat(0x000000, { emissive: 0x9fd0ff, intensity: 3 }), 0.4, 0, -0.14, 0.07, 0.07, 0.07));
      b.add(hood);
      rig.head = hood;
      rig.armL = limb(1, 0.18, cloak, 0.2, 1.9, 0.6, G.cone);
      rig.armR = limb(1, 0.18, cloak, 0.2, 1.9, -0.6, G.cone);
      b.add(rig.armL, rig.armR);
      return rig;
    }
  }
}

/**
 * Drives a rig. `speed` is world units per second along the ground, so walk cycles line up with
 * how fast the entity actually moves; `attack` is 0..1, peaking at the moment of a hit.
 */
export function animate(rig: Rig, t: number, dt: number, speed: number, attack: number, seed: number): void {
  const moving = Math.min(1, speed / 60);
  const phase = rig.stride > 0 ? (rig.root.userData.phase ?? seed) + (speed * dt) / (rig.stride * 10) : 0;
  rig.root.userData.phase = phase;
  const swing = Math.sin(phase * Math.PI * 2) * 0.75 * moving;

  switch (rig.style) {
    case 'biped': {
      if (rig.legL) rig.legL.rotation.z = swing;
      if (rig.legR) rig.legR.rotation.z = -swing;
      if (rig.armL) rig.armL.rotation.z = (rig.armL.userData.rest ?? (rig.armL.userData.rest = rig.armL.rotation.z)) - swing * 0.7;
      if (rig.armR) rig.armR.rotation.z = swing * 0.7 + attack * 2;
      rig.body.position.y = Math.abs(Math.cos(phase * Math.PI * 2)) * 0.08 * moving + Math.sin(t * 2 + seed) * 0.02;
      break;
    }
    case 'hop': {
      const hop = Math.abs(Math.sin(phase * Math.PI * 2));
      rig.body.position.y = hop * 0.35 * moving + Math.sin(t * 3 + seed) * 0.03;
      if (rig.legL) rig.legL.rotation.z = swing * 1.2;
      if (rig.legR) rig.legR.rotation.z = -swing * 1.2;
      if (rig.armL) rig.armL.rotation.z = -0.6 + Math.sin(t * 6 + seed) * 0.2;
      if (rig.armR) rig.armR.rotation.z = -0.6 + attack * 2.4;
      if (rig.tail) rig.tail.rotation.y = Math.sin(t * 5 + seed) * 0.6;
      break;
    }
    case 'float': {
      rig.body.position.y = Math.sin(t * 1.8 + seed) * 0.15;
      for (const e of rig.extras) e.rotation.z = Math.sin(t * 3 + (e.userData.phase ?? 0)) * 0.45;
      break;
    }
    case 'hover': {
      rig.body.position.y = 0.3 + Math.sin(t * 2 + seed) * 0.12;
      rig.body.rotation.z = -moving * 0.25;
      if (rig.armL) rig.armL.rotation.x = Math.sin(t * 2.5 + seed) * 0.3 + 0.3;
      if (rig.armR) rig.armR.rotation.x = -Math.sin(t * 2.5 + seed) * 0.3 - 0.3 - attack;
      break;
    }
  }
  for (const e of rig.extras) {
    if (e.userData.orbit !== undefined) {
      const a = t * 2 + e.userData.orbit;
      e.position.set(Math.cos(a) * 0.9, 2.2 + Math.sin(t * 3 + e.userData.orbit) * 0.15, Math.sin(a) * 0.9);
    }
  }
}

export function tint(color: number, amount: number): number {
  return new Color(color).offsetHSL(0, 0, amount).getHex();
}
