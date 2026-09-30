import { describe, expect, it } from 'vitest';
import { ParticleBudget } from '../src/render/vfx/budget.js';
import { emptySpec, INSTANCE_STRIDE, ParticlePool } from '../src/render/vfx/pool.js';
import { isVfxQuality, QUALITY, VFX_QUALITIES } from '../src/render/vfx/quality.js';
import { DEFAULT_OPTIONS, parseSettings } from '../src/ui/settings.js';
import { darkness, nightModeOf } from '../src/render/daylight.js';
import { HeldJitter, JITTER_RANGE } from '../src/render/vfx/jitter.js';

/** A repeatable random stream, so rounding in the budget is testable. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('particle pool', () => {
  it('keeps live particles packed and removes them when their life ends', () => {
    const pool = new ParticlePool(8, seeded(1));
    const spec = emptySpec();
    for (const life of [0.1, 0.5, 0.2, 1]) {
      spec.life = life;
      expect(pool.spawn(spec)).toBe(true);
    }
    expect(pool.count).toBe(4);
    pool.step(0.15);
    expect(pool.count).toBe(3);
    pool.step(0.1);
    expect(pool.count).toBe(2);
    // The two left are the 0.5 s and 1 s ones, both still inside their lives.
    for (let i = 0; i < pool.count; i++) {
      const f = pool.lifeFraction(i);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(1);
    }
    pool.step(1);
    expect(pool.count).toBe(0);
  });

  it('drops spawns when full instead of overwriting live particles', () => {
    const pool = new ParticlePool(3, seeded(2));
    const spec = emptySpec();
    spec.life = 10;
    expect([pool.spawn(spec), pool.spawn(spec), pool.spawn(spec), pool.spawn(spec)]).toEqual([true, true, true, false]);
    expect(pool.count).toBe(3);
  });

  it('moves with velocity, gravity and drag and settles on the ground', () => {
    const pool = new ParticlePool(1, seeded(3));
    const spec = emptySpec();
    Object.assign(spec, { x: 0, y: 100, z: 0, vx: 100, vy: 0, vz: 0, gravity: 1000, drag: 0, life: 5 });
    pool.spawn(spec);
    const out = new Float32Array(INSTANCE_STRIDE);
    pool.step(0.1);
    pool.write(out);
    expect(out[0]).toBeCloseTo(10, 3);
    pool.step(0.5);
    pool.write(out);
    expect(out[1]).toBeCloseTo(0.5, 3);
  });

  it('blends size and colour over life and fades in', () => {
    const pool = new ParticlePool(1, seeded(4));
    const spec = emptySpec();
    Object.assign(spec, { life: 1, size0: 10, size1: 0, r0: 1, r1: 0, a0: 1, a1: 1 });
    pool.spawn(spec);
    const out = new Float32Array(INSTANCE_STRIDE);
    pool.step(0.5);
    pool.write(out);
    expect(out[3]).toBeCloseTo(5, 4);
    expect(out[4]).toBeCloseTo(0.5, 4);
    expect(out[7]).toBeCloseTo(1, 4);
    const early = new ParticlePool(1, seeded(5));
    early.spawn(spec);
    early.step(0.02);
    early.write(out);
    expect(out[7]).toBeLessThan(0.3);
  });

  it('writes after an offset and never past the buffer', () => {
    const pool = new ParticlePool(10, seeded(6));
    const spec = emptySpec();
    spec.life = 1;
    for (let i = 0; i < 10; i++) pool.spawn(spec);
    const out = new Float32Array(INSTANCE_STRIDE * 4);
    expect(pool.write(out, 1)).toBe(3);
  });
});

describe('particle budget', () => {
  it('scales requests by the quality level', () => {
    const high = new ParticleBudget(QUALITY.high, seeded(7));
    const low = new ParticleBudget(QUALITY.low, seeded(7));
    let h = 0;
    let l = 0;
    for (let f = 0; f < 200; f++) {
      high.beginFrame(1 / 60, 0);
      low.beginFrame(1 / 60, 0);
      h += high.take(10);
      l += low.take(10);
    }
    expect(h).toBe(2000);
    expect(l).toBeGreaterThan(2000 * QUALITY.low.spawnScale * 0.85);
    expect(l).toBeLessThan(2000 * QUALITY.low.spawnScale * 1.15);
  });

  it('rounds fractions at random so trickles still spawn at the right rate', () => {
    const b = new ParticleBudget(QUALITY.high, seeded(8));
    let n = 0;
    for (let f = 0; f < 1000; f++) {
      b.beginFrame(1 / 60, 0);
      n += b.take(0.3);
    }
    expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(350);
  });

  it('thins ambient particles as the pools fill but keeps important ones', () => {
    const b = new ParticleBudget(QUALITY.high, seeded(9));
    b.beginFrame(1 / 60, 0.4);
    expect(b.take(10)).toBe(10);
    b.beginFrame(1 / 60, 0.97);
    expect(b.take(10)).toBe(0);
    expect(b.take(10, true)).toBe(10);
  });

  it('caps what one frame may start', () => {
    const b = new ParticleBudget(QUALITY.medium, seeded(10));
    b.beginFrame(1 / 60, 0);
    let n = 0;
    for (let i = 0; i < 100; i++) n += b.take(20, true);
    expect(n).toBe(QUALITY.medium.maxSpawnPerFrame);
  });

  it('backs off when frames are slow and recovers when they are fast', () => {
    const b = new ParticleBudget(QUALITY.high, seeded(11));
    for (let f = 0; f < 300; f++) b.beginFrame(0.045, 0);
    expect(b.throttle).toBeLessThan(0.5);
    for (let f = 0; f < 600; f++) b.beginFrame(1 / 60, 0);
    expect(b.throttle).toBe(1);
  });

  it('does not throttle at 60 Hz or on a single hitch', () => {
    const b = new ParticleBudget(QUALITY.high, seeded(12));
    for (let f = 0; f < 300; f++) b.beginFrame(1 / 60, 0);
    b.beginFrame(0.5, 0);
    expect(b.throttle).toBe(1);
  });
});

describe('quality levels', () => {
  it('grow from Low to High', () => {
    const [low, medium, high] = VFX_QUALITIES.map((q) => QUALITY[q]);
    if (!low || !medium || !high) throw new Error('missing level');
    expect(low.glowCapacity).toBeLessThan(medium.glowCapacity);
    expect(medium.glowCapacity).toBeLessThan(high.glowCapacity);
    expect(low.spawnScale).toBeLessThan(high.spawnScale);
    // Low draws the plain shapes, with no ribbons or ground light.
    expect(low.shaders || low.ribbons || low.groundLight).toBe(false);
    expect(high.shaders && high.ribbons && high.statusParticles).toBe(true);
  });

  it('is a stored client setting that falls back to High', () => {
    expect(DEFAULT_OPTIONS.vfxQuality).toBe('high');
    expect(parseSettings(JSON.stringify({ options: { vfxQuality: 'low' } })).options.vfxQuality).toBe('low');
    expect(parseSettings(JSON.stringify({ options: { vfxQuality: 'ultra' } })).options.vfxQuality).toBe('high');
    expect(isVfxQuality('medium')).toBe(true);
    expect(isVfxQuality(3)).toBe(false);
  });
});

describe('held jitter', () => {
  it('holds each value for a tenth of a second and stays within the range', () => {
    const j = new HeldJitter(JITTER_RANGE, 0.1, seeded(7));
    const first = j.next(1 / 60);
    for (let i = 0; i < 5; i++) expect(j.next(1 / 60)).toBe(first);
    const values = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const v = j.next(1 / 60);
      expect(Math.abs(v - 1)).toBeLessThanOrEqual(JITTER_RANGE + 1e-9);
      values.add(v);
    }
    // Ten seconds at 60 fps: about 100 held values, not 600.
    expect(values.size).toBeGreaterThan(80);
    expect(values.size).toBeLessThan(120);
  });
});

describe('night mode', () => {
  it('is night underground, never on flat maps and follows the clock outdoors', () => {
    expect(nightModeOf('dungeon')).toBe('underground');
    expect(nightModeOf('staging')).toBe('underground');
    expect(nightModeOf('arena')).toBe('underground');
    expect(nightModeOf('flat')).toBe('none');
    expect(nightModeOf('town')).toBe('outdoors');
    expect(nightModeOf('wilds')).toBe('outdoors');
    expect(darkness('underground', 0.2)).toBe(1);
    expect(darkness('none', 0.8)).toBe(0);
    expect(darkness('outdoors', 0.2)).toBe(0);
    expect(darkness('outdoors', 0.8)).toBe(1);
  });
});
