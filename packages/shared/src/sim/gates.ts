import { GATES, NET, SIM } from '../config/sim.js';
import type { EnemyTypeId } from '../data/enemies.js';
import type { GateInfo } from '../world/types.js';
import type { EnemyComp, EntityId } from './ecs.js';
import { spawnEnemy } from './enemies.js';
import type { GateSeal } from './movement.js';
import { killerOf, killSharers } from './progression.js';
import { Rng } from './rng.js';
import type { Simulation } from './simulation.js';
import { respawnTicks } from './streaming.js';

/**
 * Gate bosses, Diablo 2's act bosses in the seamless world (owner decision, 2026-10-01). Each road's
 * gate is a pass held by a boss; the land behind it is sealed to every character until that
 * character's party kills the boss, and stays open for that character from then on (`PlayerComp.gates`,
 * saved with the character). The boss itself comes back on a timer for the next character and for
 * farming, after the admin's boss respawn time (`respawnTicks(sim).bosses`, the region bosses' too,
 * so one setting rules every boss) counted from its death. Monsters and other players are never held
 * back by a seal.
 *
 * The seal is a rule of movement (`sealBlocks` in movement.ts), not a collider, so the client's
 * prediction applies the same rule from the same plan and its own gate list.
 *
 * The state lives beside the simulation, like the chests' and the monsters'.
 */

interface BossSlot {
  /** The living boss, or null. */
  entity: EntityId | null;
  /** Tick it died (or vanished) on; null before its first spawn. */
  diedAt: number | null;
  /** Spawns so far, for the boss's own random stream. */
  spawns: number;
}

interface GateState {
  slots: Map<string, BossSlot>;
}

const states = new WeakMap<Simulation, GateState>();

function state(sim: Simulation): GateState {
  let s = states.get(sim);
  if (!s) {
    s = { slots: new Map() };
    states.set(sim, s);
  }
  return s;
}

function slot(sim: Simulation, id: string): BossSlot {
  const s = state(sim);
  let b = s.slots.get(id);
  if (!b) {
    b = { entity: null, diedAt: null, spawns: 0 };
    s.slots.set(id, b);
  }
  return b;
}

/**
 * The seal for a character with these gates opened, or null where nothing is sealed to it (a map
 * that is not the world, or every gate open). The server's `applyInput` and the client's prediction
 * both build it this way.
 */
export function gateSeal(sim: Pick<Simulation, 'zone'>, opened: readonly string[]): GateSeal | null {
  const plan = sim.zone?.plan;
  if (!plan || plan.gates.every((g) => opened.includes(g.id))) return null;
  return { plan, opened };
}

/** Brings a dead gate boss back as soon as someone is near, whatever its timer says. */
export function respawnGateBoss(sim: Simulation, gateId: string): void {
  const b = slot(sim, gateId);
  if (b.entity === null) b.diedAt = null;
}

/** The gate's living boss, or null. */
export function gateBoss(sim: Simulation, gateId: string): EntityId | null {
  const b = state(sim).slots.get(gateId);
  if (!b || b.entity === null) return null;
  return sim.world.enemy.get(b.entity)?.gate === gateId ? b.entity : null;
}

/**
 * `living` false counts the dead too: someone waiting to respawn still sees the screen. `sealedTo`
 * counts only players the gate is still sealed for, so people idling past an opened gate (its
 * waypoint stands about 640 away) do not hold the boss back from the newcomers who need it.
 */
function playerNear(sim: Simulation, x: number, y: number, range: number, living = true, sealedTo: string | null = null): boolean {
  const w = sim.world;
  const r2 = range * range;
  for (const [id, p] of w.player) {
    if (living && p.respawnIn !== null) continue;
    if (sealedTo !== null && p.gates.includes(sealedTo)) continue;
    const pos = w.position.get(id);
    if (pos && (pos.x - x) ** 2 + (pos.y - y) ** 2 <= r2) return true;
  }
  return false;
}

function spawnGateBoss(sim: Simulation, g: GateInfo, b: BossSlot): void {
  const rng = Rng.stream(sim.seed, `gate:${g.id}:${b.spawns}`);
  const id = spawnEnemy(sim, g.boss, g.bossX, g.bossY, { rare: true, level: g.level, aggro: false, boss: true, rng });
  const e = sim.world.enemy.get(id);
  if (e) e.gate = g.id;
  b.entity = id;
  b.spawns++;
}

/** Checked a few times a second: nothing about a gate needs a faster answer. */
const EVERY_TICKS = 5;

/**
 * Spawns each gate's boss once a living player comes within range of the gate, the first time and
 * again once its respawn time has passed since it died. A respawn also waits until nobody is within
 * the network interest radius of the boss's spot, so nobody sees it appear out of thin air; the first
 * spawn does not, since a waypoint can stand that close and the gate would never get its boss. A boss
 * removed without being killed (dev tools, a room rebuilt) counts as dead from the tick it was missed.
 */
export function updateGates(sim: Simulation): void {
  const gates = sim.mapDef.gates;
  if (!gates || gates.length === 0 || sim.arena || sim.tick % EVERY_TICKS !== 0) return;
  // Read each time, so a changed admin setting reaches a boss already waiting, counted from its death.
  const wait = respawnTicks(sim).bosses;
  for (const g of gates) {
    const b = slot(sim, g.id);
    if (b.entity !== null) {
      if (sim.world.enemy.get(b.entity)?.gate === g.id) continue;
      b.entity = null;
      b.diedAt ??= sim.tick;
    }
    if (b.diedAt !== null) {
      const since = sim.tick - b.diedAt;
      if (since < wait) continue;
      // A newcomer camping the spot would otherwise hold it back for good; past the extra wait it
      // comes back regardless, which is better than a gate nobody can open.
      const overdue = since >= wait + GATES.maxRespawnDelaySeconds * SIM.tickRate;
      if (!overdue && playerNear(sim, g.bossX, g.bossY, NET.interestRadius, false, g.id)) continue;
    }
    if (playerNear(sim, g.x, g.y, GATES.spawnRange)) spawnGateBoss(sim, g, b);
  }
}

/** Opens a gate for one character, with the notice and the seal breaking on their screen. */
export function openGate(sim: Simulation, pid: EntityId, gateId: string): boolean {
  const p = sim.world.player.get(pid);
  const g = sim.mapDef.gates?.find((x) => x.id === gateId);
  if (!p || !g || p.gates.includes(gateId)) return false;
  p.gates.push(gateId);
  const pos = sim.world.position.get(pid);
  // Placed at the player, so it reaches them wherever they stood within the kill's sharing range.
  sim.emit({ e: 'gateOpened', id: pid, gate: gateId, x: g.x, y: g.y }, pos?.x ?? g.x, pos?.y ?? g.y);
  return true;
}

/**
 * A gate boss died: its timer starts, and the gate opens for everyone the kill's XP goes to (the
 * killer's party alive within range, or the killer alone). Called from `kill` in combat.ts.
 */
export function onGateBossKilled(sim: Simulation, e: EnemyComp, x: number, y: number, sourceId: EntityId | null): void {
  const gateId = e.gate;
  if (!gateId) return;
  gateBossDied(sim, gateId);
  if (!e.rewards) return;
  const killer = killerOf(sim, e, sourceId);
  if (killer === null) return;
  for (const pid of killSharers(sim, killer, x, y)) openGate(sim, pid, gateId);
}

/** Starts the gate boss's respawn timer from now. */
export function gateBossDied(sim: Simulation, gateId: string): void {
  const b = slot(sim, gateId);
  b.entity = null;
  b.diedAt = sim.tick;
}

/**
 * A dead gate boss's timer, for a world room that closes or is rebuilt: game ticks since its death
 * (time the room stood empty does not count, as with every respawn) and its spawns so far.
 */
export interface GateTimer {
  id: string;
  boss: EnemyTypeId;
  sinceDeath: number;
  spawns: number;
}

/** The timers of gate bosses dead right now; a living or never spawned boss needs nothing kept. */
export function gateTimers(sim: Simulation): GateTimer[] {
  const out: GateTimer[] = [];
  for (const g of sim.mapDef.gates ?? []) {
    const b = state(sim).slots.get(g.id);
    if (!b) continue;
    if (b.entity !== null) {
      if (sim.world.enemy.get(b.entity)?.gate === g.id) continue;
      // Gone since the last check: dead from now, as `updateGates` would count it.
      out.push({ id: g.id, boss: g.boss, sinceDeath: 0, spawns: b.spawns });
    } else if (b.diedAt !== null) out.push({ id: g.id, boss: g.boss, sinceDeath: sim.tick - b.diedAt, spawns: b.spawns });
  }
  return out;
}

/**
 * Carries timers into a new simulation of the same world copy, before anyone is near. Only where the
 * gate still exists with the same boss: a town save that moved things must not hand one gate's
 * timer to another.
 */
export function restoreGateTimers(sim: Simulation, timers: readonly GateTimer[]): void {
  for (const t of timers) {
    const g = sim.mapDef.gates?.find((x) => x.id === t.id);
    if (!g || g.boss !== t.boss) continue;
    const b = slot(sim, t.id);
    b.entity = null;
    b.diedAt = sim.tick - t.sinceDeath;
    b.spawns = t.spawns;
  }
}
