import { SIM, STREAMING } from '../config/sim.js';
import { chestKey, reopenChests } from './chests.js';
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

/** Respawn by inactivity refills a chunk's ordinary packs and its bosses on separate timers. */
type RefillKind = 'packs' | 'bosses';
const KINDS: readonly RefillKind[] = ['packs', 'bosses'];

/** What a chunk spawned, so a refill can tell whether anything was killed and remove what is left. */
interface ChunkSpawn {
  packs: EntityId[];
  bosses: EntityId[];
  /** How many times each kind has refilled: the respawn number in its random stream. */
  respawns: Record<RefillKind, number>;
}

/** A chunk waiting out the respawn time after everyone left its wake range. */
interface Pending {
  chunk: number;
  /** The chunk's `lastNear` when it was queued; anything else by the time it is due means someone came back. */
  since: number;
  /** Ordering tick: due once `tick - key` reaches the respawn time. Equals `since` but for a retry. */
  key: number;
}

/** A binary min-heap on `key`, at most one entry per chunk, so popping the due ones never scans the rest. */
interface RefillQueue {
  heap: Pending[];
  queued: Uint8Array;
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
  /** Tick of the last recompute that found each chunk within someone's wake range; -1 for never. */
  lastNear: Float64Array;
  /** Chunks within someone's wake range at the last recompute. */
  near: number[];
  chunkSpawns: Map<number, ChunkSpawn>;
  queues: Record<RefillKind, RefillQueue>;
  respawnTicks: Record<RefillKind, number>;
  /** Chest keys by chunk, built on first use. */
  chestsByChunk: Map<number, string[]> | null;
}

const states = new WeakMap<Simulation, StreamState>();
const NONE: ReadonlySet<EntityId> = new Set();

function minutesToTicks(minutes: number): number {
  return Math.round(minutes * 60 * SIM.tickRate);
}

/** The admin's respawn times, in minutes of game time (ticks run only while someone is in the room). */
export function setRespawnTimes(sim: Simulation, times: { respawnMinutes: number; bossRespawnMinutes: number }): void {
  const s = state(sim);
  s.respawnTicks = { packs: minutesToTicks(times.respawnMinutes), bosses: minutesToTicks(times.bossRespawnMinutes) };
}

/**
 * The respawn times now in force, in ticks. Gate bosses, which spawn outside the chunk packs, read
 * `bosses` here so one admin setting rules every boss.
 */
export function respawnTicks(sim: Simulation): Readonly<Record<RefillKind, number>> {
  return state(sim).respawnTicks;
}

/** The monsters the chunk holding a point spawned last, and how often it refilled; null before it first spawned. For tests and tools. */
export function chunkSpawnAt(sim: Simulation, x: number, y: number): { packs: readonly EntityId[]; bosses: readonly EntityId[]; respawns: Readonly<Record<RefillKind, number>> } | null {
  const s = state(sim);
  return s.chunkSpawns.get(chunkIndex(s, x, y)) ?? null;
}

function state(sim: Simulation): StreamState {
  let s = states.get(sim);
  if (!s) {
    const cols = Math.max(1, Math.ceil(sim.map.width / STREAMING.chunkSize));
    const rows = Math.max(1, Math.ceil(sim.map.height / STREAMING.chunkSize));
    const spawned = sim.zone ? new Uint8Array(cols * rows) : null;
    const n = cols * rows;
    const queue = (): RefillQueue => ({ heap: [], queued: new Uint8Array(n) });
    s = {
      enabled: true,
      cols,
      rows,
      awake: new Uint8Array(n).fill(1),
      sleeping: new Set(),
      anchors: new Map(),
      lastRecompute: -Infinity,
      spawned,
      lastNear: new Float64Array(n).fill(-1),
      near: [],
      chunkSpawns: new Map(),
      queues: { packs: queue(), bosses: queue() },
      respawnTicks: { packs: minutesToTicks(STREAMING.respawnMinutes), bosses: minutesToTicks(STREAMING.bossRespawnMinutes) },
      chestsByChunk: null,
    };
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
  const tick = sim.tick;
  const wasNear = s.near;
  s.near = [];
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
        if (dx * dx + dy * dy > reach * reach) continue;
        const i = cy * s.cols + cx;
        s.awake[i] = 1;
        if (s.lastNear[i] !== tick) {
          s.lastNear[i] = tick;
          s.near.push(i);
        }
      }
    }
  });
  if (s.spawned) {
    for (const i of wasNear) if (s.lastNear[i] !== tick) queueLeaver(s, i);
    refill(sim, s);
  }
  // An empty simulation is never ticked by the server; keeping it awake leaves tests and tools that
  // run monsters without players exactly as they were.
  if (s.anchors.size === 0) {
    s.awake.fill(1);
    return;
  }
  // Only around players: with nobody there, "everything awake" would build and spawn the whole zone.
  wakeChunks(sim, s);
  if (!s.enabled) {
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
      // One stream across the chunk's packs, in order, as before respawning; pack by pack only to tell bosses apart.
      const rng = Rng.stream(sim.seed, `packs:${cx},${cy}`);
      const c: ChunkSpawn = { packs: [], bosses: [], respawns: { packs: 0, bosses: 0 } };
      for (const pack of zone.packs(cx, cy)) (pack.boss ? c.bosses : c.packs).push(...spawnPackList(sim, [pack], rng));
      s.chunkSpawns.set(i, c);
    }
  }
}

/*
 * Respawn by inactivity (docs/features/world-map.md): a chunk refills once no player or minion has
 * been within its wake range (the awake distance, 2000 units, well past anyone's view) for the
 * respawn time, bosses on a longer timer. A refill removes what is left of that kind in the chunk
 * and spawns the chunk's packs of that kind again from a stream that counts refills, so it comes out
 * the same on every run. Only chunks that someone left are queued, at the recompute they left, so
 * nothing walks every chunk.
 */

function heapPush(q: RefillQueue, p: Pending): void {
  const h = q.heap;
  h.push(p);
  q.queued[p.chunk] = 1;
  let i = h.length - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    const a = h[up];
    if (!a || a.key <= p.key) break;
    h[i] = a;
    i = up;
  }
  h[i] = p;
}

function heapPop(q: RefillQueue): Pending | undefined {
  const h = q.heap;
  const top = h[0];
  const last = h.pop();
  if (!top || !last) return undefined;
  q.queued[top.chunk] = 0;
  if (h.length === 0) return top;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let m = i;
    let mKey = last.key;
    const hl = h[l];
    const hr = h[r];
    if (hl && hl.key < mKey) {
      m = l;
      mKey = hl.key;
    }
    if (hr && hr.key < mKey) m = r;
    if (m === i) break;
    const child = h[m];
    if (!child) break;
    h[i] = child;
    i = m;
  }
  h[i] = last;
  return top;
}

function queueLeaver(s: StreamState, chunk: number): void {
  const c = s.chunkSpawns.get(chunk);
  if (!c) return;
  const since = s.lastNear[chunk] ?? -1;
  for (const kind of KINDS) {
    const q = s.queues[kind];
    // A chunk already queued keeps its older entry, which is found stale when due and queued again from here.
    if (q.queued[chunk] === 1 || (kind === 'bosses' && c.bosses.length === 0)) continue;
    heapPush(q, { chunk, since, key: since });
  }
}

function refill(sim: Simulation, s: StreamState): void {
  const tick = sim.tick;
  for (const kind of KINDS) {
    const q = s.queues[kind];
    const delay = s.respawnTicks[kind];
    for (let top = q.heap[0]; top && tick - top.key >= delay; top = q.heap[0]) {
      heapPop(q);
      const last = s.lastNear[top.chunk] ?? -1;
      if (last === tick) continue;
      // Someone came back after it was queued, and left again: the wait runs from then.
      if (last !== top.since) heapPush(q, { chunk: top.chunk, since: last, key: last });
      else if (!refillChunk(sim, s, kind, top.chunk)) heapPush(q, { chunk: top.chunk, since: top.since, key: tick + STREAMING.respawnRetryTicks - delay });
    }
  }
}

function chestsIn(sim: Simulation, s: StreamState, chunk: number): readonly string[] {
  if (!s.chestsByChunk) {
    s.chestsByChunk = new Map();
    for (const c of sim.mapDef.chests ?? []) {
      const i = chunkIndex(s, c.x, c.y);
      const list = s.chestsByChunk.get(i) ?? [];
      list.push(chestKey(c));
      s.chestsByChunk.set(i, list);
    }
  }
  return s.chestsByChunk.get(chunk) ?? [];
}

/** Refills one kind in a chunk, or returns false to try again soon. */
function refillChunk(sim: Simulation, s: StreamState, kind: RefillKind, chunk: number): boolean {
  const zone = sim.zone;
  const c = s.chunkSpawns.get(chunk);
  if (!zone || !c) return true;
  const w = sim.world;
  if (kind === 'packs') reopenChests(sim, chestsIn(sim, s, chunk));
  const ids = c[kind];
  if (ids.every((id) => w.isAlive(id))) return true;
  // A survivor chasing someone, or standing in someone's wake range after a chase, holds the refill up:
  // it would vanish where it might be seen.
  for (const id of ids) {
    if (!w.isAlive(id)) continue;
    const e = w.enemy.get(id);
    const p = w.position.get(id);
    if (!e || !p || !canSleep(e) || s.lastNear[chunkIndex(s, p.x, p.y)] === sim.tick) return false;
  }
  for (const id of ids) if (w.isAlive(id)) w.destroy(id);
  const n = ++c.respawns[kind];
  const cx = chunk % s.cols;
  const cy = Math.floor(chunk / s.cols);
  const packs = zone.packs(cx, cy).filter((p) => p.boss === (kind === 'bosses'));
  c[kind] = spawnPackList(sim, packs, Rng.stream(sim.seed, `${kind}:${cx},${cy}:${n}`));
  return true;
}

/** Marks every chunk's packs as spawned without spawning them: the dev tools' "kill all" clears the zone. */
export function forgoUnspawnedPacks(sim: Simulation): void {
  state(sim).spawned?.fill(1);
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
