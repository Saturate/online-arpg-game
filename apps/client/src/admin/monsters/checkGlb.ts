import { Texture, TextureLoader } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AnimRole } from '../../render/assets.js';
import { checkModel, guessRoles, type ModelReport } from './modelChecks.js';

/**
 * The Model check for a .glb read from disk, for `pnpm model:check` and tests. GLTFLoader parses
 * fine outside a browser except for images, which it decodes through the DOM; textures load as
 * blank Textures instead, which is all the checks need (they only ask whether a material has one).
 */

class BlankTextureLoader extends TextureLoader {
  override load(_url: string, onLoad?: (texture: Texture<HTMLImageElement>) => void): Texture<HTMLImageElement> {
    const texture = new Texture<HTMLImageElement>();
    onLoad?.(texture);
    return texture;
  }
}

export interface GlbCheck {
  report: ModelReport;
  clips: { name: string; seconds: number }[];
  roles: Partial<Record<AnimRole, string>>;
}

export async function checkGlb(bytes: Uint8Array): Promise<GlbCheck> {
  // GLTFLoader reads embedded images through self.URL, which Node has as the global URL.
  if (typeof self === 'undefined') Object.assign(globalThis, { self: globalThis });
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const loader = new GLTFLoader().register((parser) => {
    parser.textureLoader = new BlankTextureLoader();
    return { name: 'blank_textures' };
  });
  const gltf = await loader.parseAsync(buffer, '');
  const json: unknown = gltf.parser.json;
  const roles = guessRoles(gltf.animations.map((c) => c.name));
  const report = checkModel({ scene: gltf.scene, clips: gltf.animations, json, bytes: bytes.byteLength, roles });
  return { report, clips: gltf.animations.map((c) => ({ name: c.name, seconds: c.duration })), roles };
}
