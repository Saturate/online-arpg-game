import type { ClassId, EnemyTypeId, EntitySnap, MinionTypeId } from '@rune/shared';
import {
  AnimationMixer,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  type AnimationAction,
  type Object3D,
} from 'three';
import { assetById, instantiate, type AnimRole, type AssetDef } from './assets.js';

/** Which registered asset each gameplay entity uses. Kinds without an entry keep their procedural model. */
const PLAYER_ASSETS: Record<ClassId, string> = {
  warrior: 'hero_barbarian',
  ranger: 'hero_rogue_hooded',
  mage: 'hero_mage',
  priest: 'hero_knight',
  binder: 'hero_rogue',
};
/** Beasts, slimes, totems and spirits have no KayKit model and stay procedural (see models.ts). */
export const ENEMY_ASSETS: Partial<Record<EnemyTypeId, string>> = {
  chaser: 'skel_minion',
  shooter: 'skel_rogue',
  spinner: 'skel_mage',
  grave_brute: 'mon_grave_brute',
  ogre: 'mon_ogre',
  bandit_archer: 'mon_bandit_archer',
  bone_archer: 'mon_bone_archer',
  frost_adept: 'mon_frost_adept',
  pyromancer: 'mon_pyromancer',
  storm_caller: 'mon_storm_caller',
  necromancer: 'mon_necromancer',
  tomb_guard: 'mon_tomb_guard',
  grave_priest: 'mon_grave_priest',
  ghoul: 'mon_ghoul',
  butcher: 'mon_butcher',
  lich: 'mon_lich',
};
export const MINION_ASSETS: Partial<Record<MinionTypeId, string>> = {
  zombie_brute: 'minion_brute',
  skeleton_archer: 'minion_archer',
};

/** Rare enemies swap to a heavier model so a champion reads differently from its pack. */
const RARE_ASSETS: Partial<Record<EnemyTypeId, string>> = { chaser: 'skel_warrior' };

export function characterAsset(s: EntitySnap): AssetDef | undefined {
  if (s.k === 'player') return assetById(PLAYER_ASSETS[s.cls]);
  if (s.k === 'enemy') return assetById((s.rare ? RARE_ASSETS[s.et] : undefined) ?? ENEMY_ASSETS[s.et] ?? '');
  if (s.k === 'minion') return assetById(MINION_ASSETS[s.mt] ?? '');
  return undefined;
}

export interface CharacterModel {
  root: Group;
  mixer: AnimationMixer;
  actions: Map<AnimRole, AnimationAction>;
  current: AnimRole | null;
  materials: MeshStandardMaterial[];
  baseEmissive: Color[];
  baseIntensity: number[];
  attackRole: AnimRole;
}

/** Small deterministic hash so the same entity always gets the same variation. */
function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function findBySuffix(root: Object3D, suffix: string): Object3D | undefined {
  let hit: Object3D | undefined;
  root.traverse((o) => {
    if (!hit && o.name.endsWith(suffix)) hit = o;
  });
  return hit;
}

const arrowShaft = new CylinderGeometry(0.018, 0.018, 0.55, 5);
const arrowHead = new ConeGeometry(0.04, 0.1, 5);
const arrowMat = new MeshStandardMaterial({ color: 0x6b4a2a, flatShading: true });
const featherMat = new MeshStandardMaterial({ color: 0xd8d0c0, flatShading: true });

/**
 * Seeded wear and tear for undead monsters and minions: missing arms or jaw, arrows stuck in the
 * body, bone colour and size jitter. Still the same low-poly model, just never quite identical.
 */
function vary(root: Object3D, seed: number, def: AssetDef): void {
  const rnd = seeded(seed);
  const isSkeleton = def.url.includes('/skeletons/');
  if (!isSkeleton) return;
  const armL = findBySuffix(root, 'ArmLeft');
  const armR = findBySuffix(root, 'ArmRight');
  const jaw = findBySuffix(root, 'Jaw');
  const roll = rnd();
  if (roll < 0.22 && armL) armL.visible = false;
  else if (roll < 0.3 && armR) {
    armR.visible = false;
    // The weapon hangs off the right hand; without the arm it would float.
    const slot = root.getObjectByName('handslotr');
    if (slot) slot.visible = false;
  } else if (roll < 0.34 && armL && armR) {
    armL.visible = false;
    armR.visible = false;
    const slot = root.getObjectByName('handslotr');
    if (slot) slot.visible = false;
  }
  if (jaw && rnd() < 0.15) jaw.visible = false;

  const body = findBySuffix(root, '_Body');
  if (body && rnd() < 0.3) {
    const count = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const arrow = new Group();
      const shaft = new Mesh(arrowShaft, arrowMat);
      const head = new Mesh(arrowHead, arrowMat);
      head.position.y = -0.3;
      head.rotation.x = Math.PI;
      const feather = new Mesh(new ConeGeometry(0.05, 0.12, 3), featherMat);
      feather.position.y = 0.28;
      arrow.add(shaft, head, feather);
      arrow.position.set((rnd() - 0.5) * 0.3, 0.9 + rnd() * 0.4, (rnd() - 0.5) * 0.25);
      arrow.rotation.set(1.2 + rnd() * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6);
      body.add(arrow);
    }
  }
  const tint = new Color().setHSL(0.1 + rnd() * 0.05, 0.1 + rnd() * 0.2, 0.75 + rnd() * 0.25);
  root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) o.material.color.multiply(tint);
  });
  root.scale.multiplyScalar(0.92 + rnd() * 0.16);
}

export async function loadCharacter(def: AssetDef, seed: number): Promise<CharacterModel> {
  const inst = await instantiate(def);
  vary(inst.root, seed, def);
  const mixer = new AnimationMixer(inst.root);
  const actions = new Map<AnimRole, AnimationAction>();
  for (const [role, name] of Object.entries(def.clips ?? {})) {
    const clip = inst.clips.find((c) => c.name === name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    const oneShot = role === 'attack' || role === 'cast' || role === 'shoot' || role === 'hit' || role === 'death' || role === 'awaken' || role === 'spawn';
    action.setLoop(oneShot ? LoopOnce : LoopRepeat, Infinity);
    action.clampWhenFinished = oneShot;
    if (role === 'attack' || role === 'cast' || role === 'shoot') action.timeScale = 1.6;
    // Validated at runtime: every key in AnimRole comes from the registry's typed clip map.
    if (isRole(role)) actions.set(role, action);
  }
  const materials: MeshStandardMaterial[] = [];
  inst.root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) materials.push(o.material);
  });
  return {
    root: inst.root,
    mixer,
    actions,
    current: null,
    materials,
    baseEmissive: materials.map((m) => m.emissive.clone()),
    baseIntensity: materials.map((m) => m.emissiveIntensity),
    attackRole: def.clips?.attack === 'Spellcast_Shoot' || def.id === 'hero_mage' || def.id === 'hero_rogue' || def.id === 'skel_mage' ? 'cast' : 'attack',
  };
}

const ROLES: readonly AnimRole[] = ['idle', 'walk', 'run', 'attack', 'cast', 'shoot', 'hit', 'death', 'dormant', 'awaken', 'spawn'];
function isRole(v: string): v is AnimRole {
  return ROLES.some((r) => r === v);
}

function play(cm: CharacterModel, role: AnimRole, fade = 0.18): void {
  if (cm.current === role) return;
  const next = cm.actions.get(role) ?? cm.actions.get('idle');
  if (!next) return;
  const prev = cm.current ? cm.actions.get(cm.current) : undefined;
  next.reset().fadeIn(fade).play();
  prev?.fadeOut(fade);
  cm.current = role;
}

export interface DriveState {
  speed: number;
  attack: boolean;
  dead: boolean;
  dormant: boolean;
  dt: number;
}

/**
 * Picks the clip from what the entity is doing. One-shots (attack, death, awaken) play through;
 * locomotion blends between idle, walk and run by actual speed.
 */
export function driveCharacter(cm: CharacterModel, s: DriveState): void {
  cm.mixer.update(s.dt);
  if (s.dead) {
    play(cm, 'death', 0.1);
    return;
  }
  if (s.dormant) {
    play(cm, cm.actions.has('dormant') ? 'dormant' : 'idle');
    return;
  }
  if (cm.current === 'dormant') {
    play(cm, 'awaken', 0.1);
    return;
  }
  const busy = cm.current === 'awaken' || cm.current === 'attack' || cm.current === 'cast' || cm.current === 'shoot';
  const action = cm.current ? cm.actions.get(cm.current) : undefined;
  const oneShotRunning = busy && action !== undefined && action.isRunning();
  if (s.attack) {
    const role = cm.actions.has(cm.attackRole) ? cm.attackRole : 'attack';
    const a = cm.actions.get(role);
    if (a) {
      a.reset().play();
      cm.current = role;
    }
    return;
  }
  if (oneShotRunning) return;
  if (s.speed > 150) play(cm, 'run');
  else if (s.speed > 18) play(cm, cm.actions.has('walk') ? 'walk' : 'run');
  else play(cm, 'idle');
  const walk = cm.actions.get('walk');
  if (walk) walk.timeScale = Math.max(0.6, Math.min(1.8, s.speed / 110));
}
