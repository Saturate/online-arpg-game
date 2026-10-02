import {
  activeTunables,
  fitSpirit,
  applyDev,
  buyItem,
  pendingItems,
  portalOpen,
  sellItem,
  type Item,
  restoreStash,
  type StashSave,
  can,
  inventoryMessage,
  mapKey,
  placeName,
  planChecksum,
  NET,
  serializeEntities,
  SIM,
  Simulation,
  snapshotFor,
  type ClassId,
  type ClientMessage,
  type EntityId,
  type GateInfo,
  type MapDescriptor,
  type MonsterTuning,
  type SimRates,
  type PlayerSave,
  type PortalRequest,
  type RoomRules,
  type Vec2,
} from '@rune/shared';
import type { Client } from './client.js';
import { InputBuffer } from './inputBuffer.js';
import { Ring, ROOM_TICK_SAMPLES } from './tickStats.js';

/** The commit this server was built from, baked into the image; 'dev' locally. */
const SERVER_BUILD = process.env.BUILD_ID ?? 'dev';

interface Member {
  client: Client;
  playerId: EntityId;
  inputs: InputBuffer;
  sentInventoryVersion: number;
  /** Spell entities this member's client already has a record of, with the motion it was sent. */
  knownSpells: Map<EntityId, string>;
  /** The pile whose loot window is open, and the version of it last sent. Only its viewer gets its full items. */
  openLoot: { id: EntityId; rev: number } | null;
}

/** Rooms opened since start; each takes its own block of item ids (see Simulation.startItemUidsAt). */
let roomSerial = 0;
/** Far more items than one room ever makes, and 2^21 rooms before ids pass the safe integer range. */
const ITEM_UIDS_PER_ROOM = 2 ** 32;

/** One simulation plus the clients in it. The room manager moves clients between rooms. */
export class Room {
  readonly sim: Simulation;
  readonly members = new Map<string, Member>();
  paused = false;
  /** The world room, which holds the town: builders get the town editor there. */
  hostsTown = false;
  /** Encounter sandbox time scale: simulation steps per server tick, accumulated so fractions work. */
  timeScale = 1;
  private timeAccumulator = 0;
  private announcedClear = false;
  /** The world instance this room belongs to. */
  instanceId: string | null = null;
  /** Seconds with nobody inside, so the manager can close abandoned instances. */
  emptySeconds = 0;
  /** How long this room's recent ticks took, in ms, for the admin Live view. */
  readonly tickTimes = new Ring(ROOM_TICK_SAMPLES);
  /**
   * For a dungeon's antechamber and its runs: the gate the dungeon's entrance lies behind, taken from
   * the world when the antechamber opened, so the manager's gate checks never need the world room
   * open (it closes after standing empty while people are still inside the dungeon).
   */
  entranceGate: GateInfo | null = null;
  /** The world plan's checksum, for rooms built from one. */
  planHash: string | undefined;

  constructor(
    readonly id: string,
    readonly desc: MapDescriptor,
    seed: number,
    rules: Partial<RoomRules> = {},
    tuning?: MonsterTuning,
    rates?: SimRates,
  ) {
    this.sim = new Simulation(seed, desc, rules, tuning, rates);
    this.sim.startItemUidsAt(++roomSerial * ITEM_UIDS_PER_ROOM);
    const plan = this.sim.zone?.plan;
    if (plan) this.planHash = planChecksum(plan);
  }

  get name(): string {
    return this.sim.mapDef.name;
  }

  /** The town is where everyone meets, so it never pauses; it lives inside the world room. */
  get shared(): boolean {
    return this.desc.kind === 'town' || this.desc.kind === 'world';
  }

  /** Where a member is, for the party frames: the world's region (or the town), otherwise the room's name. */
  placeName(x: number, y: number): string {
    return placeName(this.sim.mapDef, this.sim.zone, x, y) ?? this.name;
  }

  /** Whether a spot is inside a safe area of the map: the town in the world. */
  inSafeZone(x: number, y: number): boolean {
    return (this.sim.mapDef.safeZones ?? []).some((z) => x >= z.x && y >= z.y && x <= z.x + z.w && y <= z.y + z.h);
  }

  /** Pausing a server-authoritative world is only fair when nobody else is in it. Arena runs are timed and scored, so they never pause. */
  get canPause(): boolean {
    return !this.shared && this.members.size === 1 && this.sim.arena === null;
  }

  add(client: Client, classId: ClassId, name: string, save?: PlayerSave, at?: Vec2): void {
    const playerId = this.sim.addPlayer(client.id, classId, name, save, at);
    this.members.set(client.id, { client, playerId, inputs: new InputBuffer(), sentInventoryVersion: -1, knownSpells: new Map(), openLoot: null });
    // A save from before a live tuning change can hold more auras than the pool now pays for.
    for (const skill of fitSpirit(this.sim, playerId)) client.send({ t: 'notice', text: `${skill} was unequipped: its spirit now passes your pool` });
    client.room = this;
    // Someone joining ends a solo pause.
    this.paused = false;
    for (const m of this.members.values()) this.welcome(m);
  }

  exportMember(client: Client): PlayerSave | null {
    const m = this.members.get(client.id);
    return m ? this.sim.exportPlayer(m.playerId) : null;
  }

  /** The player's position, unlocked waypoints and opened gates, for travel decisions made by the manager. */
  playerState(client: Client): { x: number; y: number; waypoints: readonly string[]; gates: readonly string[] } | null {
    const m = this.members.get(client.id);
    const p = m ? this.sim.world.player.get(m.playerId) : undefined;
    const pos = m ? this.sim.world.position.get(m.playerId) : undefined;
    return p && pos ? { x: pos.x, y: pos.y, waypoints: p.waypoints, gates: p.gates } : null;
  }

  /** What the party frames and the teleport channel read about a member, once a tick at most. */
  memberView(client: Client): { cls: ClassId; level: number; x: number; y: number; life: number; maxLife: number; dead: boolean; castCooldown: number; dashing: boolean } | null {
    const m = this.members.get(client.id);
    if (!m) return null;
    const w = this.sim.world;
    const p = w.player.get(m.playerId);
    const pos = w.position.get(m.playerId);
    const h = w.health.get(m.playerId);
    if (!p || !pos || !h) return null;
    return { cls: p.classId, level: p.level, x: pos.x, y: pos.y, life: h.life, maxLife: h.maxLife, dead: p.respawnIn !== null, castCooldown: p.castCooldown, dashing: p.dash !== null };
  }

  /** The member's party, for sharing kill XP; see RoomManager.syncParties. */
  setParty(client: Client, party: string | null): void {
    const m = this.members.get(client.id);
    const p = m ? this.sim.world.player.get(m.playerId) : undefined;
    if (p) p.party = party;
  }

  /** Moves a member within this room, onto open ground near the spot. */
  placeMember(client: Client, x: number, y: number): void {
    const m = this.members.get(client.id);
    if (m) applyDev(this.sim, m.playerId, { c: 'teleport', x, y });
  }

  sell(client: Client, uid: number): Item | string {
    const m = this.members.get(client.id);
    return m ? sellItem(this.sim, m.playerId, uid) : 'Not in this room';
  }

  buy(client: Client, item: Item, price: number): string | null {
    const m = this.members.get(client.id);
    return m ? buyItem(this.sim, m.playerId, item, price) : 'Not in this room';
  }

  /** Items waiting for room in the bag or stash; see pendingItems. */
  pendingCount(client: Client): number {
    const m = this.members.get(client.id);
    const p = m ? this.sim.world.player.get(m.playerId) : undefined;
    return p ? pendingItems(p).length : 0;
  }

  loadStash(client: Client, stash: StashSave): void {
    const m = this.members.get(client.id);
    if (m) restoreStash(this.sim, m.playerId, stash);
  }

  /** After a role change: the welcome carries the dev and editor flags, so it is resent. */
  refreshMember(client: Client): void {
    const m = this.members.get(client.id);
    if (m) this.welcome(m);
    this.resetTimeUnlessStaff();
  }

  /** Time scale is room-wide, so it must not outlast the last member who could set it back. */
  private resetTimeUnlessStaff(): void {
    if (![...this.members.values()].some((o) => can(o.client.role, 'devTools'))) this.timeScale = 1;
  }

  /** Removes the client's player and returns their character for the next room. */
  remove(client: Client): PlayerSave | null {
    const m = this.members.get(client.id);
    if (!m) return null;
    const save = this.sim.exportPlayer(m.playerId);
    this.sim.removePlayer(m.playerId);
    this.members.delete(client.id);
    if (client.room === this) client.room = null;
    this.resetTimeUnlessStaff();
    for (const other of this.members.values()) this.welcome(other);
    return save;
  }

  /** Commands that stay inside the room. Room changes are handled by the manager. */
  handle(client: Client, msg: ClientMessage): void {
    const m = this.members.get(client.id);
    if (!m) return;
    const pid = m.playerId;
    let error: string | null = null;
    switch (msg.t) {
      case 'input':
        if (!this.paused) m.inputs.push(msg);
        return;
      case 'pause':
        this.paused = msg.paused && this.canPause;
        if (msg.paused && !this.canPause) client.send({ t: 'notice', text: this.shared ? 'The town never pauses' : 'Others are here, so the world keeps running' });
        return;
      case 'inscribe': {
        // Answered on its own rather than as a notice, so the forge never mistakes another notice
        // for its refusal.
        const refused = this.sim.inscribe(pid, msg.uid, msg.slots, can(client.role, 'devTools'), msg.base);
        // The new inventory goes first: the forge frees its button on the reply, and until the new
        // slots are on screen a second click would resend a draft made against the old ones.
        if (refused === null) this.sendInventory(m);
        client.send(refused === null ? { t: 'inscribed', uid: msg.uid, attempt: msg.attempt, ok: true } : { t: 'inscribed', uid: msg.uid, attempt: msg.attempt, ok: false, error: refused });
        break;
      }
      case 'equipSigil':
        error = this.sim.equipSigil(pid, msg.uid, msg.slot);
        break;
      case 'unequipSigil':
        error = this.sim.unequipSigil(pid, msg.slot);
        break;
      case 'swapSigils':
        error = this.sim.swapSigils(pid, msg.a, msg.b);
        break;
      case 'equipVessel':
        error = this.sim.equipVessel(pid, msg.uid, msg.slot);
        break;
      case 'unequipVessel':
        error = this.sim.unequipVessel(pid, msg.slot);
        break;
      case 'sortInventory':
        error = this.sim.sortInventory(pid);
        break;
      case 'discard':
        error = this.sim.discard(pid, msg.uid);
        break;
      case 'pickup':
        error = this.sim.pickup(pid, msg.id, msg.uid ?? null);
        break;
      case 'lootOpen': {
        // Answered at once, so the window fills on the click; broadcast keeps it current after that.
        const view = this.sim.lootView(pid, msg.id);
        m.openLoot = view ? { id: msg.id, rev: view.rev } : null;
        client.send(view ? { t: 'lootPile', id: msg.id, items: view.items, own: view.own } : { t: 'lootPile', id: msg.id, items: null });
        return;
      }
      case 'lootClose':
        m.openLoot = null;
        return;
      case 'moveItem':
        error = this.sim.moveItem(pid, msg.uid, msg.to);
        break;
      case 'quickMove':
        error = this.sim.quickMove(pid, msg.uid, msg.tab);
        break;
      case 'takeRunes':
        error = this.sim.takeRunes(pid, msg.uid, msg.count, msg.to);
        break;
      case 'sortStash':
        error = this.sim.sortStash(pid, msg.tab, msg.key, msg.affix);
        break;
      case 'buyStashTab':
        error = this.sim.buyStashTab(pid);
        break;
      case 'editStashTab':
        error = this.sim.editStashTab(pid, msg.tab, msg.name, msg.color);
        break;
      case 'cycleStance':
        this.sim.cycleStance(pid);
        break;
      case 'equipGear':
        error = this.sim.equipGear(pid, msg.uid, msg.slot);
        break;
      case 'unequipGear':
        error = this.sim.unequipGear(pid, msg.slot);
        break;
      case 'dev': {
        if (!can(client.role, 'devTools')) {
          client.send({ t: 'notice', text: 'Dev tools need the builder role' });
          return;
        }
        // Spawning, healing, god mode and free items would all make a score meaningless.
        if (this.sim.arena) {
          client.send({ t: 'notice', text: 'Dev tools are off in Arena runs' });
          return;
        }
        if (msg.cmd.c === 'timeScale') {
          this.timeScale = msg.cmd.scale;
          client.send({ t: 'notice', text: `Time x${msg.cmd.scale}` });
          return;
        }
        const note = applyDev(this.sim, pid, msg.cmd);
        if (note) client.send({ t: 'notice', text: note });
        break;
      }
      default:
        return;
    }
    if (error) client.send({ t: 'notice', text: error });
    // Always resend after an edit so a rejected change snaps the client's optimistic UI back.
    m.sentInventoryVersion = -1;
  }

  /** Advances one tick and returns portal requests for the manager to act on. */
  tick(): { client: Client; request: PortalRequest }[] {
    if (this.members.size === 0) {
      this.emptySeconds += SIM.dt;
      return [];
    }
    this.emptySeconds = 0;
    if (!this.paused) {
      this.timeAccumulator += this.timeScale;
      while (this.timeAccumulator >= 1) {
        this.timeAccumulator -= 1;
        for (const m of this.members.values()) for (const input of m.inputs.drain()) this.sim.applyInput(m.playerId, input);
        this.sim.step();
      }
    }
    this.broadcast();
    if (this.sim.cleared && !this.announcedClear) {
      this.announcedClear = true;
      const exit = this.sim.mapDef.portals.some((p) => p.sealed === 'boss');
      for (const m of this.members.values()) {
        m.client.send({ t: 'banner', title: `${this.name} cleared`, text: 'The boss has fallen. A cache has opened where it died.' });
        if (exit) m.client.send({ t: 'chat', kind: 'system', from: '', to: null, text: 'The way out opens in the boss chamber' });
      }
    }
    const out: { client: Client; request: PortalRequest }[] = [];
    for (const request of this.sim.portalRequests) {
      // The sim already skips a sealed exit; this keeps the rule even if a request gets through another way.
      if (!portalOpen(this.sim, request.portal)) continue;
      for (const m of this.members.values()) if (m.playerId === request.playerId) out.push({ client: m.client, request });
    }
    this.sim.portalRequests = [];
    return out;
  }

  private welcome(m: Member): void {
    m.client.send({
      t: 'welcome',
      playerId: m.playerId,
      tick: this.sim.tick,
      tickMs: SIM.tickMs,
      roomId: this.id,
      map: this.desc,
      canPause: this.canPause,
      editor: this.sim.editorAllowed,
      townEditor: this.hostsTown && can(m.client.role, 'townEdit'),
      devTools: can(m.client.role, 'devTools') && this.sim.arena === null,
      build: SERVER_BUILD,
      castCooldown: this.sim.rates.castCooldown,
      tunables: activeTunables(),
      ...(this.planHash === undefined ? {} : { planHash: this.planHash }),
    });
    m.sentInventoryVersion = -1;
    // Entity ids belong to the room's world, which a welcome may have replaced (a town rebuild).
    if (m.openLoot) {
      m.client.send({ t: 'lootPile', id: m.openLoot.id, items: null });
      m.openLoot = null;
    }
  }

  private broadcast(): void {
    const entities = serializeEntities(this.sim);
    const events = this.sim.takeEvents();
    for (const m of this.members.values()) {
      this.sendInventory(m);
      this.sendLoot(m);
      if (m.client.congested) continue;
      const snap = snapshotFor(this.sim, m.playerId, entities, events, NET.interestRadius, m.knownSpells);
      snap.paused = this.paused;
      m.client.send(snap);
    }
  }

  /** Keeps an open loot window current, and closes it once the pile is gone or out of reach. */
  private sendLoot(m: Member): void {
    const open = m.openLoot;
    if (!open) return;
    const view = this.sim.lootView(m.playerId, open.id);
    if (!view) {
      m.openLoot = null;
      m.client.send({ t: 'lootPile', id: open.id, items: null });
      return;
    }
    if (view.rev === open.rev) return;
    open.rev = view.rev;
    m.client.send({ t: 'lootPile', id: open.id, items: view.items, own: view.own });
  }

  private sendInventory(m: Member): void {
    const p = this.sim.world.player.get(m.playerId);
    if (!p || p.inventoryVersion === m.sentInventoryVersion) return;
    const inv = inventoryMessage(this.sim, m.playerId);
    if (inv) m.client.send(inv);
    m.sentInventoryVersion = p.inventoryVersion;
  }
}

export function roomIdFor(desc: MapDescriptor): string {
  return mapKey(desc).replaceAll(':', '-');
}
