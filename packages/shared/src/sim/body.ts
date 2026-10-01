import { ENEMIES, type EnemyTypeId } from '../data/enemies.js';
import { ENEMY_MODELS, type ModelOverride } from '../data/tuning.js';
import type { EntityId } from './ecs.js';
import type { Simulation } from './simulation.js';

/**
 * Long-bodied monsters (traits.body): hurt circles along the spine beyond the movement collider,
 * so a shot, a bite or a click on the flank or tail lands. Movement, pathing and separation keep
 * the single collider. Nothing that runs per hit allocates.
 */

export interface BodyCircle {
  along: number;
  radius: number;
}

/** A body sized to one entity, in world units along its facing. */
export interface SizedBody {
  circles: readonly BodyCircle[];
  pivot: number;
}

/**
 * The body at an entity's size: the type's circles scaled by its radius over the code radius
 * (rares, radius overrides) and by a height override over the height they were measured at, as
 * the drawn model is. Null for a type without one, or when an admin draws it with another model.
 */
export function sizeBody(typeId: EnemyTypeId, radius: number, model: ModelOverride | undefined): SizedBody | null {
  const def = ENEMIES[typeId];
  if (def.behaviour !== 'monster' || !def.traits.body) return null;
  if (model?.model !== undefined && model.model !== ENEMY_MODELS[typeId]) return null;
  const body = def.traits.body;
  const k = (radius / def.radius) * ((model?.height ?? body.height) / body.height);
  return { circles: body.circles.map((c) => ({ along: c.along * k, radius: c.radius * k })), pivot: body.pivot * k };
}

/** Distance from (px, py) to the edge of the nearest body circle, negative inside one; Infinity without a body. */
export function bodyGap(body: SizedBody | null, x: number, y: number, facing: number, px: number, py: number): number {
  if (!body) return Infinity;
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  let best = Infinity;
  for (const c of body.circles) {
    const gap = Math.hypot(px - (x + fx * c.along), py - (y + fy * c.along)) - c.radius;
    if (gap < best) best = gap;
  }
  return best;
}

/** The hurt circle (collider or body) nearest to (px, py), written into `out`. */
export function nearestHurt(body: SizedBody | null, x: number, y: number, r: number, facing: number, px: number, py: number, out: { x: number; y: number; r: number }): { x: number; y: number; r: number } {
  out.x = x;
  out.y = y;
  out.r = r;
  if (!body) return out;
  let best = Math.hypot(px - x, py - y) - r;
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  for (const c of body.circles) {
    const cx = x + fx * c.along;
    const cy = y + fy * c.along;
    const gap = Math.hypot(px - cx, py - cy) - c.radius;
    if (gap < best) {
      best = gap;
      out.x = cx;
      out.y = cy;
      out.r = c.radius;
    }
  }
  return out;
}

/** Whether a circle of radius `reach` at (px, py) touches the collider at (x, y) of radius r. */
export function withinCollider(x: number, y: number, r: number, px: number, py: number, reach: number): boolean {
  const dx = px - x;
  const dy = py - y;
  const d = r + reach;
  return dx * dx + dy * dy <= d * d;
}

/**
 * Whether a circle of radius `reach` at (px, py) touches the collider or the body. The collider
 * first: it is the whole answer for every type without a body, which never looks further.
 */
export function withinHurt(x: number, y: number, r: number, body: SizedBody | null, facing: number, px: number, py: number, reach: number): boolean {
  if (withinCollider(x, y, r, px, py, reach)) return true;
  return body !== null && bodyGap(body, x, y, facing, px, py) <= reach;
}

/** withinHurt for any target by id: enemies with their body, players and minions by their collider. */
export function withinHurtOf(sim: Simulation, id: EntityId, px: number, py: number, reach: number): boolean {
  const w = sim.world;
  const pos = w.position.get(id);
  if (!pos) return false;
  const e = w.enemy.get(id);
  return withinHurt(pos.x, pos.y, w.radius.get(id) ?? 0, e?.body ?? null, e?.facing ?? 0, px, py, reach);
}

/** Distance from a point to the edge of the target's nearest hurt circle. */
export function hurtGap(sim: Simulation, id: EntityId, px: number, py: number): number {
  const w = sim.world;
  const pos = w.position.get(id);
  if (!pos) return Infinity;
  const gap = Math.hypot(px - pos.x, py - pos.y) - (w.radius.get(id) ?? 0);
  const e = w.enemy.get(id);
  return e?.body ? Math.min(gap, bodyGap(e.body, pos.x, pos.y, e.facing, px, py)) : gap;
}
