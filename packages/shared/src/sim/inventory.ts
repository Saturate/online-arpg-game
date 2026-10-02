import { HOUND_PACK, LOOT, MINIONS, WAVES } from '../config/sim.js';
import { classStarterSigils, createStarterSigil } from '../data/starterSigils.js';
import { categoryForSlot, GEAR_SLOTS, type GearSlot } from '../data/gear.js';
import { convertCharacterSave, convertStash } from '../items/convertV2.js';
import {
  createGear,
  createRune,
  clampRuneRolls,
  createVessel,
  holdsBoundRunes,
  isBound,
  isPlainRune,
  matchingStarter,
  ITEM_TIERS,
  reissueUids,
  RUNE_STACK,
  sigilCapacity,
  sigilCastDelayShare,
  sigilMisfireMultiplier,
  STARTER_VESSELS,
  type Item,
  type ItemUid,
  type RuneItem,
  type SigilItem,
} from '../items/items.js';
import { compileSigilItem } from '../runes/v2/compile.js';
import { isCastableRune, RUNE_IDS, runeName, type RuneId } from '../runes/v2/runes.js';
import type { RuneRef } from '../protocol/messages.js';
import { rollDrops } from '../items/drops.js';
import { forgeInsertPrice, sellPrice, TRADER } from '../items/prices.js';
import { anchorOf, BAG, canPlace, emptyGrid, findSpot, itemSize, place, placements, removeFrom, STASH, type GridSize } from '../items/grid.js';
import { STASH_TABS } from '../config/stash.js';
import { cloneLayout, emptyStash, isListableRune, locateInStash, newGeneralTab, removeFromStash, stashItemUids, stashRefuses, type StashLayout, type StashSave } from '../items/stash.js';
import { levelRequirement } from './progression.js';
import { acquireLink, spiritReservedFor } from './auras.js';
import type { DropMark, EntityId, EquippedSigil, PlayerComp } from './ecs.js';
import { distSq } from './math.js';
import { despawnMinion, packVesselCount } from './minions.js';
import type { PlayerSave, Simulation } from './simulation.js';
import { computeStats } from './stats.js';

export const FORGE_REACH = 170;


export function compileSigil(p: PlayerComp, item: SigilItem): EquippedSigil {
  return { uid: item.uid, compiled: compileSigilItem(item, p.classId), misfireMultiplier: sigilMisfireMultiplier(item), castDelayShare: sigilCastDelayShare(item) };
}

/** A notice for one player, for the server to send. */
export interface PlayerNotice {
  pid: EntityId;
  text: string;
}

function sigilName(item: SigilItem): string {
  return matchingStarter(item)?.name ?? item.name;
}

/**
 * Unequips persistent skills from the last slot back until the reserved spirit fits the pool, and
 * names each one. Live tuning can raise a rune's spirit under a sigil already equipped (and a save
 * from before the change loads it equipped), which would otherwise let someone keep more auras than
 * the pool pays for. The sigil goes to the bag, or pending when the bag is full: never lost.
 */
export function fitSpirit(sim: Simulation, pid: EntityId): string[] {
  const p = sim.world.player.get(pid);
  if (!p) return [];
  const out: string[] = [];
  for (let slot = p.sigils.length - 1; slot >= 0 && spiritReservedFor(p) > spiritMax(p); slot--) {
    const eq = p.sigils[slot];
    if (!eq?.compiled.ok || !eq.compiled.persistent) continue;
    const item = p.items.get(eq.uid);
    p.sigils[slot] = null;
    p.links[slot] = null;
    if (item) {
      stow(p, item.uid);
      out.push(item.kind === 'sigil' ? sigilName(item) : item.name);
    }
  }
  if (out.length > 0) {
    settlePending(p);
    changed(p);
  }
  return out;
}

/**
 * Compiles every equipped sigil again, after live tuning changed what runes cost or do, then fits
 * the spirit pool. Returns what each player should be told: skills that stopped casting and skills
 * unequipped for spirit.
 */
export function recompileSigils(sim: Simulation): PlayerNotice[] {
  const notices: PlayerNotice[] = [];
  for (const [pid, p] of sim.world.player) {
    p.sigils.forEach((eq, slot) => {
      const item = eq ? p.items.get(eq.uid) : undefined;
      if (!eq || item?.kind !== 'sigil') return;
      const next = compileSigil(p, item);
      p.sigils[slot] = next;
      if (eq.compiled.ok && !next.compiled.ok) {
        const why = next.compiled.errors[0]?.message ?? 'it breaks a rule';
        notices.push({ pid, text: `${sigilName(item)} no longer casts after a balance change: ${why}` });
      }
    });
    for (const name of fitSpirit(sim, pid)) notices.push({ pid, text: `${name} was unequipped: a balance change raised its spirit past your pool` });
  }
  return notices;
}

function spiritMax(p: PlayerComp): number {
  return p.stats.spiritMax;
}

export function changed(p: PlayerComp): void {
  p.inventoryVersion++;
}

function inBag(p: PlayerComp, uid: ItemUid): boolean {
  return p.inventory.includes(uid);
}

/** Puts an item into the bag, preferring `at` (where the item it replaces was); false when it does not fit. */
export function stow(p: PlayerComp, uid: ItemUid, at: { x: number; y: number } | null = null): boolean {
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

/**
 * Stacks in a grid (the bag unless told otherwise) a plain rune can top up. Bound runes keep their
 * own stacks, so they never make sellable ones, and rolled runes never stack at all.
 */
function matchingStacks(p: PlayerComp, rune: RuneId, bound: boolean, cells: readonly (ItemUid | null)[] = p.inventory): RuneItem[] {
  const out: RuneItem[] = [];
  for (const uid of new Set(cells)) {
    const stack = uid === null ? undefined : p.items.get(uid);
    if (stack?.kind === 'rune' && isPlainRune(stack) && stack.rune === rune && (stack.bound === true) === bound && stack.count < RUNE_STACK) out.push(stack);
  }
  return out;
}

export function stackSpace(p: PlayerComp, rune: RuneId, bound: boolean): number {
  return matchingStacks(p, rune, bound).reduce((n, s) => n + RUNE_STACK - s.count, 0);
}

/** Moves as much of a plain rune item as fits into existing stacks of a grid. `item` shrinks by what moved. */
export function topUpStacks(p: PlayerComp, item: RuneItem, cells: readonly (ItemUid | null)[] = p.inventory): void {
  if (!isPlainRune(item)) return;
  for (const stack of matchingStacks(p, item.rune, item.bound === true, cells)) {
    const moved = Math.min(item.count, RUNE_STACK - stack.count);
    stack.count += moved;
    item.count -= moved;
    if (item.count === 0) break;
  }
  changed(p);
}

/**
 * Puts an item into the bag, all or nothing: false leaves both the bag and the item untouched. A
 * copy that fails (a trader purchase) must not have topped up any stacks on the way.
 */
export function addItem(p: PlayerComp, item: Item): boolean {
  if (item.kind === 'rune' && isPlainRune(item)) {
    if (item.count > stackSpace(p, item.rune, item.bound === true) && !fitsInBag(p, item)) return false;
    topUpStacks(p, item);
    if (item.count === 0) return true;
  }
  if (!fitsInBag(p, item)) return false;
  p.items.set(item.uid, item);
  stow(p, item.uid);
  changed(p);
  return true;
}

/**
 * For a ground stack: takes whatever part of it fits. Only safe on the real ground item, whose count
 * shrinks by exactly what the bag gained. Returns true once it is all taken.
 */
function takeFromGround(p: PlayerComp, item: Item): boolean {
  if (item.kind === 'rune') {
    topUpStacks(p, item);
    if (item.count === 0) return true;
  }
  return addItem(p, item);
}

/**
 * Keeps an item with the character when the bag has no room: outside every grid it is pending, and
 * placePending retries it on every load. Used where losing the item is the only other outcome.
 */
function addOrPend(p: PlayerComp, item: Item): void {
  if (addItem(p, item)) return;
  p.items.set(item.uid, item);
  changed(p);
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

/**
 * Lays a stored stash layout back out over items already in `p.items`, under their new uids. Each
 * item takes the first place that names it; a list only takes items of its kind and up to its cap.
 * Anything left over (a second place for one uid, a bound item, an item past a cap) is not placed,
 * so it waits as pending and placePending lays it in wherever there is room: never dropped.
 */
function relayStash(p: PlayerComp, saved: StashLayout, re: (u: ItemUid | null) => ItemUid | null): StashLayout {
  const out = emptyStash();
  out.general = [];
  const used = new Set<ItemUid>();
  const takes = (uid: ItemUid | null): Item | null => {
    const item = uid === null ? undefined : p.items.get(uid);
    return item && !used.has(item.uid) && !stashRefuses(item) ? item : null;
  };
  for (const tab of saved.general) {
    if (out.general.length >= STASH_TABS.maxGeneral || out.general.some((t) => t.id === tab.id)) continue;
    const mine = tab.cells.map(re).map((u) => (takes(u) ? u : null));
    const cells = layOut(mine, STASH, p.items);
    for (const u of cells) if (u !== null) used.add(u);
    out.general.push({ ...tab, cells });
  }
  if (out.general.length === 0) out.general.push(newGeneralTab(1));
  for (const u of saved.runes.list) {
    const item = takes(re(u));
    // A plain stack over RUNE_STACK (damaged data) is left out, so pending splits it into bag stacks.
    if (item && isListableRune(item) && item.count <= RUNE_STACK && out.runes.list.length < STASH_TABS.runeCap) {
      out.runes.list.push(item.uid);
      used.add(item.uid);
    }
  }
  for (const u of saved.sigils.list) {
    const item = takes(re(u));
    if (item?.kind === 'sigil' && out.sigils.list.length < STASH_TABS.sigilCap) {
      out.sigils.list.push(item.uid);
      used.add(item.uid);
    }
  }
  return out;
}

/** Class starting weapons, so gear exists from the first minute. */
const STARTER_WEAPONS = { warrior: 'rusty_axe', ranger: 'short_bow', mage: 'gnarled_staff', priest: 'gnarled_staff', binder: 'bone_wand' } as const;

export function giveStarterKit(sim: Simulation, pid: EntityId): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const weapon = createGear(sim.newItemUid(), sim.rand.loot, 'common', 1, { base: STARTER_WEAPONS[p.classId] });
  weapon.bound = true;
  p.items.set(weapon.uid, weapon);
  p.gear.weapon = weapon.uid;
  classStarterSigils(p.classId)
    .slice(0, 4)
    .forEach((def, slot) => {
      const item = createStarterSigil(() => sim.newItemUid(), def, { bound: true });
      p.items.set(item.uid, item);
      p.sigils[slot] = compileSigil(p, item);
      // Starter persistent skills only go in if they fit, so a class can never start over its spirit.
      if (spiritReservedFor(p) > spiritMax(p)) {
        p.sigils[slot] = null;
        addItem(p, item);
      }
    });
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

/**
 * Rebuilds a character that arrived from another room. Item uids are reissued for this room,
 * including the runes inside sigils, so no uid is ever in two places.
 */
export function restoreSave(sim: Simulation, pid: EntityId, stored: PlayerSave): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  const save = stored.runeFormat === 2 ? stored : convertCharacterSave(stored).save;
  const remap = new Map<ItemUid, ItemUid>();
  for (const item of save.items) {
    const copy = reissueUids(item, () => sim.newItemUid());
    remap.set(item.uid, copy.uid);
    p.items.set(copy.uid, copy);
  }
  const re = (u: ItemUid | null): ItemUid | null => (u === null ? null : (remap.get(u) ?? null));
  p.inventory = layOut(save.inventory.map(re), BAG, p.items);
  p.stash = relayStash(p, save.stash, re);
  // Saves from when the warband had four slots are padded out to the current size.
  p.warband = Array.from({ length: MINIONS.warbandSlots }, (_, i) => re(save.warband[i] ?? null));
  for (const slot of GEAR_SLOTS) p.gear[slot] = re(save.gear[slot]);
  p.stance = save.stance;
  p.waypoints = [...save.waypoints];
  p.gates = [...(save.gates ?? [])];
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

/** Plain runes of each kind in the bag, the ones the forge takes by id. */
export function ownedRunes(p: PlayerComp): Map<RuneId, number> {
  const out = new Map<RuneId, number>();
  for (const uid of new Set(p.inventory)) {
    const it = uid === null ? undefined : p.items.get(uid);
    if (it?.kind === 'rune' && isPlainRune(it)) out.set(it.rune, (out.get(it.rune) ?? 0) + it.count);
  }
  return out;
}

export function nearForge(sim: Simulation, pid: EntityId): boolean {
  const at = sim.mapDef.forge;
  const pos = sim.world.position.get(pid);
  return !!at && !!pos && distSq(at.x, at.y, pos.x, pos.y) <= FORGE_REACH * FORGE_REACH;
}

/** Where a rolled rune the forge takes lives: the bag, or any stash tab. */
type RuneSource = 'bag' | 'stash';

function runeSource(p: PlayerComp, uid: ItemUid): RuneSource | null {
  return p.inventory.includes(uid) ? 'bag' : locateInStash(p.stash, uid) ? 'stash' : null;
}

/**
 * Where the forge takes a plain rune from, in order: bag stacks (bound ones first), then the rune
 * tab's stacks, then stacks in general tabs.
 */
function plainSources(p: PlayerComp, rune: RuneId): RuneItem[] {
  const stacksIn = (cells: readonly (ItemUid | null)[]): RuneItem[] => {
    const here: RuneItem[] = [];
    for (const uid of new Set(cells)) {
      const it = uid === null ? undefined : p.items.get(uid);
      if (it?.kind === 'rune' && isPlainRune(it) && it.rune === rune && it.count > 0) here.push(it);
    }
    return here.sort((a, b) => Number(b.bound === true) - Number(a.bound === true));
  };
  return [...stacksIn(p.inventory), ...stacksIn(p.stash.runes.list), ...p.stash.general.flatMap((tab) => stacksIn(tab.cells))];
}

/** Takes an item out of the bag and every stash place. */
function unplace(p: PlayerComp, uid: ItemUid): void {
  removeFrom(p.inventory, uid);
  removeFromStash(p.stash, uid);
}

/** One rune for a sigil slot, split off a plain stack: same rune, tier and binding, count 1. */
function oneOf(uid: ItemUid, stack: RuneItem): RuneItem {
  const one: RuneItem = { uid, kind: 'rune', tier: stack.tier, name: stack.name, ilvl: stack.ilvl, rune: stack.rune, count: 1, affixes: [] };
  if (stack.bound === true) one.bound = true;
  return one;
}

/**
 * Sets a sigil's runes, left to right (see RuneRef). Everything is checked before anything moves:
 * the sigil, the forge, capacity, every rune named, gold and spirit. Then runes leave the bag and the
 * stash, the slots are set, gold is paid, and every slot not kept goes back to the bag, or pending
 * when the bag is full; never the stash (it is the account's, and a bound rune must not reach it).
 *
 * `free` is the builders' test bench: plain runes are made on the spot, bound and marked `bench`,
 * and nothing costs gold. A bench rune is never handed back, here or at a real forge, since the
 * bench would otherwise be a free supply; every other rune comes back as usual.
 *
 * A rune that comes back out has its rolls brought into the loot table (clampRuneRolls): a starter
 * rune's hand-set rolls only hold inside a sigil.
 *
 * `base`, when given, is the slot uids the refs were written against. `keep` indices point into the
 * sigil as it is now, so a save drafted from an older sigil (a resent click after the first save
 * landed) would keep the wrong runes and buy the rest again; it is refused instead.
 */
export function inscribe(sim: Simulation, pid: EntityId, uid: ItemUid, refs: readonly RuneRef[], free = false, base?: readonly ItemUid[]): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const item = p.items.get(uid);
  if (!item || item.kind !== 'sigil') return 'Not a sigil you own';
  const slot = p.sigils.findIndex((s) => s?.uid === uid);
  // Only a sigil the character carries: one in the shared stash could carry bound runes to another.
  if (!inBag(p, uid) && slot < 0) return locateInStash(p.stash, uid) ? 'Take the sigil out of the stash first' : 'That sigil is not in your bag';
  if (base && (base.length !== item.slots.length || item.slots.some((r, i) => r.uid !== base[i]))) return 'The sigil changed; look again';
  // The validator refuses these too; checked again because nothing else stops one rune filling two slots.
  const keptIdx = new Set<number>();
  const rolledUids = new Set<ItemUid>();
  for (const r of refs) {
    if (r.from === 'keep') {
      if (keptIdx.has(r.index)) return 'A rune can only fill one slot';
      keptIdx.add(r.index);
    } else if (r.from === 'rolled') {
      if (rolledUids.has(r.uid)) return 'A rune can only fill one slot';
      rolledUids.add(r.uid);
    }
  }
  // Saving an unchanged sigil costs nothing and touches nothing, wherever the player stands.
  if (refs.length === item.slots.length && refs.every((r, i) => r.from === 'keep' && r.index === i)) return null;
  if (!free && !nearForge(sim, pid)) return 'Sigils are inscribed at the forge in town';
  if (refs.length > sigilCapacity(item)) return 'Too many runes for this sigil';

  // Plan: nothing below changes the character until every check has passed.
  const spend = new Map<ItemUid, number>();
  const taken: { uid: ItemUid; from: RuneSource }[] = [];
  const slots: RuneItem[] = [];
  let cost = 0;
  for (const r of refs) {
    if (r.from === 'keep') {
      const kept = item.slots[r.index];
      if (!kept) return 'That slot is empty';
      slots.push(kept);
      continue;
    }
    if (r.from === 'plain') {
      if (!isCastableRune(r.rune)) return `The ${runeName(r.rune)} Rune is not in the game yet`;
      if (free) {
        const made = createRune(sim.newItemUid(), r.rune, 1);
        made.bound = true;
        made.bench = true;
        slots.push(made);
        continue;
      }
      const source = plainSources(p, r.rune).find((stack) => stack.count > (spend.get(stack.uid) ?? 0));
      if (!source) return `You need a ${runeName(r.rune)} Rune`;
      spend.set(source.uid, (spend.get(source.uid) ?? 0) + 1);
      const one = oneOf(sim.newItemUid(), source);
      cost += forgeInsertPrice(one);
      slots.push(one);
      continue;
    }
    const rune = p.items.get(r.uid);
    const from = runeSource(p, r.uid);
    if (rune?.kind !== 'rune' || from === null) return 'That rune is not in your bag or stash';
    if (isPlainRune(rune)) return 'That rune is not a rolled one';
    // Rolled runes never stack; one with a count would lose the rest in a single slot.
    if (rune.count !== 1) return 'That rune cannot be inscribed';
    if (!isCastableRune(rune.rune)) return `The ${runeName(rune.rune)} Rune is not in the game yet`;
    if (!free) cost += forgeInsertPrice(rune);
    taken.push({ uid: r.uid, from });
    slots.push(rune);
  }
  if (!free && p.gold < cost) return `That costs ${cost} gold`;
  const refunds = item.slots.filter((r, i) => !keptIdx.has(i) && r.bench !== true).map(clampRuneRolls);

  if (slot >= 0) {
    const previous = p.sigils[slot] ?? null;
    p.sigils[slot] = compileSigil(p, { ...item, slots });
    if (spiritReservedFor(p) > spiritMax(p)) {
      p.sigils[slot] = previous;
      return 'Not enough spirit for that persistent skill';
    }
  }

  // Apply. Runes leave their grids first, so a refund can use the cells they free.
  for (const [stackUid, n] of spend) {
    const stack = p.items.get(stackUid);
    if (stack?.kind !== 'rune') continue;
    stack.count -= n;
    if (stack.count <= 0) {
      unplace(p, stackUid);
      p.items.delete(stackUid);
    }
  }
  for (const t of taken) {
    unplace(p, t.uid);
    p.items.delete(t.uid);
  }
  item.slots = slots;
  if (!free) p.gold -= cost;
  for (const r of refunds) addOrPend(p, r);
  if (slot >= 0) {
    p.links[slot] = null;
    const eq = p.sigils[slot];
    if (eq?.compiled.ok && eq.compiled.program.form === 'bond') acquireLink(sim, pid, slot);
  }
  settlePending(p);
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
  if (eq?.compiled.ok && eq.compiled.program.form === 'bond') acquireLink(sim, pid, slot);
  settlePending(p);
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
  if (packVesselCount(p) > HOUND_PACK.maxDogs) {
    p.warband[slot] = previous;
    return `Your hounds are at the pack limit of ${HOUND_PACK.maxDogs}`;
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
  settlePending(p);
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
  p.stats = computeStats(p, sim.rates.forceMax);
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
  settlePending(p);
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

const KIND_ORDER: Readonly<Record<Item['kind'], number>> = { gear: 0, sigil: 1, vessel: 2, rune: 3 };
const CATEGORY_ORDER = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'amulet', 'ring'];

/**
 * Bag order after sorting: gear by slot, then sigils, then vessels, then runes grouped by rune with
 * rolled ones ahead of plain stacks; best tier and item level first.
 */
export function compareForSort(a: Item, b: Item): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;
  if (a.kind === 'gear' && b.kind === 'gear') {
    const cat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (cat !== 0) return cat;
  }
  if (a.kind === 'rune' && b.kind === 'rune') {
    const rune = RUNE_IDS.indexOf(a.rune) - RUNE_IDS.indexOf(b.rune);
    if (rune !== 0) return rune;
    const rolled = Number(isPlainRune(a)) - Number(isPlainRune(b));
    if (rolled !== 0) return rolled;
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
  settlePending(p);
  changed(p);
  return null;
}

export function discard(sim: Simulation, pid: EntityId, uid: ItemUid): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  const item = p.items.get(uid);
  const pos = sim.world.position.get(pid);
  if (!inBag(p, uid) || !item || !pos) return 'Only unequipped items can be dropped';
  if (isBound(item)) return 'Bound items stay with this character';
  if (holdsBoundRunes(item)) return 'Take the bound runes out first';
  removeFrom(p.inventory, uid);
  p.items.delete(uid);
  spawnBag(sim, pos.x, pos.y, [item], LOOT.bagRadius, pid);
  settlePending(p);
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
  // A boss cache or gold pile offset from the kill can start inside a rock.
  ({ x, y } = sim.map.findOpen(x, y, radius));
  if (!taken(x, y)) return { x, y };
  for (let ring = 1; ring <= 4; ring++) {
    const d = radius * 2.4 * ring;
    const steps = 6 * ring;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 + ring * 0.5;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      // Also in sight of where it fell: pickup needs a clear line, so a bag behind a thin wall would
      // be out of reach from everywhere.
      if (!taken(px, py) && !sim.map.pointBlocked(px, py, radius, 'move') && sim.map.lineClear(x, y, px, py, 0, 'shots')) return { x: px, y: py };
    }
  }
  return { x, y };
}

/**
 * The item pile a new drop at (x, y) joins: the nearest one within the admin's merge radius of the
 * fall point, in sight of it (a pile behind a wall is a different place), with room for the drop.
 * Gold piles are left out: they go on walk-over and would turn a pile into a coin pile.
 */
function pileFor(sim: Simulation, x: number, y: number, adding: number): EntityId | null {
  const radius = sim.rates.lootMerge;
  if (radius <= 0) return null;
  const w = sim.world;
  let best: EntityId | null = null;
  let bestD = radius * radius;
  for (const [id, pile] of w.loot) {
    if (!w.isAlive(id) || pile.items.length === 0 || pile.gold > 0 || pile.items.length + adding > LOOT.pileMaxItems) continue;
    const at = w.position.get(id);
    if (!at) continue;
    const d = distSq(at.x, at.y, x, y);
    if (d <= bestD && sim.map.lineClear(x, y, at.x, at.y, 0, 'shots')) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/**
 * Lays items on the ground at (x, y): into the item pile there if one is close enough (see pileFor),
 * else as a new pile. `dropper` marks every item as that player's own drop.
 */
export function spawnBag(sim: Simulation, x: number, y: number, items: Item[], radius: number, dropper: EntityId | null): void {
  if (items.length === 0) return;
  const w = sim.world;
  const mark = dropper === null ? null : { id: dropper, x, y };
  const joined = pileFor(sim, x, y, items.length);
  const pile = joined === null ? undefined : w.loot.get(joined);
  if (joined !== null && pile) {
    pile.items.push(...items);
    if (mark) for (const it of items) pile.droppers.set(it.uid, mark);
    // A pile that just grew starts its clock again, so the new drop gets its full time on the ground.
    pile.lifetime = Math.max(pile.lifetime, LOOT.bagLifetimeSeconds);
    pile.rev++;
    w.radius.set(joined, Math.max(w.radius.get(joined) ?? LOOT.bagRadius, radius));
    return;
  }
  const spot = freeBagSpot(sim, x, y, radius);
  const id = w.create('loot');
  w.position.set(id, spot);
  w.radius.set(id, radius);
  const droppers = new Map<ItemUid, DropMark>();
  if (mark) for (const it of items) droppers.set(it.uid, mark);
  w.loot.set(id, { items, gold: 0, lifetime: LOOT.bagLifetimeSeconds, droppers, rev: 0 });
}

export function spawnGold(sim: Simulation, x: number, y: number, amount: number): void {
  if (amount <= 0) return;
  const w = sim.world;
  const spot = freeBagSpot(sim, x, y, LOOT.bagRadius);
  const id = w.create('loot');
  w.position.set(id, spot);
  w.radius.set(id, LOOT.bagRadius);
  w.loot.set(id, { items: [], gold: amount, lifetime: LOOT.bagLifetimeSeconds, droppers: new Map(), rev: 0 });
}

/**
 * Moves every pile on the ground of `from` to the same spot in `to`, for a room rebuilt in place (a
 * town save rebuilds the world). `from` is left with none, so nothing exists twice.
 */
export function carryGroundLoot(from: Simulation, to: Simulation): void {
  const src = from.world;
  const dst = to.world;
  for (const [id, l] of [...src.loot]) {
    const pos = src.position.get(id);
    if (pos) {
      const radius = src.radius.get(id) ?? LOOT.bagRadius;
      const copy = dst.create('loot');
      // On open ground near where it lay: a rebuilt world round a moved gate can have a rock there now.
      dst.position.set(copy, freeBagSpot(to, pos.x, pos.y, radius));
      dst.radius.set(copy, radius);
      // Droppers were entities of the old room; an item nobody claims is free to all, as it soon is anyway.
      dst.loot.set(copy, { items: l.items, gold: l.gold, lifetime: l.lifetime, droppers: new Map(), rev: 0 });
    }
    src.destroy(id);
  }
  src.flushDestroyed();
}

/** Why a player cannot use a pile from where they stand, or null when they can. `slack` widens the reach. */
function pileReachRefusal(sim: Simulation, pid: EntityId, lootId: EntityId, slack: number): string | null {
  const w = sim.world;
  const pos = w.position.get(pid);
  const at = w.position.get(lootId);
  if (!pos || !at) return 'It is gone';
  // The request can arrive before the input frames that walked the hero there, so the server allows
  // a couple of frames of movement more than the client aims for.
  const reach = (w.radius.get(lootId) ?? LOOT.bagRadius) + (w.radius.get(pid) ?? 0) + LOOT.pickupReach + LOOT.pickupLagSlack + slack;
  if (distSq(pos.x, pos.y, at.x, at.y) > reach * reach) return 'Too far away';
  if (!sim.map.lineClear(pos.x, pos.y, at.x, at.y, 0, 'shots')) return 'Out of reach';
  return null;
}

/** A pile's full contents as the loot window shows them, or null once it is gone or out of reach. */
export function lootView(sim: Simulation, pid: EntityId, lootId: EntityId): { items: Item[]; own: ItemUid[]; rev: number } | null {
  const w = sim.world;
  const pile = w.loot.get(lootId);
  const p = w.player.get(pid);
  if (!p || !pile || !w.isAlive(lootId) || p.respawnIn !== null || pile.items.length === 0) return null;
  if (pileReachRefusal(sim, pid, lootId, LOOT.pileWindowSlack) !== null) return null;
  const own = pile.items.filter((it) => pile.droppers.get(it.uid)?.id === pid).map((it) => it.uid);
  return { items: pile.items, own, rev: pile.rev };
}

/**
 * Takes item `uid` from a pile, or every item (`uid` null), if the player is close enough. Each item
 * goes into the bag whole or not at all; a plain rune stack may go in part, shrinking the ground
 * stack by exactly what the bag gained. Returns why not, or null.
 */
export function takeLoot(sim: Simulation, pid: EntityId, lootId: EntityId, uid: ItemUid | null): string | null {
  const w = sim.world;
  const p = w.player.get(pid);
  const pile = w.loot.get(lootId);
  if (!p || p.respawnIn !== null) return null;
  // Destroyed piles stay readable until the end of the tick; their items already went somewhere.
  if (!pile || !w.isAlive(lootId) || pile.items.length === 0) return uid === null ? null : 'Someone else took it';
  const far = pileReachRefusal(sim, pid, lootId, 0);
  if (far) return far;
  // A drop is meant to leave the item: a click on the item just dropped would put it straight back.
  // updateLoot lifts this once the dropper steps away.
  const mine = (it: Item): boolean => pile.droppers.get(it.uid)?.id === pid;
  const wanted = uid === null ? pile.items.filter((it) => !mine(it)) : pile.items.filter((it) => it.uid === uid);
  const one = wanted[0];
  if (uid !== null && !one) return 'Someone else took it';
  if (uid !== null && one && mine(one)) return 'Step away before taking back your own drop';
  if (wanted.length === 0) return 'Step away before taking back your own drop';
  const at = w.position.get(lootId);
  let taken = 0;
  let short = false;
  // By object, not uid: the item that went into the bag is the one that leaves the pile.
  const gone = new Set<Item>();
  for (const it of wanted) {
    const count = it.kind === 'rune' ? it.count : 1;
    if (takeFromGround(p, it)) {
      gone.add(it);
      taken++;
    } else {
      short = true;
      if (it.kind === 'rune' && it.count !== count) taken++;
    }
  }
  if (gone.size > 0) {
    pile.items = pile.items.filter((it) => !gone.has(it));
    for (const it of gone) pile.droppers.delete(it.uid);
  }
  if (taken > 0) {
    pile.rev++;
    if (at) sim.emit({ e: 'pickup', id: pid, x: at.x, y: at.y, count: taken }, at.x, at.y);
  }
  if (pile.items.length === 0 && pile.gold === 0) w.destroy(lootId);
  return short ? 'No room in your bag' : null;
}

/** A click on a single-item pile, or Take all: every item that fits. Returns why not, or null. */
export function pickupLoot(sim: Simulation, pid: EntityId, lootId: EntityId): string | null {
  return takeLoot(sim, pid, lootId, null);
}

export function dropLoot(sim: Simulation, enemyId: EntityId): void {
  const w = sim.world;
  const e = w.enemy.get(enemyId);
  const pos = w.position.get(enemyId);
  // Summoned adds drop nothing, or a necromancer would be an endless loot fountain. Arena runs drop
  // nothing at all: they pay in score and XP.
  if (!e || !pos || e.summonerId !== null || !e.rewards || sim.arena) return;
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

/**
 * Walking over gold picks it up; items wait for a click (takeLoot), D2 style. Each dropped item's
 * mark lifts once its dropper steps away (see DropMark).
 */
export function updateLoot(sim: Simulation, dt: number): void {
  const w = sim.world;
  for (const [id, bag] of w.loot) {
    bag.lifetime -= dt;
    const pos = w.position.get(id);
    if (!pos || bag.lifetime <= 0) {
      w.destroy(id);
      continue;
    }
    for (const [uid, mark] of bag.droppers) {
      const dpos = w.position.get(mark.id);
      // A dropper who left the room, or died, has stepped away as far as the item is concerned.
      if (!dpos || w.player.get(mark.id)?.respawnIn !== null || distSq(dpos.x, dpos.y, mark.x, mark.y) > LOOT.dropStepAway ** 2) {
        bag.droppers.delete(uid);
        bag.rev++;
      }
    }
    if (bag.gold === 0) continue;
    const r = w.radius.get(id) ?? LOOT.bagRadius;
    for (const [pid, p] of w.player) {
      if (p.respawnIn !== null) continue;
      const ppos = w.position.get(pid);
      const reach = r + (w.radius.get(pid) ?? 0);
      if (!ppos || distSq(pos.x, pos.y, ppos.x, ppos.y) > reach * reach) continue;
      const gold = bag.gold;
      p.gold += gold;
      bag.gold = 0;
      changed(p);
      sim.emit({ e: 'pickup', id: pid, x: pos.x, y: pos.y, count: 0, gold }, pos.x, pos.y);
      if (bag.items.length === 0) w.destroy(id);
      break;
    }
  }
}


/** Items the character owns that sit in no grid and no slot, waiting for room. */
export function pendingItems(p: PlayerComp): ItemUid[] {
  const placed = new Set<ItemUid | null>([...p.inventory, ...stashItemUids(p.stash), ...p.warband, ...Object.values(p.gear), ...p.sigils.map((s) => s?.uid ?? null)]);
  return [...p.items.keys()].filter((uid) => !placed.has(uid));
}

/**
 * Lays pending items out as far as there is room. A plain rune first tops up matching bag stacks,
 * so a refund never takes a cell a stack could hold. Then, on load (`withStash`), what is left goes
 * to the stash, each kind to its tab (plain runes into their rune slot up to its cap, rolled runes and
 * sigils into their lists while there is room, the rest into the first general tab with room), and
 * only then to the bag; otherwise only to the bag, since the stash is not at hand.
 */
function placePending(p: PlayerComp, withStash = true): void {
  for (const uid of pendingItems(p)) {
    const item = p.items.get(uid);
    if (!item) continue;
    // Bound items stay with the character: bag or pending, never the account's shared stash.
    const stash = withStash && stashRefuses(item) === null;
    if (item.kind === 'rune' && isPlainRune(item)) {
      topUpStacks(p, item);
      if (stash) topUpStacks(p, item, p.stash.runes.list);
      if (item.count <= 0) {
        p.items.delete(uid);
        continue;
      }
    }
    // A stack past RUNE_STACK (damaged data) is kept out of the rune tab, which never holds one.
    if (stash && isListableRune(item) && item.count <= RUNE_STACK && p.stash.runes.list.length < STASH_TABS.runeCap) {
      p.stash.runes.list.push(uid);
      continue;
    }
    if (stash && item.kind === 'sigil' && p.stash.sigils.list.length < STASH_TABS.sigilCap) {
      p.stash.sigils.list.push(uid);
      continue;
    }
    const s = itemSize(item);
    let placed = false;
    for (const tab of stash ? p.stash.general : []) {
      const spot = findSpot(tab.cells, STASH, s);
      if (!spot) continue;
      place(tab.cells, STASH, uid, s, spot.x, spot.y);
      placed = true;
      break;
    }
    if (!placed) stow(p, uid);
  }
}

/** After anything that can free bag room: pending items move in by themselves. */
export function settlePending(p: PlayerComp): void {
  if (pendingItems(p).length === 0) return;
  placePending(p, false);
  changed(p);
}

/** Splits the stash off a character save, so it can be stored once per account. */
export function splitStash(save: PlayerSave): { character: PlayerSave; stash: StashSave } {
  const inStash = new Set(stashItemUids(save.stash));
  return {
    character: { ...save, items: save.items.filter((i) => !inStash.has(i.uid)), stash: emptyStash() },
    stash: { ...cloneLayout(save.stash), runeFormat: 2, runeTiers: 6, items: save.items.filter((i) => inStash.has(i.uid)) },
  };
}

/**
 * Loads the account stash into a character that just joined. Uids (sigil slots too) are reissued
 * for this room. The stash converts to tabs (convertStashTabs) before it gets here.
 */
export function restoreStash(sim: Simulation, pid: EntityId, stored: StashSave): void {
  const p = sim.world.player.get(pid);
  if (!p) return;
  // The character's own stash layout (anything restoreSave laid into it) gives way to the
  // account's: its items become pending and are laid in around the account's below.
  const remap = new Map<ItemUid, ItemUid>();
  for (const item of stored.items) {
    const copy = reissueUids(item, () => sim.newItemUid());
    remap.set(item.uid, copy.uid);
    p.items.set(copy.uid, copy);
  }
  p.stash = relayStash(p, stored, (u) => (u === null ? null : (remap.get(u) ?? null)));
  // Account items that lost their place, then the character's spill, go wherever there is room;
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
  if (isBound(item)) return 'Bound items cannot be sold';
  if (holdsBoundRunes(item)) return 'Take the bound runes out first';
  if (!nearTrader(sim, pid)) return 'Stand at the trader to sell';
  removeFrom(p.inventory, uid);
  p.items.delete(uid);
  p.gold += sellPrice(item);
  settlePending(p);
  changed(p);
  return item;
}

/** Buys an item from the stock into the bag. Checked here: reach, gold and room. */
export function buyItem(sim: Simulation, pid: EntityId, item: Item, price: number): string | null {
  const p = sim.world.player.get(pid);
  if (!p) return 'No player';
  if (!nearTrader(sim, pid)) return 'Stand at the trader to buy';
  if (p.gold < price) return `That costs ${price} gold`;
  // The shelf keeps its copy, so the bought one (and every rune in a sigil) gets fresh uids.
  const bought = reissueUids(item, () => sim.newItemUid());
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
