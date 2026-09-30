import { STREAMING } from '@rune/shared';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkBuckets, chunkAction, chunkCoord, chunkKey, chunkKeyAt, CHUNK_SIZE, keyCoords, NearCache, rectDistance, streamRadii, viewFootprint, type ChunkAction } from '../src/render/chunks.js';
import { VIEW } from '../src/render/config.js';
import { WorldChunks } from '../src/render/worldChunks.js';

describe('chunk indexing', () => {
  it('uses the server chunk size', () => {
    expect(CHUNK_SIZE).toBe(STREAMING.chunkSize);
  });

  it('floors into chunks, negative outside the map', () => {
    expect(chunkCoord(0)).toBe(0);
    expect(chunkCoord(999.9)).toBe(0);
    expect(chunkCoord(1000)).toBe(1);
    expect(chunkCoord(-0.1)).toBe(-1);
    expect(chunkCoord(-1000)).toBe(-1);
    expect(chunkCoord(-1000.1)).toBe(-2);
  });

  it('packs and unpacks keys, border chunks included', () => {
    for (const [cx, cy] of [
      [0, 0],
      [-2, 7],
      [13, -1],
      [-1000, 1000],
    ] as const) {
      expect(keyCoords(chunkKey(cx, cy))).toEqual({ cx, cy });
    }
    expect(chunkKeyAt(1500, -200)).toBe(chunkKey(1, -1));
    expect(new Set([chunkKey(1, 0), chunkKey(0, 1), chunkKey(-1, 0), chunkKey(0, -1)]).size).toBe(4);
  });

  it('measures the distance to a rectangle', () => {
    const r = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    expect(rectDistance(r, 500, 500)).toBe(0);
    expect(rectDistance(r, 1300, 500)).toBe(300);
    expect(rectDistance(r, -300, -400)).toBe(500);
  });
});

describe('which chunks are near', () => {
  it('sees about 600 units to the corner of the game view on a 16:9 screen', () => {
    const halfH = VIEW.viewHeight / 2;
    const f = viewFootprint((halfH * 16) / 9, halfH, 1, (VIEW.pitchDegrees * Math.PI) / 180);
    expect(f).toBeGreaterThan(550);
    expect(f).toBeLessThan(650);
    // Zooming out (the town editor goes to 0.2) widens it in step.
    expect(viewFootprint((halfH * 16) / 9, halfH, 0.5, (VIEW.pitchDegrees * Math.PI) / 180)).toBeCloseTo(f * 2);
  });

  it('keeps the radii in order, never under the brief view of 1100', () => {
    for (const f of [0, 600, 1500, 3000]) {
      const r = streamRadii(f);
      expect(r.show).toBeGreaterThanOrEqual(1100);
      expect(r.show).toBeGreaterThanOrEqual(f);
      expect(r.hide).toBeGreaterThan(r.show);
      expect(r.build).toBeGreaterThan(r.hide);
      expect(r.release).toBeGreaterThan(r.build);
    }
  });

  it('gathers bucketed items near a point in their original order', () => {
    const points = [
      { x: 5000, y: 5000 },
      { x: 10, y: 10 },
      { x: 1100, y: 20 },
      { x: -50, y: 900 },
      { x: 2600, y: 0 },
    ];
    const b = new ChunkBuckets(points);
    const out: number[] = [];
    expect(b.near(500, 500, 0, out)).toBe(1);
    expect(out).toEqual([1]);
    b.near(500, 500, 600, out);
    expect(out).toEqual([1, 2, 3]);
    b.near(500, 500, 2200, out);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('gathers again only once the focus has moved past the slack', () => {
    const b = new ChunkBuckets([
      { x: 100, y: 100 },
      { x: 1400, y: 100 },
    ]);
    const near = new NearCache(b, 150);
    expect([...near.update(100, 100, 100)]).toEqual([0]);
    // 100 units on: still the old list, which the slack already covers.
    expect([...near.update(200, 100, 100)]).toEqual([0]);
    expect([...near.update(900, 100, 100)]).toEqual([0, 1]);
  });
});

describe('chunk hysteresis', () => {
  const r = streamRadii(600);

  /** Walks one chunk through a list of distances and returns the actions taken. */
  function walk(distances: number[]): ChunkAction[] {
    let built = false;
    let visible = false;
    const out: ChunkAction[] = [];
    for (const d of distances) {
      let a = chunkAction(built, visible, d, r);
      if (a === 'build') {
        built = true;
        out.push(a);
        a = chunkAction(built, visible, d, r);
      }
      if (a === 'show') visible = true;
      if (a === 'hide') visible = false;
      if (a === 'release') {
        built = false;
        visible = false;
      }
      out.push(a);
    }
    return out;
  }

  it('builds ahead of the view and shows on the same frame when already close', () => {
    expect(walk([r.build + 1, r.build - 1, r.show])).toEqual(['none', 'build', 'none', 'show']);
    expect(walk([0])).toEqual(['build', 'show']);
  });

  it('does not flicker when the camera wanders around the show radius', () => {
    const d = [r.show - 10, r.show + 10, r.show - 10, r.show + 50, r.hide - 1, r.show - 5];
    expect(walk(d).filter((a) => a === 'hide' || a === 'release')).toEqual([]);
  });

  it('hides past the hide radius and releases only past the release radius', () => {
    expect(walk([0, r.hide + 1, r.release - 1, r.show])).toEqual(['build', 'show', 'hide', 'none', 'show']);
    expect(walk([0, r.release + 1, r.release - 1, r.build - 1])).toEqual(['build', 'show', 'release', 'none', 'build', 'none']);
  });
});

describe('world chunks', () => {
  it('builds, draws, hides and releases chunks as the camera moves, and frees what they own', () => {
    const chunks = new WorldChunks();
    const shared = new BoxGeometry(1, 1, 1);
    chunks.shared.add(shared);
    const owned: BoxGeometry[] = [];
    let builds = 0;
    let freed = 0;
    let sharedFreed = 0;
    shared.addEventListener('dispose', () => sharedFreed++);
    for (const x of [500, 6500]) {
      chunks.build(x, 500, 0, (group, anims) => {
        builds++;
        const own = new BoxGeometry(1, 1, 1);
        own.addEventListener('dispose', () => freed++);
        owned.push(own);
        group.add(new Mesh(own, new MeshBasicMaterial()), new Mesh(shared, new MeshBasicMaterial()));
        anims.push(() => {});
      });
    }
    const r = streamRadii(600);
    chunks.update(0, 500, 500, r);
    expect(chunks.stats).toMatchObject({ chunks: 2, built: 1, visible: 1 });
    expect(builds).toBe(1);
    // Walk east: the far chunk is built and drawn, the first hidden then released.
    chunks.update(0, 3500, 500, r);
    expect(chunks.stats.visible).toBe(0);
    chunks.update(0, 6000, 500, r);
    expect(chunks.stats).toMatchObject({ built: 1, visible: 1, releases: 1 });
    expect(freed).toBe(1);
    expect(sharedFreed).toBe(0);
    // Back again: rebuilt from its builder.
    chunks.update(0, 500, 500, r);
    expect(builds).toBe(3);
    chunks.dispose();
    expect(freed).toBe(3);
    expect(sharedFreed).toBe(0);
  });

  it('keeps a prebuilt landmark across a release and animates it only while drawn', () => {
    const chunks = new WorldChunks();
    const landmark = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    let ticks = 0;
    chunks.attach(100, 100, 50, landmark, () => ticks++);
    const r = streamRadii(600);
    chunks.update(0, 100, 100, r);
    expect(ticks).toBe(1);
    chunks.update(0, 100 + r.release + 1500, 100, r);
    expect(ticks).toBe(1);
    expect(landmark.parent).toBeNull();
    chunks.update(0, 100, 100, r);
    expect(ticks).toBe(2);
    expect(landmark.parent).not.toBeNull();
  });
});
