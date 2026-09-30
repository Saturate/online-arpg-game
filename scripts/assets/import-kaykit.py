# Copies the KayKit files the game uses out of the pack repos (github.com/KayKit-Game-Assets, CC0).
# Usage: python3 scripts/assets/import-kaykit.py <folder with the pack repos cloned> <out folder>
# Writing straight into apps/client/public/assets/kaykit overwrites the characters, so run
# strip-animations.mjs again afterwards (or import into a scratch folder and copy what is new).
import json, os, shutil, sys, glob
S, D = sys.argv[1], sys.argv[2]
packs = {
  'adventurers': ('KayKit-Character-Pack-Adventures-1.0', ['Characters/gltf/Barbarian.glb','Characters/gltf/Knight.glb','Characters/gltf/Mage.glb','Characters/gltf/Rogue.glb','Characters/gltf/Rogue_Hooded.glb']),
  'skeletons': ('KayKit-Character-Pack-Skeletons-1.0', ['Characters/gltf/Skeleton_Minion.glb','Characters/gltf/Skeleton_Rogue.glb','Characters/gltf/Skeleton_Mage.glb','Characters/gltf/Skeleton_Warrior.glb',
     'Assets/gltf/Skeleton_Blade.gltf','Assets/gltf/Skeleton_Crossbow.gltf','Assets/gltf/Skeleton_Staff.gltf','Assets/gltf/Skeleton_Axe.gltf','Assets/gltf/Skeleton_Shield_Small_A.gltf']),
  'dungeon': ('KayKit-Dungeon-Remastered-1.0', ['Assets/gltf/'+n for n in ['torch_lit.gltf.glb','chest.glb','chest_gold.glb','pillar.gltf.glb','pillar_decorated.gltf.glb','column.gltf.glb','barrel_large.gltf.glb','barrel_small_stack.gltf.glb','crates_stacked.gltf.glb','box_stacked.gltf.glb','rubble_large.gltf.glb','rubble_half.gltf.glb','wall_broken.gltf.glb','banner_red.gltf.glb','banner_patternA_blue.gltf.glb','candle_lit.gltf.glb','coin_stack_large.gltf.glb','table_long_decorated_A.gltf.glb','stool.gltf.glb']]),
  'halloween': ('KayKit-Halloween-Bits-1.0', ['Assets/gltf/'+n for n in ['grave_A.gltf','grave_B.gltf','gravestone.gltf','gravemarker_A.gltf','tree_dead_large.gltf','tree_dead_medium.gltf','tree_dead_small.gltf','lantern_standing.gltf','post_lantern.gltf','post_skull.gltf','crypt.gltf','shrine_candles.gltf','ribcage.gltf','skull.gltf','bone_A.gltf','fence_broken.gltf','fence.gltf','arch.gltf','pillar.gltf','pumpkin_orange.gltf']]),
  'medieval': ('KayKit-Medieval-Hexagon-Pack-1.0', None),
}
# The town editor's palette (2026-09-30): what suits a grim town and its outskirts. Team-coloured
# green and yellow buildings and flags, hex ground tiles, clouds, pumpkins, autumn pines, gold,
# the pattern banners (their white fields read bright), pieces showing gold or pumpkins, bare hex hills, wall-mounted pieces and pits that only work sunk into a floor were left out (docs/features/town.md).
dungeon_more = [n + '.gltf.glb' for n in [
  'banner_brown','banner_shield_brown','banner_shield_red','banner_thin_brown','banner_thin_red','banner_triple_brown','banner_triple_red',
  'barrel_large_decorated','barrel_small','barrier','barrier_half','barrier_column','barrier_corner','barrier_colum_half','bed_floor','bed_frame',
  'bottle_A_brown','bottle_A_labeled_brown','bottle_B_green','bottle_C_brown','box_large','box_small','candle_thin_lit','chair',
  'floor_tile_large','floor_tile_large_rocks','floor_tile_small_broken_A','floor_tile_small_broken_B','floor_tile_small_weeds_A','floor_dirt_large_rocky','floor_wood_large_dark',
  'keg','keg_decorated','table_long','table_long_broken','table_medium','table_medium_broken','table_small','table_medium_decorated_A','table_small_decorated_A',
  'trunk_large_A','trunk_large_B','trunk_large_C','trunk_medium_A',
  'wall','wall_arched','wall_archedwindow_open','wall_cracked','wall_corner','wall_endcap','wall_gated','wall_half','wall_half_endcap_sloped','wall_pillar','wall_scaffold','wall_window_open','wall_window_closed','wall_sloped']] + ['wall_doorway.glb']
packs['dungeon'][1].extend('Assets/gltf/' + n for n in dungeon_more)
halloween_more = ['arch_gate','bench','bone_B','bone_C','candle','candle_melted','candle_thin','candle_triple','coffin','coffin_decorated',
  'fence_gate','fence_pillar','fence_pillar_broken','fence_seperate','fence_seperate_broken','grave_A_destroyed','gravemarker_B','path_A','path_B','path_C','path_D',
  'plaque','plaque_candles','post','shrine','skull_candle','tree_dead_large_decorated']
packs['halloween'][1].extend('Assets/gltf/' + n + '.gltf' for n in halloween_more)
medieval_pick = ['building_home_A_red','building_home_B_red','building_home_A_blue','building_home_B_yellow','building_tavern_red','building_blacksmith_blue','building_market_yellow','building_church_blue','building_tower_A_red','building_windmill_red','building_well_blue','building_destroyed','building_bridge_A',
  'trees_A_large','trees_A_medium','trees_B_large','trees_B_medium','tree_single_A','tree_single_B','rock_single_A','rock_single_B','rock_single_C','rock_single_D','rock_single_E','hills_A_trees','hills_B','mountain_A_grass_trees','mountain_B_grass','mountain_C',
  'barrel','crate_A_big','crate_B_small','crate_long_A','sack','tent','weaponrack','wheelbarrow','flag_red','bucket_water','resource_lumber','resource_stone','target',
  'fence_wood_straight','fence_stone_straight','wall_straight','wall_corner_A_outside','waterlily_A','waterplant_A',
  # The town editor's palette (2026-09-30), red and a few blue buildings.
  'building_archeryrange_red','building_barracks_red','building_blacksmith_red','building_castle_red','building_church_red','building_lumbermill_red','building_market_red',
  'building_mine_red','building_tower_B_red','building_tower_base_red','building_tower_catapult_red','building_watermill_red','building_well_red',
  'building_home_B_blue','building_tavern_blue','building_tower_A_blue','building_tower_B_blue','building_market_blue','building_windmill_blue','building_barracks_blue',
  'building_bridge_B','building_grain','building_scaffolding','building_stage_A','building_stage_B','building_stage_C',
  'fence_stone_straight_gate','fence_wood_straight_gate','wall_straight_gate','wall_corner_A_gate','wall_corner_A_inside','wall_corner_B_inside','wall_corner_B_outside',
  'bucket_arrows','bucket_empty','crate_A_small','crate_B_big','crate_long_B','crate_long_C','crate_long_empty','crate_open','ladder','pallet',
  'hills_B_trees','hills_C_trees','mountain_A','mountain_A_grass','mountain_B','mountain_B_grass_trees',
  'mountain_C_grass','mountain_C_grass_trees','tree_single_A_cut','tree_single_B_cut','trees_A_cut','trees_B_cut','trees_A_small','trees_B_small','waterlily_B','waterplant_B','waterplant_C']
os.makedirs(D, exist_ok=True)
copied = 0
def find_root(repo):
    hits = glob.glob(f"{S}/{repo}/addons/*")
    return hits[0] if hits else f"{S}/{repo}"
for key, (repo, files) in packs.items():
    root = find_root(repo)
    out = f"{D}/{key}"
    os.makedirs(out, exist_ok=True)
    lic = f"{S}/{repo}/LICENSE.txt"
    if os.path.exists(lic): shutil.copy(lic, f"{out}/LICENSE.txt")
    if files is None:
        files = []
        for name in medieval_pick:
            m = glob.glob(f"{root}/Assets/gltf/**/{name}.gltf", recursive=True)
            if not m: print('missing', name); continue
            files.append(os.path.relpath(m[0], root))
    for rel in files:
        src = f"{root}/{rel}"
        if not os.path.exists(src): print('missing', src); continue
        dst = f"{out}/{os.path.basename(rel)}"
        shutil.copy(src, dst); copied += 1
        if src.endswith('.gltf'):
            j = json.load(open(src))
            for uri in [b.get('uri') for b in j.get('buffers', [])] + [i.get('uri') for i in j.get('images', [])]:
                if uri and not uri.startswith('data:'):
                    dep = os.path.join(os.path.dirname(src), uri)
                    if os.path.exists(dep) and not os.path.exists(f"{out}/{os.path.basename(uri)}"):
                        shutil.copy(dep, f"{out}/{os.path.basename(uri)}")
                    # Keep the uri valid: files are flattened into one folder per pack.
                    if os.path.basename(uri) != uri:
                        j2 = json.load(open(dst))
                        for coll in ('buffers','images'):
                            for e in j2.get(coll, []):
                                if e.get('uri') == uri: e['uri'] = os.path.basename(uri)
                        json.dump(j2, open(dst,'w'))
print('copied', copied)
print('then: node scripts/assets/share-dungeon-texture.mjs')
