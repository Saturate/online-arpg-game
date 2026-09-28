import { AURA, LINK, SPELL } from '../config/sim.js';
import type { EffectId, ElementId } from '../data/runes.js';
import { vesselSpirit } from '../items/items.js';
import type { SpellNode } from '../runes/compiler.js';
import { dealDamage, healEntity, isTargetable, knockback } from './combat.js';
import { emptyBuffs, type EntityId, type PlayerComp } from './ecs.js';
import { angleDiff, distSq } from './math.js';
import type { Simulation } from './simulation.js';

type AuraType = EffectId | ElementId;

/** Chill and shock from auras are refreshed every tick, so a short duration means they drop quickly outside the radius. */
const AURA_AILMENT_SECONDS = 0.3;

export function auraRadius(node: SpellNode): number {
  return AURA.radius * SPELL.modifiers.largeRadius ** node.modifiers.large * node.areaScale;
}

export function spiritReservedFor(p: PlayerComp): number {
  let total = 0;
  for (const eq of p.sigils) if (eq && eq.compiled.ok && eq.compiled.persistent) total += eq.compiled.spirit;
  for (const uid of p.warband) {
    if (uid === null) continue;
    const item = p.items.get(uid);
    if (item?.kind === 'vessel') total += vesselSpirit(item);
  }
  return total;
}

function linkCandidates(sim: Simulation, pid: EntityId): EntityId[] {
  const w = sim.world;
  const out: EntityId[] = [];
  for (const [id] of w.player) if (id !== pid && isTargetable(sim, id)) out.push(id);
  for (const [id, m] of w.minion) if (m.ownerId === pid && isTargetable(sim, id)) out.push(id);
  return out;
}

/** Picks the nearest ally or own minion inside the aim cone. Clears the link if none is found. */
export function acquireLink(sim: Simulation, pid: EntityId, slot: number): void {
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  if (!p || !pos) return;
  let best: EntityId | null = null;
  let bestD = LINK.acquireRange * LINK.acquireRange;
  for (const id of linkCandidates(sim, pid)) {
    const tpos = w.position.get(id);
    if (!tpos) continue;
    const d = distSq(pos.x, pos.y, tpos.x, tpos.y);
    if (d > bestD) continue;
    if (Math.abs(angleDiff(Math.atan2(tpos.y - pos.y, tpos.x - pos.x), p.aimAngle)) > LINK.acquireConeRadians) continue;
    best = id;
    bestD = d;
  }
  p.links[slot] = { targetId: best, connected: best !== null };
}

function auraTypes(node: SpellNode): AuraType[] {
  return [...node.effects, ...node.elements];
}

function raiseBest(map: Map<EntityId, Map<AuraType, number>>, id: EntityId, type: AuraType, strength: number): void {
  let m = map.get(id);
  if (!m) {
    m = new Map();
    map.set(id, m);
  }
  if ((m.get(type) ?? 0) < strength) m.set(type, strength);
}

/**
 * Recomputes buffs from auras and links, then applies regeneration and aura damage. Only the
 * strongest aura of each type counts for any one target, so two Restore auras do not stack.
 */
export function updateAuras(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const id of w.player.keys()) w.buffs.set(id, emptyBuffs());
  for (const id of w.minion.keys()) w.buffs.set(id, emptyBuffs());

  const allyBest = new Map<EntityId, Map<AuraType, number>>();
  const enemyBest = new Map<EntityId, Map<AuraType, number>>();
  const pushFrom = new Map<EntityId, { x: number; y: number; strength: number }>();
  const allies = [...w.player.keys(), ...w.minion.keys()];

  for (const [pid, p] of w.player) {
    const pos = w.position.get(pid);
    if (!pos || p.respawnIn !== null) continue;
    p.sigils.forEach((eq, slot) => {
      if (!eq || !eq.compiled.ok || !eq.compiled.persistent) return;
      const node = eq.compiled.program;
      const strength = node.damageScale;

      if (node.form === 'aura') {
        const r = auraRadius(node);
        const r2 = r * r;
        for (const aid of allies) {
          if (!isTargetable(sim, aid)) continue;
          const apos = w.position.get(aid);
          if (!apos || distSq(pos.x, pos.y, apos.x, apos.y) > r2) continue;
          for (const t of node.effects) raiseBest(allyBest, aid, t, strength);
        }
        for (const [eid] of w.enemy) {
          const epos = w.position.get(eid);
          if (!epos || distSq(pos.x, pos.y, epos.x, epos.y) > r2) continue;
          for (const t of auraTypes(node)) {
            if (t === 'impact') {
              const prev = pushFrom.get(eid);
              if (!prev || prev.strength < strength) pushFrom.set(eid, { x: pos.x, y: pos.y, strength });
            } else if (t !== 'ward' && t !== 'restore') {
              raiseBest(enemyBest, eid, t, strength);
            }
          }
        }
        return;
      }

      if (node.form === 'link') updateLink(sim, pid, p, slot, node);
    });
  }

  for (const [aid, types] of allyBest) {
    const b = w.buffs.get(aid);
    if (!b) continue;
    b.regenPerSecond += (types.get('restore') ?? 0) * AURA.restoreRegenPerSecond;
    b.damageReduction += (types.get('ward') ?? 0) * AURA.wardReduction;
  }

  for (const [eid, types] of enemyBest) {
    for (const [t, strength] of types) {
      if (t !== 'fire' && t !== 'cold' && t !== 'lightning') continue;
      dealDamage(sim, eid, AURA.elementDps * strength * dt, eid, [t], { quiet: true });
      if (t !== 'fire') {
        const st = w.status.get(eid);
        if (st && t === 'cold') st.chill = Math.max(st.chill, AURA_AILMENT_SECONDS);
        if (st && t === 'lightning') st.shock = Math.max(st.shock, AURA_AILMENT_SECONDS);
      }
    }
  }
  for (const [eid, from] of pushFrom) knockback(sim, eid, from.x, from.y, AURA.forcePushPerTick * from.strength);

  for (const aid of allies) {
    const b = w.buffs.get(aid);
    if (!b || b.regenPerSecond <= 0) continue;
    healEntity(sim, aid, Math.min(AURA.regenCapPerSecond, b.regenPerSecond) * dt, false);
  }
}

/** Links break beyond `breakRange` and reconnect on their own once back within `acquireRange`. */
function updateLink(sim: Simulation, pid: EntityId, p: PlayerComp, slot: number, node: SpellNode): void {
  const w = sim.world;
  const pos = w.position.get(pid);
  const link = p.links[slot];
  if (!pos || !link || link.targetId === null) return;
  if (!isTargetable(sim, link.targetId)) {
    // A dead minion respawns as a new entity, so the tether has nothing to reconnect to.
    if (!w.isAlive(link.targetId)) p.links[slot] = { targetId: null, connected: false };
    else link.connected = false;
    return;
  }
  const tpos = w.position.get(link.targetId);
  if (!tpos) return;
  const d2 = distSq(pos.x, pos.y, tpos.x, tpos.y);
  if (link.connected && d2 > LINK.breakRange * LINK.breakRange) link.connected = false;
  else if (!link.connected && d2 <= LINK.acquireRange * LINK.acquireRange) link.connected = true;
  if (!link.connected) return;

  const b = w.buffs.get(link.targetId);
  if (!b) return;
  const strength = node.damageScale;
  if (node.effects.includes('restore')) b.regenPerSecond += LINK.restoreRegenPerSecond * strength;
  if (node.effects.includes('ward')) b.damageReduction += LINK.wardReduction * strength;
  b.elementDamageBonus += node.elements.length * LINK.elementDamageBonus * strength;
}
