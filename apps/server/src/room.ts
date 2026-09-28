import {
  applyDev,
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
  type PlayerSave,
  type PortalRequest,
  type Vec2,
} from '@rune/shared';
import type { Client } from './client.js';
import { InputBuffer } from './inputBuffer.js';

interface Member {
  client: Client;
  playerId: EntityId;
  inputs: InputBuffer;
  sentInventoryVersion: number;
}

/** One simulation plus the clients in it. The room manager moves clients between rooms. */
export class Room {
  readonly sim: Simulation;
  readonly members = new Map<string, Member>();
  paused = false;
  /** Set by the manager on the town room when the town editor is enabled on this server. */
  townEditor = false;
  /** Dev tools (encounter sandbox) are enabled on this server. */
  devTools = false;
  /** Encounter sandbox time scale: simulation steps per server tick, accumulated so fractions work. */
  timeScale = 1;
  private timeAccumulator = 0;
  private announcedClear = false;
  /** The party instance this room belongs to; null for the global Arena. */
  instanceId: string | null = null;
  /** Seconds with nobody inside, so the manager can close abandoned instances. */
  emptySeconds = 0;

  constructor(
    readonly id: string,
    readonly desc: MapDescriptor,
    seed: number,
  ) {
    this.sim = new Simulation(seed, desc);
  }

  get name(): string {
    return this.sim.mapDef.name;
  }

  get shared(): boolean {
    return this.desc.kind === 'town';
  }

  /** Pausing a server-authoritative world is only fair when nobody else is in it. */
  get canPause(): boolean {
    return !this.shared && this.members.size === 1;
  }

  add(client: Client, classId: ClassId, name: string, save?: PlayerSave, at?: Vec2): void {
    const playerId = this.sim.addPlayer(client.id, classId, name, save, at);
    this.members.set(client.id, { client, playerId, inputs: new InputBuffer(), sentInventoryVersion: -1 });
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

  /** Removes the client's player and returns their character for the next room. */
  remove(client: Client): PlayerSave | null {
    const m = this.members.get(client.id);
    if (!m) return null;
    const save = this.sim.exportPlayer(m.playerId);
    this.sim.removePlayer(m.playerId);
    this.members.delete(client.id);
    if (client.room === this) client.room = null;
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
      case 'inscribe':
        error = this.sim.inscribe(pid, msg.uid, msg.runes);
        break;
      case 'equipSigil':
        error = this.sim.equipSigil(pid, msg.uid, msg.slot);
        break;
      case 'unequipSigil':
        error = this.sim.unequipSigil(pid, msg.slot);
        break;
      case 'equipVessel':
        error = this.sim.equipVessel(pid, msg.uid, msg.slot);
        break;
      case 'unequipVessel':
        error = this.sim.unequipVessel(pid, msg.slot);
        break;
      case 'discard':
        error = this.sim.discard(pid, msg.uid);
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
        if (!this.devTools) {
          client.send({ t: 'notice', text: 'Dev tools are disabled on this server' });
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
      townEditor: this.townEditor,
      devTools: this.devTools,
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
      const snap = snapshotFor(this.sim, m.playerId, entities, events, NET.interestRadius);
      snap.paused = this.paused;
      m.client.send(snap);
    }
  }
}

export function roomIdFor(desc: MapDescriptor): string {
  return mapKey(desc).replaceAll(':', '-');
}
