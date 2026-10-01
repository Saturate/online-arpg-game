import { HOUND_PACK, MINIONS, NAV, SIM } from '../config/sim.js';
import type { Ability } from '../data/enemies.js';
import type { MinionDef } from '../data/minions.js';
import { MIN_PROJECTILE_SPEED } from '../data/tuning.js';
import { affixValue, behaviourOf, vesselPackmates, type VesselItem } from '../items/items.js';
import { applyPoison, dealDamage, healEntity, isTargetable } from './combat.js';
import { emptyBuffs, emptyStatus, type EntityId, type MinionComp, type PackRole, type PlayerComp } from './ecs.js';
import { knockbackImmune } from './enemies.js';
import { distSq, type Vec2 } from './math.js';
import { findNavPath, type SearchStats } from './minionPath.js';
import type { Simulation } from './simulation.js';
import { spawnProjectile } from './spells.js';

const TAUNT_PULSE_SECONDS = 1;
const ARRIVE_DISTANCE = 12;
/** The first howl comes soon after the pack engages, then on its cooldown. */
const FIRST_HOWL_SECONDS = 1.5;
/**
 * A step shorter than this share of a tick's full stride does not turn a minion: arriving at a goal
 * and wall resolution leave sub-unit nudges that would spin it on the spot.
 */
const TURN_STEP_SHARE = 0.25;
/** Slack past strike reach within which a minion already looks at its target while closing in. */
const FACE_TARGET_SLACK = 8;
/**
 * Stuck recovery while following. A minion counts as making progress when it moves this far from
 * where the current window began, or gets this much closer to its master. A minion idle in
 * formation also stops making progress, which is why the teleport also needs the master out of sight.
 */
const STUCK_MOVE = 40;
const STUCK_CLOSER = 16;
/** About 0.75 s without progress on the trail and the minion asks the nav grid instead. */
const PATH_AFTER_STUCK_TICKS = 15;
/** About 2 s without progress and out of sight of the master: pulled over, as at 700 units. */
const STUCK_TELEPORT_TICKS = 40;
/** A* budget in nav cells; the town's gate detours need a few hundred. */
const PATH_EXPAND = 2500;
/** At most one search per minion this often; a failed one waits too. */
const PATH_REPLAN_TICKS = 10;
/** A route is planned again when this old, or when its goal has drifted this many cells. */
const PATH_STALE_TICKS = 40;
const PATH_GOAL_DRIFT_CELLS = 3;
/**
 * Searches over every minion in one tick. A search that fails at PATH_EXPAND costs about 0.7 ms, so
 * a warband of hounds cut off at once could spend many milliseconds in one tick; with these limits a
 * tick expands at most 5000 cells (two failed searches, or three short ones) and the rest wait in
 * line for the next ticks.
 */
const PATH_SEARCHES_PER_TICK = 3;
const PATH_CELLS_PER_TICK = 5000;
/** A route planned moments ago from this close by, in sight, toward about the same goal is reused rather than searched again. */
const PATH_SHARE_START = 80;
/** A waypoint this close counts as reached. */
const WAYPOINT_REACHED = 12;
/** How far along a route a minion looks for the furthest waypoint it can walk to straight. */
const PATH_LOOKAHEAD = 6;
/** Behind the master and to either side: where a pulled-over minion is put down, first open spot in sight wins. */
const BESIDE_ANGLES = [0, 0.8, -0.8, 1.6, -1.6, Math.PI] as const;
const BESIDE_DISTANCE = 40;

type LeapAbility = Extract<Ability, { kind: 'leap' }>;

function leapOf(def: MinionDef): LeapAbility | null {
  for (const a of def.abilities ?? []) if (a.kind === 'leap') return a;
  return null;
}

function vesselIn(p: PlayerComp, slot: number): VesselItem | null {
  const uid = p.warband[slot];
  const item = uid === null || uid === undefined ? undefined : p.items.get(uid);
  return item?.kind === 'vessel' ? item : null;
}

/**
 * Packmates each pack vessel may field, by warband slot. Every Leader always counts; the packmates
 * share what is left of HOUND_PACK.maxDogs in warband order, so the cap holds however many pack
 * vessels are bound.
 */
export function packmateCounts(p: PlayerComp): number[] {
  const out = new Array<number>(p.warband.length).fill(0);
  const packs: { slot: number; want: number }[] = [];
  for (let slot = 0; slot < p.warband.length; slot++) {
    const item = vesselIn(p, slot);
    if (item && vesselPackmates(item) > 0) packs.push({ slot, want: vesselPackmates(item) });
  }
  let budget = HOUND_PACK.maxDogs - packs.length;
  for (const { slot, want } of packs) {
    const n = Math.max(0, Math.min(want, budget));
    out[slot] = n;
    budget -= n;
  }
  return out;
}

/** Pack vessels bound: each one's Leader is a dog, so more than maxDogs of them cannot all field one. */
export function packVesselCount(p: PlayerComp): number {
  let n = 0;
  for (let slot = 0; slot < p.warband.length; slot++) {
    const item = vesselIn(p, slot);
    if (item && vesselPackmates(item) > 0) n++;
  }
  return n;
}

/**
 * The open spot nearest `at`, unless it is on the far side of a wall or fence from `anchor`, where a
 * minion would start cut off from its master; then the open spot at the anchor itself.
 */
function openInSight(sim: Simulation, anchor: Vec2, at: Vec2, radius: number): Vec2 {
  const p = sim.map.findOpen(at.x, at.y, radius);
  if (sim.map.lineClear(anchor.x, anchor.y, p.x, p.y, radius * 0.8, 'move')) return p;
  return sim.map.findOpen(anchor.x, anchor.y, radius);
}

/** Where a pulled-over minion lands: behind or beside the master, on the master's side of any fence. */
function besideMaster(sim: Simulation, owner: PlayerComp, opos: Vec2, radius: number): Vec2 {
  const back = owner.heading + Math.PI;
  for (const off of BESIDE_ANGLES) {
    const a = back + off;
    const p = sim.map.findOpen(opos.x + Math.cos(a) * BESIDE_DISTANCE, opos.y + Math.sin(a) * BESIDE_DISTANCE, radius);
    if (sim.map.lineClear(opos.x, opos.y, p.x, p.y, radius * 0.8, 'move')) return p;
  }
  return sim.map.findOpen(opos.x, opos.y, radius);
}

function createMinion(sim: Simulation, ownerId: EntityId, slot: number, item: VesselItem, role: PackRole | null, at: Vec2, anchor: Vec2): EntityId | null {
  const w = sim.world;
  const owner = w.player.get(ownerId);
  if (!owner) return null;
  const def = sim.tuning.minion(item.minion);
  const levelMult = 1 + MINIONS.levelScaling * (item.level - 1);
  // Packmates split the strength of one hound between them (see HOUND_PACK), the Leader is a big one.
  const share = role?.role === 'mate' ? HOUND_PACK.mate.share / Math.sqrt(Math.max(1, vesselPackmates(item))) : 1;
  const lifeRole = role?.role === 'leader' ? HOUND_PACK.leader.lifeMult : share;
  const damageRole = role?.role === 'leader' ? HOUND_PACK.leader.damageMult : share;
  const radius = role?.role === 'leader' ? def.radius * HOUND_PACK.leader.radiusScale : role?.role === 'mate' ? def.radius * HOUND_PACK.mate.radiusScale : def.radius;
  const quicker = role?.role === 'mate' ? HOUND_PACK.mate.attackSpeedMult : 1;
  const life = Math.max(1, Math.round(def.life * MINIONS.lifeMultiplier * levelMult * (1 + affixValue(item.affixes, 'armored') / 100) * owner.stats.minionLifeMult * lifeRole));
  const damageMult = MINIONS.damageMultiplier * levelMult * owner.stats.minionDamageMult * damageRole;
  const leap = role?.role === 'leader' ? leapOf(def) : null;

  const id = w.create('minion');
  w.position.set(id, openInSight(sim, anchor, at, radius));
  w.radius.set(id, radius);
  w.health.set(id, { life, maxLife: life });
  w.team.set(id, 'players');
  w.status.set(id, emptyStatus());
  w.buffs.set(id, emptyBuffs());
  w.minion.set(id, {
    ownerId,
    slot,
    typeId: item.minion,
    def,
    affixes: item.affixes,
    behaviour: behaviourOf(item.affixes),
    state: 'follow',
    targetId: null,
    attackCooldown: 0,
    attackCooldownBase: def.attackCooldown / (1 + affixValue(item.affixes, 'attack_speed') / 100) / quicker,
    damage: def.damage * damageMult,
    moveSpeed: def.moveSpeed * (1 + affixValue(item.affixes, 'hasted') / 100) * (role?.role === 'mate' ? HOUND_PACK.mate.speedMult : 1),
    tauntTimer: 0,
    lostSightTicks: 0,
    pack: role,
    leapCooldown: leap ? leap.cooldown * 0.5 : 0,
    leap: null,
    leapDamage: leap ? leap.damage * damageMult : 0,
    howlCooldown: FIRST_HOWL_SECONDS,
    howled: 0,
    facing: owner.heading,
    standingDown: owner.respawnIn !== null,
    stuck: { x: 0, y: 0, ownerDist: Infinity, ticks: 0 },
    path: [],
    pathGoal: -1,
    pathTick: -PATH_REPLAN_TICKS,
  });
  return id;
}

/** Brings a pack up to `mates` live packmates, appearing around the Leader. */
function fillPack(sim: Simulation, ownerId: EntityId, slot: number, mates: number): void {
  const w = sim.world;
  const owner = w.player.get(ownerId);
  const item = owner ? vesselIn(owner, slot) : null;
  const leaderId = owner?.minions[slot];
  const lpos = leaderId === null || leaderId === undefined ? undefined : w.position.get(leaderId);
  const pack = owner?.packs[slot];
  if (!owner || !item || !lpos || !pack) return;
  const used = new Set(pack.mates.map((id) => w.minion.get(id)?.pack?.index ?? -1));
  for (let index = 0; pack.mates.length < mates && index < HOUND_PACK.flankAngles.length; index++) {
    if (used.has(index)) continue;
    const a = (Math.PI * 2 * index) / HOUND_PACK.flankAngles.length;
    const id = createMinion(sim, ownerId, slot, item, { role: 'mate', index }, { x: lpos.x + Math.cos(a) * 36, y: lpos.y + Math.sin(a) * 36 }, lpos);
    if (id !== null) pack.mates.push(id);
  }
}

export function spawnMinion(sim: Simulation, ownerId: EntityId, slot: number): EntityId | null {
  const w = sim.world;
  const owner = w.player.get(ownerId);
  const opos = w.position.get(ownerId);
  if (!owner || !opos) return null;
  const item = vesselIn(owner, slot);
  if (!item) return null;
  const a = (Math.PI * 2 * slot) / MINIONS.warbandSlots;
  const at = { x: opos.x + Math.cos(a) * MINIONS.spawnOffset, y: opos.y + Math.sin(a) * MINIONS.spawnOffset };
  const pack = vesselPackmates(item) > 0;
  const id = createMinion(sim, ownerId, slot, item, pack ? { role: 'leader', index: 0 } : null, at, opos);
  if (id === null) return null;
  owner.minions[slot] = id;
  // Dead packmates come back with their Leader.
  const state = owner.packs[slot];
  if (pack && state) {
    state.down = [];
    fillPack(sim, ownerId, slot, packmateCounts(owner)[slot] ?? 0);
  }
  return id;
}

export function despawnMinion(sim: Simulation, ownerId: EntityId, slot: number): void {
  const owner = sim.world.player.get(ownerId);
  if (!owner) return;
  const pack = owner.packs[slot];
  if (pack) {
    for (const mate of pack.mates) sim.world.destroy(mate);
    pack.mates = [];
    pack.down = [];
  }
  const mid = owner.minions[slot];
  if (mid === null || mid === undefined) return;
  sim.world.destroy(mid);
  owner.minions[slot] = null;
}

/**
 * Arena deaths last until the run ends, so there the warband leaves with its master rather than
 * standing down for the rest of the run. Only the live minions go; the vessels stay bound, and the
 * timers are cleared so the warband would be back at once if the master stood up in this room.
 * Removed, not killed: no death event, no explosion, nothing for the pack's dead list.
 */
export function desummonWarband(sim: Simulation, ownerId: EntityId): void {
  const owner = sim.world.player.get(ownerId);
  if (!owner) return;
  for (let slot = 0; slot < owner.minions.length; slot++) {
    despawnMinion(sim, ownerId, slot);
    owner.minionRespawn[slot] = 0;
  }
}

export function updateMinionRespawns(sim: Simulation, dt: number): void {
  for (const [pid, p] of sim.world.player) {
    // A fallen Arena member's warband stays away until the run ends (see desummonWarband).
    if (sim.arena && p.respawnIn !== null) continue;
    let counts: number[] | null = null;
    for (let slot = 0; slot < p.warband.length; slot++) {
      const pack = p.packs[slot];
      const item = vesselIn(p, slot);
      if (pack && ((item !== null && vesselPackmates(item) > 0) || pack.mates.length > 0 || pack.down.length > 0)) {
        counts ??= packmateCounts(p);
        trimPack(sim, p, pid, slot, counts[slot] ?? 0);
      }
      if (p.warband[slot] === null || p.minions[slot] !== null) continue;
      const left = (p.minionRespawn[slot] ?? 0) - dt;
      p.minionRespawn[slot] = left;
      if (left <= 0) {
        p.minionRespawn[slot] = 0;
        spawnMinion(sim, pid, slot);
      }
    }
  }
}

/**
 * Keeps a pack within its share of the dog cap after the warband changes: extra packmates go, and
 * with its Leader alive a pack whose share grew fills up at once.
 */
function trimPack(sim: Simulation, p: PlayerComp, pid: EntityId, slot: number, allowed: number): void {
  const pack = p.packs[slot];
  if (!pack) return;
  while (pack.mates.length > allowed) {
    const id = pack.mates.pop();
    if (id !== undefined) sim.world.destroy(id);
  }
  if (pack.mates.length + pack.down.length > allowed) pack.down.length = Math.max(0, allowed - pack.mates.length);
  const leader = p.minions[slot];
  if (leader !== null && leader !== undefined && pack.mates.length + pack.down.length < allowed) fillPack(sim, pid, slot, allowed - pack.down.length);
}

/** A dead packmate was killed; it waits for its Leader to come back or to howl it back. */
export function onPackmateDeath(sim: Simulation, m: MinionComp, id: EntityId): void {
  const pack = sim.world.player.get(m.ownerId)?.packs[m.slot];
  if (!pack) return;
  const at = pack.mates.indexOf(id);
  if (at < 0) return;
  pack.mates.splice(at, 1);
  pack.down.push(sim.tick);
}

/** The Leader fell: its packmates lose the howl until it is back. */
export function onPackLeaderDeath(sim: Simulation, m: MinionComp): void {
  const pack = sim.world.player.get(m.ownerId)?.packs[m.slot];
  if (!pack) return;
  for (const id of pack.mates) {
    const mate = sim.world.minion.get(id);
    if (mate) mate.howled = 0;
  }
}

interface EngageRules {
  radius: number;
  leash: number;
  /** Engage radius is measured from the owner (defensive, bodyguard) or from the minion itself. */
  fromOwner: boolean;
}

function engageRules(sim: Simulation, m: MinionComp): EngageRules | null {
  const owner = sim.world.player.get(m.ownerId);
  const stance = owner?.stance ?? 'aggressive';
  if (stance === 'follow') return null;
  if (m.behaviour === 'bodyguard') {
    return { radius: MINIONS.bodyguardDistance * 3, leash: MINIONS.bodyguardDistance * 4, fromOwner: true };
  }
  const defaultHunt = m.def.defaultBehaviour === 'hunt';
  const mult = m.behaviour === 'hunter' ? MINIONS.hunterEngageMultiplier : defaultHunt ? MINIONS.defaultHuntEngageMultiplier : 1;
  if (stance === 'defensive') {
    return { radius: MINIONS.defensiveEngageRadius * mult, leash: MINIONS.defensiveLeash * mult, fromOwner: true };
  }
  return { radius: MINIONS.aggressiveEngageRadius * mult, leash: MINIONS.aggressiveLeash * mult, fromOwner: false };
}

/**
 * Target choice: the master's current focus if it is in range and visible, otherwise the best enemy
 * in the engage radius. Hunters weight rares as much closer; everyone prefers what they can see.
 */
function findTarget(sim: Simulation, m: MinionComp, from: Vec2, center: Vec2, radius: number): EntityId | null {
  const w = sim.world;
  const owner = w.player.get(m.ownerId);
  const r2 = radius * radius;
  if (owner?.focusTarget !== null && owner?.focusTarget !== undefined && sim.tick - owner.focusTick < MINIONS.focusTicks) {
    const fp = w.position.get(owner.focusTarget);
    if (fp && w.isAlive(owner.focusTarget) && distSq(center.x, center.y, fp.x, fp.y) <= r2) return owner.focusTarget;
  }
  let best: EntityId | null = null;
  let bestScore = Infinity;
  for (const [eid, e, ep] of w.query(w.enemy, w.position)) {
    if (e.burrowed) continue;
    const d = distSq(center.x, center.y, ep.x, ep.y);
    if (d > r2) continue;
    let score = distSq(from.x, from.y, ep.x, ep.y);
    if (m.behaviour === 'hunter' && e.rare) score *= 0.1;
    if (!sim.map.lineClear(from.x, from.y, ep.x, ep.y, 6, 'move')) score *= 4;
    if (score < bestScore) {
      bestScore = score;
      best = eid;
    }
  }
  return best;
}

function stepToward(pos: Vec2, tx: number, ty: number, step: number, stopAt: number): void {
  const dx = tx - pos.x;
  const dy = ty - pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= stopAt || d === 0) return;
  const len = Math.min(step, d - stopAt);
  pos.x += (dx / d) * len;
  pos.y += (dy / d) * len;
}

/**
 * `stepToward` against the map, in steps no longer than the minion's radius. A Hound packmate
 * catching up moves about 24 units a tick (265 speed, x1.15 for a mate, x1.6 to catch up), more
 * than a fence's reach from its line (its radius 10 plus 8): one step from touching it could land
 * past the line, and settling then pushed it out the far side.
 */
function walkToward(sim: Simulation, pos: Vec2, tx: number, ty: number, step: number, stopAt: number, radius: number): void {
  const d = Math.hypot(tx - pos.x, ty - pos.y);
  const len = Math.min(step, d - stopAt);
  if (len <= 0) return;
  const n = Math.max(1, Math.ceil(len / Math.max(4, radius)));
  for (let i = 0; i < n; i++) {
    stepToward(pos, tx, ty, len / n, stopAt);
    if (n > 1) settle(sim, pos, radius);
  }
}

/**
 * Walks toward a goal around obstacles. With line of sight it goes straight; otherwise it follows
 * the master's breadcrumb trail, picking the newest crumb it can see, which is always a route the
 * master actually walked. With no crumb in sight (after a teleport, or spawned across a fence), or
 * when the trail has stopped getting it anywhere, it plans a route on the nav grid and keeps to it
 * until the goal is in sight.
 */
function navigate(sim: Simulation, id: EntityId, m: MinionComp, pos: Vec2, radius: number, goal: Vec2, trail: readonly Vec2[], step: number, stopAt: number): void {
  if (sim.map.lineClear(pos.x, pos.y, goal.x, goal.y, radius * 0.8, 'move')) {
    m.path.length = 0;
    budgets.get(sim)?.queue.delete(m);
    walkToward(sim, pos, goal.x, goal.y, step, stopAt, radius);
    return;
  }
  if (m.path.length > 0 && followPath(sim, id, m, pos, radius, goal, step, stopAt)) return;
  if (m.stuck.ticks < PATH_AFTER_STUCK_TICKS) {
    for (let i = trail.length - 1; i >= 0; i--) {
      const c = trail[i];
      if (c && sim.map.lineClear(pos.x, pos.y, c.x, c.y, radius * 0.8, 'move')) {
        walkToward(sim, pos, c.x, c.y, step, 4, radius);
        return;
      }
    }
  }
  if (planPath(sim, id, m, pos, radius, goal) && followPath(sim, id, m, pos, radius, goal, step, stopAt)) return;
  walkToward(sim, pos, goal.x, goal.y, step, stopAt, radius);
}

interface PathRequest {
  id: EntityId;
  from: Vec2;
  goal: Vec2;
}

/** A search from the last few ticks, successful or not, that nearby minions heading the same way reuse. */
interface SharedRoute {
  tick: number;
  from: Vec2;
  goalCell: number;
  path: readonly Vec2[];
}

interface PathBudget {
  tick: number;
  searches: number;
  cells: number;
  /** Minions waiting for a search, oldest first (a Map keeps insertion order, and a repeated ask keeps its place). */
  queue: Map<MinionComp, PathRequest>;
  shared: SharedRoute[];
  stats: SearchStats;
}

const budgets = new WeakMap<Simulation, PathBudget>();

function budgetFor(sim: Simulation): PathBudget {
  let b = budgets.get(sim);
  if (!b) {
    b = { tick: sim.tick, searches: 0, cells: 0, queue: new Map(), shared: [], stats: { expanded: 0 } };
    budgets.set(sim, b);
  }
  if (b.tick !== sim.tick) {
    b.tick = sim.tick;
    b.searches = 0;
    b.cells = 0;
    b.shared = b.shared.filter((r) => sim.tick - r.tick < PATH_REPLAN_TICKS);
  }
  return b;
}

/** Room for one more search this tick, at its full cap, inside both limits. */
function budgetRoom(b: PathBudget): boolean {
  return b.searches < PATH_SEARCHES_PER_TICK && b.cells + PATH_EXPAND <= PATH_CELLS_PER_TICK;
}

function sharedRoute(sim: Simulation, b: PathBudget, from: Vec2, radius: number, goalCell: number): SharedRoute | null {
  const cols = sim.map.navCols;
  for (const r of b.shared) {
    if (cellDrift(cols, goalCell, r.goalCell) > PATH_GOAL_DRIFT_CELLS) continue;
    if (distSq(from.x, from.y, r.from.x, r.from.y) > PATH_SHARE_START * PATH_SHARE_START) continue;
    if (sim.map.lineClear(from.x, from.y, r.from.x, r.from.y, radius * 0.8, 'move')) return r;
  }
  return null;
}

function takeRoute(sim: Simulation, m: MinionComp, route: readonly Vec2[], goalCell: number): void {
  m.pathTick = sim.tick;
  m.pathGoal = goalCell;
  // A copy: following a route shifts and splices it.
  m.path = [...route];
}

function search(sim: Simulation, b: PathBudget, m: MinionComp, from: Vec2, goal: Vec2): void {
  const goalCell = sim.map.navCell(goal.x, goal.y);
  const path = findNavPath(sim.map, from, goal, PATH_EXPAND, b.stats) ?? [];
  b.searches++;
  b.cells += b.stats.expanded;
  b.shared.push({ tick: sim.tick, from: { x: from.x, y: from.y }, goalCell, path });
  takeRoute(sim, m, path, goalCell);
}

/**
 * Plans a nav-grid route unless one was tried moments ago; returns whether the minion has a route.
 * Reuses a route a packmate just planned when it can; otherwise searches if this tick's budget has
 * room and nobody is waiting ahead of it, and joins the line if not (served at the end of the tick
 * or on later ticks by `drainPathQueue`).
 */
function planPath(sim: Simulation, id: EntityId, m: MinionComp, pos: Vec2, radius: number, goal: Vec2): boolean {
  if (sim.tick - m.pathTick < PATH_REPLAN_TICKS) return m.path.length > 0;
  const b = budgetFor(sim);
  const goalCell = sim.map.navCell(goal.x, goal.y);
  const shared = sharedRoute(sim, b, pos, radius, goalCell);
  if (shared) {
    b.queue.delete(m);
    takeRoute(sim, m, shared.path, shared.goalCell);
    return m.path.length > 0;
  }
  const first = b.queue.keys().next();
  if (budgetRoom(b) && (first.done === true || first.value === m)) {
    b.queue.delete(m);
    search(sim, b, m, pos, goal);
    return m.path.length > 0;
  }
  b.queue.set(m, { id, from: { x: pos.x, y: pos.y }, goal: { x: goal.x, y: goal.y } });
  return m.path.length > 0;
}

/** Spends what is left of this tick's search budget on the minions waiting in line, oldest first. */
function drainPathQueue(sim: Simulation): void {
  const b = budgets.get(sim);
  if (!b || b.queue.size === 0) return;
  budgetFor(sim);
  for (const [m, req] of b.queue) {
    if (!budgetRoom(b)) break;
    b.queue.delete(m);
    // Gone since it asked (dead, unbound, or its room closed).
    if (sim.world.minion.get(req.id) !== m) continue;
    const radius = sim.world.radius.get(req.id) ?? m.def.radius;
    const goalCell = sim.map.navCell(req.goal.x, req.goal.y);
    const shared = sharedRoute(sim, b, req.from, radius, goalCell);
    if (shared) takeRoute(sim, m, shared.path, shared.goalCell);
    else search(sim, b, m, req.from, req.goal);
  }
}

/** This tick's route searches and the minions waiting for one, for tests and the bench. */
export function pathBudgetStats(sim: Simulation): { tick: number; searches: number; cells: number; queued: number } {
  const b = budgets.get(sim);
  return b ? { tick: b.tick, searches: b.searches, cells: b.cells, queued: b.queue.size } : { tick: sim.tick, searches: 0, cells: 0, queued: 0 };
}

function cellDrift(cols: number, a: number, b: number): number {
  const ax = a % cols;
  const bx = b % cols;
  return Math.max(Math.abs(ax - bx), Math.abs((a - ax) / cols - (b - bx) / cols));
}

/** One step along the planned route, cutting to the furthest waypoint in a straight line. */
function followPath(sim: Simulation, id: EntityId, m: MinionComp, pos: Vec2, radius: number, goal: Vec2, step: number, stopAt: number): boolean {
  const cols = sim.map.navCols;
  const goalCell = sim.map.navCell(goal.x, goal.y);
  if (sim.tick - m.pathTick >= PATH_STALE_TICKS || cellDrift(cols, goalCell, m.pathGoal) > PATH_GOAL_DRIFT_CELLS) {
    const planned = planPath(sim, id, m, pos, radius, goal);
    // A replan the rate limit or the budget refused leaves the old route. An old route that is only
    // old still leads the right way; one toward where the goal no longer is (a target that ran off)
    // is dropped, and the minion takes the trail or a straight step until its search comes up.
    if (!planned || cellDrift(cols, goalCell, m.pathGoal) > PATH_GOAL_DRIFT_CELLS) {
      m.path.length = 0;
      return false;
    }
  }
  const path = m.path;
  while (path.length > 1) {
    const first = path[0];
    if (!first || distSq(pos.x, pos.y, first.x, first.y) > WAYPOINT_REACHED * WAYPOINT_REACHED) break;
    path.shift();
  }
  for (let k = Math.min(path.length, PATH_LOOKAHEAD) - 1; k >= 1; k--) {
    const wp = path[k];
    if (wp && sim.map.lineClear(pos.x, pos.y, wp.x, wp.y, radius * 0.8, 'move')) {
      path.splice(0, k);
      break;
    }
  }
  const target = path[0];
  if (!target) return false;
  const last = path.length === 1;
  walkToward(sim, pos, target.x, target.y, step, last ? stopAt : 0, radius);
  if (last && distSq(pos.x, pos.y, target.x, target.y) <= Math.max(stopAt, WAYPOINT_REACHED) ** 2) path.length = 0;
  return true;
}

function resetStuck(m: MinionComp, pos: Vec2, ownerDist: number): void {
  m.stuck.x = pos.x;
  m.stuck.y = pos.y;
  m.stuck.ownerDist = ownerDist;
  m.stuck.ticks = 0;
}

/** Puts a minion down beside its master and forgets what it was doing on the way. */
function pullOver(sim: Simulation, m: MinionComp, owner: PlayerComp, pos: Vec2, opos: Vec2, radius: number): void {
  const p = besideMaster(sim, owner, opos, radius);
  pos.x = p.x;
  pos.y = p.y;
  m.targetId = null;
  m.path.length = 0;
  budgets.get(sim)?.queue.delete(m);
  resetStuck(m, pos, Math.hypot(pos.x - opos.x, pos.y - opos.y));
}

/**
 * Counts ticks without progress toward the master and pulls the minion over once it has been
 * stuck about 2 s out of their sight. Returns whether it was pulled. The sight check only runs at
 * the threshold, so a minion resting in formation costs one line test every 2 s.
 */
function trackStuck(sim: Simulation, m: MinionComp, owner: PlayerComp, pos: Vec2, opos: Vec2, radius: number): boolean {
  const d = Math.hypot(pos.x - opos.x, pos.y - opos.y);
  const s = m.stuck;
  if (d < s.ownerDist - STUCK_CLOSER || distSq(pos.x, pos.y, s.x, s.y) > STUCK_MOVE * STUCK_MOVE) {
    resetStuck(m, pos, d);
    return false;
  }
  s.ticks++;
  if (s.ticks < STUCK_TELEPORT_TICKS) return false;
  if (sim.map.lineClear(pos.x, pos.y, opos.x, opos.y, radius * 0.8, 'move')) {
    resetStuck(m, pos, d);
    return false;
  }
  pullOver(sim, m, owner, pos, opos, radius);
  return true;
}

/**
 * While the master is dead: no fighting, no abilities, and the minion walks back to wait around
 * the corpse. Monsters ignore it (see isTargetable), so it cannot die for its master's death.
 */
function standDown(sim: Simulation, id: EntityId, m: MinionComp, owner: PlayerComp, pos: Vec2, opos: Vec2, radius: number, speed: number, dt: number): void {
  if (!m.standingDown) {
    m.standingDown = true;
    m.targetId = null;
    m.leap = null;
    m.howled = 0;
    m.state = 'follow';
    m.path.length = 0;
    resetStuck(m, pos, Math.hypot(pos.x - opos.x, pos.y - opos.y));
  }
  if (distSq(pos.x, pos.y, opos.x, opos.y) > NAV.minionTeleportDistance ** 2) {
    pullOver(sim, m, owner, pos, opos, radius);
    return;
  }
  const goal = followGoal(sim, owner, m, opos, radius);
  navigate(sim, id, m, pos, radius, goal.at, owner.trail, speed * dt, goal.stopAt);
  if (trackStuck(sim, m, owner, pos, opos, radius)) return;
  settle(sim, pos, radius);
}

/** The master is back: a minion left far away or out of sight rejoins them at once. */
function rejoin(sim: Simulation, m: MinionComp, owner: PlayerComp, pos: Vec2, opos: Vec2, radius: number): void {
  m.standingDown = false;
  m.path.length = 0;
  const far = distSq(pos.x, pos.y, opos.x, opos.y) > MINIONS.catchUpDistance ** 2;
  if (far || !sim.map.lineClear(pos.x, pos.y, opos.x, opos.y, radius * 0.8, 'move')) pullOver(sim, m, owner, pos, opos, radius);
  else resetStuck(m, pos, Math.hypot(pos.x - opos.x, pos.y - opos.y));
}

/**
 * Where a following minion heads: its formation spot, or the master when that spot is behind a
 * fence or wall from them, which would send the minion the long way round for nothing.
 */
function followGoal(sim: Simulation, owner: PlayerComp, m: MinionComp, opos: Vec2, radius: number): { at: Vec2; stopAt: number } {
  const at = packFollowPoint(sim, owner, m) ?? formationPoint(owner, opos, m.slot, m.behaviour === 'bodyguard');
  if (sim.map.lineClear(opos.x, opos.y, at.x, at.y, radius * 0.8, 'move')) return { at, stopAt: ARRIVE_DISTANCE };
  return { at: opos, stopAt: MINIONS.followDistance * 0.6 };
}

/** Formation slot for a minion: an arc behind the master's heading; bodyguards take the front. */
const FORMATION_ROW = 6;

function formationPoint(owner: { heading: number }, opos: Vec2, slot: number, bodyguard: boolean): Vec2 {
  const back = owner.heading + Math.PI;
  if (bodyguard) {
    const a = owner.heading + ((slot % FORMATION_ROW) - (FORMATION_ROW - 1) / 2) * 0.4;
    const r = MINIONS.bodyguardDistance + Math.floor(slot / FORMATION_ROW) * 26;
    return { x: opos.x + Math.cos(a) * r, y: opos.y + Math.sin(a) * r };
  }
  // Rows of six behind the master, so a big warband forms ranks instead of a circle around them.
  const spread = ((slot % FORMATION_ROW) - (FORMATION_ROW - 1) / 2) * 0.45;
  const d = MINIONS.followDistance + Math.floor(slot / FORMATION_ROW) * MINIONS.formationSpacing + (slot % 2) * 10;
  return { x: opos.x + Math.cos(back + spread) * d, y: opos.y + Math.sin(back + spread) * d };
}

/** Bodyguards step onto the path of the nearest enemy bullet heading for their master. */
function interceptPoint(sim: Simulation, opos: Vec2): Vec2 | null {
  const w = sim.world;
  let best: Vec2 | null = null;
  let bestT = Infinity;
  for (const [id, , ppos] of w.query(w.projectile, w.position)) {
    if (w.team.get(id) !== 'enemies') continue;
    const v = w.velocity.get(id);
    if (!v) continue;
    const dx = opos.x - ppos.x;
    const dy = opos.y - ppos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > MINIONS.interceptRange) continue;
    const speed = Math.hypot(v.x, v.y) || 1;
    // Only bullets actually aimed near the master are worth blocking.
    if ((dx * v.x + dy * v.y) / (dist * speed) < 0.92) continue;
    const t = dist / speed;
    if (t < bestT) {
      bestT = t;
      best = { x: ppos.x + dx * 0.55, y: ppos.y + dy * 0.55 };
    }
  }
  return best;
}

/**
 * A minion's heading: at a target within striking distance, otherwise along the step it just took,
 * otherwise unchanged so a minion that stops keeps looking where it went.
 */
export function minionFacing(facing: number, from: Vec2, to: Vec2, minStep: number, strikeAt: Vec2 | null): number {
  if (strikeAt && (strikeAt.x !== to.x || strikeAt.y !== to.y)) return Math.atan2(strikeAt.y - to.y, strikeAt.x - to.x);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx * dx + dy * dy < minStep * minStep) return facing;
  return Math.atan2(dy, dx);
}

/** Positions at the start of the tick, reused between ticks. */
const tickStarts = new Map<EntityId, Vec2>();

export function updateMinions(sim: Simulation, dt: number): void {
  const w = sim.world;
  tickStarts.clear();
  for (const [id, , pos] of w.query(w.minion, w.position)) tickStarts.set(id, { x: pos.x, y: pos.y });
  for (const [id, m, pos] of w.query(w.minion, w.position)) {
    const h = w.health.get(id);
    const owner = w.player.get(m.ownerId);
    const opos = w.position.get(m.ownerId);
    if (!h) continue;
    if (!owner || !opos) {
      w.destroy(id);
      continue;
    }
    const def = m.def;
    const radius = w.radius.get(id) ?? def.radius;
    if (m.attackCooldown > 0) m.attackCooldown -= dt;
    if (m.leapCooldown > 0) m.leapCooldown -= dt;
    if (m.howlCooldown > 0) m.howlCooldown -= dt;
    if (m.howled > 0) m.howled = Math.max(0, m.howled - dt);
    // Road bonus applies per tick; the stored base speed never changes.
    const speed = m.moveSpeed * (m.howled > 0 ? 1 + HOUND_PACK.howl.speedBonus : 1) * sim.map.speedAt(pos.x, pos.y);

    if (owner.respawnIn !== null) {
      standDown(sim, id, m, owner, pos, opos, radius, speed, dt);
      continue;
    }
    if (m.standingDown) rejoin(sim, m, owner, pos, opos, radius);

    if (m.leap) {
      advanceLeap(sim, id, m, pos, radius, dt);
      continue;
    }

    const regen = affixValue(m.affixes, 'regenerating');
    if (regen > 0) healEntity(sim, id, (h.maxLife * regen * dt) / 100, false);

    const tauntRadius = affixValue(m.affixes, 'taunts');
    if (tauntRadius > 0) {
      m.tauntTimer -= dt;
      if (m.tauntTimer <= 0) {
        m.tauntTimer = TAUNT_PULSE_SECONDS;
        for (const [, e, ep] of w.query(w.enemy, w.position)) {
          if (distSq(pos.x, pos.y, ep.x, ep.y) <= tauntRadius * tauntRadius) {
            e.tauntTarget = id;
            e.tauntTimer = MINIONS.tauntSeconds;
          }
        }
      }
    }

    const ownerDist2 = distSq(pos.x, pos.y, opos.x, opos.y);
    if (ownerDist2 > NAV.minionTeleportDistance ** 2) {
      pullOver(sim, m, owner, pos, opos, radius);
      continue;
    }

    if (m.behaviour === 'coward') {
      const ratio = h.life / h.maxLife;
      if (m.state !== 'retreat' && ratio < MINIONS.cowardRetreatAt) {
        m.state = 'retreat';
        m.targetId = null;
      } else if (m.state === 'retreat' && ratio >= MINIONS.cowardResumeAt) {
        m.state = 'follow';
      }
    }
    if (m.state === 'retreat') {
      navigate(sim, id, m, pos, radius, opos, owner.trail, speed * dt, MINIONS.followDistance * 0.5);
      healEntity(sim, id, h.maxLife * MINIONS.cowardRegenFraction * dt, false);
      if (trackStuck(sim, m, owner, pos, opos, radius)) continue;
      settle(sim, pos, radius);
      continue;
    }

    if (m.behaviour === 'bodyguard') {
      const block = interceptPoint(sim, opos);
      if (block) {
        walkToward(sim, pos, block.x, block.y, speed * 1.4 * dt, 2, radius);
        settle(sim, pos, radius);
        continue;
      }
    }

    const rules = engageRules(sim, m);
    // Focus fire: a fresh hit from the master overrides whatever the minion was doing.
    const focus = owner.focusTarget;
    if (rules && focus !== null && focus !== m.targetId && sim.tick - owner.focusTick < MINIONS.focusTicks && isTargetable(sim, focus)) {
      const fp = w.position.get(focus);
      if (fp && distSq(opos.x, opos.y, fp.x, fp.y) <= rules.leash * rules.leash) {
        m.targetId = focus;
        m.lostSightTicks = 0;
      }
    }
    if (m.targetId !== null) {
      const tp = w.position.get(m.targetId);
      const lost = !isTargetable(sim, m.targetId) || !tp || !rules || ownerDist2 > rules.leash * rules.leash;
      if (lost) m.targetId = null;
      else if (tp) {
        m.lostSightTicks = sim.map.lineClear(pos.x, pos.y, tp.x, tp.y, 4, 'shots') ? 0 : m.lostSightTicks + 1;
        if (m.lostSightTicks > MINIONS.lostSightTicks) {
          m.targetId = null;
          m.lostSightTicks = 0;
        }
      }
    }
    if (m.targetId === null && rules) m.targetId = findTarget(sim, m, pos, rules.fromOwner ? opos : pos, rules.radius);
    // Packmates hunt what their Leader hunts; without a Leader they pick their own.
    const leader = packLeader(sim, owner, m);
    if (rules && leader && leader.targetId !== null && isTargetable(sim, leader.targetId)) m.targetId = leader.targetId;
    if (rules && m.pack?.role === 'leader' && m.targetId !== null && m.howlCooldown <= 0) howl(sim, id, m, owner, pos);

    const target = m.targetId;
    const tpos = target === null ? undefined : w.position.get(target);
    if (target !== null && tpos) {
      m.state = 'engage';
      // Chasing a target is progress of its own; the stuck count is for getting back to the master.
      resetStuck(m, pos, Math.sqrt(ownerDist2));
      const dist = Math.sqrt(distSq(pos.x, pos.y, tpos.x, tpos.y));
      const reach = def.attackRange + radius + (w.radius.get(target) ?? 0);
      if (def.ranged) {
        const canShoot = sim.map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 4, 'shots');
        if (!canShoot || dist > def.attackRange) {
          // Reposition until there is a clear shot, walking around whatever is in the way.
          navigate(sim, id, m, pos, radius, tpos, owner.trail, speed * dt, def.attackRange * 0.8);
        } else if (dist < def.kiteDistance) {
          const away = { x: pos.x + (pos.x - tpos.x), y: pos.y + (pos.y - tpos.y) };
          const before = { x: pos.x, y: pos.y };
          stepToward(pos, away.x, away.y, speed * dt, 0);
          // Backing into a wall is worse than standing ground; kite sideways instead.
          if (sim.map.pointBlocked(pos.x, pos.y, radius, 'move')) {
            pos.x = before.x;
            pos.y = before.y;
            const side = { x: pos.x - (tpos.y - pos.y), y: pos.y + (tpos.x - pos.x) };
            stepToward(pos, side.x, side.y, speed * dt, 0);
          }
        }
        if (canShoot && dist <= def.attackRange && m.attackCooldown <= 0) {
          m.attackCooldown = m.attackCooldownBase;
          sim.emit({ e: 'attack', id }, pos.x, pos.y);
          const volley = 1 + affixValue(m.affixes, 'extra_projectiles');
          const base = Math.atan2(tpos.y - pos.y, tpos.x - pos.x);
          for (let k = 0; k < volley; k++) {
            spawnProjectile(sim, {
              ownerId: id,
              team: 'players',
              x: pos.x,
              y: pos.y,
              angle: base + (k - (volley - 1) / 2) * MINIONS.volleySpreadRadians,
              speed: Math.max(MIN_PROJECTILE_SPEED, def.projectileSpeed),
              radius: MINIONS.arrowRadius,
              range: def.attackRange * MINIONS.arrowRangeMultiplier,
              damage: m.damage,
            });
          }
        }
      } else if (m.pack?.role === 'leader' && startLeap(sim, id, m, pos, tpos, dist, radius)) {
        settle(sim, pos, radius);
        continue;
      } else {
        // Packmates circle to their own side of the target instead of queueing behind the Leader.
        const goal = m.pack?.role === 'mate' ? flankPoint(sim, owner, m, pos, tpos, radius + (w.radius.get(target) ?? 0) + def.attackRange * 0.5) : tpos;
        navigate(sim, id, m, pos, radius, goal, owner.trail, speed * dt, m.pack?.role === 'mate' ? 2 : reach - 4);
        const now = Math.sqrt(distSq(pos.x, pos.y, tpos.x, tpos.y));
        if (now <= reach && m.attackCooldown <= 0) {
          m.attackCooldown = m.attackCooldownBase;
          sim.emit({ e: 'attack', id }, pos.x, pos.y);
          const hit = biteDamage(owner, m);
          const dealt = dealDamage(sim, target, hit, id, []);
          if (dealt > 0 && m.pack?.role === 'mate') applyPoison(sim, target, hit, id);
        }
      }
    } else {
      m.state = 'follow';
      const goal = followGoal(sim, owner, m, opos, radius);
      // Minions sprint to catch up when far behind, so they do not trail across the map.
      const catchUp = ownerDist2 > MINIONS.catchUpDistance ** 2 ? MINIONS.catchUpSpeedMultiplier : 1;
      navigate(sim, id, m, pos, radius, goal.at, owner.trail, speed * catchUp * dt, goal.stopAt);
      if (trackStuck(sim, m, owner, pos, opos, radius)) continue;
    }
    settle(sim, pos, radius);
  }
  drainPathQueue(sim);
  // Before separation, so being shoved by a packmate does not turn a dog around.
  for (const [id, m, pos] of w.query(w.minion, w.position)) {
    const from = tickStarts.get(id);
    if (!from) continue;
    const radius = w.radius.get(id) ?? m.def.radius;
    let strikeAt: Vec2 | null = null;
    const targetId = m.state === 'engage' ? m.targetId : null;
    const tpos = targetId === null ? undefined : w.position.get(targetId);
    if (targetId !== null && tpos && !m.leap) {
      const reach = m.def.ranged ? m.def.attackRange : m.def.attackRange + radius + (w.radius.get(targetId) ?? 0);
      if (distSq(pos.x, pos.y, tpos.x, tpos.y) <= (reach + FACE_TARGET_SLACK) ** 2) strikeAt = tpos;
    }
    m.facing = minionFacing(m.facing, from, pos, m.moveSpeed * dt * TURN_STEP_SHARE, strikeAt);
  }
  separateMinions(sim);
}

// ---------------------------------------------------------------------------------------------
// Hound pack

/** A packmate's living Leader, or null (also for dogs that are not packmates). */
function packLeader(sim: Simulation, owner: PlayerComp, m: MinionComp): MinionComp | null {
  if (m.pack?.role !== 'mate') return null;
  const id = owner.minions[m.slot];
  return id === null || id === undefined ? null : (sim.world.minion.get(id) ?? null);
}

function biteDamage(owner: PlayerComp, m: MinionComp): number {
  let d = m.damage;
  if (m.howled > 0) d *= 1 + HOUND_PACK.howl.damageBonus;
  if (m.pack?.role === 'mate' && owner.minions[m.slot] === null) d *= HOUND_PACK.leaderlessDamageMult;
  return d;
}

/** Where a packmate stands to bite: its own angle around the target, measured from the Leader's side. */
function flankPoint(sim: Simulation, owner: PlayerComp, m: MinionComp, pos: Vec2, tpos: Vec2, distance: number): Vec2 {
  const leaderId = owner.minions[m.slot];
  const lpos = leaderId === null || leaderId === undefined ? undefined : sim.world.position.get(leaderId);
  const from = lpos ?? pos;
  const angles = HOUND_PACK.flankAngles;
  const a = Math.atan2(from.y - tpos.y, from.x - tpos.x) + (angles[(m.pack?.index ?? 0) % angles.length] ?? 0);
  return { x: tpos.x + Math.cos(a) * distance, y: tpos.y + Math.sin(a) * distance };
}

/** Out of a fight, packmates trot in a loose ring behind their Leader rather than in the master's ranks. */
function packFollowPoint(sim: Simulation, owner: PlayerComp, m: MinionComp): Vec2 | null {
  if (m.pack?.role !== 'mate') return null;
  const leaderId = owner.minions[m.slot];
  const lpos = leaderId === null || leaderId === undefined ? undefined : sim.world.position.get(leaderId);
  if (!lpos) return null;
  const angles = HOUND_PACK.flankAngles;
  const a = owner.heading + Math.PI + (angles[m.pack.index % angles.length] ?? 0) * 0.5;
  return { x: lpos.x + Math.cos(a) * 34, y: lpos.y + Math.sin(a) * 34 };
}

/** The Leader's howl: the pack runs and bites harder, and packmates that fell long enough ago rejoin. */
function howl(sim: Simulation, id: EntityId, m: MinionComp, owner: PlayerComp, pos: Vec2): void {
  const w = sim.world;
  const cfg = HOUND_PACK.howl;
  m.howlCooldown = cfg.cooldown;
  m.howled = cfg.seconds;
  const pack = owner.packs[m.slot];
  if (pack) {
    for (const mate of pack.mates) {
      const mc = w.minion.get(mate);
      if (mc) mc.howled = cfg.seconds;
    }
    const wait = MINIONS.respawnSeconds * (1 - affixValue(m.affixes, 'faster_respawn') / 100) * SIM.tickRate;
    const ready = pack.down.filter((t) => sim.tick - t >= wait).length;
    if (ready > 0) {
      pack.down = pack.down.filter((t) => sim.tick - t < wait);
      fillPack(sim, m.ownerId, m.slot, pack.mates.length + ready);
    }
  }
  sim.emit({ e: 'howl', id, x: Math.round(pos.x), y: Math.round(pos.y), r: cfg.radius }, pos.x, pos.y);
}

/** The Leader pounces on a target in range; returns whether it started. */
function startLeap(sim: Simulation, id: EntityId, m: MinionComp, pos: Vec2, tpos: Vec2, dist: number, radius: number): boolean {
  const a = leapOf(m.def);
  if (!a || m.leapCooldown > 0 || dist < a.minRange || dist > a.range) return false;
  if (!sim.map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 8, 'shots')) return false;
  // Fences and water let shots through but not walkers; the pounce is a walker's jump, not a flight.
  if (!sim.map.lineClear(pos.x, pos.y, tpos.x, tpos.y, radius * 0.8, 'move')) return false;
  const angle = Math.atan2(tpos.y - pos.y, tpos.x - pos.x);
  // Lands against the target, not on top of it.
  const reach = Math.max(0, Math.min(dist, a.range) - radius);
  m.leapCooldown = a.cooldown;
  m.facing = angle;
  m.leap = {
    t: 0,
    windup: a.windup,
    duration: a.duration,
    fromX: pos.x,
    fromY: pos.y,
    toX: pos.x + Math.cos(angle) * reach,
    toY: pos.y + Math.sin(angle) * reach,
    radius: a.radius,
    damage: m.leapDamage,
  };
  sim.emit({ e: 'attack', id }, pos.x, pos.y);
  return true;
}

function advanceLeap(sim: Simulation, id: EntityId, m: MinionComp, pos: Vec2, radius: number, dt: number): void {
  const l = m.leap;
  if (!l) return;
  l.t += dt;
  if (l.t < l.windup) return;
  const k = Math.min(1, (l.t - l.windup) / l.duration);
  pos.x = l.fromX + (l.toX - l.fromX) * k;
  pos.y = l.fromY + (l.toY - l.fromY) * k;
  if (k < 1) return;
  m.leap = null;
  const land = sim.map.findOpen(pos.x, pos.y, radius);
  pos.x = land.x;
  pos.y = land.y;
  const w = sim.world;
  const hit = l.damage * (m.howled > 0 ? 1 + HOUND_PACK.howl.damageBonus : 1);
  for (const [eid, e, ep] of w.query(w.enemy, w.position)) {
    const reach = l.radius + (w.radius.get(eid) ?? 0);
    if (distSq(pos.x, pos.y, ep.x, ep.y) > reach * reach) continue;
    const dealt = dealDamage(sim, eid, hit, id, []);
    if (dealt <= 0) continue;
    applyPoison(sim, eid, hit, id);
    if (!e.boss && !knockbackImmune(e) && !e.leap && !e.dash) e.pinned = Math.max(e.pinned, HOUND_PACK.pinSeconds);
  }
  sim.emit({ e: 'pounce', id, x: Math.round(pos.x), y: Math.round(pos.y), r: l.radius }, pos.x, pos.y);
}

/** Keeps a warband from collapsing into one stack. */
function separateMinions(sim: Simulation): void {
  const w = sim.world;
  const list = [...w.query(w.minion, w.position)];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b) continue;
      const ra = (w.radius.get(a[0]) ?? 0) * MINIONS.separation;
      const rb = (w.radius.get(b[0]) ?? 0) * MINIONS.separation;
      const dx = b[2].x - a[2].x;
      const dy = b[2].y - a[2].y;
      const d = Math.hypot(dx, dy);
      const overlap = ra + rb - d;
      if (overlap <= 0 || d === 0) continue;
      const push = overlap / 2 / d;
      a[2].x -= dx * push;
      a[2].y -= dy * push;
      b[2].x += dx * push;
      b[2].y += dy * push;
    }
  }
}

function settle(sim: Simulation, pos: Vec2, r: number): void {
  const p = sim.map.resolveCircle(pos, r);
  pos.x = p.x;
  pos.y = p.y;
}
