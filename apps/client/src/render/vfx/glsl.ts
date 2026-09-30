/**
 * Shared GLSL for the effect shaders. Value noise, not simplex: it is cheaper, and a few octaves of
 * it look like smoke and flame at the sizes spells are drawn at.
 */
export const NOISE_GLSL = /* glsl */ `
float vfxHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vfxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vfxHash(i), vfxHash(i + vec2(1.0, 0.0)), u.x), mix(vfxHash(i + vec2(0.0, 1.0)), vfxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vfxFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vfxNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
`;

/**
 * The end of every effect fragment shader: tone mapping and the output colour space, so effects sit
 * in the same exposure as the lit world. Without it additive colours skipped the ACES curve and
 * clipped to white by day.
 */
export const OUTPUT_GLSL = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;
