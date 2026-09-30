import { describe, expect, it } from 'vitest';
import { minimapRotation, rotatedBounds, rotatePoint } from '../src/render/minimap.js';
import { VIEW } from '../src/render/config.js';

/** The ground direction the camera shows as screen up, as GameScene builds its basis. */
function screenUp(yawDegrees: number): { x: number; y: number } {
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: -Math.sin(yaw), y: -Math.cos(yaw) };
}

describe('minimap rotation', () => {
  for (const yaw of [VIEW.yawDegrees, 0, 30, 90, -60]) {
    it(`turns screen up to minimap up and screen right to minimap right at yaw ${yaw}`, () => {
      const angle = minimapRotation(yaw);
      const up = screenUp(yaw);
      const right = { x: -up.y, y: up.x };
      // A 100 by 100 map on a canvas of the same size: the centre stays put, directions turn.
      const u = rotatePoint(50 + up.x * 10, 50 + up.y * 10, 100, 100, 100, 100, angle);
      expect(u.x).toBeCloseTo(50);
      expect(u.y).toBeCloseTo(40);
      const r = rotatePoint(50 + right.x * 10, 50 + right.y * 10, 100, 100, 100, 100, angle);
      expect(r.x).toBeCloseTo(60);
      expect(r.y).toBeCloseTo(50);
    });
  }

  it('fits the turned map in its bounds', () => {
    const angle = minimapRotation(45);
    const b = rotatedBounds(200, 100, angle);
    expect(b.w).toBeCloseTo(300 / Math.SQRT2);
    expect(b.h).toBeCloseTo(300 / Math.SQRT2);
    for (const [x, y] of [
      [0, 0],
      [200, 0],
      [0, 100],
      [200, 100],
    ] as const) {
      const p = rotatePoint(x, y, 200, 100, b.w, b.h, angle);
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(b.w + 1e-9);
      expect(p.y).toBeLessThanOrEqual(b.h + 1e-9);
    }
  });

  it('leaves a north-up camera alone', () => {
    expect(rotatedBounds(120, 80, minimapRotation(0))).toEqual({ w: 120, h: 80 });
    const p = rotatePoint(10, 70, 120, 80, 120, 80, minimapRotation(0));
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(70);
  });
});
