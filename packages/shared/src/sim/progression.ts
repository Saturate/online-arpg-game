import { ARENA, PROGRESSION } from '../config/sim.js';
import type { Item } from '../items/items.js';
import type { EnemyComp, EntityId } from './ecs.js';
import { refreshStats } from './inventory.js';
import type { Simulation } from './simulation.js';

/** XP needed to go from `level` to the next one. */
export function xpToNext(level: number): number {
  return Math.round(PROGRESSION.xpBase * level ** PROGRESSION.xpExponent);
}

/** The character level an item asks for before it can be equipped. */
export function levelRequirement(item: Item): number {
  return Math.max(1, item.ilvl - PROGRESSION.requirementSlack);
}

/** Base XP for killing one monster, before sharing and the level-gap penalty. */
export function monsterXp(e: Pick<EnemyComp, 'level' | 'rare' | 'boss'> & { summonerId?: EntityId | null }): number {
  const base = PROGRESSION.monsterXpBase * e.level ** PROGRESSION.monsterXpExponent;
  // Summoned adds are worth a little, so killing them is not wasted, but not enough to farm.
  const summoned = e.summonerId !== undefined && e.summonerId !== null ? PROGRESSION.summonedXpMultiplier : 1;
  return base * summoned * (e.boss ? PROGRESSION.bossXpMultiplier : e.rare ? PROGRESSION.rareXpMultiplier : 1);
}

/** What a kill pays out: the base value times the type's XP multiplier (an admin override, usually 1). */
export function killXp(e: Pick<EnemyComp, 'level' | 'rare' | 'boss' | 'summonerId' | 'def'>): number {
  return monsterXp(e) * (e.def.xp ?? 1);
}

function grayFactor(playerLevel: number, monsterLevel: number): number {
  const gap = playerLevel - monsterLevel - PROGRESSION.grayGap;
  return gap <= 0 ? 1 : Math.max(PROGRESSION.grayFloor, 1 - gap * PROGRESSION.grayPenaltyPerLevel);
}

/** The player a hit counts for: the player itself, or a minion's master. Monsters and hazards count for nobody. */
function creditedPlayer(sim: Simulation, sourceId: EntityId | null): EntityId | null {
  if (sourceId === null) return null;
  const w = sim.world;
  if (w.player.has(sourceId)) return sourceId;
  const owner = w.minion.get(sourceId)?.ownerId;
  return owner !== undefined && w.player.has(owner) ? owner : null;
}

/** Tallies a hit on a monster for whoever it counts for, for the kill fallback in grantKillXp. */
export function creditDamage(sim: Simulation, e: EnemyComp, sourceId: EntityId, amount: number): void {
  const pid = creditedPlayer(sim, sourceId);
  if (pid === null || amount <= 0) return;
  e.damageBy.set(pid, (e.damageBy.get(pid) ?? 0) + amount);
}

/**
 * Who a kill belongs to: the player who dealt the killing blow, their minions counting for them.
 * With no player behind the last hit, the player still here who dealt the most damage, or nobody.
 */
export function killerOf(sim: Simulation, e: EnemyComp, sourceId: EntityId | null): EntityId | null {
  const direct = creditedPlayer(sim, sourceId);
  if (direct !== null) return direct;
  let best: EntityId | null = null;
  let most = 0;
  for (const [pid, dealt] of e.damageBy) {
    if (dealt > most && sim.world.player.has(pid)) {
      best = pid;
      most = dealt;
    }
  }
  return best;
}

/**
 * Pays a kill's XP the D2 way: to the killer's party members alive within partyRange of the kill,
 * or to the killer alone outside a party. Anyone else nearby gets nothing, so strangers cannot
 * leech off each other's fights. The pool grows per member present, so a party levels faster than
 * the same players alone, and each share takes its own low-level penalty.
 */
export function grantKillXp(sim: Simulation, e: EnemyComp, x: number, y: number, sourceId: EntityId | null = null): void {
  if (!e.rewards) return;
  const w = sim.world;
  const killer = killerOf(sim, e, sourceId);
  if (killer === null) return;
  const party = w.player.get(killer)?.party ?? null;
  const r2 = PROGRESSION.partyRange ** 2;
  const near: EntityId[] = [];
  for (const [id, p] of w.player) {
    if (id !== killer && (party === null || p.party !== party)) continue;
    const pos = w.position.get(id);
    if (p.respawnIn === null && pos && (pos.x - x) ** 2 + (pos.y - y) ** 2 <= r2) near.push(id);
  }
  if (near.length === 0) return;
  const arena = sim.arena ? ARENA.xpMultiplier : 1;
  const pool = killXp(e) * (1 + PROGRESSION.partyBonusPerMember * (near.length - 1)) * sim.rates.xp * arena;
  for (const id of near) {
    const p = w.player.get(id);
    if (p) addXp(sim, id, (pool / near.length) * grayFactor(p.level, e.level));
  }
}

export function addXp(sim: Simulation, pid: EntityId, amount: number): void {
  const p = sim.world.player.get(pid);
  if (!p || p.level >= PROGRESSION.maxLevel) return;
  p.xp += amount;
  let leveled = false;
  while (p.level < PROGRESSION.maxLevel && p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    leveled = true;
  }
  if (p.level >= PROGRESSION.maxLevel) p.xp = 0;
  if (!leveled) return;
  refreshStats(sim, pid);
  // A level-up refills life and Force: the moment should feel like a reward, not a bookkeeping change.
  const h = sim.world.health.get(pid);
  if (h) h.life = h.maxLife;
  p.heat = 0;
  const pos = sim.world.position.get(pid);
  const x = pos?.x ?? 0;
  const y = pos?.y ?? 0;
  sim.emit({ e: 'levelUp', id: pid, level: p.level, x, y }, x, y);
}
