import type { GameMap } from '../world/gamemap.js';
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
export function stepPlayer(map: GameMap, state: MoveState, moveDir: Vec2, speed: number, dt: number, radius: number): MoveState {
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
  let pos = moveThrough(map, { x: state.x, y: state.y }, dx, dy, radius);
  const wanted = Math.hypot(dx, dy);
  // Walking straight into the middle of a round obstacle pushes back along the same line, so there
  // is nothing to slide along. Try the direction turned 45 degrees each way and keep the better one.
  if (wanted > 0 && Math.hypot(pos.x - state.x, pos.y - state.y) < wanted * STUCK_FRACTION) {
    let best = pos;
    let bestGain = Math.hypot(pos.x - state.x, pos.y - state.y);
    for (const turn of [TURN, -TURN]) {
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      const tryPos = moveThrough(map, { x: state.x, y: state.y }, dx * c - dy * sn, dx * sn + dy * c, radius);
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

/** Sub-steps keep a fast dash from tunnelling through small rocks. */
function moveThrough(map: GameMap, from: Vec2, dx: number, dy: number, radius: number): Vec2 {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MAX_SUBSTEP));
  let pos = from;
  for (let i = 0; i < steps; i++) pos = map.resolveCircle({ x: pos.x + dx / steps, y: pos.y + dy / steps }, radius, 'move');
  return pos;
}
