import { HEAT, MINIONS, SIM, SPELL } from '../config/sim.js';
import { castCooldownSeconds, misfireChance } from '../items/items.js';
import type { SpellFx } from '../protocol/messages.js';
import { projectileBase, type ReleaseTrigger, type SpellNode, type SpellProgram } from './program.js';
import { acquireLink } from './auras.js';
import { withinHurt } from './body.js';
import { blocksProjectile } from './enemies.js';
import { dealDamage, grantShield, healEntity, isTargetable, knockback, selfDamage } from './combat.js';
import type { EntityId, PlayerComp, ProjectileComp, SpellInst, Team } from './ecs.js';
import { distSq } from './math.js';
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

/** Float slack for timers counted down in 0.05 s ticks, so 0.5 s is ten ticks and not eleven. */
const TIME_EPS = 1e-6;

function spellDamage(sim: Simulation, node: SpellNode, casterId: EntityId, base: number): number {
  const combo = node.combos.includes('frostfire') ? 1 + SPELL.comboDamageBonus : 1;
  const bonus = 1 + (sim.world.buffs.get(casterId)?.elementDamageBonus ?? 0);
  const gear = sim.world.player.get(casterId)?.stats.damageMult ?? 1;
  return base * node.damageScale * node.tuning.damage * combo * bonus * gear;
}

// ---------------------------------------------------------------------------------------------
// Casting

/**
 * Full length of the cooldown each player's last cast or fizzle set. Sigils differ in cast delay, so
 * the HUD measures the running cooldown against this rather than each slot's own delay.
 */
const castCooldownLengths = new WeakMap<Simulation, Map<EntityId, number>>();

export function castCooldownLength(sim: Simulation, pid: EntityId): number {
  return castCooldownLengths.get(sim)?.get(pid) ?? 0;
}

function startCastCooldown(sim: Simulation, pid: EntityId, p: PlayerComp, castDelayShare: number): void {
  const seconds = castCooldownSeconds(sim.rates.castCooldown, castDelayShare, p.stats.castSpeedMult);
  p.castCooldown = seconds;
  const lengths = castCooldownLengths.get(sim) ?? new Map<EntityId, number>();
  lengths.set(pid, seconds);
  castCooldownLengths.set(sim, lengths);
}

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
    if (pressed && res.program.form === 'bond') acquireLink(sim, pid, slot);
    return;
  }
  if (p.castCooldown > 0) return;

  if (!res.ok) {
    // Holding the key on a dud would drain heat every cast cooldown; only fizzle on a fresh press.
    if (!pressed) return;
    const cost = res.force * HEAT.dudHeatFraction * sim.rates.forceCost;
    if (p.heat + cost > p.stats.heatMax * (HEAT.overheatMax / HEAT.max)) return;
    p.heat += cost;
    p.heatPause = HEAT.coolPauseSeconds;
    startCastCooldown(sim, pid, p, eq.castDelayShare);
    sim.emit({ e: 'fizzle', id: pid, x: pos.x, y: pos.y, why: 'dud', reason: res.errors[0]?.rule ?? null }, pos.x, pos.y);
    return;
  }

  const overheatMax = p.stats.heatMax * (HEAT.overheatMax / HEAT.max);
  const cost = res.force * sim.rates.forceCost;
  if (p.heat + cost > overheatMax) return;
  const chance = misfireChance(p.heat, eq.misfireMultiplier, p.stats.heatMax);
  p.heat += cost;
  p.heatPause = HEAT.coolPauseSeconds;
  startCastCooldown(sim, pid, p, eq.castDelayShare);
  if (chance > 0 && sim.rand.combat.next() < chance) {
    sim.emit({ e: 'fizzle', id: pid, x: pos.x, y: pos.y, why: 'misfire', reason: null }, pos.x, pos.y);
    selfDamage(sim, pid, h.maxLife * HEAT.misfireLifeFraction);
    return;
  }
  sim.emit({ e: 'cast', id: pid, x: pos.x, y: pos.y, el: res.program.roots[0]?.elements[0] ?? null }, pos.x, pos.y);
  spawnProgram(sim, res.program, pid, pos.x, pos.y, p.aimAngle);
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

/** Spawns a whole cast: shapes cast together (multicast) all leave from one point on one aim. */
export function spawnProgram(sim: Simulation, program: SpellProgram, casterId: EntityId, x: number, y: number, angle: number): void {
  for (const root of program.roots) spawnSpell(sim, root, casterId, x, y, angle, null);
}

/** Spawns a node including its Split copies. */
export function spawnSpell(
  sim: Simulation,
  node: SpellNode,
  casterId: EntityId,
  x: number,
  y: number,
  angle: number,
  inheritHits: ReadonlySet<EntityId> | null,
): void {
  placeCopies(node, node.copies, x, y, angle, (cx, cy, ca) => spawnForm(sim, node, casterId, cx, cy, ca, inheritHits));
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
    if (node.form === 'bolt' || node.form === 'orb') {
      place(x, y, angle + (k - (count - 1) / 2) * SPELL.splitSpreadRadians);
    } else {
      const a = angle + (Math.PI * 2 * k) / count;
      place(x + Math.cos(a) * SPELL.splitRingOffset, y + Math.sin(a) * SPELL.splitRingOffset, angle);
    }
  }
}

/** Whether a spell entity still has something to release: ending it early would cut its payload. */
function carriesPayload(inst: SpellInst): boolean {
  return inst.node.payload.length > 0 && !inst.timerFired;
}

interface LiveSpell {
  id: EntityId;
  inst: SpellInst;
  weight: number;
}

interface CasterLoad {
  /** In spawn order, so the front is the oldest. May hold entries that already ended until pruned. */
  live: LiveSpell[];
  load: number;
}

/**
 * Running live-cap counts per caster and per room. Spawning only adds; entries that ended are
 * dropped the next time a count would pass its cap, so a spawn under the cap costs nothing extra.
 */
interface SpellLedger {
  casters: Map<EntityId, CasterLoad>;
  load: number;
}

const ledgers = new WeakMap<Simulation, SpellLedger>();

function ledgerOf(sim: Simulation): SpellLedger {
  let l = ledgers.get(sim);
  if (!l) {
    l = { casters: new Map(), load: 0 };
    ledgers.set(sim, l);
  }
  return l;
}

/** The entity still exists and still runs this spell (a reflected projectile has left it). */
function stillLive(sim: Simulation, e: LiveSpell): boolean {
  const w = sim.world;
  if (!w.isAlive(e.id)) return false;
  return (w.projectile.get(e.id)?.spell ?? w.nova.get(e.id)?.spell ?? w.zone.get(e.id)?.spell) === e.inst;
}

function prune(sim: Simulation, ledger: SpellLedger, casterId: EntityId, c: CasterLoad): void {
  const kept = c.live.filter((e) => stillLive(sim, e));
  const load = kept.reduce((n, e) => n + e.weight, 0);
  ledger.load += load - c.load;
  c.live = kept;
  c.load = load;
  if (kept.length === 0) ledger.casters.delete(casterId);
}

/** Ends the caster's oldest spent piece, or their oldest carrier when every piece still carries a payload. */
function evictOldest(sim: Simulation, ledger: SpellLedger, c: CasterLoad): boolean {
  let at = c.live.findIndex((e) => !carriesPayload(e.inst));
  if (at < 0) at = c.live.length > 0 ? 0 : -1;
  const e = c.live[at];
  if (!e) return false;
  c.live.splice(at, 1);
  c.load -= e.weight;
  ledger.load -= e.weight;
  sim.world.destroy(e.id);
  return true;
}

/**
 * Keeps a caster under their live spell cap and the room under its own, by ending the oldest spell
 * entities first, so a big payload spell stays castable but can never flood the room. Spent pieces
 * (a Frozen Orb's shards) go before carriers (the orb still spraying them). Over the room cap, the
 * caster with the most alive gives way first.
 */
function makeRoomForSpell(sim: Simulation, casterId: EntityId, weight: number): void {
  const ledger = ledgerOf(sim);
  const mine = ledger.casters.get(casterId);
  if (mine && mine.load + weight > SPELL.liveCap.max) {
    prune(sim, ledger, casterId, mine);
    while (mine.load + weight > SPELL.liveCap.max && evictOldest(sim, ledger, mine));
  }
  if (ledger.load + weight <= SPELL.liveCap.roomMax) return;
  for (const [id, c] of ledger.casters) prune(sim, ledger, id, c);
  while (ledger.load + weight > SPELL.liveCap.roomMax) {
    let heaviest: CasterLoad | undefined;
    for (const c of ledger.casters.values()) if (!heaviest || c.load > heaviest.load) heaviest = c;
    if (!heaviest || !evictOldest(sim, ledger, heaviest)) break;
  }
}

function recordSpell(sim: Simulation, id: EntityId, inst: SpellInst, weight: number): void {
  const ledger = ledgerOf(sim);
  let c = ledger.casters.get(inst.casterId);
  if (!c) {
    c = { live: [], load: 0 };
    ledger.casters.set(inst.casterId, c);
  }
  c.live.push({ id, inst, weight });
  c.load += weight;
  ledger.load += weight;
}

/** Weighted live spell load of a caster and of the room, counting only entities still alive. */
export function liveSpellLoad(sim: Simulation, casterId: EntityId): { caster: number; room: number } {
  const ledger = ledgerOf(sim);
  for (const [id, c] of ledger.casters) prune(sim, ledger, id, c);
  return { caster: ledger.casters.get(casterId)?.load ?? 0, room: ledger.load };
}

/**
 * Spells of a caster who is no longer in the room (zone change, disconnect) end with them: their
 * entities go and their delayed payloads never fire. Checked once per tick over casters with spells
 * alive, not over every entity.
 */
function endSpellsOfDeparted(sim: Simulation): void {
  const w = sim.world;
  const ledger = ledgers.get(sim);
  if (ledger) {
    for (const [id, c] of ledger.casters) {
      if (w.player.has(id)) continue;
      for (const e of c.live) if (stillLive(sim, e)) w.destroy(e.id);
      ledger.load -= c.load;
      ledger.casters.delete(id);
    }
  }
  const list = delayedReleases.get(sim);
  if (list && list.some((d) => !w.player.has(d.inst.casterId))) {
    delayedReleases.set(
      sim,
      list.filter((d) => w.player.has(d.inst.casterId)),
    );
  }
}

function liveWeight(node: SpellNode): number {
  if (node.form === 'bolt' || node.form === 'orb') return SPELL.liveCap.projectile;
  if (node.form === 'nova') return SPELL.liveCap.nova;
  if (node.form === 'zone') return SPELL.liveCap.zone;
  return 0;
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
  const weight = liveWeight(node);
  if (weight > 0) makeRoomForSpell(sim, casterId, weight);
  const t = node.tuning;
  const every = node.release?.kind === 'every' ? node.release.seconds : 0;
  const inst: SpellInst = { node, casterId, age: 0, timerFired: false, angle, pulseTimer: every, pulseCount: 0 };
  const team = w.team.get(casterId) ?? 'players';
  const hasRestore = node.effects.includes('restore');
  const hasWard = node.effects.includes('ward');
  const force = node.effects.includes('impact') ? SPELL.forceKnockback : 0;

  switch (node.form) {
    case 'orb':
    case 'bolt': {
      const base = projectileBase(node.form);
      const id = spawnProjectile(sim, {
        ownerId: casterId,
        team,
        x,
        y,
        angle,
        speed: base.speed * t.speed,
        radius: base.radius * node.areaScale * t.radius,
        range: base.range * t.range,
        damage: spellDamage(sim, node, casterId, base.damage),
        partial: {
          elements: [...node.elements],
          pierceLeft: t.phase > 0 ? Infinity : node.pierce,
          hitIds: new Set(inheritHits ?? []),
          knockback: force,
          heal: hasRestore ? SPELL.nova.heal * 0.6 * node.damageScale : 0,
          shield: hasWard ? SPELL.nova.shield * 0.6 * node.damageScale : 0,
          offensive: isOffensive(node),
          spell: inst,
        },
      });
      recordSpell(sim, id, inst, weight);
      return;
    }
    case 'nova': {
      const id = w.create('nova');
      w.position.set(id, { x, y });
      w.radius.set(id, 0);
      w.team.set(id, team);
      w.nova.set(id, {
        spell: inst,
        maxRadius: SPELL.nova.radius * node.areaScale * t.radius,
        duration: (SPELL.nova.durationSeconds * t.range) / t.speed,
        hitIds: new Set(inheritHits ?? []),
      });
      recordSpell(sim, id, inst, weight);
      return;
    }
    case 'zone': {
      const id = w.create('zone');
      w.position.set(id, { x, y });
      w.radius.set(id, SPELL.zone.radius * node.areaScale * t.radius);
      w.team.set(id, team);
      w.zone.set(id, {
        spell: inst,
        duration: SPELL.zone.durationSeconds * t.range,
        tickInterval: SPELL.zone.tickSeconds / t.speed,
        tickTimer: 0,
      });
      recordSpell(sim, id, inst, weight);
      return;
    }
    case 'dash': {
      const p = w.player.get(casterId);
      if (!p || p.dash || p.respawnIn !== null) return;
      const distance = SPELL.dash.distance * t.speed;
      const v = distance / (SPELL.dash.ticks * SIM.dt);
      p.dash = { vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, ticksLeft: SPELL.dash.ticks };
      p.dashSpell = { inst, hitIds: new Set(), hitFired: false };
      return;
    }
    case 'aura':
    case 'bond':
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Releases

/** Spawns a node's payload where it released. Every payload shape goes off together. */
function releasePayload(sim: Simulation, inst: SpellInst, x: number, y: number, angle: number, hitIds: ReadonlySet<EntityId> | null): void {
  const every = inst.node.release?.kind === 'every';
  for (const child of inst.node.payload) {
    if (every && child.copies > 1) {
      // Released every X s, split copies spray outward in a rotating ring (Frozen Orb) instead of a fan.
      const base = inst.angle + inst.pulseCount * SPELL.pulseRotation;
      for (let k = 0; k < child.copies; k++) spawnForm(sim, child, inst.casterId, x, y, base + (Math.PI * 2 * k) / child.copies, hitIds);
    } else {
      spawnSpell(sim, child, inst.casterId, x, y, angle, hitIds);
    }
  }
  if (every) inst.pulseCount++;
}

/** Releases the payload if the node releases on `trigger`. `after` releases once. */
function release(sim: Simulation, inst: SpellInst, trigger: ReleaseTrigger, x: number, y: number, angle: number, hitIds: ReadonlySet<EntityId> | null): void {
  const r = inst.node.release;
  if (!r || r.kind !== trigger || inst.node.payload.length === 0) return;
  if (trigger === 'after') {
    if (inst.timerFired) return;
    inst.timerFired = true;
  }
  releasePayload(sim, inst, x, y, angle, hitIds);
}

/**
 * `after X s` payloads whose shape ended first: they still go off X s after the shape spawned, where
 * it ended, so a 0.3 s nova with "after 0.5 s" releases 0.2 s after its ring is gone.
 */
interface DelayedRelease {
  inst: SpellInst;
  x: number;
  y: number;
  angle: number;
  hitIds: ReadonlySet<EntityId> | null;
  left: number;
}

const delayedReleases = new WeakMap<Simulation, DelayedRelease[]>();

/** Payloads of this caster still waiting on their `after` time, for tools that wait for a cast to finish. */
export function pendingReleases(sim: Simulation, casterId: EntityId): number {
  return (delayedReleases.get(sim) ?? []).filter((d) => d.inst.casterId === casterId).length;
}

function updateDelayedReleases(sim: Simulation, dt: number): void {
  const list = delayedReleases.get(sim);
  if (!list || list.length === 0) return;
  const due: DelayedRelease[] = [];
  const keep: DelayedRelease[] = [];
  for (const d of list) {
    d.left -= dt;
    (d.left <= TIME_EPS ? due : keep).push(d);
  }
  delayedReleases.set(sim, keep);
  for (const d of due) release(sim, d.inst, 'after', d.x, d.y, d.angle, d.hitIds);
}

/** `every` fires on its interval for as long as the form lives; `after` fires once at its time. */
function checkTimer(sim: Simulation, inst: SpellInst, x: number, y: number, angle: number, hits: ReadonlySet<EntityId> | null): void {
  const r = inst.node.release;
  if (!r) return;
  if (r.kind === 'every') {
    inst.pulseTimer -= SIM.dt;
    if (inst.pulseTimer <= TIME_EPS) {
      inst.pulseTimer += r.seconds;
      // Released shards should not ignore what the parent already touched, so they get a fresh hit list.
      release(sim, inst, 'every', x, y, angle, null);
    }
    return;
  }
  if (r.kind === 'after' && !inst.timerFired && inst.age >= r.seconds - TIME_EPS) release(sim, inst, 'after', x, y, angle, hits);
}

function endSpell(sim: Simulation, inst: SpellInst, x: number, y: number, angle: number, hits: ReadonlySet<EntityId> | null): void {
  const r = inst.node.release;
  if (r?.kind === 'after' && !inst.timerFired && inst.node.payload.length > 0) {
    const left = r.seconds - inst.age;
    if (left <= TIME_EPS) release(sim, inst, 'after', x, y, angle, hits);
    else {
      const list = delayedReleases.get(sim) ?? [];
      list.push({ inst, x, y, angle, hitIds: hits ? new Set(hits) : null, left });
      delayedReleases.set(sim, list);
    }
    return;
  }
  release(sim, inst, 'onexpire', x, y, angle, hits);
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
  // Projectiles run first of the spell systems, so delayed payloads join this tick's updates.
  endSpellsOfDeparted(sim);
  updateDelayedReleases(sim, dt);
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
      checkTimer(sim, inst, pos.x, pos.y, angle, proj.hitIds);
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
    if (!withinHurt(sim, eid, x, y, r + SIM.enemyHitLeniency)) continue;
    const reach = r + (w.radius.get(eid) ?? 0) + SIM.enemyHitLeniency;
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
      if (inst) applySpellHit(sim, inst, eid, x, y, { damage: projectileBase(inst.node.form === 'orb' ? 'orb' : 'bolt').damage, heal: 0, shield: 0 });
      else dealDamage(sim, eid, proj.damage, proj.ownerId, proj.elements);
      if (!inst && proj.knockback > 0) knockback(sim, eid, x, y, proj.knockback);
    }
    if (proj.spell) release(sim, proj.spell, 'onhit', epos.x, epos.y, angle, proj.hitIds);
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

/** The player side's targets for enemy bullets, bodyguards first. Built once per tick, not per bullet. */
const bulletTargets = new WeakMap<Simulation, { tick: number; list: { tid: EntityId; bonus: number }[] }>();

function playerSideTargets(sim: Simulation): { tid: EntityId; bonus: number }[] {
  const cached = bulletTargets.get(sim);
  if (cached?.tick === sim.tick) return cached.list;
  const w = sim.world;
  const list: { tid: EntityId; bonus: number }[] = [];
  for (const [mid, m] of w.minion) list.push({ tid: mid, bonus: m.behaviour === 'bodyguard' ? MINIONS.bodyguardInterceptBonus : 0 });
  list.sort((a, b) => b.bonus - a.bonus);
  for (const pid of w.player.keys()) list.push({ tid: pid, bonus: 0 });
  bulletTargets.set(sim, { tick: sim.tick, list });
  return list;
}

/** Enemy bullets. Bodyguard minions are checked first with a bigger hitbox so they intercept shots aimed at their master. */
function hitPlayersSide(sim: Simulation, id: EntityId, proj: ProjectileComp, x: number, y: number, r: number): void {
  const w = sim.world;
  for (const { tid, bonus } of playerSideTargets(sim)) {
    const tpos = w.position.get(tid);
    if (!tpos) continue;
    const reach = r + (w.radius.get(tid) ?? 0) + bonus;
    // Distance first: isTargetable is the costlier check and most targets are far from the bullet.
    if (distSq(x, y, tpos.x, tpos.y) > reach * reach) continue;
    if (!isTargetable(sim, tid)) continue;
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
      if (!withinHurt(sim, tid, pos.x, pos.y, radius)) continue;
      nova.hitIds.add(tid);
      applySpellHit(sim, inst, tid, pos.x, pos.y, { damage: SPELL.nova.damage, heal: SPELL.nova.heal, shield: SPELL.nova.shield });
    }

    checkTimer(sim, inst, pos.x, pos.y, inst.angle, nova.hitIds);
    if (inst.age >= nova.duration) {
      endSpell(sim, inst, pos.x, pos.y, inst.angle, nova.hitIds);
      w.destroy(id);
    }
  }
}

/**
 * When each target may next be hit by each caster's zones of one kind. A target takes one tick per
 * caster, per kind, per tick interval, however many of those zones it stands in, or splitting into
 * zones would multiply damage. Different casters still stack, so parties gain from layering them.
 */
const zoneLockouts = new WeakMap<Simulation, Map<EntityId, Map<string, number>>>();

function zoneKind(inst: SpellInst): string {
  const n = inst.node;
  return `${inst.casterId}|${[...n.elements].sort().join('+')}|${[...n.effects].sort().join('+')}`;
}

/** True when the zone may tick this target now, and records the tick if so. */
function takeZoneTick(sim: Simulation, targetId: EntityId, kind: string, interval: number): boolean {
  let byTarget = zoneLockouts.get(sim);
  if (!byTarget) {
    byTarget = new Map();
    zoneLockouts.set(sim, byTarget);
  }
  const now = sim.tick * SIM.dt;
  const kinds = byTarget.get(targetId) ?? new Map<string, number>();
  if ((kinds.get(kind) ?? -Infinity) > now) return false;
  // Half a tick short of the interval, so a zone ticking on schedule is never refused by rounding.
  kinds.set(kind, now + interval - SIM.dt / 2);
  byTarget.set(targetId, kinds);
  return true;
}

/** Drops lockouts for targets that are gone, so the map does not grow for the life of the room. */
function pruneZoneLockouts(sim: Simulation): void {
  const byTarget = zoneLockouts.get(sim);
  if (!byTarget || sim.tick % SIM.tickRate !== 0) return;
  for (const id of byTarget.keys()) if (!sim.world.isAlive(id)) byTarget.delete(id);
}

export function updateZones(sim: Simulation, dt: number): void {
  const w = sim.world;
  pruneZoneLockouts(sim);
  for (const [id, zone] of w.zone) {
    const pos = w.position.get(id);
    const radius = w.radius.get(id) ?? 0;
    if (!pos || !w.isAlive(id)) continue;
    const inst = zone.spell;
    inst.age += dt;
    zone.tickTimer -= dt;
    if (zone.tickTimer <= 0) {
      zone.tickTimer += zone.tickInterval;
      const kind = zoneKind(inst);
      for (const tid of areaTargets(sim)) {
        if (!withinHurt(sim, tid, pos.x, pos.y, radius)) continue;
        if (!takeZoneTick(sim, tid, kind, zone.tickInterval)) continue;
        applySpellHit(sim, inst, tid, pos.x, pos.y, { damage: SPELL.zone.damage, heal: SPELL.zone.heal, shield: SPELL.zone.shield });
      }
    }
    checkTimer(sim, inst, pos.x, pos.y, inst.angle, null);
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
    if (!withinHurt(sim, eid, pos.x, pos.y, SPELL.dash.hitRadius)) continue;
    ds.hitIds.add(eid);
    applySpellHit(sim, inst, eid, pos.x, pos.y, { damage: SPELL.dash.damage, heal: 0, shield: 0 });
    if (!ds.hitFired) {
      ds.hitFired = true;
      release(sim, inst, 'onhit', epos.x, epos.y, inst.angle, ds.hitIds);
    }
  }
  checkTimer(sim, inst, pos.x, pos.y, inst.angle, ds.hitIds);

  if (landed) {
    p.dashSpell = null;
    if (inst.node.effects.includes('restore')) healEntity(sim, pid, SPELL.nova.heal * 0.5 * inst.node.damageScale, true);
    if (inst.node.effects.includes('ward')) {
      grantShield(sim, pid, SPELL.nova.shield * 0.5 * inst.node.damageScale, SPELL.shieldSeconds, inst.node.combos.includes('burning_ward'));
    }
    release(sim, inst, 'onland', pos.x, pos.y, inst.angle, ds.hitIds);
    endSpell(sim, inst, pos.x, pos.y, inst.angle, ds.hitIds);
  }
}
