// Every KayKit dungeon .glb embeds the same 16 KB texture atlas. This rewrites the dungeon pieces
// as .gltf + .bin pointing at one shared dungeon_texture.png, so a hundred props carry the atlas
// once, and the client can share one GPU texture between them (assets.ts, shareTextures).
// The first 19 pieces stay .glb: their URLs are in the game and in saved maps' decor.
// Usage: node scripts/assets/share-dungeon-texture.mjs [folder]
import { NodeIO } from '@gltf-transform/core';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'apps/client/public/assets/kaykit/dungeon';
const LEGACY = new Set([
  'torch_lit.gltf.glb', 'chest.glb', 'chest_gold.glb', 'pillar.gltf.glb', 'pillar_decorated.gltf.glb', 'column.gltf.glb', 'barrel_large.gltf.glb',
  'barrel_small_stack.gltf.glb', 'crates_stacked.gltf.glb', 'box_stacked.gltf.glb', 'rubble_large.gltf.glb', 'rubble_half.gltf.glb', 'wall_broken.gltf.glb',
  'banner_red.gltf.glb', 'banner_patternA_blue.gltf.glb', 'candle_lit.gltf.glb', 'coin_stack_large.gltf.glb', 'table_long_decorated_A.gltf.glb', 'stool.gltf.glb',
]);
const TEXTURE = 'dungeon_texture.png';
const io = new NodeIO();
let before = 0;
let after = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.glb') && !LEGACY.has(f))) {
  const path = join(dir, file);
  const name = file.replace(/(\.gltf)?\.glb$/, '');
  before += statSync(path).size;
  const doc = await io.read(path);
  for (const t of doc.getRoot().listTextures()) t.setURI(TEXTURE);
  for (const b of doc.getRoot().listBuffers()) b.setURI(`${name}.bin`);
  await io.write(join(dir, `${name}.gltf`), doc);
  unlinkSync(path);
  after += statSync(join(dir, `${name}.gltf`)).size + statSync(join(dir, `${name}.bin`)).size;
}
console.log(`${(before / 1e6).toFixed(2)} MB of .glb -> ${(after / 1e6).toFixed(2)} MB of .gltf + .bin, plus one ${TEXTURE}`);
