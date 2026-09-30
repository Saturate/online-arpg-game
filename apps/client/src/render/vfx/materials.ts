import { AdditiveBlending, Color, DoubleSide, NormalBlending, ShaderMaterial, Vector2, Vector3, type IUniform } from 'three';
import { NOISE_GLSL, OUTPUT_GLSL } from './glsl.js';
import { PALETTE, STYLE_INDEX, type VfxStyle } from './palette.js';

/**
 * Shader materials for spell shapes. They share the clock and the night factor through uniform
 * objects owned by the Vfx system. Per-instance uniforms (fade, progress, seed) live on each copy;
 * copies of one kind and style share a compiled program because their source and defines match.
 */

// Type aliases, not interfaces: ShaderMaterial wants an index signature, which only aliases satisfy.
export type SharedUniforms = {
  uTime: IUniform<number>;
  /** 0 by day, 1 at deep night: glows lift at night and scorch reads less, so effects feel like light. */
  uNight: IUniform<number>;
};

type StyleUniforms = {
  uCore: IUniform<Color>;
  uBody: IUniform<Color>;
  uDeep: IUniform<Color>;
  uSmoke: IUniform<Color>;
};

/** A material and its uniforms, typed, so callers set values without looking them up by name. */
export interface Shaded<U> {
  material: ShaderMaterial;
  u: U;
}

function styleUniforms(style: VfxStyle): StyleUniforms {
  const p = PALETTE[style];
  return { uCore: { value: p.core }, uBody: { value: p.body }, uDeep: { value: p.deep }, uSmoke: { value: p.smoke } };
}

const FLAT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STYLE_DEFINES = `
#define S_PLAIN ${STYLE_INDEX.plain}
#define S_FIRE ${STYLE_INDEX.fire}
#define S_COLD ${STYLE_INDEX.cold}
#define S_LIGHTNING ${STYLE_INDEX.lightning}
#define S_RESTORE ${STYLE_INDEX.restore}
#define S_WARD ${STYLE_INDEX.ward}
#define S_MIXED ${STYLE_INDEX.mixed}
`;

const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform vec3 uCore;
uniform vec3 uBody;
uniform vec3 uDeep;
uniform vec3 uSmoke;
`;

// ---------------------------------------------------------------------------------------------
// Zones: ground effects. Every style keeps the same crisp ring at the edge, so the area is always
// readable; the inside is where the style lives.

const ZONE_FRAGMENT = /* glsl */ `
${STYLE_DEFINES}
${COMMON_UNIFORMS}
uniform float uFade;
uniform float uGlow;
uniform float uRadius;
uniform float uSeed;
varying vec2 vUv;
${NOISE_GLSL}
float ridge(float n) { return 1.0 - abs(n * 2.0 - 1.0); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  vec2 w = p * uRadius + uSeed * 37.0;
  float ang = atan(p.y, p.x);
  float t = uTime;
  vec3 glow = vec3(0.0);
  float dark = 0.0;
  vec3 darkCol = uSmoke;
  float edge = smoothstep(0.915, 0.945, r) * smoothstep(1.0, 0.975, r);
  float inner = smoothstep(1.0, 0.8, r);
#if STYLE == S_FIRE
  float n = vfxFbm(w * 0.028 + vec2(0.0, t * 0.35));
  float f = vfxFbm(w * 0.07 + vec2(t * 0.25, t * 0.9) + n * 2.4);
  float flames = smoothstep(0.34, 0.72, f * (1.08 - r * 0.4));
  float hot = pow(flames, 3.0);
  glow = mix(uDeep, uBody, flames) * flames * 1.25 + uCore * hot * 0.7;
  // Embers glowing in the ash, blinking out one by one.
  vec2 cw = w * 0.12;
  float cell = vfxHash(floor(cw));
  float spot = smoothstep(0.32, 0.05, length(fract(cw) - 0.5 + (vec2(vfxHash(floor(cw) + 3.1), vfxHash(floor(cw) + 7.7)) - 0.5) * 0.3));
  float ember = step(0.88, cell) * spot * (0.5 + 0.5 * sin(t * (3.0 + cell * 5.0) + cell * 40.0));
  glow += uBody * ember * 0.6 * inner;
  // Heat shimmer: faint bright ripples drifting across the flames.
  glow += uCore * 0.025 * smoothstep(0.75, 1.0, sin(w.y * 0.18 + w.x * 0.05 + t * 5.0 + n * 7.0)) * inner;
  // Scorched ground under it, darkest in a charred band just inside the edge.
  float char = smoothstep(0.7, 0.9, r) * smoothstep(1.0, 0.92, r);
  dark = (0.3 + char * 0.45) * (0.7 + 0.3 * n);
  darkCol = vec3(0.03, 0.02, 0.015);
  glow += mix(uDeep, uBody, 0.75) * edge * 1.2;
#elif STYLE == S_COLD
  // Frost creeping in veins from the rim, with a pale mist over the whole patch.
  float n = vfxFbm(w * 0.03 + vec2(t * 0.05, 0.0));
  float veins = pow(ridge(vfxNoise(w * 0.05 + n * 3.0)), 6.0);
  float creep = smoothstep(0.2, 1.0, r + n * 0.5);
  float frost = max(veins * 0.9, creep * 0.55);
  // Rime is only a little lighter than the ground: at the world's exposure a pale colour at full
  // strength turned the whole patch white.
  dark = frost * 0.5 * inner + 0.1;
  darkCol = mix(uDeep, vec3(0.07, 0.085, 0.1), 0.7);
  glow = uBody * veins * 0.35 + uCore * pow(veins, 3.0) * 0.25;
  // Crystal shards around the rim: bright spikes pointing inward.
  float spikes = pow(abs(sin(ang * 13.0 + uSeed * 20.0)), 14.0) * smoothstep(0.7, 0.95, r);
  float glint = 0.5 + 0.5 * sin(t * 4.0 + ang * 7.0);
  glow += mix(uBody, uCore, 0.5) * spikes * (0.3 + glint * 0.35);
  glow += mix(uDeep, uBody, 0.85) * edge * 1.1;
#elif STYLE == S_LIGHTNING
  // Arcs crawling over scorched ground: thin ridges of noise that jump every few frames.
  float jump = floor(t * 11.0);
  // Jagged: the line follows a noise ridge whose input is itself kicked by finer noise.
  vec2 q1 = w * 0.03 + vec2(jump * 1.7, jump * 0.9);
  vec2 q2 = w * 0.045 + vec2(-jump * 1.3, jump * 2.1);
  float n1 = vfxNoise(q1 + (vfxNoise(q1 * 6.0) - 0.5) * 0.35);
  float n2 = vfxNoise(q2 + (vfxNoise(q2 * 7.0) - 0.5) * 0.35);
  float gate1 = step(0.4, vfxHash(vec2(jump, 3.0) + floor(w * 0.015)));
  float arc = smoothstep(0.014, 0.0, abs(n1 - 0.5)) * gate1;
  arc += smoothstep(0.01, 0.0, abs(n2 - 0.5)) * step(0.5, vfxHash(vec2(jump, 7.0)));
  float halo = (smoothstep(0.06, 0.0, abs(n1 - 0.5)) * gate1) * 0.25;
  glow = (uCore * 1.6 * arc + uBody * halo) * inner;
  float flicker = 0.75 + 0.25 * vfxHash(vec2(jump, 1.0));
  glow += uBody * 0.07 * inner * flicker;
  dark = 0.22 * inner;
  darkCol = vec3(0.04, 0.04, 0.05);
  glow += mix(uDeep, uBody, 0.7) * edge * (0.8 + 0.3 * flicker);
#elif STYLE == S_PLAIN
  // Dust stirred on the ground.
  float n = vfxFbm(w * 0.04 + vec2(t * 0.2, -t * 0.1));
  float swirl = vfxFbm(vec2(ang * 2.0 + t * 0.4, r * 4.0 - t * 0.3));
  dark = (0.18 + 0.2 * n * swirl) * inner;
  darkCol = uSmoke * 0.6;
  glow = uBody * 0.05 * swirl * inner;
  glow += uBody * edge * 0.75;
#else
  // Restore, ward and mixed: a slow runic circle, a band of glyph marks and a soft inner light.
  float spin = t * 0.08;
  float fa = fract((ang + spin) * 24.0 / 6.2831);
  float hs = vfxHash(vec2(floor((ang + spin) * 24.0 / 6.2831), uSeed));
  // Glyphs: thin strokes of differing length in the band, like the aura's circle.
  float stroke = smoothstep(0.07, 0.0, abs(fa - 0.5)) + smoothstep(0.05, 0.0, abs(fa - 0.15 - hs * 0.7)) * 0.6;
  float band = smoothstep(0.77, 0.79, r) * smoothstep(0.87 - hs * 0.04, 0.85 - hs * 0.04, r);
  float marks = stroke * band * step(0.3, hs);
  float ringIn = smoothstep(0.012, 0.0, abs(r - 0.76));
  float ringOut = smoothstep(0.01, 0.0, abs(r - 0.89));
  float breathe = 0.8 + 0.2 * sin(t * 1.6 + uSeed * 6.0);
  float n = vfxFbm(w * 0.03 + vec2(t * 0.1, t * 0.07));
  float soft = (1.0 - r) * 0.12 * (0.5 + n);
  vec3 tone = mix(uDeep, uBody, 0.65);
  glow = tone * (soft + marks * 0.4 + (ringIn + ringOut) * 0.3) * breathe;
  glow += uCore * pow(1.0 - r, 4.0) * 0.08 * breathe;
  dark = 0.1 * inner;
  darkCol = uDeep * 0.4;
  glow += tone * edge * 0.9;
#endif
  // The world is drawn at an exposure of about 1.5, so body colours at full strength clip to yellow
  // white; about half keeps embers orange by day.
  float nightGain = mix(0.5, 0.8, uNight);
  float a = clamp(dark * mix(1.0, 0.6, uNight), 0.0, 0.9) * uFade;
  gl_FragColor = vec4(glow * nightGain * uGlow + darkCol * a, a);
  ${OUTPUT_GLSL}
}
`;

export type ZoneUniforms = SharedUniforms & StyleUniforms & { uFade: IUniform<number>; uGlow: IUniform<number>; uRadius: IUniform<number>; uSeed: IUniform<number> };

export function zoneMaterial(style: VfxStyle, shared: SharedUniforms): Shaded<ZoneUniforms> {
  const uniforms: ZoneUniforms = { ...shared, ...styleUniforms(style), uFade: { value: 1 }, uGlow: { value: 1 }, uRadius: { value: 60 }, uSeed: { value: Math.random() } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: ZONE_FRAGMENT,
    defines: { STYLE: STYLE_INDEX[style] },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// Novas: a shockwave ring. The mesh is scaled to 1.15x the current radius so the leading edge sits
// at r = 1 / 1.15 in the quad; the dark band behind the edge stands in for refraction.

const NOVA_FRAGMENT = /* glsl */ `
${STYLE_DEFINES}
${COMMON_UNIFORMS}
uniform float uProgress;
uniform float uSeed;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * 1.15;
  float r = length(p);
  if (r > 1.15) discard;
  float ang = atan(p.y, p.x);
  float k = uProgress;
  float n = vfxNoise(vec2(ang * 7.0 + uSeed * 30.0, r * 5.0 - uTime * 3.0));
  float front = smoothstep(1.06, 1.0, r) * smoothstep(0.9, 0.995, r);
  float band = smoothstep(0.55, 0.9, r) * smoothstep(1.0, 0.92, r);
  float fill = smoothstep(1.0, 0.2, r) * 0.12;
  float life = pow(1.0 - k, 0.7);
  vec3 glow = (uBody * 0.9 * front * (0.7 + n * 0.5) + uCore * pow(front, 3.0) * 0.45 + uBody * fill * (1.0 - k)) * life;
  float dark = band * (0.28 + n * 0.25) * life;
  vec3 darkCol = uSmoke * 0.35;
#if STYLE == S_LIGHTNING
  float jump = floor(uTime * 14.0);
  float jag = vfxNoise(vec2(ang * 18.0, jump));
  glow *= 0.6 + 0.9 * step(0.4, jag);
  darkCol = vec3(0.03);
#elif STYLE == S_COLD
  float spikes = pow(abs(sin(ang * 17.0 + uSeed * 9.0)), 10.0) * smoothstep(0.7, 0.98, r) * smoothstep(1.05, 0.98, r);
  glow += uCore * spikes * 0.4 * life;
  darkCol = mix(uDeep, vec3(0.07, 0.085, 0.1), 0.7);
  dark *= 0.8;
#elif STYLE == S_FIRE
  darkCol = vec3(0.04, 0.025, 0.02);
#elif STYLE == S_PLAIN
  // Impact and plain novas throw a heavy ring of dust rather than light.
  glow *= 0.55;
  dark *= 1.5;
  darkCol = uSmoke * 0.5;
#else
  dark *= 0.35;
#endif
  float nightGain = mix(0.55, 0.85, uNight);
  float a = clamp(dark * mix(1.0, 0.65, uNight), 0.0, 0.85);
  gl_FragColor = vec4(glow * nightGain + darkCol * a, a);
  ${OUTPUT_GLSL}
}
`;

export type NovaUniforms = SharedUniforms & StyleUniforms & { uProgress: IUniform<number>; uSeed: IUniform<number> };

export function novaMaterial(style: VfxStyle, shared: SharedUniforms): Shaded<NovaUniforms> {
  const uniforms: NovaUniforms = { ...shared, ...styleUniforms(style), uProgress: { value: 0 }, uSeed: { value: Math.random() } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: NOVA_FRAGMENT,
    defines: { STYLE: STYLE_INDEX[style] },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// Orbs: a solid, heavy ball. Its surface turns in object space so it reads as rolling.

const ORB_VERTEX = /* glsl */ `
varying vec3 vObj;
varying vec3 vNormalView;
varying vec3 vViewPos;
void main() {
  vObj = position;
  vNormalView = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const ORB_FRAGMENT = /* glsl */ `
${STYLE_DEFINES}
${COMMON_UNIFORMS}
uniform float uSeed;
uniform vec3 uSpin;
varying vec3 vObj;
varying vec3 vNormalView;
varying vec3 vViewPos;
${NOISE_GLSL}
float ridge(float n) { return 1.0 - abs(n * 2.0 - 1.0); }
void main() {
  // Orthographic camera: the view direction is constant, straight into the screen.
  float facing = clamp(dot(normalize(vNormalView), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
  float rim = pow(1.0 - facing, 2.2);
  vec3 q = vObj;
  float c = cos(uSpin.x);
  float s = sin(uSpin.x);
  q.xz = mat2(c, -s, s, c) * q.xz;
  c = cos(uSpin.y);
  s = sin(uSpin.y);
  q.yz = mat2(c, -s, s, c) * q.yz;
  vec2 uvA = q.xy * 2.2 + q.z * 1.3 + uSeed * 10.0;
  float n = vfxFbm(uvA);
  vec3 col;
#if STYLE == S_FIRE
  // A black crust split by molten cracks.
  float cracks = pow(ridge(vfxNoise(uvA * 1.6 + n * 1.5)), 8.0);
  float pulse = 0.8 + 0.2 * sin(uTime * 7.0 + uSeed * 9.0);
  col = uDeep * 0.12 + uBody * cracks * 1.6 * pulse + uCore * pow(cracks, 4.0) * 0.9;
  col += uBody * rim * 1.1;
#elif STYLE == S_COLD
  // Clouded ice: dark blue depth, pale facets and a frosted rim.
  float facets = pow(ridge(vfxNoise(uvA * 1.3)), 4.0);
  col = uDeep * 0.5 + uBody * (0.25 + facets * 0.6) + uCore * pow(facets, 6.0) * 0.8;
  col += mix(uBody, uCore, 0.5) * rim * 1.0;
#elif STYLE == S_LIGHTNING
  // A dark storm core with arcs racing over the surface.
  float jump = floor(uTime * 16.0);
  float arcs = smoothstep(0.05, 0.0, abs(vfxNoise(uvA * 1.4 + jump * 0.37) - 0.5));
  col = uDeep * 0.2 + (uBody + uCore * 0.6) * arcs * 1.4;
  col += uBody * rim * 1.2;
#else
  float swirl = pow(ridge(vfxNoise(uvA * 1.2 + n)), 5.0);
  col = uDeep * 0.25 + uBody * swirl * 0.9 + uCore * pow(swirl, 5.0) * 0.4;
  col += uBody * rim * 0.9;
#endif
  col *= mix(0.6, 0.85, uNight);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}
`;

export type OrbUniforms = SharedUniforms & StyleUniforms & { uSeed: IUniform<number>; uSpin: IUniform<Vector3> };

export function orbMaterial(style: VfxStyle, shared: SharedUniforms): Shaded<OrbUniforms> {
  const uniforms: OrbUniforms = { ...shared, ...styleUniforms(style), uSeed: { value: Math.random() }, uSpin: { value: new Vector3() } };
  return { material: new ShaderMaterial({ uniforms, vertexShader: ORB_VERTEX, fragmentShader: ORB_FRAGMENT, defines: { STYLE: STYLE_INDEX[style] } }), u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// Auras: a faint runic circle on the ground around the caster, the same size as the aura.

const AURA_FRAGMENT = /* glsl */ `
${STYLE_DEFINES}
${COMMON_UNIFORMS}
uniform float uSeed;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x) + uTime * 0.12 * (uSeed > 0.5 ? 1.0 : -1.0);
  float outer = smoothstep(0.035, 0.0, abs(r - 0.975));
  float inner = smoothstep(0.02, 0.0, abs(r - 0.86));
  float seg = floor(ang * 18.0 / 6.2831);
  // Glyph marks: short strokes of differing length between the two rings, not solid tiles.
  float f = fract(ang * 18.0 / 6.2831);
  float h = vfxHash(vec2(seg, uSeed * 13.0));
  float stroke = smoothstep(0.08, 0.0, abs(f - 0.5)) + smoothstep(0.05, 0.0, abs(f - 0.2 - h * 0.6)) * 0.7;
  float glyph = stroke * smoothstep(0.87, 0.89, r) * smoothstep(0.96 - h * 0.04, 0.93 - h * 0.04, r) * step(0.3, h);
  float breathe = 0.75 + 0.25 * sin(uTime * 1.3 + uSeed * 5.0);
  float fill = (1.0 - r) * 0.05;
  vec3 glow = uBody * (outer * 0.55 + inner * 0.25 + glyph * 0.15 + fill) * breathe;
  glow *= mix(0.45, 0.75, uNight);
  gl_FragColor = vec4(glow, 0.0);
  ${OUTPUT_GLSL}
}
`;

export type AuraUniforms = SharedUniforms & StyleUniforms & { uSeed: IUniform<number> };

export function auraMaterial(style: VfxStyle, shared: SharedUniforms): Shaded<AuraUniforms> {
  const uniforms: AuraUniforms = { ...shared, ...styleUniforms(style), uSeed: { value: Math.random() } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: AURA_FRAGMENT,
    defines: { STYLE: STYLE_INDEX[style] },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// Bond tethers: a cord with pulses running from the caster to the bonded ally.

const TETHER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform float uLength;
uniform vec3 uBody;
uniform vec3 uCore;
varying vec2 vUv;
void main() {
  float along = vUv.y * uLength;
  float pulse = pow(0.5 + 0.5 * sin(along * 0.12 - uTime * 7.0), 6.0);
  float across = 1.0 - abs(fract(vUv.x * 2.0) * 2.0 - 1.0);
  vec3 col = uBody * (0.35 + across * 0.35) + uCore * pulse * 0.8;
  col *= mix(0.5, 0.8, uNight);
  gl_FragColor = vec4(col, 0.0);
  ${OUTPUT_GLSL}
}
`;

export type TetherUniforms = SharedUniforms & { uLength: IUniform<number>; uBody: IUniform<Color>; uCore: IUniform<Color> };

export function tetherMaterial(shared: SharedUniforms): Shaded<TetherUniforms> {
  const uniforms: TetherUniforms = { ...shared, uLength: { value: 100 }, uBody: { value: PALETTE.ward.body }, uCore: { value: PALETTE.ward.core } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: TETHER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// The Low look of zones and novas: the old flat fill and edge ring, in one quad and one draw
// instead of two meshes.

const PLAIN_AREA_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFill;
uniform float uRing;
uniform float uInner;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ring = step(uInner, r);
  float k = ring > 0.5 ? uRing : uFill;
  gl_FragColor = vec4(uColor * k, 0.0);
  ${OUTPUT_GLSL}
}
`;

export type PlainAreaUniforms = { uColor: IUniform<Color>; uFill: IUniform<number>; uRing: IUniform<number>; uInner: IUniform<number> };

export function plainAreaMaterial(color: number, inner: number): Shaded<PlainAreaUniforms> {
  const uniforms: PlainAreaUniforms = { uColor: { value: new Color(color) }, uFill: { value: 0.2 }, uRing: { value: 0.8 }, uInner: { value: inner } };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: PLAIN_AREA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}

// ---------------------------------------------------------------------------------------------
// Enemy wind-ups and hazards: one hostile look for every enemy ground marker, so it can never be
// read as a player's spell. Player areas have a solid ring in their element's colour; these have a
// blood-red ring broken into segments with a dark border, and the element only as a thin inner
// tick. Circles are a 2 x 2 quad scaled by the radius; lines a 1 x 1 plane scaled to length and
// width, with `uSize` in world units so the border and dashes keep their size.

export const HOSTILE = { ring: 0xb81c14, ringAlpha: 0.9, border: 0x1a0806, borderAlpha: 0.8, fillAlpha: 0.26, segments: 24 } as const;

const HOSTILE_FRAGMENT = /* glsl */ `
uniform vec3 uRing;
uniform vec3 uBorder;
uniform vec3 uTick;
uniform float uRingA;
uniform float uBorderA;
uniform float uFillA;
/** 0 to 1: how far the fill has grown (radius share for circles, length share for lines). */
uniform float uFill;
/** Opacity of the whole marker: fades hazards in and out, 1 for telegraphs. */
uniform float uAlpha;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vec3 col = vec3(0.0);
  float a = 0.0;
  float ring;
  float border;
  float tick;
  float fill;
#ifdef LINE
  // Distances in world units: along the line from its start, across from its nearer long edge.
  float along = vUv.x * uSize.x;
  float edge = min(min(vUv.y, 1.0 - vUv.y) * uSize.y, min(along, uSize.x - along));
  border = step(edge, 3.0);
  float dash = step(0.3, fract(along / 22.0));
  ring = step(3.0, edge) * step(edge, 7.0) * dash;
  tick = step(8.5, edge) * step(edge, 10.0);
  fill = step(vUv.x, uFill) * step(7.0, edge);
#else
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  // Widths as a share of the radius, with a floor so small circles keep a readable ring.
  float px = 1.0 / max(uSize.x, 1.0);
  float bw = max(0.03, 3.0 * px);
  float rw = max(0.06, 5.0 * px);
  float tw = max(0.012, 1.5 * px);
  float ang = atan(p.y, p.x);
  float seg = step(0.28, fract(ang * ${HOSTILE.segments}.0 / 6.2831853));
  border = step(1.0 - bw, r);
  ring = step(1.0 - bw - rw, r) * step(r, 1.0 - bw) * seg;
  float t0 = 1.0 - bw - rw - 1.5 * tw;
  tick = step(t0 - tw, r) * step(r, t0);
  fill = step(r, uFill * (1.0 - bw));
#endif
  // Layered front to back: border, ring, tick, fill; each covers what is under it.
  if (border > 0.5) { col = uBorder; a = uBorderA; }
  else if (ring > 0.5) { col = uRing; a = uRingA; }
  else if (tick > 0.5) { col = uTick; a = 0.8; }
  else if (fill > 0.5) { col = uRing; a = uFillA; }
  a *= uAlpha;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(col * a, a);
  ${OUTPUT_GLSL}
}
`;

export type HostileUniforms = {
  uRing: IUniform<Color>;
  uBorder: IUniform<Color>;
  uTick: IUniform<Color>;
  uRingA: IUniform<number>;
  uBorderA: IUniform<number>;
  uFillA: IUniform<number>;
  uFill: IUniform<number>;
  uAlpha: IUniform<number>;
  uSize: IUniform<Vector2>;
};

/** The hostile marker for one telegraph or hazard. `tick` is the element's colour. */
export function hostileMaterial(shape: 'circle' | 'line', tick: number): Shaded<HostileUniforms> {
  const uniforms: HostileUniforms = {
    uRing: { value: new Color(HOSTILE.ring) },
    uBorder: { value: new Color(HOSTILE.border) },
    uTick: { value: new Color(tick) },
    uRingA: { value: HOSTILE.ringAlpha },
    uBorderA: { value: HOSTILE.borderAlpha },
    uFillA: { value: HOSTILE.fillAlpha },
    uFill: { value: 0 },
    uAlpha: { value: 1 },
    uSize: { value: new Vector2(60, 60) },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: FLAT_VERTEX,
    fragmentShader: HOSTILE_FRAGMENT,
    defines: shape === 'line' ? { LINE: 1 } : {},
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
  return { material, u: uniforms };
}
