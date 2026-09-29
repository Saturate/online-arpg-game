import { Box3, Color, Group, Mesh, MeshStandardMaterial, Vector3, type AnimationClip, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Asset registry. Every 3D model the game uses is listed here: where the file lives, how big it
 * should be in world units, and which animation clips play for each role. Files are CC0 KayKit
 * packs under public/assets/kaykit (see scripts/assets for how they were imported and trimmed).
 */

export type AnimRole = 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'shoot' | 'hit' | 'death' | 'dormant' | 'awaken' | 'spawn';

export type AssetCategory = 'hero' | 'monster' | 'building' | 'nature' | 'prop' | 'dungeon' | 'graveyard';

export interface AssetDef {
  id: string;
  label: string;
  category: AssetCategory;
  url: string;
  /** Target height in world units, weapons included; the model is scaled to fit. Heroes are 54. */
  height: number;
  clips?: Partial<Record<AnimRole, string>>;
  /** Mesh node names to hide (KayKit heroes carry every weapon; we show one). */
  hide?: string[];
  /** Separate weapon model attached to a bone. GLTFLoader strips '.' from node names, so `handslot.r` is `handslotr`. */
  weapon?: { url: string; bone: string };
  /** Multiplies every material colour, for recolouring shared models. */
  tint?: number;
  /** Extra emissive glow, e.g. spectral minions. */
  glow?: number;
}

const K = '/assets/kaykit';

const HERO_CLIPS: Partial<Record<AnimRole, string>> = {
  idle: 'Idle',
  walk: 'Walking_A',
  run: 'Running_A',
  attack: '1H_Melee_Attack_Chop',
  cast: 'Spellcast_Shoot',
  shoot: '1H_Ranged_Shoot',
  hit: 'Hit_A',
  death: 'Death_A',
};

const SKELETON_CLIPS: Partial<Record<AnimRole, string>> = {
  ...HERO_CLIPS,
  idle: 'Idle_Combat',
  death: 'Death_C_Skeletons',
  dormant: 'Skeleton_Inactive_Standing_Pose',
  awaken: 'Skeletons_Awaken_Standing',
  spawn: 'Spawn_Ground_Skeletons',
};

/** Each KayKit hero carries every weapon variant; these lists hide all but the one we want. */
const HIDE_BARBARIAN = ['1H_Axe_Offhand', 'Barbarian_Round_Shield', '1H_Axe', 'Mug'];
const HIDE_KNIGHT = ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield', '2H_Sword'];
const HIDE_MAGE = ['Spellbook', 'Spellbook_open', '1H_Wand'];
const HIDE_RANGER = ['Knife_Offhand', '1H_Crossbow', 'Knife', 'Throwable'];
const HIDE_BINDER = ['Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Throwable'];

export const ASSETS: AssetDef[] = [
  // Heroes
  { id: 'hero_barbarian', label: 'Barbarian (Warrior)', category: 'hero', url: `${K}/adventurers/Barbarian.glb`, height: 54, clips: { ...HERO_CLIPS, attack: '2H_Melee_Attack_Chop' }, hide: HIDE_BARBARIAN },
  { id: 'hero_rogue_hooded', label: 'Hooded Rogue (Ranger)', category: 'hero', url: `${K}/adventurers/Rogue_Hooded.glb`, height: 54, clips: { ...HERO_CLIPS, attack: '2H_Ranged_Shoot' }, hide: HIDE_RANGER },
  { id: 'hero_mage', label: 'Mage', category: 'hero', url: `${K}/adventurers/Mage.glb`, height: 54, clips: { ...HERO_CLIPS, attack: 'Spellcast_Shoot' }, hide: HIDE_MAGE },
  { id: 'hero_knight', label: 'Knight (Priest)', category: 'hero', url: `${K}/adventurers/Knight.glb`, height: 54, clips: HERO_CLIPS, hide: HIDE_KNIGHT },
  { id: 'hero_rogue', label: 'Rogue (Binder)', category: 'hero', url: `${K}/adventurers/Rogue.glb`, height: 54, clips: { ...HERO_CLIPS, attack: 'Spellcast_Shoot' }, hide: HIDE_BINDER },
  // Monsters and minions
  { id: 'skel_minion', label: 'Skeleton Minion (Chaser)', category: 'monster', url: `${K}/skeletons/Skeleton_Minion.glb`, height: 46, clips: SKELETON_CLIPS, weapon: { url: `${K}/skeletons/Skeleton_Blade.gltf`, bone: 'handslotr' } },
  { id: 'skel_rogue', label: 'Skeleton Rogue (Shooter)', category: 'monster', url: `${K}/skeletons/Skeleton_Rogue.glb`, height: 46, clips: { ...SKELETON_CLIPS, attack: '2H_Ranged_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Crossbow.gltf`, bone: 'handslotr' } },
  { id: 'skel_mage', label: 'Skeleton Mage (Spinner caster)', category: 'monster', url: `${K}/skeletons/Skeleton_Mage.glb`, height: 50, clips: { ...SKELETON_CLIPS, attack: 'Spellcast_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Staff.gltf`, bone: 'handslotr' } },
  { id: 'skel_warrior', label: 'Skeleton Warrior (Brute)', category: 'monster', url: `${K}/skeletons/Skeleton_Warrior.glb`, height: 52, clips: { ...SKELETON_CLIPS, attack: '1H_Melee_Attack_Slice_Diagonal' }, weapon: { url: `${K}/skeletons/Skeleton_Axe.gltf`, bone: 'handslotr' } },
  // Monster variants: the same KayKit rigs recoloured, resized and re-armed per family.
  { id: 'mon_grave_brute', label: 'Grave Brute', category: 'monster', url: `${K}/skeletons/Skeleton_Warrior.glb`, height: 72, clips: { ...SKELETON_CLIPS, attack: '2H_Melee_Attack_Chop' }, weapon: { url: `${K}/skeletons/Skeleton_Axe.gltf`, bone: 'handslotr' }, tint: 0xd8d0b8 },
  { id: 'mon_ogre', label: 'Swamp Ogre', category: 'monster', url: `${K}/adventurers/Barbarian.glb`, height: 84, clips: { ...HERO_CLIPS, attack: '2H_Melee_Attack_Chop' }, hide: HIDE_BARBARIAN, tint: 0x8ac060 },
  { id: 'mon_bandit_archer', label: 'Bandit Archer', category: 'monster', url: `${K}/adventurers/Rogue_Hooded.glb`, height: 50, clips: { ...HERO_CLIPS, attack: '2H_Ranged_Shoot' }, hide: HIDE_RANGER, tint: 0xa08060 },
  { id: 'mon_bone_archer', label: 'Bone Archer', category: 'monster', url: `${K}/skeletons/Skeleton_Rogue.glb`, height: 44, clips: { ...SKELETON_CLIPS, attack: '2H_Ranged_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Crossbow.gltf`, bone: 'handslotr' }, tint: 0xc8bca0 },
  { id: 'mon_frost_adept', label: 'Frost Adept', category: 'monster', url: `${K}/skeletons/Skeleton_Mage.glb`, height: 50, clips: { ...SKELETON_CLIPS, attack: 'Spellcast_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Staff.gltf`, bone: 'handslotr' }, tint: 0xc0dcff, glow: 0x1a3a80 },
  { id: 'mon_pyromancer', label: 'Pyromancer', category: 'monster', url: `${K}/adventurers/Mage.glb`, height: 52, clips: { ...HERO_CLIPS, attack: 'Spellcast_Shoot' }, hide: HIDE_MAGE, tint: 0xff9a80, glow: 0x3a1000 },
  { id: 'mon_storm_caller', label: 'Storm Caller', category: 'monster', url: `${K}/skeletons/Skeleton_Mage.glb`, height: 52, clips: { ...SKELETON_CLIPS, attack: 'Spellcast_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Staff.gltf`, bone: 'handslotr' }, tint: 0xfff0a0, glow: 0x3a3000 },
  { id: 'mon_necromancer', label: 'Necromancer', category: 'monster', url: `${K}/skeletons/Skeleton_Mage.glb`, height: 56, clips: { ...SKELETON_CLIPS, attack: 'Spellcast_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Staff.gltf`, bone: 'handslotr' }, tint: 0xa8ffc0, glow: 0x0a4a1a },
  { id: 'mon_tomb_guard', label: 'Tomb Guard', category: 'monster', url: `${K}/adventurers/Knight.glb`, height: 56, clips: HERO_CLIPS, hide: ['1H_Sword_Offhand', 'Badge_Shield', 'Spike_Shield', '2H_Sword'], tint: 0x9aa4b8, glow: 0x0a1020 },
  { id: 'mon_grave_priest', label: 'Grave Priest', category: 'monster', url: `${K}/adventurers/Rogue.glb`, height: 52, clips: { ...HERO_CLIPS, attack: 'Spellcast_Shoot' }, hide: HIDE_BINDER, tint: 0xc0a0e0, glow: 0x200838 },
  { id: 'mon_ghoul', label: 'Ghoul', category: 'monster', url: `${K}/skeletons/Skeleton_Minion.glb`, height: 44, clips: SKELETON_CLIPS, tint: 0xa8c098, glow: 0x0a1a08 },
  { id: 'mon_butcher', label: 'The Butcher', category: 'monster', url: `${K}/adventurers/Barbarian.glb`, height: 98, clips: { ...HERO_CLIPS, attack: '2H_Melee_Attack_Chop' }, hide: HIDE_BARBARIAN, tint: 0xe09088, glow: 0x300000 },
  { id: 'mon_lich', label: 'The Pale Lich', category: 'monster', url: `${K}/skeletons/Skeleton_Mage.glb`, height: 100, clips: { ...SKELETON_CLIPS, attack: 'Spellcast_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Staff.gltf`, bone: 'handslotr' }, tint: 0xe0d0ff, glow: 0x3a1a90 },
  { id: 'minion_brute', label: 'Bound Warrior (Zombie Brute minion)', category: 'monster', url: `${K}/skeletons/Skeleton_Warrior.glb`, height: 54, clips: SKELETON_CLIPS, weapon: { url: `${K}/skeletons/Skeleton_Axe.gltf`, bone: 'handslotr' }, tint: 0xb8ffb0, glow: 0x205a20 },
  { id: 'minion_archer', label: 'Bound Archer (Skeleton Archer minion)', category: 'monster', url: `${K}/skeletons/Skeleton_Rogue.glb`, height: 46, clips: { ...SKELETON_CLIPS, attack: '2H_Ranged_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Crossbow.gltf`, bone: 'handslotr' }, tint: 0xd8c8ff, glow: 0x3a2a6a },
  // Buildings
  ...['building_home_A_red', 'building_home_B_red', 'building_home_A_blue', 'building_home_B_yellow', 'building_tavern_red', 'building_blacksmith_blue', 'building_market_yellow', 'building_church_blue', 'building_tower_A_red', 'building_windmill_red', 'building_well_blue', 'building_destroyed', 'building_bridge_A'].map(
    (n): AssetDef => ({ id: n, label: n.replace('building_', '').replace(/_/g, ' '), category: 'building', url: `${K}/medieval/${n}.gltf`, height: n.includes('tower') || n.includes('windmill') || n.includes('church') ? 190 : n.includes('well') ? 70 : n.includes('bridge') ? 40 : 130 }),
  ),
  // Nature
  ...(
    [
      ['trees_A_large', 120],
      ['trees_A_medium', 90],
      ['trees_B_large', 120],
      ['trees_B_medium', 90],
      ['tree_single_A', 90],
      ['tree_single_B', 90],
      ['rock_single_A', 30],
      ['rock_single_B', 30],
      ['rock_single_C', 30],
      ['rock_single_D', 30],
      ['rock_single_E', 30],
      ['hills_A_trees', 120],
      ['hills_B', 80],
      ['mountain_A_grass_trees', 260],
      ['mountain_B_grass', 240],
      ['mountain_C', 260],
      ['waterlily_A', 6],
      ['waterplant_A', 20],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace(/_/g, ' '), category: 'nature', url: `${K}/medieval/${n}.gltf`, height: h })),
  // Props
  ...(
    [
      ['barrel', 26],
      ['crate_A_big', 28],
      ['crate_B_small', 18],
      ['crate_long_A', 20],
      ['sack', 16],
      ['tent', 70],
      ['weaponrack', 40],
      ['wheelbarrow', 26],
      ['flag_red', 70],
      ['bucket_water', 14],
      ['resource_lumber', 24],
      ['resource_stone', 22],
      ['target', 40],
      ['fence_wood_straight', 26],
      ['fence_stone_straight', 30],
      ['wall_straight', 70],
      ['wall_corner_A_outside', 80],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace(/_/g, ' '), category: 'prop', url: `${K}/medieval/${n}.gltf`, height: h })),
  // Dungeon
  ...(
    [
      ['torch_lit.gltf.glb', 'torch_lit', 50],
      ['chest.glb', 'chest', 22],
      ['chest_gold.glb', 'chest_gold', 24],
      ['pillar.gltf.glb', 'pillar', 110],
      ['pillar_decorated.gltf.glb', 'pillar_decorated', 110],
      ['column.gltf.glb', 'column', 110],
      ['barrel_large.gltf.glb', 'barrel_large', 30],
      ['barrel_small_stack.gltf.glb', 'barrel_small_stack', 30],
      ['crates_stacked.gltf.glb', 'crates_stacked', 40],
      ['box_stacked.gltf.glb', 'box_stacked', 32],
      ['rubble_large.gltf.glb', 'rubble_large', 20],
      ['rubble_half.gltf.glb', 'rubble_half', 14],
      ['wall_broken.gltf.glb', 'wall_broken', 70],
      ['banner_red.gltf.glb', 'banner_red', 80],
      ['banner_patternA_blue.gltf.glb', 'banner_blue', 80],
      ['candle_lit.gltf.glb', 'candle_lit', 10],
      ['coin_stack_large.gltf.glb', 'coin_stack', 10],
      ['table_long_decorated_A.gltf.glb', 'table_long', 24],
      ['stool.gltf.glb', 'stool', 14],
    ] as const
  ).map(([f, n, h]): AssetDef => ({ id: `dungeon_${n}`, label: n.replace(/_/g, ' '), category: 'dungeon', url: `${K}/dungeon/${f}`, height: h })),
  // Graveyard
  ...(
    [
      ['grave_A', 20],
      ['grave_B', 20],
      ['gravestone', 28],
      ['gravemarker_A', 26],
      ['tree_dead_large', 120],
      ['tree_dead_medium', 90],
      ['tree_dead_small', 60],
      ['lantern_standing', 40],
      ['post_lantern', 70],
      ['post_skull', 50],
      ['crypt', 120],
      ['shrine_candles', 50],
      ['ribcage', 16],
      ['skull', 8],
      ['bone_A', 8],
      ['fence_broken', 28],
      ['fence', 28],
      ['arch', 90],
      ['pillar', 70],
      ['pumpkin_orange', 14],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: `grave_${n}`, label: n.replace(/_/g, ' '), category: 'graveyard', url: `${K}/halloween/${n}.gltf`, height: h })),
];

export function assetById(id: string): AssetDef | undefined {
  return ASSETS.find((a) => a.id === id);
}

// ---------------------------------------------------------------------------------------------
// Loading

interface LoadedFile {
  scene: Group;
  clips: AnimationClip[];
}

const loader = new GLTFLoader();
const files = new Map<string, Promise<LoadedFile>>();
/** Files that have finished loading, so a model can be built without waiting a frame. */
const ready = new Map<string, LoadedFile>();

function loadFile(url: string): Promise<LoadedFile> {
  let p = files.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      const file = { scene: gltf.scene, clips: gltf.animations };
      ready.set(url, file);
      return file;
    });
    files.set(url, p);
  }
  return p;
}

export interface AssetInstance {
  root: Group;
  clips: AnimationClip[];
  def: AssetDef;
}

/**
 * Copies a material with its shader hooks: Material.clone skips onBeforeCompile, which would drop
 * the corruption repaint from a monster built on a hero model.
 */
export function cloneMaterial(m: MeshStandardMaterial): MeshStandardMaterial {
  const c = m.clone();
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  return c;
}

/** Tinted and glowing copies of a file's materials, one set per asset def, shared by every instance. */
const defMaterials = new Map<string, Map<MeshStandardMaterial, MeshStandardMaterial>>();

function prepared(def: AssetDef, source: MeshStandardMaterial): MeshStandardMaterial {
  let byDef = defMaterials.get(def.id);
  if (!byDef) {
    byDef = new Map();
    defMaterials.set(def.id, byDef);
  }
  let m = byDef.get(source);
  if (!m) {
    m = source.clone();
    // Monsters built on the hero models must never read as a player at a glance.
    if (def.category === 'monster' && def.url.includes('/adventurers/')) corruptMaterial(m, def.tint ?? 0xb0a0a0);
    else if (def.tint !== undefined) m.color.multiply(new Color(def.tint));
    if (def.glow !== undefined) {
      m.emissive.setHex(def.glow);
      m.emissiveIntensity = 0.8;
    }
    byDef.set(source, m);
  }
  return m;
}

/**
 * Scale and foot offset per asset def. Measuring a skinned model skins every vertex on the CPU,
 * close to a millisecond per instance, and the bind pose is the same for every copy.
 */
const fits = new Map<string, { scale: number; minY: number }>();

function build(def: AssetDef, file: LoadedFile, weapon: LoadedFile | null): AssetInstance {
  const model = cloneSkinned(file.scene);
  for (const name of def.hide ?? []) {
    const o = model.getObjectByName(name);
    if (o) o.visible = false;
  }
  if (weapon && def.weapon) {
    const bone = model.getObjectByName(def.weapon.bone);
    if (bone) bone.add(weapon.scene.clone(true));
  }
  model.traverse((o: Object3D) => {
    if (!(o instanceof Mesh)) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (o.material instanceof MeshStandardMaterial) o.material = prepared(def, o.material);
  });

  let fit = fits.get(def.id);
  if (!fit) {
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    fit = { scale: size.y > 0 ? def.height / size.y : 1, minY: box.min.y };
    fits.set(def.id, fit);
  }
  const root = new Group();
  const pivot = new Group();
  pivot.add(model);
  model.position.y = -fit.minY;
  pivot.scale.setScalar(fit.scale);
  // KayKit characters face +z; the game treats +x as forward.
  if (def.category === 'hero' || def.category === 'monster') pivot.rotation.y = Math.PI / 2;
  root.add(pivot);
  root.userData.assetId = def.id;
  return { root, clips: file.clips, def };
}

/**
 * A ready-to-place copy of an asset, scaled to its target height with its feet at y = 0 and facing
 * +x like the rest of the game. Skinned models are cloned with their skeletons so each instance
 * animates on its own. Geometry and materials are shared between copies: anything that changes a
 * material for one instance must clone it first (see cloneMaterial).
 */
export async function instantiate(def: AssetDef): Promise<AssetInstance> {
  const file = await loadFile(def.url);
  const weapon = def.weapon ? await loadFile(def.weapon.url) : null;
  return build(def, file, weapon);
}

/** Same as instantiate, but only when the files are already loaded; null means use instantiate. */
export function instantiateNow(def: AssetDef): AssetInstance | null {
  const file = ready.get(def.url);
  const weapon = def.weapon ? ready.get(def.weapon.url) : null;
  if (!file || weapon === undefined) return null;
  return build(def, file, weapon);
}

/**
 * Drains the texture's own colours and repaints it in the monster's tint. A plain colour multiply
 * keeps the texture's hue, so a tinted hero model still looked like the player's class.
 */
function corruptMaterial(m: MeshStandardMaterial, tint: number): void {
  const color = new Color(tint);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCorruptTint = { value: color };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCorruptTint;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float corruptLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(vec3(corruptLuma), diffuseColor.rgb, 0.2) * uCorruptTint * 1.25;`,
      );
  };
  m.customProgramCacheKey = () => `corrupt-${tint}`;
}
