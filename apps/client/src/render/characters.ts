import { ENEMY_MODELS, MINION_MODELS, type ClassId, type EnemyTypeId, type EntitySnap, type MinionTypeId, type ModelOverride, type ModelOverrides } from '@rune/shared';
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
  SkinnedMesh,
  type AnimationAction,
  type Object3D,
} from 'three';
import { assetById, cloneMaterial, instantiate, instantiateNow, type AnimRole, type AssetDef, type AssetInstance } from './assets.js';

/** Which registered asset each gameplay entity uses. Kinds without an entry keep their procedural model. */
const PLAYER_ASSETS: Record<ClassId, string> = {
  warrior: 'hero_barbarian',
  ranger: 'hero_rogue_hooded',
  mage: 'hero_mage',
  priest: 'hero_knight',
  binder: 'hero_rogue',
};
/**
 * Beasts, slimes, totems and spirits have no KayKit model and stay procedural (see models.ts). The
 * maps live in shared (data/tuning.ts) so the server knows which types have a model to resize.
 */
export const ENEMY_ASSETS: Partial<Record<EnemyTypeId, string>> = ENEMY_MODELS;
export const MINION_ASSETS: Partial<Record<MinionTypeId, string>> = MINION_MODELS;

/** Pack Leaders are drawn in a darker copy of their type's model. */
const LEADER_ASSETS: Partial<Record<MinionTypeId, string>> = { hound: 'minion_hound_leader' };

/** Rare enemies swap to a heavier model so a champion reads differently from its pack. */
const RARE_ASSETS: Partial<Record<EnemyTypeId, string>> = { chaser: 'skel_warrior' };

/** Admin model overrides from the server's 'models' message. */
let serverModels: ModelOverrides = { monsters: {}, minions: {} };
/** Local .glb files the Model check is trying on, for this browser only. Beat the server's overrides. */
const tryOns = new Map<string, AssetDef>();

export function setModelOverrides(models: ModelOverrides): void {
  serverModels = models;
}

export function setTryOn(key: `monsters:${EnemyTypeId}` | `minions:${MinionTypeId}`, def: AssetDef | null): void {
  if (def) tryOns.set(key, def);
  else tryOns.delete(key);
}

export function clearTryOns(): void {
  tryOns.clear();
}

/** Registry copies at another height, keyed so their fit and materials are cached apart from the original. */
const resized = new Map<string, AssetDef>();

/** The asset at `height` world units tall; the same object for the same pair, since caches key on the id. */
export function sizedAsset(def: AssetDef, height: number | undefined): AssetDef {
  if (height === undefined || height === def.height) return def;
  const id = `${def.id}@${height}`;
  let out = resized.get(id);
  if (!out) {
    out = { ...def, id, height };
    resized.set(id, out);
  }
  return out;
}

/** A type's model with an admin override applied; undefined keeps the procedural model. */
export function overriddenAsset(defaultId: string | undefined, o: ModelOverride | undefined): AssetDef | undefined {
  const base = assetById(o?.model ?? defaultId ?? '');
  return base ? sizedAsset(base, o?.height) : undefined;
}

/** Enemy copies of defs, with the night rim (their materials are cached apart, see `prepared`). */
const rimmed = new Map<string, AssetDef>();

function enemyAsset(def: AssetDef | undefined): AssetDef | undefined {
  if (!def) return undefined;
  let out = rimmed.get(def.id);
  if (!out) {
    out = { ...def, rim: true };
    rimmed.set(def.id, out);
  }
  return out;
}

export function characterAsset(s: EntitySnap): AssetDef | undefined {
  if (s.k === 'player') return assetById(PLAYER_ASSETS[s.cls]);
  if (s.k === 'enemy') {
    const o = serverModels.monsters[s.et];
    // A chosen model is used for champions too; a height-only override keeps the rare swap.
    return enemyAsset(tryOns.get(`monsters:${s.et}`) ?? overriddenAsset((s.rare && o?.model === undefined ? RARE_ASSETS[s.et] : undefined) ?? ENEMY_ASSETS[s.et], o));
  }
  if (s.k === 'minion') {
    const o = serverModels.minions[s.mt];
    // A pack Leader wears the darker copy unless an admin picked another model for the type.
    const leader = s.pack === 'leader' && o?.model === undefined ? LEADER_ASSETS[s.mt] : undefined;
    return tryOns.get(`minions:${s.mt}`) ?? overriddenAsset(leader ?? MINION_ASSETS[s.mt], o);
  }
  return undefined;
}

export interface CharacterModel {
  root: Group;
  mixer: AnimationMixer;
  actions: Map<AnimRole, AnimationAction>;
  current: AnimRole | null;
  /** Meshes that take the hit flash and status tint; their materials may still be shared. */
  tintMeshes: Mesh[];
  /** Per-instance GPU resources to free with the model. The file's geometry and shared materials are not listed. */
  owned: { dispose(): void }[];
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
const arrowFeather = new ConeGeometry(0.05, 0.12, 3);
const featherMat = new MeshStandardMaterial({ color: 0xd8d0c0, flatShading: true });

/**
 * Seeded wear and tear for undead monsters and minions: missing arms or jaw, arrows stuck in the
 * body, bone colour and size jitter. Still the same low-poly model, just never quite identical.
 */
function vary(root: Object3D, seed: number, def: AssetDef, owned: CharacterModel['owned']): void {
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
      const feather = new Mesh(arrowFeather, featherMat);
      feather.position.y = 0.28;
      arrow.add(shaft, head, feather);
      arrow.position.set((rnd() - 0.5) * 0.3, 0.9 + rnd() * 0.4, (rnd() - 0.5) * 0.25);
      arrow.rotation.set(1.2 + rnd() * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6);
      body.add(arrow);
    }
  }
  const tint = new Color().setHSL(0.1 + rnd() * 0.05, 0.1 + rnd() * 0.2, 0.75 + rnd() * 0.25);
  // The colour jitter is per entity, so this model needs its own materials from the start.
  const copies = new Map<MeshStandardMaterial, MeshStandardMaterial>();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !(o.material instanceof MeshStandardMaterial)) return;
    let m = copies.get(o.material);
    if (!m) {
      m = cloneMaterial(o.material);
      m.color.multiply(tint);
      copies.set(o.material, m);
      owned.push(m);
    }
    o.material = m;
  });
  root.scale.multiplyScalar(0.92 + rnd() * 0.16);
}

export async function loadCharacter(def: AssetDef, seed: number): Promise<CharacterModel> {
  return fromInstance(await instantiate(def), def, seed);
}

/** Builds the character right away when its files are already loaded; null means use loadCharacter. */
export function characterNow(def: AssetDef, seed: number): CharacterModel | null {
  const inst = instantiateNow(def);
  return inst ? fromInstance(inst, def, seed) : null;
}

function fromInstance(inst: AssetInstance, def: AssetDef, seed: number): CharacterModel {
  const owned: CharacterModel['owned'] = [];
  vary(inst.root, seed, def, owned);
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
  const tintMeshes: Mesh[] = [];
  inst.root.traverse((o) => {
    if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) tintMeshes.push(o);
    // Each clone has its own skeleton, and with it a bone texture on the GPU.
    if (o instanceof SkinnedMesh) owned.push(o.skeleton);
  });
  return {
    root: inst.root,
    mixer,
    actions,
    current: null,
    tintMeshes,
    owned,
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
 * Speeds where locomotion switches to running, and back to walking, in world units per second. A
 * narrow band clear of common move speeds (minions at 150 to 180, players from 190), since a
 * smoothed speed hovering on a single line flips the clip and restarts the crossfade every frame.
 */
const RUN_UP = 188;
const RUN_DOWN = 184;
/** Below this the entity stands; smoothed speed never quite reaches 0. */
const WALK_FROM = 18;

/** Idle, walk or run for a ground speed, with the run band's hysteresis. Procedural rigs use it too. */
export function locomotionRole(speed: number, current: AnimRole | null): 'idle' | 'walk' | 'run' {
  if (speed > (current === 'run' ? RUN_DOWN : RUN_UP)) return 'run';
  return speed > WALK_FROM ? 'walk' : 'idle';
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
  const loco = locomotionRole(s.speed, cm.current);
  play(cm, loco === 'walk' && !cm.actions.has('walk') ? 'run' : loco);
  const walk = cm.actions.get('walk');
  if (walk) walk.timeScale = Math.max(0.6, Math.min(1.8, s.speed / 110));
}
