import {
  can,
  HOME_ZONE,
  INSTANCE_CAPACITY,
  jsonCodec,
  parseClientMessage,
  SETTINGS_LIMITS,
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
  type PartyInfo,
  type PortalRequest,
  type Role,
  type TownLayout,
  type Vec2,
  type WorldInfo,
  type ZoneId,
} from '@rune/shared';
import type { AccountStore } from './accounts.js';
import { roleOf, type AdminHooks } from './http.js';
import { Client, MAX_MESSAGES_PER_SECOND, type GameSocket } from './client.js';
import { Room } from './room.js';
import { Staging } from './staging.js';
import { loadTownLayout, saveTownLayout } from './townStore.js';

const startedAt = Date.now();
const TOWN_SAVE_COOLDOWN_MS = 3000;
const SERVER_BUILD = process.env.BUILD_ID ?? 'dev';

/** Bounds what a crash can lose; room changes and disconnects save straight away. */
const AUTOSAVE_SECONDS = 30;

/** Chat flood limit: this many messages per window. Generous for talk, tight for spam. */
const CHAT_PER_WINDOW = 6;
const CHAT_WINDOW_MS = 5000;

/** Waypoint travel is only allowed while standing on one; a little slack covers movement since the menu opened. */
const WAYPOINT_REACH = 120;

/**
 * One copy of the world: its own town and zones, seeded once, for up to INSTANCE_CAPACITY players.
 * Public copies all use the owner's world seed and fill up in turn; a party copy has a random seed
 * of its own and only lets the party in. Zone rooms are created when someone first walks in and
 * closed when abandoned; they regenerate identically from the seed, with fresh monsters.
 */
interface Instance {
  id: string;
  seed: number;
  kind: 'public' | 'party';
  name: string;
  rooms: Set<string>;
  /** The party a party world belongs to. */
  partyId: string | null;
}

/** Players who travel together. Kept by account, in memory, so a reconnect stays in the party. */
interface Party {
  id: string;
  leader: number;
  /** Account id to the character name last seen, for the member list. */
  members: Map<number, string>;
  instanceId: string | null;
}

/**
 * Owns every room and every connection. The Arena is one global test room; everything else lives
 * in party instances.
 */
export class RoomManager implements AdminHooks {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<string, Client>();
  private readonly instances = new Map<string, Instance>();
  private readonly parties = new Map<string, Party>();
  /** Invited account id to the inviting account id. */
  private readonly invites = new Map<number, number>();
  private nextPartyId = 1;
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
    /** Lower-cased owner usernames from ADMIN_USERS. */
    private readonly owners: ReadonlySet<string> = new Set(),
  ) {
    this.seedCounter = seed;
    this.current = store.loadSettings();
    this.townLayout = loadTownLayout();
    this.arena = this.createRoom('arena', { kind: 'arena' }, null);
  }

  private createRoom(id: string, desc: MapDescriptor, instance: Instance | null): Room {
    const room = new Room(id, desc, this.seedCounter++);
    this.applySettings(room);
    room.instanceId = instance?.id ?? null;
    if (desc.kind === 'zone' && desc.zone === HOME_ZONE) room.hostsTown = true;
    this.rooms.set(room.id, room);
    instance?.rooms.add(room.id);
    return room;
  }

  private applySettings(room: Room): void {
    room.sim.rates = { xp: this.current.xpRate, loot: this.current.lootRate };
  }

  // Admin hooks -------------------------------------------------------------------------------

  settings(): ServerSettings {
    return { ...this.current };
  }

  updateSettings(patch: Partial<ServerSettings>): ServerSettings {
    this.current = { ...this.current, ...patch };
    this.store.saveSettings(this.current);
    for (const room of this.rooms.values()) this.applySettings(room);
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

  gotoCharacter(staffAccountId: number, characterId: number): string | null {
    const staff = [...this.clients.values()].find((c) => c.accountId === staffAccountId && c.characterId !== null);
    const target = [...this.clients.values()].find((c) => c.characterId === characterId);
    if (!staff) return 'Enter the game first; teleporting moves your character';
    if (!target) return 'That character is not online';
    return this.goto(staff, target);
  }

  /** Staff jump to a player: same world copy and room, beside them. Party worlds too, to check on things. */
  private goto(staff: Client, target: Client): string | null {
    if (staff === target) return 'That is you';
    const room = target.room;
    const at = room?.playerState(target);
    if (!room || !at) return 'That player is between rooms, try again';
    if (room === this.arena || isSandbox(room)) return 'That player is in the Arena';
    const beside = { x: at.x + 40, y: at.y };
    if (staff.room === room) room.placeMember(staff, beside.x, beside.y);
    else {
      const before = this.instanceOf(staff);
      staff.instanceId = target.instanceId;
      this.move(staff, room, beside);
      if (before) this.sendWorldToAll(before);
      const inst = this.instanceOf(target);
      if (inst) this.sendWorldToAll(inst);
    }
    console.log(`[admin] ${staff.accountName}: teleported to ${this.playerName(target)}`);
    return null;
  }

  currentTown(): TownLayout {
    return this.townLayout;
  }

  roleChanged(accountId: number, role: Role): void {
    for (const c of this.clients.values()) {
      if (c.accountId !== accountId) continue;
      // Owners stay owners whatever the stored role says.
      c.role = this.owners.has(c.accountName.toLowerCase()) ? 'owner' : role;
      c.room?.refreshMember(c);
    }
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
      games: [...this.instances.values()].map((i) => ({ id: i.id, host: i.name, players: this.membersOf(i).length, rooms: i.rooms.size })),
      rooms: [...this.rooms.values()].map((r) => ({ id: r.id, name: r.name, players: r.members.size, monsters: r.sim.world.enemy.size })),
    };
  }

  // -------------------------------------------------------------------------------------------

  private newInstance(kind: Instance['kind'], seed: number, name: string, partyId: string | null = null): Instance {
    const inst: Instance = { id: `i${this.nextInstanceId++}`, seed, kind, name, rooms: new Set(), partyId };
    this.instances.set(inst.id, inst);
    return inst;
  }

  /** The first public copy on the current world seed with room, or a new one. */
  private publicInstance(): Instance {
    const seed = this.current.worldSeed;
    const open = [...this.instances.values()].find((i) => i.kind === 'public' && i.seed === seed && this.membersOf(i).length < INSTANCE_CAPACITY);
    if (open) return open;
    const n = [...this.instances.values()].filter((i) => i.kind === 'public').length + 1;
    return this.newInstance('public', seed, `Public world ${n}`);
  }

  private partyInstance(party: Party): Instance | null {
    return party.instanceId === null ? null : (this.instances.get(party.instanceId) ?? null);
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
      if (inst.rooms.size === 0 && this.membersOf(inst).length === 0) {
        this.instances.delete(inst.id);
        const party = inst.partyId === null ? undefined : this.parties.get(inst.partyId);
        if (party?.instanceId === inst.id) {
          party.instanceId = null;
          this.sendParty(party);
        }
      }
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

  connect(socket: GameSocket): void {
    const client = new Client(`c${this.nextClientId++}`, socket);
    this.clients.set(client.id, client);
    socket.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    socket.on('close', () => {
      const room = client.room;
      if (room) this.persist(client, room, room.remove(client));
      this.clients.delete(client.id);
      const inst = this.instanceOf(client);
      if (inst) this.sendWorldToAll(inst);
      const party = this.partyOf(client.accountId);
      if (party) this.sendParty(party);
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
      case 'partyInvite':
        this.partyInvite(client, msg.name);
        return;
      case 'partyAnswer':
        this.partyAnswer(client, msg.accept);
        return;
      case 'partyLeave':
        this.partyLeave(client);
        return;
      case 'partyWorld':
        this.goPartyWorld(client);
        return;
      case 'publicWorld':
        if (this.instanceOf(client)?.kind === 'public') this.system(client, 'You are already in the public world');
        else this.enterInstance(client, this.publicInstance());
        return;
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
        if (!can(client.role, 'townEdit')) {
          client.send({ t: 'notice', text: 'The town editor needs the builder role' });
          return;
        }
        // A save rebuilds the town room in every game, so it is rate limited per client.
        const now = Date.now();
        if (now - client.lastTownSave < TOWN_SAVE_COOLDOWN_MS) {
          client.send({ t: 'notice', text: 'Wait a few seconds between town saves' });
          return;
        }
        client.lastTownSave = now;
        try {
          saveTownLayout(msg.layout);
        } catch (err) {
          console.error('saving the town layout failed', err);
          client.send({ t: 'notice', text: 'Could not save the town on the server' });
          return;
        }
        console.log(`[town] saved by ${client.accountName}`);
        this.replaceTown(msg.layout);
        client.send({ t: 'notice', text: 'Town saved' });
        return;
      }
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

  /** The town of the world the player is in, or of the public world if that copy is gone. */
  private goHome(client: Client): void {
    this.enterInstance(client, this.instanceOf(client) ?? this.publicInstance());
  }

  private enterInstance(client: Client, inst: Instance): void {
    const before = this.instanceOf(client);
    client.instanceId = inst.id;
    this.move(client, this.zoneRoom(inst, HOME_ZONE));
    if (before && before !== inst) this.sendWorldToAll(before);
    this.sendWorldToAll(inst);
  }

  // Worlds and parties ------------------------------------------------------------------------

  private worldInfo(inst: Instance): WorldInfo {
    return { kind: inst.kind, name: inst.name, players: this.membersOf(inst).length, capacity: INSTANCE_CAPACITY };
  }

  private sendWorldToAll(inst: Instance): void {
    const world = this.worldInfo(inst);
    for (const c of this.membersOf(inst)) c.send({ t: 'world', world });
  }

  private partyOf(accountId: number | null): Party | null {
    if (accountId === null) return null;
    for (const p of this.parties.values()) if (p.members.has(accountId)) return p;
    return null;
  }

  private onlineMembers(party: Party): Client[] {
    return [...this.clients.values()].filter((c) => c.accountId !== null && c.characterId !== null && party.members.has(c.accountId));
  }

  private sendParty(party: Party): void {
    const online = new Set(this.onlineMembers(party).map((c) => c.accountId));
    const info: PartyInfo = {
      leader: party.members.get(party.leader) ?? '?',
      members: [...party.members].map(([acc, name]) => ({ name, online: online.has(acc) })),
      hasWorld: this.partyInstance(party) !== null,
    };
    for (const c of this.onlineMembers(party)) c.send({ t: 'party', party: info });
  }

  private partyInvite(client: Client, name: string): void {
    const me = client.accountId;
    if (me === null) return;
    const target = [...this.clients.values()].find((c) => c.characterId !== null && this.playerName(c).toLowerCase() === name.trim().toLowerCase());
    if (!target || target.accountId === null) return this.system(client, `${name} is not online`);
    if (target.accountId === me) return this.system(client, 'You cannot invite yourself');
    if (this.partyOf(target.accountId)) return this.system(client, `${this.playerName(target)} is already in a party`);
    let party = this.partyOf(me);
    if (party && party.members.size >= INSTANCE_CAPACITY) return this.system(client, `Your party is full (${INSTANCE_CAPACITY})`);
    if (!party) {
      party = { id: `p${this.nextPartyId++}`, leader: me, members: new Map([[me, this.playerName(client)]]), instanceId: null };
      this.parties.set(party.id, party);
    }
    this.invites.set(target.accountId, me);
    target.send({ t: 'partyInvite', from: this.playerName(client) });
    this.system(client, `Invited ${this.playerName(target)} to your party`);
    this.sendParty(party);
  }

  private partyAnswer(client: Client, accept: boolean): void {
    const me = client.accountId;
    if (me === null) return;
    const from = this.invites.get(me);
    this.invites.delete(me);
    const party = from === undefined ? null : this.partyOf(from);
    const inviter = from === undefined ? undefined : [...this.clients.values()].find((c) => c.accountId === from);
    if (!party) return this.system(client, 'That invite is no longer open');
    if (!accept) {
      if (inviter) this.system(inviter, `${this.playerName(client)} declined your invite`);
      return;
    }
    if (this.partyOf(me)) return this.system(client, 'Leave your party first');
    if (party.members.size >= INSTANCE_CAPACITY) return this.system(client, 'That party is full');
    party.members.set(me, this.playerName(client));
    this.sendParty(party);
    for (const c of this.onlineMembers(party)) if (c !== client) this.system(c, `${this.playerName(client)} joined the party`);
    // Joining a party means playing together, so go to where the inviter is if there is room.
    const there = inviter ? this.instanceOf(inviter) : null;
    if (there && there !== this.instanceOf(client) && this.membersOf(there).length < INSTANCE_CAPACITY) this.enterInstance(client, there);
  }

  private partyLeave(client: Client): void {
    const me = client.accountId;
    const party = this.partyOf(me);
    if (me === null || !party) return this.system(client, 'You are not in a party');
    const inPartyWorld = this.instanceOf(client)?.partyId === party.id;
    party.members.delete(me);
    client.send({ t: 'party', party: null });
    for (const c of this.onlineMembers(party)) this.system(c, `${this.playerName(client)} left the party`);
    if (party.members.size <= 1) {
      // A party of one is no party; the last member keeps playing where they are.
      for (const c of this.onlineMembers(party)) c.send({ t: 'party', party: null });
      this.parties.delete(party.id);
      const world = this.partyInstance(party);
      if (world) world.partyId = null;
    } else {
      if (party.leader === me) party.leader = [...party.members.keys()][0] ?? me;
      this.sendParty(party);
    }
    // A party world is for the party only.
    if (inPartyWorld) this.enterInstance(client, this.publicInstance());
  }

  /** The leader opens the party's own world and brings everyone online; others follow into it. */
  private goPartyWorld(client: Client): void {
    const party = this.partyOf(client.accountId);
    if (!party) return this.system(client, 'Invite someone first: /invite name');
    let world = this.partyInstance(party);
    if (!world) {
      if (party.leader !== client.accountId) return this.system(client, 'Only the party leader can open a party world');
      // Random, from the server: seeds are never chosen by players.
      const seed = (Math.imul(this.seedCounter++, 2654435761) >>> 0) % (SETTINGS_LIMITS.seedMax + 1);
      world = this.newInstance('party', seed, `${party.members.get(party.leader) ?? 'Party'}'s party world`, party.id);
      party.instanceId = world.id;
      for (const c of this.onlineMembers(party)) this.enterInstance(c, world);
      this.sendParty(party);
      return;
    }
    if (this.instanceOf(client) === world) return this.system(client, 'You are already in the party world');
    this.enterInstance(client, world);
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
          this.system(client, `In this world: ${names.join(', ')}`);
          return;
        }
        case 'goto': {
          if (!can(client.role, 'teleport')) {
            this.system(client, 'Unknown command /goto. Try /help');
            return;
          }
          const name = rest.join(' ').trim().toLowerCase();
          const target = [...this.clients.values()].find((c) => c.characterId !== null && this.playerName(c).toLowerCase() === name);
          const error = target ? this.goto(client, target) : `${rest.join(' ')} is not online`;
          if (error) this.system(client, error);
          return;
        }
        case 'invite':
          this.partyInvite(client, rest.join(' '));
          return;
        case 'accept':
          this.partyAnswer(client, true);
          return;
        case 'decline':
          this.partyAnswer(client, false);
          return;
        case 'leave':
          this.partyLeave(client);
          return;
        case 'p':
        case 'party': {
          const party = this.partyOf(client.accountId);
          const body = rest.join(' ').trim();
          if (!party) this.system(client, 'You are not in a party');
          else if (body) for (const c of this.onlineMembers(party)) c.send({ t: 'chat', kind: 'party', from, to: null, text: body });
          return;
        }
        case 'help':
          this.system(client, 'Enter chats to your world. /p message to your party, /w name message whispers, /invite name, /accept, /decline, /leave, /who.');
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
    if (!account) {
      this.endSession(client, 'Your session has expired, log in again');
      return;
    }
    // One character per account in the world at a time, so the same items cannot exist twice. The
    // other window is saved before the character is loaded, or its latest progress would be lost.
    for (const other of this.clients.values()) {
      if (other !== client && other.accountId === account.id) this.endSession(other, 'Logged in from another window');
    }
    const character = this.store.loadCharacter(account.id, characterId);
    if (!character) {
      this.endSession(client, 'That character no longer exists');
      return;
    }
    if (character.saveUnreadable) {
      this.endSession(client, 'This character could not be loaded. Nothing was lost; ask the server owner to look at it.');
      return;
    }
    client.accountId = account.id;
    client.accountName = account.username;
    client.role = roleOf(account, this.owners);
    client.characterId = character.id;
    // Back into the party's world if it is still running and has room, otherwise the public world.
    const party = this.partyOf(account.id);
    if (party) party.members.set(account.id, character.name);
    const partyWorld = party ? this.partyInstance(party) : null;
    const inst = partyWorld && this.membersOf(partyWorld).length < INSTANCE_CAPACITY ? partyWorld : this.publicInstance();
    client.instanceId = inst.id;
    const room = mode === 'arena' ? this.arena : this.zoneRoom(inst, HOME_ZONE);
    room.add(client, character.classId, character.name, character.save ?? undefined);
    // A brand new character gets its starter kit on first entry; store it right away.
    if (!character.save) this.persist(client, room, room.exportMember(client));
    if (this.current.motd) this.system(client, this.current.motd);
    this.sendWorldToAll(inst);
    if (party) this.sendParty(party);
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
