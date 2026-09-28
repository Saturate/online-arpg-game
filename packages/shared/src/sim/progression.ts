import { PROGRESSION } from '../config/sim.js';
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

function grayFactor(playerLevel: number, monsterLevel: number): number {
  const gap = playerLevel - monsterLevel - PROGRESSION.grayGap;
  return gap <= 0 ? 1 : Math.max(PROGRESSION.grayFloor, 1 - gap * PROGRESSION.grayPenaltyPerLevel);
}

/**
 * Splits a kill's XP among living players near it. Everyone in range gets a share of the pool,
 * and the pool grows per member, so a party levels faster than the same players alone.
 */
export function grantKillXp(sim: Simulation, e: EnemyComp, x: number, y: number): void {
  const w = sim.world;
  const r2 = PROGRESSION.partyRange ** 2;
  const near: EntityId[] = [];
  for (const [id, p] of w.player) {
    const pos = w.position.get(id);
    if (p.respawnIn === null && pos && (pos.x - x) ** 2 + (pos.y - y) ** 2 <= r2) near.push(id);
  }
  if (near.length === 0) return;
  const pool = monsterXp(e) * (1 + PROGRESSION.partyBonusPerMember * (near.length - 1));
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
