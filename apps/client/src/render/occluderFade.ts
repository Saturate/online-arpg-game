import { Vector2, Vector3, type Material, type WebGLProgramParametersWithUniforms } from 'three';

/**
 * Cuts a dithered hole through walls and buildings that stand between the camera and the hero, the
 * way D2 fades walls you walk behind. Dithered discard instead of transparency, because walls are
 * merged or instanced meshes that cannot be sorted per piece. Shadows use a separate depth material,
 * so they stay whole.
 */
export const fadeUniforms = {
  uFadeCenter: { value: new Vector3() },
  /** Ground direction from the hero toward the camera. */
  uFadeDir: { value: new Vector2(0, 1) },
  uFadeRadius: { value: 95 },
};

const VERTEX_DECL = /* glsl */ `
varying vec3 vFadeWorld;
`;

const VERTEX_BODY = /* glsl */ `
  vec4 fadePos = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    fadePos = instanceMatrix * fadePos;
  #endif
  vFadeWorld = (modelMatrix * fadePos).xyz;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vFadeWorld;
uniform vec3 uFadeCenter;
uniform vec2 uFadeDir;
uniform float uFadeRadius;
`;

const FRAGMENT_BODY = /* glsl */ `
  {
    vec2 d = vFadeWorld.xz - uFadeCenter.xz;
    float along = dot(d, uFadeDir);
    float side = length(d - uFadeDir * along);
    // Only what is in front of the hero (toward the camera), close to the line of sight, and above ankle height.
    if (along > -12.0 && along < 320.0 && vFadeWorld.y > 8.0) {
      float strength = 1.0 - smoothstep(uFadeRadius * 0.55, uFadeRadius, side);
      // Interleaved gradient noise: a stable screen-space dither with no visible grid.
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (n < strength * 0.8) discard;
    }
  }
`;

/** Patches a material in place to fade near the hero. Returns it for chaining. */
export function withOccluderFade<M extends Material>(material: M): M {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, fadeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_BODY}`);
  };
  // Separate program from the unpatched material, or three would reuse one for the other.
  material.customProgramCacheKey = () => 'occluder-fade';
  material.needsUpdate = true;
  return material;
}
