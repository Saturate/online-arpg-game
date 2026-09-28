// Keeps only the animation clips the game uses in each character .glb, then drops the accessors
// those clips referenced. KayKit characters ship ~90 clips each (~4 MB); we use about 20.
// Usage: node scripts/assets/strip-animations.mjs
import { NodeIO } from '@gltf-transform/core';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = new Set([
  'Idle', 'Idle_Combat', 'Walking_A', 'Running_A', 'Hit_A', 'Death_A', 'Death_A_Pose', 'Death_C_Skeletons', 'Dodge_Forward', 'Cheer', 'Block',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '2H_Melee_Attack_Chop', '2H_Melee_Attack_Spin',
  '1H_Ranged_Shoot', '2H_Ranged_Shoot', 'Spellcast_Shoot', 'Spellcast_Raise', 'Spellcast_Long', 'Spellcast_Summon', 'Throw',
  'Skeletons_Awaken_Standing', 'Skeleton_Inactive_Standing_Pose', 'Spawn_Ground_Skeletons', 'Taunt',
]);

const dirs = ['apps/client/public/assets/kaykit/adventurers', 'apps/client/public/assets/kaykit/skeletons'];
const io = new NodeIO();

for (const dir of dirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
    const path = join(dir, file);
    const before = statSync(path).size;
    const doc = await io.read(path);
    const root = doc.getRoot();
    for (const anim of root.listAnimations()) {
      if (KEEP.has(anim.getName())) continue;
      const accessors = new Set();
      for (const s of anim.listSamplers()) {
        const input = s.getInput();
        const output = s.getOutput();
        if (input) accessors.add(input);
        if (output) accessors.add(output);
      }
      anim.dispose();
      // Only drop accessors nothing else still uses (input times are often shared between clips).
      for (const a of accessors) if (a.listParents().every((p) => p === root)) a.dispose();
    }
    await io.write(path, doc);
    const after = statSync(path).size;
    console.log(`${file}: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB, ${root.listAnimations().length} clips`);
  }
}
