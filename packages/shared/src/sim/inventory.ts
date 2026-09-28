import { LOOT, WAVES } from '../config/sim.js';
import { CLASSES } from '../data/classes.js';
import type { RuneId } from '../data/runes.js';
import { categoryForSlot, GEAR_SLOTS, type GearSlot } from '../data/gear.js';
import { classSkills } from '../data/skills.js';
import {
  compileSigilItem,
  createSigil,
  createGear,
  createVessel,
  ITEM_TIERS,
  rollTier,
  sigilCapacity,
  sigilMods,
  STARTER_VESSELS,
  TEST_SIGIL,
  type Item,
  type ItemUid,
  type SigilItem,
} from '../items/items.js';
import { acquireLink, spiritReservedFor } from './auras.js';
import type { EntityId, EquippedSigil, PlayerComp } from './ecs.js';
import { distSq } from './math.js';
import { despawnMinion } from './minions.js';
import type { PlayerSave, Simulation } from './simulation.js';
import { computeStats } from './stats.js';

export const INVENTORY_SIZE = LOOT.inventorySize;

const NORMAL_TIER_WEIGHTS = { common: 60, magic: 30, rare: 9, relic: 1 } as const;
const RARE_TIER_WEIGHTS = { common: 0, magic: 40, rare: 45, relic: 15 } as const;
const BOSS_TIER_WEIGHTS = { common: 0, magic: 0, rare: 60, relic: 40 } as const;
const BOSS_DROP_COUNT = 4;

export function compileSigil(p: PlayerComp, item: SigilItem): EquippedSigil {
  return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMods(item).misfireMultiplier };
}

function spiritMax(p: PlayerComp): number {
  return p.stats.spiritMax;
}

function changed(p: PlayerComp): void {
  p.inventoryVersion++;
}

function freeSlot(p: PlayerComp): number {
  return p.inventory.indexOf(null);
}

function inventoryIndex(p: PlayerComp, uid: ItemUid): number {
  return p.inventory.indexOf(uid);
}

export function addItem(p: PlayerComp, item: Item): boolean {
  const slot = freeSlot(p);
  if (slot < 0) return false;
  p.items.set(item.uid, item);
  p.inventory[slot] = item.uid;
  changed(p);
  return true;
}

/** A new character gets their class's four skills equipped, plus a blank test sigil. */
/** Class starting weapons, so gear exists from the first minute. */
const STARTER_WEAPONS = { warrior: 'rusty_axe', ranger: 'short_bow', mage: 'gnarled_staff', priest: 'gnarled_staff', binder: 'bone_wand' } as const;

export function giveStarterKit(sim: Simulation, pid: EntityId): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const weapon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { base: STARTER_WEAPONS[p.classId] });
  p.items.set(weapon.uid, weapon);
  p.gear.weapon = weapon.uid;
  classSkills(p.classId)
    .slice(0, 4)
    .forEach((skill, slot) => {
      const item = createSigil(sim.newItemUid(), sim.rand.loot, 'common', { skill: skill.id });
      item.name = skill.name;
      p.items.set(item.uid, item);
      p.sigils[slot] = compileSigil(p, item);
      // Starter persistent skills only go in if they fit, so a class can never start over its spirit.
      if (spiritReservedFor(p) > spiritMax(p)) {
        p.sigils[slot] = null;
        addItem(p, item);
      }
    });
  const test = createSigil(sim.newItemUid(), sim.rand.loot, TEST_SIGIL.tier);
  test.corrupted = TEST_SIGIL.corrupted;
  test.name = TEST_SIGIL.name;
  addItem(p, test);
  if (p.classId === 'binder') {
    STARTER_VESSELS.forEach((type, slot) => {
      const v = createVessel(sim.newItemUid(), sim.rand.loot, 'common', type);
      p.items.set(v.uid, v);
      p.warband[slot] = v.uid;
    });
  }
  changed(p);
}

/** Rebuilds a character that arrived from another room. Item uids are reissued for this room. */
export function restoreSave(sim: Simulation, pid: EntityId, save: PlayerSave): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const remap = new Map<ItemUid, ItemUid>();
  for (const item of save.items) {
    const uid = sim.newItemUid();
    remap.set(item.uid, uid);
    p.items.set(uid, { ...item, uid });
  }
  const re = (u: ItemUid | null): ItemUid | null => (u === null ? null : (remap.get(u) ?? null));
  p.inventory = save.inventory.map(re);
  p.warband = save.warband.map(re);
  for (const slot of GEAR_SLOTS) p.gear[slot] = re(save.gear[slot]);
  p.stance = save.stance;
  save.sigils.forEach((u, slot) => {
    const item = p.items.get(re(u) ?? -1);
    p.sigils[slot] = item?.kind === 'sigil' ? compileSigil(p, item) : null;
  });
  changed(p);
}

export function inscribe(sim: Simulation, pid: EntityId, uid: ItemUid, runes: RuneId[]): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const item = p.items.get(uid);
  if (!item || item.kind !== 'sigil') return 'Not a sigil you own';
  if (runes.length > sigilCapacity(item)) return 'Too many runes for this sigil';

  const slot = p.sigils.findIndex((s) => s?.uid === uid);
  const previous = item.runes;
  const previousSkill = item.skill;
  item.runes = [...runes];
  // Hand-inscribing replaces the prebaked skill; the sigil is now a custom one.
  item.skill = null;
  if (slot >= 0) {
    const before = p.sigils[slot] ?? null;
    p.sigils[slot] = compileSigil(p, item);
    if (spiritReservedFor(p) > spiritMax(p)) {
      item.runes = previous;
      item.skill = previousSkill;
      p.sigils[slot] = before;
      return 'Not enough spirit for that persistent skill';
    }
    p.links[slot] = null;
  }
  changed(p);
  return null;
}

export function equipSigil(sim: Simulation, pid: EntityId, uid: ItemUid, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const invIndex = inventoryIndex(p, uid);
  const item = p.items.get(uid);
  if (invIndex < 0 || !item || item.kind !== 'sigil') return 'That sigil is not in your inventory';

  const previous = p.sigils[slot] ?? null;
  p.sigils[slot] = compileSigil(p, item);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.sigils[slot] = previous;
    return 'Not enough spirit to equip that';
  }
  p.inventory[invIndex] = previous ? previous.uid : null;
  p.links[slot] = null;
  const eq = p.sigils[slot];
  if (eq?.compiled.ok && eq.compiled.program.form === 'link') acquireLink(sim, pid, slot);
  changed(p);
  return null;
}

export function unequipSigil(sim: Simulation, pid: EntityId, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const eq = p.sigils[slot];
  if (!eq) return 'Slot is empty';
  const free = freeSlot(p);
  if (free < 0) return 'Inventory is full';
  p.inventory[free] = eq.uid;
  p.sigils[slot] = null;
  p.links[slot] = null;
  changed(p);
  return null;
}

export function equipVessel(sim: Simulation, pid: EntityId, uid: ItemUid, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (p.classId !== 'binder') return 'Only Binders can bind vessels';
  const invIndex = inventoryIndex(p, uid);
  const item = p.items.get(uid);
  if (invIndex < 0 || !item || item.kind !== 'vessel') return 'That vessel is not in your inventory';

  const previous = p.warband[slot] ?? null;
  p.warband[slot] = uid;
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.warband[slot] = previous;
    return 'Not enough spirit to bind that vessel';
  }
  despawnMinion(sim, pid, slot);
  p.inventory[invIndex] = previous;
  p.minionRespawn[slot] = 0;
  changed(p);
  return null;
}

export function unequipVessel(sim: Simulation, pid: EntityId, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const uid = p.warband[slot];
  if (uid === null || uid === undefined) return 'Slot is empty';
  const free = freeSlot(p);
  if (free < 0) return 'Inventory is full';
  despawnMinion(sim, pid, slot);
  p.inventory[free] = uid;
  p.warband[slot] = null;
  changed(p);
  return null;
}

/** Recomputes stats after equipment changed; life keeps its ratio so swapping a belt does not heal or kill. */
export function refreshStats(sim: Simulation, pid: EntityId): void {
  const p = sim.world.player.get(pid);
  const h = sim.world.health.get(pid);
  if (!p) return;
  p.stats = computeStats(p);
  if (h) {
    const ratio = h.maxLife > 0 ? h.life / h.maxLife : 1;
    h.maxLife = p.stats.maxLife;
    h.life = Math.min(h.maxLife, Math.max(1, ratio * h.maxLife));
  }
}

export function equipGear(sim: Simulation, pid: EntityId, uid: ItemUid): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const idx = inventoryIndex(p, uid);
  const item = p.items.get(uid);
  if (idx < 0 || !item || item.kind !== 'gear') return 'That is not equipment in your inventory';
  const slots = GEAR_SLOTS.filter((s) => categoryForSlot(s) === item.category);
  // Rings go into whichever ring slot is empty first, otherwise they replace the first ring.
  const slot = slots.find((s) => p.gear[s] === null) ?? slots[0];
  if (!slot) return 'No slot for that item';
  const previous = p.gear[slot];
  p.gear[slot] = uid;
  p.inventory[idx] = previous;
  refreshStats(sim, pid);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.gear[slot] = previous;
    p.inventory[idx] = uid;
    refreshStats(sim, pid);
    return 'Removing that would leave you without enough spirit';
  }
  changed(p);
  return null;
}

export function unequipGear(sim: Simulation, pid: EntityId, slot: GearSlot): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const uid = p.gear[slot];
  if (uid === null) return 'Slot is empty';
  const free = freeSlot(p);
  if (free < 0) return 'Inventory is full';
  p.gear[slot] = null;
  refreshStats(sim, pid);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.gear[slot] = uid;
    refreshStats(sim, pid);
    return 'Removing that would leave you without enough spirit';
  }
  p.inventory[free] = uid;
  changed(p);
  return null;
}

export function discard(sim: Simulation, pid: EntityId, uid: ItemUid): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const idx = inventoryIndex(p, uid);
  const item = p.items.get(uid);
  const pos = sim.world.position.get(pid);
  if (idx < 0 || !item || !pos) return 'Only unequipped items can be dropped';
  p.inventory[idx] = null;
  p.items.delete(uid);
  spawnBag(sim, pos.x, pos.y, [item], LOOT.bagRadius, pid);
  changed(p);
  return null;
}

function spawnBag(sim: Simulation, x: number, y: number, items: Item[], radius: number, ignoreFor: EntityId | null): void {
  const w = sim.world;
  const id = w.create('loot');
  w.position.set(id, { x, y });
  w.radius.set(id, radius);
  w.loot.set(id, { items, lifetime: LOOT.bagLifetimeSeconds, ignoreFor });
}

export function dropLoot(sim: Simulation, enemyId: EntityId): void {
  const w = sim.world;
  const e = w.enemy.get(enemyId);
  const pos = w.position.get(enemyId);
  if (!e || !pos) return;
  let count = 0;
  if (e.boss) count = BOSS_DROP_COUNT;
  else if (e.rare) count = sim.rand.loot.int(LOOT.rareDropCount.min, LOOT.rareDropCount.max);
  else if (sim.rand.loot.next() < LOOT.normalDropChance) count = 1;
  if (count === 0) return;

  const items: Item[] = [];
  const weights = e.boss ? BOSS_TIER_WEIGHTS : e.rare ? RARE_TIER_WEIGHTS : NORMAL_TIER_WEIGHTS;
  for (let i = 0; i < count; i++) {
    const tier = rollTier(sim.rand.loot, weights);
    const roll = sim.rand.loot.next();
    items.push(
      roll < LOOT.gearShareOfDrops
        ? createGear(sim.newItemUid(), sim.rand.loot, tier, e.level)
        : roll < LOOT.gearShareOfDrops + LOOT.vesselShareOfDrops
          ? createVessel(sim.newItemUid(), sim.rand.loot, tier, undefined, e.level)
          : createSigil(sim.newItemUid(), sim.rand.loot, tier, { ilvl: e.level, allowCorrupt: true, skill: 'random' }),
    );
  }
  spawnBag(sim, pos.x, pos.y, items, LOOT.bagRadius * (e.rare ? WAVES.rareScale : 1), null);
}

export function bestTier(items: readonly Item[]): (typeof ITEM_TIERS)[number] {
  let best = 0;
  for (const it of items) best = Math.max(best, ITEM_TIERS.indexOf(it.tier));
  return ITEM_TIERS[best] ?? 'common';
}

/** Walking over a bag picks up as many items as fit. */
export function updateLoot(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, bag] of w.loot) {
    bag.lifetime -= dt;
    const pos = w.position.get(id);
    if (!pos || bag.lifetime <= 0) {
      w.destroy(id);
      continue;
    }
    const r = w.radius.get(id) ?? LOOT.bagRadius;
    for (const [pid, p] of w.player) {
      if (p.respawnIn !== null) continue;
      const ppos = w.position.get(pid);
      const reach = r + (w.radius.get(pid) ?? 0);
      if (!ppos) continue;
      const d2 = distSq(pos.x, pos.y, ppos.x, ppos.y);
      if (bag.ignoreFor === pid) {
        if (d2 > (reach + 40) ** 2) bag.ignoreFor = null;
        continue;
      }
      if (d2 > reach * reach) continue;
      let taken = 0;
      while (bag.items.length > 0 && freeSlot(p) >= 0) {
        const item = bag.items.shift();
        if (item && addItem(p, item)) taken++;
      }
      if (taken > 0) sim.emit({ e: 'pickup', id: pid, x: pos.x, y: pos.y, count: taken }, pos.x, pos.y);
      if (bag.items.length === 0) {
        w.destroy(id);
        break;
      }
    }
  }
}

