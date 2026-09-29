import {
  DEFAULT_SERVER_SETTINGS,
  HOME_ZONE,
  INSTANCE_CAPACITY,
  jsonCodec,
  parseClientMessage,
  SIM,
  WILDS,
  ZONE_IDS,
  zoneArrival,
  type AdminOverview,
  type ClientMessage,
  type ServerSettings,
  type ServerMessage,
  type DungeonRef,
  type MapDescriptor,
  type PlayerSave,
  type PortalRequest,
  type TownLayout,
  type Vec2,
  type ZoneId,
} from '@rune/shared';
import type { WebSocket } from 'ws';
import type { AccountStore } from './accounts.js';
import type { AdminHooks } from './http.js';
import { Client, MAX_MESSAGES_PER_SECOND } from './client.js';
import { Room } from './room.js';
import { Staging } from './staging.js';
import { loadTownLayout, saveTownLayout, townEditorEnabled } from './townStore.js';

/** DEV_TOOLS=1 turns the encounter sandbox on at boot; admins can flip it later from the admin page. */
const devToolsAtBoot = process.env.DEV_TOOLS === '1';
const startedAt = Date.now();
const SERVER_BUILD = process.env.BUILD_ID ?? 'dev';

/** Bounds what a crash can lose; room changes and disconnects save straight away. */
const AUTOSAVE_SECONDS = 30;

/** Chat flood limit: this many messages per window. Generous for talk, tight for spam. */
const CHAT_PER_WINDOW = 6;
const CHAT_WINDOW_MS = 5000;

/** Waypoint travel is only allowed while standing on one; a little slack covers movement since the menu opened. */
const WAYPOINT_REACH = 120;

/**
 * One party's game, D2 style: its own town and zones, seeded once, for up to six players. Zone rooms
 * are created when someone first walks in and closed when abandoned; they regenerate identically
 * from the instance seed, with fresh monsters, like re-entering an area.
 */
interface Instance {
  id: string;
  seed: number;
  host: string;
  rooms: Set<string>;
}

/**
 * Owns every room and every connection. The Arena is one global test room; everything else lives
 * in party instances.
 */
export class RoomManager implements AdminHooks {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<string, Client>();
  private readonly instances = new Map<string, Instance>();
  /** Ready-check state per antechamber, keyed by the staging room id. */
  private readonly stagings = new Map<string, Staging>();
  private readonly arena: Room;
  private townLayout: TownLayout;
  private nextClientId = 1;
  private nextInstanceId = 1;
  private seedCounter: number;
  private timer: NodeJS.Timeout | null = null;
  private ticksSinceSave = 0;
  private current: ServerSettings;

  constructor(
    seed: number,
    private readonly store: AccountStore,
  ) {
    this.seedCounter = seed;
    // DEV_TOOLS only seeds a fresh database; after that the admin page decides.
    this.current = store.loadSettings({ ...DEFAULT_SERVER_SETTINGS, devTools: devToolsAtBoot });
    this.townLayout = loadTownLayout();
    this.arena = this.createRoom('arena', { kind: 'arena' }, null);
  }

  private createRoom(id: string, desc: MapDescriptor, instance: Instance | null): Room {
    const room = new Room(id, desc, this.seedCounter++);
    this.applySettings(room);
    room.instanceId = instance?.id ?? null;
    if (desc.kind === 'zone' && desc.zone === HOME_ZONE) room.townEditor = townEditorEnabled;
    this.rooms.set(room.id, room);
    instance?.rooms.add(room.id);
    return room;
  }

  private applySettings(room: Room): void {
    room.devTools = this.current.devTools;
    room.sim.rates = { xp: this.current.xpRate, loot: this.current.lootRate };
  }

  // Admin hooks -------------------------------------------------------------------------------

  settings(): ServerSettings {
    return { ...this.current };
  }

  updateSettings(patch: Partial<ServerSettings>): ServerSettings {
    this.current = { ...this.current, ...patch };
    this.store.saveSettings(this.current);
    for (const room of this.rooms.values()) {
      const hadDev = room.devTools;
      this.applySettings(room);
      // Clients read the dev flag from the welcome, so they learn about a change on the next one.
      if (hadDev === room.devTools) continue;
      if (!room.devTools) room.clearDevEffects();
      room.rewelcome();
    }
    return this.settings();
  }

  announce(text: string): number {
    let reached = 0;
    for (const c of this.clients.values()) {
      if (c.characterId === null) continue;
      c.send({ t: 'chat', kind: 'system', from: '', to: null, text: `Announcement: ${text}` });
      c.send({ t: 'banner', title: 'Announcement', text });
      reached++;
    }
    return reached;
  }

  kickCharacter(characterId: number): boolean {
    const c = [...this.clients.values()].find((x) => x.characterId === characterId);
    if (!c) return false;
    this.endSession(c, 'You were removed from the game by an admin');
    return true;
  }

  kickAccount(accountId: number): void {
    for (const c of [...this.clients.values()]) if (c.accountId === accountId) this.endSession(c, 'This account has been banned');
  }

  overview(): AdminOverview {
    const online = [...this.clients.values()].flatMap((c) => {
      const room = c.room;
      const m = room?.members.get(c.id);
      const p = m ? room?.sim.world.player.get(m.playerId) : undefined;
      if (!room || !p || c.characterId === null) return [];
      return [{ characterId: c.characterId, name: p.name, classId: p.classId, level: p.level, account: c.accountName, game: c.instanceId, room: room.name }];
    });
    return {
      build: SERVER_BUILD,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      online,
      games: [...this.instances.values()].map((i) => ({ id: i.id, host: i.host, players: this.membersOf(i).length, rooms: i.rooms.size })),
      rooms: [...this.rooms.values()].map((r) => ({ id: r.id, name: r.name, players: r.members.size, monsters: r.sim.world.enemy.size })),
    };
  }

  // -------------------------------------------------------------------------------------------

  private newInstance(host: string, seed: number | null = null): Instance {
    // Random seeds only need to differ between instances; a mixed counter keeps layouts varied.
    const s = seed ?? (Math.imul(this.seedCounter++, 2654435761) >>> 0) % 1_000_000;
    const inst: Instance = { id: `i${this.nextInstanceId++}`, seed: s, host, rooms: new Set() };
    this.instances.set(inst.id, inst);
    return inst;
  }

  private zoneDesc(inst: Instance, zone: ZoneId): Extract<MapDescriptor, { kind: 'zone' }> {
    // Each zone gets its own seed from the instance seed, so an instance's world is fixed but zones differ.
    const seed = ((Math.imul(inst.seed + 1, 2654435761) + ZONE_IDS.indexOf(zone) * 40503) >>> 0) % 1_000_000;
    return zone === HOME_ZONE ? { kind: 'zone', zone, seed, layout: this.townLayout } : { kind: 'zone', zone, seed };
  }

  private zoneRoom(inst: Instance, zone: ZoneId): Room {
    const id = `${inst.id}-${zone}`;
    return this.rooms.get(id) ?? this.createRoom(id, this.zoneDesc(inst, zone), inst);
  }

  private instanceOf(client: Client): Instance | null {
    return client.instanceId === null ? null : (this.instances.get(client.instanceId) ?? null);
  }

  private membersOf(inst: Instance): Client[] {
    return [...this.clients.values()].filter((c) => c.instanceId === inst.id && c.characterId !== null);
  }

  start(): void {
    const startedAt = performance.now();
    let ticks = 0;
    const loop = (): void => {
      const target = Math.floor((performance.now() - startedAt) / SIM.tickMs);
      // Cap catch-up so a long GC pause or breakpoint does not fast-forward the world.
      let budget = 5;
      while (ticks < target && budget-- > 0) {
        this.tick();
        ticks++;
      }
      if (ticks < target) {
        console.warn(`fell behind by ${target - ticks} ticks, skipping`);
        ticks = target;
      }
      this.timer = setTimeout(loop, Math.max(0, startedAt + (ticks + 1) * SIM.tickMs - performance.now()));
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private tick(): void {
    if (++this.ticksSinceSave >= AUTOSAVE_SECONDS * SIM.tickRate) {
      this.ticksSinceSave = 0;
      this.saveAll();
    }
    for (const room of [...this.rooms.values()]) {
      for (const { client, request } of room.tick()) this.usePortal(client, room, request);
      if (this.closable(room)) this.close(room);
    }
    for (const staging of this.stagings.values()) {
      if (staging.runRoomId !== null && !this.rooms.has(staging.runRoomId)) staging.runRoomId = null;
      staging.recheck();
      if (staging.tick()) this.startRun(staging);
      const run = staging.runRoomId === null ? undefined : this.rooms.get(staging.runRoomId);
      if (run?.sim.cleared) staging.cleared = true;
      staging.broadcast(run?.members.size ?? 0);
    }
    for (const inst of [...this.instances.values()]) {
      if (inst.rooms.size === 0 && this.membersOf(inst).length === 0) this.instances.delete(inst.id);
    }
  }

  /** Abandoned rooms close. An antechamber stays while its run is live, so latecomers can still get in. */
  private closable(room: Room): boolean {
    if (room === this.arena || room.members.size > 0 || room.emptySeconds <= WILDS.idleCloseSeconds) return false;
    return room.desc.kind !== 'staging' || this.stagings.get(room.id)?.runRoomId === null;
  }

  private close(room: Room): void {
    this.rooms.delete(room.id);
    this.stagings.delete(room.id);
    if (room.instanceId !== null) this.instances.get(room.instanceId)?.rooms.delete(room.id);
  }

  private stagingFor(inst: Instance, ref: DungeonRef): Room {
    const id = `${inst.id}-st-${ref.seed}-${ref.level}`;
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const room = this.createRoom(id, { kind: 'staging', seed: ref.seed, level: ref.level }, inst);
    this.stagings.set(room.id, new Staging(room, ref));
    return room;
  }

  /** Everyone in the antechamber goes into a brand new run together. */
  private startRun(staging: Staging): void {
    const inst = staging.room.instanceId === null ? undefined : this.instances.get(staging.room.instanceId);
    if (!inst) return;
    const run = this.createRoom(
      `${inst.id}-dg-${staging.ref.seed}-${staging.runs}`,
      { kind: 'dungeon', seed: staging.ref.seed, level: staging.ref.level, run: staging.runs++ },
      inst,
    );
    staging.runRoomId = run.id;
    staging.cleared = false;
    for (const m of [...staging.room.members.values()]) this.move(m.client, run);
  }

  connect(socket: WebSocket): void {
    const client = new Client(`c${this.nextClientId++}`, socket);
    this.clients.set(client.id, client);
    socket.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    socket.on('close', () => {
      const room = client.room;
      if (room) this.persist(client, room, room.remove(client));
      this.clients.delete(client.id);
    });
    socket.on('error', () => socket.close());
  }

  private onMessage(client: Client, data: unknown, isBinary: boolean): void {
    const now = performance.now();
    if (now - client.messageWindowStart >= 1000) {
      client.messageWindowStart = now;
      client.messageCount = 0;
    }
    if (++client.messageCount > MAX_MESSAGES_PER_SECOND) {
      client.socket.close(1008, 'rate limit');
      return;
    }
    if (isBinary || !(data instanceof Buffer)) return;
    let decoded: unknown;
    try {
      decoded = jsonCodec.decode(data.toString('utf8'));
    } catch {
      return;
    }
    const msg = parseClientMessage(decoded);
    if (msg) this.handle(client, msg);
  }

  private handle(client: Client, msg: ClientMessage): void {
    if (client.characterId === null && msg.t !== 'ping' && msg.t !== 'join') return;
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', clientTime: msg.clientTime });
        return;
      case 'join':
        this.join(client, msg.token, msg.characterId, msg.mode);
        return;
      case 'townPortal':
        this.goHome(client);
        return;
      case 'newInstance': {
        const inst = this.newInstance(this.playerName(client), msg.seed);
        client.instanceId = inst.id;
        this.move(client, this.zoneRoom(inst, HOME_ZONE));
        return;
      }
      case 'joinInstance': {
        const inst = this.instances.get(msg.id);
        if (!inst) client.send({ t: 'notice', text: 'That game has closed' });
        else if (inst.id === client.instanceId) client.send({ t: 'notice', text: 'You are already in that game' });
        else if (this.membersOf(inst).length >= INSTANCE_CAPACITY) client.send({ t: 'notice', text: `That game is full (${INSTANCE_CAPACITY} players)` });
        else {
          client.instanceId = inst.id;
          this.move(client, this.zoneRoom(inst, HOME_ZONE));
        }
        return;
      }
      case 'useWaypoint':
        this.useWaypoint(client, msg.zone);
        return;
      case 'chat':
        this.chat(client, msg.text);
        return;
      case 'ready': {
        const room = client.room;
        const staging = room ? this.stagings.get(room.id) : undefined;
        staging?.setReady(client, msg.ready);
        return;
      }
      case 'saveTown': {
        if (!townEditorEnabled) {
          client.send({ t: 'notice', text: 'The town editor is disabled on this server' });
          return;
        }
        saveTownLayout(msg.layout);
        this.replaceTown(msg.layout);
        client.send({ t: 'notice', text: 'Town saved' });
        return;
      }
      case 'listInstances':
        client.send({
          t: 'instances',
          // Empty games are about to close and cannot be met in, so they are not offered.
          list: [...this.instances.values()].filter((inst) => this.membersOf(inst).length > 0).map((inst) => ({
            id: inst.id,
            name: `${inst.host}'s game`,
            seed: inst.seed,
            players: this.membersOf(inst).map((c) => this.playerName(c)),
            capacity: INSTANCE_CAPACITY,
            yours: inst.id === client.instanceId,
          })),
        });
        return;
      default:
        client.room?.handle(client, msg);
    }
  }

  private playerName(client: Client): string {
    const room = client.room;
    const m = room?.members.get(client.id);
    const p = m ? room?.sim.world.player.get(m.playerId) : undefined;
    return p?.name ?? '?';
  }

  /** The instance's town, or a fresh game if the old one is gone (after a restart, say). */
  private goHome(client: Client): void {
    const inst = this.instanceOf(client) ?? this.newInstance(this.playerName(client));
    client.instanceId = inst.id;
    this.move(client, this.zoneRoom(inst, HOME_ZONE));
  }

  /** Rebuilds every town with the new layout and carries everyone inside over. */
  private replaceTown(layout: TownLayout): void {
    this.townLayout = layout;
    for (const inst of this.instances.values()) {
      const old = this.rooms.get(`${inst.id}-${HOME_ZONE}`);
      if (!old) continue;
      this.close(old);
      const next = this.zoneRoom(inst, HOME_ZONE);
      for (const m of [...old.members.values()]) {
        const save = old.remove(m.client);
        if (save) next.add(m.client, save.classId, save.name, save);
      }
    }
  }

  private usePortal(client: Client, from: Room, request: PortalRequest): void {
    const inst = this.instanceOf(client);
    switch (request.target) {
      case 'town':
        this.goHome(client);
        return;
      case 'arena':
        this.move(client, this.arena);
        return;
      case 'zone': {
        const zone = request.portal.zone;
        if (!inst || !zone || from.desc.kind !== 'zone') return;
        const to = this.zoneRoom(inst, zone);
        if (to.desc.kind === 'zone') this.move(client, to, zoneArrival(to.desc, from.desc.zone));
        return;
      }
      case 'waypoint': {
        const state = from.playerState(client);
        const zone = request.portal.zone;
        if (!state || !zone) return;
        client.send({ t: 'waypoints', current: zone, unlocked: ZONE_IDS.filter((z) => state.waypoints.includes(z)) });
        return;
      }
      case 'staging':
        if (inst && request.portal.dungeon) this.move(client, this.stagingFor(inst, request.portal.dungeon));
        return;
      case 'dungeon': {
        const staging = this.stagings.get(from.id);
        const run = staging?.runRoomId ? this.rooms.get(staging.runRoomId) : undefined;
        if (run) this.move(client, run);
        else client.send({ t: 'notice', text: 'The gate is sealed until everyone here is ready (R)' });
        return;
      }
      case 'wilds': {
        const last = client.lastZoneRoomId === null ? undefined : this.rooms.get(client.lastZoneRoomId);
        if (last) this.move(client, last);
        else this.goHome(client);
      }
    }
  }

  private system(client: Client, text: string): void {
    client.send({ t: 'chat', kind: 'system', from: '', to: null, text });
  }

  /** Game chat plus a few D2-style commands. Rate limited so one player cannot flood a game. */
  private chat(client: Client, text: string): void {
    const now = performance.now();
    client.chatTimes = client.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (client.chatTimes.length >= CHAT_PER_WINDOW) {
      this.system(client, 'You are sending messages too quickly');
      return;
    }
    client.chatTimes.push(now);
    const from = this.playerName(client);
    if (text.startsWith('/')) {
      const [cmd = '', ...rest] = text.slice(1).split(' ');
      switch (cmd.toLowerCase()) {
        case 'w':
        case 'whisper': {
          const [name = '', ...words] = rest;
          const body = words.join(' ').trim();
          const target = [...this.clients.values()].find((c) => c.characterId !== null && this.playerName(c).toLowerCase() === name.toLowerCase());
          if (!body) this.system(client, 'Usage: /w name message');
          else if (!target) this.system(client, `${name} is not online`);
          else {
            const msg: ServerMessage = { t: 'chat', kind: 'whisper', from, to: this.playerName(target), text: body };
            target.send(msg);
            if (target !== client) client.send(msg);
          }
          return;
        }
        case 'who': {
          const inst = this.instanceOf(client);
          const names = inst ? this.membersOf(inst).map((c) => this.playerName(c)) : [from];
          this.system(client, `In your game: ${names.join(', ')}`);
          return;
        }
        case 'help':
          this.system(client, 'Enter chats to your game. /w name message whispers anyone online. /who lists your game.');
          return;
        default:
          this.system(client, `Unknown command /${cmd}. Try /help`);
          return;
      }
    }
    const inst = this.instanceOf(client);
    const to = inst ? this.membersOf(inst) : [client];
    for (const c of to) c.send({ t: 'chat', kind: 'game', from, to: null, text });
  }

  /** Checked on the server: standing on a waypoint, and the destination unlocked by this character. */
  private useWaypoint(client: Client, zone: ZoneId): void {
    const room = client.room;
    const inst = this.instanceOf(client);
    const state = room?.playerState(client);
    if (!room || !inst || !state) return;
    const near = room.sim.mapDef.portals.some((p) => p.target === 'waypoint' && Math.hypot(p.x - state.x, p.y - state.y) <= p.r + WAYPOINT_REACH);
    if (!near) {
      client.send({ t: 'notice', text: 'Stand on a waypoint to travel' });
      return;
    }
    if (!state.waypoints.includes(zone)) {
      client.send({ t: 'notice', text: 'You have not found that waypoint yet' });
      return;
    }
    const to = this.zoneRoom(inst, zone);
    if (to !== room && to.desc.kind === 'zone') this.move(client, to, zoneArrival(to.desc, 'waypoint'));
  }

  /** Carries the character (class, name, items, equipment) from the current room into `to`. */
  private move(client: Client, to: Room, at?: Vec2): void {
    const from = client.room;
    if (!from || from === to) return;
    const carried = from.remove(client);
    if (!carried) return;
    this.persist(client, from, carried);
    // Leaving the sandbox restores the stored character, so free rune editing never leaks into the world.
    const stored = isSandbox(from) && !isSandbox(to) ? this.loadSave(client) : null;
    const save = stored ?? carried;
    if (to.desc.kind === 'zone') client.lastZoneRoomId = to.id;
    to.add(client, save.classId, save.name, save, at);
  }

  private join(client: Client, token: string, characterId: number, mode: 'world' | 'arena'): void {
    if (client.characterId !== null) return;
    const account = this.store.accountForToken(token);
    const character = account ? this.store.loadCharacter(account.id, characterId) : null;
    if (!account || !character) {
      this.endSession(client, 'Your session has expired, log in again');
      return;
    }
    // One character per account in the world at a time, so the same items cannot exist twice.
    for (const other of this.clients.values()) {
      if (other !== client && other.accountId === account.id) this.endSession(other, 'Logged in from another window');
    }
    client.accountId = account.id;
    client.accountName = account.username;
    client.characterId = character.id;
    // Everyone starts in a game of their own, like D2; friends join it from the menu.
    const inst = this.newInstance(character.name);
    client.instanceId = inst.id;
    const room = mode === 'arena' ? this.arena : this.zoneRoom(inst, HOME_ZONE);
    room.add(client, character.classId, character.name, character.save ?? undefined);
    // A brand new character gets its starter kit on first entry; store it right away.
    if (!character.save) this.persist(client, room, room.exportMember(client));
    if (this.current.motd) this.system(client, this.current.motd);
  }

  private loadSave(client: Client): PlayerSave | null {
    if (client.accountId === null || client.characterId === null) return null;
    return this.store.loadCharacter(client.accountId, client.characterId)?.save ?? null;
  }

  private persist(client: Client, room: Room, save: PlayerSave | null): void {
    if (!save || client.characterId === null || isSandbox(room)) return;
    this.store.saveCharacter(client.characterId, save);
  }

  saveAll(): void {
    for (const room of this.rooms.values()) {
      for (const m of room.members.values()) this.persist(m.client, room, room.exportMember(m.client));
    }
  }

  /** Saves, removes and disconnects. Used for duplicate logins and deleted characters. */
  endSession(client: Client, reason: string): void {
    const room = client.room;
    if (room) this.persist(client, room, room.remove(client));
    client.characterId = null;
    client.accountId = null;
    client.send({ t: 'sessionEnded', reason });
    client.socket.close(4001, 'session ended');
  }

  endCharacterSession(characterId: number): void {
    for (const c of this.clients.values()) if (c.characterId === characterId) this.endSession(c, 'That character was deleted');
  }
}

/** Rooms with free rune editing. Nothing done there is saved. */
function isSandbox(room: Room): boolean {
  return room.sim.editorAllowed;
}
