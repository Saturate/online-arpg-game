import { Color, Mesh, MeshStandardMaterial, Scene, type AnimationClip, type Object3D, type Texture } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { instantiate, type AssetDef } from '../render/assets.js';
import { applyLeafTransforms, bakeExportTransform, cleanForExport, corruptPixels, corruptTint, exportFrame, finishGlb, mergeMaterials, originalNames, pushDownScales } from './exportPrep.js';

/** Writes a prepared model (export frame, metres, facing +Z) as a binary glTF. */
export async function toGlb(root: Object3D, clips: AnimationClip[], names: ReadonlyMap<string, string>, keepRoot: boolean): Promise<ArrayBuffer> {
  const scene = new Scene();
  // A model file's own top nodes (KayKit's "Rig") become the file's roots again, as in the source;
  // procedural rigs keep the root, since their Death clip turns it.
  if (keepRoot) scene.add(root);
  else for (const c of [...root.children]) scene.add(c);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, animations: clips, onlyVisible: true });
  if (!(data instanceof ArrayBuffer)) throw new Error('Exporter returned JSON instead of a binary file');
  return finishGlb(data, names, root.name);
}

export function download(data: ArrayBuffer, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revoked on the next task: some browsers start the download only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isDrawable(image: unknown): image is CanvasImageSource & { width: number; height: number } {
  return (
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement)
  );
}

/**
 * Monsters built on hero models are repainted in a shader (assets.ts corruptMaterial), which glTF
 * cannot carry: exported as they are, an Ogre would open in Blender as the Barbarian. This bakes
 * the repaint into a copy of the texture (or the colour, without one) and sets the colour to white.
 */
function bakeCorruption(root: Object3D): void {
  const baked = new Map<string, Texture>();
  const done = new Map<MeshStandardMaterial, MeshStandardMaterial>();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !(o.material instanceof MeshStandardMaterial)) return;
    const src = o.material;
    const tint = corruptTint(src);
    if (!tint) return;
    let m = done.get(src);
    if (!m) {
      m = src.clone();
      const map = src.map;
      if (map && isDrawable(map.image)) {
        const key = `${map.uuid}|${src.color.getHex()}|${tint.getHex()}`;
        let tex = baked.get(key);
        if (!tex) {
          const canvas = document.createElement('canvas');
          canvas.width = map.image.width;
          canvas.height = map.image.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('No 2D canvas to bake the monster colours');
          ctx.drawImage(map.image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          corruptPixels(pixels.data, src.color, tint);
          ctx.putImageData(pixels, 0, 0);
          tex = map.clone();
          tex.image = canvas;
          tex.needsUpdate = true;
          baked.set(key, tex);
        }
        m.map = tex;
        m.color.set(0xffffff);
      } else {
        const c = new Uint8ClampedArray([255, 255, 255, 255]);
        corruptPixels(c, src.color, tint);
        m.color.setRGB((c[0] ?? 0) / 255, (c[1] ?? 0) / 255, (c[2] ?? 0) / 255, 'srgb');
      }
      m.name = `${src.name || 'material'} (${new Color(tint).getHexString()})`;
      done.set(src, m);
    }
    o.material = m;
  });
}

/**
 * Exports a registry model as the game shows it: the chosen weapon on its bone, the other weapons
 * left out, tint and glow in the materials, scaled to its in-game height in metres, feet at the
 * origin, facing +Z like the source file. The game's own quarter turn is not baked in, so the file
 * goes back into the game the same way the KayKit ones did.
 */
export async function exportAsset(def: AssetDef): Promise<void> {
  const inst = await instantiate(def);
  // instantiate() builds root > pivot (fit scale and the game's turn) > model (feet offset).
  const pivot = inst.root.children[0];
  const model = pivot?.children[0];
  if (!pivot || !model) throw new Error(`Unexpected node layout for ${def.id}`);
  if (def.weapon) {
    const bone = model.getObjectByName(def.weapon.bone);
    // build() adds the weapon file's scene last; its mesh already carries the weapon's own name.
    const weapon = bone?.children.at(-1);
    if (weapon && weapon.type !== 'Bone') weapon.name = 'weapon';
  }
  const names = originalNames(model);
  model.name = def.id;
  cleanForExport(model);
  bakeCorruption(model);
  // In world units the model is pivot.scale times the file; the frame takes that on to metres.
  const { root, clips } = bakeExportTransform(model, inst.clips, exportFrame(0).scale(pivot.scale), def.id);
  pushDownScales(root, clips);
  applyLeafTransforms(root, clips);
  mergeMaterials(root);
  download(await toGlb(root, clips, names, false), `${def.id}.glb`);
}
