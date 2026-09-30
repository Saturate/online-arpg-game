import { describe, expect, it } from 'vitest';
import { MIN_SCALE, minimapRotation, minimapScale, rotateAround, rotatedBounds, rotatePoint, TILE, tilesNear } from '../src/render/minimap.js';
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

describe('minimap tiles', () => {
  const angle = minimapRotation(VIEW.yawDegrees);

  it('shows every zone today whole, and a zone four times the area as a window', () => {
    // The home zone (town plus the zone) and the plain Wilds.
    expect(minimapScale(7400, 3600, angle).windowed).toBe(false);
    expect(minimapScale(5600, 4200, angle).windowed).toBe(false);
    const big = minimapScale(10400, 7200, angle);
    expect(big.windowed).toBe(true);
    expect(big.scale).toBe(MIN_SCALE);
  });

  it('keeps a map shown whole inside one tile', () => {
    const { scale } = minimapScale(7400, 3600, angle);
    expect(7400 * scale).toBeLessThanOrEqual(TILE);
    expect(3600 * scale).toBeLessThanOrEqual(TILE);
  });

  it('picks the tiles a window touches, clipped to the grid', () => {
    expect(tilesNear(10, 10, 20, 4, 3)).toEqual([{ col: 0, row: 0 }]);
    expect(tilesNear(256, 10, 20, 4, 3)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
    ]);
    expect(tilesNear(600, 400, 2000, 4, 3)).toHaveLength(12);
  });

  it('turns around the hero in a window', () => {
    const p = rotateAround(100, 50, 100, 50, 220, 220, angle);
    expect(p.x).toBeCloseTo(110);
    expect(p.y).toBeCloseTo(110);
  });
});
