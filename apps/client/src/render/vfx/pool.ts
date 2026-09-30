/**
 * A fixed pool of particles in flat typed arrays, with no three.js in it so it can be tested in Node.
 * Live particles are kept packed at the front (a dead one is replaced by the last live one), so the
 * GPU buffer is written and drawn as one contiguous range and nothing is allocated per frame.
 */

/** What an emitter fills in before `spawn`. One scratch object is reused for every particle. */
export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  size0: number;
  size1: number;
  /** Linear colour and alpha at birth and at death; the pool blends between them over the life. */
  r0: number;
  g0: number;
  b0: number;
  a0: number;
  r1: number;
  g1: number;
  b1: number;
  a1: number;
  /** World units per second squared, down. Negative rises, like heat. */
  gravity: number;
  /** Fraction of velocity lost per second. */
  drag: number;
  /** Which sprite the shader draws; see SHAPE. */
  shape: number;
  /** Stretch along the screen-space velocity, for sparks and streaks. 0 draws a round sprite. */
  stretch: number;
  /**
   * Sideways swirl, world units per second squared: embers and smoke drift on a slow turbulence
   * instead of flying straight. 0 (every spell particle) skips it.
   */
  wobble: number;
}

export const SHAPE = {
  glow: 0,
  smoke: 1,
  spark: 2,
  shard: 3,
  flame: 4,
  mote: 5,
  /** A hot core: white centre, coloured falloff. */
  core: 6,
  /** A heavy chunk of debris: hard edged, not glowing. */
  chunk: 7,
  ring: 8,
  disc: 9,
} as const;

export function emptySpec(): ParticleSpec {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 1, r0: 1, g0: 1, b0: 1, a0: 1, r1: 1, g1: 1, b1: 1, a1: 0, gravity: 0, drag: 0, shape: 0, stretch: 0, wobble: 0 };
}

/** Floats per particle written for the GPU: position 3, size 1, colour 4, velocity 3, stretch, shape, seed. */
export const INSTANCE_STRIDE = 14;

// Offsets into one particle's record.
const PX = 0;
const PY = 1;
const PZ = 2;
const VX = 3;
const VY = 4;
const VZ = 5;
const AGE = 6;
const LIFE = 7;
const SIZE0 = 8;
const SIZE1 = 9;
const COL0 = 10;
const COL1 = 14;
const GRAVITY = 18;
const DRAG = 19;
const SHAPE_AT = 20;
const STRETCH = 21;
const SEED = 22;
const WOBBLE = 23;
const FIELDS = 24;

export class ParticlePool {
  readonly capacity: number;
  count = 0;
  /** Every particle's record, FIELDS floats each, interleaved so a removal is one copyWithin. */
  private readonly d: Float32Array;

  constructor(
    capacity: number,
    private readonly random: () => number = Math.random,
  ) {
    this.capacity = capacity;
    this.d = new Float32Array(capacity * FIELDS);
  }

  private at(k: number): number {
    return this.d[k] ?? 0;
  }

  /**
   * Starts a particle. A full pool drops the request rather than overwriting a live particle: the
   * budget in front of the pool decides what is worth spawning, and stealing made bursts flicker.
   */
  spawn(s: ParticleSpec): boolean {
    if (this.count >= this.capacity || s.life <= 0) return false;
    const b = this.count++ * FIELDS;
    const d = this.d;
    d[b + PX] = s.x;
    d[b + PY] = s.y;
    d[b + PZ] = s.z;
    d[b + VX] = s.vx;
    d[b + VY] = s.vy;
    d[b + VZ] = s.vz;
    d[b + AGE] = 0;
    d[b + LIFE] = s.life;
    d[b + SIZE0] = s.size0;
    d[b + SIZE1] = s.size1;
    d[b + COL0] = s.r0;
    d[b + COL0 + 1] = s.g0;
    d[b + COL0 + 2] = s.b0;
    d[b + COL0 + 3] = s.a0;
    d[b + COL1] = s.r1;
    d[b + COL1 + 1] = s.g1;
    d[b + COL1 + 2] = s.b1;
    d[b + COL1 + 3] = s.a1;
    d[b + GRAVITY] = s.gravity;
    d[b + DRAG] = s.drag;
    d[b + SHAPE_AT] = s.shape;
    d[b + STRETCH] = s.stretch;
    d[b + SEED] = this.random();
    d[b + WOBBLE] = s.wobble;
    return true;
  }

  /** Ages and moves every particle; a dead one is replaced by the last live one. */
  step(dt: number): void {
    const d = this.d;
    let i = 0;
    while (i < this.count) {
      const b = i * FIELDS;
      const age = this.at(b + AGE) + dt;
      if (age >= this.at(b + LIFE)) {
        const last = --this.count;
        if (i !== last) d.copyWithin(b, last * FIELDS, last * FIELDS + FIELDS);
        continue;
      }
      d[b + AGE] = age;
      const damp = Math.max(0, 1 - this.at(b + DRAG) * dt);
      let vx = this.at(b + VX) * damp;
      let vz = this.at(b + VZ) * damp;
      let vy = this.at(b + VY) * damp - this.at(b + GRAVITY) * dt;
      const wobble = this.at(b + WOBBLE);
      if (wobble !== 0) {
        // Two unrelated sines per particle, phased by its seed: a lazy curl, never the same path twice.
        const ph = age * 2.3 + this.at(b + SEED) * 40;
        vx += Math.sin(ph) * wobble * dt;
        vz += Math.cos(ph * 1.37 + 1.1) * wobble * dt;
      }
      const y = this.at(b + PY) + vy * dt;
      // Particles settle on the ground instead of sinking through it.
      if (y < 0.5) {
        d[b + PY] = 0.5;
        vy = 0;
        vx *= 0.6;
        vz *= 0.6;
      } else d[b + PY] = y;
      d[b + PX] = this.at(b + PX) + vx * dt;
      d[b + PZ] = this.at(b + PZ) + vz * dt;
      d[b + VX] = vx;
      d[b + VY] = vy;
      d[b + VZ] = vz;
      i++;
    }
  }

  /**
   * Writes every live particle's current look into `out` starting at instance `from`,
   * INSTANCE_STRIDE floats each, and returns how many it wrote. Alpha fades in over the first
   * tenth of the life so nothing pops into view.
   */
  write(out: Float32Array, from = 0): number {
    const n = Math.min(this.count, Math.floor(out.length / INSTANCE_STRIDE) - from);
    for (let i = 0; i < n; i++) {
      const b = i * FIELDS;
      const t = this.at(b + AGE) / this.at(b + LIFE);
      const o = (from + i) * INSTANCE_STRIDE;
      out[o] = this.at(b + PX);
      out[o + 1] = this.at(b + PY);
      out[o + 2] = this.at(b + PZ);
      out[o + 3] = mix(this.at(b + SIZE0), this.at(b + SIZE1), t);
      out[o + 4] = mix(this.at(b + COL0), this.at(b + COL1), t);
      out[o + 5] = mix(this.at(b + COL0 + 1), this.at(b + COL1 + 1), t);
      out[o + 6] = mix(this.at(b + COL0 + 2), this.at(b + COL1 + 2), t);
      out[o + 7] = mix(this.at(b + COL0 + 3), this.at(b + COL1 + 3), t) * Math.min(1, t * 10);
      out[o + 8] = this.at(b + VX);
      out[o + 9] = this.at(b + VY);
      out[o + 10] = this.at(b + VZ);
      out[o + 11] = this.at(b + STRETCH);
      out[o + 12] = this.at(b + SHAPE_AT);
      out[o + 13] = this.at(b + SEED);
    }
    return Math.max(0, n);
  }

  /** Age over life of particle `i`, for tests. */
  lifeFraction(i: number): number {
    return i < this.count ? this.at(i * FIELDS + AGE) / this.at(i * FIELDS + LIFE) : -1;
  }

  clear(): void {
    this.count = 0;
  }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
