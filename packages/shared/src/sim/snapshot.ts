import { CLASSES } from '../data/classes.js';
import { cloneLayout } from '../items/stash.js';
import { stashTabPrice } from '../config/stash.js';
import { xpToNext } from './progression.js';
import { LOOT, SIM } from '../config/sim.js';
import type { AuraSnap, EntitySnap, GameEvent, InventoryMessage, LootName, SelfState, Snapshot, SpellSnap } from '../protocol/messages.js';
import { ITEM_TIERS, type Item } from '../items/items.js';
import { STATUS } from '../protocol/messages.js';
import { auraRadius, persistentNode, spiritReservedFor } from './auras.js';
import type { EntityId, StatusComp } from './ecs.js';
import { bestTier } from './inventory.js';
import { distSq } from './math.js';
import type { PositionedEvent, Simulation } from './simulation.js';
import { castCooldownLength, spellFx } from './spells.js';

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function statusFlags(st: StatusComp | undefined): number {
  if (!st) return 0;
  let f = 0;
  if (st.burn) f |= STATUS.burn;
  if (st.chill > 0) f |= STATUS.chill;
  if (st.shock > 0) f |= STATUS.shock;
  if (st.curse > 0) f |= STATUS.cursed;
  if (st.poison.length > 0) f |= STATUS.poison;
  if (st.shield) f |= st.shield.burning ? STATUS.shield | STATUS.burningShield : STATUS.shield;
  return f;
}

/** Serialises every entity once per tick; per-player filtering happens afterwards. */
export function serializeEntities(sim: Simulation): EntitySnap[] {
  const w = sim.world;
  const out: EntitySnap[] = [];
  for (const [id, kind] of w.kind) {
    if (!w.isAlive(id)) continue;
    const pos = w.position.get(id);
    if (!pos) continue;
    const base = { id, x: round1(pos.x), y: round1(pos.y), r: round1(w.radius.get(id) ?? 0) };
    const st = statusFlags(w.status.get(id));
    switch (kind) {
      case 'player': {
        const p = w.player.get(id);
        const h = w.health.get(id);
        if (!p || !h) break;
        const auras: AuraSnap[] = [];
        const links: EntityId[] = [];
        p.sigils.forEach((eq, slot) => {
          if (!eq?.compiled.ok || !eq.compiled.persistent) return;
          const node = persistentNode(eq.compiled.program);
          if (!node) return;
          if (node.form === 'aura') auras.push({ r: round1(auraRadius(node)), fx: spellFx(node), el: node.elements[0] ?? null });
          const link = p.links[slot];
          if (node.form === 'bond' && link?.connected && link.targetId !== null) links.push(link.targetId);
        });
        out.push({
          ...base,
          k: 'player',
          cls: p.classId,
          name: p.name,
          a: round2(p.aimAngle),
          life: Math.ceil(h.life),
          maxLife: h.maxLife,
          dead: p.respawnIn !== null,
          dashing: p.dash !== null,
          st,
          auras,
          links,
        });
        break;
      }
      case 'enemy': {
        const e = w.enemy.get(id);
        const h = w.health.get(id);
        if (!e || !h) break;
        const flags = st | (e.burrowed ? STATUS.hidden : 0) | (e.enraged ? STATUS.enraged : 0);
        out.push({ ...base, k: 'enemy', et: e.typeId, rare: e.rare, dormant: !e.aggro, boss: e.boss, lvl: e.level, ax: e.affixes.map((x) => x.id), life: Math.ceil(h.life), maxLife: h.maxLife, st: flags, a: round2(e.facing) });
        break;
      }
      case 'minion': {
        const m = w.minion.get(id);
        const h = w.health.get(id);
        if (!m || !h) break;
        out.push({ ...base, k: 'minion', mt: m.typeId, owner: m.ownerId, ...(m.pack ? { pack: m.pack.role } : {}), life: Math.ceil(h.life), maxLife: h.maxLife, st, a: round2(m.facing) });
        break;
      }
      case 'projectile': {
        const proj = w.projectile.get(id);
        if (!proj) break;
        out.push({
          ...base,
          k: 'projectile',
          team: w.team.get(id) ?? 'players',
          owner: proj.ownerId,
          el: proj.elements[0] ?? null,
          fx: proj.spell ? spellFx(proj.spell.node) : 'damage',
          ...(proj.spell?.node.form === 'orb' ? ORB_FLAG : {}),
        });
        break;
      }
      case 'nova': {
        const n = w.nova.get(id);
        if (!n) break;
        out.push({ ...base, k: 'nova', maxR: round1(n.maxRadius), el: n.spell.node.elements[0] ?? null, fx: spellFx(n.spell.node) });
        break;
      }
      case 'zone': {
        const z = w.zone.get(id);
        if (!z) break;
        out.push({
          ...base,
          k: 'zone',
          el: z.spell.node.elements[0] ?? null,
          fx: spellFx(z.spell.node),
          left: round2(Math.max(0, 1 - z.spell.age / z.duration)),
        });
        break;
      }
      case 'loot': {
        const l = w.loot.get(id);
        if (!l) break;
        out.push({ ...base, k: 'loot', tier: bestTier(l.items), count: l.items.length, names: previewNames(l.items), gold: l.gold });
        break;
      }
    }
  }
  return out;
}

/**
 * Snapshots go out every tick to everyone near, so a pile sends only its best few names (best tier
 * first, then drop order); the loot window asks for the rest.
 */
export function previewNames(items: readonly Item[]): LootName[] {
  const order = items.map((it, i) => ({ it, i, rank: ITEM_TIERS.indexOf(it.tier) + (it.kind === 'vessel' && it.fixedName ? ITEM_TIERS.length : 0) }));
  order.sort((a, b) => b.rank - a.rank || a.i - b.i);
  return order.slice(0, LOOT.pilePreviewNames).map(({ it }) => {
    const name: LootName = { n: it.name, tier: it.tier };
    if (it.kind === 'vessel' && it.fixedName) name.u = true;
    if (it.kind === 'rune' && it.count > 1) name.c = it.count;
    return name;
  });
}

function selfState(sim: Simulation, pid: EntityId): SelfState | null {
  const p = sim.world.player.get(pid);
  if (!p) return null;
  return {
    respawnIn: p.respawnIn,
    castCooldown: round2(p.castCooldown),
    castCooldownFull: round2(castCooldownLength(sim, pid)),
    heat: round1(p.heat),
    spiritMax: p.stats.spiritMax,
    heatMax: p.stats.heatMax,
    moveSpeed: p.stats.moveSpeed,
    stats: p.stats,
    spiritReserved: spiritReservedFor(p),
    dash: p.dash,
    stance: p.stance,
    minionRespawn: p.minionRespawn.map((t) => round1(Math.max(0, t))),
    links: p.links.map((l) => (l ? { targetId: l.targetId, connected: l.connected } : null)),
    level: p.level,
    xp: Math.floor(p.xp),
    xpNext: xpToNext(p.level),
    gates: p.gates,
  };
}

type SpellEntity = Extract<EntitySnap, { k: 'projectile' | 'nova' | 'zone' }>;

const ORB_FLAG: { orb: true } = { orb: true };

function isSpellEntity(e: EntitySnap): e is SpellEntity {
  return e.k === 'projectile' || e.k === 'nova' || e.k === 'zone';
}

/** The spell entity plus what the client needs to carry it forward on its own. */
function spellRecord(sim: Simulation, e: SpellEntity): SpellSnap {
  const w = sim.world;
  if (e.k === 'projectile') {
    const v = w.velocity.get(e.id);
    return { ...e, vx: round1(v?.x ?? 0), vy: round1(v?.y ?? 0) };
  }
  if (e.k === 'nova') {
    const n = w.nova.get(e.id);
    return { ...e, age: round2(n?.spell.age ?? 0), dur: n?.duration ?? 1 };
  }
  const z = w.zone.get(e.id);
  return { ...e, age: round2(z?.spell.age ?? 0), dur: z?.duration ?? 1 };
}

/** What would make a sent projectile record stale: its motion changing (a reflect, homing). */
function projectileKey(sim: Simulation, e: Extract<EntitySnap, { k: 'projectile' }>): string {
  const v = sim.world.velocity.get(e.id);
  return `${round1(v?.x ?? 0)},${round1(v?.y ?? 0)},${e.team},${e.r}`;
}

/**
 * A spell record carried forward `ticks` ticks, as the client does between records. Projectiles fly
 * straight, novas grow to their full radius over their duration, zones fade over theirs.
 */
export function advanceSpell(r: SpellSnap, ticks: number): EntitySnap {
  const dt = ticks * SIM.dt;
  if (r.k === 'projectile') {
    const { vx, vy, ...e } = r;
    return { ...e, x: round1(e.x + vx * dt), y: round1(e.y + vy * dt) };
  }
  const age = r.age + dt;
  if (r.k === 'nova') {
    const { age: _a, dur, ...e } = r;
    return { ...e, r: round1(e.maxR * Math.min(1, age / dur)) };
  }
  const { age: _a, dur, ...e } = r;
  return { ...e, left: round2(Math.max(0, 1 - age / dur)) };
}

/**
 * Interest management: a player receives entities and events within `radius` of themselves, plus
 * their own minions and link targets wherever they are.
 *
 * With `known` (the spell records this client already has, by id), spell entities are sent only
 * when new to the client or when their motion changes, then listed in `gone` when they end or leave
 * view. They were half the bytes of a busy snapshot, resent every tick though the client can move
 * them itself. Without `known`, every entity goes out in full, as tests and tools expect.
 */
export function snapshotFor(
  sim: Simulation,
  pid: EntityId,
  all: readonly EntitySnap[],
  events: readonly PositionedEvent[],
  radius: number,
  known?: Map<EntityId, string>,
): Snapshot {
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  const r2 = radius * radius;
  const always = new Set<EntityId>([pid]);
  if (p) {
    for (const m of p.minions) if (m !== null) always.add(m);
    for (const pack of p.packs) for (const m of pack.mates) always.add(m);
    for (const l of p.links) if (l?.targetId !== null && l?.targetId !== undefined) always.add(l.targetId);
  }
  const near = (x: number, y: number): boolean => !pos || distSq(x, y, pos.x, pos.y) <= r2;

  const visible = all.filter((e) => always.has(e.id) || near(e.x, e.y) || (e.k === 'minion' && e.owner === pid));
  const entities: EntitySnap[] = [];
  const spells: SpellSnap[] = [];
  const gone: EntityId[] = [];
  if (!known) entities.push(...visible);
  else {
    const seen = new Set<EntityId>();
    for (const e of visible) {
      if (!isSpellEntity(e)) {
        entities.push(e);
        continue;
      }
      seen.add(e.id);
      // Only a projectile's motion can change; build the full record only when the key says so.
      const key = e.k === 'projectile' ? projectileKey(sim, e) : e.k;
      if (known.get(e.id) === key) continue;
      known.set(e.id, key);
      spells.push(spellRecord(sim, e));
    }
    for (const id of known.keys()) {
      if (seen.has(id)) continue;
      known.delete(id);
      gone.push(id);
    }
  }
  const evs: GameEvent[] = [];
  for (const pe of events) if (near(pe.x, pe.y)) evs.push(pe.ev);

  const players: Snapshot['players'] = [];
  for (const [id, other] of w.player) {
    const h = w.health.get(id);
    if (h) players.push({ id, name: other.name, cls: other.classId, level: other.level, life: Math.ceil(h.life), maxLife: h.maxLife, dead: other.respawnIn !== null });
  }

  return {
    t: 'snapshot',
    tick: sim.tick,
    lastProcessedInputSeq: p?.lastProcessedInputSeq ?? -1,
    self: selfState(sim, pid),
    entities,
    spells,
    gone,
    events: evs,
    roomEntityCount: w.entityCount,
    wave: sim.wave,
    players,
    paused: false,
    ...(sim.cleared ? { exitOpen: true } : {}),
  };
}

export function inventoryMessage(sim: Simulation, pid: EntityId): InventoryMessage | null {
  const p = sim.world.player.get(pid);
  if (!p) return null;
  return {
    t: 'inventory',
    items: [...p.items.values()],
    inventory: [...p.inventory],
    stash: cloneLayout(p.stash),
    stashTabPrice: stashTabPrice(p.stash.general.length),
    gold: p.gold,
    sigils: p.sigils.map((s) => s?.uid ?? null),
    warband: [...p.warband],
    gear: { ...p.gear },
  };
}
