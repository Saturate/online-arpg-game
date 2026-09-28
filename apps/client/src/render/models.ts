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
    case 'plague_rat':
      return rat(color);
    case 'blood_bat':
      return bat(color);
    case 'spiderling':
      return spider(color, 0.8, false);
    case 'venom_spider':
      return spider(color, 1, false);
    case 'broodmother':
      return spider(color, 1.1, true);
    case 'tusked_boar':
      return quadruped(color, { tusks: true, horns: false, bulk: 1 });
    case 'horned_charger':
      return quadruped(color, { tusks: false, horns: true, bulk: 1.25 });
    case 'bloated_corpse': {
      const rig = humanoid({ skin: color, torso: tint(color, -0.1), legs: 0x3a3a2a, bulk: 1.3, hunch: 0.3 });
      rig.body.add(mesh(G.sphereLow, mat(tint(color, 0.08), { rough: 0.5 }), 0.25, 1.75, 0, 0.75, 0.7, 0.7));
      for (const [y, z] of [[1.9, 0.35], [1.6, -0.3], [2.1, -0.1]] as const) rig.body.add(mesh(G.sphere, mat(0x9aba4a, { emissive: 0x405a10, intensity: 0.6 }), 0.8, y, z, 0.14, 0.14, 0.14));
      return rig;
    }
    case 'volatile': {
      const rig = imp(color, { glow: true, staff: false });
      rig.root.scale.multiplyScalar(0.9);
      return rig;
    }
    case 'fallen_shaman':
      return imp(color, { glow: false, staff: true });
    case 'sand_burrower':
      return worm(color);
    case 'bone_spire':
      return spire(color);
    case 'flame_totem':
      return totem(color);
    case 'wraith':
      return ghost(color, false);
    case 'banshee':
      return ghost(color, true);
    case 'bog_spitter':
      return toad(color);
    case 'ooze':
    case 'oozeling':
      return ooze(color);
    case 'infernal':
      return infernal(color);
    case 'dire_wolf':
      return wolf(color, { fire: false, bulk: 1 });
    case 'hellhound':
      return wolf(color, { fire: true, bulk: 1.1 });
    case 'giant_scorpion':
      return scorpion(color, 1);
    case 'thorn_beast':
      return thornBeast(color);
    case 'cave_spider':
      return spider(color, 0.85, false);
    case 'lizardman':
      return lizardman(color);
    case 'scarab':
      return beetle(color, 0.7, false);
    case 'carrion_beetle':
      return beetle(color, 1.25, true);
    case 'vulture':
      return bird(color, false);
    case 'harpy':
      return bird(color, true);
    case 'fire_slime':
      return ooze(color);
    case 'frost_slime':
      return ooze(color);
    case 'fire_elemental':
      return elemental(color, 'fire');
    case 'frost_elemental':
      return elemental(color, 'frost');
    case 'storm_elemental':
      return elemental(color, 'storm');
    case 'will_o_wisp':
      return wisp(color);
    case 'earth_golem':
      return golem(color, 'earth');
    case 'bone_golem':
      return golem(color, 'bone');
    case 'iron_golem':
      return golem(color, 'iron');
    case 'treant':
      return treant(color, false);
    case 'treant_king':
      return treant(color, true);
    case 'spore_man':
      return mushroom(color);
    case 'bog_lurker':
      return lurker(color);
    case 'gargoyle':
      return gargoyle(color);
    case 'mimic':
      return mimic(color);
    case 'sand_worm':
      return worm(color, 1.2);
    case 'sand_wyrm':
      return worm(color, 1.6);
    case 'mummy':
      return mummy(color);
    case 'ice_wraith':
      return ghost(color, true);
    case 'imp': {
      const rig = imp(color, { glow: true, staff: false });
      rig.root.scale.multiplyScalar(0.8);
      return rig;
    }
    case 'cultist':
      return cultist(color);
    case 'hellspawn':
      return demon(color);
    case 'frost_giant':
      return frostGiant(color);
    default: {
      // Placeholder until the glTF model streams in; humanoids with their family colour.
      const rig = humanoid({ skin: tint(color, 0.1), torso: color, legs: tint(color, -0.25) });
      return rig;
    }
  }
}

function imp(color: number, opts: { glow: boolean; staff: boolean }): Rig {
  const rig = emptyRig('hop', 2.2);
  const skin = opts.glow ? mat(color, { emissive: 0xff5a10, intensity: 0.9 }) : mat(color, { rough: 0.7 });
  const dark = mat(0x3a1410);
  const eye = mat(0xffe060, { emissive: 0xffc020, intensity: 2.5 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 0.95, 0, 0.6, 0.55, 0.55));
  const head = new Group();
  head.position.set(0.45, 1.45, 0);
  head.add(mesh(G.sphereLow, skin, 0, 0, 0, 0.5, 0.45, 0.5));
  head.add(mesh(G.sphere, eye, 0.4, 0.05, 0.18, 0.08, 0.08, 0.08), mesh(G.sphere, eye, 0.4, 0.05, -0.18, 0.08, 0.08, 0.08));
  if (opts.staff) {
    // A shaman's feathered headdress.
    for (let i = 0; i < 5; i++) {
      const f = mesh(G.cone4, mat(i % 2 ? 0xf0d060 : 0x40a0c0), -0.1, 0.5, (i - 2) * 0.14, 0.07, 0.55, 0.07);
      f.rotation.x = (i - 2) * 0.25;
      head.add(f);
    }
  } else {
    // A fuse on its head, burning.
    head.add(mesh(G.cyl, dark, 0, 0.45, 0, 0.04, 0.3, 0.04), mesh(G.sphere, mat(0xffe080, { emissive: 0xffa020, intensity: 3 }), 0, 0.65, 0, 0.1, 0.1, 0.1));
  }
  b.add(head);
  rig.head = head;
  rig.armL = limb(0.75, 0.13, skin, 0.3, 1.2, 0.5);
  rig.armR = limb(0.75, 0.13, skin, 0.3, 1.2, -0.5);
  if (opts.staff) rig.armR.add(mesh(G.cyl, mat(0x5a3a20), 0.1, -0.6, 0, 0.05, 1.8, 0.05), mesh(G.octa, mat(0xff6030, { emissive: 0xff3010, intensity: 1.5 }), 0.1, 0.35, 0, 0.14, 0.18, 0.14));
  b.add(rig.armL, rig.armR);
  rig.legL = limb(0.6, 0.16, dark, 0, 0.6, 0.28);
  rig.legR = limb(0.6, 0.16, dark, 0, 0.6, -0.28);
  b.add(rig.legL, rig.legR);
  return rig;
}

function rat(color: number): Rig {
  const rig = emptyRig('hop', 1.4);
  const fur = mat(color, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, fur, 0, 0.55, 0, 0.9, 0.5, 0.55));
  const head = mesh(G.cone, fur, 0.95, 0.6, 0, 0.32, 0.7, 0.32);
  head.rotation.z = -Math.PI / 2;
  b.add(head);
  rig.head = head;
  for (const z of [0.2, -0.2]) b.add(mesh(G.sphere, mat(0xd8a0a0), 0.75, 0.95, z, 0.14, 0.18, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xff3030, intensity: 1.5 }), 1.1, 0.72, z * 0.6, 0.05, 0.05, 0.05));
  const tail = new Group();
  tail.position.set(-0.85, 0.5, 0);
  const t = mesh(G.cone, mat(0xc89090), -0.6, 0, 0, 0.05, 1.2, 0.05);
  t.rotation.z = Math.PI / 2;
  tail.add(t);
  b.add(tail);
  rig.tail = tail;
  rig.legL = limb(0.4, 0.1, fur, 0.3, 0.35, 0.3);
  rig.legR = limb(0.4, 0.1, fur, -0.3, 0.35, -0.3);
  b.add(rig.legL, rig.legR);
  return rig;
}

function bat(color: number): Rig {
  const rig = emptyRig('float', 0);
  const skin = mat(color, { rough: 0.7 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 1.8, 0, 0.45, 0.45, 0.4));
  b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xffe040, intensity: 2 }), 0.38, 1.9, 0.14, 0.06, 0.06, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xffe040, intensity: 2 }), 0.38, 1.9, -0.14, 0.06, 0.06, 0.06));
  for (const sgn of [1, -1]) {
    const wing = new Group();
    wing.position.set(0, 1.85, sgn * 0.35);
    const membrane = mesh(G.cone4, mat(tint(color, -0.12), { rough: 0.9 }), 0, 0, sgn * 0.7, 0.9, 0.08, 0.8);
    membrane.rotation.x = Math.PI / 2;
    wing.add(membrane);
    wing.userData.phase = sgn > 0 ? 0 : Math.PI;
    b.add(wing);
    rig.extras.push(wing);
  }
  return rig;
}

function spider(color: number, size: number, queen: boolean): Rig {
  const rig = emptyRig('float', 0);
  const shell = mat(color, { rough: 0.5 });
  const b = rig.body;
  b.scale.setScalar(size);
  b.add(mesh(G.sphereLow, shell, -0.45, 0.75, 0, 0.75, 0.6, 0.65));
  b.add(mesh(G.sphereLow, shell, 0.35, 0.65, 0, 0.4, 0.35, 0.4));
  for (let i = 0; i < 4; i++) b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xff2020, intensity: 2 }), 0.72, 0.8 + (i % 2) * 0.08, (i < 2 ? 1 : -1) * (0.08 + (i % 2) * 0.1), 0.05, 0.05, 0.05));
  // A venom mark on the back.
  b.add(mesh(G.sphere, mat(0xc02020, { emissive: 0x600000, intensity: 0.8 }), -0.45, 1.3, 0, 0.3, 0.08, 0.2));
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? 1 : -1;
    const k = i % 4;
    const leg = limb(1.1, 0.07, mat(tint(color, -0.1)), 0.25 - k * 0.22, 0.75, side * 0.3, G.cyl);
    leg.rotation.x = side * (0.9 + k * 0.05);
    leg.rotation.y = (k - 1.5) * 0.35 * side;
    leg.userData.phase = i * 0.8;
    b.add(leg);
    rig.extras.push(leg);
  }
  if (queen) {
    for (const [x, z] of [[-1.1, 0.4], [-1.2, -0.3], [-0.9, -0.6]] as const) b.add(mesh(G.sphere, mat(0xe8e0c0, { emissive: 0x303010, intensity: 0.5 }), x, 0.45, z, 0.28, 0.32, 0.28));
    b.add(mesh(G.cone, mat(0x201810), 0.7, 0.5, 0.12, 0.06, 0.4, 0.06), mesh(G.cone, mat(0x201810), 0.7, 0.5, -0.12, 0.06, 0.4, 0.06));
  }
  return rig;
}

function quadruped(color: number, opts: { tusks: boolean; horns: boolean; bulk: number }): Rig {
  const rig = emptyRig('biped', 2.6);
  const hide = mat(color, { rough: 0.9 });
  const b = rig.body;
  b.scale.setScalar(opts.bulk);
  b.add(mesh(G.sphereLow, hide, -0.1, 0.95, 0, 1.0, 0.62, 0.6));
  // A bristled ridge along the back.
  for (let i = 0; i < 5; i++) b.add(mesh(G.cone4, mat(tint(color, -0.2)), -0.7 + i * 0.3, 1.55, 0, 0.1, 0.3, 0.1));
  const head = new Group();
  head.position.set(0.95, 0.95, 0);
  head.add(mesh(G.sphereLow, hide, 0, 0, 0, 0.45, 0.4, 0.4), mesh(G.cyl, mat(0x3a2418), 0.42, -0.08, 0, 0.18, 0.2, 0.18));
  head.add(mesh(G.sphere, mat(0x000000, { emissive: 0xff4020, intensity: 1.6 }), 0.3, 0.12, 0.2, 0.06, 0.06, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xff4020, intensity: 1.6 }), 0.3, 0.12, -0.2, 0.06, 0.06, 0.06));
  if (opts.tusks) {
    for (const z of [0.18, -0.18]) {
      const tusk = mesh(G.cone, mat(0xf0e8d0), 0.45, -0.1, z, 0.06, 0.4, 0.06);
      tusk.rotation.z = -1.1;
      head.add(tusk);
    }
  }
  if (opts.horns) {
    for (const z of [0.3, -0.3]) {
      const horn = mesh(G.cone, mat(0xe8dcc0), 0.05, 0.4, z, 0.1, 0.8, 0.1);
      horn.rotation.x = z > 0 ? -0.7 : 0.7;
      horn.rotation.z = -0.5;
      head.add(horn);
    }
  }
  b.add(head);
  rig.head = head;
  rig.legL = limb(0.6, 0.14, hide, 0.55, 0.6, 0.3);
  rig.legR = limb(0.6, 0.14, hide, 0.55, 0.6, -0.3);
  rig.armL = limb(0.6, 0.14, hide, -0.6, 0.6, 0.3);
  rig.armR = limb(0.6, 0.14, hide, -0.6, 0.6, -0.3);
  b.add(rig.legL, rig.legR, rig.armL, rig.armR);
  return rig;
}

function worm(color: number, size = 1): Rig {
  const rig = emptyRig('float', 0);
  const skin = mat(color, { rough: 0.8 });
  const b = rig.body;
  b.scale.setScalar(size);
  for (let i = 0; i < 5; i++) {
    const a = i * 0.42;
    b.add(mesh(G.sphereLow, i % 2 ? skin : mat(tint(color, -0.08)), -0.8 + Math.sin(a) * 0.9, 0.35 + i * 0.42, 0, 0.55 - i * 0.04, 0.4, 0.55 - i * 0.04));
  }
  const maw = new Group();
  maw.position.set(0.35, 2.35, 0);
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI * 2 * i) / 4;
    const fang = mesh(G.cone, mat(0xf0e0c0), Math.cos(a) * 0.2, 0.2, Math.sin(a) * 0.2, 0.08, 0.5, 0.08);
    fang.rotation.z = -0.4;
    maw.add(fang);
  }
  b.add(maw);
  rig.head = maw;
  return rig;
}

function spire(color: number): Rig {
  const rig = emptyRig('biped', 0);
  const bone = mat(color, { rough: 0.7 });
  const b = rig.body;
  b.add(mesh(G.cyl, mat(0x5a5048), 0, 0.2, 0, 0.9, 0.4, 0.9));
  b.add(mesh(G.cone, bone, 0, 1.6, 0, 0.45, 2.6, 0.45));
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    const spike = mesh(G.cone, bone, Math.cos(a) * 0.45, 0.8 + (i % 3) * 0.35, Math.sin(a) * 0.45, 0.1, 0.8, 0.1);
    spike.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    b.add(spike);
  }
  b.add(mesh(G.sphereLow, bone, 0.1, 2.9, 0, 0.35, 0.33, 0.33), mesh(G.sphere, mat(0x000000, { emissive: 0x80ffff, intensity: 2.5 }), 0.38, 2.95, 0.12, 0.07, 0.07, 0.07));
  return rig;
}

function totem(color: number): Rig {
  const rig = emptyRig('biped', 0);
  const wood = mat(0x6b4a2a, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.cyl, wood, 0, 1.3, 0, 0.45, 2.6, 0.45));
  for (let i = 0; i < 3; i++) {
    b.add(mesh(G.box, mat(i % 2 ? 0x8a2a1a : 0x3a6a8a), 0.42, 0.55 + i * 0.8, 0, 0.1, 0.35, 0.5));
    b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xffa020, intensity: 2 }), 0.48, 0.7 + i * 0.8, 0.15, 0.06, 0.06, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xffa020, intensity: 2 }), 0.48, 0.7 + i * 0.8, -0.15, 0.06, 0.06, 0.06));
  }
  const flame = mesh(G.cone, mat(color, { emissive: 0xff6010, intensity: 2.5, opacity: 0.85 }), 0, 3.0, 0, 0.35, 0.9, 0.35);
  flame.userData.phase = 0;
  b.add(flame);
  rig.extras.push(flame);
  return rig;
}

function ghost(color: number, banshee: boolean): Rig {
  const rig = emptyRig('hover', 0);
  const cloak = mat(color, { opacity: 0.7, emissive: banshee ? 0x6080c0 : 0x2040a0, intensity: 0.7 });
  const b = rig.body;
  const body = mesh(G.cone, cloak, 0, 1.3, 0, 0.8, 2.2, 0.8);
  body.rotation.x = Math.PI;
  b.add(body);
  const hood = new Group();
  hood.position.set(0.1, 2.35, 0);
  hood.add(mesh(G.sphere, cloak, 0, 0, 0, 0.45, 0.5, 0.45));
  const eyes = banshee ? 0xffffff : 0x9fd0ff;
  hood.add(mesh(G.sphere, mat(0x000000, { emissive: eyes, intensity: 3 }), 0.38, 0, 0.13, 0.07, 0.07, 0.07), mesh(G.sphere, mat(0x000000, { emissive: eyes, intensity: 3 }), 0.38, 0, -0.13, 0.07, 0.07, 0.07));
  if (banshee) {
    // Long drifting hair.
    for (let i = 0; i < 5; i++) {
      const strand = limb(1.4, 0.07, mat(0xe8f0ff, { opacity: 0.6 }), -0.2, 0.2, (i - 2) * 0.12, G.cone);
      strand.rotation.z = 0.6;
      strand.userData.phase = i;
      hood.add(strand);
      rig.extras.push(strand);
    }
  }
  b.add(hood);
  rig.head = hood;
  rig.armL = limb(1, 0.18, cloak, 0.2, 1.9, 0.6, G.cone);
  rig.armR = limb(1, 0.18, cloak, 0.2, 1.9, -0.6, G.cone);
  b.add(rig.armL, rig.armR);
  return rig;
}

function toad(color: number): Rig {
  const rig = emptyRig('hop', 1.6);
  const skin = mat(color, { rough: 0.6 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 0.75, 0, 0.9, 0.65, 0.85));
  b.add(mesh(G.sphereLow, mat(0xd8d0a0), 0.3, 0.6, 0, 0.6, 0.45, 0.7));
  for (const z of [0.4, -0.4]) b.add(mesh(G.sphere, mat(0xf0e040, { emissive: 0x806000, intensity: 0.8 }), 0.5, 1.35, z, 0.18, 0.18, 0.18), mesh(G.sphere, mat(0x000000), 0.64, 1.38, z, 0.07, 0.1, 0.1));
  // Warts that ooze.
  for (let i = 0; i < 6; i++) b.add(mesh(G.sphere, mat(0x9ad040, { emissive: 0x3a6010, intensity: 0.7 }), -0.5 + (i % 3) * 0.3, 1.2 + (i % 2) * 0.1, (i < 3 ? 1 : -1) * 0.35, 0.1, 0.1, 0.1));
  rig.legL = limb(0.55, 0.2, skin, -0.4, 0.55, 0.55);
  rig.legR = limb(0.55, 0.2, skin, -0.4, 0.55, -0.55);
  b.add(rig.legL, rig.legR);
  return rig;
}

function ooze(color: number): Rig {
  const rig = emptyRig('hop', 1.8);
  const b = rig.body;
  b.add(mesh(G.sphereLow, mat(color, { opacity: 0.75, emissive: tint(color, -0.3), intensity: 0.4, rough: 0.2 }), 0, 0.8, 0, 1, 0.8, 1));
  b.add(mesh(G.sphereLow, mat(tint(color, -0.25), { emissive: 0x104030, intensity: 0.8 }), 0, 0.75, 0, 0.45, 0.4, 0.45));
  for (const z of [0.3, -0.3]) b.add(mesh(G.sphere, mat(0x000000), 0.75, 1.1, z, 0.1, 0.12, 0.1));
  return rig;
}

function infernal(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.2), legs: 0x2a1a10, bulk: 1.5, hunch: 0.15, armLength: 1.4 });
  rig.root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial && o.material.color.getHex() === new Color(color).getHex()) {
      o.material = mat(color, { emissive: 0xff3010, intensity: 0.9 });
    }
  });
  for (const z of [0.25, -0.25]) {
    const horn = mesh(G.cone, mat(0x1a1010), 0, 0.5, z, 0.1, 0.6, 0.1);
    horn.rotation.x = z > 0 ? -0.4 : 0.4;
    rig.head?.add(horn);
  }
  for (let i = 0; i < 3; i++) {
    const ember = mesh(G.octa, mat(0xffc040, { emissive: 0xff8010, intensity: 3 }), 0, 0, 0, 0.2, 0.2, 0.2);
    ember.userData.orbit = (Math.PI * 2 * i) / 3;
    rig.body.add(ember);
    rig.extras.push(ember);
  }
  return rig;
}

// ---------------------------------------------------------------------------------------------
// Second roster: beasts, insects, flyers, elementals, golems and ambushers. All procedural, since
// the KayKit packs have no animals; each is a handful of primitives with its own silhouette.

function eyes(parent: Object3D, x: number, y: number, z: number, glow: number, size = 0.06): void {
  parent.add(mesh(G.sphere, mat(0x000000, { emissive: glow, intensity: 2.2 }), x, y, z, size, size, size));
  parent.add(mesh(G.sphere, mat(0x000000, { emissive: glow, intensity: 2.2 }), x, y, -z, size, size, size));
}

/** Long-snouted four-legged hunter. Hellhounds smoulder and have a burning mane. */
function wolf(color: number, opts: { fire: boolean; bulk: number }): Rig {
  const rig = emptyRig('biped', 2.8);
  const fur = opts.fire ? mat(color, { emissive: 0x801800, intensity: 0.6, rough: 0.9 }) : mat(color, { rough: 0.95 });
  const dark = mat(tint(color, -0.18), { rough: 0.95 });
  const b = rig.body;
  b.scale.setScalar(opts.bulk);
  b.add(mesh(G.capsule, fur, -0.05, 0.95, 0, 0.42, 0.9, 0.38));
  b.children[b.children.length - 1]?.rotateZ(Math.PI / 2);
  const head = new Group();
  head.position.set(0.85, 1.15, 0);
  head.add(mesh(G.sphereLow, fur, 0, 0, 0, 0.36, 0.32, 0.32));
  const snout = mesh(G.cone, dark, 0.38, -0.05, 0, 0.16, 0.5, 0.16);
  snout.rotation.z = -Math.PI / 2;
  head.add(snout);
  for (const z of [0.16, -0.16]) {
    const ear = mesh(G.cone4, dark, -0.05, 0.32, z, 0.09, 0.3, 0.09);
    head.add(ear);
  }
  eyes(head, 0.24, 0.1, 0.14, opts.fire ? 0xffa020 : 0xffe060);
  b.add(head);
  rig.head = head;
  if (opts.fire) {
    for (let i = 0; i < 4; i++) {
      const flame = mesh(G.cone, mat(0xffa030, { emissive: 0xff5010, intensity: 2.5, opacity: 0.85 }), 0.5 - i * 0.3, 1.45, 0, 0.14, 0.45, 0.14);
      flame.userData.phase = i;
      b.add(flame);
      rig.extras.push(flame);
    }
  }
  const tail = new Group();
  tail.position.set(-0.85, 1.05, 0);
  const t = mesh(G.cone, dark, -0.35, 0, 0, 0.12, 0.8, 0.12);
  t.rotation.z = Math.PI / 2 + 0.5;
  tail.add(t);
  b.add(tail);
  rig.tail = tail;
  rig.legL = limb(0.7, 0.12, dark, 0.5, 0.7, 0.22);
  rig.legR = limb(0.7, 0.12, dark, 0.5, 0.7, -0.22);
  rig.armL = limb(0.7, 0.12, dark, -0.5, 0.7, 0.22);
  rig.armR = limb(0.7, 0.12, dark, -0.5, 0.7, -0.22);
  b.add(rig.legL, rig.legR, rig.armL, rig.armR);
  return rig;
}

/** Flat body, two raised pincers and a tail curled over its back ending in a stinger. */
function scorpion(color: number, size: number): Rig {
  const rig = emptyRig('float', 0);
  const shell = mat(color, { rough: 0.5 });
  const dark = mat(tint(color, -0.2), { rough: 0.5 });
  const b = rig.body;
  b.scale.setScalar(size);
  b.add(mesh(G.sphereLow, shell, 0, 0.5, 0, 0.8, 0.35, 0.55));
  for (const z of [0.5, -0.5]) {
    const claw = new Group();
    claw.position.set(0.7, 0.55, z);
    claw.add(mesh(G.capsule, shell, 0.3, 0, 0, 0.12, 0.35, 0.12));
    claw.children[0]?.rotateZ(Math.PI / 2);
    claw.add(mesh(G.cone4, dark, 0.75, 0.05, 0.06, 0.1, 0.35, 0.1), mesh(G.cone4, dark, 0.75, -0.05, -0.06, 0.1, 0.35, 0.1));
    claw.userData.phase = z > 0 ? 0 : Math.PI;
    b.add(claw);
    rig.extras.push(claw);
  }
  // Tail segments arching up and forward over the body.
  const tail = new Group();
  tail.position.set(-0.7, 0.55, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 4) * Math.PI * 0.85;
    tail.add(mesh(G.sphereLow, i % 2 ? shell : dark, -Math.sin(a) * 0.55 + 0.05 * i, Math.cos(a) * -0.1 + i * 0.28, 0, 0.2 - i * 0.015, 0.18, 0.2 - i * 0.015));
  }
  const sting = mesh(G.cone, mat(0x301008, { emissive: 0xa02010, intensity: 1 }), 0.45, 1.35, 0, 0.1, 0.4, 0.1);
  sting.rotation.z = -2.4;
  tail.add(sting);
  b.add(tail);
  rig.tail = tail;
  eyes(b, 0.75, 0.75, 0.12, 0xff3020, 0.05);
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1;
    const k = i % 3;
    const leg = limb(0.75, 0.06, dark, 0.2 - k * 0.3, 0.5, side * 0.4, G.cyl);
    leg.rotation.x = side * 1.0;
    leg.userData.phase = i * 1.1;
    b.add(leg);
    rig.extras.push(leg);
  }
  return rig;
}

/** A dome-shelled beetle. The carrion beetle is bigger and carries its brood on its back. */
function beetle(color: number, size: number, brood: boolean): Rig {
  const rig = emptyRig('float', 0);
  const shell = mat(color, { rough: 0.35, metal: 0.4 });
  const dark = mat(0x1a1a14);
  const b = rig.body;
  b.scale.setScalar(size);
  b.add(mesh(G.sphere, shell, -0.1, 0.55, 0, 0.8, 0.5, 0.6));
  // The seam down the wing cases.
  b.add(mesh(G.box, dark, -0.1, 1.02, 0, 1.3, 0.04, 0.05));
  b.add(mesh(G.sphereLow, dark, 0.65, 0.45, 0, 0.3, 0.26, 0.3));
  const horn = mesh(G.cone, dark, 0.95, 0.7, 0, 0.08, 0.45, 0.08);
  horn.rotation.z = -0.9;
  b.add(horn);
  eyes(b, 0.88, 0.5, 0.14, 0x60ffd0, 0.05);
  if (brood) {
    for (const [x, z] of [[-0.4, 0.25], [-0.1, -0.3], [0.2, 0.2]] as const) b.add(mesh(G.sphere, mat(0x5a8a9a, { rough: 0.3 }), x, 1.05, z, 0.14, 0.1, 0.14));
  }
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1;
    const k = i % 3;
    const leg = limb(0.6, 0.06, dark, 0.3 - k * 0.35, 0.45, side * 0.45, G.cyl);
    leg.rotation.x = side * 1.1;
    leg.userData.phase = i * 1.3;
    b.add(leg);
    rig.extras.push(leg);
  }
  return rig;
}

/** Vultures are hunched carrion birds; harpies have a woman's head and grasping arms. */
function bird(color: number, harpy: boolean): Rig {
  const rig = emptyRig('float', 0);
  const plume = mat(color, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, plume, 0, 1.9, 0, 0.55, 0.45, 0.4));
  const head = new Group();
  head.position.set(0.5, 2.2, 0);
  if (harpy) {
    head.add(mesh(G.sphere, mat(0xd8b8a0), 0, 0, 0, 0.26, 0.3, 0.26));
    head.add(mesh(G.cone, mat(0x3a2030), -0.12, 0.05, 0, 0.3, 0.6, 0.3));
    eyes(head, 0.22, 0.05, 0.1, 0xff60ff, 0.05);
  } else {
    head.add(mesh(G.sphereLow, mat(0xd89a8a), 0, 0, 0, 0.2, 0.2, 0.2));
    const beak = mesh(G.cone, mat(0xe0c060), 0.25, -0.05, 0, 0.08, 0.3, 0.08);
    beak.rotation.z = -1.9;
    head.add(beak);
    // The bare neck ruff that makes a vulture read as a vulture.
    head.add(mesh(G.torus, mat(0xe8e0d0, { rough: 1 }), -0.15, -0.15, 0, 0.3, 0.3, 0.3));
    eyes(head, 0.15, 0.05, 0.1, 0xffe040, 0.04);
  }
  b.add(head);
  rig.head = head;
  for (const sgn of [1, -1]) {
    const wing = new Group();
    wing.position.set(0, 2.0, sgn * 0.3);
    const feather = mesh(G.cone4, mat(tint(color, -0.12), { rough: 0.95 }), -0.1, 0, sgn * 0.95, 0.55, 0.06, 1.1);
    feather.rotation.x = Math.PI / 2;
    wing.add(feather);
    wing.userData.phase = sgn > 0 ? 0 : Math.PI;
    b.add(wing);
    rig.extras.push(wing);
  }
  const tail = mesh(G.cone4, mat(tint(color, -0.2)), -0.6, 1.85, 0, 0.3, 0.5, 0.15);
  tail.rotation.z = Math.PI / 2;
  b.add(tail);
  if (harpy) {
    rig.armL = limb(0.7, 0.08, mat(0xd8b8a0), 0.2, 1.7, 0.3);
    rig.armR = limb(0.7, 0.08, mat(0xd8b8a0), 0.2, 1.7, -0.3);
    b.add(rig.armL, rig.armR);
  }
  return rig;
}

/** A glowing core with chunks of its element orbiting it. */
function elemental(color: number, kind: 'fire' | 'frost' | 'storm'): Rig {
  const rig = emptyRig('hover', 0);
  const glow = kind === 'fire' ? 0xff4010 : kind === 'frost' ? 0x60b0ff : 0xfff060;
  const core = mat(color, { emissive: glow, intensity: kind === 'storm' ? 2.2 : 1.4, rough: 0.3 });
  const b = rig.body;
  b.add(mesh(kind === 'frost' ? G.octa : G.sphereLow, core, 0, 1.6, 0, 0.6, kind === 'frost' ? 0.9 : 0.65, 0.6));
  const shardGeo = kind === 'frost' ? G.octa : kind === 'storm' ? G.cone4 : G.sphereLow;
  const shardMat = kind === 'fire' ? mat(0x3a1a10, { emissive: 0xff3000, intensity: 0.8 }) : mat(tint(color, 0.15), { emissive: glow, intensity: 1 });
  for (let i = 0; i < 5; i++) {
    const shard = mesh(shardGeo, shardMat, 0, 0, 0, 0.22, 0.3, 0.22);
    shard.userData.orbit = (Math.PI * 2 * i) / 5;
    b.add(shard);
    rig.extras.push(shard);
  }
  if (kind === 'fire') {
    const flame = mesh(G.cone, mat(0xffc040, { emissive: 0xff6010, intensity: 2.5, opacity: 0.8 }), 0, 2.4, 0, 0.4, 1.0, 0.4);
    flame.userData.phase = 0;
    b.add(flame);
  }
  eyes(b, 0.5, 1.75, 0.18, kind === 'fire' ? 0xffffa0 : 0xffffff, 0.07);
  rig.head = b;
  return rig;
}

function wisp(color: number): Rig {
  const rig = emptyRig('hover', 0);
  const b = rig.body;
  b.add(mesh(G.sphere, mat(color, { emissive: color, intensity: 2.5, opacity: 0.85 }), 0, 1.8, 0, 0.4, 0.4, 0.4));
  b.add(mesh(G.sphere, mat(0xffffff, { emissive: 0xffffff, intensity: 3 }), 0, 1.8, 0, 0.18, 0.18, 0.18));
  for (let i = 0; i < 3; i++) {
    const spark = mesh(G.octa, mat(color, { emissive: color, intensity: 3 }), 0, 0, 0, 0.1, 0.1, 0.1);
    spark.userData.orbit = (Math.PI * 2 * i) / 3;
    b.add(spark);
    rig.extras.push(spark);
  }
  return rig;
}

/** Blocky constructs. Earth golems are boulders, bone golems ribcages, iron golems plated. */
function golem(color: number, kind: 'earth' | 'bone' | 'iron'): Rig {
  const rig = emptyRig('biped', 2.4);
  const body = mat(color, kind === 'iron' ? { metal: 0.7, rough: 0.4 } : { rough: 0.95 });
  const dark = mat(tint(color, -0.2), kind === 'iron' ? { metal: 0.6, rough: 0.5 } : { rough: 1 });
  const glow = kind === 'earth' ? 0x80ff60 : kind === 'bone' ? 0x80ffff : 0xff8040;
  const b = rig.body;
  const torso = new Group();
  torso.position.y = 1.3;
  b.add(torso);
  torso.add(mesh(kind === 'earth' ? G.sphereLow : G.box, body, 0, 0.75, 0, kind === 'earth' ? 0.95 : 1.4, 1.2, kind === 'earth' ? 0.85 : 1.2));
  if (kind === 'bone') for (let i = 0; i < 4; i++) torso.add(mesh(G.halfTorus, mat(0xf0e8d0), 0.3, 0.3 + i * 0.3, 0, 0.55, 0.55, 0.9));
  if (kind === 'iron') torso.add(mesh(G.cyl, mat(0x2a2a30), 0.72, 0.85, 0, 0.3, 0.06, 0.3), mesh(G.sphere, mat(0x000000, { emissive: 0xff5010, intensity: 2 }), 0.74, 0.85, 0, 0.18, 0.18, 0.18));
  const head = new Group();
  head.position.set(0.25, 1.65, 0);
  head.add(mesh(kind === 'earth' ? G.sphereLow : G.box, dark, 0, 0, 0, 0.45, 0.4, 0.45));
  eyes(head, 0.24, 0.02, 0.12, glow, 0.07);
  torso.add(head);
  rig.head = head;
  rig.armL = limb(1.5, 0.42, body, 0, 1.2, 0.95, kind === 'earth' ? G.sphereLow : G.box);
  rig.armR = limb(1.5, 0.42, body, 0, 1.2, -0.95, kind === 'earth' ? G.sphereLow : G.box);
  for (const a of [rig.armL, rig.armR]) a.add(mesh(G.sphereLow, dark, 0, -1.55, 0, 0.42, 0.38, 0.42));
  torso.add(rig.armL, rig.armR);
  rig.legL = limb(1.3, 0.4, dark, 0, 1.3, 0.45, G.box);
  rig.legR = limb(1.3, 0.4, dark, 0, 1.3, -0.45, G.box);
  b.add(rig.legL, rig.legR);
  return rig;
}

/** A walking tree: bark trunk, branch arms, a leafy crown. The king wears a crown of antlers. */
function treant(color: number, king: boolean): Rig {
  const rig = emptyRig('biped', 2.2);
  const bark = mat(0x5a4028, { rough: 1 });
  const leaf = mat(color, { rough: 0.9 });
  const b = rig.body;
  if (king) b.scale.setScalar(1.15);
  const torso = new Group();
  torso.position.y = 1.2;
  b.add(torso);
  torso.add(mesh(G.taper, bark, 0, 0.9, 0, 0.55, 1.9, 0.55));
  const crown = new Group();
  crown.position.set(0, 2.1, 0);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    crown.add(mesh(G.sphereLow, leaf, Math.cos(a) * 0.45, 0.25 + (i % 2) * 0.2, Math.sin(a) * 0.45, 0.55, 0.45, 0.55));
  }
  crown.add(mesh(G.sphereLow, leaf, 0, 0.6, 0, 0.6, 0.55, 0.6));
  if (king) {
    for (const z of [0.3, -0.3]) {
      const antler = mesh(G.cone, mat(0xe8dcc0), 0, 1.2, z, 0.08, 1.0, 0.08);
      antler.rotation.x = z > 0 ? -0.5 : 0.5;
      crown.add(antler);
    }
  }
  torso.add(crown);
  // The face carved into the trunk.
  eyes(torso, 0.5, 1.4, 0.14, king ? 0xffe060 : 0x80ff60, 0.08);
  rig.head = crown;
  rig.armL = limb(1.4, 0.22, bark, 0, 1.4, 0.55, G.cone);
  rig.armR = limb(1.4, 0.22, bark, 0, 1.4, -0.55, G.cone);
  for (const a of [rig.armL, rig.armR]) a.add(mesh(G.sphereLow, leaf, 0, -1.4, 0, 0.3, 0.3, 0.3));
  torso.add(rig.armL, rig.armR);
  rig.legL = limb(1.2, 0.3, bark, 0, 1.2, 0.3, G.cone);
  rig.legR = limb(1.2, 0.3, bark, 0, 1.2, -0.3, G.cone);
  b.add(rig.legL, rig.legR);
  return rig;
}

/** A quadruped covered in thorns. */
function thornBeast(color: number): Rig {
  const rig = quadruped(color, { tusks: false, horns: true, bulk: 1.05 });
  const thorn = mat(0x3a2a18);
  for (let i = 0; i < 9; i++) {
    const spike = mesh(G.cone, thorn, -0.8 + (i % 5) * 0.4, 1.35 + (i % 2) * 0.1, (i < 5 ? 0.25 : -0.25), 0.07, 0.5, 0.07);
    spike.rotation.x = i < 5 ? -0.5 : 0.5;
    rig.body.add(spike);
  }
  return rig;
}

/** Stalk and cap; the cap puffs spores. */
function mushroom(color: number): Rig {
  const rig = emptyRig('hop', 1.6);
  const cap = mat(color, { rough: 0.6 });
  const stalk = mat(0xe8dcc8, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.cyl, stalk, 0, 0.8, 0, 0.35, 1.2, 0.35));
  b.add(mesh(G.sphere, cap, 0, 1.55, 0, 0.9, 0.5, 0.9));
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7;
    b.add(mesh(G.sphere, mat(0xf0e8e0), Math.cos(a) * 0.55, 1.8, Math.sin(a) * 0.55, 0.12, 0.06, 0.12));
  }
  eyes(b, 0.34, 1.0, 0.12, 0xffe060, 0.06);
  rig.legL = limb(0.45, 0.14, stalk, 0, 0.45, 0.2);
  rig.legR = limb(0.45, 0.14, stalk, 0, 0.45, -0.2);
  b.add(rig.legL, rig.legR);
  rig.head = b;
  return rig;
}

/** Long, low, armoured: a crocodile shape that surfaces from the bog. */
function lurker(color: number): Rig {
  const rig = emptyRig('biped', 2.6);
  const hide = mat(color, { rough: 0.8 });
  const belly = mat(0xa8a070, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.capsule, hide, 0, 0.55, 0, 0.45, 1.4, 0.45));
  b.children[0]?.rotateZ(Math.PI / 2);
  b.add(mesh(G.box, belly, 0, 0.3, 0, 1.6, 0.1, 0.5));
  for (let i = 0; i < 6; i++) b.add(mesh(G.cone4, mat(tint(color, -0.15)), -0.9 + i * 0.32, 0.98, 0, 0.1, 0.2, 0.1));
  const head = new Group();
  head.position.set(1.25, 0.6, 0);
  head.add(mesh(G.box, hide, 0.35, 0, 0, 0.9, 0.22, 0.4), mesh(G.box, hide, 0.35, -0.15, 0, 0.85, 0.12, 0.36));
  for (let i = 0; i < 4; i++) head.add(mesh(G.cone4, mat(0xf0e8d0), 0.05 + i * 0.2, -0.08, 0.19, 0.04, 0.12, 0.04), mesh(G.cone4, mat(0xf0e8d0), 0.05 + i * 0.2, -0.08, -0.19, 0.04, 0.12, 0.04));
  eyes(head, 0.05, 0.16, 0.14, 0xffd020, 0.06);
  b.add(head);
  rig.head = head;
  const tail = new Group();
  tail.position.set(-1.2, 0.55, 0);
  const t = mesh(G.cone, hide, -0.6, 0, 0, 0.3, 1.3, 0.3);
  t.rotation.z = Math.PI / 2;
  tail.add(t);
  b.add(tail);
  rig.tail = tail;
  rig.legL = limb(0.4, 0.14, hide, 0.6, 0.4, 0.4);
  rig.legR = limb(0.4, 0.14, hide, 0.6, 0.4, -0.4);
  rig.armL = limb(0.4, 0.14, hide, -0.6, 0.4, 0.4);
  rig.armR = limb(0.4, 0.14, hide, -0.6, 0.4, -0.4);
  b.add(rig.legL, rig.legR, rig.armL, rig.armR);
  return rig;
}

/** Winged stone crouched on its haunches until it wakes. */
function gargoyle(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.08), legs: tint(color, -0.15), hunch: 0.5, bulk: 1.05, armLength: 1.3 });
  for (const z of [0.25, -0.25]) {
    const horn = mesh(G.cone, mat(tint(color, -0.25)), -0.05, 0.45, z, 0.08, 0.45, 0.08);
    horn.rotation.x = z > 0 ? -0.6 : 0.6;
    rig.head?.add(horn);
  }
  if (rig.head) eyes(rig.head, 0.36, 0.05, 0.14, 0xff6020, 0.06);
  for (const sgn of [1, -1]) {
    const wing = new Group();
    wing.position.set(-0.3, 2.4, sgn * 0.35);
    const membrane = mesh(G.cone4, mat(tint(color, -0.1)), -0.3, 0.2, sgn * 0.8, 0.8, 0.07, 0.9);
    membrane.rotation.x = Math.PI / 2;
    wing.add(membrane);
    wing.userData.phase = sgn > 0 ? 0 : Math.PI;
    rig.body.add(wing);
  }
  return rig;
}

/** A treasure chest with a tongue and a lid full of teeth. */
function mimic(color: number): Rig {
  const rig = emptyRig('hop', 1.4);
  const wood = mat(color, { rough: 0.9 });
  const band = mat(0xc8a040, { metal: 0.7, rough: 0.4 });
  const b = rig.body;
  b.add(mesh(G.box, wood, 0, 0.45, 0, 1.3, 0.7, 0.9), mesh(G.box, band, 0, 0.45, 0, 1.34, 0.12, 0.94));
  const lid = new Group();
  lid.position.set(-0.65, 0.8, 0);
  lid.add(mesh(G.box, wood, 0.65, 0.18, 0, 1.3, 0.35, 0.9), mesh(G.box, band, 0.65, 0.18, 0, 1.34, 0.08, 0.94));
  for (let i = 0; i < 6; i++) lid.add(mesh(G.cone4, mat(0xf0e8d0), 0.2 + i * 0.2, -0.05, 0.4, 0.05, 0.16, 0.05), mesh(G.cone4, mat(0xf0e8d0), 0.2 + i * 0.2, -0.05, -0.4, 0.05, 0.16, 0.05));
  lid.rotation.z = 0.35;
  b.add(lid);
  rig.head = lid;
  const tongue = mesh(G.capsule, mat(0xc03040, { rough: 0.4 }), 0.75, 0.85, 0, 0.12, 0.5, 0.18);
  tongue.rotation.z = -1.2;
  b.add(tongue);
  eyes(b, 0.55, 0.95, 0.25, 0xffe040, 0.07);
  rig.legL = limb(0.35, 0.12, wood, 0.4, 0.2, 0.3);
  rig.legR = limb(0.35, 0.12, wood, -0.4, 0.2, -0.3);
  b.add(rig.legL, rig.legR);
  return rig;
}

function mummy(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.06), legs: tint(color, -0.1), hunch: 0.2 });
  const wrap = mat(tint(color, 0.08), { rough: 1 });
  // Loose bandage strips trailing from the arms.
  for (const a of [rig.armL, rig.armR]) {
    if (!a) continue;
    const strip = mesh(G.box, wrap, 0.1, -0.9, 0, 0.05, 0.6, 0.12);
    strip.rotation.z = 0.3;
    a.add(strip);
  }
  if (rig.head) eyes(rig.head, 0.36, 0.05, 0.13, 0x60ffa0, 0.06);
  if (rig.armL) rig.armL.rotation.z = -1.2;
  if (rig.armR) rig.armR.rotation.z = -1.2;
  return rig;
}

function lizardman(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.12), legs: tint(color, -0.18), hunch: 0.25 });
  if (rig.head) {
    const snout = mesh(G.cone, mat(color), 0.45, -0.05, 0, 0.2, 0.5, 0.2);
    snout.rotation.z = -Math.PI / 2;
    rig.head.add(snout);
    eyes(rig.head, 0.3, 0.12, 0.2, 0xffe040, 0.05);
  }
  const tail = new Group();
  tail.position.set(-0.4, 1.2, 0);
  const t = mesh(G.cone, mat(tint(color, -0.12)), -0.5, -0.2, 0, 0.18, 1.1, 0.18);
  t.rotation.z = Math.PI / 2 + 0.5;
  tail.add(t);
  rig.body.add(tail);
  rig.tail = tail;
  rig.armR?.add(mesh(G.cyl, mat(0x6b4a2a), 0.1, -0.9, 0, 0.04, 2.0, 0.04), mesh(G.cone4, mat(0xa0a8b0, { metal: 0.6 }), 0.1, 0.15, 0, 0.08, 0.3, 0.08));
  return rig;
}

/** Robed and hooded, hands glowing with the fire it is about to call down. */
function cultist(color: number): Rig {
  const rig = humanoid({ skin: 0x1a1414, torso: color, legs: 0x1a1010, robe: tint(color, -0.1) });
  const hood = mesh(G.cone, mat(tint(color, -0.15)), -0.05, 0.25, 0, 0.5, 0.8, 0.5);
  rig.head?.add(hood);
  if (rig.head) eyes(rig.head, 0.34, 0, 0.12, 0xff4020, 0.06);
  for (const a of [rig.armL, rig.armR]) a?.add(mesh(G.sphere, mat(0xff8030, { emissive: 0xff4010, intensity: 2.5 }), 0, -1.25, 0, 0.16, 0.16, 0.16));
  return rig;
}

/** Hellspawn: horned, hooved and on fire, built to run you down. */
function demon(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.15), legs: 0x2a1410, bulk: 1.25, hunch: 0.35, armLength: 1.35 });
  for (const z of [0.25, -0.25]) {
    const horn = mesh(G.cone, mat(0x1a1010), 0.1, 0.45, z, 0.1, 0.7, 0.1);
    horn.rotation.x = z > 0 ? -0.7 : 0.7;
    horn.rotation.z = -0.5;
    rig.head?.add(horn);
  }
  if (rig.head) eyes(rig.head, 0.36, 0.05, 0.14, 0xffd020, 0.07);
  for (let i = 0; i < 3; i++) {
    const flame = mesh(G.cone, mat(0xffa030, { emissive: 0xff5010, intensity: 2.5, opacity: 0.8 }), -0.3, 2.3 + i * 0.1, (i - 1) * 0.3, 0.15, 0.5, 0.15);
    rig.body.add(flame);
  }
  return rig;
}

function frostGiant(color: number): Rig {
  const rig = humanoid({ skin: color, torso: 0x5a6a80, legs: 0x3a4a5a, bulk: 1.7, hunch: 0.1, armLength: 1.45 });
  // An icy beard and shoulder spikes.
  rig.head?.add(mesh(G.cone, mat(0xe8f4ff, { emissive: 0x4080c0, intensity: 0.4 }), 0.3, -0.35, 0, 0.3, 0.6, 0.35));
  if (rig.head) eyes(rig.head, 0.38, 0.08, 0.15, 0x80d0ff, 0.07);
  for (const z of [0.9, -0.9]) {
    for (let i = 0; i < 3; i++) {
      const spike = mesh(G.octa, mat(0xc8e8ff, { emissive: 0x3070c0, intensity: 0.8, rough: 0.2 }), -0.1 + i * 0.15, 2.95 + i * 0.1, z, 0.12, 0.4, 0.12);
      rig.body.add(spike);
    }
  }
  rig.armR?.add(mesh(G.cyl, mat(0x6a5a4a), 0.1, -1.0, 0, 0.12, 2.4, 0.12), mesh(G.box, mat(0xa8c8e0, { metal: 0.5, rough: 0.3 }), 0.1, 0.25, 0, 0.5, 0.5, 0.35));
  return rig;
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
