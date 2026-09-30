import { BufferAttribute, BufferGeometry, OrthographicCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { withoutUvRect } from '../src/render/propBatch.js';
import { ParticleBudget } from '../src/render/vfx/budget.js';
import { emptySpec, ParticlePool, type ParticleSpec } from '../src/render/vfx/pool.js';
import { QUALITY, type QualityLevel } from '../src/render/vfx/quality.js';
import { FIRE_FULL, FIRE_OFF, FIRE_SPRITE, fireDetail, FULL_RANGE, MAX_FULL, nearestFirst, WorldFires, type FireHost, type FireKind, type FireSpot } from '../src/render/vfx/worldFires.js';

function spot(kind: FireKind, x: number, y: number): FireSpot {
  return { kind, x, y, h: 10, size: 1, pull: 0, lightX: x, lightY: y, flicker: 0.1, forge: false };
}

/** A host that counts what the fires spawn; the budget always says yes at High. */
function host(level: QualityLevel, focusX = 0, focusY = 0): FireHost & { glow: number; smoke: number } {
  const budget = new ParticleBudget(level, () => 0);
  budget.beginFrame(1 / 60, 0);
  return {
    budget,
    level,
    night: 1,
    time: 1,
    focusX,
    focusY,
    glow: 0,
    smoke: 0,
    spawnGlow() {
      this.glow++;
      return true;
    },
    spawnSmoke() {
      this.smoke++;
      return true;
    },
  };
}

/** The game's camera: orthographic, looking down at the focus from the south-east. */
function camera(focusX: number, focusY: number): OrthographicCamera {
  const cam = new OrthographicCamera(-480, 480, 270, -270, 1, 5400);
  cam.position.set(focusX + 780, 1420, focusY + 780);
  cam.lookAt(focusX, 0, focusY);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('fire detail', () => {
  it('draws nothing off screen, the flame far away and everything near the middle', () => {
    expect(fireDetail(1.5, 0, 100, true)).toBe(FIRE_OFF);
    expect(fireDetail(0, -2, 100, true)).toBe(FIRE_OFF);
    expect(fireDetail(0.2, 0.1, FULL_RANGE + 1, true)).toBe(FIRE_SPRITE);
    expect(fireDetail(0.2, 0.1, 100, true)).toBe(FIRE_FULL);
  });

  it('keeps flames and drops particles when the quality has none', () => {
    expect(fireDetail(0, 0, 0, false)).toBe(FIRE_SPRITE);
  });

  it('keeps a flame whose base is just below the screen, since its tip shows', () => {
    expect(fireDetail(0, -1.1, 100, true)).toBe(FIRE_FULL);
  });
});

describe('nearest first', () => {
  it('picks the closest few in order without repeats', () => {
    const dist = new Float32Array([300, 50, 900, 10, 400]);
    const out = new Int32Array(3);
    expect(nearestFirst(dist, 5, 3, out)).toBe(3);
    expect(Array.from(out)).toEqual([3, 1, 0]);
  });

  it('returns fewer when there are fewer candidates', () => {
    const out = new Int32Array(8);
    expect(nearestFirst(new Float32Array([5, 1]), 2, 8, out)).toBe(2);
    expect(Array.from(out.slice(0, 2))).toEqual([1, 0]);
  });
});

describe('world fires', () => {
  it('gives the nearest fires particles, up to the cap, and draws the rest as flames', () => {
    const fires = new WorldFires(camera(0, 0), { value: 0 });
    // A ring of torches around the focus, all on screen.
    fires.setSpots(Array.from({ length: 14 }, (_, i) => spot('torch', Math.cos(i) * 200, Math.sin(i) * 200)));
    const h = host(QUALITY.high);
    fires.update(1, h);
    expect(fires.stats.drawn).toBe(14);
    expect(fires.stats.full).toBe(MAX_FULL);
    // A flame and a glow per torch.
    expect(fires.stats.quads).toBe(28);
    expect(h.smoke).toBeGreaterThan(0);
  });

  it('keeps the flames on Low but spawns no particles and no shimmer', () => {
    const fires = new WorldFires(camera(0, 0), { value: 0 });
    fires.setSpots([spot('bonfire', 0, 0), spot('torch', 60, 0)]);
    const h = host(QUALITY.low);
    fires.update(1, h);
    expect(fires.stats.drawn).toBe(2);
    expect(fires.stats.full).toBe(0);
    expect(h.glow + h.smoke).toBe(0);
    // Bonfire: coals, five tongues and a glow, no shimmer; torch: flame and glow.
    expect(fires.stats.quads).toBe(9);
  });

  it('skips fires off screen and never gives lanterns or candles particles', () => {
    const fires = new WorldFires(camera(0, 0), { value: 0 });
    fires.setSpots([spot('torch', 5000, 5000), spot('lantern', 0, 0), spot('candle', 20, 0)]);
    const h = host(QUALITY.high);
    fires.update(1, h);
    expect(fires.stats.drawn).toBe(2);
    expect(fires.stats.full).toBe(0);
    expect(h.glow + h.smoke).toBe(0);
  });

  it('flares the forge with an important burst of sparks', () => {
    const fires = new WorldFires(camera(0, 0), { value: 0 });
    fires.setSpots([{ ...spot('bonfire', 0, 0), forge: true }]);
    const h = host(QUALITY.high);
    fires.update(0, h);
    const before = h.glow;
    fires.flareForge();
    fires.update(0, h);
    expect(h.glow - before).toBeGreaterThanOrEqual(30);
  });
});

describe('particle wobble', () => {
  function drift(wobble: number): number {
    const pool = new ParticlePool(1, () => 0.5);
    const s: ParticleSpec = emptySpec();
    s.life = 10;
    s.y = 50;
    s.wobble = wobble;
    pool.spawn(s);
    for (let i = 0; i < 60; i++) pool.step(1 / 60);
    const out = new Float32Array(14);
    pool.write(out);
    return Math.hypot(out[0] ?? 0, out[2] ?? 0);
  }

  it('drifts sideways only when asked', () => {
    expect(drift(0)).toBe(0);
    expect(drift(80)).toBeGreaterThan(1);
  });
});

describe('baked flame removal', () => {
  it('drops the triangles painted from the fire gradient and keeps the rest', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    // Triangle one on the torch handle, triangle two in the fire gradient.
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0.1, 0.1, 0.12, 0.1, 0.1, 0.12, 0.92, 0.6, 0.93, 0.6, 0.92, 0.62]), 2));
    const out = withoutUvRect(g, { u0: 0.9, u1: 0.96, v0: 0.5, v1: 0.7 });
    expect(out.getIndex()?.count).toBe(3);
    expect(Array.from(out.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
  });

  it('returns the same geometry when nothing matches', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
    expect(withoutUvRect(g, { u0: 0.9, u1: 0.96, v0: 0.5, v1: 0.7 })).toBe(g);
  });
});
