import { STREAMING } from '../config/sim.js';
import type { EnemyComp, EntityId } from './ecs.js';
import { clamp } from './math.js';
import { spawnPackList } from './enemies.js';
import { Rng } from './rng.js';
import type { Simulation } from './simulation.js';

/**
 * World streaming, step 1: monsters far from every player sleep, so a room's cost follows where its
 * players are instead of the zone's area. The map is cut into square chunks; a chunk is awake while
 * a player (alive or waiting to respawn) or a minion is near it, and an idle monster in any other
 * chunk is skipped by the monster systems. Nothing about a sleeping monster changes, so it resumes
 * exactly where it stopped.
 *
 * Only idle monsters sleep. One that is aggroed, mid-action, pinned or still sliding from a
 * knockback stays awake wherever it is, so a chase or a walk home can lead out of the awake area
 * without freezing halfway. Anything that hits a sleeping monster aggroes it (`dealDamage` calls
 * `alertPack`), which wakes it on the same tick.
 *
 * The state lives beside the simulation, like the monster state in enemies.ts, so the ECS and the
 * Simulation class need nothing new.
 */

interface Anchor {
  x: number;
  y: number;
}

interface StreamState {
  enabled: boolean;
  cols: number;
  rows: number;
  /** 1 per awake chunk, row-major. */
  awake: Uint8Array;
  sleeping: Set<EntityId>;
  /** Where each player and minion stood at the last recompute. */
  anchors: Map<EntityId, Anchor>;
  lastRecompute: number;
  /** 1 per chunk of a generated zone whose packs have spawned; null on a map built whole. */
  spawned: Uint8Array | null;
}

const states = new WeakMap<Simulation, StreamState>();
const NONE: ReadonlySet<EntityId> = new Set();

function state(sim: Simulation): StreamState {
  let s = states.get(sim);
  if (!s) {
    const cols = Math.max(1, Math.ceil(sim.map.width / STREAMING.chunkSize));
    const rows = Math.max(1, Math.ceil(sim.map.height / STREAMING.chunkSize));
    const spawned = sim.zone ? new Uint8Array(cols * rows) : null;
    s = { enabled: true, cols, rows, awake: new Uint8Array(cols * rows).fill(1), sleeping: new Set(), anchors: new Map(), lastRecompute: -Infinity, spawned };
    states.set(sim, s);
  }
  return s;
}

/**
 * Turns sleep off (every monster runs every tick, as before streaming) or back on. For tests and the
 * bench. Packs of a generated zone still spawn chunk by chunk as players come near either way, so
 * a run with sleep and one without see the same monsters.
 */
export function setStreaming(sim: Simulation, enabled: boolean): void {
  const s = state(sim);
  s.enabled = enabled;
  s.sleeping.clear();
  s.awake.fill(1);
  s.anchors.clear();
  s.lastRecompute = -Infinity;
}

/**
 * Monsters that were idle outside every awake chunk at the last recompute. A monster in this set is
 * asleep only while it is still idle: callers check `isAsleep`, so an aggro between recomputes wakes it
 * at once.
 */
export function sleepingEnemies(sim: Simulation): ReadonlySet<EntityId> {
  return states.get(sim)?.sleeping ?? NONE;
}

export function isAsleep(asleep: ReadonlySet<EntityId>, id: EntityId, e: EnemyComp): boolean {
  return !e.aggro && asleep.has(id);
}

function chunkIndex(s: StreamState, x: number, y: number): number {
  const cx = clamp(Math.floor(x / STREAMING.chunkSize), 0, s.cols - 1);
  const cy = clamp(Math.floor(y / STREAMING.chunkSize), 0, s.rows - 1);
  return cy * s.cols + cx;
}

/** Whether the chunk holding a point is awake. Every chunk is awake with streaming off or before the first recompute. */
export function chunkAwake(sim: Simulation, x: number, y: number): boolean {
  const s = state(sim);
  return s.awake[chunkIndex(s, x, y)] === 1;
}

export function streamingStats(sim: Simulation): { enabled: boolean; chunks: number; awakeChunks: number; asleep: number; spawnedChunks: number } {
  const s = state(sim);
  let awakeChunks = 0;
  for (const a of s.awake) awakeChunks += a;
  let spawnedChunks = 0;
  for (const a of s.spawned ?? []) spawnedChunks += a;
  let asleep = 0;
  for (const id of s.sleeping) {
    const e = sim.world.enemy.get(id);
    if (e && sim.world.isAlive(id) && isAsleep(s.sleeping, id, e)) asleep++;
  }
  return { enabled: s.enabled, chunks: s.cols * s.rows, awakeChunks, asleep, spawnedChunks };
}

/** Everyone whose surroundings must stay live: every player, dead or alive, and every minion. */
function forAnchors(sim: Simulation, visit: (id: EntityId, x: number, y: number) => void): void {
  const w = sim.world;
  for (const id of w.player.keys()) {
    const p = w.position.get(id);
    if (p) visit(id, p.x, p.y);
  }
  for (const id of w.minion.keys()) {
    const p = w.position.get(id);
    if (p) visit(id, p.x, p.y);
  }
}

/** A recompute is due on the timer, or at once when someone arrives, leaves or jumps (a portal, a teleport). */
function due(sim: Simulation, s: StreamState): boolean {
  if (sim.tick - s.lastRecompute >= STREAMING.recomputeEveryTicks) return true;
  let count = 0;
  let moved = false;
  const jump2 = STREAMING.jumpDistance * STREAMING.jumpDistance;
  forAnchors(sim, (id, x, y) => {
    count++;
    const a = s.anchors.get(id);
    if (!a || (x - a.x) ** 2 + (y - a.y) ** 2 > jump2) moved = true;
  });
  return moved || count !== s.anchors.size;
}

/** Idle and settled: nothing in its own state would move it this tick. */
function canSleep(e: EnemyComp): boolean {
  return !e.aggro && e.cast === null && e.dash === null && e.leap === null && e.pinned <= 0 && Math.abs(e.knockX) < 0.5 && Math.abs(e.knockY) < 0.5;
}

function recompute(sim: Simulation, s: StreamState): void {
  const w = sim.world;
  const size = STREAMING.chunkSize;
  const reach = STREAMING.awakeChunks * size;
  s.awake.fill(0);
  s.anchors.clear();
  s.sleeping.clear();
  s.lastRecompute = sim.tick;
  forAnchors(sim, (id, x, y) => {
    s.anchors.set(id, { x, y });
    const cx0 = clamp(Math.floor((x - reach) / size), 0, s.cols - 1);
    const cx1 = clamp(Math.floor((x + reach) / size), 0, s.cols - 1);
    const cy0 = clamp(Math.floor((y - reach) / size), 0, s.rows - 1);
    const cy1 = clamp(Math.floor((y + reach) / size), 0, s.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // Distance from the anchor to the chunk's nearest point, so the awake area is round, not square.
        const dx = Math.max(cx * size - x, 0, x - (cx + 1) * size);
        const dy = Math.max(cy * size - y, 0, y - (cy + 1) * size);
        if (dx * dx + dy * dy <= reach * reach) s.awake[cy * s.cols + cx] = 1;
      }
    }
  });
  // An empty simulation is never ticked by the server; keeping it awake leaves tests and tools that
  // run monsters without players exactly as they were.
  if (s.anchors.size === 0) s.awake.fill(1);
  wakeChunks(sim, s);
  if (s.anchors.size === 0 || !s.enabled) {
    s.awake.fill(1);
    return;
  }
  for (const [id, e] of w.enemy) {
    const p = w.position.get(id);
    if (p && canSleep(e) && s.awake[chunkIndex(s, p.x, p.y)] === 0) s.sleeping.add(id);
  }
}

/**
 * World streaming step 3: the first time a chunk of a generated zone is awake, its static content is
 * built (`GameMap.ensureChunk`) and its packs spawn, idle, from the chunk's own random stream. A chunk
 * wakes 2000 units out, well past what any player sees, so a pack is never seen appearing, and it
 * comes out the same whenever that happens, as if it had stood there asleep since the room opened.
 */
function wakeChunks(sim: Simulation, s: StreamState): void {
  const zone = sim.zone;
  const spawned = s.spawned;
  if (!zone || !spawned) return;
  for (let cy = 0; cy < s.rows; cy++) {
    for (let cx = 0; cx < s.cols; cx++) {
      const i = cy * s.cols + cx;
      if (s.awake[i] !== 1 || spawned[i] === 1) continue;
      spawned[i] = 1;
      sim.map.ensureChunk(cx, cy);
      spawnPackList(sim, zone.packs(cx, cy), Rng.stream(sim.seed, `packs:${cx},${cy}`));
    }
  }
}

/** Spawns every chunk's packs now, as a room built whole would have. For tests and the bench. */
export function spawnEverywhere(sim: Simulation): void {
  const s = state(sim);
  const saved = s.awake;
  s.awake = new Uint8Array(saved.length).fill(1);
  wakeChunks(sim, s);
  s.awake = saved;
}

/** Runs after input and `updatePlayers` (portals, respawns), before the monsters, so this tick's positions decide who sleeps. */
export function updateStreaming(sim: Simulation): void {
  const s = state(sim);
  if (!due(sim, s)) return;
  recompute(sim, s);
}
