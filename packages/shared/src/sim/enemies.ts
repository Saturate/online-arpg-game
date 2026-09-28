import { AILMENTS, ENEMY_LEVEL, SIM, SPELL, WAVES, WILDS } from '../config/sim.js';
import { ENEMIES, type EnemyDef, type EnemyTypeId } from '../data/enemies.js';
import { affixValue, rollAffixes } from '../items/items.js';
import { dealDamage, isTargetable } from './combat.js';
import { emptyStatus, type EnemyComp, type EntityId } from './ecs.js';
import { clamp, distSq, type Vec2 } from './math.js';
import type { Simulation } from './simulation.js';
import { spawnProjectile } from './spells.js';

/** Fraction of knockback velocity kept each tick. */
const KNOCK_DECAY = 0.85;
const STRAFE_FRACTION = 0.6;
/** Idle pack members shuffle a little so a camp does not look frozen. */
const IDLE_WANDER_SPEED = 0.25;

export interface SpawnOptions {
  rare: boolean;
  level: number;
  aggro: boolean;
  boss?: boolean;
}

export function spawnEnemy(sim: Simulation, typeId: EnemyTypeId, x: number, y: number, opts: SpawnOptions): EntityId {
  const def = ENEMIES[typeId];
  const w = sim.world;
  const boss = opts.boss ?? false;
  const affixCount = boss ? 3 : sim.rand.world.int(1, 3);
  const affixes = opts.rare || boss ? rollAffixes(sim.rand.world, 'enemy', affixCount, 2) : [];
  const levelMult = 1 + ENEMY_LEVEL.lifePerLevel * (opts.level - 1);
  const lifeMult =
    (opts.rare || boss ? WAVES.rareLifeMultiplier : 1) * (boss ? ENEMY_LEVEL.bossLifeMultiplier : 1) * levelMult * (1 + affixValue(affixes, 'armored') / 100);
  const life = Math.round(def.life * lifeMult);
  const pos = sim.map.findOpen(x, y, def.radius);

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
  });
  return id;
}

/** Places a map's monster packs once, when the room is created. */
export function spawnPacks(sim: Simulation): void {
  for (const pack of sim.mapDef.packs) {
    for (let i = 0; i < pack.count; i++) {
      const a = sim.rand.world.range(0, Math.PI * 2);
      const d = sim.rand.world.range(0, WILDS.packSpread);
      const type = pack.types[i % pack.types.length] ?? 'chaser';
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
  if (def.behaviour === 'chaser') return;
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

    const slow = st && st.chill > 0 ? 1 - AILMENTS.chill.slow : 1;
    const speed = def.moveSpeed * e.speedMult * slow * map.speedAt(pos.x, pos.y);
    const radius = w.radius.get(id) ?? def.radius;

    if (!e.aggro) {
      const seen = pickTarget(sim, e, pos.x, pos.y, WILDS.aggroRadius);
      const spos = seen === null ? undefined : w.position.get(seen);
      if (spos && map.lineClear(pos.x, pos.y, spos.x, spos.y, 4, 'shots')) {
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
          const n = def.bullets + e.extraProjectiles;
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

    if (dist <= contact + 2 && e.contactCooldown <= 0) {
      e.contactCooldown = def.contactCooldown;
      sim.emit({ e: 'attack', id }, pos.x, pos.y);
      dealDamage(sim, target, def.contactDamage * e.damageMult, id, []);
      const shield = w.status.get(target)?.shield;
      if (shield?.burning) dealDamage(sim, id, SPELL.burningWardDamage, target, ['fire']);
    }
  }
  separateEnemies(sim);
  // Separation can shove enemies into rocks; settle everyone against the map last.
  for (const [id, , pos] of w.query(w.enemy, w.position)) {
    const p = map.resolveCircle(pos, w.radius.get(id) ?? 0);
    pos.x = p.x;
    pos.y = p.y;
  }
}

/** Pushes overlapping enemies apart so groups stay readable. */
function separateEnemies(sim: Simulation): void {
  const w = sim.world;
  const ids = [...w.enemy.keys()];
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i];
    if (a === undefined) continue;
    const pa = w.position.get(a);
    const ra = w.radius.get(a) ?? 0;
    if (!pa) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j];
      if (b === undefined) continue;
      const pb = w.position.get(b);
      const rb = w.radius.get(b) ?? 0;
      if (!pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      // Cheap reject first: the wilds hold a few hundred enemies spread over a big map.
      if (Math.abs(dx) > ra + rb || Math.abs(dy) > ra + rb) continue;
      const d = Math.hypot(dx, dy);
      const overlap = ra + rb - d;
      if (overlap <= 0 || d === 0) continue;
      const push = overlap / 2 / d;
      pa.x -= dx * push;
      pa.y -= dy * push;
      pb.x += dx * push;
      pb.y += dy * push;
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
