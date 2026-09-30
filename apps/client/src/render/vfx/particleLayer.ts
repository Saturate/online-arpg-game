import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  type IUniform,
} from 'three';
import { RENDER_ORDER } from '../config.js';
import { NOISE_GLSL, OUTPUT_GLSL } from './glsl.js';
import { INSTANCE_STRIDE, ParticlePool } from './pool.js';

const VERTEX = /* glsl */ `
attribute vec4 iPosSize;
attribute vec4 iColor;
attribute vec4 iVelStretch;
attribute vec2 iShapeSeed;
uniform float uTime;
varying vec4 vColor;
varying vec2 vUv;
varying float vShape;
varying float vSeed;
varying float vGround;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 ax = right;
  vec3 ay = up;
  float size = iPosSize.w;
  float sy = 1.0;
  vec3 vel = iVelStretch.xyz;
  vec2 sv = vec2(dot(vel, right), dot(vel, up));
  float speed = length(sv);
#ifdef FLAT
  // Ground decals lie on the ground and turn slowly by seed.
  float ga = iShapeSeed.y * 6.2831 + uTime * (iShapeSeed.y - 0.5) * 0.2;
  ax = vec3(cos(ga), 0.0, sin(ga));
  ay = vec3(-sin(ga), 0.0, cos(ga));
#else
  if (iVelStretch.w > 0.0 && speed > 1.0) {
    // Sparks and streaks point along their motion on screen and lengthen with speed.
    vec2 d = sv / speed;
    ay = right * d.x + up * d.y;
    ax = right * -d.y + up * d.x;
    sy = 1.0 + iVelStretch.w * min(speed, 600.0) * 0.01;
  } else {
    // Flames always point up; everything else turns by seed so a cloud of sprites never repeats.
    float a = abs(iShapeSeed.x - 4.0) < 0.5 ? 0.0 : iShapeSeed.y * 6.2831 + uTime * (iShapeSeed.y - 0.5) * 1.5;
    float c = cos(a);
    float s = sin(a);
    ax = right * c + up * s;
    ay = right * -s + up * c;
  }
#endif
  vec3 world = iPosSize.xyz + ax * position.x * size + ay * position.y * size * sy;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vColor = iColor;
  vUv = position.xy * 2.0;
  vShape = iShapeSeed.x;
  vSeed = iShapeSeed.y;
  // Sprites low on the ground fade where they would cut into it: a cheap stand-in for soft particles.
#ifdef FLAT
  vGround = 1.0;
#else
  vGround = clamp(iPosSize.y / max(1.0, size * 0.35), 0.0, 1.0);
#endif
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uGain;
uniform float uAdditive;
varying vec4 vColor;
varying vec2 vUv;
varying float vShape;
varying float vSeed;
varying float vGround;
${NOISE_GLSL}
void main() {
  float r = length(vUv);
  float a = 0.0;
  vec3 col = vColor.rgb;
  int shape = int(vShape + 0.5);
  if (shape == 0) {
    a = pow(max(0.0, 1.0 - r), 2.2);
  } else if (shape == 1) {
    // Smoke: a lumpy puff that churns as it ages.
    float n = vfxFbm(vUv * 1.6 + vec2(vSeed * 19.0, uTime * 0.35 + vSeed * 7.0));
    a = smoothstep(1.0, 0.25, r + (0.5 - n) * 0.7);
    col *= 0.75 + n * 0.5;
  } else if (shape == 2) {
    // Spark: a thin hot streak.
    float w = abs(vUv.x);
    a = pow(max(0.0, 1.0 - w * 2.6), 2.0) * pow(max(0.0, 1.0 - abs(vUv.y)), 1.2);
    col = mix(col, vec3(1.0, 0.97, 0.9) * max(max(col.r, col.g), col.b), a * 0.6);
  } else if (shape == 3) {
    // Shard: a diamond with a hard edge and a bright facet.
    float d = abs(vUv.x) * 1.6 + abs(vUv.y);
    a = smoothstep(1.0, 0.85, d);
    col *= 0.7 + 0.6 * step(0.0, vUv.x * vUv.y + 0.1);
  } else if (shape == 4) {
    // Flame tongue: a rounded base licking up to a flickering tip.
    vec2 p = vUv;
    float up = (p.y + 1.0) * 0.5;
    float n = vfxNoise(vec2(p.x * 2.5 + vSeed * 11.0, p.y * 2.0 - uTime * 5.0));
    float width = pow(max(0.0, 1.0 - up), 0.7) * 0.75 * (0.8 + 0.4 * n);
    float sway = sin(uTime * 7.0 + vSeed * 20.0 + up * 3.0) * 0.12 * up;
    a = pow(smoothstep(width, 0.0, abs(p.x - sway)), 1.5) * smoothstep(0.0, 0.3, up) * 0.8;
    col = mix(col * 0.7, col * 1.3 + vec3(0.2, 0.1, 0.0), (1.0 - up) * (1.0 - abs(p.x)));
  } else if (shape == 5) {
    // Mote: a soft dot with a faint cross, for runic and holy light.
    float cross = max(pow(max(0.0, 1.0 - abs(vUv.x) * 6.0), 2.0), pow(max(0.0, 1.0 - abs(vUv.y) * 6.0), 2.0)) * (1.0 - r);
    a = pow(max(0.0, 1.0 - r), 3.0) + cross * 0.6;
  } else if (shape == 6) {
    // Core: a white hot centre inside the colour, with a long soft falloff.
    float inner = pow(max(0.0, 1.0 - r * 1.8), 2.0);
    a = pow(max(0.0, 1.0 - r), 1.6);
    col = mix(col, vec3(1.0, 0.96, 0.88) * (0.6 + max(max(col.r, col.g), col.b)), inner);
    a = max(a, inner);
  } else if (shape == 7) {
    // Chunk: debris, grit and ash with a ragged edge.
    float n = vfxNoise(vUv * 3.0 + vSeed * 30.0);
    a = step(r + (n - 0.5) * 0.5, 0.75);
  } else if (shape == 9) {
    // Disc: a solid round sprite with a crisp edge, the Low look of a bolt.
    a = smoothstep(1.0, 0.9, r);
  } else {
    // Ring: a thin halo, for impacts.
    a = smoothstep(0.12, 0.0, abs(r - 0.8)) * step(r, 1.0);
  }
  a *= vColor.a * vGround;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col * uGain * a, a * (1.0 - uAdditive));
  ${OUTPUT_GLSL}
}
`;

/**
 * One instanced draw for every particle of one blend mode. Pooled particles are written first, then
 * per-frame sprites (projectile cores, status glows) that live for exactly one frame; both share the
 * buffer, so a hundred glowing bolts add nothing to the draw count.
 */
export class ParticleLayer {
  readonly pool: ParticlePool;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly geometry: InstancedBufferGeometry;
  /** Instances written this frame: the pool first, then sprites. */
  private used = 0;
  private readonly spriteCap: number;
  readonly uniforms: { uTime: IUniform<number>; uGain: IUniform<number>; uAdditive: IUniform<number> };

  constructor(capacity: number, spriteCapacity: number, additive: boolean, time: IUniform<number>, flat = false) {
    this.pool = new ParticlePool(capacity);
    this.spriteCap = spriteCapacity;
    const total = capacity + spriteCapacity;
    this.data = new Float32Array(total * INSTANCE_STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, INSTANCE_STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPosSize', new InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('iColor', new InterleavedBufferAttribute(this.buffer, 4, 4));
    g.setAttribute('iVelStretch', new InterleavedBufferAttribute(this.buffer, 4, 8));
    g.setAttribute('iShapeSeed', new InterleavedBufferAttribute(this.buffer, 2, 12));
    g.instanceCount = 0;
    this.geometry = g;
    this.uniforms = { uTime: time, uGain: { value: 1 }, uAdditive: { value: additive ? 1 : 0 } };
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Premultiplied output: additive layers write zero alpha, smoke writes its coverage.
      blending: additive ? AdditiveBlending : NormalBlending,
      premultipliedAlpha: true,
      defines: flat ? { FLAT: '' } : {},
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = flat ? (additive ? RENDER_ORDER.groundLight : RENDER_ORDER.groundEffect) : additive ? RENDER_ORDER.glow : RENDER_ORDER.smoke;
  }

  /** Steps the pool and uploads it; sprites added after this in the same frame go on top. */
  step(dt: number): void {
    this.pool.step(dt);
    this.used = this.pool.write(this.data, 0);
  }

  /** Room for one more sprite this frame. Returns the float offset to write it at, or -1. */
  spriteSlot(): number {
    if (this.used >= this.pool.capacity + this.spriteCap) return -1;
    return this.used++ * INSTANCE_STRIDE;
  }

  get buffer32(): Float32Array {
    return this.data;
  }

  /** Uploads what was written this frame. */
  commit(): void {
    this.geometry.instanceCount = this.used;
    this.buffer.clearUpdateRanges();
    if (this.used > 0) this.buffer.addUpdateRange(0, this.used * INSTANCE_STRIDE);
    this.buffer.needsUpdate = true;
  }

  get fullness(): number {
    return this.pool.count / this.pool.capacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
