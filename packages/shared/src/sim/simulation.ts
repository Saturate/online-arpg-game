import { ENEMY_LEVEL, HEAT, LOOT, MINIONS, SIM, WAVES } from '../config/sim.js';
import { CLASSES, type ClassId } from '../data/classes.js';
import type { EnemyTypeId } from '../data/enemies.js';
import { STANCES, type Stance } from '../data/minions.js';
import { BASE_TUNING, type MonsterTuning } from '../data/tuning.js';
import type { GearSlot } from '../data/gear.js';
import type { Item, ItemUid } from '../items/items.js';
import type { GridDest, ItemDest, RuneRef } from '../protocol/messages.js';
import type { StashColorId } from '../config/stash.js';
import type { AffixId } from '../data/affixes.js';
import { BAG, emptyGrid } from '../items/grid.js';
import { cloneLayout, emptyStash, type StashLayout, type StashSortKey, type StashTabRef } from '../items/stash.js';
import { BUTTON, SKILL_BUTTONS, type GameEvent, type InputFrame } from '../protocol/messages.js';
import type { GameMap } from '../world/gamemap.js';
import { loadMap } from '../world/maps.js';
import { FlowField } from '../world/nav.js';
import type { MapDescriptor, Portal, PortalTarget, WorldMap } from '../world/types.js';
import type { ZoneWorld } from '../world/zoneGen.js';
import type { ArenaState } from './arena.js';
import { emptyBuffs, emptyStatus, World, type EntityId } from './ecs.js';
import { spawnEnemy, spawnPacks } from './enemies.js';
import * as inv from './inventory.js';
import * as stash from './stash.js';
import { distSq, type Vec2 } from './math.js';
import { despawnMinion } from './minions.js';
import { gateSeal } from './gates.js';
import { stepPlayer } from './movement.js';
import { Rng } from './rng.js';
import { castSkill, updateDashSpell } from './spells.js';
import { computeStats, baseStats } from './stats.js';
import { SYSTEMS } from './systems.js';

export interface PositionedEvent {
  ev: GameEvent;
  x: number;
  y: number;
}

/** Everything that survives moving a character between rooms. Life, heat and minions are rebuilt on arrival. */
export interface PlayerSave {
  classId: ClassId;
  name: string;
  items: Item[];
  inventory: (ItemUid | null)[];
  /** Account stash. The server stores it per account, apart from the character. */
  stash: StashLayout;
  sigils: (ItemUid | null)[];
  warband: (ItemUid | null)[];
  gear: Record<GearSlot, ItemUid | null>;
  stance: Stance;
  /** Waypoints this character has touched, by world waypoint id (`steppe-1`); the town's is never listed. */
  waypoints: string[];
  level: number;
  xp: number;
  gold: number;
  /** Rune items and sigil slots (v2). A save without it is v1 and is converted before it is read. */
  runeFormat: 2;
  /** Rune affix rolls count six tiers (2026-10-01). Required on what is written; see StoredPlayerSave for what is read. */
  runeTiers: 6;
  /** Waypoints hold world ids. A save without it lists the old zones' ids and is converted before it is read. */
  worldFormat: 1;
  /** Gates this character has opened (`sim/gates.ts`). A save from before gate bosses has none. */
  gates?: string[];
}

/** A character save as read from storage, before the one-time rune roll pass: it may predate the six tiers. */
export type StoredPlayerSave = Omit<PlayerSave, 'runeTiers'> & { runeTiers?: 6 };

export interface PortalRequest {
  playerId: EntityId;
  target: PortalTarget;
  portal: Portal;
}

/** Seconds after arriving before a portal can be used, so players do not bounce straight back. */
const PORTAL_COOLDOWN = 1.5;

/** Admin-tunable rates, so balance can change without a deploy. */
export interface SimRates {
  xp: number;
  loot: number;
  /** Force bar at level 1 before gear. */
  forceMax: number;
  /** Multiplier on every skill's Force cost. */
  forceCost: number;
  /** Multiplier on Force cooling. */
  forceCool: number;
  /** Cap on the cooling speed-up after a pause in casting. */
  forceRampMax: number;
  /** Every boss's life, on top of the rare multiplier; read when a boss spawns, so the living keep theirs. */
  bossLife: number;
  /** Every boss's damage, all of it; read when a boss spawns, like `bossLife`. */
  bossDamage: number;
  /** Seconds between any two sigil casts, before the cast delay affix and cast speed. */
  castCooldown: number;
  /** World units within which a new drop joins an item pile; 0 keeps every drop apart. */
  lootMerge: number;
  /** Seconds a pile may live from its first drop, however often drops join and restart its clock. */
  lootPileMax: number;
}

/**
 * Per-room switches the server sets when it opens a room, so rules follow the room's purpose rather
 * than its map. Arena runs are switched on separately with `startArena`.
 */
export interface RoomRules {
  /** Builders may inscribe for free here: the private sandbox. */
  bench: boolean;
  /** The map's own endless waves run. Off in the sandbox, where builders spawn what they test. */
  waves: boolean;
}

export const DEFAULT_RATES: SimRates = {
  xp: 1,
  loot: 1,
  forceMax: HEAT.max,
  forceCost: 1,
  forceCool: 1,
  forceRampMax: HEAT.coolRampMax,
  bossLife: ENEMY_LEVEL.bossLifeMultiplier,
  bossDamage: ENEMY_LEVEL.bossDamageMultiplier,
  castCooldown: HEAT.castCooldownSeconds,
  lootMerge: LOOT.mergeRadius,
  lootPileMax: LOOT.pileMaxSeconds,
};

export class Simulation {
  readonly world = new World();
  readonly rng: Rng;
  /** Per-system random streams; see `Rng.stream`. */
  readonly rand: { loot: Rng; combat: Rng; world: Rng };
  readonly seed: number;
  readonly map: GameMap;
  readonly mapDef: WorldMap;
  /** A generated zone's chunks; its packs spawn chunk by chunk as players come near (`streaming.ts`). */
  readonly zone: ZoneWorld | null;
  readonly mapDesc: MapDescriptor;
  readonly nav: FlowField;
  tick = 0;
  wave = 0;
  waveTimer: number = WAVES.firstWaveDelaySeconds;
  /** Server-wide rates from the admin settings; the room manager keeps them current through setRates. */
  rates: SimRates = { ...DEFAULT_RATES };
  /** Monster and minion definitions with the admin's overrides; spawns read it, the living keep theirs. */
  tuning: MonsterTuning;

  setTuning(tuning: MonsterTuning): void {
    this.tuning = tuning;
  }

  /** Applies new admin rates. The Force bar is part of every player's stats, so those are rebuilt. */
  setRates(rates: SimRates): void {
    const maxChanged = rates.forceMax !== this.rates.forceMax;
    this.rates = { ...rates };
    if (!maxChanged) return;
    for (const p of this.world.player.values()) {
      p.stats = computeStats(p, this.rates.forceMax);
      p.heat = Math.min(p.heat, p.stats.heatMax);
    }
  }
  readonly rules: RoomRules;
  /** Set by `startArena`: this room is a scored Arena run (one life, no loot, reduced XP). */
  arena: ArenaState | null = null;
  /** A dungeon's boss has died. Set once; the server announces it. */
  cleared = false;
  /** Filled by the portal system; the server drains it and moves players between rooms. */
  portalRequests: PortalRequest[] = [];
  private events: PositionedEvent[] = [];
  private nextItemUid = 1;

  /** Without explicit rules the flat test map keeps the bench, so tests and the spell studio can inscribe freely. */
  /** `tuning` and `rates` come in here rather than later because a built map's packs (a dungeon's boss) spawn in the constructor. */
  constructor(seed: number, mapDesc: MapDescriptor = { kind: 'flat' }, rules: Partial<RoomRules> = {}, tuning: MonsterTuning = BASE_TUNING, rates: SimRates = DEFAULT_RATES) {
    this.seed = seed;
    this.tuning = tuning;
    this.rates = { ...rates };
    this.rules = { bench: mapDesc.kind === 'flat', waves: true, ...rules };
    this.rng = new Rng(seed);
    this.rand = { loot: Rng.stream(seed, 'loot'), combat: Rng.stream(seed, 'combat'), world: Rng.stream(seed, 'world') };
    this.mapDesc = mapDesc;
    const loaded = loadMap(mapDesc);
    this.map = loaded.game;
    this.mapDef = loaded.def;
    this.zone = loaded.zone;
    this.nav = new FlowField(this.map);
    if (!this.zone) spawnPacks(this);
  }

  /**
   * Starts this room's item ids at `base`. The server gives every room its own range, so an item id
   * a client still holds from the room it just left can never name a different item here.
   */
  startItemUidsAt(base: number): void {
    this.nextItemUid = Math.max(this.nextItemUid, base);
  }

  newItemUid(): ItemUid {
    return this.nextItemUid++;
  }

  emit(ev: GameEvent, x: number, y: number): void {
    this.events.push({ ev, x, y });
  }

  /** Events since the last call. The server sends them with the snapshot for the same tick. */
  takeEvents(): PositionedEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** `at` places the player at a zone transition or waypoint instead of the map's spawn. */
  addPlayer(clientId: string, classId: ClassId, name = 'Player', save?: PlayerSave, at?: Vec2): EntityId {
    const def = CLASSES[classId];
    const w = this.world;
    const id = w.create('player');
    w.position.set(id, at ? this.map.findOpen(at.x, at.y, SIM.playerRadius + 6) : this.playerSpawnPoint());
    w.radius.set(id, SIM.playerRadius);
    w.health.set(id, { life: def.life, maxLife: def.life });
    w.team.set(id, 'players');
    w.status.set(id, emptyStatus());
    w.buffs.set(id, emptyBuffs());
    w.player.set(id, {
      clientId,
      name,
      party: null,
      classId,
      aimAngle: 0,
      castCooldown: 0,
      respawnIn: null,
      lastProcessedInputSeq: -1,
      prevButtons: 0,
      heat: 0,
      heatPause: 0,
      heatIdle: 0,
      dash: null,
      dashSpell: null,
      items: new Map(),
      inventory: emptyGrid(BAG),
      stash: emptyStash(),
      sigils: [null, null, null, null],
      warband: new Array<ItemUid | null>(MINIONS.warbandSlots).fill(null),
      gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
      stats: baseStats({ classId, level: 1 }),
      minions: new Array<EntityId | null>(MINIONS.warbandSlots).fill(null),
      minionRespawn: new Array<number>(MINIONS.warbandSlots).fill(0),
      packs: Array.from({ length: MINIONS.warbandSlots }, () => ({ mates: [], down: [] })),
      stance: 'aggressive',
      links: [null, null, null, null],
      inventoryVersion: 0,
      portalCooldown: PORTAL_COOLDOWN,
      trail: [],
      heading: 0,
      focusTarget: null,
      focusTick: 0,
      god: false,
      // The town's waypoint is everyone's without being listed, like D2's.
      waypoints: [],
      gates: [],
      level: 1,
      xp: 0,
      gold: 0,
    });
    if (save) inv.restoreSave(this, id, save);
    else inv.giveStarterKit(this, id);
    const p = w.player.get(id);
    const h = w.health.get(id);
    if (p && h) {
      p.stats = computeStats(p, this.rates.forceMax);
      h.maxLife = p.stats.maxLife;
      h.life = p.stats.maxLife;
    }
    return id;
  }

  /** Snapshot of a character's items and equipment, for moving them to another room. */
  exportPlayer(id: EntityId): PlayerSave | null {
    const p = this.world.player.get(id);
    if (!p) return null;
    return {
      classId: p.classId,
      name: p.name,
      items: [...p.items.values()],
      inventory: [...p.inventory],
      stash: cloneLayout(p.stash),
      sigils: p.sigils.map((s) => s?.uid ?? null),
      warband: [...p.warband],
      gear: { ...p.gear },
      stance: p.stance,
      waypoints: [...p.waypoints],
      level: p.level,
      xp: p.xp,
      gold: p.gold,
      runeFormat: 2,
      runeTiers: 6,
      worldFormat: 1,
      gates: [...p.gates],
    };
  }

  removePlayer(id: EntityId): void {
    const p = this.world.player.get(id);
    if (p) for (let slot = 0; slot < p.minions.length; slot++) despawnMinion(this, id, slot);
    this.world.destroy(id);
    this.world.flushDestroyed();
  }

  get playerCount(): number {
    return this.world.player.size;
  }

  /**
   * Applies one tick's worth of input. The caller is responsible for rate limiting how many inputs
   * a player may apply per tick; this validates the content.
   */
  applyInput(id: EntityId, input: InputFrame): void {
    const w = this.world;
    const p = w.player.get(id);
    const pos = w.position.get(id);
    if (!p || !pos) return;
    if (input.seq <= p.lastProcessedInputSeq) return;
    p.lastProcessedInputSeq = input.seq;
    if (p.respawnIn !== null) {
      p.prevButtons = input.buttons;
      return;
    }

    const def = CLASSES[p.classId];
    const wasDashing = p.dash !== null;
    const next = stepPlayer(this.map, { x: pos.x, y: pos.y, dash: p.dash }, input.moveDir, p.stats.moveSpeed, SIM.dt, SIM.playerRadius, gateSeal(this, p.gates));
    const moved = Math.hypot(next.x - pos.x, next.y - pos.y);
    if (moved > 0.5) p.heading = Math.atan2(next.y - pos.y, next.x - pos.x);
    pos.x = next.x;
    pos.y = next.y;
    p.dash = next.dash;
    const last = p.trail[p.trail.length - 1];
    if (!last || Math.hypot(last.x - pos.x, last.y - pos.y) > MINIONS.trailSpacing) {
      p.trail.push({ x: pos.x, y: pos.y });
      if (p.trail.length > MINIONS.trailLength) p.trail.shift();
    }
    if (p.dashSpell) updateDashSpell(this, id, SIM.dt, wasDashing && p.dash === null);
    p.aimAngle = input.aimAngle;

    // There is no basic attack: every hit comes from a sigil, so the primary button bit is ignored.
    const pressed = input.buttons & ~p.prevButtons;
    SKILL_BUTTONS.forEach((bit, slot) => {
      if ((input.buttons & bit) !== 0) castSkill(this, id, slot, (pressed & bit) !== 0);
    });
    p.prevButtons = input.buttons;
  }

  step(): void {
    for (const system of SYSTEMS) system.run(this, SIM.dt);
    this.world.flushDestroyed();
    this.tick++;
  }

  spawnEnemy(typeId: EnemyTypeId, x: number, y: number, rare = false): EntityId {
    return spawnEnemy(this, typeId, x, y, { rare, level: 1, aggro: true });
  }

  /** Rooms where builders may inscribe freely (the test bench); everyone else uses the forge. */
  get editorAllowed(): boolean {
    return this.rules.bench && this.arena === null;
  }

  // Commands from the inventory and editor UI. Each returns an error message, or null on success.

  /**
   * `devTools`: the caller may use the free test bench, which only works on editorAllowed maps.
   * `base`: the slot uids the client drafted from (see the inscribe message); the server always passes it.
   */
  inscribe(id: EntityId, uid: ItemUid, slots: readonly RuneRef[], devTools = false, base?: readonly ItemUid[]): string | null {
    return inv.inscribe(this, id, uid, slots, devTools && this.editorAllowed, base);
  }

  equipSigil(id: EntityId, uid: ItemUid, slot: number): string | null {
    return inv.equipSigil(this, id, uid, slot);
  }

  unequipSigil(id: EntityId, slot: number): string | null {
    return inv.unequipSigil(this, id, slot);
  }

  swapSigils(id: EntityId, a: number, b: number): string | null {
    return inv.swapSigils(this, id, a, b);
  }

  equipVessel(id: EntityId, uid: ItemUid, slot: number): string | null {
    return inv.equipVessel(this, id, uid, slot);
  }

  unequipVessel(id: EntityId, slot: number): string | null {
    return inv.unequipVessel(this, id, slot);
  }

  equipGear(id: EntityId, uid: ItemUid, slot: GearSlot | null = null): string | null {
    return inv.equipGear(this, id, uid, slot);
  }

  unequipGear(id: EntityId, slot: GearSlot): string | null {
    return inv.unequipGear(this, id, slot);
  }

  sortInventory(id: EntityId): string | null {
    return inv.sortInventory(this, id);
  }

  discard(id: EntityId, uid: ItemUid): string | null {
    return inv.discard(this, id, uid);
  }

  /** Takes item `uid` from a ground pile, or everything that fits when `uid` is null. */
  pickup(id: EntityId, lootId: EntityId, uid: ItemUid | null = null): string | null {
    return inv.takeLoot(this, id, lootId, uid);
  }

  lootView(id: EntityId, lootId: EntityId): ReturnType<typeof inv.lootView> {
    return inv.lootView(this, id, lootId);
  }

  moveItem(id: EntityId, uid: ItemUid, to: ItemDest): string | null {
    return stash.moveItem(this, id, uid, to);
  }

  quickMove(id: EntityId, uid: ItemUid, openTab: number | null): string | null {
    return stash.quickMove(this, id, uid, openTab);
  }

  takeRunes(id: EntityId, uid: ItemUid, count: number, to: GridDest | null): string | null {
    return stash.takeRunes(this, id, uid, count, to);
  }

  sortStash(id: EntityId, tab: StashTabRef, key: StashSortKey | null, affix: AffixId | null): string | null {
    return stash.sortStash(this, id, tab, key, affix);
  }

  buyStashTab(id: EntityId): string | null {
    return stash.buyStashTab(this, id);
  }

  editStashTab(id: EntityId, tab: number, name: string, color: StashColorId): string | null {
    return stash.editStashTab(this, id, tab, name, color);
  }

  cycleStance(id: EntityId): void {
    const p = this.world.player.get(id);
    if (!p) return;
    const i = STANCES.indexOf(p.stance);
    p.stance = STANCES[(i + 1) % STANCES.length] ?? 'aggressive';
  }

  /**
   * Waves maps pick the open point farthest from enemies, so a camped corpse is not a death loop.
   * Everywhere else players arrive at the map's spawn.
   */
  playerSpawnPoint(): Vec2 {
    const w = this.world;
    const spawn = this.map.findOpen(this.mapDef.spawn.x, this.mapDef.spawn.y, SIM.playerRadius + 6);
    if (!this.mapDef.waves || w.enemy.size === 0) return spawn;
    const margin = SIM.playerSpawnMargin;
    let best = spawn;
    let bestD = -1;
    for (let i = 0; i < SIM.playerSpawnCandidates; i++) {
      const c = { x: this.rand.world.range(margin, this.map.width - margin), y: this.rand.world.range(margin, this.map.height - margin) };
      if (this.map.pointBlocked(c.x, c.y, SIM.playerRadius + 10, 'move')) continue;
      let nearest = Infinity;
      for (const [eid] of w.enemy) {
        const p = w.position.get(eid);
        if (p) nearest = Math.min(nearest, distSq(c.x, c.y, p.x, p.y));
      }
      if (nearest > bestD) {
        bestD = nearest;
        best = c;
      }
    }
    return best;
  }
}
