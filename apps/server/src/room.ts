import {
  applyDev,
  buyItem,
  pendingItems,
  sellItem,
  type Item,
  restoreStash,
  type StashSave,
  can,
  inventoryMessage,
  mapKey,
  NET,
  serializeEntities,
  SIM,
  Simulation,
  snapshotFor,
  type ClassId,
  type ClientMessage,
  type EntityId,
  type MapDescriptor,
  type MonsterTuning,
  type PlayerSave,
  type PortalRequest,
  type RoomRules,
  type Vec2,
} from '@rune/shared';
import type { Client } from './client.js';
import { InputBuffer } from './inputBuffer.js';

/** The commit this server was built from, baked into the image; 'dev' locally. */
const SERVER_BUILD = process.env.BUILD_ID ?? 'dev';

interface Member {
  client: Client;
  playerId: EntityId;
  inputs: InputBuffer;
  sentInventoryVersion: number;
  /** Spell entities this member's client already has a record of, with the motion it was sent. */
  knownSpells: Map<EntityId, string>;
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
  /** The home zone room, where builders get the town editor. */
  hostsTown = false;
  /** Encounter sandbox time scale: simulation steps per server tick, accumulated so fractions work. */
  timeScale = 1;
  private timeAccumulator = 0;
  private announcedClear = false;
  /** The world instance this room belongs to. */
  instanceId: string | null = null;
  /** Seconds with nobody inside, so the manager can close abandoned instances. */
  emptySeconds = 0;

  constructor(
    readonly id: string,
    readonly desc: MapDescriptor,
    seed: number,
    rules: Partial<RoomRules> = {},
    tuning?: MonsterTuning,
  ) {
    this.sim = new Simulation(seed, desc, rules, tuning);
    this.sim.startItemUidsAt(++roomSerial * ITEM_UIDS_PER_ROOM);
  }

  get name(): string {
    return this.sim.mapDef.name;
  }

  get shared(): boolean {
    return this.desc.kind === 'town';
  }

  /** Pausing a server-authoritative world is only fair when nobody else is in it. Arena runs are timed and scored, so they never pause. */
  get canPause(): boolean {
    return !this.shared && this.members.size === 1 && this.sim.arena === null;
  }

  add(client: Client, classId: ClassId, name: string, save?: PlayerSave, at?: Vec2): void {
    const playerId = this.sim.addPlayer(client.id, classId, name, save, at);
    this.members.set(client.id, { client, playerId, inputs: new InputBuffer(), sentInventoryVersion: -1, knownSpells: new Map() });
    client.room = this;
    // Someone joining ends a solo pause.
    this.paused = false;
    for (const m of this.members.values()) this.welcome(m);
  }

  exportMember(client: Client): PlayerSave | null {
    const m = this.members.get(client.id);
    return m ? this.sim.exportPlayer(m.playerId) : null;
  }

  /** The player's position and unlocked waypoints, for travel decisions made by the manager. */
  playerState(client: Client): { x: number; y: number; waypoints: readonly string[] } | null {
    const m = this.members.get(client.id);
    const p = m ? this.sim.world.player.get(m.playerId) : undefined;
    const pos = m ? this.sim.world.position.get(m.playerId) : undefined;
    return p && pos ? { x: pos.x, y: pos.y, waypoints: p.waypoints } : null;
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
        if (msg.paused && !this.canPause) client.send({ t: 'notice', text: 'Others are here, so the world keeps running' });
        return;
      case 'inscribe': {
        // Answered on its own rather than as a notice, so the forge never mistakes another notice
        // for its refusal.
        const refused = this.sim.inscribe(pid, msg.uid, msg.slots, can(client.role, 'devTools'));
        client.send(refused === null ? { t: 'inscribed', uid: msg.uid, ok: true } : { t: 'inscribed', uid: msg.uid, ok: false, error: refused });
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
        error = this.sim.pickup(pid, msg.id);
        break;
      case 'moveItem':
        error = this.sim.moveItem(pid, msg.uid, msg.to, msg.x, msg.y);
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
      for (const m of this.members.values()) m.client.send({ t: 'banner', title: `${this.name} cleared`, text: 'The boss has fallen. A cache has opened where it died.' });
    }
    const out: { client: Client; request: PortalRequest }[] = [];
    for (const request of this.sim.portalRequests) {
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
    });
    m.sentInventoryVersion = -1;
  }

  private broadcast(): void {
    const entities = serializeEntities(this.sim);
    const events = this.sim.takeEvents();
    for (const m of this.members.values()) {
      const p = this.sim.world.player.get(m.playerId);
      if (p && p.inventoryVersion !== m.sentInventoryVersion) {
        const inv = inventoryMessage(this.sim, m.playerId);
        if (inv) m.client.send(inv);
        m.sentInventoryVersion = p.inventoryVersion;
      }
      if (m.client.congested) continue;
      const snap = snapshotFor(this.sim, m.playerId, entities, events, NET.interestRadius, m.knownSpells);
      snap.paused = this.paused;
      m.client.send(snap);
    }
  }
}

export function roomIdFor(desc: MapDescriptor): string {
  return mapKey(desc).replaceAll(':', '-');
}
