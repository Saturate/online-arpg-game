import { WILDS } from '../config/sim.js';
import { rollPack, type Biome } from '../data/monsterPools.js';
import { Rng } from '../sim/rng.js';
import { distToSegment, distToShape, fits, inRect } from './gen.js';
import type { GameMap } from './gamemap.js';
import { decorCollision } from './town.js';
import type { Decor, SafeZone, WorldMap } from './types.js';

/**
 * Small camps scattered over a zone: a camp fire with supplies around it, sometimes a tent or a
 * cart, sometimes held by a monster pack. Counts are for the standard Wilds size and scale with area.
 */
export const CAMPS = {
  perMap: 4,
  /** Everything of a camp stays inside this radius of its fire; the whole circle must be open ground. */
  radius: 120,
  /** Away from portals, waypoints and gates, so a camp never crowds a way in or out. */
  portalClearance: 450,
  /** Clear of roads and plazas beyond the camp's own radius. */
  pathClearance: 30,
  /** Between two camps, so they spread over the zone. */
  spacing: 1100,
  guardChance: 0.4,
  /** An unguarded camp keeps this far from packs, so it does not read as guarded by accident. */
  unguardedPackGap: 380,
} as const;

export interface CampSite {
  x: number;
  y: number;
  guarded: boolean;
}

const SUPPLIES = ['crate_A_big', 'crate_B_big', 'crate_A_small', 'barrel', 'sack', 'sack', 'dungeon_barrel_small', 'bucket_water', 'dungeon_keg', 'crate_open'] as const;

/** The obstacle test of a camp site: `fits` with a little spacing, by a scan of the map unless given an index. */
export type CampFits = (x: number, y: number, r: number) => boolean;

/** Whether a camp at (x, y) keeps clear of every road, plaza, portal, gate and camp already placed. */
export function campSiteClear(map: WorldMap, x: number, y: number, keepClear: readonly SafeZone[], fitsAt: CampFits = (px, py, r) => fits(map, px, py, r, { spacing: 8, riverPad: 40, avoid: [] })): boolean {
  const r = CAMPS.radius;
  if (Math.hypot(x - map.spawn.x, y - map.spawn.y) < WILDS.safeRadius) return false;
  // As far from a town as packs keep, since a camp may be guarded.
  if (keepClear.some((z) => inRect(x, y, z, 140 + WILDS.aggroRadius + r))) return false;
  if (map.portals.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + CAMPS.portalClearance)) return false;
  if ((map.lamps ?? []).some((l) => Math.hypot(l.x - x, l.y - y) < r + 60)) return false;
  for (const g of map.ground) {
    const s = g.shape;
    const d = s.type === 'capsule' ? distToSegment(x, y, s.ax, s.ay, s.bx, s.by) - s.r : distToShape(x, y, s);
    if (d < r + CAMPS.pathClearance) return false;
  }
  if ((map.camps ?? []).some((c) => Math.hypot(c.x - x, c.y - y) < CAMPS.spacing)) return false;
  return fitsAt(x, y, r);
}

/**
 * Places the camps of a generated zone, as part of its plan: after the waypoint, the gates, the
 * boss and the entrances, before any chunk content, on its own random stream. Only ground reachable
 * from the spawn is used. Trees and rocks generated later keep off a camp, and packs keep their
 * spacing from a guarded one (it is a pack) and `unguardedPackGap` from the rest.
 *
 * With `spots` (the world plan's side valleys) each camp is looked for around its spot instead of
 * anywhere on the map, and a spot with no room for one is skipped.
 */
export function placeCamps(map: WorldMap, seed: number, gm: GameMap, reach: { has(cell: number): boolean }, keepClear: readonly SafeZone[], levelAt: (x: number, y: number) => number, biomeAt: (x: number, y: number) => Biome, scale: number, fitsAt?: CampFits, spots?: readonly { x: number; y: number }[]): void {
  const rng = Rng.stream(seed, 'camps');
  const wanted = spots ? spots.length : Math.max(1, Math.round(CAMPS.perMap * scale));
  const camps: CampSite[] = [];
  map.camps = camps;
  const tryAt = (x: number, y: number): boolean => {
    if (!reach.has(gm.navCell(x, y)) || !campSiteClear(map, x, y, keepClear, fitsAt)) return false;
    const nearest = map.packs.reduce((best, p) => Math.min(best, Math.hypot(p.x - x, p.y - y)), Infinity);
    // A camp can only take a guard where a new pack keeps the usual spacing from the others.
    const guarded = nearest >= WILDS.packSpacing && rng.next() < CAMPS.guardChance;
    if (!guarded && nearest < CAMPS.unguardedPackGap) return false;
    buildCamp(map, rng, x, y);
    if (guarded) {
      const level = levelAt(x, y);
      map.packs.push({ x, y, ...rollPack(rng, biomeAt(x, y), level), rareLeader: rng.next() < WILDS.rareLeaderChance, level, boss: false });
    }
    camps.push({ x, y, guarded });
    return true;
  };
  if (spots) {
    for (const spot of spots) {
      for (let k = 0; k < 24; k++) {
        const a = rng.range(0, Math.PI * 2);
        const d = k === 0 ? 0 : rng.range(40, 260);
        if (tryAt(spot.x + Math.cos(a) * d, spot.y + Math.sin(a) * d)) break;
      }
    }
    return;
  }
  for (let attempt = 0; attempt < 3000 && camps.length < wanted; attempt++) tryAt(rng.range(300, map.width - 300), rng.range(300, map.height - 300));
}

/** The fire in the middle on trampled dirt, a tent or a cart facing it, and supplies around. */
function buildCamp(map: WorldMap, rng: Rng, x: number, y: number): void {
  map.ground.push({ kind: 'dirt', shape: { type: 'circle', x, y, r: 95 } });
  map.decor.push({ asset: 'campfire', x, y, angle: rng.range(0, Math.PI * 2), scale: 1 });
  const taken: { x: number; y: number; r: number }[] = [{ x, y, r: 36 }];
  const put = (d: Decor, r: number): boolean => {
    if (taken.some((t) => Math.hypot(t.x - d.x, t.y - d.y) < t.r + r - 0.5)) return false;
    taken.push({ x: d.x, y: d.y, r });
    map.decor.push(d);
    return true;
  };
  const back = rng.range(0, Math.PI * 2);
  const shelter = rng.next();
  if (shelter < 0.55) {
    // Faces the fire; solid like the town editor places it, so nobody walks through the canvas.
    const tent: Decor = { asset: 'tent', x: x + Math.cos(back) * 78, y: y + Math.sin(back) * 78, angle: back + Math.PI / 2, scale: 1 };
    const shape = put(tent, 42) ? decorCollision(tent) : null;
    if (shape) map.obstacles.push({ kind: 'decor', shape, blocksMove: true, blocksShots: true, visual: 70 });
  } else if (shelter < 0.8) {
    const cart: Decor = { asset: 'wheelbarrow', x: x + Math.cos(back) * 72, y: y + Math.sin(back) * 72, angle: back + rng.range(-0.4, 0.4), scale: 1.1 };
    put(cart, 36);
  }
  // A log to sit on, on the side of the fire away from the shelter.
  if (rng.next() < 0.6) {
    const a = back + Math.PI + rng.range(-0.5, 0.5);
    put({ asset: 'resource_lumber', x: x + Math.cos(a) * 66, y: y + Math.sin(a) * 66, angle: a + Math.PI / 2, scale: 0.7 }, 26);
  }
  const count = rng.int(3, 6);
  for (let i = 0, placed = 0; i < count * 8 && placed < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(52, CAMPS.radius - 18);
    const asset = SUPPLIES[rng.int(0, SUPPLIES.length - 1)] ?? 'crate_A_big';
    if (put({ asset, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, angle: rng.range(0, Math.PI * 2), scale: rng.range(0.9, 1.15) }, 16)) placed++;
  }
}
