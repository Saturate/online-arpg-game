import { AILMENTS, CURSE, ENEMY_LEVEL, SIM, SPELL, WAVES, WILDS } from '../config/sim.js';
import { ENEMIES, type Ability, type EnemyDef, type EnemyTypeId, type HazardKind, type MonsterDef } from '../data/enemies.js';
import { BIOMES, bossFor, monsterPool } from '../data/monsterPools.js';
import type { ElementId } from '../data/runes.js';
import { affixValue, rollAffixes } from '../items/items.js';
import { dealDamage, healEntity, isTargetable } from './combat.js';
import { emptyStatus, type EnemyComp, type EntityId } from './ecs.js';
import { angleDiff, clamp, distSq, type Vec2 } from './math.js';
import type { Simulation } from './simulation.js';
import { spawnProjectile } from './spells.js';

/** Fraction of knockback velocity kept each tick. */
const KNOCK_DECAY = 0.85;
const STRAFE_FRACTION = 0.6;
/** Idle pack members shuffle a little so a camp does not look frozen. */
const IDLE_WANDER_SPEED = 0.25;
/** Shaman raises only work on the recently dead. */
const CORPSE_SECONDS = 20;
const MAX_CORPSES = 60;
/** Enemy puddles tick in chunks so damage numbers stay readable. */
const HAZARD_TICK = 0.5;

export interface SpawnOptions {
  rare: boolean;
  level: number;
  aggro: boolean;
  boss?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Per-simulation monster state that is not an entity: ground hazards, homing shots, corpses and
// deferred spawns. Kept here rather than on Simulation so the monster AI stays self-contained.

interface Hazard {
  x: number;
  y: number;
  r: number;
  dps: number;
  t: number;
  tick: number;
  kind: HazardKind;
  ownerId: EntityId;
}

interface Corpse {
  typeId: EnemyTypeId;
  x: number;
  y: number;
  level: number;
  tick: number;
}

interface PendingSpawn {
  typeId: EnemyTypeId;
  x: number;
  y: number;
  level: number;
  summonerId: EntityId | null;
  lifeShare: number;
  raised: boolean;
}

interface MonsterState {
  hazards: Hazard[];
  homing: Map<EntityId, { targetId: EntityId; turn: number }>;
  corpses: Corpse[];
  pending: PendingSpawn[];
}

const states = new WeakMap<Simulation, MonsterState>();

function state(sim: Simulation): MonsterState {
  let s = states.get(sim);
  if (!s) {
    s = { hazards: [], homing: new Map(), corpses: [], pending: [] };
    states.set(sim, s);
  }
  return s;
}

/** Active ground hazards, for tests and debugging. */
export function activeHazards(sim: Simulation): readonly { x: number; y: number; r: number; kind: HazardKind }[] {
  return state(sim).hazards;
}

export function spawnEnemy(sim: Simulation, typeId: EnemyTypeId, x: number, y: number, opts: SpawnOptions): EntityId {
  const def = ENEMIES[typeId];
  const w = sim.world;
  const boss = opts.boss ?? false;
  const affixCount = boss ? 3 : sim.rand.world.int(1, 3);
  const rolled = opts.rare || boss ? rollAffixes(sim.rand.world, 'enemy', affixCount, 2) : [];
  // Dropped after rolling rather than excluded from the roll, so the random stream is the same either way.
  // Low levels never get Multishot; bosses never Regenerate, since a long fight on a big life pool
  // with regen turned into a slog the party could not out-damage.
  const affixes = rolled.filter((a) => !(a.id === 'extra_projectiles' && opts.level < ENEMY_LEVEL.multishotFromLevel) && !(a.id === 'regenerating' && boss));
  const levelMult = 1 + ENEMY_LEVEL.lifePerLevel * (opts.level - 1);
  const lifeMult =
    (opts.rare || boss ? WAVES.rareLifeMultiplier : 1) * (boss ? ENEMY_LEVEL.bossLifeMultiplier : 1) * levelMult * (1 + affixValue(affixes, 'armored') / 100);
  const life = Math.round(def.life * lifeMult);
  const pos = sim.map.findOpen(x, y, def.radius);
  const mdef = def.behaviour === 'monster' ? def : null;

  const id = w.create('enemy');
  w.position.set(id, pos);
  w.radius.set(id, def.radius * (boss ? WAVES.rareScale * 1.3 : opts.rare ? WAVES.rareScale : 1));
  w.health.set(id, { life, maxLife: life });
  w.team.set(id, 'enemies');
  w.status.set(id, emptyStatus());
  w.enemy.set(id, {
    typeId,
    rare: opts.rare || boss,
    boss,
    level: opts.level,
    damageMult: 1 + ENEMY_LEVEL.damagePerLevel * (opts.level - 1),
    aggro: opts.aggro,
    homeX: pos.x,
    homeY: pos.y,
    affixes,
    contactCooldown: 0,
    // Stagger the first volley so a group does not fire in perfect unison.
    fireCooldown: sim.rand.world.range(0.5, 1.5),
    patternAngle: sim.rand.world.range(0, Math.PI * 2),
    facing: sim.rand.world.range(0, Math.PI * 2),
    speedMult: 1 + affixValue(affixes, 'hasted') / 100,
    extraProjectiles: affixValue(affixes, 'extra_projectiles'),
    reflectChance: affixValue(affixes, 'reflects_projectiles') / 100,
    regenPercent: affixValue(affixes, 'regenerating'),
    tauntTarget: null,
    tauntTimer: 0,
    knockX: 0,
    knockY: 0,
    // Same stagger for abilities, so a pack of casters does not all telegraph on one tick.
    cooldowns: (mdef?.abilities ?? []).map((a) => sim.rand.world.range(0.4, 1) * Math.min(a.cooldown, 2.5)),
    cast: null,
    dash: null,
    leap: null,
    burrowed: mdef?.traits.burrow !== undefined,
    burrowTimer: 0,
    summonerId: null,
    enraged: false,
    raised: false,
    rewards: true,
    detonated: false,
  });
  return id;
}

/** Places a map's monster packs once, when the room is created. */
export function spawnPacks(sim: Simulation): void {
  for (const pack of sim.mapDef.packs) {
    for (let i = 0; i < pack.count; i++) {
      const a = sim.rand.world.range(0, Math.PI * 2);
      const d = sim.rand.world.range(0, WILDS.packSpread);
      // A boss pack's first type is the boss itself; only the rest make up its escort.
      const members = pack.boss && pack.types.length > 1 ? pack.types.slice(1) : pack.types;
      const type = members[i % members.length] ?? 'chaser';
      spawnEnemy(sim, type, pack.x + Math.cos(a) * d, pack.y + Math.sin(a) * d, { rare: false, level: pack.level, aggro: false });
    }
    if (pack.rareLeader || pack.boss) {
      spawnEnemy(sim, pack.types[0] ?? 'chaser', pack.x, pack.y, { rare: true, level: pack.level, aggro: false, boss: pack.boss });
    }
  }
}

/** Wakes an enemy and the idle pack members around it. */
export function alertPack(sim: Simulation, id: EntityId): void {
  const w = sim.world;
  const pos = w.position.get(id);
  const e = w.enemy.get(id);
  if (!pos || !e || e.aggro) return;
  e.aggro = true;
  const r2 = WILDS.alertRadius * WILDS.alertRadius;
  for (const [oid, other, opos] of w.query(w.enemy, w.position)) {
    if (!other.aggro && oid !== id && distSq(pos.x, pos.y, opos.x, opos.y) <= r2) other.aggro = true;
  }
}

/** Players and minions are both valid targets; the nearest one wins unless the enemy is taunted. */
function pickTarget(sim: Simulation, e: EnemyComp, x: number, y: number, maxDist: number): EntityId | null {
  const w = sim.world;
  if (e.tauntTarget !== null && e.tauntTimer > 0 && isTargetable(sim, e.tauntTarget)) return e.tauntTarget;
  let best: EntityId | null = null;
  let bestD = maxDist * maxDist;
  const consider = (tid: EntityId): void => {
    if (!isTargetable(sim, tid)) return;
    const p = w.position.get(tid);
    if (!p) return;
    const d = distSq(x, y, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = tid;
    }
  };
  for (const pid of w.player.keys()) consider(pid);
  for (const mid of w.minion.keys()) consider(mid);
  return best;
}

function fireBullets(sim: Simulation, id: EntityId, def: EnemyDef, e: EnemyComp, x: number, y: number, angles: number[]): void {
  if (def.behaviour === 'chaser' || def.behaviour === 'monster') return;
  for (const a of angles) {
    spawnProjectile(sim, {
      ownerId: id,
      team: 'enemies',
      x,
      y,
      angle: a,
      speed: def.bulletSpeed,
      radius: def.bulletRadius,
      range: def.bulletRange,
      damage: def.bulletDamage * e.damageMult,
    });
  }
}

function moveBy(pos: Vec2, nx: number, ny: number, len: number): void {
  pos.x += nx * len;
  pos.y += ny * len;
}

export function updateEnemies(sim: Simulation, dt: number): void {
  const w = sim.world;
  const map = sim.map;
  flushPendingSpawns(sim);
  updateHazards(sim, dt);
  steerHomingShots(sim, dt);
  for (const [id, e, pos] of w.query(w.enemy, w.position)) {
    const def = ENEMIES[e.typeId];
    const st = w.status.get(id);
    if (e.contactCooldown > 0) e.contactCooldown -= dt;
    if (e.fireCooldown > 0) e.fireCooldown -= dt;
    if (e.tauntTimer > 0) e.tauntTimer -= dt;

    pos.x += e.knockX * dt;
    pos.y += e.knockY * dt;
    e.knockX *= KNOCK_DECAY;
    e.knockY *= KNOCK_DECAY;

    if (def.behaviour === 'monster' && def.traits.curse) applyCurse(sim, pos, def.traits.curse.radius);

    const slow = st && st.chill > 0 ? 1 - AILMENTS.chill.slow : 1;
    const enrageSpeed = def.behaviour === 'monster' && e.enraged ? (def.traits.enrage?.speed ?? 1) : 1;
    const speed = def.moveSpeed * e.speedMult * slow * enrageSpeed * map.speedAt(pos.x, pos.y);
    const radius = w.radius.get(id) ?? def.radius;

    // Committed monster actions (a wind-up, a charge, a leap) play out even if the target walks away.
    if (def.behaviour === 'monster' && advanceMonster(sim, id, e, def, pos, radius, dt)) continue;

    if (!e.aggro && def.behaviour === 'monster' && def.traits.dormant) {
      // Statues and mimics hold perfectly still: no idle shuffle that would give them away.
      if (pickTarget(sim, e, pos.x, pos.y, def.traits.dormant.wakeRange) !== null) alertPack(sim, id);
      else continue;
    }

    if (!e.aggro) {
      const seen = pickTarget(sim, e, pos.x, pos.y, WILDS.aggroRadius);
      const spos = seen === null ? undefined : w.position.get(seen);
      if (spos && (map.lineClear(pos.x, pos.y, spos.x, spos.y, 4, 'shots') || (def.behaviour === 'monster' && def.movement === 'burrow'))) {
        alertPack(sim, id);
      } else {
        const wobble = Math.sin(sim.tick * 0.05 + id);
        moveBy(pos, Math.cos(e.facing), Math.sin(e.facing), speed * IDLE_WANDER_SPEED * dt * wobble);
        continue;
      }
    }

    // Aggroed enemies in the wilds give up and walk home once they are dragged too far from it.
    const leashed = !sim.mapDef.waves && distSq(pos.x, pos.y, e.homeX, e.homeY) > WILDS.leashDistance ** 2;
    const target = leashed ? null : pickTarget(sim, e, pos.x, pos.y, Infinity);
    const tpos = target === null ? undefined : w.position.get(target);
    if (target === null || !tpos) {
      if (!sim.mapDef.waves) {
        const dx = e.homeX - pos.x;
        const dy = e.homeY - pos.y;
        const d = Math.hypot(dx, dy);
        if (d > 20) moveBy(pos, dx / d, dy / d, speed * dt);
        else {
          e.aggro = false;
          const h = w.health.get(id);
          if (h) h.life = h.maxLife;
        }
      }
      continue;
    }

    if (def.behaviour === 'monster') {
      thinkMonster(sim, id, e, def, pos, radius, speed, target, tpos, dt);
      continue;
    }

    const dx = tpos.x - pos.x;
    const dy = tpos.y - pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const contact = radius + (w.radius.get(target) ?? SIM.playerRadius);
    const toward = Math.atan2(dy, dx);
    const hasSight = map.lineClear(pos.x, pos.y, tpos.x, tpos.y, radius * 0.8, 'move');
    const flow = hasSight ? null : sim.nav.direction(pos.x, pos.y);
    // Walk straight at a visible target; otherwise follow the flow field around obstacles.
    const ax = flow ? flow.x : dx / dist;
    const ay = flow ? flow.y : dy / dist;
    e.facing = def.behaviour === 'spinner' ? e.patternAngle : Math.atan2(ay, ax);

    if (def.behaviour === 'chaser') {
      if (dist > contact) moveBy(pos, ax, ay, flow ? speed * dt : Math.min(speed * dt, dist - contact));
    } else {
      const range = def.preferredRange;
      if (dist > range + 40 || flow) moveBy(pos, ax, ay, speed * dt);
      else if (dist < range - 60) moveBy(pos, -dx / dist, -dy / dist, speed * dt);
      else if (def.behaviour === 'shooter') {
        const side = id % 2 === 0 ? 1 : -1;
        moveBy(pos, (-dy / dist) * side, (dx / dist) * side, speed * STRAFE_FRACTION * dt);
      }

      const shotClear = def.behaviour === 'spinner' || map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 4, 'shots');
      if (e.fireCooldown <= 0 && dist < def.bulletRange && shotClear) {
        e.fireCooldown = def.fireCooldown;
        sim.emit({ e: 'attack', id }, pos.x, pos.y);
        if (def.behaviour === 'shooter') {
          const n = e.level < ENEMY_LEVEL.multishotFromLevel ? 1 : def.bullets + e.extraProjectiles;
          const angles = Array.from({ length: n }, (_, k) => toward + (k - (n - 1) / 2) * def.spread);
          fireBullets(sim, id, def, e, pos.x, pos.y, angles);
        } else {
          const n = def.bullets + e.extraProjectiles * 2;
          const angles = Array.from({ length: n }, (_, k) => e.patternAngle + (Math.PI * 2 * k) / n);
          e.patternAngle += def.rotationPerVolley;
          fireBullets(sim, id, def, e, pos.x, pos.y, angles);
        }
      }
    }

    contactHit(sim, id, e, def, pos, target, dist, contact, []);
  }
  separateEnemies(sim);
  // Separation can shove enemies into rocks; settle everyone against the map last. Ghosts and
  // burrowers are the exception: passing through the terrain is their whole point.
  for (const [id, e, pos] of w.query(w.enemy, w.position)) {
    const def = ENEMIES[e.typeId];
    if (e.burrowed || (def.behaviour === 'monster' && def.movement === 'ghost')) continue;
    // Flyers are stopped by rocks and walls but not by water, which only blocks walking.
    const flying = def.behaviour === 'monster' && def.movement === 'fly';
    const p = map.resolveCircle(pos, w.radius.get(id) ?? 0, flying ? 'shots' : 'move');
    pos.x = p.x;
    pos.y = p.y;
  }
}

function contactHit(sim: Simulation, id: EntityId, e: EnemyComp, def: EnemyDef, pos: Vec2, target: EntityId, dist: number, contact: number, elements: readonly ElementId[]): void {
  const w = sim.world;
  if (def.contactDamage <= 0 || e.burrowed || dist > contact + 2 || e.contactCooldown > 0) return;
  e.contactCooldown = def.contactCooldown;
  sim.emit({ e: 'attack', id }, pos.x, pos.y);
  dealDamage(sim, target, def.contactDamage * e.damageMult, id, elements);
  const shield = w.status.get(target)?.shield;
  if (shield?.burning) dealDamage(sim, id, SPELL.burningWardDamage, target, ['fire']);
}

// ---------------------------------------------------------------------------------------------
// Generic monster AI

/** Every player and minion whose body overlaps a circle. */
function targetsInCircle(sim: Simulation, x: number, y: number, r: number): EntityId[] {
  const w = sim.world;
  const out: EntityId[] = [];
  for (const tid of [...w.player.keys(), ...w.minion.keys()]) {
    if (!isTargetable(sim, tid)) continue;
    const p = w.position.get(tid);
    if (!p) continue;
    const reach = r + (w.radius.get(tid) ?? SIM.playerRadius);
    if (distSq(x, y, p.x, p.y) <= reach * reach) out.push(tid);
  }
  return out;
}

function hitCircle(sim: Simulation, sourceId: EntityId, x: number, y: number, r: number, damage: number, element: ElementId | undefined): void {
  for (const tid of targetsInCircle(sim, x, y, r)) dealDamage(sim, tid, damage, sourceId, element ? [element] : []);
}

function telegraphCircle(sim: Simulation, id: EntityId, x: number, y: number, r: number, t: number, el: ElementId | undefined): void {
  sim.emit({ e: 'tele', id, shape: 'circle', x: Math.round(x), y: Math.round(y), r: Math.round(r), t, el: el ?? null }, x, y);
}

function telegraphLine(sim: Simulation, id: EntityId, x: number, y: number, x2: number, y2: number, width: number, t: number, el: ElementId | undefined): void {
  sim.emit({ e: 'tele', id, shape: 'line', x: Math.round(x), y: Math.round(y), x2: Math.round(x2), y2: Math.round(y2), w: Math.round(width), t, el: el ?? null }, x, y);
}

function addHazard(sim: Simulation, ownerId: EntityId, x: number, y: number, r: number, dps: number, duration: number, kind: HazardKind): void {
  state(sim).hazards.push({ x, y, r, dps, t: duration, tick: HAZARD_TICK, kind, ownerId });
  sim.emit({ e: 'hazard', x: Math.round(x), y: Math.round(y), r: Math.round(r), t: duration, kind }, x, y);
}

function updateHazards(sim: Simulation, dt: number): void {
  const s = state(sim);
  for (const h of s.hazards) {
    h.t -= dt;
    h.tick -= dt;
    if (h.tick > 0) continue;
    h.tick += HAZARD_TICK;
    for (const tid of targetsInCircle(sim, h.x, h.y, h.r)) {
      dealDamage(sim, tid, h.dps * HAZARD_TICK, h.ownerId, h.kind === 'fire' ? ['fire'] : []);
      if (h.kind === 'frost') {
        const st = sim.world.status.get(tid);
        if (st) st.chill = AILMENTS.chill.seconds;
      }
    }
  }
  s.hazards = s.hazards.filter((h) => h.t > 0);
}

/** Homing shots turn toward their target a little each tick; they stay dodgeable by strafing. */
function steerHomingShots(sim: Simulation, dt: number): void {
  const w = sim.world;
  const homing = state(sim).homing;
  for (const [pid, h] of homing) {
    const vel = w.velocity.get(pid);
    const pos = w.position.get(pid);
    const tpos = w.position.get(h.targetId);
    if (!w.isAlive(pid) || !vel || !pos) {
      homing.delete(pid);
      continue;
    }
    if (!tpos || !isTargetable(sim, h.targetId)) continue;
    const speed = Math.hypot(vel.x, vel.y);
    const cur = Math.atan2(vel.y, vel.x);
    const want = Math.atan2(tpos.y - pos.y, tpos.x - pos.x);
    const turn = clamp(angleDiff(want, cur), -h.turn * dt, h.turn * dt);
    vel.x = Math.cos(cur + turn) * speed;
    vel.y = Math.sin(cur + turn) * speed;
  }
}

function flushPendingSpawns(sim: Simulation): void {
  const s = state(sim);
  if (s.pending.length === 0) return;
  const pending = s.pending;
  s.pending = [];
  for (const p of pending) {
    const nid = spawnEnemy(sim, p.typeId, p.x, p.y, { rare: false, level: p.level, aggro: true });
    const e = sim.world.enemy.get(nid);
    const h = sim.world.health.get(nid);
    if (e) {
      e.summonerId = p.summonerId;
      e.raised = p.raised;
      e.rewards = !p.raised;
    }
    if (h) h.life = Math.max(1, Math.round(h.maxLife * p.lifeShare));
  }
}

function abilityCooldown(sim: Simulation, a: Ability): number {
  return a.cooldown * sim.rand.world.range(0.85, 1.15);
}

/**
 * Timers, enrage, and actions already in progress. Returns true while the monster is busy with a
 * charge, leap or wind-up, so the rest of its AI (and its movement) is skipped this tick.
 */
function advanceMonster(sim: Simulation, id: EntityId, e: EnemyComp, def: MonsterDef, pos: Vec2, radius: number, dt: number): boolean {
  const w = sim.world;
  const enrage = def.traits.enrage;
  if (enrage && !e.enraged) {
    const h = w.health.get(id);
    if (h && h.life <= h.maxLife * enrage.at) {
      e.enraged = true;
      sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: radius * 3 }, pos.x, pos.y);
    }
  }
  const cdRate = e.enraged && enrage ? 1 / enrage.cooldown : 1;
  for (let i = 0; i < e.cooldowns.length; i++) {
    const c = e.cooldowns[i];
    if (c !== undefined && c > 0) e.cooldowns[i] = c - dt * cdRate;
  }

  if (e.dash) {
    const d = e.dash;
    d.t -= dt;
    // Two steps so a fast charge cannot skip over a target or a thin wall in one tick.
    for (let s = 0; s < 2; s++) {
      pos.x += (d.vx * dt) / 2;
      pos.y += (d.vy * dt) / 2;
      for (const tid of targetsInCircle(sim, pos.x, pos.y, radius + d.width / 2)) {
        if (d.hitIds.has(tid)) continue;
        d.hitIds.add(tid);
        dealDamage(sim, tid, d.damage * e.damageMult, id, []);
      }
      if (sim.map.pointBlocked(pos.x, pos.y, radius * 0.8, 'move')) {
        d.t = 0;
        break;
      }
    }
    e.facing = Math.atan2(d.vy, d.vx);
    if (d.t <= 0) e.dash = null;
    return true;
  }

  if (e.leap) {
    const l = e.leap;
    l.t += dt;
    const k = Math.min(1, l.t / l.duration);
    pos.x = l.fromX + (l.toX - l.fromX) * k;
    pos.y = l.fromY + (l.toY - l.fromY) * k;
    if (k >= 1) {
      const land = sim.map.findOpen(l.toX, l.toY, radius);
      pos.x = land.x;
      pos.y = land.y;
      hitCircle(sim, id, pos.x, pos.y, l.radius, l.damage * e.damageMult, undefined);
      sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: l.radius }, pos.x, pos.y);
      e.leap = null;
    }
    return true;
  }

  if (e.cast) {
    const c = e.cast;
    c.t -= dt;
    e.facing = c.angle;
    if (c.t > 0) return true;
    e.cast = null;
    const a = def.abilities[c.index];
    if (a) {
      const cd = e.cooldowns[c.index];
      if (cd !== undefined) e.cooldowns[c.index] = abilityCooldown(sim, a);
      resolveAbility(sim, id, e, def, a, pos, radius, c.angle, c.points);
    }
    return true;
  }
  return false;
}

function liveSummons(sim: Simulation, id: EntityId): number {
  let n = 0;
  for (const other of sim.world.enemy.values()) if (other.summonerId === id) n++;
  return n;
}

function hurtAllyNear(sim: Simulation, x: number, y: number, r: number): boolean {
  const w = sim.world;
  for (const [oid, , opos] of w.query(w.enemy, w.position)) {
    const h = w.health.get(oid);
    if (h && h.life < h.maxLife * 0.8 && distSq(x, y, opos.x, opos.y) <= r * r) return true;
  }
  return false;
}

function corpsesNear(sim: Simulation, x: number, y: number, r: number): Corpse[] {
  const cutoff = sim.tick - CORPSE_SECONDS * SIM.tickRate;
  return state(sim).corpses.filter((c) => c.tick >= cutoff && distSq(x, y, c.x, c.y) <= r * r);
}

/** Whether an ability can start now, given where the target stands. */
function abilityReady(sim: Simulation, id: EntityId, e: EnemyComp, a: Ability, i: number, pos: Vec2, tpos: Vec2, dist: number, sight: boolean): boolean {
  const cd = e.cooldowns[i] ?? 0;
  if (cd > 0 || (a.enragedOnly && !e.enraged) || dist > a.range) return false;
  switch (a.kind) {
    case 'shoot':
    case 'blast':
    case 'charge':
      return sight;
    case 'pool':
      return a.atSelf === true || sight;
    case 'leap':
      return dist >= a.minRange && sim.map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 8, 'shots');
    case 'summon':
      return liveSummons(sim, id) < a.cap;
    case 'heal':
      return hurtAllyNear(sim, pos.x, pos.y, a.radius);
    case 'raise':
      return corpsesNear(sim, pos.x, pos.y, a.radius).length > 0;
    default:
      return true;
  }
}

function startAbility(sim: Simulation, id: EntityId, e: EnemyComp, def: MonsterDef, a: Ability, i: number, pos: Vec2, tpos: Vec2, radius: number): void {
  const angle = Math.atan2(tpos.y - pos.y, tpos.x - pos.x);
  const points: Vec2[] = [];
  const rnd = sim.rand.world;
  const tele = a.windup;
  switch (a.kind) {
    case 'slam': {
      const at = a.atSelf ? { x: pos.x, y: pos.y } : { x: tpos.x, y: tpos.y };
      points.push(at);
      if (tele > 0) telegraphCircle(sim, id, at.x, at.y, a.radius, tele, a.element);
      break;
    }
    case 'shoot': {
      if (tele > 0) {
        const len = Math.min(a.range, 520);
        telegraphLine(sim, id, pos.x, pos.y, pos.x + Math.cos(angle) * len, pos.y + Math.sin(angle) * len, a.radius * 2 + 6, tele, a.element);
      }
      break;
    }
    case 'ring':
      if (tele > 0) telegraphCircle(sim, id, pos.x, pos.y, radius * 2.5, tele, a.element);
      break;
    case 'blast': {
      points.push({ x: tpos.x, y: tpos.y });
      for (let k = 0; k < a.extra; k++) {
        const ang = rnd.range(0, Math.PI * 2);
        const d = rnd.range(a.radius, a.radius * 2.6);
        points.push({ x: tpos.x + Math.cos(ang) * d, y: tpos.y + Math.sin(ang) * d });
      }
      for (const p of points) telegraphCircle(sim, id, p.x, p.y, a.radius, tele, a.element);
      break;
    }
    case 'summon': {
      const n = Math.min(a.count, a.cap - liveSummons(sim, id));
      for (let k = 0; k < n; k++) {
        const ang = rnd.range(0, Math.PI * 2);
        const d = rnd.range(radius + 30, radius + 90);
        points.push({ x: pos.x + Math.cos(ang) * d, y: pos.y + Math.sin(ang) * d });
      }
      for (const p of points) telegraphCircle(sim, id, p.x, p.y, 20, tele, undefined);
      sim.emit({ e: 'cast', id, x: pos.x, y: pos.y, el: null }, pos.x, pos.y);
      break;
    }
    case 'charge': {
      const len = a.speed * a.duration;
      telegraphLine(sim, id, pos.x, pos.y, pos.x + Math.cos(angle) * len, pos.y + Math.sin(angle) * len, a.width + radius * 2, tele, undefined);
      break;
    }
    case 'leap': {
      const d = Math.hypot(tpos.x - pos.x, tpos.y - pos.y);
      const reach = Math.min(d, a.range);
      const at = { x: pos.x + Math.cos(angle) * reach, y: pos.y + Math.sin(angle) * reach };
      points.push(at);
      telegraphCircle(sim, id, at.x, at.y, a.radius, tele + a.duration, undefined);
      break;
    }
    case 'explode':
      points.push({ x: pos.x, y: pos.y });
      telegraphCircle(sim, id, pos.x, pos.y, a.radius, tele, a.element);
      break;
    case 'heal':
    case 'raise':
      sim.emit({ e: 'cast', id, x: pos.x, y: pos.y, el: null }, pos.x, pos.y);
      break;
    case 'pool': {
      const at = a.atSelf ? { x: pos.x, y: pos.y } : { x: tpos.x, y: tpos.y };
      points.push(at);
      if (tele > 0) telegraphCircle(sim, id, at.x, at.y, a.radius, tele, undefined);
      break;
    }
    case 'blink': {
      // A fresh angle around the target each time, so an imp never lands in the same place twice.
      const ang = rnd.range(0, Math.PI * 2);
      const at = sim.map.findOpen(tpos.x + Math.cos(ang) * a.distance, tpos.y + Math.sin(ang) * a.distance, radius);
      points.push(at);
      telegraphCircle(sim, id, at.x, at.y, radius * 1.8, Math.max(tele, 0.2), 'fire');
      sim.emit({ e: 'cast', id, x: pos.x, y: pos.y, el: 'fire' }, pos.x, pos.y);
      break;
    }
  }
  e.facing = angle;
  if (tele > 0) {
    e.cast = { index: i, t: tele, x: pos.x, y: pos.y, angle, points };
    return;
  }
  e.cooldowns[i] = abilityCooldown(sim, a);
  resolveAbility(sim, id, e, def, a, pos, radius, angle, points);
}

function resolveAbility(sim: Simulation, id: EntityId, e: EnemyComp, def: MonsterDef, a: Ability, pos: Vec2, radius: number, angle: number, points: readonly Vec2[]): void {
  const w = sim.world;
  const dmg = e.damageMult;
  sim.emit({ e: 'attack', id }, pos.x, pos.y);
  switch (a.kind) {
    case 'slam': {
      const at = points[0] ?? pos;
      hitCircle(sim, id, at.x, at.y, a.radius, a.damage * dmg, a.element);
      sim.emit({ e: 'explode', x: at.x, y: at.y, r: a.radius }, at.x, at.y);
      break;
    }
    case 'shoot': {
      const n = e.level < ENEMY_LEVEL.multishotFromLevel ? 1 : a.bullets + e.extraProjectiles;
      const target = a.homing ? pickTarget(sim, e, pos.x, pos.y, a.range * 1.5) : null;
      for (let k = 0; k < n; k++) {
        const pid = spawnProjectile(sim, {
          ownerId: id,
          team: 'enemies',
          x: pos.x,
          y: pos.y,
          angle: angle + (k - (n - 1) / 2) * a.spread,
          speed: a.speed,
          radius: a.radius,
          range: a.range * 1.2,
          damage: a.damage * dmg,
          partial: { elements: a.element ? [a.element] : [] },
        });
        if (a.homing && target !== null) state(sim).homing.set(pid, { targetId: target, turn: a.homing });
      }
      break;
    }
    case 'ring': {
      const n = a.bullets + e.extraProjectiles * 2;
      for (let k = 0; k < n; k++) {
        spawnProjectile(sim, {
          ownerId: id,
          team: 'enemies',
          x: pos.x,
          y: pos.y,
          angle: e.patternAngle + (Math.PI * 2 * k) / n,
          speed: a.speed,
          radius: a.radius,
          range: a.range,
          damage: a.damage * dmg,
          partial: { elements: a.element ? [a.element] : [] },
        });
      }
      e.patternAngle += 0.27;
      break;
    }
    case 'blast':
      for (const p of points) {
        hitCircle(sim, id, p.x, p.y, a.radius, a.damage * dmg, a.element);
        sim.emit({ e: 'explode', x: p.x, y: p.y, r: a.radius }, p.x, p.y);
      }
      break;
    case 'summon': {
      const room = a.cap - liveSummons(sim, id);
      for (const p of points.slice(0, Math.max(0, room))) {
        state(sim).pending.push({ typeId: a.type, x: p.x, y: p.y, level: e.level, summonerId: id, lifeShare: 1, raised: false });
      }
      break;
    }
    case 'charge':
      e.dash = { vx: Math.cos(angle) * a.speed, vy: Math.sin(angle) * a.speed, t: a.duration, damage: a.damage, width: a.width, hitIds: new Set() };
      break;
    case 'leap': {
      const at = points[0] ?? pos;
      e.leap = { fromX: pos.x, fromY: pos.y, toX: at.x, toY: at.y, t: 0, duration: a.duration, radius: a.radius, damage: a.damage };
      break;
    }
    case 'explode': {
      hitCircle(sim, id, pos.x, pos.y, a.radius, a.damage * dmg, a.element);
      if (a.hazard) addHazard(sim, id, pos.x, pos.y, a.radius * 0.7, 12, 3, a.hazard);
      sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: a.radius }, pos.x, pos.y);
      e.detonated = true;
      const h = w.health.get(id);
      if (h) dealDamage(sim, id, h.life + 1, id, [], { ignoreArmor: true, quiet: true });
      break;
    }
    case 'heal':
      for (const [oid, , opos] of w.query(w.enemy, w.position)) {
        const h = w.health.get(oid);
        if (h && distSq(pos.x, pos.y, opos.x, opos.y) <= a.radius * a.radius) healEntity(sim, oid, (h.maxLife * a.percent) / 100, true);
      }
      break;
    case 'raise': {
      const s = state(sim);
      const found = corpsesNear(sim, pos.x, pos.y, a.radius).slice(0, a.count);
      for (const c of found) {
        s.corpses = s.corpses.filter((x) => x !== c);
        s.pending.push({ typeId: c.typeId, x: c.x, y: c.y, level: c.level, summonerId: null, lifeShare: 0.6, raised: true });
        sim.emit({ e: 'cast', id, x: c.x, y: c.y, el: null }, c.x, c.y);
        sim.emit({ e: 'raise', x: c.x, y: c.y }, c.x, c.y);
      }
      break;
    }
    case 'pool': {
      const at = points[0] ?? pos;
      addHazard(sim, id, at.x, at.y, a.radius, a.dps * dmg, a.duration, a.hazard);
      break;
    }
    case 'blink': {
      const at = points[0];
      if (!at) break;
      sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: radius * 1.5 }, pos.x, pos.y);
      pos.x = at.x;
      pos.y = at.y;
      sim.emit({ e: 'explode', x: at.x, y: at.y, r: radius * 1.5 }, at.x, at.y);
      break;
    }
  }
  if (def.traits.burrow && e.burrowed) e.burrowed = false;
}

/** Movement and ability choice for a monster with a live target. */
function thinkMonster(sim: Simulation, id: EntityId, e: EnemyComp, def: MonsterDef, pos: Vec2, radius: number, speed: number, target: EntityId, tpos: Vec2, dt: number): void {
  const w = sim.world;
  const map = sim.map;
  const dx = tpos.x - pos.x;
  const dy = tpos.y - pos.y;
  const dist = Math.hypot(dx, dy) || 1;
  const contact = radius + (w.radius.get(target) ?? SIM.playerRadius);
  const phases = def.movement === 'ghost' || e.burrowed;
  const sight = phases || map.lineClear(pos.x, pos.y, tpos.x, tpos.y, radius * 0.8, def.movement === 'fly' ? 'shots' : 'move');
  const shotSight = map.lineClear(pos.x, pos.y, tpos.x, tpos.y, 4, 'shots');
  const flow = sight ? null : sim.nav.direction(pos.x, pos.y);
  const ax = flow ? flow.x : dx / dist;
  const ay = flow ? flow.y : dy / dist;
  e.facing = Math.atan2(dy, dx);

  // Burrowers travel unseen and only fight above ground.
  const burrow = def.traits.burrow;
  if (burrow) {
    if (e.burrowed) {
      if (dist <= burrow.surfaceRange) {
        e.burrowed = false;
        e.burrowTimer = 0;
        // Surfacing always opens with the eruption, telegraphed so it can be dodged.
        if (e.cooldowns.length > 0) e.cooldowns[0] = 0;
      } else {
        moveBy(pos, dx / dist, dy / dist, speed * 1.3 * dt);
        return;
      }
    } else {
      e.burrowTimer += dt;
      if (e.burrowTimer > burrow.surfacedSeconds && dist > contact + 20) {
        e.burrowed = true;
        return;
      }
    }
  }

  const abilities = def.abilities;
  // Phase-two abilities first, so an enraged boss shows off its new moves.
  const order = abilities.map((_, i) => i).sort((a, b) => Number(abilities[b]?.enragedOnly ?? false) - Number(abilities[a]?.enragedOnly ?? false));
  for (const i of order) {
    const a = abilities[i];
    if (!a || !abilityReady(sim, id, e, a, i, pos, tpos, dist, a.kind === 'leap' ? sight : shotSight)) continue;
    startAbility(sim, id, e, def, a, i, pos, tpos, radius);
    return;
  }

  const range = def.preferredRange;
  switch (def.movement) {
    case 'stationary':
      break;
    case 'melee':
    case 'burrow':
      if (dist > contact) moveBy(pos, ax, ay, flow ? speed * dt : Math.min(speed * dt, dist - contact));
      break;
    case 'flank': {
      // Aim beside the target until close, so a swarm wraps around instead of queueing.
      const side = id % 2 === 0 ? 1 : -1;
      const off = dist > 110 ? Math.min(dist * 0.45, 90) : 0;
      const gx = tpos.x + (-dy / dist) * side * off;
      const gy = tpos.y + (dx / dist) * side * off;
      const gdx = gx - pos.x;
      const gdy = gy - pos.y;
      const gd = Math.hypot(gdx, gdy) || 1;
      if (flow) moveBy(pos, flow.x, flow.y, speed * dt);
      else if (dist > contact) moveBy(pos, gdx / gd, gdy / gd, Math.min(speed * dt, Math.max(0, dist - contact)));
      break;
    }
    case 'erratic': {
      const weave = Math.sin(sim.tick * 0.35 + id * 1.7) * 0.9;
      const nx = ax + (-ay) * weave;
      const ny = ay + ax * weave;
      const n = Math.hypot(nx, ny) || 1;
      if (dist > contact) moveBy(pos, nx / n, ny / n, speed * dt);
      break;
    }
    case 'fly': {
      const hold = range > 0 ? range : contact;
      if (dist > hold) {
        const weave = Math.sin(sim.tick * 0.22 + id * 1.3) * 0.7;
        const nx = ax + -ay * weave;
        const ny = ay + ax * weave;
        const n = Math.hypot(nx, ny) || 1;
        moveBy(pos, nx / n, ny / n, Math.min(speed * dt, dist - hold + speed * dt * 0.3));
      } else if (range > 0) {
        // Circles its target at range, like a harpy wheeling overhead.
        const side = id % 2 === 0 ? 1 : -1;
        moveBy(pos, (-dy / dist) * side, (dx / dist) * side, speed * STRAFE_FRACTION * dt);
      }
      break;
    }
    case 'ghost': {
      const hold = range > 0 ? range : contact;
      if (dist > hold) moveBy(pos, dx / dist, dy / dist, Math.min(speed * dt, dist - hold));
      break;
    }
    case 'ranged':
      if (dist > range + 40 || flow) moveBy(pos, ax, ay, speed * dt);
      else if (dist < range - 60) moveBy(pos, -dx / dist, -dy / dist, speed * dt);
      else {
        const side = id % 2 === 0 ? 1 : -1;
        moveBy(pos, (-dy / dist) * side, (dx / dist) * side, speed * STRAFE_FRACTION * dt);
      }
      break;
    case 'kite':
      // Kiters back off hard when approached, so closing the gap takes intent.
      if (dist > range + 40 || flow) moveBy(pos, ax, ay, speed * dt);
      else if (dist < range * 0.7) moveBy(pos, -dx / dist, -dy / dist, speed * 1.1 * dt);
      break;
  }

  contactHit(sim, id, e, def, pos, target, dist, contact, def.traits.contactElement ? [def.traits.contactElement] : []);
}

// ---------------------------------------------------------------------------------------------
// Hooks called from combat and projectiles

/** Shielders stop projectiles arriving from in front of them. */
export function blocksProjectile(sim: Simulation, enemyId: EntityId, fromX: number, fromY: number): boolean {
  const e = sim.world.enemy.get(enemyId);
  const pos = sim.world.position.get(enemyId);
  if (!e || !pos) return false;
  const def = ENEMIES[e.typeId];
  const arc = def.behaviour === 'monster' ? def.traits.frontalBlock : undefined;
  if (arc === undefined || e.cast || e.dash) return false;
  return Math.abs(angleDiff(Math.atan2(fromY - pos.y, fromX - pos.x), e.facing)) < arc / 2;
}

export function knockbackImmune(typeId: EnemyTypeId): boolean {
  const def = ENEMIES[typeId];
  return def.behaviour === 'monster' && def.traits.knockbackImmune === true;
}

/** Death effects: bursts, splitting, and leaving a corpse for shamans to raise. */
export function onEnemyDeath(sim: Simulation, id: EntityId, e: EnemyComp, pos: Vec2): void {
  const def = ENEMIES[e.typeId];
  const s = state(sim);
  // Totems and ghosts leave nothing to raise; bosses and the already-raised stay down.
  const leavesCorpse = !e.raised && !e.boss && (def.behaviour !== 'monster' || (def.family !== 'totem' && def.family !== 'ghost'));
  if (leavesCorpse) {
    s.corpses.push({ typeId: e.typeId, x: pos.x, y: pos.y, level: e.level, tick: sim.tick });
    if (s.corpses.length > MAX_CORPSES) s.corpses.splice(0, s.corpses.length - MAX_CORPSES);
  }
  if (def.behaviour !== 'monster') return;
  const t = def.traits;
  if (t.deathBurst && !e.detonated) {
    const b = t.deathBurst;
    hitCircle(sim, id, pos.x, pos.y, b.radius, b.damage * e.damageMult, b.element);
    sim.emit({ e: 'explode', x: pos.x, y: pos.y, r: b.radius }, pos.x, pos.y);
    if (b.hazard) addHazard(sim, id, pos.x, pos.y, b.radius * 0.8, 10 * e.damageMult, 4, b.hazard);
  }
  if (t.splitInto) {
    for (let k = 0; k < t.splitInto.count; k++) {
      const a = (Math.PI * 2 * k) / t.splitInto.count + sim.rand.world.range(0, 0.6);
      s.pending.push({ typeId: t.splitInto.type, x: pos.x + Math.cos(a) * 26, y: pos.y + Math.sin(a) * 26, level: e.level, summonerId: null, lifeShare: 1, raised: false });
    }
  }
}

/** Refreshes the curse on every player standing in a mummy's aura. */
function applyCurse(sim: Simulation, pos: Vec2, radius: number): void {
  const w = sim.world;
  for (const pid of w.player.keys()) {
    if (!isTargetable(sim, pid)) continue;
    const p = w.position.get(pid);
    const st = w.status.get(pid);
    if (p && st && distSq(pos.x, pos.y, p.x, p.y) <= radius * radius) st.curse = Math.max(st.curse, CURSE.lingerSeconds);
  }
}

/** Pushes overlapping enemies apart so groups stay readable. */
/**
 * Pushes overlapping enemies apart. A zone holds a few hundred enemies, and checking every pair was a
 * third of an idle zone's tick, so pairs only come from neighbouring grid cells. A cell is as wide
 * as the biggest pair of radii, so any two enemies that touch sit in the same or adjacent cells.
 */
function separateEnemies(sim: Simulation): void {
  const w = sim.world;
  const bodies: { pos: { x: number; y: number }; r: number; cx: number; cy: number; order: number }[] = [];
  let maxR = 0;
  for (const id of w.enemy.keys()) {
    const pos = w.position.get(id);
    if (!pos) continue;
    const r = w.radius.get(id) ?? 0;
    maxR = Math.max(maxR, r);
    bodies.push({ pos, r, cx: 0, cy: 0, order: bodies.length });
  }
  const cell = Math.max(32, maxR * 2);
  const cells = new Map<number, typeof bodies>();
  // Wide enough that neighbouring keys never collide for any map size.
  const key = (cx: number, cy: number): number => cx * 65536 + cy;
  for (const b of bodies) {
    b.cx = Math.floor(b.pos.x / cell);
    b.cy = Math.floor(b.pos.y / cell);
    const k = key(b.cx, b.cy);
    const list = cells.get(k);
    if (list) list.push(b);
    else cells.set(k, [b]);
  }
  for (const a of bodies) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const b of cells.get(key(a.cx + dx, a.cy + dy)) ?? []) {
          // Each pair once, in the same order as before, so results stay deterministic.
          if (b.order <= a.order) continue;
          const ox = b.pos.x - a.pos.x;
          const oy = b.pos.y - a.pos.y;
          if (Math.abs(ox) > a.r + b.r || Math.abs(oy) > a.r + b.r) continue;
          const d = Math.hypot(ox, oy);
          const overlap = a.r + b.r - d;
          if (overlap <= 0 || d === 0) continue;
          const push = overlap / 2 / d;
          a.pos.x -= ox * push;
          a.pos.y -= oy * push;
          b.pos.x += ox * push;
          b.pos.y += oy * push;
        }
      }
    }
  }
}

export function updateWaves(sim: Simulation, dt: number): void {
  if (!sim.mapDef.waves) return;
  const w = sim.world;
  const players = [...w.player.keys()];
  if (players.length === 0) return;
  let living = 0;
  for (const id of w.enemy.keys()) if (w.isAlive(id)) living++;
  if (living > 0) {
    sim.waveTimer = WAVES.betweenWavesSeconds;
    return;
  }
  sim.waveTimer -= dt;
  if (sim.waveTimer > 0) return;

  sim.wave++;
  const base = Math.min(WAVES.maxCount, WAVES.baseCount + WAVES.perWave * (sim.wave - 1));
  const count = Math.floor(base * (1 + WAVES.perExtraPlayer * (players.length - 1)));
  const rareChance = Math.min(WAVES.rareChanceMax, WAVES.rareChanceBase + WAVES.rareChancePerWave * (sim.wave - 1));
  const level = 1 + Math.floor((sim.wave - 1) / 2);
  const types: { id: EnemyTypeId; weight: number }[] = [{ id: 'chaser', weight: 5 }];
  if (sim.wave >= WAVES.shooterFromWave) types.push({ id: 'shooter', weight: 3 });
  if (sim.wave >= WAVES.spinnerFromWave) types.push({ id: 'spinner', weight: 1.5 });
  // From wave 3 the arena cycles through the biomes, so every monster family shows up in testing.
  const biome = BIOMES[(sim.wave - 1) % BIOMES.length] ?? 'meadow';
  if (sim.wave >= 3) for (const t of monsterPool(biome, level)) if (!types.some((x) => x.id === t)) types.push({ id: t, weight: 1.5 });
  const totalWeight = types.reduce((s, t) => s + t.weight, 0);

  for (let i = 0; i < count; i++) {
    let roll = sim.rand.world.next() * totalWeight;
    let typeId: EnemyTypeId = 'chaser';
    for (const t of types) {
      roll -= t.weight;
      if (roll < 0) {
        typeId = t.id;
        break;
      }
    }
    const at = enemySpawnPoint(sim, players);
    spawnEnemy(sim, typeId, at.x, at.y, { rare: sim.rand.world.next() < rareChance, level, aggro: true });
  }
  // Every fifth wave brings the biome's boss.
  if (sim.wave % 5 === 0) {
    const at = enemySpawnPoint(sim, players);
    spawnEnemy(sim, bossFor(biome, level), at.x, at.y, { rare: true, level, aggro: true, boss: true });
  }
  sim.waveTimer = WAVES.betweenWavesSeconds;
}

/** Near a random player, but never on top of any player or inside an obstacle. */
function enemySpawnPoint(sim: Simulation, players: EntityId[]): Vec2 {
  const w = sim.world;
  const m = WAVES.spawnMargin;
  const minD = WAVES.minSpawnDistance * WAVES.minSpawnDistance;
  let candidate: Vec2 = { x: m, y: m };
  for (let attempt = 0; attempt < WAVES.spawnAttempts; attempt++) {
    const anchorId = players[sim.rand.world.int(0, players.length - 1)];
    const anchor = anchorId === undefined ? undefined : w.position.get(anchorId);
    const a = sim.rand.world.range(0, Math.PI * 2);
    const d = sim.rand.world.range(WAVES.minSpawnDistance, WAVES.maxSpawnDistance);
    candidate = {
      x: clamp((anchor?.x ?? sim.map.width / 2) + Math.cos(a) * d, m, sim.map.width - m),
      y: clamp((anchor?.y ?? sim.map.height / 2) + Math.sin(a) * d, m, sim.map.height - m),
    };
    if (sim.map.pointBlocked(candidate.x, candidate.y, 24, 'move')) continue;
    let ok = true;
    for (const pid of players) {
      const pos = w.position.get(pid);
      if (pos && distSq(candidate.x, candidate.y, pos.x, pos.y) < minD) {
        ok = false;
        break;
      }
    }
    if (ok) break;
  }
  return candidate;
}
