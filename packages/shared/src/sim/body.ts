import { ENEMIES, type EnemyTypeId } from '../data/enemies.js';
import type { EntityId } from './ecs.js';
import type { Simulation } from './simulation.js';

/**
 * Long-bodied monsters (traits.body): hurt circles along the spine beyond the movement collider,
 * so a shot or a click on the flank or tail lands. Movement, pathing and separation keep the
 * single collider. Circles are placed along the facing and scaled by the entity's radius over
 * the type's code radius, so rares and radius overrides grow the body with the model (which the
 * client scales the same way). Nothing here allocates: these run per projectile per enemy per tick.
 */

/**
 * Distance from (px, py) to the edge of the nearest body circle, negative inside one; Infinity for
 * a type without a body. (x, y), radius and facing are the entity's, as the sim or a snapshot has them.
 */
export function bodyGap(typeId: EnemyTypeId, radius: number, x: number, y: number, facing: number, px: number, py: number): number {
  const def = ENEMIES[typeId];
  if (def.behaviour !== 'monster' || !def.traits.body) return Infinity;
  const k = radius / def.radius;
  const cx = Math.cos(facing);
  const cy = Math.sin(facing);
  let best = Infinity;
  for (const c of def.traits.body.circles) {
    const gap = Math.hypot(px - (x + cx * c.along * k), py - (y + cy * c.along * k)) - c.radius * k;
    if (gap < best) best = gap;
  }
  return best;
}

/** Where a long body turns about, as a distance along its facing at its own size; 0 for others. */
export function bodyPivot(typeId: EnemyTypeId, radius: number): number {
  const def = ENEMIES[typeId];
  if (def.behaviour !== 'monster' || !def.traits.body) return 0;
  return (def.traits.body.pivot * radius) / def.radius;
}

/** Distance from a point to the edge of the target's nearest hurt circle (collider or body). */
export function hurtGap(sim: Simulation, id: EntityId, px: number, py: number): number {
  const w = sim.world;
  const pos = w.position.get(id);
  if (!pos) return Infinity;
  const r = w.radius.get(id) ?? 0;
  const gap = Math.hypot(px - pos.x, py - pos.y) - r;
  const e = w.enemy.get(id);
  return e ? Math.min(gap, bodyGap(e.typeId, r, pos.x, pos.y, e.facing, px, py)) : gap;
}

/** Whether a circle of radius `reach` at (px, py) touches the target's collider or its body. */
export function withinHurt(sim: Simulation, id: EntityId, px: number, py: number, reach: number): boolean {
  const w = sim.world;
  const pos = w.position.get(id);
  if (!pos) return false;
  const r = (w.radius.get(id) ?? 0) + reach;
  const dx = px - pos.x;
  const dy = py - pos.y;
  // The plain collider first: it is the whole answer for nearly every target.
  if (dx * dx + dy * dy <= r * r) return true;
  const e = w.enemy.get(id);
  return e !== undefined && bodyGap(e.typeId, w.radius.get(id) ?? 0, pos.x, pos.y, e.facing, px, py) <= reach;
}
