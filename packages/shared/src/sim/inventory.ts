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
  isBound,
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
import { rollDrops } from '../items/drops.js';
import { sellPrice, TRADER } from '../items/prices.js';
import { anchorOf, BAG, canPlace, emptyGrid, findSpot, itemSize, place, placements, removeFrom, STASH, type GridSize } from '../items/grid.js';
import { levelRequirement } from './progression.js';
import { acquireLink, spiritReservedFor } from './auras.js';
import type { EntityId, EquippedSigil, PlayerComp } from './ecs.js';
import { distSq } from './math.js';
import { despawnMinion } from './minions.js';
import type { PlayerSave, Simulation } from './simulation.js';
import { computeStats } from './stats.js';

/** How close to the stash chest a player must stand to use it; like waypoints, checked on the server. */
export const STASH_REACH = 150;


export function compileSigil(p: PlayerComp, item: SigilItem): EquippedSigil {
  return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMods(item).misfireMultiplier };
}

function spiritMax(p: PlayerComp): number {
  return p.stats.spiritMax;
}

function changed(p: PlayerComp): void {
  p.inventoryVersion++;
}

function inBag(p: PlayerComp, uid: ItemUid): boolean {
  return p.inventory.includes(uid);
}

/** Puts an item into the bag, preferring `at` (where the item it replaces was); false when it does not fit. */
function stow(p: PlayerComp, uid: ItemUid, at: { x: number; y: number } | null = null): boolean {
  const item = p.items.get(uid);
  if (!item) return false;
  const size = itemSize(item);
  const spot = at && canPlace(p.inventory, BAG, size, at.x, at.y) ? at : findSpot(p.inventory, BAG, size);
  if (!spot) return false;
  place(p.inventory, BAG, uid, size, spot.x, spot.y);
  return true;
}

export function fitsInBag(p: PlayerComp, item: Item): boolean {
  return findSpot(p.inventory, BAG, itemSize(item)) !== null;
}

export function addItem(p: PlayerComp, item: Item): boolean {
  if (!fitsInBag(p, item)) return false;
  p.items.set(item.uid, item);
  stow(p, item.uid);
  changed(p);
  return true;
}

/**
 * Lays saved items back into a grid. Saves from before grids (a plain list of slots) and anything
 * that no longer fits its old cell are packed in fresh. What fits nowhere is left out of the grid
 * and so becomes pending (see pendingItems), which keeps it with the character.
 */
function layOut(saved: readonly (ItemUid | null)[], size: GridSize, items: Map<ItemUid, Item>): (ItemUid | null)[] {
  const cells = emptyGrid(size);
  const isGrid = saved.length === size.w * size.h;
  // A grid of another size (the bag grew) lists each item once per covered cell, so ids are
  // deduplicated before repacking; an old slot list never repeats one.
  const order = isGrid ? placements(saved, size) : [...new Set(saved.filter((u): u is ItemUid => u !== null))].map((uid) => ({ uid, x: -1, y: -1 }));
  for (const { uid, x, y } of order) {
    const item = items.get(uid);
    if (!item) continue;
    const s = itemSize(item);
    const spot = isGrid && canPlace(cells, size, s, x, y) ? { x, y } : findSpot(cells, size, s);
    if (spot) place(cells, size, uid, s, spot.x, spot.y);
  }
  return cells;
}

/** A new character gets their class's four skills equipped, plus a blank test sigil. */
/** Class starting weapons, so gear exists from the first minute. */
const STARTER_WEAPONS = { warrior: 'rusty_axe', ranger: 'short_bow', mage: 'gnarled_staff', priest: 'gnarled_staff', binder: 'bone_wand' } as const;

export function giveStarterKit(sim: Simulation, pid: EntityId): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const weapon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { base: STARTER_WEAPONS[p.classId] });
  weapon.bound = true;
  p.items.set(weapon.uid, weapon);
  p.gear.weapon = weapon.uid;
  classSkills(p.classId)
    .slice(0, 4)
    .forEach((skill, slot) => {
      const item = createSigil(sim.newItemUid(), sim.rand.loot, 'common', { skill: skill.id });
      item.name = skill.name;
      item.bound = true;
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
  test.bound = true;
  addItem(p, test);
  if (p.classId === 'binder') {
    STARTER_VESSELS.forEach((type, slot) => {
      const v = createVessel(sim.newItemUid(), sim.rand.loot, 'common', type);
      v.bound = true;
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
  p.inventory = layOut(save.inventory.map(re), BAG, p.items);
  p.stash = layOut(save.stash.map(re), STASH, p.items);
  p.warband = save.warband.map(re);
  for (const slot of GEAR_SLOTS) p.gear[slot] = re(save.gear[slot]);
  p.stance = save.stance;
  p.waypoints = [...save.waypoints];
  p.level = save.level;
  p.xp = save.xp;
  p.gold = save.gold;
  save.sigils.forEach((u, slot) => {
    const item = p.items.get(re(u) ?? -1);
    p.sigils[slot] = item?.kind === 'sigil' ? compileSigil(p, item) : null;
  });
  // Last, once every slot is filled: what did not fit (an old 20-slot bag of big items), plus
  // anything left over from before, is retried in the stash. What still does not fit stays
  // pending: kept with the character and retried on every load, never dropped.
  placePending(p);
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
  const item = p.items.get(uid);
  if (!inBag(p, uid) || !item || item.kind !== 'sigil') return 'That sigil is not in your inventory';
  if (levelRequirement(item) > p.level) return `Requires level ${levelRequirement(item)}`;

  const previous = p.sigils[slot] ?? null;
  p.sigils[slot] = compileSigil(p, item);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.sigils[slot] = previous;
    return 'Not enough spirit to equip that';
  }
  const at = anchorOf(p.inventory, BAG, uid);
  removeFrom(p.inventory, uid);
  if (previous && !stow(p, previous.uid, at)) {
    stow(p, uid, at);
    p.sigils[slot] = previous;
    return 'No room in your bag for the swap';
  }
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
  if (!stow(p, eq.uid)) return 'Inventory is full';
  p.sigils[slot] = null;
  p.links[slot] = null;
  changed(p);
  return null;
}

export function equipVessel(sim: Simulation, pid: EntityId, uid: ItemUid, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (p.classId !== 'binder') return 'Only Binders can bind vessels';
  const item = p.items.get(uid);
  if (!inBag(p, uid) || !item || item.kind !== 'vessel') return 'That vessel is not in your inventory';
  if (levelRequirement(item) > p.level) return `Requires level ${levelRequirement(item)}`;

  const previous = p.warband[slot] ?? null;
  p.warband[slot] = uid;
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.warband[slot] = previous;
    return 'Not enough spirit to bind that vessel';
  }
  const at = anchorOf(p.inventory, BAG, uid);
  removeFrom(p.inventory, uid);
  if (previous !== null && !stow(p, previous, at)) {
    stow(p, uid, at);
    p.warband[slot] = previous;
    return 'No room in your bag for the swap';
  }
  despawnMinion(sim, pid, slot);
  p.minionRespawn[slot] = 0;
  changed(p);
  return null;
}

export function unequipVessel(sim: Simulation, pid: EntityId, slot: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const uid = p.warband[slot];
  if (uid === null || uid === undefined) return 'Slot is empty';
  if (!stow(p, uid)) return 'Inventory is full';
  despawnMinion(sim, pid, slot);
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

export function equipGear(sim: Simulation, pid: EntityId, uid: ItemUid, target: GearSlot | null = null): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const item = p.items.get(uid);
  if (!inBag(p, uid) || !item || item.kind !== 'gear') return 'That is not equipment in your inventory';
  if (levelRequirement(item) > p.level) return `Requires level ${levelRequirement(item)}`;
  const slots = GEAR_SLOTS.filter((s) => categoryForSlot(s) === item.category);
  if (target !== null && !slots.includes(target)) return 'That does not go there';
  // Without a target, rings go into whichever ring slot is empty first, otherwise they replace the first ring.
  const slot = target ?? slots.find((s) => p.gear[s] === null) ?? slots[0];
  if (!slot) return 'No slot for that item';
  const previous = p.gear[slot];
  const at = anchorOf(p.inventory, BAG, uid);
  const bagBefore = [...p.inventory];
  removeFrom(p.inventory, uid);
  // The old piece goes where the new one was if it fits, otherwise anywhere; no room means no swap.
  if (previous !== null && !stow(p, previous, at)) {
    p.inventory = bagBefore;
    return 'No room in your bag for the swap';
  }
  p.gear[slot] = uid;
  refreshStats(sim, pid);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.gear[slot] = previous;
    p.inventory = bagBefore;
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
  const item = p.items.get(uid);
  if (!item || !fitsInBag(p, item)) return 'Inventory is full';
  p.gear[slot] = null;
  refreshStats(sim, pid);
  if (spiritReservedFor(p) > spiritMax(p)) {
    p.gear[slot] = uid;
    refreshStats(sim, pid);
    return 'Removing that would leave you without enough spirit';
  }
  stow(p, uid);
  changed(p);
  return null;
}

const KIND_ORDER: Readonly<Record<Item['kind'], number>> = { gear: 0, sigil: 1, vessel: 2 };
const CATEGORY_ORDER = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring'];

/** Bag order after sorting: gear by slot, then sigils, then vessels; best tier and item level first. */
export function compareForSort(a: Item, b: Item): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;
  if (a.kind === 'gear' && b.kind === 'gear') {
    const cat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (cat !== 0) return cat;
  }
  const tier = ITEM_TIERS.indexOf(b.tier) - ITEM_TIERS.indexOf(a.tier);
  if (tier !== 0) return tier;
  if (a.ilvl !== b.ilvl) return b.ilvl - a.ilvl;
  return a.name.localeCompare(b.name) || a.uid - b.uid;
}

/** Packs the bag to the front in sort order. Only the bag moves; nothing equipped changes. */
export function sortInventory(sim: Simulation, pid: EntityId): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const items = placements(p.inventory, BAG).flatMap(({ uid }) => {
    const item = p.items.get(uid);
    return item ? [item] : [];
  });
  items.sort(compareForSort);
  const cells = emptyGrid(BAG);
  for (const item of items) {
    const s = itemSize(item);
    const spot = findSpot(cells, BAG, s);
    // Sorting packs at least as tightly as the bag was, but never lose an item if it somehow does not.
    if (!spot) return 'Could not sort the bag';
    place(cells, BAG, item.uid, s, spot.x, spot.y);
  }
  p.inventory = cells;
  changed(p);
  return null;
}

export function discard(sim: Simulation, pid: EntityId, uid: ItemUid): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const item = p.items.get(uid);
  const pos = sim.world.position.get(pid);
  if (!inBag(p, uid) || !item || !pos) return 'Only unequipped items can be dropped';
  removeFrom(p.inventory, uid);
  p.items.delete(uid);
  spawnBag(sim, pos.x, pos.y, [item], LOOT.bagRadius, pid);
  changed(p);
  return null;
}

/**
 * Bags landing on the same spot would stack into one unreadable pile of labels, so each drop takes
 * the nearest free spot around where it fell, like D2 items scattering. Fixed ring offsets keep it
 * deterministic.
 */
function freeBagSpot(sim: Simulation, x: number, y: number, radius: number): { x: number; y: number } {
  const w = sim.world;
  const taken = (px: number, py: number): boolean => {
    for (const [id] of w.loot) {
      const p = w.position.get(id);
      if (p && (p.x - px) ** 2 + (p.y - py) ** 2 < (radius * 2.2) ** 2) return true;
    }
    return false;
  };
  if (!taken(x, y)) return { x, y };
  for (let ring = 1; ring <= 4; ring++) {
    const d = radius * 2.4 * ring;
    const steps = 6 * ring;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 + ring * 0.5;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      if (!taken(px, py) && !sim.map.pointBlocked(px, py, radius, 'move')) return { x: px, y: py };
    }
  }
  return { x, y };
}

export function spawnBag(sim: Simulation, x: number, y: number, items: Item[], radius: number, ignoreFor: EntityId | null): void {
  const w = sim.world;
  const spot = freeBagSpot(sim, x, y, radius);
  const id = w.create('loot');
  w.position.set(id, spot);
  w.radius.set(id, radius);
  w.loot.set(id, { items, gold: 0, lifetime: LOOT.bagLifetimeSeconds, ignoreFor });
}

export function spawnGold(sim: Simulation, x: number, y: number, amount: number): void {
  if (amount <= 0) return;
  const w = sim.world;
  const spot = freeBagSpot(sim, x, y, LOOT.bagRadius);
  const id = w.create('loot');
  w.position.set(id, spot);
  w.radius.set(id, LOOT.bagRadius);
  w.loot.set(id, { items: [], gold: amount, lifetime: LOOT.bagLifetimeSeconds, ignoreFor: null });
}

/** A click on a ground bag: takes what fits if the player is close enough. Returns why not, or null. */
export function pickupLoot(sim: Simulation, pid: EntityId, lootId: EntityId): string | null {
  const w = sim.world;
  const p = w.player.get(pid);
  const bag = w.loot.get(lootId);
  const pos = w.position.get(pid);
  const at = w.position.get(lootId);
  if (!p || !bag || !pos || !at || p.respawnIn !== null) return null;
  const reach = (w.radius.get(lootId) ?? LOOT.bagRadius) + (w.radius.get(pid) ?? 0) + LOOT.pickupReach;
  if (distSq(pos.x, pos.y, at.x, at.y) > reach * reach) return 'Too far away';
  const before = bag.items.length;
  bag.items = bag.items.filter((item) => !addItem(p, item));
  const taken = before - bag.items.length;
  if (taken > 0) sim.emit({ e: 'pickup', id: pid, x: at.x, y: at.y, count: taken }, at.x, at.y);
  if (bag.items.length === 0 && bag.gold === 0) w.destroy(lootId);
  return bag.items.length > 0 ? 'No room in your bag' : null;
}

export function dropLoot(sim: Simulation, enemyId: EntityId): void {
  const w = sim.world;
  const e = w.enemy.get(enemyId);
  const pos = w.position.get(enemyId);
  // Summoned adds drop nothing, or a necromancer would be an endless loot fountain.
  if (!e || !pos || e.summonerId !== null) return;
  const items = rollDrops(sim.rand.loot, () => sim.newItemUid(), { level: e.level, rare: e.rare, boss: e.boss }, undefined, sim.rates.loot);
  if (items.length > 0) spawnBag(sim, pos.x, pos.y, items, LOOT.bagRadius * (e.rare ? WAVES.rareScale : 1), null);
  if (e.rare || e.boss || sim.rand.loot.next() < LOOT.goldChance * sim.rates.loot) {
    const per = sim.rand.loot.range(LOOT.goldPerLevel.min, LOOT.goldPerLevel.max);
    spawnGold(sim, pos.x + 18, pos.y + 12, Math.round(per * e.level * (e.boss ? 15 : e.rare ? 4 : 1)));
  }
}

export function bestTier(items: readonly Item[]): (typeof ITEM_TIERS)[number] {
  let best = 0;
  for (const it of items) best = Math.max(best, ITEM_TIERS.indexOf(it.tier));
  return ITEM_TIERS[best] ?? 'common';
}

/** Walking over gold picks it up; items wait for a click (pickupLoot), D2 style. */
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
      if (d2 > reach * reach || bag.gold === 0) continue;
      p.gold += bag.gold;
      bag.gold = 0;
      changed(p);
      sim.emit({ e: 'pickup', id: pid, x: pos.x, y: pos.y, count: 0 }, pos.x, pos.y);
      if (bag.items.length === 0) {
        w.destroy(id);
        break;
      }
    }
  }
}


export function nearStash(sim: Simulation, pid: EntityId): boolean {
  const at = sim.mapDef.stash;
  const pos = sim.world.position.get(pid);
  return !!at && !!pos && distSq(at.x, at.y, pos.x, pos.y) <= STASH_REACH * STASH_REACH;
}

/**
 * Moves an item within or between the bag and the stash, to the given top-left cell. The stash can
 * only be touched standing at its chest. The target cells must be free (the item itself aside).
 */
export function moveItem(sim: Simulation, pid: EntityId, uid: ItemUid, to: 'bag' | 'stash', x: number, y: number): string | null {
  const p = sim.world.player.get(pid);
  const item = p?.items.get(uid);
  if (!p || !item) return 'No such item';
  const from = p.inventory.includes(uid) ? 'bag' : p.stash.includes(uid) ? 'stash' : null;
  if (!from) return 'Take it off first';
  if ((from === 'stash' || to === 'stash') && !nearStash(sim, pid)) return 'Stand at the stash to use it';
  const size = itemSize(item);
  const target = to === 'bag' ? p.inventory : p.stash;
  const dims = to === 'bag' ? BAG : STASH;
  if (!canPlace(target, dims, size, x, y, from === to ? uid : null)) return 'No room there';
  removeFrom(from === 'bag' ? p.inventory : p.stash, uid);
  place(target, dims, uid, size, x, y);
  changed(p);
  return null;
}

/** Items the character owns that sit in no grid and no slot, waiting for room. */
export function pendingItems(p: PlayerComp): ItemUid[] {
  const placed = new Set<ItemUid | null>([...p.inventory, ...p.stash, ...p.warband, ...Object.values(p.gear), ...p.sigils.map((s) => s?.uid ?? null)]);
  return [...p.items.keys()].filter((uid) => !placed.has(uid));
}

/** Lays pending items into the stash, then the bag, as far as there is room. */
function placePending(p: PlayerComp): void {
  for (const uid of pendingItems(p)) {
    const item = p.items.get(uid);
    if (!item) continue;
    const s = itemSize(item);
    const inStash = findSpot(p.stash, STASH, s);
    if (inStash) place(p.stash, STASH, uid, s, inStash.x, inStash.y);
    else stow(p, uid);
  }
}

/** The account stash as stored, apart from any character. */
export interface StashSave {
  items: Item[];
  cells: (ItemUid | null)[];
}

/** Splits the stash off a character save, so it can be stored once per account. */
export function splitStash(save: PlayerSave): { character: PlayerSave; stash: StashSave } {
  const inStash = new Set(save.stash.filter((u): u is ItemUid => u !== null));
  return {
    character: { ...save, items: save.items.filter((i) => !inStash.has(i.uid)), stash: emptyGrid(STASH) },
    stash: { items: save.items.filter((i) => inStash.has(i.uid)), cells: [...save.stash] },
  };
}

/** Loads the account stash into a character that just joined. Uids are reissued for this room. */
export function restoreStash(sim: Simulation, pid: EntityId, stash: StashSave): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const remap = new Map<ItemUid, ItemUid>();
  for (const item of stash.items) {
    const uid = sim.newItemUid();
    remap.set(item.uid, uid);
    p.items.set(uid, { ...item, uid });
  }
  // The account's own items keep their cells, so whatever the character spilled in from an old bag
  // is taken out first and laid in around them afterwards.
  p.stash = emptyGrid(STASH);
  const cells = stash.cells.length === STASH.w * STASH.h ? stash.cells : emptyGrid(STASH);
  for (const { uid, x, y } of placements(cells, STASH)) {
    const mine = remap.get(uid);
    const item = mine === undefined ? undefined : p.items.get(mine);
    if (!item || mine === undefined) continue;
    const s = itemSize(item);
    const spot = canPlace(p.stash, STASH, s, x, y) ? { x, y } : findSpot(p.stash, STASH, s);
    if (spot) place(p.stash, STASH, mine, s, spot.x, spot.y);
  }
  // Account items that lost their cell, then the character's spill, go wherever there is room;
  // anything left over stays pending with the character rather than vanishing.
  placePending(p);
  changed(p);
}

export function nearTrader(sim: Simulation, pid: EntityId): boolean {
  const at = sim.mapDef.trader;
  const pos = sim.world.position.get(pid);
  return !!at && !!pos && distSq(at.x, at.y, pos.x, pos.y) <= TRADER.reach * TRADER.reach;
}

/**
 * Sells a bag item to the trader: it leaves the character and the gold comes in. Returns the item
 * for the shared stock, or why not. The server stores the stock and the character together.
 */
export function sellItem(sim: Simulation, pid: EntityId, uid: ItemUid): Item | string {
  const p = sim.world.player.get(pid);
  const item = p?.items.get(uid);
  if (!p || !item || !p.inventory.includes(uid)) return 'Only bag items can be sold';
  if (isBound(item)) return 'Starter items cannot be sold';
  if (!nearTrader(sim, pid)) return 'Stand at the trader to sell';
  removeFrom(p.inventory, uid);
  p.items.delete(uid);
  p.gold += sellPrice(item);
  changed(p);
  return item;
}

/** Buys an item from the stock into the bag. Checked here: reach, gold and room. */
export function buyItem(sim: Simulation, pid: EntityId, item: Item, price: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (!nearTrader(sim, pid)) return 'Stand at the trader to buy';
  if (p.gold < price) return `That costs ${price} gold`;
  const bought = { ...item, uid: sim.newItemUid() };
  if (!addItem(p, bought)) return 'No room in your bag';
  p.gold -= price;
  return null;
}

/** Reorders two skill slots. Nothing is equipped or taken off, so spirit is unchanged. */
export function swapSigils(sim: Simulation, pid: EntityId, a: number, b: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (a === b) return null;
  const sa = p.sigils[a] ?? null;
  p.sigils[a] = p.sigils[b] ?? null;
  p.sigils[b] = sa;
  // A persistent link follows its skill to the new slot.
  const la = p.links[a] ?? null;
  p.links[a] = p.links[b] ?? null;
  p.links[b] = la;
  changed(p);
  return null;
}
