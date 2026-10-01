import type { ClassId, EnemyTypeId, MinionTypeId } from '@rune/shared';
import { Color, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { compiledRig } from './rigs/compile.js';
import { emptyRig, extra, eyes, G, limb, mat, mesh, strut, tint, tri, type Rig, type Vec3 } from './rigs/parts.js';

export { mat, tint, uniqueMaterials, type Rig } from './rigs/parts.js';
export { beginRigFrame, driveRig, rigAttack, rigHit, rigReset, rigSpawn, rigWindup, type RigDrive } from './rigs/motion.js';
import { motion, type MotionProfile } from './rigs/motion.js';

/**
 * Procedural low-poly character models, one builder per monster type. Every model is built facing
 * +x with its feet at y = 0 and a nominal radius of 1, then scaled to the entity's collision radius.
 * Limbs hang off pivot groups so the animator (rigs/motion.ts) can swing them without knowing the
 * model's shape; each builder picks the motion profile its type moves with. The game draws the
 * compiled form (rigs/compile.ts); the raw builders are exported for the .glb export.
 */

const HERO = motion('biped', 'claw', 'topple', 0.4, { cast: 'cast', shoot: 'shoot' });

interface HumanoidSpec {
  skin: number;
  torso: number;
  legs: number;
  robe?: number;
  bulk?: number;
  hunch?: number;
  armLength?: number;
  profile?: MotionProfile;
}

/** Shared humanoid skeleton: players, zombies and skeletons are all variations of this. */
function humanoid(spec: HumanoidSpec): Rig {
  const rig = emptyRig(spec.profile ?? HERO);
  const b = rig.body;
  const bulk = spec.bulk ?? 1;
  const skin = mat(spec.skin);
  const torsoMat = mat(spec.torso);
  const legMat = mat(spec.legs);
  const hip = 1.35;
  rig.legLength = hip;

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

/** The raw, uncompiled model of a player class. */
export function buildPlayer(cls: ClassId, color: number): Rig {
  switch (cls) {
    case 'warrior': {
      const rig = humanoid({ skin: 0xd8b08c, torso: 0x8a8f99, legs: 0x4a3a2a, bulk: 1.15 });
      const metal = mat(0xb8bec8, { metal: 0.2, rough: 0.45 });
      rig.head?.add(mesh(G.sphere, metal, 0, 0.1, 0, 0.47, 0.4, 0.47));
      rig.head?.add(mesh(G.cone, mat(0xe8dcc0), -0.05, 0.45, 0.4, 0.08, 0.4, 0.08));
      rig.head?.add(mesh(G.cone, mat(0xe8dcc0), -0.05, 0.45, -0.4, 0.08, 0.4, 0.08));
      rig.armL?.add(mesh(G.box, mat(color, { metal: 0.15 }), 0.25, -0.8, 0.12, 0.12, 0.95, 0.75));
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
      rig.body.children[0]?.add(mesh(G.box, mat(0xd8b050, { metal: 0.2, rough: 0.5 }), 0.35, 0.95, 0, 0.05, 1.1, 0.25));
      const halo = mesh(G.torus, mat(0xffe9a0, { emissive: 0xffd060, intensity: 1.8 }), 0, 0.6, 0, 0.42, 0.42, 0.42);
      halo.rotation.x = Math.PI / 2;
      rig.head?.add(halo);
      const mace = new Group();
      mace.position.set(0, -1.1, 0);
      mace.add(mesh(G.cyl, mat(0x5a3d22), 0, 0.3, 0, 0.07, 0.9, 0.07), mesh(G.octa, mat(0xd8b050, { metal: 0.2 }), 0, 0.85, 0, 0.26, 0.26, 0.26));
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
        extra(rig, orb, 'orbit');
      }
      const staff = new Group();
      staff.position.set(0.05, -1.1, 0);
      staff.add(mesh(G.cyl, mat(0x3a3028), 0, 0.6, 0, 0.07, 2.3, 0.07), mesh(G.sphere, mat(0xe8e0d0), 0, 1.85, 0, 0.24, 0.26, 0.22));
      rig.armR?.add(staff);
      return rig;
    }
  }
}

const SPIDER = motion('skitter', 'bite', 'curl', 0.2);

/** The raw, uncompiled model of a monster type: separate meshes on pivot groups. */
export function buildEnemy(type: EnemyTypeId, color: number): Rig {
  switch (type) {
    case 'chaser': {
      // A fallen-style imp: hunched, big horned head, glowing eyes, short hopping legs and a tail.
      const rig = emptyRig(motion('hop', 'claw', 'topple', 0.25));
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
      rig.armR.add(mesh(G.box, mat(0x9a9aa0, { metal: 0.2, rough: 0.5 }), 0.35, -0.8, 0, 0.7, 0.08, 0.2));
      b.add(rig.armL, rig.armR);
      rig.legL = limb(0.6, 0.16, dark, 0, 0.6, 0.28);
      rig.legR = limb(0.6, 0.16, dark, 0, 0.6, -0.28);
      rig.legLength = 0.6;
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
      const rig = humanoid({ skin: 0x7a9a4a, torso: 0x6b4a2a, legs: 0x4a3420, hunch: 0.2, profile: motion('biped', 'claw', 'topple', 0.3, { ability: 'shoot', shoot: 'shoot' }) });
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
      const rig = emptyRig(motion('float', 'pulse', 'fall', 0.3));
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
        b.add(t);
        extra(rig, t, 'tentacle', a);
      }
      return rig;
    }
    case 'plague_rat':
      return rat(color);
    case 'blood_bat':
      return bat(color);
    case 'spiderling':
      return spider(color, 0.8, false, SPIDER);
    case 'venom_spider':
      return spider(color, 1, false, { ...SPIDER, ability: 'spit', shoot: 'spit' });
    case 'broodmother':
      return spider(color, 1.1, true, { ...SPIDER, weight: 0.8, ability: 'leap', cast: 'pulse', shoot: 'spit' });
    case 'tusked_boar':
      return quadruped(color, { tusks: true, horns: false, bulk: 1 }, motion('quad', 'ram', 'roll', 0.6, { ability: 'charge' }));
    case 'horned_charger':
      return quadruped(color, { tusks: false, horns: true, bulk: 1.25 }, motion('quad', 'ram', 'roll', 0.75, { ability: 'charge' }));
    case 'charger':
      // Stand-in while its model file streams in: a heavy hornless beast, never a humanoid.
      return quadruped(color, { tusks: false, horns: false, bulk: 1.4 }, motion('quad', 'ram', 'roll', 0.8, { ability: 'charge' }));
    case 'bloated_corpse': {
      const rig = humanoid({ skin: color, torso: tint(color, -0.1), legs: 0x3a3a2a, bulk: 1.3, hunch: 0.3, profile: motion('biped', 'claw', 'collapse', 0.8) });
      rig.body.add(mesh(G.sphereLow, mat(tint(color, 0.08), { rough: 0.5 }), 0.25, 1.75, 0, 0.75, 0.7, 0.7));
      for (const [y, z] of [[1.9, 0.35], [1.6, -0.3], [2.1, -0.1]] as const) rig.body.add(mesh(G.sphere, mat(0x9aba4a, { emissive: 0x405a10, intensity: 0.6 }), 0.8, y, z, 0.14, 0.14, 0.14));
      return rig;
    }
    case 'volatile': {
      const rig = imp(color, 'volatile', motion('hop', 'burst', 'splat', 0.15));
      rig.root.scale.multiplyScalar(0.9);
      return rig;
    }
    case 'fallen_shaman':
      return imp(color, 'shaman', motion('hop', 'claw', 'topple', 0.3, { ability: 'cast', cast: 'cast' }));
    case 'sand_burrower':
      return worm(color, 1, 0.5);
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
      return ooze(type);
    case 'infernal':
      return infernal(color);
    case 'dire_wolf':
      return wolf(color, { fire: false, bulk: 1 }, motion('quad', 'bite', 'roll', 0.35));
    case 'hellhound':
      return wolf(color, { fire: true, bulk: 1.1 }, motion('quad', 'bite', 'roll', 0.45, { ability: 'spit', shoot: 'spit' }));
    case 'grave_hound':
      // Stand-in while its model file streams in, so it never pops from a humanoid to a dog.
      return wolf(color, { fire: false, bulk: 1.2 }, motion('quad', 'bite', 'roll', 0.45, { ability: 'leap' }));
    case 'giant_scorpion':
      return scorpion(color, 1);
    case 'thorn_beast':
      return thornBeast(color);
    case 'cave_spider':
      return spider(color, 0.85, false, SPIDER);
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
    case 'frost_slime':
      return ooze(type);
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
      return worm(color, 1.2, 0.75);
    case 'sand_wyrm':
      return worm(color, 1.6, 1);
    case 'mummy':
      return mummy(color);
    case 'ice_wraith':
      return ghost(color, true);
    case 'imp': {
      const rig = imp(color, 'imp', motion('hop', 'claw', 'topple', 0.2, { ability: 'shoot', cast: 'cast', shoot: 'shoot' }));
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
      const rig = humanoid({ skin: tint(color, 0.1), torso: color, legs: tint(color, -0.25), profile: motion('biped', 'claw', 'topple', 0.4, { ability: 'slam', cast: 'cast', shoot: 'shoot' }) });
      return rig;
    }
  }
}

/** Fallen-style small demons: the volatile carries a lit fuse, the shaman a staff, the imp horns and stubby wings. */
function imp(color: number, kind: 'volatile' | 'shaman' | 'imp', profile: MotionProfile): Rig {
  const rig = emptyRig(profile);
  // Their own colours read as toys; these are burnt and blood-dark, lit from inside where they glow.
  const hue = kind === 'volatile' ? 0xb06a30 : kind === 'imp' ? 0x8a2a1a : color;
  const skin = kind === 'imp' ? mat(hue, { emissive: 0x801a08, intensity: 0.25, rough: 0.7 }) : mat(hue, { rough: 0.75 });
  const dark = mat(0x3a1410);
  const eye = mat(0xffe060, { emissive: 0xffc020, intensity: 2.5 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 0.95, 0, 0.6, 0.55, 0.55));
  const head = new Group();
  head.position.set(0.45, 1.45, 0);
  head.add(mesh(G.sphereLow, skin, 0, 0, 0, 0.5, 0.45, 0.5));
  head.add(mesh(G.sphere, eye, 0.4, 0.05, 0.18, 0.08, 0.08, 0.08), mesh(G.sphere, eye, 0.4, 0.05, -0.18, 0.08, 0.08, 0.08));
  if (kind === 'shaman') {
    // A shaman's feathered headdress, faded and filthy.
    for (let i = 0; i < 5; i++) {
      const f = mesh(G.cone4, mat(i % 2 ? 0x9a8040 : 0x3a6068), -0.1, 0.5, (i - 2) * 0.14, 0.07, 0.55, 0.07);
      f.rotation.x = (i - 2) * 0.25;
      head.add(f);
    }
  } else if (kind === 'volatile') {
    // A fuse on its head, burning, and the fire showing through cracks in its hide.
    head.add(mesh(G.cyl, dark, 0, 0.45, 0, 0.04, 0.3, 0.04), mesh(G.sphere, mat(0xffe080, { emissive: 0xffa020, intensity: 3 }), 0, 0.65, 0, 0.1, 0.1, 0.1));
    const crack = mat(0xffa040, { emissive: 0xff5a10, intensity: 2 });
    cracks(b, crack, [0, 0.95, 0], [0.6, 0.55, 0.55], BODY_CRACKS);
    cracks(head, crack, [0, 0, 0], [0.5, 0.45, 0.5], HEAD_CRACKS);
  } else {
    for (const s of [1, -1]) {
      const horn = mesh(G.cone, dark, -0.05, 0.42, s * 0.26, 0.09, 0.45, 0.09);
      horn.rotation.x = s * 0.55;
      head.add(horn);
    }
    // Wing stubs too small to fly on, folded against the back.
    for (const s of [1, -1]) {
      const stub = membraneWing(s, 0.45, dark, mat(0x4a1810, { rough: 0.9 }));
      stub.position.set(-0.35, 1.3, s * 0.25);
      stub.rotation.set(-s * 0.9, -s * 0.6, 0.4);
      b.add(stub);
    }
  }
  b.add(head);
  rig.head = head;
  rig.armL = limb(0.75, 0.13, skin, 0.3, 1.2, 0.5);
  rig.armR = limb(0.75, 0.13, skin, 0.3, 1.2, -0.5);
  if (kind === 'shaman') rig.armR.add(mesh(G.cyl, mat(0x5a3a20), 0.1, -0.6, 0, 0.05, 1.8, 0.05), mesh(G.octa, mat(0xff6030, { emissive: 0xff3010, intensity: 1.5 }), 0.1, 0.35, 0, 0.14, 0.18, 0.14));
  b.add(rig.armL, rig.armR);
  rig.legL = limb(0.6, 0.16, dark, 0, 0.6, 0.28);
  rig.legR = limb(0.6, 0.16, dark, 0, 0.6, -0.28);
  rig.legLength = 0.6;
  b.add(rig.legL, rig.legR);
  return rig;
}

/** Crack paths over an ellipsoid, as (yaw, elevation) points: yaw 0 faces forward (+x). */
type CrackPath = readonly (readonly [number, number])[];
const BODY_CRACKS: readonly CrackPath[] = [
  [[0.2, 0.7], [0.45, 0.3], [0.3, -0.1], [0.55, -0.45]],
  [[-0.5, 0.6], [-0.25, 0.2], [-0.55, -0.2]],
  [[1.4, 0.5], [1.1, 0.1], [1.35, -0.3]],
  [[-1.5, 0.4], [-1.2, 0], [-1.45, -0.4]],
  [[2.6, 0.5], [2.9, 0.1], [2.5, -0.3]],
];
const HEAD_CRACKS: readonly CrackPath[] = [[[0.9, 0.7], [0.6, 0.35], [0.95, 0.1]], [[-0.9, 0.6], [-0.6, 0.3]]];

/** Glowing seams over an ellipsoid of radii `r` at `c`: thin rods between points on its surface. */
function cracks(parent: Object3D, material: MeshStandardMaterial, c: Vec3, r: Vec3, paths: readonly CrackPath[]): void {
  const at = (yaw: number, elev: number): Vec3 => [c[0] + r[0] * 1.03 * Math.cos(yaw) * Math.cos(elev), c[1] + r[1] * 1.03 * Math.sin(elev), c[2] + r[2] * 1.03 * Math.sin(yaw) * Math.cos(elev)];
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (a && b) parent.add(strut(G.box, material, at(a[0], a[1]), at(b[0], b[1]), 0.035));
    }
  }
}

function rat(color: number): Rig {
  const rig = emptyRig(motion('scurry', 'bite', 'roll', 0.15));
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
  rig.legL = limb(0.4, 0.1, fur, 0.3, 0.4, 0.3);
  rig.legR = limb(0.4, 0.1, fur, -0.3, 0.4, -0.3);
  rig.legLength = 0.4;
  b.add(rig.legL, rig.legR);
  return rig;
}

function bat(color: number): Rig {
  const rig = emptyRig(motion('fly', 'bite', 'fall', 0.1));
  const skin = mat(color, { rough: 0.7 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 1.8, 0, 0.45, 0.45, 0.4));
  b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xffe040, intensity: 2 }), 0.38, 1.9, 0.14, 0.06, 0.06, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xffe040, intensity: 2 }), 0.38, 1.9, -0.14, 0.06, 0.06, 0.06));
  for (const z of [0.16, -0.16]) {
    const ear = mesh(G.cone4, skin, 0.1, 2.25, z, 0.08, 0.3, 0.06);
    ear.rotation.x = z > 0 ? -0.3 : 0.3;
    b.add(ear);
  }
  for (const sgn of [1, -1]) {
    // Laid flat and out to the side, so a beat raises and lowers it.
    const wing = membraneWing(sgn, 1, mat(0x5a2a2a, { rough: 0.8 }), mat(0x4a1a22, { rough: 0.9 }));
    wing.position.set(0, 1.85, sgn * 0.35);
    b.add(wing);
    extra(rig, wing, 'wing', 0, sgn);
  }
  return rig;
}

function toward(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/**
 * A bat's wing, laid flat along +z (-z when `sgn` is -1) from a shoulder at the origin: an arm to
 * the wrist, three finger bones fanned from it, and membrane panels between them whose trailing
 * edge dips in between the finger tips.
 */
function membraneWing(sgn: number, span: number, bone: MeshStandardMaterial, skin: MeshStandardMaterial): Group {
  const wing = new Group();
  const at = (x: number, y: number, z: number): Vec3 => [x * span, y * span, z * span * sgn];
  const shoulder = at(0, 0, 0);
  const wrist = at(0.12, 0.04, 0.5);
  const tips = [at(0.28, 0, 1.3), at(-0.12, -0.03, 1.25), at(-0.5, -0.05, 0.85)];
  const hip = at(-0.42, -0.02, 0.05);
  wing.add(strut(G.cyl, bone, shoulder, wrist, 0.045 * span));
  for (const t of tips) wing.add(strut(G.cone, bone, wrist, t, 0.028 * span));
  const edge = [...tips, hip];
  for (let i = 0; i + 1 < edge.length; i++) {
    const a = edge[i];
    const c = edge[i + 1];
    if (!a || !c) continue;
    // The scallop: the edge between two finger tips is pulled a third of the way in to the wrist.
    const mid = toward(wrist, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], 0.68);
    wing.add(tri(skin, wrist, a, mid, 0.02 * span), tri(skin, wrist, mid, c, 0.02 * span));
  }
  wing.add(tri(skin, shoulder, wrist, hip, 0.02 * span));
  return wing;
}

function spider(color: number, size: number, queen: boolean, profile: MotionProfile): Rig {
  const rig = emptyRig(profile);
  rig.legLength = 1.1;
  const shell = mat(color, { rough: 0.5 });
  const b = rig.body;
  b.scale.setScalar(size);
  b.add(mesh(G.sphereLow, shell, -0.45, 0.75, 0, 0.75, 0.6, 0.65));
  b.add(mesh(G.sphereLow, shell, 0.35, 0.65, 0, 0.4, 0.35, 0.4));
  for (let i = 0; i < 4; i++) b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xff2020, intensity: 2 }), 0.72, 0.8 + (i % 2) * 0.08, (i < 2 ? 1 : -1) * (0.08 + (i % 2) * 0.1), 0.05, 0.05, 0.05));
  // A venom mark on the back.
  b.add(mesh(G.sphere, mat(0xc02020, { emissive: 0x600000, intensity: 0.8 }), -0.45, 1.3, 0, 0.3, 0.08, 0.2));
  const legMat = mat(tint(color, -0.1));
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? 1 : -1;
    const k = i % 4;
    const leg = kneedLeg(legMat, 0.25 - k * 0.22, 0.75, side * 0.3, side, 0.55, 0.07);
    // Fanned wide front to back, so the eight read as a spider's and not a comb.
    leg.rotation.y = (k - 1.5) * 0.6 * side;
    leg.userData.k = k;
    leg.userData.front = k === 0;
    b.add(leg);
    extra(rig, leg, 'leg', i * 0.8, side);
  }
  if (queen) {
    for (const [x, z] of [[-1.1, 0.4], [-1.2, -0.3], [-0.9, -0.6]] as const) b.add(mesh(G.sphere, mat(0xb8a888, { rough: 0.6 }), x, 0.45, z, 0.28, 0.32, 0.28));
    b.add(mesh(G.cone, mat(0x201810), 0.7, 0.5, 0.12, 0.06, 0.4, 0.06), mesh(G.cone, mat(0x201810), 0.7, 0.5, -0.12, 0.06, 0.4, 0.06));
  }
  return rig;
}

/**
 * Leg splay about x: positive tips a leg on the +z side toward -z, so outward is `-side`. The order
 * puts yaw outermost, so the fan and the stride both turn about the vertical.
 */
function splay(leg: Object3D, side: number, angle: number): void {
  leg.rotation.order = 'YXZ';
  leg.rotation.x = -side * angle;
}

/**
 * An insect leg: a femur rising out from the hip to a knee, a tibia down to the ground. The pivot
 * swings it about z and lifts it about x like the plain legs; `userData.foot` is the tip, for tests.
 */
function kneedLeg(material: MeshStandardMaterial, x: number, y: number, z: number, side: number, femur: number, thick: number): Group {
  const pivot = new Group();
  pivot.position.set(x, y, z);
  // The femur rises about 18 degrees above level; the knee turns the tibia down to 23 from vertical.
  const up = 1.9;
  const down = 0.4;
  splay(pivot, side, up);
  const tibia = (y + femur * -Math.cos(up)) / Math.cos(down);
  // In the pivot's frame the knee turns the tibia by up - down about x; no group, since every group compiles to a bone.
  const foot: Vec3 = [0, -femur - tibia * Math.cos(up - down), -side * tibia * Math.sin(up - down)];
  pivot.add(strut(G.cyl, material, [0, 0, 0], [0, -femur, 0], thick));
  pivot.add(strut(G.cone, material, [0, -femur, 0], foot, thick * 0.9));
  pivot.add(mesh(G.sphereLow, material, 0, -femur, 0, thick * 1.3, thick * 1.3, thick * 1.3));
  pivot.userData.length = femur + tibia;
  pivot.userData.foot = foot;
  return pivot;
}

function quadruped(color: number, opts: { tusks: boolean; horns: boolean; bulk: number }, profile: MotionProfile): Rig {
  const rig = emptyRig(profile);
  rig.legLength = 0.6;
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

function worm(color: number, size: number, weight: number): Rig {
  const rig = emptyRig(motion('slither', 'slam', 'slump', weight, { burrows: true, cast: 'slam', shoot: 'slam' }));
  const skin = mat(color, { rough: 0.8 });
  const b = rig.body;
  b.scale.setScalar(size);
  // A chain of segments, each hung off the one below, so bending one bends everything above it.
  let parent: Object3D = b;
  let px = 0;
  let py = 0;
  for (let i = 0; i < 5; i++) {
    const a = i * 0.42;
    const x = -0.8 + Math.sin(a) * 0.9;
    const y = 0.35 + i * 0.42;
    const seg = new Group();
    seg.position.set(x - px, y - py, 0);
    seg.add(mesh(G.sphereLow, i % 2 ? skin : mat(tint(color, -0.08)), 0, 0, 0, 0.55 - i * 0.04, 0.4, 0.55 - i * 0.04));
    parent.add(seg);
    extra(rig, seg, 'segment', i);
    parent = seg;
    px = x;
    py = y;
  }
  const maw = new Group();
  maw.position.set(0.35 - px, 2.35 - py, 0);
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI * 2 * i) / 4;
    const fang = mesh(G.cone, mat(0xf0e0c0), Math.cos(a) * 0.2, 0.2, Math.sin(a) * 0.2, 0.08, 0.5, 0.08);
    fang.rotation.z = -0.4;
    maw.add(fang);
  }
  parent.add(maw);
  rig.head = maw;
  return rig;
}

function spire(color: number): Rig {
  const rig = emptyRig(motion('still', 'pulse', 'crumble', 1));
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
  const rig = emptyRig(motion('still', 'pulse', 'crumble', 1));
  const wood = mat(0x6b4a2a, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.cyl, wood, 0, 1.3, 0, 0.45, 2.6, 0.45));
  for (let i = 0; i < 3; i++) {
    b.add(mesh(G.box, mat(i % 2 ? 0x8a2a1a : 0x3a6a8a), 0.42, 0.55 + i * 0.8, 0, 0.1, 0.35, 0.5));
    b.add(mesh(G.sphere, mat(0x000000, { emissive: 0xffa020, intensity: 2 }), 0.48, 0.7 + i * 0.8, 0.15, 0.06, 0.06, 0.06), mesh(G.sphere, mat(0x000000, { emissive: 0xffa020, intensity: 2 }), 0.48, 0.7 + i * 0.8, -0.15, 0.06, 0.06, 0.06));
  }
  const flame = mesh(G.cone, mat(color, { emissive: 0xff6010, intensity: 2.5, opacity: 0.85 }), 0, 3.0, 0, 0.35, 0.9, 0.35);
  b.add(flame);
  extra(rig, flame, 'flame');
  return rig;
}

function ghost(color: number, banshee: boolean): Rig {
  const rig = emptyRig(banshee ? motion('hover', 'claw', 'dissolve', 0.2, { ability: 'scream', cast: 'scream', shoot: 'scream' }) : motion('hover', 'claw', 'dissolve', 0.25, { cast: 'cast' }));
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
      hood.add(strand);
      extra(rig, strand, 'strand', i);
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
  const rig = emptyRig(motion('hop', 'bite', 'roll', 0.5, { ability: 'spit', shoot: 'spit', cast: 'spit' }));
  rig.legLength = 0.55;
  // Bog-dark with small hooded eyes; the brighter green and big eyes read as a cartoon frog.
  const skin = mat(0x4a5a2a, { rough: 0.6 });
  const b = rig.body;
  b.add(mesh(G.sphereLow, skin, 0, 0.75, 0, 0.9, 0.65, 0.85));
  b.add(mesh(G.sphereLow, mat(0x8a8660), 0.3, 0.6, 0, 0.6, 0.45, 0.7));
  for (const z of [0.36, -0.36]) {
    b.add(mesh(G.sphereLow, skin, 0.5, 1.3, z, 0.15, 0.12, 0.15));
    b.add(mesh(G.sphere, mat(0xc0a030, { emissive: 0x806000, intensity: 0.8 }), 0.58, 1.32, z, 0.11, 0.11, 0.11), mesh(G.sphere, mat(0x141008), 0.67, 1.34, z, 0.04, 0.06, 0.06));
  }
  // Warts that ooze.
  for (let i = 0; i < 6; i++) b.add(mesh(G.sphere, mat(0x6a7a30, { emissive: 0x2a4008, intensity: 0.6 }), -0.5 + (i % 3) * 0.3, 1.2 + (i % 2) * 0.1, (i < 3 ? 1 : -1) * 0.35, 0.1, 0.1, 0.1));
  rig.legL = limb(0.55, 0.2, skin, -0.4, 0.55, 0.55);
  rig.legR = limb(0.55, 0.2, skin, -0.4, 0.55, -0.55);
  // The webbed pad rests on the leg's tip, so it sits on the ground and not in it.
  for (const l of [rig.legL, rig.legR]) l.add(mesh(G.sphereLow, skin, 0.12, -0.49, 0, 0.2, 0.06, 0.16));
  b.add(rig.legL, rig.legR);
  return rig;
}

/** Body colour and inner glow per slime: muted, lit a little from inside, never candy. */
const SLIMES = {
  ooze: { color: 0x4a7a5a, glow: 0x103020, intensity: 0.3 },
  oozeling: { color: 0x5a8a6a, glow: 0x103020, intensity: 0.3 },
  fire_slime: { color: 0xa04020, glow: 0xff4010, intensity: 0.2 },
  frost_slime: { color: 0x5a8aa8, glow: 0x2050a0, intensity: 0.25 },
} as const;

function ooze(kind: keyof typeof SLIMES): Rig {
  const rig = emptyRig(motion('bounce', 'ram', 'splat', 0.45));
  const { color, glow, intensity } = SLIMES[kind];
  const b = rig.body;
  b.add(mesh(G.sphereLow, mat(color, { opacity: 0.75, emissive: glow, intensity, rough: 0.3 }), 0, 0.8, 0, 1, 0.8, 1));
  b.add(mesh(G.sphereLow, mat(tint(color, -0.15), { emissive: glow, intensity }), 0, 0.75, 0, 0.45, 0.4, 0.45));
  // What it has eaten, half dissolved: a skull and a couple of bones, instead of a cartoon face.
  const bone = mat(0xb0a890, { rough: 0.9 });
  b.add(mesh(G.sphereLow, bone, 0.35, 0.95, 0.15, 0.2, 0.18, 0.18), mesh(G.sphere, mat(0x2a2418), 0.52, 0.98, 0.2, 0.05, 0.05, 0.05), mesh(G.sphere, mat(0x2a2418), 0.5, 0.98, 0.07, 0.05, 0.05, 0.05));
  b.add(strut(G.cyl, bone, [-0.4, 0.5, -0.3], [0.1, 0.75, -0.45], 0.05), strut(G.cyl, bone, [-0.3, 1.0, 0.35], [-0.6, 0.7, 0.1], 0.04));
  return rig;
}

function infernal(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.2), legs: 0x2a1a10, bulk: 1.5, hunch: 0.15, armLength: 1.4, profile: motion('biped', 'claw', 'collapse', 1, { ability: 'cast', cast: 'cast', shoot: 'cast' }) });
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
    extra(rig, ember, 'orbit');
  }
  return rig;
}

// ---------------------------------------------------------------------------------------------
// Second roster: beasts, insects, flyers, elementals, golems and ambushers. All procedural, since
// the KayKit packs have no animals; each is a handful of primitives with its own silhouette.

/** Long-snouted four-legged hunter. Hellhounds smoulder, with ember cracks and a burning mane. */
function wolf(color: number, opts: { fire: boolean; bulk: number }, profile: MotionProfile): Rig {
  const rig = emptyRig(profile);
  // Long legs: a small fast hunter on short ones could only slide.
  const L = 0.85;
  rig.legLength = L;
  const hue = opts.fire ? 0x6a1a10 : color;
  const fur = opts.fire ? mat(hue, { emissive: 0x801800, intensity: 0.2, rough: 0.9 }) : mat(hue, { rough: 0.95 });
  const dark = mat(tint(hue, -0.12), { rough: 0.95 });
  const b = rig.body;
  b.scale.setScalar(opts.bulk);
  const y = L + 0.25;
  // A capsule is its length plus two radii long: 0.45 makes a 1.35 body, so the head sits clear of it.
  b.add(mesh(G.capsule, fur, -0.1, y, 0, 0.36, 0.45, 0.34));
  b.children[b.children.length - 1]?.rotateZ(Math.PI / 2);
  // Deep chest and raised shoulders: the head hangs below them, which is what makes it a wolf.
  b.add(mesh(G.sphereLow, fur, 0.45, y + 0.05, 0, 0.42, 0.44, 0.36));
  const head = new Group();
  head.position.set(0.95, y - 0.12, 0);
  head.rotation.z = -0.2;
  head.add(mesh(G.sphereLow, fur, 0, 0, 0, 0.3, 0.26, 0.26));
  const snout = mesh(G.cone, dark, 0.42, -0.06, 0, 0.14, 0.45, 0.13);
  snout.rotation.z = -Math.PI / 2;
  head.add(snout, mesh(G.box, dark, 0.3, -0.16, 0, 0.36, 0.06, 0.16));
  for (const z of [0.13, -0.13]) {
    const ear = mesh(G.cone4, dark, -0.12, 0.26, z, 0.08, 0.26, 0.07);
    ear.rotation.z = 0.35;
    head.add(ear);
  }
  eyes(head, 0.2, 0.08, 0.13, opts.fire ? 0xffa020 : 0xffe060);
  b.add(head);
  rig.head = head;
  if (opts.fire) {
    for (let i = 0; i < 4; i++) {
      const flame = mesh(G.cone, mat(0xffa030, { emissive: 0xff5010, intensity: 2.5, opacity: 0.85 }), 0.5 - i * 0.3, y + 0.42, 0, 0.14, 0.45, 0.14);
      b.add(flame);
      extra(rig, flame, 'flame', i);
    }
    cracks(b, mat(0xff8030, { emissive: 0xff4010, intensity: 2 }), [-0.05, y, 0], [0.8, 0.36, 0.34], EMBER_CRACKS);
  }
  const tail = new Group();
  tail.position.set(-0.85, y + 0.05, 0);
  const t = mesh(G.cone, dark, -0.35, -0.12, 0, 0.12, 0.8, 0.12);
  t.rotation.z = Math.PI / 2 + 0.8;
  tail.add(t);
  b.add(tail);
  rig.tail = tail;
  rig.legL = limb(L, 0.11, dark, 0.5, L, 0.2);
  rig.legR = limb(L, 0.11, dark, 0.5, L, -0.2);
  rig.armL = limb(L, 0.12, dark, -0.5, L, 0.2);
  rig.armR = limb(L, 0.12, dark, -0.5, L, -0.2);
  for (const l of [rig.legL, rig.legR, rig.armL, rig.armR]) l.add(mesh(G.sphereLow, dark, 0.05, -L, 0, 0.1, 0.05, 0.08));
  b.add(rig.legL, rig.legR, rig.armL, rig.armR);
  return rig;
}

const EMBER_CRACKS: readonly CrackPath[] = [
  [[1.3, 0.6], [1.6, 0.2], [1.35, -0.3]],
  [[-1.3, 0.6], [-1.6, 0.2], [-1.35, -0.3]],
  [[2.2, 0.7], [2.0, 0.2], [2.3, -0.2]],
  [[-2.2, 0.7], [-2.0, 0.2], [-2.3, -0.2]],
];

/** Flat body, two raised pincers and a tail curled over its back ending in a stinger. */
function scorpion(color: number, size: number): Rig {
  const rig = emptyRig(motion('skitter', 'sting', 'curl', 0.6));
  rig.legLength = 0.75;
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
    b.add(claw);
    extra(rig, claw, 'claw', z > 0 ? 0 : Math.PI, z > 0 ? 1 : -1);
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
    splay(leg, side, Math.acos(0.48 / 0.75));
    leg.userData.k = k;
    b.add(leg);
    extra(rig, leg, 'leg', i * 1.1, side);
  }
  return rig;
}

/** A dome-shelled beetle. The carrion beetle is bigger and carries its brood on its back. */
function beetle(color: number, size: number, brood: boolean): Rig {
  const rig = emptyRig(motion('skitter', 'ram', 'curl', brood ? 0.7 : 0.3));
  rig.legLength = 0.6;
  const shell = mat(color, { rough: 0.45, metal: 0.1 });
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
    splay(leg, side, Math.acos(0.43 / 0.6));
    leg.userData.k = k;
    leg.userData.front = k === 0;
    b.add(leg);
    extra(rig, leg, 'leg', i * 1.3, side);
  }
  return rig;
}

/** Vultures are hunched carrion birds; harpies are a grimy woman's torso on a bird's wings and talons. */
function bird(color: number, harpy: boolean): Rig {
  const rig = emptyRig(harpy ? motion('fly', 'claw', 'fall', 0.4, { ability: 'shoot', shoot: 'shoot', cast: 'shoot' }) : motion('fly', 'bite', 'fall', 0.5));
  // A harpy in its own colour read as a pastel moth: dusky plumage instead.
  const feathers = harpy ? 0x5a4a52 : color;
  const plume = mat(feathers, { rough: 0.9 });
  const b = rig.body;
  const bulk = harpy ? 1 : 1.3;
  b.add(mesh(G.sphereLow, plume, 0, 1.9, 0, 0.55 * bulk, 0.45 * bulk, 0.4 * bulk));
  const head = new Group();
  if (harpy) {
    const skin = mat(0x9a8070, { rough: 0.9 });
    // Upright under the wings, so the woman reads before the bird.
    b.add(mesh(G.capsule, skin, 0.5, 1.95, 0, 0.21, 0.22, 0.2));
    head.position.set(0.58, 2.6, 0);
    head.add(mesh(G.sphere, skin, 0, 0, 0, 0.22, 0.26, 0.22));
    const hair = mat(0x241a1c, { rough: 1 });
    head.add(mesh(G.sphereLow, hair, -0.06, 0.07, 0, 0.24, 0.26, 0.25));
    for (let i = 0; i < 3; i++) {
      const lock = mesh(G.cone4, hair, -0.2, -0.25, (i - 1) * 0.13, 0.08, 0.55, 0.06);
      lock.rotation.z = Math.PI - 0.3;
      head.add(lock);
    }
    eyes(head, 0.19, 0.03, 0.09, 0xd05a40, 0.045);
  } else {
    head.position.set(0.5 * bulk, 2.2, 0);
    head.add(mesh(G.sphereLow, mat(0x9a6a60), 0, 0, 0, 0.2, 0.2, 0.2));
    const beak = mesh(G.cone, mat(0xb09850), 0.25, -0.05, 0, 0.08, 0.3, 0.08);
    beak.rotation.z = -1.9;
    head.add(beak);
    // The bare neck ruff that makes a vulture read as a vulture.
    head.add(mesh(G.torus, mat(0xb8b0a0, { rough: 1 }), -0.15, -0.15, 0, 0.3, 0.3, 0.3));
    eyes(head, 0.15, 0.05, 0.1, 0xffe040, 0.04);
  }
  b.add(head);
  rig.head = head;
  for (const sgn of [1, -1]) {
    const wing = featherWing(sgn, mat(tint(feathers, -0.1), { rough: 0.95 }), mat(harpy ? 0x6a5860 : 0x6a5a4a, { rough: 0.95 }), mat(tint(feathers, -0.18), { rough: 0.95 }));
    wing.position.set(0, 2.0, sgn * 0.3 * bulk);
    b.add(wing);
    extra(rig, wing, 'wing', 0, sgn);
  }
  const tail = mesh(G.cone4, mat(tint(feathers, -0.2)), -0.6 * bulk, 1.85, 0, 0.3, 0.5, 0.15);
  tail.rotation.z = Math.PI / 2;
  b.add(tail);
  if (harpy) {
    // Talons, raked forward by the claw and dropped slack by the fall.
    const scale = mat(0x4a3a30, { rough: 0.9 });
    const claw = mat(0xb8a890, { rough: 0.6 });
    for (const z of [0.18, -0.18]) {
      const leg = limb(0.45, 0.07, scale, 0.1, 1.6, z);
      for (let i = 0; i < 3; i++) {
        const talon = strut(G.cone, claw, [0, -0.45, 0], [0.18, -0.52, (i - 1) * 0.08], 0.035);
        leg.add(talon);
      }
      leg.add(strut(G.cone, claw, [0, -0.45, 0], [-0.14, -0.5, 0], 0.03));
      b.add(leg);
      if (z > 0) rig.armL = leg;
      else rig.armR = leg;
    }
  }
  return rig;
}

/**
 * A bird's wing laid flat along +z (-z when `sgn` is -1): an inner panel with a lighter band of
 * coverts along its leading edge, and four primaries fanned out at the tip.
 */
function featherWing(sgn: number, inner: MeshStandardMaterial, covert: MeshStandardMaterial, primary: MeshStandardMaterial): Group {
  const wing = new Group();
  wing.add(mesh(G.box, inner, -0.12, 0, sgn * 0.55, 0.5, 0.05, 1.05));
  wing.add(mesh(G.box, covert, 0.1, 0.02, sgn * 0.55, 0.2, 0.06, 1.0));
  for (let i = 0; i < 4; i++) {
    // Fanned from pointing straight out to swept back, like the fingers of a soaring vulture.
    const len = 0.75 - i * 0.08;
    const sweep = 0.12 + i * 0.28;
    // Pointing out along z, flattened top to bottom, then swept back about y.
    const f = mesh(G.cone4, primary, 0.05 - i * 0.12 - (Math.sin(sweep) * len) / 2, -0.01 * i, sgn * (1.0 + (Math.cos(sweep) * len) / 2), 0.08, len, 0.015);
    f.rotation.set((sgn * Math.PI) / 2, -sgn * sweep, 0, 'YXZ');
    wing.add(f);
  }
  return wing;
}

/** A glowing core with chunks of its element orbiting it. */
function elemental(color: number, kind: 'fire' | 'frost' | 'storm'): Rig {
  const rig = emptyRig(motion('hover', 'pulse', 'dissolve', 0.4));
  const glow = kind === 'fire' ? 0xff4010 : kind === 'frost' ? 0x60b0ff : 0xfff060;
  const core = mat(color, { emissive: glow, intensity: kind === 'storm' ? 1.6 : 1.4, rough: 0.3 });
  const b = rig.body;
  b.add(mesh(kind === 'frost' ? G.octa : G.sphereLow, core, 0, 1.6, 0, 0.6, kind === 'frost' ? 0.9 : 0.65, 0.6));
  const shardGeo = kind === 'frost' ? G.octa : kind === 'storm' ? G.cone4 : G.sphereLow;
  const shardMat = kind === 'fire' ? mat(0x3a1a10, { emissive: 0xff3000, intensity: 0.8 }) : mat(tint(color, 0.15), { emissive: glow, intensity: 1 });
  for (let i = 0; i < 5; i++) {
    const shard = mesh(shardGeo, shardMat, 0, 0, 0, 0.22, 0.3, 0.22);
    shard.userData.orbit = (Math.PI * 2 * i) / 5;
    b.add(shard);
    extra(rig, shard, 'orbit');
  }
  if (kind === 'fire') {
    const flame = mesh(G.cone, mat(0xffc040, { emissive: 0xff6010, intensity: 2.5, opacity: 0.8 }), 0, 2.4, 0, 0.4, 1.0, 0.4);
    b.add(flame);
    extra(rig, flame, 'flame');
  }
  eyes(b, 0.5, 1.75, 0.18, kind === 'fire' ? 0xffffa0 : 0xffffff, 0.07);
  rig.head = b;
  return rig;
}

function wisp(color: number): Rig {
  const rig = emptyRig(motion('hover', 'pulse', 'dissolve', 0.05));
  const b = rig.body;
  b.add(mesh(G.sphere, mat(color, { emissive: color, intensity: 2.5, opacity: 0.85 }), 0, 1.8, 0, 0.4, 0.4, 0.4));
  b.add(mesh(G.sphere, mat(0xffffff, { emissive: 0xffffff, intensity: 3 }), 0, 1.8, 0, 0.18, 0.18, 0.18));
  for (let i = 0; i < 3; i++) {
    const spark = mesh(G.octa, mat(color, { emissive: color, intensity: 3 }), 0, 0, 0, 0.1, 0.1, 0.1);
    spark.userData.orbit = (Math.PI * 2 * i) / 3;
    b.add(spark);
    extra(rig, spark, 'orbit');
  }
  return rig;
}

/** Blocky constructs. Earth golems are boulders, bone golems ribcages, iron golems plated. */
function golem(color: number, kind: 'earth' | 'bone' | 'iron'): Rig {
  const rig = emptyRig(motion('biped', 'claw', 'collapse', kind === 'earth' ? 1 : 0.9, { ability: kind === 'iron' ? 'charge' : 'slam', cast: 'slam', shoot: 'slam' }));
  rig.legLength = 1.3;
  // Metalness stays low: with no environment map to reflect, metal renders near black.
  const base = kind === 'iron' ? 0x6a6e74 : color;
  const body = mat(base, kind === 'iron' ? { metal: 0.2, rough: 0.6 } : { rough: 0.95 });
  const dark = mat(kind === 'earth' ? 0x6a5e48 : tint(base, -0.2), kind === 'iron' ? { metal: 0.2, rough: 0.65 } : { rough: 1 });
  const glow = kind === 'earth' ? 0x80ff60 : kind === 'bone' ? 0x80ffff : 0xff8040;
  const b = rig.body;
  const torso = new Group();
  torso.position.y = 1.3;
  b.add(torso);
  torso.add(mesh(kind === 'earth' ? G.sphereLow : G.box, body, 0, 0.75, 0, kind === 'earth' ? 0.95 : 1.4, 1.2, kind === 'earth' ? 0.85 : 1.2));
  if (kind === 'bone') for (let i = 0; i < 4; i++) torso.add(mesh(G.halfTorus, mat(0xf0e8d0), 0.3, 0.3 + i * 0.3, 0, 0.55, 0.55, 0.9));
  if (kind === 'iron') torso.add(mesh(G.cyl, mat(0x2a2a30), 0.72, 0.85, 0, 0.3, 0.06, 0.3), mesh(G.sphere, mat(0x000000, { emissive: 0xff5010, intensity: 2 }), 0.74, 0.85, 0, 0.18, 0.18, 0.18));
  const head = new Group();
  // The boulder's top sits at 1.95; lower, the head sank into it and read as a hole.
  head.position.set(0.25, kind === 'earth' ? 1.9 : 1.65, 0);
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
  const rig = emptyRig(motion('biped', 'claw', 'collapse', king ? 1 : 0.9, { ability: 'slam', cast: 'cast', shoot: 'cast' }));
  rig.legLength = 1.2;
  const bark = mat(0x5a4028, { rough: 1 });
  // The king's crown towers over the hero's light and went black at night: a faint mossy glow keeps its shape.
  const leaf = king ? mat(color, { rough: 0.9, emissive: 0x2a3a18, intensity: 0.45 }) : mat(color, { rough: 0.9 });
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
  if (king) crown.scale.setScalar(1.5);
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
  const rig = quadruped(color, { tusks: false, horns: true, bulk: 1.05 }, motion('quad', 'ram', 'roll', 0.65, { ability: 'charge' }));
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
  const rig = emptyRig(motion('hop', 'ram', 'splat', 0.3));
  rig.legLength = 0.45;
  // A dusky purple cap with pale spots and a grimy stalk; the bright ones read as a toadstool toy.
  const cap = mat(0x6a3a6a, { rough: 0.7 });
  const stalk = mat(0x9a9080, { rough: 0.95 });
  const b = rig.body;
  b.add(mesh(G.cyl, stalk, 0, 0.8, 0, 0.35, 1.2, 0.35));
  b.add(mesh(G.sphere, cap, 0, 1.55, 0, 0.9, 0.5, 0.9));
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7;
    // On the cap's surface: at 1.8 they sat inside it and never showed.
    b.add(mesh(G.sphere, mat(0xb0a080), Math.cos(a) * 0.55, 1.95, Math.sin(a) * 0.55, 0.12, 0.06, 0.12));
  }
  b.add(mesh(G.sphere, mat(0xb0a080), 0, 2.04, 0, 0.14, 0.05, 0.14));
  eyes(b, 0.34, 1.0, 0.12, 0xffe060, 0.06);
  rig.legL = limb(0.45, 0.14, stalk, 0, 0.45, 0.2);
  rig.legR = limb(0.45, 0.14, stalk, 0, 0.45, -0.2);
  b.add(rig.legL, rig.legR);
  rig.head = b;
  return rig;
}

/** Long, low, armoured: a crocodile shape that surfaces from the bog. */
function lurker(color: number): Rig {
  const rig = emptyRig(motion('crawl', 'bite', 'roll', 0.6, { burrows: true }));
  rig.legLength = 0.4;
  const hide = mat(color, { rough: 0.8 });
  const belly = mat(0xa8a070, { rough: 0.9 });
  const b = rig.body;
  b.add(mesh(G.capsule, hide, 0, 0.55, 0, 0.45, 1.4, 0.45));
  b.children[0]?.rotateZ(Math.PI / 2);
  b.add(mesh(G.box, belly, 0, 0.3, 0, 1.6, 0.1, 0.5));
  for (let i = 0; i < 6; i++) b.add(mesh(G.cone4, mat(tint(color, -0.15)), -0.9 + i * 0.32, 0.98, 0, 0.1, 0.2, 0.1));
  const head = new Group();
  head.position.set(1.25, 0.6, 0);
  head.add(mesh(G.box, hide, 0.35, 0, 0, 0.9, 0.22, 0.4));
  // The lower jaw on its own hinge, so it can snap.
  const jaw = new Group();
  jaw.position.set(-0.05, -0.08, 0);
  jaw.add(mesh(G.box, hide, 0.4, -0.07, 0, 0.85, 0.12, 0.36));
  head.add(jaw);
  rig.jaw = jaw;
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
  const rig = humanoid({ skin: color, torso: tint(color, -0.08), legs: tint(color, -0.15), hunch: 0.5, bulk: 1.05, armLength: 1.3, profile: motion('biped', 'claw', 'collapse', 0.7, { ability: 'leap', dormant: 'statue' }) });
  for (const z of [0.25, -0.25]) {
    const horn = mesh(G.cone, mat(tint(color, -0.25)), -0.05, 0.45, z, 0.08, 0.45, 0.08);
    horn.rotation.x = z > 0 ? -0.6 : 0.6;
    rig.head?.add(horn);
  }
  if (rig.head) eyes(rig.head, 0.36, 0.05, 0.14, 0xff6020, 0.06);
  // On the torso at the shoulder blades, so the wings hunch and turn with the back.
  const torso = rig.head?.parent ?? rig.body;
  for (const sgn of [1, -1]) {
    const wing = membraneWing(sgn, 1.25, mat(tint(color, -0.05)), mat(tint(color, -0.14)));
    wing.position.set(-0.25, 1.2, sgn * 0.5);
    // Half raised and swept back, the way a gargoyle holds them folded.
    wing.rotation.set(-sgn * 0.75, -sgn * 0.45, 0.35);
    torso.add(wing);
    extra(rig, wing, 'wing', 0, sgn);
  }
  return rig;
}

/** A treasure chest with a tongue and a lid full of teeth. */
function mimic(color: number): Rig {
  const rig = emptyRig(motion('hop', 'chomp', 'tip', 0.5, { dormant: 'chest' }));
  rig.legLength = 0.35;
  const wood = mat(color, { rough: 0.9 });
  const legWood = mat(tint(color, -0.1), { rough: 0.9 });
  const band = mat(0x8a7040, { metal: 0.2, rough: 0.6 });
  const b = rig.body;
  b.add(mesh(G.box, wood, 0, 0.45, 0, 1.3, 0.7, 0.9), mesh(G.box, band, 0, 0.45, 0, 1.34, 0.12, 0.94));
  const lid = new Group();
  lid.position.set(-0.65, 0.8, 0);
  lid.add(mesh(G.box, wood, 0.65, 0.18, 0, 1.3, 0.35, 0.9), mesh(G.box, band, 0.65, 0.18, 0, 1.34, 0.08, 0.94));
  for (let i = 0; i < 6; i++) lid.add(mesh(G.cone4, mat(0xf0e8d0), 0.2 + i * 0.2, -0.05, 0.4, 0.05, 0.16, 0.05), mesh(G.cone4, mat(0xf0e8d0), 0.2 + i * 0.2, -0.05, -0.4, 0.05, 0.16, 0.05));
  lid.rotation.z = 0.35;
  b.add(lid);
  rig.head = lid;
  const tongue = new Group();
  tongue.position.set(0.6, 0.9, 0);
  const tip = mesh(G.capsule, mat(0x8a2a2a, { rough: 0.5 }), 0.1, -0.04, 0, 0.12, 0.35, 0.18);
  tip.rotation.z = -1.2;
  tongue.add(tip);
  b.add(tongue);
  extra(rig, tongue, 'tongue');
  eyes(b, 0.55, 0.95, 0.25, 0xd08a20, 0.035);
  // Out at the sides and long enough to reach the floor; they were tucked inside the box, the feet under the ground.
  rig.legL = limb(0.35, 0.12, legWood, 0.4, 0.35, 0.5);
  rig.legR = limb(0.35, 0.12, legWood, -0.4, 0.35, -0.5);
  b.add(rig.legL, rig.legR);
  return rig;
}

function mummy(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.06), legs: tint(color, -0.1), hunch: 0.2, profile: motion('biped', 'claw', 'topple', 0.55) });
  const wrap = mat(tint(color, 0.08), { rough: 1 });
  // Loose bandage strips trailing from the arms.
  for (const a of [rig.armL, rig.armR]) {
    if (!a) continue;
    const strip = mesh(G.box, wrap, 0.1, -0.9, 0, 0.05, 0.6, 0.12);
    strip.rotation.z = 0.3;
    a.add(strip);
  }
  if (rig.head) eyes(rig.head, 0.36, 0.05, 0.13, 0x60ffa0, 0.06);
  // Arms held out in front, bent at the elbow, the classic shamble.
  for (const a of [rig.armL, rig.armR]) {
    if (!a) continue;
    bendElbow(a, 0.55, 0.4);
    a.rotation.z = 0.95;
  }
  return rig;
}

/**
 * Splits a humanoid arm at `at` of its length and bends the part below forward by `angle`. The
 * forearm is placed directly rather than on an elbow group, since every group compiles to a bone.
 */
function bendElbow(arm: Object3D, at: number, angle: number): void {
  const length: unknown = arm.userData.length;
  const l = typeof length === 'number' ? length : 1;
  const [upper, ...rest] = arm.children;
  if (!(upper instanceof Mesh) || !(upper.material instanceof MeshStandardMaterial)) return;
  const ey = -l * at;
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const fore = l * (1 - at);
  arm.add(strut(G.taper, upper.material, [0, ey, 0], [fore * sn, ey - fore * c, 0], upper.scale.x * 0.9));
  upper.scale.y = l * at;
  upper.position.y = ey / 2;
  for (const r of rest) {
    const dx = r.position.x;
    const dy = r.position.y - ey;
    r.position.set(dx * c - dy * sn, ey + dx * sn + dy * c, r.position.z);
    r.rotation.z += angle;
  }
}

function lizardman(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.12), legs: tint(color, -0.18), hunch: 0.25, profile: motion('biped', 'claw', 'topple', 0.35, { ability: 'shoot', shoot: 'shoot' }) });
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
  rig.armR?.add(mesh(G.cyl, mat(0x6b4a2a), 0.1, -0.9, 0, 0.04, 2.0, 0.04), mesh(G.cone4, mat(0xa0a8b0, { metal: 0.2, rough: 0.5 }), 0.1, 0.15, 0, 0.08, 0.3, 0.08));
  return rig;
}

/** Robed and hooded, hands glowing with the fire it is about to call down. */
function cultist(_color: number): Rig {
  // Blood-dark but lit, and hunched so it never reads as a player mage or priest.
  const rig = humanoid({ skin: 0x4a3830, torso: 0x6a3030, legs: 0x2a1a18, robe: 0x5a2a2a, hunch: 0.3, profile: motion('biped', 'claw', 'topple', 0.4, { ability: 'cast', cast: 'cast', shoot: 'cast' }) });
  const hood = mesh(G.cone, mat(0x3e2224), -0.05, 0.25, 0, 0.5, 0.8, 0.5);
  rig.head?.add(hood);
  if (rig.head) eyes(rig.head, 0.34, 0, 0.12, 0xff4020, 0.06);
  for (const a of [rig.armL, rig.armR]) a?.add(mesh(G.sphere, mat(0xff8030, { emissive: 0xff4010, intensity: 2.5 }), 0, -1.25, 0, 0.16, 0.16, 0.16));
  return rig;
}

/** Hellspawn: horned, hooved and on fire, built to run you down. */
function demon(color: number): Rig {
  const rig = humanoid({ skin: color, torso: tint(color, -0.15), legs: 0x2a1410, bulk: 1.25, hunch: 0.35, armLength: 1.35, profile: motion('biped', 'claw', 'collapse', 0.7, { ability: 'charge' }) });
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
    extra(rig, flame, 'flame', i * 2);
  }
  return rig;
}

function frostGiant(color: number): Rig {
  const rig = humanoid({ skin: color, torso: 0x5a6a80, legs: 0x3a4a5a, bulk: 1.7, hunch: 0.1, armLength: 1.45, profile: motion('biped', 'claw', 'collapse', 1, { ability: 'slam', cast: 'cast', shoot: 'cast' }) });
  // Head sunk between the shoulders under a heavy brow, an icy beard and shoulder spikes.
  if (rig.head) {
    rig.head.position.y -= 0.18;
    rig.head.add(mesh(G.box, mat(tint(color, -0.12), { rough: 0.9 }), 0.28, 0.2, 0, 0.18, 0.12, 0.5));
  }
  rig.head?.add(mesh(G.cone, mat(0xe8f4ff, { emissive: 0x4080c0, intensity: 0.4 }), 0.3, -0.35, 0, 0.3, 0.6, 0.35));
  if (rig.head) eyes(rig.head, 0.38, 0.08, 0.15, 0x80d0ff, 0.07);
  for (const z of [0.9, -0.9]) {
    for (let i = 0; i < 3; i++) {
      const spike = mesh(G.octa, mat(0xc8e8ff, { emissive: 0x3070c0, intensity: 0.8, rough: 0.2 }), -0.1 + i * 0.15, 2.95 + i * 0.1, z, 0.12, 0.4, 0.12);
      rig.body.add(spike);
    }
  }
  rig.armR?.add(mesh(G.cyl, mat(0x6a5a4a), 0.1, -1.0, 0, 0.12, 2.4, 0.12), mesh(G.box, mat(0xa8c8e0, { metal: 0.2, rough: 0.45 }), 0.1, 0.25, 0, 0.5, 0.5, 0.35));
  return rig;
}

/** The raw, uncompiled model of a minion type. */
export function buildMinion(type: MinionTypeId, color: number): Rig {
  switch (type) {
    case 'zombie_brute': {
      const rig = humanoid({ skin: 0x7a8a5a, torso: color, legs: 0x3a3a2a, bulk: 1.35, hunch: 0.35, armLength: 1.5, profile: motion('biped', 'claw', 'collapse', 0.7) });
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0x80ff40, intensity: 1.5 }), 0.36, 0.05, 0.14, 0.06, 0.06, 0.06));
      rig.head?.add(mesh(G.sphere, mat(0x000000, { emissive: 0x80ff40, intensity: 1.5 }), 0.36, 0.05, -0.14, 0.06, 0.06, 0.06));
      return rig;
    }
    case 'skeleton_archer': {
      const rig = humanoid({ skin: 0xe8e0c8, torso: 0xd8d0b8, legs: 0xd8d0b8, bulk: 0.7, profile: motion('biped', 'claw', 'topple', 0.2, { ability: 'shoot', shoot: 'shoot' }) });
      rig.head?.add(mesh(G.sphere, mat(0x000000), 0.3, 0.05, 0.14, 0.09, 0.09, 0.09), mesh(G.sphere, mat(0x000000), 0.3, 0.05, -0.14, 0.09, 0.09, 0.09));
      const bow = mesh(G.halfTorus, mat(0x6b4a2a), 0.3, -0.9, 0, 0.9, 0.9, 0.9);
      bow.rotation.set(0, 0, Math.PI / 2);
      rig.armL?.add(bow);
      return rig;
    }
    case 'wraith': {
      const rig = emptyRig(motion('hover', 'claw', 'dissolve', 0.25));
      // Green like the other bound minions, so it is never taken for the blue enemy wraith.
      const cloak = mat(0x7ab89a, { opacity: 0.85, emissive: 0x1a7040, intensity: 0.5 });
      const b = rig.body;
      const body = mesh(G.cone, cloak, 0, 1.3, 0, 0.8, 2.2, 0.8);
      body.rotation.x = Math.PI;
      b.add(body);
      const hood = new Group();
      hood.position.set(0.1, 2.35, 0);
      hood.add(mesh(G.sphere, cloak, 0, 0, 0, 0.5, 0.55, 0.5));
      hood.add(mesh(G.sphere, mat(0x000000, { emissive: 0xa0ffc0, intensity: 3 }), 0.4, 0, 0.14, 0.07, 0.07, 0.07));
      hood.add(mesh(G.sphere, mat(0x000000, { emissive: 0xa0ffc0, intensity: 3 }), 0.4, 0, -0.14, 0.07, 0.07, 0.07));
      b.add(hood);
      rig.head = hood;
      rig.armL = limb(1, 0.18, cloak, 0.2, 1.9, 0.6, G.cone);
      rig.armR = limb(1, 0.18, cloak, 0.2, 1.9, -0.6, G.cone);
      b.add(rig.armL, rig.armR);
      return rig;
    }
    case 'hound':
      // Stand-in while the Grave Hound file streams in, in the bound minions' green.
      return wolf(0x6f8a62, { fire: false, bulk: 1.2 }, motion('quad', 'bite', 'roll', 0.45, { ability: 'leap' }));
  }
}

/** A player's procedural model, the stand-in while the class's model file loads. */
export function playerModel(cls: ClassId, color: number): Rig {
  return compiledRig(`player:${cls}:${color}`, () => buildPlayer(cls, color));
}

/** A monster's procedural model, compiled once per type and shared by every copy. */
export function enemyModel(type: EnemyTypeId, color: number): Rig {
  return compiledRig(`enemy:${type}:${color}`, () => buildEnemy(type, color), true);
}

export function minionModel(type: MinionTypeId, color: number): Rig {
  return compiledRig(`minion:${type}:${color}`, () => buildMinion(type, color));
}
