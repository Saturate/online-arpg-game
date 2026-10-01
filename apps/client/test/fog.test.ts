import { describe, expect, it } from 'vitest';
import { decodeBits, encodeBits, FOG_KEEP, FogGrid, fogKey, readFog, writeFog, type FogStorage } from '../src/render/fog.js';

function memoryStorage(limit = Infinity): FogStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > limit) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe('fog grid', () => {
  it('keeps one bit per cell: the world at 80 units a cell is 3.3 KB', () => {
    const g = new FogGrid(163, 163, 80);
    expect(g.bits.length).toBe(Math.ceil((163 * 163) / 8));
    expect(g.bits.length).toBeLessThan(3400);
  });

  it('marks a cell once and reports only new cells', () => {
    const g = new FogGrid(10, 10, 10);
    expect(g.set(37)).toBe(true);
    expect(g.set(37)).toBe(false);
    expect(g.has(37)).toBe(true);
    expect(g.has(36)).toBe(false);
    expect(g.set(-1)).toBe(false);
    expect(g.set(100)).toBe(false);
    expect(g.count()).toBe(1);
  });

  it('finds the cell under a spot, and none off the grid', () => {
    const g = new FogGrid(10, 5, 10);
    expect(g.index(0, 0)).toBe(0);
    expect(g.index(15, 25)).toBe(21);
    expect(g.index(-1, 5)).toBe(-1);
    expect(g.index(100, 5)).toBe(-1);
    expect(g.index(5, 50)).toBe(-1);
  });

  it('uncovers a circle of cells by their middles, clipped to the grid', () => {
    const g = new FogGrid(20, 20, 10);
    const fresh: number[] = [];
    g.markCircle(100, 100, 30, fresh);
    // Middles within 30 of (100, 100): a disc of cells about 6 across.
    expect(fresh.length).toBeGreaterThan(20);
    expect(fresh.length).toBeLessThan(36);
    expect(g.seenAt(100, 100)).toBe(true);
    expect(g.seenAt(125, 125)).toBe(false);
    expect(g.seenAt(100, 129)).toBe(true);
    const again: number[] = [];
    g.markCircle(100, 100, 30, again);
    expect(again).toEqual([]);
    const corner: number[] = [];
    g.markCircle(0, 0, 25, corner);
    expect(corner.every((i) => i >= 0 && i < g.size)).toBe(true);
  });

  it('uncovers every cell a rectangle touches', () => {
    const g = new FogGrid(10, 10, 10);
    const fresh: number[] = [];
    g.markRect(10, 10, 20, 10, fresh);
    expect(fresh.length).toBe(3 * 2);
  });
});

describe('fog encoding', () => {
  it('round trips the bits through base64', () => {
    const bits = new Uint8Array(5000);
    for (let i = 0; i < bits.length; i++) bits[i] = (i * 37) & 255;
    const back = decodeBits(encodeBits(bits), bits.length);
    expect(back).toEqual(bits);
  });

  it('refuses text of the wrong length or not base64', () => {
    expect(decodeBits(encodeBits(new Uint8Array(10)), 11)).toBeNull();
    expect(decodeBits('not base64 !!', 4)).toBeNull();
  });
});

describe('fog memory', () => {
  it('remembers a world per character and seed', () => {
    const s = memoryStorage();
    const grid = new FogGrid(30, 20, 80);
    grid.markCircle(800, 800, 300, []);
    writeFog(s, fogKey(7, 904226), { grid, regions: ['barrens', 'steppe'], waypoints: ['steppe-1'] }, 1);
    const back = readFog(s, fogKey(7, 904226), 30, 20, 80);
    expect(back?.grid.bits).toEqual(grid.bits);
    expect(back?.regions).toEqual(['barrens', 'steppe']);
    expect(back?.waypoints).toEqual(['steppe-1']);
    expect(readFog(s, fogKey(8, 904226), 30, 20, 80)).toBeNull();
    expect(readFog(s, fogKey(7, 1), 30, 20, 80)).toBeNull();
  });

  it('ignores a record of another grid shape or a corrupt one', () => {
    const s = memoryStorage();
    writeFog(s, 'rune.fog.1.2', { grid: new FogGrid(30, 20, 80), regions: [], waypoints: [] }, 1);
    expect(readFog(s, 'rune.fog.1.2', 31, 20, 80)).toBeNull();
    s.data.set('rune.fog.1.3', '{"v":1,"c":30,"r":20,"b":"AAA"}');
    expect(readFog(s, 'rune.fog.1.3', 30, 20, 80)).toBeNull();
    s.data.set('rune.fog.1.4', 'not json');
    expect(readFog(s, 'rune.fog.1.4', 30, 20, 80)).toBeNull();
    s.data.set('rune.fog.1.5', JSON.stringify({ v: 1, c: 30, r: 20, b: encodeBits(new Uint8Array(75)), g: [3], w: 'x' }));
    expect(readFog(s, 'rune.fog.1.5', 30, 20, 80)).toEqual(expect.objectContaining({ regions: [], waypoints: [] }));
  });

  it('forgets the least recently saved worlds past the cap', () => {
    const s = memoryStorage();
    const rec = { grid: new FogGrid(8, 8, 80), regions: [], waypoints: [] };
    for (let i = 0; i < FOG_KEEP + 4; i++) writeFog(s, fogKey(1, i), rec, i);
    // The first world saved again counts as recent.
    writeFog(s, fogKey(1, 0), rec, 1000);
    const kept = [...s.data.keys()].filter((k) => k !== 'rune.fog.index');
    expect(kept).toHaveLength(FOG_KEEP);
    expect(kept).toContain(fogKey(1, 0));
    expect(kept).not.toContain(fogKey(1, 1));
    expect(kept).toContain(fogKey(1, FOG_KEEP + 3));
  });

  it('does not throw when storage refuses', () => {
    const s = memoryStorage(10);
    expect(() => writeFog(s, fogKey(1, 1), { grid: new FogGrid(30, 20, 80), regions: [], waypoints: [] }, 1)).not.toThrow();
    const broken: FogStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
    };
    expect(readFog(broken, 'k', 1, 1, 1)).toBeNull();
    expect(() => writeFog(broken, 'k', { grid: new FogGrid(1, 1, 1), regions: [], waypoints: [] }, 1)).not.toThrow();
  });
});
