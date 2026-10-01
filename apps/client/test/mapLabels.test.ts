import { freshWorld, ZONES } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { fitLabels, regionLabels } from '../src/render/mapLabels.js';

describe('region name placement', () => {
  const { plan } = freshWorld(904226);
  const labels = regionLabels(plan.edges, plan.town);

  it('names every region with a road once', () => {
    const regions = new Set(plan.edges.map((e) => e.region));
    expect(labels.map((l) => l.region).sort()).toEqual([...regions].sort());
    for (const l of labels) expect(ZONES[l.region].name.length).toBeGreaterThan(0);
  });

  it('puts each name inside its own region and off the town', () => {
    const t = plan.town;
    for (const l of labels) {
      expect(plan.regionAt(l.x, l.y)).toBe(l.region);
      const dx = Math.max(t.x - l.x, 0, l.x - (t.x + t.w));
      const dy = Math.max(t.y - l.y, 0, l.y - (t.y + t.h));
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(500);
    }
  });

  it('keeps names far enough apart to read on the world map', () => {
    // 1200 units is about 58 pixels on the world map, more than a name's height.
    for (const a of labels) for (const b of labels) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1200);
  });

  it('is the same for a seed every time', () => {
    expect(regionLabels(freshWorld(904226).plan.edges, plan.town)).toEqual(labels);
  });

  it('picks the road point nearest the middle of a region', () => {
    const edges = [
      { ax: 0, ay: 0, bx: 1000, by: 0, length: 1000, region: 'a' },
      { ax: 1000, ay: 0, bx: 2000, by: 0, length: 1000, region: 'a' },
      { ax: 5000, ay: 0, bx: 6000, by: 0, length: 1000, region: 'b' },
    ] as const;
    const out = regionLabels(edges, { x: -5000, y: -5000, w: 10, h: 10 });
    expect(out).toEqual([
      { region: 'a', x: 750, y: 0 },
      { region: 'b', x: 5500, y: 0 },
    ]);
  });
});

describe('label fitting', () => {
  it('keeps the higher priority of two overlapping names', () => {
    const kept = fitLabels(
      [
        { x: 50, y: 50, w: 60, h: 12, priority: 1 },
        { x: 70, y: 52, w: 60, h: 12, priority: 3 },
        { x: 50, y: 120, w: 60, h: 12, priority: 1 },
      ],
      200,
      200,
    );
    expect(kept.sort()).toEqual([1, 2]);
  });

  it('drops names that run past the canvas edge', () => {
    expect(fitLabels([{ x: 10, y: 50, w: 60, h: 12, priority: 1 }], 200, 200)).toEqual([]);
    expect(fitLabels([{ x: 100, y: 199, w: 60, h: 12, priority: 1 }], 200, 200)).toEqual([]);
  });
});
