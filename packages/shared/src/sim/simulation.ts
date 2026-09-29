import { MINIONS, SIM, WAVES } from '../config/sim.js';
import { CLASSES, type ClassId } from '../data/classes.js';
import type { EnemyTypeId } from '../data/enemies.js';
import { STANCES, type Stance } from '../data/minions.js';
import type { GearSlot } from '../data/gear.js';
import type { RuneId } from '../data/runes.js';
import type { Item, ItemUid } from '../items/items.js';
import { BAG, emptyGrid, STASH } from '../items/grid.js';
import { BUTTON, SKILL_BUTTONS, type GameEvent, type InputFrame } from '../protocol/messages.js';
import type { GameMap } from '../world/gamemap.js';
import { loadMap } from '../world/maps.js';
import { FlowField } from '../world/nav.js';
import type { MapDescriptor, Portal, PortalTarget, WorldMap } from '../world/types.js';
import { HOME_ZONE, type ZoneId } from '../data/zones.js';
import { emptyBuffs, emptyStatus, World, type EntityId } from './ecs.js';
import { spawnEnemy, spawnPacks } from './enemies.js';
import * as inv from './inventory.js';
import { distSq, type Vec2 } from './math.js';
import { despawnMinion } from './minions.js';
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
  stash: (ItemUid | null)[];
  sigils: (ItemUid | null)[];
  warband: (ItemUid | null)[];
  gear: Record<GearSlot, ItemUid | null>;
  stance: Stance;
  waypoints: ZoneId[];
  level: number;
  xp: number;
  gold: number;
}

export interface PortalRequest {
  playerId: EntityId;
  target: PortalTarget;
  portal: Portal;
}

/** Seconds after arriving before a portal can be used, so players do not bounce straight back. */
const PORTAL_COOLDOWN = 1.5;

export class Simulation {
  readonly world = new World();
  readonly rng: Rng;
  /** Per-system random streams; see `Rng.stream`. */
  readonly rand: { loot: Rng; combat: Rng; world: Rng };
  readonly seed: number;
  readonly map: GameMap;
  readonly mapDef: WorldMap;
  readonly mapDesc: MapDescriptor;
  readonly nav: FlowField;
  tick = 0;
  wave = 0;
  waveTimer: number = WAVES.firstWaveDelaySeconds;
  /** Server-wide rates from the admin settings; the room manager keeps them current. */
  rates = { xp: 1, loot: 1 };
  /** A dungeon's boss has died. Set once; the server announces it. */
  cleared = false;
  /** Filled by the portal system; the server drains it and moves players between rooms. */
  portalRequests: PortalRequest[] = [];
  private events: PositionedEvent[] = [];
  private nextItemUid = 1;

  constructor(seed: number, mapDesc: MapDescriptor = { kind: 'flat' }) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.rand = { loot: Rng.stream(seed, 'loot'), combat: Rng.stream(seed, 'combat'), world: Rng.stream(seed, 'world') };
    this.mapDesc = mapDesc;
    const loaded = loadMap(mapDesc);
    this.map = loaded.game;
    this.mapDef = loaded.def;
    this.nav = new FlowField(this.map);
    spawnPacks(this);
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
      classId,
      aimAngle: 0,
      primaryCooldown: 0,
      castCooldown: 0,
      respawnIn: null,
      lastProcessedInputSeq: -1,
      prevButtons: 0,
      heat: 0,
      heatPause: 0,
      dash: null,
      dashSpell: null,
      items: new Map(),
      inventory: emptyGrid(BAG),
      stash: emptyGrid(STASH),
      sigils: [null, null, null, null],
      warband: [null, null, null, null],
      gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null },
      stats: baseStats({ classId, level: 1 }),
      minions: [null, null, null, null],
      minionRespawn: [0, 0, 0, 0],
      stance: 'aggressive',
      links: [null, null, null, null],
      inventoryVersion: 0,
      portalCooldown: PORTAL_COOLDOWN,
      trail: [],
      heading: 0,
      focusTarget: null,
      focusTick: 0,
      god: false,
      // Everyone starts with the town's waypoint, like D2's.
      waypoints: [HOME_ZONE],
      level: 1,
      xp: 0,
      gold: 0,
    });
    if (save) inv.restoreSave(this, id, save);
    else inv.giveStarterKit(this, id);
    const p = w.player.get(id);
    const h = w.health.get(id);
    if (p && h) {
      p.stats = computeStats(p);
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
      stash: [...p.stash],
      sigils: p.sigils.map((s) => s?.uid ?? null),
      warband: [...p.warband],
      gear: { ...p.gear },
      stance: p.stance,
      waypoints: [...p.waypoints],
      level: p.level,
      xp: p.xp,
      gold: p.gold,
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
    const next = stepPlayer(this.map, { x: pos.x, y: pos.y, dash: p.dash }, input.moveDir, p.stats.moveSpeed, SIM.dt, SIM.playerRadius);
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

  /** The sigil editor is a testing tool for now, allowed only on some maps. */
  get editorAllowed(): boolean {
    return this.mapDef.theme === 'arena' || this.mapDef.theme === 'flat';
  }

  // Commands from the inventory and editor UI. Each returns an error message, or null on success.

  inscribe(id: EntityId, uid: ItemUid, runes: RuneId[]): string | null {
    if (!this.editorAllowed) return 'Sigils can only be reinscribed in the test arena for now';
    return inv.inscribe(this, id, uid, runes);
  }

  equipSigil(id: EntityId, uid: ItemUid, slot: number): string | null {
    return inv.equipSigil(this, id, uid, slot);
  }

  unequipSigil(id: EntityId, slot: number): string | null {
    return inv.unequipSigil(this, id, slot);
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

  moveItem(id: EntityId, uid: ItemUid, to: 'bag' | 'stash', x: number, y: number): string | null {
    return inv.moveItem(this, id, uid, to, x, y);
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
