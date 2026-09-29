import { MINIONS, NAV } from '../config/sim.js';
import { affixValue, behaviourOf } from '../items/items.js';
import { dealDamage, healEntity, isTargetable } from './combat.js';
import { emptyBuffs, emptyStatus, type EntityId, type MinionComp } from './ecs.js';
import { distSq, type Vec2 } from './math.js';
import type { Simulation } from './simulation.js';
import { spawnProjectile } from './spells.js';

const TAUNT_PULSE_SECONDS = 1;
const ARRIVE_DISTANCE = 12;

export function spawnMinion(sim: Simulation, ownerId: EntityId, slot: number): EntityId | null {
  const w = sim.world;
  const owner = w.player.get(ownerId);
  const opos = w.position.get(ownerId);
  if (!owner || !opos) return null;
  const uid = owner.warband[slot];
  const item = uid === null || uid === undefined ? undefined : owner.items.get(uid);
  if (!item || item.kind !== 'vessel') return null;

  const def = sim.tuning.minion(item.minion);
  const levelMult = 1 + MINIONS.levelScaling * (item.level - 1);
  const life = Math.round(def.life * MINIONS.lifeMultiplier * levelMult * (1 + affixValue(item.affixes, 'armored') / 100) * owner.stats.minionLifeMult);
  const a = (Math.PI * 2 * slot) / MINIONS.warbandSlots;

  const id = w.create('minion');
  w.position.set(id, sim.map.findOpen(opos.x + Math.cos(a) * MINIONS.spawnOffset, opos.y + Math.sin(a) * MINIONS.spawnOffset, def.radius));
  w.radius.set(id, def.radius);
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
    attackCooldownBase: def.attackCooldown / (1 + affixValue(item.affixes, 'attack_speed') / 100),
    damage: def.damage * MINIONS.damageMultiplier * levelMult * owner.stats.minionDamageMult,
    moveSpeed: def.moveSpeed * (1 + affixValue(item.affixes, 'hasted') / 100),
    tauntTimer: 0,
    lostSightTicks: 0,
  });
  owner.minions[slot] = id;
  return id;
}

export function despawnMinion(sim: Simulation, ownerId: EntityId, slot: number): void {
  const owner = sim.world.player.get(ownerId);
  const mid = owner?.minions[slot];
  if (!owner || mid === null || mid === undefined) return;
  sim.world.destroy(mid);
  owner.minions[slot] = null;
}

export function updateMinionRespawns(sim: Simulation, dt: number): void {
  for (const [pid, p] of sim.world.player) {
    for (let slot = 0; slot < p.warband.length; slot++) {
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
 * Walks toward a goal around obstacles. With line of sight it goes straight; otherwise it follows
 * the master's breadcrumb trail, picking the newest crumb it can see, which is always a route the
 * master actually walked.
 */
function navigate(sim: Simulation, pos: Vec2, radius: number, goal: Vec2, trail: readonly Vec2[], step: number, stopAt: number): void {
  if (sim.map.lineClear(pos.x, pos.y, goal.x, goal.y, radius * 0.8, 'move')) {
    stepToward(pos, goal.x, goal.y, step, stopAt);
    return;
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    const c = trail[i];
    if (c && sim.map.lineClear(pos.x, pos.y, c.x, c.y, radius * 0.8, 'move')) {
      stepToward(pos, c.x, c.y, step, 4);
      return;
    }
  }
  stepToward(pos, goal.x, goal.y, step, stopAt);
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

export function updateMinions(sim: Simulation, dt: number): void {
  const w = sim.world;
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
    if (m.attackCooldown > 0) m.attackCooldown -= dt;
    // Road bonus applies per tick; the stored base speed never changes.
    const speed = m.moveSpeed * sim.map.speedAt(pos.x, pos.y);

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
      const p = sim.map.findOpen(opos.x + 30, opos.y + 30, def.radius);
      pos.x = p.x;
      pos.y = p.y;
      m.targetId = null;
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
      navigate(sim, pos, def.radius, opos, owner.trail, speed * dt, MINIONS.followDistance * 0.5);
      healEntity(sim, id, h.maxLife * MINIONS.cowardRegenFraction * dt, false);
      settle(sim, pos, def.radius);
      continue;
    }

    if (m.behaviour === 'bodyguard') {
      const block = interceptPoint(sim, opos);
      if (block) {
        stepToward(pos, block.x, block.y, speed * 1.4 * dt, 2);
        settle(sim, pos, def.radius);
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

    const target = m.targetId;
    const tpos = target === null ? undefined : w.position.get(target);
    if (target !== null && tpos) {
      m.state = 'engage';
      const dist = Math.sqrt(distSq(pos.x, pos.y, tpos.x, tpos.y));
      const reach = def.attackRange + def.radius + (w.radius.get(target) ?? 0);
      if (def.ranged) {
        const canShoot = sim.map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 4, 'shots');
        if (!canShoot || dist > def.attackRange) {
          // Reposition until there is a clear shot, walking around whatever is in the way.
          navigate(sim, pos, def.radius, tpos, owner.trail, speed * dt, def.attackRange * 0.8);
        } else if (dist < def.kiteDistance) {
          const away = { x: pos.x + (pos.x - tpos.x), y: pos.y + (pos.y - tpos.y) };
          const before = { x: pos.x, y: pos.y };
          stepToward(pos, away.x, away.y, speed * dt, 0);
          // Backing into a wall is worse than standing ground; kite sideways instead.
          if (sim.map.pointBlocked(pos.x, pos.y, def.radius, 'move')) {
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
              speed: def.projectileSpeed,
              radius: MINIONS.arrowRadius,
              range: def.attackRange * MINIONS.arrowRangeMultiplier,
              damage: m.damage,
            });
          }
        }
      } else {
        navigate(sim, pos, def.radius, tpos, owner.trail, speed * dt, reach - 4);
        if (dist <= reach && m.attackCooldown <= 0) {
          m.attackCooldown = m.attackCooldownBase;
          sim.emit({ e: 'attack', id }, pos.x, pos.y);
          dealDamage(sim, target, m.damage, id, []);
        }
      }
    } else {
      m.state = 'follow';
      const goal = formationPoint(owner, opos, m.slot, m.behaviour === 'bodyguard');
      // Minions sprint to catch up when far behind, so they do not trail across the map.
      const catchUp = ownerDist2 > MINIONS.catchUpDistance ** 2 ? MINIONS.catchUpSpeedMultiplier : 1;
      navigate(sim, pos, def.radius, goal, owner.trail, speed * catchUp * dt, ARRIVE_DISTANCE);
    }
    settle(sim, pos, def.radius);
  }
  separateMinions(sim);
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
