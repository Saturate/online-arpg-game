import { ShaderChunk } from 'three';

/**
 * Makes the cute KayKit models read as worn and dirty, D2 style, without new art: every lit
 * (standard) material gets grime blotches laid out in world space, soot toward the ground and some
 * of its toy colour drained. Done once on the shared shader chunks, so models, props, trees and the
 * ground all age the same way. Must run before the first material compiles.
 */

let applied = false;

export function applyGrit(): void {
  if (applied) return;
  applied = true;

  ShaderChunk.common += `
varying vec3 vGritWorld;
float gritHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float gritNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gritHash(i), gritHash(i + vec2(1.0, 0.0)), u.x), mix(gritHash(i + vec2(0.0, 1.0)), gritHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

  // World position for the fragment stage, instancing included, so grime stays put on the world
  // instead of swimming with the camera.
  ShaderChunk.project_vertex += `
vec4 gritPos = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
gritPos = instanceMatrix * gritPos;
#endif
vGritWorld = (modelMatrix * gritPos).xyz;
`;

  ShaderChunk.color_fragment += `
#ifdef STANDARD
{
  // Two octaves of blotchy grime, darker in the pits.
  float grime = gritNoise(vGritWorld.xz * 0.018) * 0.6 + gritNoise(vGritWorld.xz * 0.09 + vGritWorld.y * 0.05) * 0.4;
  float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(vec3(luma), diffuseColor.rgb, 0.78);
  diffuseColor.rgb *= mix(0.72, 1.02, grime);
  // Soot and mud toward the ground: the bottom of walls, legs and trunks are the dirtiest.
  diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.0, 45.0, vGritWorld.y));
}
#endif
`;
}
