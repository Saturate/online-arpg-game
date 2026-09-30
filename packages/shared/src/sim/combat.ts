import { AILMENTS, ARMOR, CURSE, MINIONS, SIM } from '../config/sim.js';
import { CLASSES } from '../data/classes.js';
import { ENEMIES } from '../data/enemies.js';
import { MINION_DEFS } from '../data/minions.js';
import type { ElementId } from './program.js';
import { affixValue } from '../items/items.js';
import type { EntityId, Team } from './ecs.js';
import { alertPack, knockbackImmune, onEnemyDeath } from './enemies.js';
import { onBossKilled } from './dungeon.js';
import { creditDamage, grantKillXp } from './progression.js';
import { scoreKill } from './arena.js';
import { dropLoot } from './inventory.js';
import { onPackLeaderDeath, onPackmateDeath } from './minions.js';
import { distSq } from './math.js';
import type { Simulation } from './simulation.js';

/** Damage reduction from wards is capped so stacked auras and links never make a target immune. */
const MAX_DAMAGE_REDUCTION = 0.6;

export function teamOf(sim: Simulation, id: EntityId): Team | null {
  return sim.world.team.get(id) ?? null;
}

/** Players and minions are valid targets for enemies; dead players are not. */
/** Inside a town built into a zone: nobody there can be targeted or hurt. */
export function inSafeZone(sim: Simulation, x: number, y: number): boolean {
  const zones = sim.mapDef.safeZones;
  return zones !== undefined && zones.some((z) => x >= z.x && y >= z.y && x <= z.x + z.w && y <= z.y + z.h);
}

export function isTargetable(sim: Simulation, id: EntityId): boolean {
  const w = sim.world;
  if (!w.isAlive(id)) return false;
  const pos = w.position.get(id);
  // Monsters lose interest at the town gate and go home, as in D2.
  if (pos && inSafeZone(sim, pos.x, pos.y)) return false;
  const p = w.player.get(id);
  if (p) return p.respawnIn === null;
  const h = w.health.get(id);
  // Burrowed monsters are underground: nothing can hit them until they surface.
  if (w.enemy.get(id)?.burrowed) return false;
  return h !== undefined && h.life > 0;
}

export interface DamageOptions {
  /** DoT and aura ticks: no floating number, no ailment re-application. */
  quiet?: boolean;
  ignoreArmor?: boolean;
}

export function dealDamage(
  sim: Simulation,
  targetId: EntityId,
  raw: number,
  sourceId: EntityId,
  elements: readonly ElementId[],
  opts: DamageOptions = {},
): number {
  const w = sim.world;
  if (sim.mapDef.safe || raw <= 0 || !isTargetable(sim, targetId)) return 0;
  const h = w.health.get(targetId);
  const pos = w.position.get(targetId);
  if (!h || !pos) return 0;
  if (w.enemy.has(targetId)) alertPack(sim, targetId);

  let amount = raw;
  // A cursed player hits softer; the curse lives on the attacker, not the target.
  const sourceStatus = w.player.has(sourceId) ? w.status.get(sourceId) : undefined;
  if (sourceStatus && sourceStatus.curse > 0) amount *= 1 - CURSE.damageReduction;
  const st = w.status.get(targetId);
  if (st && st.shock > 0) amount *= 1 + AILMENTS.shock.damageTakenBonus;
  const p = w.player.get(targetId);
  if (p && !opts.ignoreArmor) amount = (amount * ARMOR.scale) / (ARMOR.scale + p.stats.armor);
  const buffs = w.buffs.get(targetId);
  if (buffs) amount *= 1 - Math.min(MAX_DAMAGE_REDUCTION, buffs.damageReduction);

  if (st?.shield) {
    const absorbed = Math.min(st.shield.amount, amount);
    st.shield.amount -= absorbed;
    amount -= absorbed;
    if (st.shield.amount <= 0) st.shield = null;
  }

  if (p?.god) amount = 0;
  const enemy = w.enemy.get(targetId);
  if (enemy) creditDamage(sim, enemy, sourceId, Math.min(amount, h.life));
  h.life = Math.max(0, h.life - amount);
  const attacker = w.player.get(sourceId);
  if (attacker && w.enemy.has(targetId)) {
    attacker.focusTarget = targetId;
    attacker.focusTick = sim.tick;
  }
  if (!opts.quiet) {
    sim.emit({ e: 'dmg', id: targetId, amt: Math.round(amount), x: pos.x, y: pos.y, el: elements[0] ?? null }, pos.x, pos.y);
    if (elements.length > 0) applyAilments(sim, targetId, raw, elements, sourceId);
  }

  const src = w.minion.get(sourceId);
  if (src && amount > 0) {
    const leech = affixValue(src.affixes, 'leech_for_master');
    if (leech > 0) healEntity(sim, src.ownerId, (amount * leech) / 100, false);
  }

  if (h.life <= 0) kill(sim, targetId, sourceId);
  return amount;
}

/** Life loss that bypasses armor, shields and wards, used for misfires. */
export function selfDamage(sim: Simulation, id: EntityId, amount: number): void {
  const h = sim.world.health.get(id);
  const pos = sim.world.position.get(id);
  if (!h || !pos || sim.mapDef.safe || !isTargetable(sim, id)) return;
  h.life = Math.max(0, h.life - amount);
  sim.emit({ e: 'dmg', id, amt: Math.round(amount), x: pos.x, y: pos.y, el: null }, pos.x, pos.y);
  if (h.life <= 0) kill(sim, id);
}

export function applyAilments(
  sim: Simulation,
  targetId: EntityId,
  hit: number,
  elements: readonly ElementId[],
  sourceId: EntityId,
): void {
  const st = sim.world.status.get(targetId);
  if (!st) return;
  for (const el of elements) {
    if (el === 'fire') {
      const dps = hit * AILMENTS.burn.dpsFractionOfHit;
      if (!st.burn || st.burn.dps <= dps) st.burn = { dps, t: AILMENTS.burn.seconds, sourceId };
      else st.burn.t = AILMENTS.burn.seconds;
    } else if (el === 'cold') {
      st.chill = AILMENTS.chill.seconds;
    } else {
      st.shock = AILMENTS.shock.seconds;
    }
  }
}

/**
 * A bite's poison: adds a stack worth a share of the hit and refreshes every stack, so a pack that
 * keeps biting keeps the poison up. At the cap the weakest stack gives way, never a stronger one.
 */
export function applyPoison(sim: Simulation, targetId: EntityId, hit: number, sourceId: EntityId): void {
  const st = sim.world.status.get(targetId);
  if (!st || hit <= 0 || !isTargetable(sim, targetId)) return;
  const cfg = AILMENTS.poison;
  const dps = hit * cfg.dpsFractionOfHit;
  for (const s of st.poison) s.t = cfg.seconds;
  if (st.poison.length < cfg.maxStacks) {
    st.poison.push({ dps, t: cfg.seconds, sourceId });
    return;
  }
  let weakest = st.poison[0];
  for (const s of st.poison) if (weakest && s.dps < weakest.dps) weakest = s;
  if (weakest && weakest.dps < dps) {
    weakest.dps = dps;
    weakest.sourceId = sourceId;
  }
}

export function healEntity(sim: Simulation, id: EntityId, amount: number, showNumber: boolean): number {
  const h = sim.world.health.get(id);
  const pos = sim.world.position.get(id);
  if (!h || !pos || amount <= 0 || !isTargetable(sim, id)) return 0;
  const healed = Math.min(amount, h.maxLife - h.life);
  h.life += healed;
  if (showNumber && healed >= 1) sim.emit({ e: 'heal', id, amt: Math.round(healed), x: pos.x, y: pos.y }, pos.x, pos.y);
  return healed;
}

export function grantShield(sim: Simulation, id: EntityId, amount: number, seconds: number, burning: boolean): void {
  const st = sim.world.status.get(id);
  if (!st || amount <= 0 || !isTargetable(sim, id)) return;
  if (!st.shield || st.shield.amount < amount) st.shield = { amount, t: seconds, burning };
  else {
    st.shield.t = seconds;
    st.shield.burning ||= burning;
  }
}

export function knockback(sim: Simulation, id: EntityId, fromX: number, fromY: number, strength: number): void {
  const e = sim.world.enemy.get(id);
  const pos = sim.world.position.get(id);
  if (!e || !pos || strength <= 0 || knockbackImmune(e)) return;
  const dx = pos.x - fromX;
  const dy = pos.y - fromY;
  const d = Math.hypot(dx, dy) || 1;
  // Rares are heavier, so knockback matters less against them.
  const s = e.rare ? strength * 0.5 : strength;
  e.knockX += (dx / d) * s;
  e.knockY += (dy / d) * s;
}

function kill(sim: Simulation, id: EntityId, sourceId: EntityId | null = null): void {
  const w = sim.world;
  const pos = w.position.get(id);
  if (!pos) return;

  const p = w.player.get(id);
  if (p) {
    p.respawnIn = SIM.playerRespawnSeconds;
    p.dash = null;
    p.dashSpell = null;
    sim.emit({ e: 'death', id, x: pos.x, y: pos.y, k: 'player', color: CLASSES[p.classId].color, big: false }, pos.x, pos.y);
    return;
  }

  const e = w.enemy.get(id);
  if (e) {
    // Dead first, so nothing below can treat it as alive; its store entries stay readable until the
    // end of the tick, which the rewards rely on.
    w.destroy(id);
    sim.emit({ e: 'death', id, x: pos.x, y: pos.y, k: 'enemy', color: ENEMIES[e.typeId].color, big: e.rare }, pos.x, pos.y);
    dropLoot(sim, id);
    onEnemyDeath(sim, id, e, pos);
    if (e.boss) onBossKilled(sim, pos.x, pos.y, e.level);
    grantKillXp(sim, e, pos.x, pos.y, sourceId);
    scoreKill(sim, e);
    return;
  }

  const m = w.minion.get(id);
  if (m) {
    sim.emit({ e: 'death', id, x: pos.x, y: pos.y, k: 'minion', color: MINION_DEFS[m.typeId].color, big: false }, pos.x, pos.y);
    const explode = affixValue(m.affixes, 'explodes_on_death');
    if (explode > 0) {
      const dmg = (MINIONS.explodeDamage * explode) / 100;
      sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: MINIONS.explodeRadius }, pos.x, pos.y);
      const r2 = MINIONS.explodeRadius * MINIONS.explodeRadius;
      for (const [eid] of w.enemy) {
        const ep = w.position.get(eid);
        if (ep && distSq(pos.x, pos.y, ep.x, ep.y) <= r2) dealDamage(sim, eid, dmg, id, ['fire']);
      }
    }
    const owner = w.player.get(m.ownerId);
    if (m.pack?.role === 'mate') onPackmateDeath(sim, m, id);
    else if (owner && owner.minions[m.slot] === id) {
      owner.minions[m.slot] = null;
      owner.minionRespawn[m.slot] = MINIONS.respawnSeconds * (1 - affixValue(m.affixes, 'faster_respawn') / 100);
      if (m.pack?.role === 'leader') onPackLeaderDeath(sim, m);
    }
    w.destroy(id);
  }
}

/** Ailment timers, burn ticks, shield decay and enemy regeneration. */
export function updateStatuses(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, st] of w.status) {
    if (!w.isAlive(id)) continue;
    if (st.burn) {
      dealDamage(sim, id, st.burn.dps * dt, st.burn.sourceId, ['fire'], { quiet: true });
      st.burn.t -= dt;
      if (st.burn.t <= 0) st.burn = null;
    }
    if (st.poison.length > 0) {
      for (const s of st.poison) {
        dealDamage(sim, id, s.dps * dt, s.sourceId, [], { quiet: true });
        s.t -= dt;
      }
      st.poison = st.poison.filter((s) => s.t > 0);
    }
    if (st.chill > 0) st.chill = Math.max(0, st.chill - dt);
    if (st.shock > 0) st.shock = Math.max(0, st.shock - dt);
    if (st.curse > 0) st.curse = Math.max(0, st.curse - dt);
    if (st.shield) {
      st.shield.t -= dt;
      if (st.shield.t <= 0) st.shield = null;
    }
  }
  for (const [id, e] of w.enemy) {
    const h = w.health.get(id);
    if (h && e.regenPercent > 0 && h.life > 0) h.life = Math.min(h.maxLife, h.life + (h.maxLife * e.regenPercent * dt) / 100);
  }
}
