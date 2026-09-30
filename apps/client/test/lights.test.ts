import { describe, expect, it } from 'vitest';
import { LightBudget, lightKey, POOL_SIZE, type StaticLight } from '../src/render/lights.js';

const torch = (x: number, y: number): StaticLight => ({ x, y, height: 60, color: 0xff9a40, intensity: 2, radius: 300, flicker: 0, priority: 0, day: 0 });

function run(b: LightBudget, frames: number, fx: number, fy: number, dark = 1, emit?: () => void): void {
  for (let i = 0; i < frames; i++) {
    emit?.();
    b.update(i / 60, 1 / 60, fx, fy, dark);
  }
}

describe('light budget', () => {
  it('gives real lights to the nearest sources and ground pools to the rest', () => {
    const b = new LightBudget();
    b.setStatic(Array.from({ length: 20 }, (_, i) => torch(i * 40, 0)));
    run(b, 60, 0, 0);
    expect(b.stats.real).toBe(POOL_SIZE);
    // The 12 farther torches have pools; the near ones are fully covered by their real light.
    expect(b.stats.pools).toBe(20 - POOL_SIZE);
  });

  it('is dark by day unless a source asks to glow by day', () => {
    const b = new LightBudget();
    b.setStatic([torch(0, 0)]);
    run(b, 60, 0, 0, 0);
    expect(b.stats.real).toBe(0);
    expect(b.stats.pools).toBe(0);
    const spell = lightKey();
    run(b, 60, 0, 0, 0, () => b.emit(spell, 10, 10, 30, 0xff6a2b, 3, 200, 0, 0.4));
    expect(b.stats.real).toBe(1);
  });

  it('fades a light out over several frames instead of popping when the source stops', () => {
    const b = new LightBudget();
    const key = lightKey();
    run(b, 60, 0, 0, 1, () => b.emit(key, 0, 0, 30, 0xffffff, 2, 200));
    expect(b.slotKeys()).toContain(key);
    run(b, 5, 0, 0);
    expect(b.stats.real).toBe(1);
    run(b, 60, 0, 0);
    expect(b.slotKeys()).not.toContain(key);
    expect(b.stats.real).toBe(0);
  });

  it('keeps a slot for a high-priority source even when many brighter ones are nearer', () => {
    const b = new LightBudget();
    b.setStatic(Array.from({ length: 12 }, (_, i) => ({ ...torch(i * 10, 0), intensity: 5 })));
    const hero = lightKey();
    run(b, 60, 0, 0, 1, () => b.emit(hero, 600, 0, 40, 0xffd6a0, 1, 300, 2));
    expect(b.slotKeys()).toContain(hero);
  });

  it('ignores sources far off screen', () => {
    const b = new LightBudget();
    b.setStatic([torch(5000, 5000)]);
    run(b, 10, 0, 0);
    expect(b.stats.real + b.stats.pools).toBe(0);
  });
});

describe('light budget crowding', () => {
  it('scales a crowd of lights around the hero down instead of burning white', () => {
    const b = new LightBudget();
    const keys = Array.from({ length: 64 }, () => lightKey());
    run(b, 120, 0, 0, 1, () => keys.forEach((k, i) => b.emit(k, Math.cos(i) * 150, Math.sin(i) * 150, 40, 0xff6a2b, 2.5, 260)));
    expect(b.stats.crowd).toBeLessThan(0.4);
  });

  it('leaves a lone torch at full strength', () => {
    const b = new LightBudget();
    b.setStatic([{ x: 0, y: 0, height: 56, color: 0xff9a4a, intensity: 3, radius: 480, flicker: 0, priority: 0, day: 0 }]);
    run(b, 60, 0, 0);
    expect(b.stats.crowd).toBe(1);
  });
});

describe('light budget spell pools', () => {
  const emitAll = (b: LightBudget, keys: number[], at: (i: number) => [number, number]) => () => {
    keys.forEach((k, i) => {
      const [x, y] = at(i);
      b.emit(k, x, y, 30, 0xff6a2b, 1, 100);
    });
  };

  it('divides overlapping spell pools so a cluster does not wash the ground out', () => {
    const keys = Array.from({ length: 25 }, () => lightKey());
    const apart = new LightBudget();
    run(apart, 60, 0, 0, 1, emitAll(apart, keys, (i) => [(i % 5) * 300 - 600, Math.floor(i / 5) * 300 - 600 + 150]));
    const piled = new LightBudget();
    run(piled, 60, 0, 0, 1, emitAll(piled, keys, () => [500, 500]));
    expect(piled.stats.pools).toBe(apart.stats.pools);
    // 8 of the 25 get real lights; the other 17 pools each divide by sqrt(17).
    expect(piled.stats.poolLight / apart.stats.poolLight).toBeCloseTo(1 / Math.sqrt(17), 3);
  });

  it('leaves the pools of the world lights alone', () => {
    const b = new LightBudget();
    b.setStatic(Array.from({ length: 20 }, () => torch(600, 600)));
    run(b, 60, 0, 0);
    const alone = new LightBudget();
    alone.setStatic([torch(600, 600)]);
    run(alone, 60, 0, 0);
    expect(b.stats.poolLight).toBeGreaterThan(alone.stats.poolLight * 10);
  });
});
