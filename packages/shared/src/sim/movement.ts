import type { GameMap } from '../world/gamemap.js';
import type { WorldPlan } from '../world/worldPlan.js';
import { clampDir, type Vec2 } from './math.js';

/** Smaller than the smallest obstacle diameter plus the player radius. */
const MAX_SUBSTEP = 20;
/** Below this share of the intended step, the mover counts as stuck and tries a turned direction. */
const STUCK_FRACTION = 0.3;
const TURN = Math.PI / 4;

export interface DashState {
  vx: number;
  vy: number;
  ticksLeft: number;
}

/**
 * The gates a mover has not opened: what keeps a character out of the land behind a gate until it
 * has killed that gate's boss. Static per character between snapshots (the plan is the world's,
 * the list the character's own), so prediction and the server step alike.
 */
export interface GateSeal {
  readonly plan: WorldPlan;
  /** Gate ids this character has opened. */
  readonly opened: readonly string[];
}

/** Whether a step from one spot to the next crosses into land behind a gate the mover has not opened. */
export function sealBlocks(seal: GateSeal, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const to = seal.plan.gateAt(toX, toY);
  if (to === null || seal.opened.includes(to)) return false;
  // Already behind it (carried there by an admin, say): walking about, or back out, stays free.
  return seal.plan.gateAt(fromX, fromY) !== to;
}

export interface MoveState {
  x: number;
  y: number;
  dash: DashState | null;
}

/**
 * Own-player movement for one input tick. The client runs this exact function for prediction, so it
 * must depend only on the input, the dash state and static map geometry, never on other entities.
 * A dash overrides input movement until it runs out; obstacles stop it like they stop walking.
 */
export function stepPlayer(map: GameMap, state: MoveState, moveDir: Vec2, speed: number, dt: number, radius: number, seal: GateSeal | null = null): MoveState {
  let dx: number;
  let dy: number;
  let dash: DashState | null = null;
  if (state.dash && state.dash.ticksLeft > 0) {
    dx = state.dash.vx * dt;
    dy = state.dash.vy * dt;
    const left = state.dash.ticksLeft - 1;
    dash = left > 0 ? { vx: state.dash.vx, vy: state.dash.vy, ticksLeft: left } : null;
  } else {
    const dir = clampDir(moveDir.x, moveDir.y);
    const ground = map.speedAt(state.x, state.y);
    dx = dir.x * speed * ground * dt;
    dy = dir.y * speed * ground * dt;
  }
  let pos = moveThrough(map, { x: state.x, y: state.y }, dx, dy, radius, seal);
  const wanted = Math.hypot(dx, dy);
  // Walking straight into the middle of a round obstacle pushes back along the same line, so there
  // is nothing to slide along. Try the direction turned 45 degrees each way and keep the better one.
  if (wanted > 0 && Math.hypot(pos.x - state.x, pos.y - state.y) < wanted * STUCK_FRACTION) {
    let best = pos;
    let bestGain = Math.hypot(pos.x - state.x, pos.y - state.y);
    for (const turn of [TURN, -TURN]) {
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      const tryPos = moveThrough(map, { x: state.x, y: state.y }, dx * c - dy * sn, dx * sn + dy * c, radius, seal);
      const gain = Math.hypot(tryPos.x - state.x, tryPos.y - state.y);
      if (gain > bestGain + 0.01) {
        best = tryPos;
        bestGain = gain;
      }
    }
    pos = best;
  }
  return { x: pos.x, y: pos.y, dash };
}

/**
 * Sub-steps keep a fast dash from tunnelling through small rocks. A sub-step that would cross a seal
 * slides along it instead (each axis alone, the longer that stays out), or stops.
 */
function moveThrough(map: GameMap, from: Vec2, dx: number, dy: number, radius: number, seal: GateSeal | null): Vec2 {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MAX_SUBSTEP));
  const sx = dx / steps;
  const sy = dy / steps;
  let pos = from;
  for (let i = 0; i < steps; i++) {
    const next = map.resolveCircle({ x: pos.x + sx, y: pos.y + sy }, radius, 'move');
    if (!seal || !sealBlocks(seal, pos.x, pos.y, next.x, next.y)) {
      pos = next;
      continue;
    }
    let best = pos;
    let gain = 0;
    for (const [ax, ay] of [
      [sx, 0],
      [0, sy],
    ] as const) {
      const alt = map.resolveCircle({ x: pos.x + ax, y: pos.y + ay }, radius, 'move');
      const d = Math.hypot(alt.x - pos.x, alt.y - pos.y);
      if (d > gain && !sealBlocks(seal, pos.x, pos.y, alt.x, alt.y)) {
        best = alt;
        gain = d;
      }
    }
    pos = best;
  }
  return pos;
}
