import { describe, expect, it } from 'vitest';
import { buildMap, DEFAULT_TOWN_LAYOUT, GameMap, HOME_ZONE, layoutToMap, WILDS, ZONE_IDS, type MapDescriptor, type WorldMap } from '../src/index.js';
import { CAMPS } from '../src/world/camps.js';
import { distToSegment, distToShape } from '../src/world/gen.js';

const zone = (z: (typeof ZONE_IDS)[number], seed: number): Extract<MapDescriptor, { kind: 'zone' }> => ({ kind: 'zone', zone: z, seed });
const SEEDS = [1, 42, 9001, 123456, 777];

function reachable(map: WorldMap): { gm: GameMap; seen: Set<number> } {
  const gm = new GameMap(map);
  const start = gm.navCell(map.spawn.x, map.spawn.y);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const c = queue.pop() ?? 0;
    const cx = c % gm.navCols;
    const cy = (c - cx) / gm.navCols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (!gm.isWalkable(cx + dx, cy + dy)) continue;
      const n = (cy + dy) * gm.navCols + cx + dx;
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return { gm, seen };
}

/** The decor pieces of the camp around (x, y). */
function campDecor(map: WorldMap, x: number, y: number): WorldMap['decor'] {
  return map.decor.filter((d) => Math.hypot(d.x - x, d.y - y) <= CAMPS.radius);
}

/** Whether a ground patch is the camp's own trampled dirt. */
function isCampGround(map: WorldMap, g: WorldMap['ground'][number]): boolean {
  return g.kind === 'dirt' && g.shape.type === 'circle' && (map.camps ?? []).some((c) => g.shape.type === 'circle' && g.shape.x === c.x && g.shape.y === c.y);
}

describe('zone camps', () => {
  it('are the same for the same seed and differ between seeds', () => {
    for (const id of ZONE_IDS) {
      const a = buildMap(zone(id, 42));
      const b = buildMap(zone(id, 42));
      expect(a.camps).toEqual(b.camps);
      expect(a.decor).toEqual(b.decor);
      expect(a.packs).toEqual(b.packs);
      expect(buildMap(zone(id, 43)).camps).not.toEqual(a.camps);
    }
  });

  it('a few per zone, each with a camp fire, some guarded', () => {
    let guarded = 0;
    let total = 0;
    for (const id of ZONE_IDS) {
      for (const seed of SEEDS) {
        const map = buildMap(zone(id, seed));
        const camps = map.camps ?? [];
        expect(camps.length, `${id}/${seed}`).toBeGreaterThanOrEqual(2);
        expect(camps.length, `${id}/${seed}`).toBeLessThanOrEqual(6);
        for (const c of camps) {
          expect(map.decor.some((d) => d.asset === 'campfire' && d.x === c.x && d.y === c.y)).toBe(true);
          expect(campDecor(map, c.x, c.y).length).toBeGreaterThanOrEqual(4);
          const pack = map.packs.find((p) => p.x === c.x && p.y === c.y);
          expect(!!pack, `${id}/${seed} camp guard`).toBe(c.guarded);
          if (pack) expect(pack.boss).toBe(false);
          guarded += c.guarded ? 1 : 0;
          total++;
        }
      }
    }
    expect(guarded).toBeGreaterThan(0);
    expect(guarded).toBeLessThan(total);
  });

  it('never on roads, plazas, portals, waypoints or gates, and clear of walls and rocks', () => {
    for (const id of ZONE_IDS) {
      for (const seed of SEEDS) {
        const map = buildMap(zone(id, seed));
        const { gm, seen } = reachable(map);
        for (const c of map.camps ?? []) {
          const where = `${id}/${seed} camp at ${Math.round(c.x)},${Math.round(c.y)}`;
          expect(seen.has(gm.navCell(c.x, c.y)), `${where} reachable`).toBe(true);
          for (const p of map.portals) expect(Math.hypot(p.x - c.x, p.y - c.y), `${where} vs ${p.label}`).toBeGreaterThanOrEqual(p.r + CAMPS.portalClearance);
          for (const g of map.ground) {
            if (isCampGround(map, g)) continue;
            const s = g.shape;
            const d = s.type === 'capsule' ? distToSegment(c.x, c.y, s.ax, s.ay, s.bx, s.by) - s.r : distToShape(c.x, c.y, s);
            expect(d, `${where} vs ${g.kind}`).toBeGreaterThanOrEqual(CAMPS.radius);
          }
          for (const r of map.rivers) for (const pt of r.path) expect(Math.hypot(pt.x - c.x, pt.y - c.y)).toBeGreaterThan(CAMPS.radius + r.width / 2);
          for (const o of map.obstacles) {
            // The camp's own tent is the only solid thing inside it.
            if (o.kind === 'decor') continue;
            expect(distToShape(c.x, c.y, o.shape), `${where} vs ${o.kind}`).toBeGreaterThanOrEqual(CAMPS.radius);
          }
          expect(Math.hypot(c.x - map.spawn.x, c.y - map.spawn.y)).toBeGreaterThanOrEqual(WILDS.safeRadius);
        }
      }
    }
  });

  it('leave the town alone', () => {
    const town = layoutToMap(DEFAULT_TOWN_LAYOUT);
    for (const seed of SEEDS) {
      const map = buildMap(zone(HOME_ZONE, seed));
      const rect = map.safeZones?.[0];
      expect(rect).toBeDefined();
      if (!rect) continue;
      const inTown = (x: number, y: number): boolean => x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
      expect(map.decor.filter((d) => inTown(d.x, d.y))).toEqual(town.decor);
      for (const c of map.camps ?? []) {
        const pad = 140 + WILDS.aggroRadius;
        const near = c.x > rect.x - pad && c.x < rect.x + rect.w + pad && c.y > rect.y - pad && c.y < rect.y + rect.h + pad;
        expect(near, `camp at ${Math.round(c.x)},${Math.round(c.y)}`).toBe(false);
      }
    }
  });
});
