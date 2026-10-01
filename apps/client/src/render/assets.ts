import { Box3, Color, Group, Mesh, MeshStandardMaterial, Vector3, type AnimationClip, type Object3D, type Texture } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { addNightRim } from './nightRim.js';

/**
 * Asset registry. Every 3D model the game uses is listed here: where the file lives, how big it
 * should be in world units, and which animation clips play for each role. Files are CC0 KayKit
 * packs under public/assets/kaykit (see scripts/assets for how they were imported and trimmed).
 */

/** windup is held through a telegraph, stretched to its length (characters.ts windupCharacter). */
export type AnimRole = 'idle' | 'walk' | 'run' | 'attack' | 'windup' | 'cast' | 'shoot' | 'hit' | 'death' | 'dormant' | 'awaken' | 'spawn';

export type AssetCategory = 'hero' | 'monster' | 'building' | 'wall' | 'nature' | 'prop' | 'light' | 'dungeon' | 'graveyard';

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
  /** The cold night rim of enemies (nightRim.ts); set on the enemy copy of a def, never on heroes or minions. */
  rim?: boolean;
  /** False keeps a scenery asset out of the town editor's palette (see TOWN_DECOR_ASSETS in shared). */
  town?: false;
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

/**
 * The town editor's kit (2026-09-30): the rest of the three packs that suits a grim town and its
 * outskirts. Heights follow the older entries of the same kind: houses 130, towers 190 to 220,
 * medieval clutter about 125 units per model unit, dungeon furniture about 15.
 */
const TOWN_KIT: AssetDef[] = [
  ...(
    [
      ['building_archeryrange_red', 130],
      ['building_barracks_red', 150],
      ['building_barracks_blue', 150],
      ['building_blacksmith_red', 130],
      ['building_castle_red', 280],
      ['building_church_red', 190],
      ['building_home_B_blue', 130],
      ['building_lumbermill_red', 150],
      ['building_market_red', 130],
      ['building_market_blue', 130],
      ['building_mine_red', 110],
      ['building_tavern_blue', 130],
      ['building_tower_A_blue', 190],
      ['building_tower_B_red', 220],
      ['building_tower_B_blue', 220],
      ['building_tower_base_red', 150],
      ['building_tower_catapult_red', 200],
      ['building_watermill_red', 150],
      ['building_well_red', 70],
      ['building_windmill_blue', 190],
      ['building_bridge_B', 40],
      ['building_grain', 20],
      ['building_scaffolding', 110],
      ['building_stage_A', 30],
      ['building_stage_B', 65],
      ['building_stage_C', 110],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace('building_', '').replace(/_/g, ' '), category: 'building', url: `${K}/medieval/${n}.gltf`, height: h })),
  ...(
    [
      ['fence_stone_straight_gate', 33],
      ['fence_wood_straight_gate', 31],
      ['wall_straight_gate', 90],
      ['wall_corner_A_gate', 90],
      ['wall_corner_A_inside', 70],
      ['wall_corner_B_inside', 70],
      ['wall_corner_B_outside', 70],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace(/_/g, ' '), category: 'wall', url: `${K}/medieval/${n}.gltf`, height: h })),
  ...(
    [
      ['bucket_arrows', 29],
      ['bucket_empty', 16],
      ['crate_A_small', 18],
      ['crate_B_big', 28],
      ['crate_long_B', 20],
      ['crate_long_C', 25],
      ['crate_long_empty', 19],
      ['crate_open', 26],
      ['ladder', 90],
      ['pallet', 10],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace(/_/g, ' '), category: 'prop', url: `${K}/medieval/${n}.gltf`, height: h })),
  ...(
    [
      ['hills_B_trees', 110],
      ['hills_C_trees', 110],
      ['mountain_A', 190],
      ['mountain_A_grass', 200],
      ['mountain_B', 235],
      ['mountain_B_grass_trees', 280],
      ['mountain_C_grass', 230],
      ['mountain_C_grass_trees', 260],
      ['tree_single_A_cut', 18],
      ['tree_single_B_cut', 14],
      ['trees_A_cut', 20],
      ['trees_B_cut', 16],
      ['trees_A_small', 75],
      ['trees_B_small', 70],
      ['waterlily_B', 6],
      ['waterplant_B', 20],
      ['waterplant_C', 20],
    ] as const
  ).map(([n, h]): AssetDef => ({ id: n, label: n.replace(/_/g, ' '), category: 'nature', url: `${K}/medieval/${n}.gltf`, height: h })),
  // Dungeon pieces as .gltf sharing one texture (scripts/assets/share-dungeon-texture.mjs).
  ...(
    [
      ['wall', 70, 'wall'],
      ['wall_arched', 70, 'wall'],
      ['wall_archedwindow_open', 70, 'wall'],
      ['wall_cracked', 70, 'wall'],
      ['wall_corner', 70, 'wall'],
      ['wall_doorway', 70, 'wall'],
      ['wall_endcap', 70, 'wall'],
      ['wall_gated', 70, 'wall'],
      ['wall_half', 70, 'wall'],
      ['wall_half_endcap_sloped', 70, 'wall'],
      ['wall_pillar', 70, 'wall'],
      ['wall_scaffold', 70, 'wall'],
      ['wall_sloped', 70, 'wall'],
      ['wall_window_open', 70, 'wall'],
      ['wall_window_closed', 70, 'wall'],
      ['barrier', 19, 'wall'],
      ['barrier_half', 19, 'wall'],
      ['barrier_column', 25, 'wall'],
      ['barrier_colum_half', 25, 'wall'],
      ['barrier_corner', 25, 'wall'],
      ['banner_brown', 80, 'prop'],
      ['banner_shield_brown', 80, 'prop'],
      ['banner_shield_red', 80, 'prop'],
      ['banner_thin_brown', 80, 'prop'],
      ['banner_thin_red', 80, 'prop'],
      ['banner_triple_brown', 80, 'prop'],
      ['banner_triple_red', 80, 'prop'],
      ['barrel_large_decorated', 38, 'prop'],
      ['barrel_small', 15, 'prop'],
      ['keg', 30, 'prop'],
      ['keg_decorated', 30, 'prop'],
      ['box_large', 22, 'prop'],
      ['box_small', 15, 'prop'],
      ['trunk_large_A', 15, 'prop'],
      ['trunk_large_B', 15, 'prop'],
      ['trunk_large_C', 15, 'prop'],
      ['trunk_medium_A', 11, 'prop'],
      ['candle_thin_lit', 10, 'light'],
      ['bed_floor', 8, 'dungeon'],
      ['bed_frame', 16, 'dungeon'],
      ['bottle_A_brown', 9, 'dungeon'],
      ['bottle_A_labeled_brown', 9, 'dungeon'],
      ['bottle_B_green', 9, 'dungeon'],
      ['bottle_C_brown', 9, 'dungeon'],
      ['chair', 18, 'dungeon'],
      ['table_long', 15, 'dungeon'],
      ['table_long_broken', 18, 'dungeon'],
      ['table_medium', 15, 'dungeon'],
      ['table_medium_broken', 14, 'dungeon'],
      ['table_small', 15, 'dungeon'],
      ['table_medium_decorated_A', 26, 'dungeon'],
      ['table_small_decorated_A', 23, 'dungeon'],
      // Flagstones, boards and broken tiles: sized by their thickness, so a large tile is about 105 wide.
      ['floor_tile_large', 4, 'dungeon'],
      ['floor_tile_large_rocks', 17, 'dungeon'],
      ['floor_tile_small_broken_A', 4, 'dungeon'],
      ['floor_tile_small_broken_B', 4, 'dungeon'],
      ['floor_tile_small_weeds_A', 8, 'dungeon'],
      ['floor_dirt_large_rocky', 10, 'dungeon'],
      ['floor_wood_large_dark', 4, 'dungeon'],
    ] as const
  ).map(([n, h, category]): AssetDef => ({
    // `dungeon_table_long` is already the laid table (table_long_decorated_A).
    id: n === 'table_long' ? 'dungeon_table_long_bare' : `dungeon_${n}`,
    label: n === 'table_long' ? 'table long bare' : n.replace(/_/g, ' '),
    category,
    url: `${K}/dungeon/${n}.gltf`,
    height: h,
  })),
  ...(
    [
      ['arch_gate', 90, 'graveyard'],
      ['bench', 10, 'graveyard'],
      ['bone_B', 6, 'graveyard'],
      ['bone_C', 8, 'graveyard'],
      ['coffin', 26, 'graveyard'],
      ['coffin_decorated', 18, 'graveyard'],
      ['fence_gate', 38, 'graveyard'],
      ['fence_pillar', 28, 'graveyard'],
      ['fence_pillar_broken', 19, 'graveyard'],
      ['fence_seperate', 25, 'graveyard'],
      ['fence_seperate_broken', 25, 'graveyard'],
      ['grave_A_destroyed', 20, 'graveyard'],
      ['gravemarker_B', 26, 'graveyard'],
      ['plaque', 7, 'graveyard'],
      ['post', 70, 'graveyard'],
      ['shrine', 67, 'graveyard'],
      ['tree_dead_large_decorated', 128, 'nature'],
      // Stepping stones, sized by their thickness to about 38 across.
      ['path_A', 2, 'graveyard'],
      ['path_B', 2, 'graveyard'],
      ['path_C', 2, 'graveyard'],
      ['path_D', 2, 'graveyard'],
      // The pack's candles are unlit; the world fires light them (props.ts FLAMES).
      ['candle', 12, 'light'],
      ['candle_melted', 10, 'light'],
      ['candle_thin', 12, 'light'],
      ['candle_triple', 12, 'light'],
      ['skull_candle', 14, 'light'],
      ['plaque_candles', 20, 'light'],
    ] as const
  ).map(([n, h, category]): AssetDef => ({ id: `grave_${n}`, label: n.replace(/_/g, ' '), category, url: `${K}/halloween/${n}.gltf`, height: h })),
];

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
  // The owner's brother's dog (tools/blender/README.md), made for this game only; not licensed for reuse.
  { id: 'mon_grave_hound', label: 'Grave Hound', category: 'monster', url: '/assets/monsters/grave_hound.glb', height: 50, clips: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack', hit: 'Hit', death: 'Death' } },
  // The owner's brother's Charger (tools/blender/README.md), made for this game only; not licensed for reuse.
  { id: 'mon_charger', label: 'Charger', category: 'monster', url: '/assets/monsters/charger.glb', height: 80, clips: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack', windup: 'Windup', hit: 'Hit', death: 'Death' } },
  { id: 'minion_brute', label: 'Bound Warrior (Zombie Brute minion)', category: 'monster', url: `${K}/skeletons/Skeleton_Warrior.glb`, height: 54, clips: SKELETON_CLIPS, weapon: { url: `${K}/skeletons/Skeleton_Axe.gltf`, bone: 'handslotr' }, tint: 0xb8ffb0, glow: 0x205a20 },
  { id: 'minion_archer', label: 'Bound Archer (Skeleton Archer minion)', category: 'monster', url: `${K}/skeletons/Skeleton_Rogue.glb`, height: 46, clips: { ...SKELETON_CLIPS, attack: '2H_Ranged_Shoot' }, weapon: { url: `${K}/skeletons/Skeleton_Crossbow.gltf`, bone: 'handslotr' }, tint: 0xd8c8ff, glow: 0x3a2a6a },
  // The Hound pack: the Grave Hound's file in its own coat (the minion ring and bar mark them as allies), the Leader darker.
  { id: 'minion_hound', label: 'Bound Hound (Hound packmate)', category: 'monster', url: '/assets/monsters/grave_hound.glb', height: 50, clips: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack', hit: 'Hit', death: 'Death' } },
  { id: 'minion_hound_leader', label: 'Bound Hound Leader (Hound pack)', category: 'monster', url: '/assets/monsters/grave_hound.glb', height: 50, clips: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack', hit: 'Hit', death: 'Death' }, tint: 0x8a8680 },
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
  ).map(([f, n, h]): AssetDef => ({
    id: `dungeon_${n}`,
    label: n.replace(/_/g, ' '),
    // Torches and candles sit with the other lights in the town editor.
    category: n === 'torch_lit' || n === 'candle_lit' ? 'light' : 'dungeon',
    url: `${K}/dungeon/${f}`,
    height: h,
    // In town a chest reads as the stash and a coin pile as loot nobody can pick up.
    ...(n === 'chest' || n === 'chest_gold' || n === 'coin_stack' ? { town: false } : {}),
    // The checkered banner's white squares read as the brightest thing in a dark street; this
    // takes it down to soiled cloth.
    ...(n === 'banner_blue' ? { tint: 0x9c948c } : {}),
  })),
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
  ).map(([n, h]): AssetDef => ({
    id: `grave_${n}`,
    label: n.replace(/_/g, ' '),
    category: n === 'lantern_standing' || n === 'post_lantern' || n === 'shrine_candles' ? 'light' : 'graveyard',
    url: `${K}/halloween/${n}.gltf`,
    height: h,
    // Too cute for the town (CLAUDE.md, Look); dungeons and the wilds still use it.
    ...(n === 'pumpkin_orange' ? { town: false } : {}),
  })),
  ...TOWN_KIT,
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
      shareTextures(gltf, url);
      const file = { scene: gltf.scene, clips: gltf.animations };
      ready.set(url, file);
      return file;
    });
    files.set(url, p);
  }
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The image file a glTF texture reads, or null when it is embedded. */
function imageUri(json: unknown, textureIndex: number): string | null {
  if (!isRecord(json) || !Array.isArray(json.textures) || !Array.isArray(json.images)) return null;
  const tex: unknown = json.textures[textureIndex];
  const source = isRecord(tex) ? tex.source : undefined;
  const image: unknown = typeof source === 'number' ? json.images[source] : undefined;
  const uri = isRecord(image) ? image.uri : undefined;
  return typeof uri === 'string' && !uri.startsWith('data:') ? uri : null;
}

/** Textures by resolved image URL and sampler, shared by every file that paints from them. */
const sharedTextures = new Map<string, Texture>();

/**
 * Points every material at one texture per image file. Each glTF load makes its own texture, so a
 * town of forty KayKit props painted from the same atlas would upload that atlas forty times.
 */
function shareTextures(gltf: GLTF, url: string): void {
  const base = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
  gltf.scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!(m instanceof MeshStandardMaterial) || !m.map) continue;
      const index = gltf.parser.associations.get(m.map)?.textures;
      const uri = index === undefined ? null : imageUri(gltf.parser.json, index);
      if (!uri) continue;
      const t = m.map;
      const key = `${new URL(uri, base).href}|${t.wrapS}|${t.wrapT}|${t.magFilter}|${t.minFilter}|${t.flipY}|${t.colorSpace}`;
      const have = sharedTextures.get(key);
      if (!have) sharedTextures.set(key, t);
      else if (have !== t) {
        t.dispose();
        m.map = have;
      }
    }
  });
}

/**
 * Makes an already parsed file available under `url`, as if it had been loaded from there. The
 * Model check uses it for a local .glb that never leaves the browser.
 */
export function registerFile(url: string, scene: Group, clips: AnimationClip[]): void {
  const file = { scene, clips };
  ready.set(url, file);
  files.set(url, Promise.resolve(file));
}

/** Forgets a registered file, so a replaced local model does not stay in memory. */
export function unregisterFile(url: string): void {
  ready.delete(url);
  files.delete(url);
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
  // Enemies and minions can share a model; only the enemy copy has the rim.
  const key = def.rim ? `${def.id}#rim` : def.id;
  let byDef = defMaterials.get(key);
  if (!byDef) {
    byDef = new Map();
    defMaterials.set(key, byDef);
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
    if (def.rim) addNightRim(m);
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
