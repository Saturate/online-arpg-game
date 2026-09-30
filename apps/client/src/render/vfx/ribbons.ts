import { AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, ShaderMaterial, Vector3, type Camera, type IUniform } from 'three';
import { RENDER_ORDER } from '../config.js';
import { NOISE_GLSL, OUTPUT_GLSL } from './glsl.js';

/** Points kept per ribbon. At the trail rate below this is about a quarter second of path. */
const POINTS = 12;
/** A ribbon takes a new point once its head has moved this far, in world units. */
const MIN_STEP = 6;
/** Floats per ribbon point: x, y, z, time. */
const PF = 4;

const VERTEX = /* glsl */ `
attribute vec4 aColor;
attribute vec3 aInfo;
varying vec4 vColor;
varying vec3 vInfo;
void main() {
  vColor = aColor;
  vInfo = aInfo;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uGain;
varying vec4 vColor;
varying vec3 vInfo;
${NOISE_GLSL}
void main() {
  float along = vInfo.x;
  float across = vInfo.y;
  int style = int(vInfo.z + 0.5);
  float edge = 1.0 - abs(across);
  float a = vColor.a;
  vec3 col = vColor.rgb;
  if (style == 3) {
    // Lightning: a thin jittering filament, bright and broken.
    float j = vfxNoise(vec2(along * 22.0, uTime * 30.0)) - 0.5;
    float line = smoothstep(0.28, 0.0, abs(across - j * 0.9));
    a *= line * (0.6 + 0.8 * step(0.35, vfxNoise(vec2(along * 9.0, uTime * 18.0))));
    col = mix(col, vec3(1.0, 0.98, 0.9), line * 0.5);
  } else {
    float n = vfxFbm(vec2(along * 5.0 - uTime * 2.5, across * 1.5 + uTime * 0.6));
    a *= pow(edge, 1.5) * (0.35 + n * 0.9);
    if (style == 1) col = mix(col * 0.55, col * 1.25, pow(1.0 - along, 2.0));
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(col * a * uGain, 0.0);
  ${OUTPUT_GLSL}
}
`;

const viewDir = new Vector3();
const tangent = new Vector3();
const side = new Vector3();

/**
 * Every trail ribbon in one geometry and one draw. A ribbon is a short history of points turned into
 * a camera-facing strip each frame, thinning and fading toward its tail. Handles are slot indices;
 * a released ribbon keeps drawing until its tail has faded, then its slot is reused.
 */
export class RibbonBatch {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly points: Float32Array;
  private readonly head: Int32Array;
  private readonly count: Int32Array;
  /** 0 free, 1 live, 2 released and fading out. */
  private readonly state: Uint8Array;
  /** r, g, b, width, lifetime seconds, style. */
  private readonly params: Float32Array;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly info: Float32Array;
  private readonly geometry: BufferGeometry;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly infoAttr: BufferAttribute;
  private readonly free: number[] = [];
  readonly uniforms: { uTime: IUniform<number>; uGain: IUniform<number> };
  private highest = 0;

  constructor(
    readonly capacity: number,
    time: IUniform<number>,
  ) {
    this.points = new Float32Array(capacity * POINTS * PF);
    this.head = new Int32Array(capacity);
    this.count = new Int32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.params = new Float32Array(capacity * 6);
    const verts = capacity * POINTS * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 4);
    this.info = new Float32Array(verts * 3);
    const index: number[] = [];
    for (let r = 0; r < capacity; r++) {
      const base = r * POINTS * 2;
      for (let i = 0; i < POINTS - 1; i++) {
        const a = base + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    const g = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage);
    this.infoAttr = new BufferAttribute(this.info, 3).setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aColor', this.colAttr);
    g.setAttribute('aInfo', this.infoAttr);
    g.setIndex(index);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.uniforms = { uTime: time, uGain: { value: 1 } };
    this.mesh = new Mesh(
      g,
      new ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.ribbons;
  }

  /** A new ribbon, or -1 when every slot is taken (the projectile then goes without one). */
  acquire(r: number, g: number, b: number, width: number, lifetime: number, style: number): number {
    const h = this.free.pop();
    if (h === undefined) return -1;
    this.state[h] = 1;
    this.count[h] = 0;
    this.head[h] = 0;
    const p = h * 6;
    this.params[p] = r;
    this.params[p + 1] = g;
    this.params[p + 2] = b;
    this.params[p + 3] = width;
    this.params[p + 4] = lifetime;
    this.params[p + 5] = style;
    this.highest = Math.max(this.highest, h + 1);
    return h;
  }

  /** Moves the head of a ribbon; a new point is kept once the head has moved far enough. */
  push(h: number, x: number, y: number, z: number, now: number): void {
    if (h < 0 || this.state[h] !== 1) return;
    const n = this.count[h] ?? 0;
    const head = this.head[h] ?? 0;
    const o = (h * POINTS + head) * PF;
    if (n > 1) {
      // The newest point follows the projectile; it only becomes history after MIN_STEP.
      const prev = (h * POINTS + ((head + POINTS - 1) % POINTS)) * PF;
      const dx = x - (this.points[prev] ?? 0);
      const dz = z - (this.points[prev + 2] ?? 0);
      if (dx * dx + dz * dz < MIN_STEP * MIN_STEP) {
        this.points[o] = x;
        this.points[o + 1] = y;
        this.points[o + 2] = z;
        this.points[o + 3] = now;
        return;
      }
    }
    const next = n === 0 ? head : (head + 1) % POINTS;
    const q = (h * POINTS + next) * PF;
    this.points[q] = x;
    this.points[q + 1] = y;
    this.points[q + 2] = z;
    this.points[q + 3] = now;
    this.head[h] = next;
    this.count[h] = Math.min(POINTS, n + 1);
  }

  /** The projectile is gone; the ribbon fades out behind where it was. */
  release(h: number): void {
    if (h >= 0 && this.state[h] === 1) this.state[h] = 2;
  }

  update(now: number, camera: Camera): void {
    camera.getWorldDirection(viewDir);
    let highest = 0;
    for (let h = 0; h < this.highest; h++) {
      const state = this.state[h] ?? 0;
      if (state === 0) {
        this.clearSlot(h);
        continue;
      }
      const lifetime = this.params[h * 6 + 4] ?? 0.3;
      const n = this.count[h] ?? 0;
      const head = this.head[h] ?? 0;
      const newest = (h * POINTS + head) * PF;
      if (state === 2 && (n === 0 || now - (this.points[newest + 3] ?? 0) > lifetime)) {
        this.state[h] = 0;
        this.free.push(h);
        this.clearSlot(h);
        continue;
      }
      highest = h + 1;
      this.writeSlot(h, n, head, now, lifetime);
    }
    this.highest = highest;
    this.geometry.setDrawRange(0, highest * (POINTS - 1) * 6);
    if (highest > 0) {
      const verts = highest * POINTS * 2;
      this.posAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(0, verts * 3);
      this.colAttr.clearUpdateRanges();
      this.colAttr.addUpdateRange(0, verts * 4);
      this.infoAttr.clearUpdateRanges();
      this.infoAttr.addUpdateRange(0, verts * 3);
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.infoAttr.needsUpdate = true;
    }
  }

  private writeSlot(h: number, n: number, head: number, now: number, lifetime: number): void {
    const p = h * 6;
    const r = this.params[p] ?? 1;
    const g = this.params[p + 1] ?? 1;
    const b = this.params[p + 2] ?? 1;
    const width = this.params[p + 3] ?? 4;
    const style = this.params[p + 5] ?? 0;
    const base = h * POINTS * 2;
    for (let k = 0; k < POINTS; k++) {
      const v = base + k * 2;
      if (k >= n) {
        // Unused points collapse onto the last used one: zero-area triangles, nothing drawn.
        this.copyVertex(v, base + Math.max(0, n - 1) * 2);
        this.copyVertex(v + 1, base + Math.max(0, n - 1) * 2 + 1);
        continue;
      }
      const idx = (head - k + POINTS) % POINTS;
      const o = (h * POINTS + idx) * PF;
      const x = this.points[o] ?? 0;
      const y = this.points[o + 1] ?? 0;
      const z = this.points[o + 2] ?? 0;
      const age = Math.min(1, (now - (this.points[o + 3] ?? 0)) / lifetime);
      const along = Math.max(age, k / (POINTS - 1));
      // The tangent runs toward the neighbour point; the strip's side is across it on screen.
      const nk = k + 1 < n ? k + 1 : k - 1;
      if (nk >= 0 && nk < n) {
        const on = (h * POINTS + ((head - nk + POINTS) % POINTS)) * PF;
        tangent.set(x - (this.points[on] ?? 0), y - (this.points[on + 1] ?? 0), z - (this.points[on + 2] ?? 0));
        if (nk < k) tangent.negate();
      } else tangent.set(1, 0, 0);
      side.crossVectors(tangent, viewDir);
      const len = side.length();
      if (len > 1e-5) side.multiplyScalar(1 / len);
      else side.set(0, 0, 1);
      const w = width * (1 - along * 0.85);
      const alpha = Math.pow(1 - along, 1.4);
      this.setVertex(v, x + side.x * w, y + side.y * w, z + side.z * w, r, g, b, alpha, along, 1, style);
      this.setVertex(v + 1, x - side.x * w, y - side.y * w, z - side.z * w, r, g, b, alpha, along, -1, style);
    }
  }

  private setVertex(v: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number, along: number, across: number, style: number): void {
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.col[v * 4] = r;
    this.col[v * 4 + 1] = g;
    this.col[v * 4 + 2] = b;
    this.col[v * 4 + 3] = a;
    this.info[v * 3] = along;
    this.info[v * 3 + 1] = across;
    this.info[v * 3 + 2] = style;
  }

  private copyVertex(to: number, from: number): void {
    this.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.col[to * 4 + 3] = 0;
    this.info.copyWithin(to * 3, from * 3, from * 3 + 3);
  }

  private clearSlot(h: number): void {
    const base = h * POINTS * 2;
    for (let k = 0; k < POINTS * 2; k++) this.col[(base + k) * 4 + 3] = 0;
    const o = base * 3;
    this.pos.fill(0, o, o + POINTS * 2 * 3);
  }

  get live(): number {
    return this.capacity - this.free.length;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
