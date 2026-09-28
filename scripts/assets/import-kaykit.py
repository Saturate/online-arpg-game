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
medieval_pick = ['building_home_A_red','building_home_B_red','building_home_A_blue','building_home_B_yellow','building_tavern_red','building_blacksmith_blue','building_market_yellow','building_church_blue','building_tower_A_red','building_windmill_red','building_well_blue','building_destroyed','building_bridge_A',
  'trees_A_large','trees_A_medium','trees_B_large','trees_B_medium','tree_single_A','tree_single_B','rock_single_A','rock_single_B','rock_single_C','rock_single_D','rock_single_E','hills_A_trees','hills_B','mountain_A_grass_trees','mountain_B_grass','mountain_C',
  'barrel','crate_A_big','crate_B_small','crate_long_A','sack','tent','weaponrack','wheelbarrow','flag_red','bucket_water','resource_lumber','resource_stone','target',
  'fence_wood_straight','fence_stone_straight','wall_straight','wall_corner_A_outside','waterlily_A','waterplant_A']
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
