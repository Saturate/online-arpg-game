import {
  AddEquation,
  BufferAttribute,
  Color,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  OneFactor,
  OrthographicCamera,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
  type Camera,
  type IUniform,
} from 'three';
import { ChunkBuckets, NearCache, viewFootprint } from '../chunks.js';
import { RENDER_ORDER, VIEW } from '../config.js';
import { emitLight, lightKey, sceneLights, staticFlicker } from '../lights.js';
import type { ParticleBudget } from './budget.js';
import { NOISE_GLSL, OUTPUT_GLSL } from './glsl.js';
import { PALETTE } from './palette.js';
import { emptySpec, SHAPE, type ParticleSpec } from './pool.js';
import type { QualityLevel } from './quality.js';

/**
 * The world's own fires: torches, candles, lanterns, camp fires and the forge. Every flame, bed of
 * coals, heat shimmer and glow of every fire on screen is one instanced quad in a single draw, built
 * from layered noise in the shader, so a ring of fourteen torches costs what one does. Embers,
 * sparks and smoke go into the spell effects' particle pools (no draws of their own) and only for
 * the few fires nearest the camera. Nothing here allocates per frame.
 */

export type FireKind = 'torch' | 'candle' | 'lantern' | 'bonfire';

export interface FireSpot {
  kind: FireKind;
  /** Ground position of the flame. */
  x: number;
  y: number;
  /** Height of the flame's base above the ground. */
  h: number;
  /** 1 is the usual size of its kind. */
  size: number;
  /** Units the flame is drawn toward the camera, so a lantern's glass does not hide the flame inside it. */
  pull: number;
  /** The light this flame belongs to (its position and flicker), so both pulse together. */
  lightX: number;
  lightY: number;
  flicker: number;
  /** The forge's fire, which flares when a sigil is inscribed. */
  forge: boolean;
}

/** What the fires need from the effects system: its clock, budget, pools and where the camera looks. */
export interface FireHost {
  readonly budget: ParticleBudget;
  readonly level: QualityLevel;
  readonly night: number;
  readonly time: number;
  readonly focusX: number;
  readonly focusY: number;
  spawnGlow(s: ParticleSpec): boolean;
  spawnSmoke(s: ParticleSpec): boolean;
}

export const FIRE_OFF = 0;
export const FIRE_SPRITE = 1;
export const FIRE_FULL = 2;
export type FireDetail = typeof FIRE_OFF | typeof FIRE_SPRITE | typeof FIRE_FULL;

/** Ground distance from the camera focus within which a fire gets particles; about the middle of the screen. */
export const FULL_RANGE = 650;
/** Most fires with particles at once, nearest first: an Arena ring of torches must not flood the pools. */
export const MAX_FULL = 8;

/**
 * How much of a fire to draw from where it lands on screen (normalised device coordinates of its
 * flame) and how far it is from the camera focus. Off screen draws nothing; on screen draws the
 * flame; near the middle it also gets embers and smoke, unless the quality keeps only flames. The
 * margins let a flame whose base is just below the screen edge still show its tip.
 */
export function fireDetail(ndcX: number, ndcY: number, groundDistance: number, particles: boolean): FireDetail {
  if (ndcX < -1.15 || ndcX > 1.15 || ndcY < -1.25 || ndcY > 1.15) return FIRE_OFF;
  if (!particles || groundDistance > FULL_RANGE) return FIRE_SPRITE;
  return FIRE_FULL;
}

/**
 * Writes into `out` the positions (0 to count - 1) of the `max` smallest distances, nearest first,
 * and returns how many it wrote. A partial selection: fires on screen are a handful, so this beats
 * sorting and allocates nothing.
 */
export function nearestFirst(dist: Float32Array, count: number, max: number, out: Int32Array): number {
  const n = Math.min(count, max, out.length);
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const d = dist[i] ?? Infinity;
      if (d >= bestD) continue;
      let taken = false;
      for (let j = 0; j < k; j++) if (out[j] === i) taken = true;
      if (taken) continue;
      best = i;
      bestD = d;
    }
    out[k] = best;
  }
  return n;
}

// Quad kinds, read by the shader.
const FLAME = 0;
const COALS = 1;
const SHIMMER = 2;
const HALO = 3;

/** Floats per quad: position and kind, size seed and gain, lean speed pull and a spare. */
const STRIDE = 12;
const MAX_QUADS = 640;

/** A camp fire's tongues around its centre at size 1: offset x, z, width, height. The first is the tall middle one. */
const TONGUES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 30, 74],
  [-9, 5, 22, 50],
  [9, -4, 24, 56],
  [4, 9, 18, 40],
  [-6, -8, 18, 44],
];

const VERTEX = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iSize;
attribute vec4 iMisc;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vGain;
varying float vLean;
varying float vSpeed;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float kind = iPos.w;
  vec3 ax;
  vec3 ay;
  vec2 p = position.xy;
  if (abs(kind - 1.0) < 0.5) {
    // Coals lie on the ground.
    ax = vec3(1.0, 0.0, 0.0);
    ay = vec3(0.0, 0.0, 1.0);
    vUv = p * 2.0;
  } else if (abs(kind - 3.0) < 0.5) {
    ax = right;
    ay = up;
    vUv = p * 2.0;
  } else {
    // Flames and shimmer stand upright and turn about the vertical to face the camera, so they
    // keep their base on the torch and foreshorten like the world around them.
    ax = normalize(vec3(right.x, 0.0, right.z));
    ay = vec3(0.0, 1.0, 0.0);
    p.y += 0.5;
    vUv = vec2(position.x * 2.0, p.y);
  }
  vec3 world = iPos.xyz + ax * p.x * iSize.x + ay * p.y * iSize.y + back * iMisc.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vKind = kind;
  vSeed = iSize.z;
  vGain = iSize.w;
  vLean = iMisc.x;
  vSpeed = iMisc.y;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vGain;
varying float vLean;
varying float vSpeed;
${NOISE_GLSL}
// One layer of flame: a teardrop that leans with the wind and wavers, eaten from the top by rising
// noise so it breaks into tongues instead of a clean cone.
float flameMask(vec2 uv, float seed, float t, float lean) {
  float y = uv.y;
  float x = uv.x - lean * y * y - sin(t * 3.3 + seed * 6.2831 + y * 4.0) * 0.07 * y;
  vec2 q = vec2(x * 2.4 + seed * 13.0, y * 2.2 - t * 2.1);
  float n = vfxNoise(q) * 0.6 + vfxNoise(q * 2.2 + vec2(5.2, -t * 1.6)) * 0.4;
  float w = 0.5 * pow(max(0.0, 1.0 - y), 0.75) * smoothstep(-0.02, 0.2, y) + 0.02;
  float body = 1.0 - abs(x) / w;
  body -= (n - 0.42) * (0.3 + 1.4 * y);
  return clamp(body * 1.5, 0.0, 1.0);
}
void main() {
  int kind = int(vKind + 0.5);
  float t = uTime * vSpeed + vSeed * 17.0;
  vec3 rgb;
  float alpha;
  if (kind == 0) {
    float outer = flameMask(vUv, vSeed, t, vLean);
    float inner = flameMask(vec2(vUv.x * 2.2, vUv.y * 1.55 + 0.02), vSeed + 0.37, t * 1.15, vLean * 0.6);
    float heat = max(outer * 0.6, inner) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
    if (heat < 0.01) discard;
    // Near-white core, deep orange body, dull red tips; the colours are linear.
    vec3 c = mix(vec3(0.26, 0.03, 0.006), vec3(0.85, 0.2, 0.03), smoothstep(0.05, 0.55, heat));
    c = mix(c, vec3(1.0, 0.78, 0.5), smoothstep(0.72, 1.0, heat));
    float a = smoothstep(0.0, 0.25, heat);
    rgb = c * a * vGain * (0.7 + 0.6 * heat);
    // Sooty tips: the cool edge of the flame darkens what is behind it a little, so it reads as
    // burning pitch rather than a clean glow.
    alpha = smoothstep(0.02, 0.3, outer) * (1.0 - smoothstep(0.2, 0.55, heat)) * smoothstep(0.3, 0.85, vUv.y) * 0.45;
  } else if (kind == 1) {
    float r = length(vUv);
    if (r > 1.0) discard;
    float n = vfxFbm(vUv * 3.2 + vSeed * 9.0);
    float cells = vfxNoise(vUv * 9.0 + vSeed * 4.0 + vec2(0.0, uTime * 0.05));
    // Each coal breathes on its own slow beat.
    float pulse = 0.7 + 0.3 * sin(uTime * 1.7 + cells * 9.0 + vSeed * 5.0);
    float glow = smoothstep(0.5, 0.78, n * 0.7 + cells * 0.45) * (1.0 - smoothstep(0.3, 0.9, r)) * pulse;
    float ash = (1.0 - smoothstep(0.65, 1.0, r + (n - 0.5) * 0.35)) * 0.8;
    rgb = mix(vec3(0.35, 0.03, 0.0), vec3(1.0, 0.36, 0.05), glow) * glow * vGain * 1.5;
    alpha = ash * (1.0 - glow);
  } else if (kind == 2) {
    // Heat shimmer: faint bands rising over the fire, a touch lighter and darker than what is
    // behind them. It stands in for refraction without a screen copy.
    float edge = (1.0 - abs(vUv.x)) * smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.5, 1.0, vUv.y));
    float n = vfxNoise(vec2(vUv.x * 5.0 + vSeed * 7.0, vUv.y * 7.0 - uTime * 3.0)) - vfxNoise(vec2(vUv.x * 9.0 - vSeed, vUv.y * 11.0 - uTime * 4.3)) * 0.8;
    float s = (n - 0.1) * edge * vGain;
    rgb = vec3(1.0, 0.8, 0.6) * max(s, 0.0) * 0.07;
    alpha = max(-s, 0.0) * 0.14;
    if (abs(s) < 0.002) discard;
  } else {
    float r = length(vUv);
    float a = pow(max(0.0, 1.0 - r), 2.4);
    if (a < 0.004) discard;
    rgb = vec3(1.0, 0.5, 0.16) * a * vGain;
    alpha = 0.0;
  }
  gl_FragColor = vec4(rgb, alpha);
  ${OUTPUT_GLSL}
}
`;

const SOOT = new Color(0x121010);
const tmp = new Vector3();

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class WorldFires {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly data = new Float32Array(MAX_QUADS * STRIDE);
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly geometry: InstancedBufferGeometry;
  private spots: readonly FireSpot[] = [];
  /** The spots near the camera, so a zone of any size only projects the fires that can be on screen. */
  private near = new NearCache(new ChunkBuckets([]));
  private quads = 0;
  private readonly spec: ParticleSpec = emptySpec();
  // Fires that asked for particles this frame: their spot index and distance, and the chosen few.
  private readonly candSpot = new Int32Array(256);
  private readonly candDist = new Float32Array(256);
  private readonly chosen = new Int32Array(MAX_FULL);
  /** 1 right after an inscribe, falling to 0 over FLARE_SECONDS. */
  private flareLevel = 0;
  private flareBurst = false;
  private readonly flareKey = lightKey();
  /** Wind lean this frame and the ground direction flames lean toward (the camera's right). */
  private wind = 0;
  private windX = 1;
  private windZ = 0;
  /** How many fires drew, and how many had particles, last frame; for the bench and tests. */
  readonly stats = { drawn: 0, full: 0, quads: 0 };

  constructor(
    private readonly camera: Camera,
    time: IUniform<number>,
  ) {
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPos', new InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('iSize', new InterleavedBufferAttribute(this.buffer, 4, 4));
    g.setAttribute('iMisc', new InterleavedBufferAttribute(this.buffer, 4, 8));
    g.instanceCount = 0;
    this.geometry = g;
    const material = new ShaderMaterial({
      uniforms: { uTime: time },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Premultiplied: flames and glows add (alpha 0), soot, ash and shimmer darken by their alpha,
      // all in one draw.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      premultipliedAlpha: true,
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.worldFire;
  }

  /** The world's fires; replaced when the map is rebuilt. */
  setSpots(spots: readonly FireSpot[]): void {
    if (spots === this.spots) return;
    this.spots = spots;
    this.near = new NearCache(new ChunkBuckets(spots));
  }

  /** Ground distance from the focus beyond which no flame can reach the screen. */
  private reach(): number {
    const c = this.camera;
    // Flames stand up to about 150 over the ground, which leans them into view from past the footprint.
    if (c instanceof OrthographicCamera) return viewFootprint((c.right - c.left) / 2, (c.top - c.bottom) / 2, c.zoom, (VIEW.pitchDegrees * Math.PI) / 180) + 300;
    return Infinity;
  }

  /** The forge's fire flares up: a sigil was inscribed. */
  flareForge(): void {
    this.flareLevel = 1;
    this.flareBurst = true;
  }

  update(dt: number, host: FireHost): void {
    const t = host.time;
    const lt = sceneLights.time;
    const night = host.night;
    // By day flames stay visible without turning into glowing blobs; at night they are the light.
    const flameGain = 0.6 + 0.4 * night;
    const haloGain = 0.06 + 0.5 * night;
    const shimmer = host.level.fireParticles;
    const particles = host.level.fireParticles;
    this.wind = 0.16 + 0.07 * Math.sin(t * 0.21) + 0.04 * Math.sin(t * 0.53 + 1.3);
    const m = this.camera.matrixWorld.elements;
    const rx = m[0] ?? 1;
    const rz = m[2] ?? 0;
    const rl = Math.hypot(rx, rz) || 1;
    this.windX = rx / rl;
    this.windZ = rz / rl;
    this.flareLevel = Math.max(0, this.flareLevel - dt / FLARE_SECONDS);

    this.quads = 0;
    let cands = 0;
    let drawn = 0;
    const near = this.near.update(host.focusX, host.focusY, this.reach());
    for (let n = 0; n < near.length; n++) {
      const i = near[n] ?? 0;
      const s = this.spots[i];
      if (!s) continue;
      tmp.set(s.x, s.h + 10 * s.size, s.y).project(this.camera);
      const dist = Math.hypot(s.x - host.focusX, s.y - host.focusY);
      const detail = fireDetail(tmp.x, tmp.y, dist, particles);
      if (detail === FIRE_OFF) continue;
      drawn++;
      // The flame moves a little more than its light, so the flicker reads on the flame itself.
      const f = 1 + (staticFlicker(lt, s.lightX, s.lightY, s.flicker) - 1) * 1.6;
      const flare = s.forge ? this.flareLevel : 0;
      this.drawFire(s, i, t, f, flare, flameGain, haloGain, shimmer);
      if (detail === FIRE_FULL && cands < this.candSpot.length && (s.kind === 'torch' || s.kind === 'bonfire')) {
        this.candSpot[cands] = i;
        this.candDist[cands] = dist;
        cands++;
      }
    }
    const full = nearestFirst(this.candDist, cands, MAX_FULL, this.chosen);
    for (let k = 0; k < full; k++) {
      const s = this.spots[this.candSpot[this.chosen[k] ?? 0] ?? 0];
      if (s) this.emit(s, dt, host);
    }
    if (this.flareBurst) {
      this.flareBurst = false;
      for (const s of this.spots) if (s.forge) this.flareSparks(s, host);
    }
    if (this.flareLevel > 0) {
      for (const s of this.spots) if (s.forge) emitLight(this.flareKey, s.x, s.y, s.h + 30, 0xff8a3a, 3.2 * this.flareLevel, 620, 1, 0.6);
    }

    this.geometry.instanceCount = this.quads;
    this.buffer.clearUpdateRanges();
    if (this.quads > 0) this.buffer.addUpdateRange(0, this.quads * STRIDE);
    this.buffer.needsUpdate = true;
    this.stats.drawn = drawn;
    this.stats.full = full;
    this.stats.quads = this.quads;
  }

  private quad(kind: number, x: number, h: number, z: number, w: number, height: number, seed: number, gain: number, lean: number, speed: number, pull: number): void {
    if (this.quads >= MAX_QUADS) return;
    const o = this.quads++ * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = h;
    d[o + 2] = z;
    d[o + 3] = kind;
    d[o + 4] = w;
    d[o + 5] = height;
    d[o + 6] = seed;
    d[o + 7] = gain;
    d[o + 8] = lean;
    d[o + 9] = speed;
    d[o + 10] = pull;
    d[o + 11] = 0;
  }

  private drawFire(s: FireSpot, index: number, t: number, f: number, flare: number, flameGain: number, haloGain: number, shimmer: boolean): void {
    const seed = ((index * 0.618034) % 1 + (s.x * 0.0071) % 1 + 1) % 1;
    const k = s.size;
    const lean = this.wind;
    switch (s.kind) {
      case 'torch': {
        // Quads are drawn about 1.8 times the flame's width, leaving room for the lean and waver.
        this.quad(FLAME, s.x, s.h, s.y, 30 * k, 36 * k * f, seed, flameGain * 0.9 * f, lean, 1.2, s.pull);
        this.quad(HALO, s.x, s.h + 10 * k, s.y, 60 * k, 60 * k, seed, haloGain * 0.55 * f, 0, 0, s.pull + 6);
        break;
      }
      case 'candle': {
        this.quad(FLAME, s.x, s.h, s.y, 6 * k, 8 * k * f, seed, flameGain * 0.9, lean * 0.4, 1.5, s.pull);
        this.quad(HALO, s.x, s.h + 3 * k, s.y, 22 * k, 22 * k, seed, haloGain * 0.4 * f, 0, 0, s.pull + 2);
        break;
      }
      case 'lantern': {
        // A small steady flame behind glass, and the glass glowing around it.
        this.quad(FLAME, s.x, s.h, s.y, 8 * k, 11 * k * (0.85 + 0.15 * f), seed, flameGain * 0.85, 0, 0.9, s.pull);
        this.quad(HALO, s.x, s.h + 5 * k, s.y, 48 * k, 48 * k, seed, (0.06 + haloGain * 1.1) * f, 0, 0, s.pull + 2);
        break;
      }
      case 'bonfire': {
        const up = 1 + flare * 0.7;
        const hot = 1 + flare * 0.45;
        this.quad(COALS, s.x, 1.8, s.y, 40 * k, 40 * k, seed, flameGain * (0.8 + 0.2 * f) * hot, 0, 0, 0);
        for (let j = 0; j < TONGUES.length; j++) {
          const tg = TONGUES[j];
          if (!tg) continue;
          // Each tongue rises and falls on its own around the fire's shared flicker.
          const own = f * (0.9 + 0.1 * Math.sin(t * (4.1 + j * 0.9) + j * 2.1 + seed * 9));
          this.quad(FLAME, s.x + tg[0] * k, s.h, s.y + tg[1] * k, tg[2] * 1.8 * k, tg[3] * k * own * up, (seed + j * 0.173) % 1, flameGain * 0.55 * f * hot, lean * (j === 0 ? 1 : 0.8), 1 + j * 0.07, s.pull);
        }
        if (shimmer) this.quad(SHIMMER, s.x, s.h + 44 * k, s.y, 56 * k, 90 * k, seed, 1, 0, 0, 0);
        this.quad(HALO, s.x, s.h + 22 * k, s.y, 150 * k, 150 * k, seed, haloGain * 0.45 * f * hot, 0, 0, 20 * k);
        break;
      }
    }
  }

  private emit(s: FireSpot, dt: number, host: FireHost): void {
    const b = host.budget;
    const p = PALETTE.fire;
    const k = s.size;
    const sp = this.spec;
    const wx = this.windX * this.wind * 60;
    const wz = this.windZ * this.wind * 60;
    if (s.kind === 'torch') {
      const top = s.h + 28 * k;
      // A thin dark wisp off the tip.
      for (let n = b.take(3.5 * dt); n > 0; n--) {
        this.motion(s.x + rand(-2, 2), top, s.y + rand(-2, 2), wx * 0.4 + rand(-3, 3), rand(20, 30), wz * 0.4 + rand(-3, 3), -4, 0.3, 10);
        this.look(rand(1.6, 2.4), 4 * k, 15 * k, SHAPE.smoke, 0);
        this.colour(SOOT, 1, 0.3, SOOT, 1, 0);
        host.spawnSmoke(sp);
      }
      // Now and then a spark pops off the pitch.
      for (let n = b.take(1.4 * dt); n > 0; n--) {
        this.motion(s.x + rand(-3, 3), s.h + 10 * k, s.y + rand(-3, 3), rand(-15, 15), rand(50, 90), rand(-15, 15), 90, 0.8, 40);
        this.look(rand(0.5, 0.9), rand(1.3, 1.8), 0.4, SHAPE.spark, 0.9);
        this.colour(p.core, 1.3, 1, p.deep, 1, 0);
        host.spawnGlow(sp);
      }
      return;
    }
    // A camp fire: embers riding the heat, sparks popping, dark smoke rising and spreading.
    const r = 12 * k;
    for (let n = b.take(16 * k * dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      this.motion(s.x + Math.cos(a) * d, s.h + rand(8, 22) * k, s.y + Math.sin(a) * d, wx + rand(-12, 12), rand(45, 100), wz + rand(-12, 12), -12, 0.5, 70);
      this.look(rand(1.4, 2.8), rand(1.6, 2.6), 0.6, SHAPE.glow, 0);
      this.colour(p.core, 1.2, 1, p.deep, 1, 0);
      host.spawnGlow(sp);
    }
    for (let n = b.take(4 * k * dt); n > 0; n--) {
      this.motion(s.x + rand(-r, r) * 0.5, s.h + rand(6, 16) * k, s.y + rand(-r, r) * 0.5, rand(-40, 40), rand(90, 160), rand(-40, 40), 120, 0.6, 30);
      this.look(rand(0.4, 0.7), rand(1.6, 2.2), 0.5, SHAPE.spark, 1.2);
      this.colour(p.core, 1.4, 1, p.body, 1, 0);
      host.spawnGlow(sp);
    }
    for (let n = b.take(6 * k * dt); n > 0; n--) {
      this.motion(s.x + rand(-6, 6) * k, s.h + rand(50, 64) * k, s.y + rand(-6, 6) * k, wx * 0.5 + rand(-6, 6), rand(26, 40), wz * 0.5 + rand(-6, 6), -3, 0.15, 14);
      this.look(rand(3, 4.5), 20 * k, 75 * k, SHAPE.smoke, 0);
      this.colour(SOOT, 1, 0.26, SOOT, 1.3, 0);
      host.spawnSmoke(sp);
    }
  }

  /** The inscribe flare's burst of sparks and embers; important, so a full pool still shows it. */
  private flareSparks(s: FireSpot, host: FireHost): void {
    const p = PALETTE.fire;
    const sp = this.spec;
    for (let n = host.budget.take(36, true); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(40, 120);
      this.motion(s.x, s.h + rand(10, 30), s.y, Math.cos(a) * v, rand(120, 230), Math.sin(a) * v, 160, 0.6, 30);
      this.look(rand(0.5, 1), rand(1.8, 2.6), 0.5, SHAPE.spark, 1.2);
      this.colour(p.core, 1.5, 1, p.body, 1, 0);
      host.spawnGlow(sp);
    }
  }

  private motion(x: number, h: number, y: number, vx: number, vh: number, vy: number, gravity: number, drag: number, wobble: number): void {
    const s = this.spec;
    s.x = x;
    s.y = h;
    s.z = y;
    s.vx = vx;
    s.vy = vh;
    s.vz = vy;
    s.gravity = gravity;
    s.drag = drag;
    s.wobble = wobble;
  }

  private look(life: number, size0: number, size1: number, shape: number, stretch: number): void {
    const s = this.spec;
    s.life = life;
    s.size0 = size0;
    s.size1 = size1;
    s.shape = shape;
    s.stretch = stretch;
  }

  private colour(start: Color, startScale: number, a0: number, end: Color, endScale: number, a1: number): void {
    const s = this.spec;
    s.r0 = start.r * startScale;
    s.g0 = start.g * startScale;
    s.b0 = start.b * startScale;
    s.a0 = a0;
    s.r1 = end.r * endScale;
    s.g1 = end.g * endScale;
    s.b1 = end.b * endScale;
    s.a1 = a1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Seconds the forge's inscribe flare takes to settle. */
const FLARE_SECONDS = 0.9;
