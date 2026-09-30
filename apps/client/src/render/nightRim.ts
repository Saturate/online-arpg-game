import { Color, type Material, type WebGLProgramParametersWithUniforms } from 'three';

/**
 * Cold moonlight on the edges of enemies at night. Many monsters are near black and lit only by the
 * low night fill, so at night they vanished into the ground with only their eyes showing; a faint
 * blue rim picks out the silhouette without lifting the ground around them. Enemies only: heroes
 * and minions stay warm or unrimmed so friend and foe still read apart.
 */

/** The part of a program the shader hooks edit; narrower than three's type so tests can build one. */
export type ShaderSource = Pick<WebGLProgramParametersWithUniforms, 'uniforms' | 'vertexShader' | 'fragmentShader'>;

/** Rim strength at deep night; the scene eases it from 0 by day. */
export const NIGHT_RIM = 0.34;

/** Set by the scene every frame from the night factor; 0 by day and underground. */
export const nightRim = { value: 0 };

/** Moonlight blue, the same hue as the night sun. */
export const RIM_COLOR = new Color(0.42, 0.48, 0.66);

/** GLSL added after the emissive include: `normal` and `vViewPosition` are in view space there. */
export function rimChunk(uniform: string): string {
  return `
float rimF = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
totalEmissiveRadiance += vec3(${RIM_COLOR.r.toFixed(2)}, ${RIM_COLOR.g.toFixed(2)}, ${RIM_COLOR.b.toFixed(2)}) * ${uniform} * pow(rimF, 2.5);`;
}

/**
 * Adds the rim to a compiled standard material's shader. `scale` tunes it per model family: the
 * KayKit models have smooth normals, so their rim spreads wider than on the flat-shaded rigs.
 */
export function injectRim(shader: ShaderSource, scale = 1): void {
  shader.uniforms.uRim = {
    get value(): number {
      return nightRim.value * scale;
    },
  };
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uRim;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${rimChunk('uRim')}`);
}

/** How strong the rim is on KayKit monsters relative to the procedural rigs. */
const KAYKIT_RIM = 0.8;

/**
 * Chains the rim onto a material's own shader hook (the corruption repaint, say) and keeps its
 * program apart from unrimmed copies of the same material.
 */
export function addNightRim(m: Material): void {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    injectRim(shader, KAYKIT_RIM);
  };
  m.customProgramCacheKey = () => `${prevKey}|rim`;
}
