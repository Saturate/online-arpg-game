import { HEAT, MINIONS, SIM, SPELL } from '../config/sim.js';
import type { PrimaryAttackDef } from '../data/classes.js';
import type { TriggerId } from '../data/runes.js';
import { misfireChance } from '../items/items.js';
import type { SpellFx } from '../protocol/messages.js';
import type { SpellNode } from '../runes/compiler.js';
import { acquireLink } from './auras.js';
import { blocksProjectile } from './enemies.js';
import { dealDamage, grantShield, healEntity, isTargetable, knockback, selfDamage } from './combat.js';
import type { EntityId, ProjectileComp, SpellInst, Team } from './ecs.js';
import { angleDiff, distSq } from './math.js';
import type { Simulation } from './simulation.js';

/** Reflected projectiles hit players for at most this much, so a big spell bounced back is not a one-shot. */
const REFLECT_DAMAGE_CAP = 12;
const REFLECT_LIFETIME = 1.5;

export function isOffensive(node: SpellNode): boolean {
  if (node.elements.length > 0 || node.effects.includes('impact')) return true;
  return !node.effects.includes('restore') && !node.effects.includes('ward');
}

export function spellFx(node: SpellNode): SpellFx {
  const offensive = isOffensive(node);
  const support = node.effects.includes('restore') || node.effects.includes('ward');
  if (offensive && support) return 'mixed';
  if (node.effects.includes('restore')) return 'heal';
  if (node.effects.includes('ward')) return 'ward';
  return 'damage';
}

function modPow(base: number, n: number): number {
  return n === 0 ? 1 : base ** n;
}

function spellDamage(sim: Simulation, node: SpellNode, casterId: EntityId, base: number): number {
  const combo = node.combos.includes('frostfire') ? 1 + SPELL.comboDamageBonus : 1;
  const bonus = 1 + (sim.world.buffs.get(casterId)?.elementDamageBonus ?? 0);
  const gear = sim.world.player.get(casterId)?.stats.damageMult ?? 1;
  return base * node.damageScale * node.tuning.damage * combo * bonus * gear;
}

// ---------------------------------------------------------------------------------------------
// Casting

export function castSkill(sim: Simulation, pid: EntityId, slot: number, pressed: boolean): void {
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  const h = w.health.get(pid);
  if (!p || !pos || !h || p.respawnIn !== null) return;
  const eq = p.sigils[slot];
  if (!eq) return;
  const res = eq.compiled;

  if (res.ok && res.persistent) {
    if (pressed && res.program.form === 'link') acquireLink(sim, pid, slot);
    return;
  }
  if (p.castCooldown > 0) return;

  if (!res.ok) {
    // Holding the key on a dud would drain heat every cast cooldown; only fizzle on a fresh press.
    if (!pressed) return;
    const cost = res.heat * HEAT.dudHeatFraction;
    if (p.heat + cost > p.stats.heatMax * (HEAT.overheatMax / HEAT.max)) return;
    p.heat += cost;
    p.heatPause = HEAT.coolPauseSeconds;
    p.castCooldown = HEAT.castCooldownSeconds;
    sim.emit({ e: 'fizzle', id: pid, x: pos.x, y: pos.y, why: 'dud', reason: res.dud }, pos.x, pos.y);
    return;
  }

  const overheatMax = p.stats.heatMax * (HEAT.overheatMax / HEAT.max);
  if (p.heat + res.heat > overheatMax) return;
  const chance = misfireChance(p.heat, eq.misfireMultiplier, p.stats.heatMax);
  p.heat += res.heat;
  p.heatPause = HEAT.coolPauseSeconds;
  p.castCooldown = HEAT.castCooldownSeconds / p.stats.castSpeedMult;
  if (chance > 0 && sim.rand.combat.next() < chance) {
    sim.emit({ e: 'fizzle', id: pid, x: pos.x, y: pos.y, why: 'misfire', reason: null }, pos.x, pos.y);
    selfDamage(sim, pid, h.maxLife * HEAT.misfireLifeFraction);
    return;
  }
  sim.emit({ e: 'cast', id: pid, x: pos.x, y: pos.y, el: res.program.elements[0] ?? null }, pos.x, pos.y);
  spawnSpell(sim, res.program, pid, pos.x, pos.y, p.aimAngle, null);
}

export function firePrimary(sim: Simulation, ownerId: EntityId, attack: PrimaryAttackDef, x: number, y: number, angle: number): void {
  const w = sim.world;
  sim.emit({ e: 'attack', id: ownerId }, x, y);
  if (attack.kind === 'bolt') {
    spawnProjectile(sim, {
      ownerId,
      team: 'players',
      x: x + Math.cos(angle) * SIM.playerRadius,
      y: y + Math.sin(angle) * SIM.playerRadius,
      angle,
      speed: attack.speed,
      radius: attack.radius,
      range: attack.range,
      damage: attack.damage * (w.player.get(ownerId)?.stats.damageMult ?? 1),
    });
    return;
  }

  const half = attack.arc / 2;
  for (const [eid] of w.enemy) {
    const epos = w.position.get(eid);
    if (!epos || !w.isAlive(eid)) continue;
    const reach = attack.range + (w.radius.get(eid) ?? 0) + SIM.enemyHitLeniency;
    if (distSq(x, y, epos.x, epos.y) > reach * reach) continue;
    if (Math.abs(angleDiff(Math.atan2(epos.y - y, epos.x - x), angle)) > half) continue;
    dealDamage(sim, eid, attack.damage * (w.player.get(ownerId)?.stats.damageMult ?? 1), ownerId, []);
  }
  const sid = w.create('swing');
  w.position.set(sid, { x, y });
  w.radius.set(sid, attack.range);
  w.swing.set(sid, { ownerId, angle, arc: attack.arc, range: attack.range, lifetime: SIM.swingVisualSeconds });
}

export interface ProjectileSpec {
  ownerId: EntityId;
  team: Team;
  x: number;
  y: number;
  angle: number;
  speed: number;
  radius: number;
  range: number;
  damage: number;
  partial?: Partial<ProjectileComp>;
}

export function spawnProjectile(sim: Simulation, spec: ProjectileSpec): EntityId {
  const w = sim.world;
  const id = w.create('projectile');
  w.position.set(id, { x: spec.x, y: spec.y });
  w.velocity.set(id, { x: Math.cos(spec.angle) * spec.speed, y: Math.sin(spec.angle) * spec.speed });
  w.radius.set(id, spec.radius);
  w.team.set(id, spec.team);
  w.projectile.set(id, {
    ownerId: spec.ownerId,
    damage: spec.damage,
    elements: [],
    lifetime: spec.range / spec.speed,
    pierceLeft: 0,
    hitIds: new Set(),
    knockback: 0,
    heal: 0,
    shield: 0,
    offensive: true,
    spell: null,
    ...spec.partial,
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Spawning spell forms

/** Spawns a node including its untriggered Split copies. */
export function spawnSpell(
  sim: Simulation,
  node: SpellNode,
  casterId: EntityId,
  x: number,
  y: number,
  angle: number,
  inheritHits: ReadonlySet<EntityId> | null,
): void {
  placeCopies(node, node.castSplit, x, y, angle, (cx, cy, ca) => spawnForm(sim, node, casterId, cx, cy, ca, inheritHits));
}

/** Directional forms fan out; others are placed in a ring so copies do not overlap exactly. */
function placeCopies(
  node: SpellNode,
  count: number,
  x: number,
  y: number,
  angle: number,
  place: (x: number, y: number, angle: number) => void,
): void {
  if (count <= 1) {
    place(x, y, angle);
    return;
  }
  for (let k = 0; k < count; k++) {
    if (node.form === 'bolt') {
      place(x, y, angle + (k - (count - 1) / 2) * SPELL.splitSpreadRadians);
    } else {
      const a = angle + (Math.PI * 2 * k) / count;
      place(x + Math.cos(a) * SPELL.splitRingOffset, y + Math.sin(a) * SPELL.splitRingOffset, angle);
    }
  }
}

function spawnForm(
  sim: Simulation,
  node: SpellNode,
  casterId: EntityId,
  x: number,
  y: number,
  angle: number,
  inheritHits: ReadonlySet<EntityId> | null,
): void {
  const w = sim.world;
  const m = node.modifiers;
  const inst: SpellInst = { node, casterId, age: 0, timerFired: false, angle, pulseTimer: SPELL.pulseSeconds, pulseCount: 0 };
  const team = w.team.get(casterId) ?? 'players';
  const hasRestore = node.effects.includes('restore');
  const hasWard = node.effects.includes('ward');
  const force = node.effects.includes('impact') ? SPELL.forceKnockback : 0;

  switch (node.form) {
    case 'bolt': {
      const t = node.tuning;
      const speed = SPELL.bolt.speed * modPow(SPELL.modifiers.swiftSpeed, m.swift) * t.speed;
      const range = SPELL.bolt.range * modPow(SPELL.modifiers.lingerDuration, m.linger) * t.range;
      spawnProjectile(sim, {
        ownerId: casterId,
        team,
        x,
        y,
        angle,
        speed,
        radius: SPELL.bolt.radius * modPow(SPELL.modifiers.largeRadius, m.large) * node.areaScale * t.radius,
        range,
        damage: spellDamage(sim, node, casterId, SPELL.bolt.damage),
        partial: {
          elements: [...node.elements],
          pierceLeft: t.phase > 0 ? Infinity : m.pierce * SPELL.modifiers.pierceHits,
          hitIds: new Set(inheritHits ?? []),
          knockback: force,
          heal: hasRestore ? SPELL.nova.heal * 0.6 * node.damageScale : 0,
          shield: hasWard ? SPELL.nova.shield * 0.6 * node.damageScale : 0,
          offensive: isOffensive(node),
          spell: inst,
        },
      });
      return;
    }
    case 'nova': {
      const id = w.create('nova');
      w.position.set(id, { x, y });
      w.radius.set(id, 0);
      w.team.set(id, team);
      w.nova.set(id, {
        spell: inst,
        maxRadius: SPELL.nova.radius * modPow(SPELL.modifiers.largeRadius, m.large) * node.areaScale * node.tuning.radius,
        duration: SPELL.nova.durationSeconds / modPow(SPELL.modifiers.swiftSpeed, m.swift),
        hitIds: new Set(inheritHits ?? []),
      });
      return;
    }
    case 'zone': {
      const id = w.create('zone');
      w.position.set(id, { x, y });
      w.radius.set(id, SPELL.zone.radius * modPow(SPELL.modifiers.largeRadius, m.large) * node.areaScale * node.tuning.radius);
      w.team.set(id, team);
      w.zone.set(id, {
        spell: inst,
        duration: SPELL.zone.durationSeconds * modPow(SPELL.modifiers.lingerDuration, m.linger) * node.tuning.range,
        tickInterval: SPELL.zone.tickSeconds / modPow(SPELL.modifiers.swiftSpeed, m.swift),
        tickTimer: 0,
      });
      return;
    }
    case 'dash': {
      const p = w.player.get(casterId);
      if (!p || p.dash || p.respawnIn !== null) return;
      const distance = SPELL.dash.distance * modPow(SPELL.modifiers.swiftDash, m.swift);
      const v = distance / (SPELL.dash.ticks * SIM.dt);
      p.dash = { vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, ticksLeft: SPELL.dash.ticks };
      p.dashSpell = { inst, hitIds: new Set(), hitFired: false };
      return;
    }
    case 'aura':
    case 'link':
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers

/** Fires the node's branch if it uses `trigger`. Returns true when the node was replaced by split copies. */
function fireTrigger(
  sim: Simulation,
  inst: SpellInst,
  trigger: TriggerId,
  x: number,
  y: number,
  angle: number,
  hitIds: ReadonlySet<EntityId> | null,
): boolean {
  const b = inst.node.branch;
  if (!b || b.trigger !== trigger) return false;
  if (trigger === 'timer') {
    if (inst.timerFired) return false;
    inst.timerFired = true;
  }
  if (b.action === 'split' && trigger === 'pulse') {
    // Pulse sprays copies outward in a rotating ring and keeps the parent alive.
    const base = inst.angle + inst.pulseCount * SPELL.pulseRotation;
    for (let k = 0; k < b.count; k++) spawnSpell(sim, b.node, inst.casterId, x, y, base + (Math.PI * 2 * k) / b.count, hitIds);
    inst.pulseCount++;
    return false;
  }
  if (b.action === 'split') {
    placeCopies(b.node, b.count, x, y, angle, (cx, cy, ca) => spawnSpell(sim, b.node, inst.casterId, cx, cy, ca, hitIds));
    return true;
  }
  spawnSpell(sim, b.node, inst.casterId, x, y, angle, hitIds);
  return false;
}

/**
 * Timer fires once after `timerSeconds`, or when the form ends if that comes first. Pulse fires
 * every `pulseSeconds` for as long as the form lives.
 */
function checkTimer(sim: Simulation, inst: SpellInst, x: number, y: number, angle: number, hits: ReadonlySet<EntityId> | null): boolean {
  if (inst.node.branch?.trigger === 'pulse') {
    inst.pulseTimer -= SIM.dt;
    if (inst.pulseTimer <= 0) {
      inst.pulseTimer += SPELL.pulseSeconds;
      // Pulse shards should not ignore what the orb already touched, so they get a fresh hit list.
      fireTrigger(sim, inst, 'pulse', x, y, angle, null);
    }
    return false;
  }
  if (inst.timerFired || inst.age < SPELL.timerSeconds) return false;
  return fireTrigger(sim, inst, 'timer', x, y, angle, hits);
}

function endSpell(sim: Simulation, inst: SpellInst, x: number, y: number, angle: number, hits: ReadonlySet<EntityId> | null): void {
  if (!inst.timerFired && fireTrigger(sim, inst, 'timer', x, y, angle, hits)) return;
  fireTrigger(sim, inst, 'onexpire', x, y, angle, hits);
}

// ---------------------------------------------------------------------------------------------
// Applying spell effects to targets

interface HitAmounts {
  damage: number;
  heal: number;
  shield: number;
}

function applySpellHit(sim: Simulation, inst: SpellInst, targetId: EntityId, fromX: number, fromY: number, amounts: HitAmounts): void {
  const w = sim.world;
  const node = inst.node;
  const casterTeam = w.team.get(inst.casterId) ?? 'players';
  const targetTeam = w.team.get(targetId);
  if (!targetTeam || !isTargetable(sim, targetId)) return;

  if (targetTeam === casterTeam) {
    if (node.effects.includes('restore')) healEntity(sim, targetId, amounts.heal * node.damageScale, true);
    if (node.effects.includes('ward')) {
      grantShield(sim, targetId, amounts.shield * node.damageScale, SPELL.shieldSeconds, node.combos.includes('burning_ward'));
    }
    return;
  }
  if (!isOffensive(node)) return;
  dealDamage(sim, targetId, spellDamage(sim, node, inst.casterId, amounts.damage), inst.casterId, node.elements);
  if (node.effects.includes('impact')) knockback(sim, targetId, fromX, fromY, SPELL.forceKnockback);
}

/** Everything a spell area can touch: enemies, players and minions. */
function* areaTargets(sim: Simulation): Generator<EntityId> {
  const w = sim.world;
  for (const id of w.enemy.keys()) yield id;
  for (const id of w.player.keys()) yield id;
  for (const id of w.minion.keys()) yield id;
}

// ---------------------------------------------------------------------------------------------
// Per-tick updates

export function updateProjectiles(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, proj] of w.projectile) {
    const pos = w.position.get(id);
    const vel = w.velocity.get(id);
    if (!pos || !vel || !w.isAlive(id)) continue;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    proj.lifetime -= dt;
    const angle = Math.atan2(vel.y, vel.x);
    const inst = proj.spell;

    if (inst) {
      inst.age += dt;
      if (checkTimer(sim, inst, pos.x, pos.y, angle, proj.hitIds)) {
        w.destroy(id);
        continue;
      }
    }
    const hitWall = sim.map.pointBlocked(pos.x, pos.y, Math.max(2, (w.radius.get(id) ?? 0) * 0.5), 'shots');
    if (proj.lifetime <= 0 || hitWall) {
      if (inst) endSpell(sim, inst, pos.x, pos.y, angle, proj.hitIds);
      w.destroy(id);
      continue;
    }

    const team = w.team.get(id);
    const r = w.radius.get(id) ?? 0;
    if (team === 'players') {
      if (hitEnemies(sim, id, proj, pos.x, pos.y, r, angle)) continue;
      if (proj.heal > 0 || proj.shield > 0) hitAllies(sim, id, proj, pos.x, pos.y, r, angle);
    } else {
      hitPlayersSide(sim, id, proj, pos.x, pos.y, r);
    }
  }
}

function consumeOrPierce(sim: Simulation, id: EntityId, proj: ProjectileComp, x: number, y: number, angle: number): boolean {
  if (proj.pierceLeft > 0) {
    proj.pierceLeft--;
    return false;
  }
  if (proj.spell) endSpell(sim, proj.spell, x, y, angle, proj.hitIds);
  sim.world.destroy(id);
  return true;
}

/** Returns true when the projectile is gone. */
function hitEnemies(sim: Simulation, id: EntityId, proj: ProjectileComp, x: number, y: number, r: number, angle: number): boolean {
  const w = sim.world;
  for (const [eid, enemy] of w.enemy) {
    if (proj.hitIds.has(eid) || !w.isAlive(eid) || enemy.burrowed) continue;
    const epos = w.position.get(eid);
    if (!epos) continue;
    const reach = r + (w.radius.get(eid) ?? 0) + SIM.enemyHitLeniency;
    if (distSq(x, y, epos.x, epos.y) > reach * reach) continue;
    proj.hitIds.add(eid);

    if (blocksProjectile(sim, eid, x - Math.cos(angle) * reach, y - Math.sin(angle) * reach)) {
      // A blocked shot flashes the shield and is spent, spell triggers included.
      sim.emit({ e: 'dmg', id: eid, amt: 0, x: epos.x, y: epos.y, el: null }, epos.x, epos.y);
      w.destroy(id);
      return true;
    }

    if (enemy.reflectChance > 0 && sim.rand.combat.next() < enemy.reflectChance) {
      reflect(sim, id, proj, eid);
      return true;
    }
    if (proj.offensive) {
      const inst = proj.spell;
      if (inst) applySpellHit(sim, inst, eid, x, y, { damage: SPELL.bolt.damage, heal: 0, shield: 0 });
      else dealDamage(sim, eid, proj.damage, proj.ownerId, proj.elements);
      if (!inst && proj.knockback > 0) knockback(sim, eid, x, y, proj.knockback);
    }
    if (proj.spell && fireTrigger(sim, proj.spell, 'onhit', epos.x, epos.y, angle, proj.hitIds)) {
      w.destroy(id);
      return true;
    }
    return consumeOrPierce(sim, id, proj, x, y, angle);
  }
  return false;
}

function hitAllies(sim: Simulation, id: EntityId, proj: ProjectileComp, x: number, y: number, r: number, angle: number): void {
  const w = sim.world;
  const inst = proj.spell;
  if (!inst) return;
  const allies = [...w.player.keys(), ...w.minion.keys()];
  for (const aid of allies) {
    if (aid === proj.ownerId || proj.hitIds.has(aid) || !isTargetable(sim, aid)) continue;
    const apos = w.position.get(aid);
    if (!apos) continue;
    const reach = r + (w.radius.get(aid) ?? 0);
    if (distSq(x, y, apos.x, apos.y) > reach * reach) continue;
    proj.hitIds.add(aid);
    applySpellHit(sim, inst, aid, x, y, { damage: 0, heal: SPELL.nova.heal * 0.6, shield: SPELL.nova.shield * 0.6 });
    consumeOrPierce(sim, id, proj, x, y, angle);
    return;
  }
}

/** Enemy bullets. Bodyguard minions are checked first with a bigger hitbox so they intercept shots aimed at their master. */
function hitPlayersSide(sim: Simulation, id: EntityId, proj: ProjectileComp, x: number, y: number, r: number): void {
  const w = sim.world;
  const candidates: { tid: EntityId; bonus: number }[] = [];
  for (const [mid, m] of w.minion) {
    candidates.push({ tid: mid, bonus: m.behaviour === 'bodyguard' ? MINIONS.bodyguardInterceptBonus : 0 });
  }
  candidates.sort((a, b) => b.bonus - a.bonus);
  for (const pid of w.player.keys()) candidates.push({ tid: pid, bonus: 0 });

  for (const { tid, bonus } of candidates) {
    if (!isTargetable(sim, tid)) continue;
    const tpos = w.position.get(tid);
    if (!tpos) continue;
    const reach = r + (w.radius.get(tid) ?? 0) + bonus;
    if (distSq(x, y, tpos.x, tpos.y) > reach * reach) continue;
    dealDamage(sim, tid, proj.damage, proj.ownerId, proj.elements);
    w.destroy(id);
    return;
  }
}

function reflect(sim: Simulation, id: EntityId, proj: ProjectileComp, enemyId: EntityId): void {
  const w = sim.world;
  const vel = w.velocity.get(id);
  if (vel) {
    vel.x = -vel.x;
    vel.y = -vel.y;
  }
  w.team.set(id, 'enemies');
  proj.ownerId = enemyId;
  proj.damage = Math.min(proj.damage, REFLECT_DAMAGE_CAP);
  proj.hitIds.clear();
  proj.spell = null;
  proj.heal = 0;
  proj.shield = 0;
  proj.offensive = true;
  proj.lifetime = REFLECT_LIFETIME;
}

export function updateNovas(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, nova] of w.nova) {
    const pos = w.position.get(id);
    if (!pos || !w.isAlive(id)) continue;
    const inst = nova.spell;
    inst.age += dt;
    const radius = nova.maxRadius * Math.min(1, inst.age / nova.duration);
    w.radius.set(id, radius);

    for (const tid of areaTargets(sim)) {
      if (nova.hitIds.has(tid)) continue;
      const tpos = w.position.get(tid);
      if (!tpos) continue;
      const reach = radius + (w.radius.get(tid) ?? 0);
      if (distSq(pos.x, pos.y, tpos.x, tpos.y) > reach * reach) continue;
      nova.hitIds.add(tid);
      applySpellHit(sim, inst, tid, pos.x, pos.y, { damage: SPELL.nova.damage, heal: SPELL.nova.heal, shield: SPELL.nova.shield });
    }

    if (checkTimer(sim, inst, pos.x, pos.y, inst.angle, nova.hitIds)) {
      w.destroy(id);
      continue;
    }
    if (inst.age >= nova.duration) {
      endSpell(sim, inst, pos.x, pos.y, inst.angle, nova.hitIds);
      w.destroy(id);
    }
  }
}

export function updateZones(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, zone] of w.zone) {
    const pos = w.position.get(id);
    const radius = w.radius.get(id) ?? 0;
    if (!pos || !w.isAlive(id)) continue;
    const inst = zone.spell;
    inst.age += dt;
    zone.tickTimer -= dt;
    if (zone.tickTimer <= 0) {
      zone.tickTimer += zone.tickInterval;
      for (const tid of areaTargets(sim)) {
        const tpos = w.position.get(tid);
        if (!tpos) continue;
        const reach = radius + (w.radius.get(tid) ?? 0);
        if (distSq(pos.x, pos.y, tpos.x, tpos.y) > reach * reach) continue;
        applySpellHit(sim, inst, tid, pos.x, pos.y, { damage: SPELL.zone.damage, heal: SPELL.zone.heal, shield: SPELL.zone.shield });
      }
    }
    if (checkTimer(sim, inst, pos.x, pos.y, inst.angle, null)) {
      w.destroy(id);
      continue;
    }
    if (inst.age >= zone.duration) {
      endSpell(sim, inst, pos.x, pos.y, inst.angle, null);
      w.destroy(id);
    }
  }
}

/** Runs inside input processing so dash hits line up with the movement step that caused them. */
export function updateDashSpell(sim: Simulation, pid: EntityId, dt: number, landed: boolean): void {
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  if (!p || !pos || !p.dashSpell) return;
  const ds = p.dashSpell;
  const inst = ds.inst;
  inst.age += dt;

  for (const [eid] of w.enemy) {
    if (ds.hitIds.has(eid) || !w.isAlive(eid)) continue;
    const epos = w.position.get(eid);
    if (!epos) continue;
    const reach = SPELL.dash.hitRadius + (w.radius.get(eid) ?? 0);
    if (distSq(pos.x, pos.y, epos.x, epos.y) > reach * reach) continue;
    ds.hitIds.add(eid);
    applySpellHit(sim, inst, eid, pos.x, pos.y, { damage: SPELL.dash.damage, heal: 0, shield: 0 });
    if (!ds.hitFired) {
      ds.hitFired = true;
      fireTrigger(sim, inst, 'onhit', epos.x, epos.y, inst.angle, ds.hitIds);
    }
  }
  checkTimer(sim, inst, pos.x, pos.y, inst.angle, ds.hitIds);

  if (landed) {
    p.dashSpell = null;
    if (inst.node.effects.includes('restore')) healEntity(sim, pid, SPELL.nova.heal * 0.5 * inst.node.damageScale, true);
    if (inst.node.effects.includes('ward')) {
      grantShield(sim, pid, SPELL.nova.shield * 0.5 * inst.node.damageScale, SPELL.shieldSeconds, inst.node.combos.includes('burning_ward'));
    }
    fireTrigger(sim, inst, 'onland', pos.x, pos.y, inst.angle, ds.hitIds);
    if (!inst.timerFired) fireTrigger(sim, inst, 'timer', pos.x, pos.y, inst.angle, ds.hitIds);
  }
}
