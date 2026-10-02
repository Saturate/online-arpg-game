import {
  activeTunables,
  applyTunables,
  recompileSigils,
  ARENA,
  can,
  resolveChatLinks,
  INSTANCE_CAPACITY,
  jsonCodec,
  parseClientMessage,
  partyLevel,
  seasonOf,
  startArena,
  buyPrice,
  sellPrice,
  SETTINGS_LIMITS,
  TRADER,
  SIM,
  splitStash,
  WILDS,
  carryGroundLoot,
  currentWorldGen,
  entranceArrival,
  loadMap,
  worldGenKey,
  GATES,
  rememberWorld,
  restoreWorld,
  setRespawnTimes,
  TOWN_WAYPOINT,
  waypointArrival,
  type AdminOverview,
  type AdminLive,
  type LivePlayer,
  type LiveRoom,
  type LiveRoomKind,
  type LiveRegionGrid,
  type LiveWorld,
  type LiveWorldDot,
  ZONES,
  type ArenaResult,
  type ClassId,
  type ClientMessage,
  type EnemyOverride,
  type EnemyTypeId,
  type MinionOverride,
  type MinionTypeId,
  type TuningOverrides,
  type ServerSettings,
  type SimRates,
  type ServerMessage,
  type DungeonRef,
  type MapDescriptor,
  type PlayerComp,
  type PlayerSave,
  type Lighting,
  type Item,
  type ItemUid,
  type ZoomSettings,
  type PartyInfo,
  type PartyMemberStatus,
  type PartyPlace,
  type PortalRequest,
  type Role,
  type RoomRules,
  type TownLayout,
  type Vec2,
  type GateInfo,
  type WorldInfo,
  type WorldMemory,
  type WorldGenValues,
  type WorldRebuildCopy,
  type WorldRebuildFailure,
  type WorldRebuildResult,
} from '@rune/shared';
import { boardOf, type AccountStore, type CharacterSaveRow, type Market } from './accounts.js';
import { ArenaRun } from './arena.js';
import { LiveTuning } from './liveTuning.js';
import { roleOf, type AdminHooks, type TownSaveResult } from './http.js';
import { Client, MAX_MESSAGES_PER_SECOND, type GameSocket } from './client.js';
import { events } from './eventLog.js';
import { channelBreak, PARTY_STATUS_TICKS, TELEPORT_CHANNEL_SECONDS, type ChannelWatch, type TeleportChannel } from './partyTravel.js';
import { Room } from './room.js';
import { rollBackTrade, snapshotForTrade, type TradeSnapshot } from './tradeRollback.js';
import { Staging, type StagingTarget } from './staging.js';
import { roomTiming, serverStats } from './tickStats.js';
import { loadTownLayout, saveTownLayout } from './townStore.js';

const startedAt = Date.now();
const TOWN_SAVE_COOLDOWN_MS = 3000;
/**
 * The least time between two rebuilds or rerolls of one world copy, whoever asks: a rebuild that
 * moves the ground fills its chests and brings its bosses back, so rebuilds must not farm them.
 */
const COPY_REBUILD_COOLDOWN_MS = 60_000;
const SERVER_BUILD = process.env.BUILD_ID ?? 'dev';

/** How often joins and leaves are summed up in the server log. */
const PLAYER_REPORT_MINUTES = 5;

/** Bounds what a crash can lose; room changes and disconnects save straight away. */
const AUTOSAVE_SECONDS = 30;

/** Chat flood limit: this many messages per window. Generous for talk, tight for spam. */
const CHAT_PER_WINDOW = 6;
const CHAT_WINDOW_MS = 5000;

/**
 * Most players a world copy takes when the newcomer is joining a party member there. The public
 * world stops sending strangers at INSTANCE_CAPACITY, and a party holds at most INSTANCE_CAPACITY
 * members, so a copy that was full when a party's first member got in can still take the other 7:
 * 8 + 7 = 15. Only two parties overflowing the same copy at once can reach it. The whole world is
 * one room, so this many can share one simulation; the cap stops a copy from growing without end.
 */
const INSTANCE_HARD_CAP = INSTANCE_CAPACITY * 2 - 1;

/** Waypoint travel is only allowed while standing on one; a little slack covers movement since the menu opened. */
const WAYPOINT_REACH = 120;

/**
 * One copy of the world: one seamless room holding the town and every region, seeded once, for up to
 * INSTANCE_CAPACITY players. Public copies all use the owner's world seed and fill up in turn; a
 * party copy has a random seed of its own and only lets the party in. The world room is created when
 * someone first enters the copy and closed when abandoned; it regenerates identically from the
 * seed, with fresh monsters. Dungeons, their antechambers and the Arena are rooms of their own.
 */
interface Instance {
  id: string;
  seed: number;
  kind: 'public' | 'party';
  name: string;
  rooms: Set<string>;
  /** The party a party world belongs to. */
  partyId: string | null;
  /**
   * What the world room kept when it last closed or was rebuilt (`rememberWorld`): dead bosses'
   * timers and opened chests, so a room reopened after standing empty does not hand them out again.
   * In memory only; a restart starts every copy fresh.
   */
  memory: WorldMemory | null;
  /**
   * The generation numbers the copy was made with (off the code defaults), fixed for its life so the
   * world never changes under its players; only a forced rebuild or a reroll gives it others. The
   * public world's are stored by seed (WorldGenStore), so a restart builds the same world.
   */
  gen: WorldGenValues;
}

/** Players who travel together. Kept by account, in memory, so a reconnect stays in the party. */
interface Party {
  id: string;
  leader: number;
  /** Account id to the character name last seen, for the member list. */
  members: Map<number, string>;
  /** Class and level last seen per account, so an offline member's frame still says who they are. */
  seen: Map<number, { cls: ClassId; level: number }>;
  instanceId: string | null;
}

/**
 * Owns every room and every connection. Every room belongs to a world instance: its world, the
 * dungeon and Arena antechambers and their runs, and builders' private sandboxes.
 */
export class RoomManager implements AdminHooks {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<string, Client>();
  private readonly instances = new Map<string, Instance>();
  private readonly parties = new Map<string, Party>();
  /** Invited account id to the inviting account id. */
  private readonly invites = new Map<number, number>();
  private nextPartyId = 1;
  /** Teleports to party members being channelled, keyed by the channelling client's id. */
  private readonly channels = new Map<string, TeleportChannel>();
  private ticksSinceStatus = 0;
  /** Ready-check state per antechamber, keyed by the staging room id. */
  private readonly stagings = new Map<string, Staging>();
  /** Live and just-finished Arena runs, keyed by the run's room id. */
  private readonly arenaRuns = new Map<string, ArenaRun>();
  /** Builders' private sandbox rooms. */
  private readonly sandboxes = new Set<string>();
  private townLayout: TownLayout;
  /** When each account last saved the town, for the save cooldown. */
  private readonly lastTownSave = new Map<number, number>();
  /** When each account last forced a world rebuild or reroll, under the town save's cooldown. */
  private readonly lastRebuild = new Map<number, number>();
  private nextClientId = 1;
  private nextInstanceId = 1;
  private nextArenaRun = 1;
  private seedCounter: number;
  private timer: NodeJS.Timeout | null = null;
  private ticksSinceSave = 0;
  private current: ServerSettings;
  private market: Market;
  private readonly tuning: LiveTuning;

  constructor(
    seed: number,
    private readonly store: AccountStore,
    /** Lower-cased owner usernames from ADMIN_USERS. */
    private readonly owners: ReadonlySet<string> = new Set(),
  ) {
    this.seedCounter = seed;
    this.current = store.loadSettings();
    this.market = store.loadMarket();
    this.townLayout = loadTownLayout();
    this.tuning = new LiveTuning(store.tuning);
    // Before any room exists, so the first sigil compiled and the first welcome use the stored numbers.
    applyTunables(store.tunables.load(), (why) => events.warn('server', `[tuning] ${why}`));
  }

  /** The free bench is off unless a room asks for it; only the sandbox does. */
  private createRoom(id: string, desc: MapDescriptor, instance: Instance | null, rules: Partial<RoomRules> = {}): Room {
    const room = this.buildRoom(id, desc, instance, rules);
    this.register(room, instance);
    return room;
  }

  /** A room that nothing can reach until `register`: a rebuild builds its new world room first. */
  private buildRoom(id: string, desc: MapDescriptor, instance: Instance | null, rules: Partial<RoomRules> = {}): Room {
    const room = new Room(id, desc, this.seedCounter++, { bench: false, ...rules }, this.tuning.current, this.rates());
    this.applySettings(room);
    room.instanceId = instance?.id ?? null;
    if (desc.kind === 'world') room.hostsTown = true;
    return room;
  }

  private register(room: Room, instance: Instance | null): void {
    this.rooms.set(room.id, room);
    instance?.rooms.add(room.id);
  }

  private rates(): SimRates {
    const s = this.current;
    return {
      xp: s.xpRate,
      loot: s.lootRate,
      forceMax: s.forceMax,
      forceCost: s.forceCostRate,
      forceCool: s.forceCoolRate,
      forceRampMax: s.forceRampMax,
      bossLife: s.bossLifeMultiplier,
      bossDamage: s.bossDamageMultiplier,
      castCooldown: s.castCooldownSeconds,
      lootMerge: s.lootMergeRadius,
      lootPileMax: s.lootPileMaxSeconds,
    };
  }

  private applySettings(room: Room): void {
    room.sim.setRates(this.rates());
    setRespawnTimes(room.sim, this.current);
  }

  // Admin hooks -------------------------------------------------------------------------------

  settings(): ServerSettings {
    return { ...this.current };
  }

  updateSettings(patch: Partial<ServerSettings>): ServerSettings {
    const cooldownChanged = patch.castCooldownSeconds !== undefined && patch.castCooldownSeconds !== this.current.castCooldownSeconds;
    this.current = { ...this.current, ...patch };
    this.store.saveSettings(this.current);
    for (const room of this.rooms.values()) this.applySettings(room);
    const lighting = this.lighting();
    const zoom = this.zoom();
    for (const c of this.clients.values()) {
      if (c.characterId === null) continue;
      c.send({ t: 'lighting', lighting });
      c.send({ t: 'zoom', zoom });
      if (cooldownChanged) c.send({ t: 'castCooldown', seconds: this.current.castCooldownSeconds });
    }
    return this.settings();
  }

  tuningOverrides(): TuningOverrides {
    return this.tuning.overrides;
  }

  setMonsterOverride(typeId: EnemyTypeId, override: EnemyOverride | null): TuningOverrides {
    return this.retune(this.tuning.setMonster(typeId, override));
  }

  setMinionOverride(typeId: MinionTypeId, override: MinionOverride | null): TuningOverrides {
    return this.retune(this.tuning.setMinion(typeId, override));
  }

  /**
   * Live tuning changed (tunablesRoutes.ts applied it already): equipped sigils carry their compiled
   * program and Force price, so every room compiles them again for the next cast, and every client
   * gets the new set for its tooltips and the forge.
   */
  tunablesChanged(): void {
    for (const room of this.rooms.values()) {
      for (const n of recompileSigils(room.sim)) {
        for (const m of room.members.values()) if (m.playerId === n.pid) m.client.send({ t: 'notice', text: n.text });
      }
    }
    const msg: ServerMessage = { t: 'tunables', values: activeTunables() };
    for (const c of this.clients.values()) if (c.characterId !== null) c.send(msg);
  }

  /** Every room spawns from the new numbers at once; players only hear about model changes. */
  private retune(modelsChanged: boolean): TuningOverrides {
    for (const room of this.rooms.values()) room.sim.setTuning(this.tuning.current);
    if (modelsChanged) {
      const msg = this.tuning.modelsMessage();
      for (const c of this.clients.values()) if (c.characterId !== null) c.send(msg);
    }
    return this.tuning.overrides;
  }

  private lighting(): Lighting {
    const { dayMinutes, nightBrightness, timeOfDay, clockOffset, heldPhase, heroLight, heroLightRadius, lampLight } = this.current;
    return { dayMinutes, nightBrightness, timeOfDay, clockOffset, heldPhase, heroLight, heroLightRadius, lampLight };
  }

  private zoom(): ZoomSettings {
    const { zoomDefault, zoomDungeon, zoomMin, zoomMax } = this.current;
    return { zoomDefault, zoomDungeon, zoomMin, zoomMax };
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
    // A scored run takes nobody who was not there at the start, and a sandbox is its builder's own.
    if (this.arenaRuns.has(room.id)) return 'That player is in an Arena run';
    if (this.sandboxes.has(room.id)) return 'That player is in a private sandbox';
    const error = this.travelTo(staff, target, true);
    if (error) return error;
    events.log('staff', `[admin] ${staff.accountName}: teleported to ${this.playerName(target)}`);
    return null;
  }

  /**
   * Puts the client beside the target: moved within the room, or carried into the target's world
   * copy and room the same way waypoints and portals do it (saved on the way out). `staff` is an
   * admin's goto, the one placement the gate seals do not hold.
   */
  private travelTo(client: Client, target: Client, staff = false): string | null {
    const room = target.room;
    const at = room?.playerState(target);
    if (!room || !at) return 'That player is between rooms, try again';
    // The step aside can cross a seal the target stands at; then onto the target's own spot, which
    // the teleport's refusal already checked.
    const gates = client.room?.playerState(client)?.gates ?? [];
    const beside = this.sealedAt(room, at.x + 40, at.y, gates) === null ? { x: at.x + 40, y: at.y } : { x: at.x, y: at.y };
    if (client.room === room) {
      this.move(client, room, beside, staff);
      return null;
    }
    const before = this.instanceOf(client);
    const beforeId = client.instanceId;
    client.instanceId = target.instanceId;
    if (!this.move(client, room, beside, staff)) {
      client.instanceId = beforeId;
      return 'Could not travel there, try again';
    }
    if (before) this.sendWorldToAll(before);
    const inst = this.instanceOf(target);
    if (inst && inst !== before) this.sendWorldToAll(inst);
    return null;
  }

  accountOnline(accountId: number): boolean {
    for (const c of this.clients.values()) if (c.accountId === accountId) return true;
    return false;
  }

  /** Accounts with a character in the world right now. */
  onlineAccounts(): Set<number> {
    return new Set([...this.clients.values()].flatMap((c) => (c.accountId !== null && c.characterId !== null ? [c.accountId] : [])));
  }

  /** A live room by id, for tests and tools that need to look inside one. */
  roomById(id: string): Room | undefined {
    return this.rooms.get(id);
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

  /**
   * The Live view's game part; the admin API adds the log tails for callers with `serverLog`. Read
   * every few seconds per open admin page, so it may allocate; the tick never does for it.
   */
  live(have: ReadonlyMap<string, string> = new Map()): Omit<AdminLive, 'log' | 'staff'> {
    const now = Date.now();
    const players: LivePlayer[] = [];
    for (const c of this.clients.values()) {
      const room = c.room;
      const m = room?.members.get(c.id);
      const p = m ? room?.sim.world.player.get(m.playerId) : undefined;
      const pos = m ? room?.sim.world.position.get(m.playerId) : undefined;
      if (!room || !p || !pos || c.characterId === null || c.accountId === null) continue;
      const party = this.partyOf(c.accountId);
      players.push({
        characterId: c.characterId,
        accountId: c.accountId,
        account: c.accountName,
        name: p.name,
        classId: p.classId,
        level: p.level,
        game: c.instanceId,
        roomId: room.id,
        room: room.name,
        region: room.placeName(pos.x, pos.y),
        party: party ? `${party.members.get(party.leader) ?? 'Someone'}'s party (${party.members.size})` : null,
        onlineSeconds: c.joinedAt === 0 ? 0 : Math.max(0, Math.round((now - c.joinedAt) / 1000)),
      });
    }
    const rooms: LiveRoom[] = [...this.rooms.values()].map((r) => {
      const w = r.sim.world;
      return { id: r.id, name: r.name, kind: this.roomKind(r), game: r.instanceId, players: r.members.size, monsters: w.enemy.size, minions: w.minion.size, spells: w.projectile.size + w.nova.size + w.zone.size, ...roomTiming(r.tickTimes) };
    });
    const worlds: LiveWorld[] = [];
    const current = worldGenKey(currentWorldGen());
    for (const inst of this.instances.values()) {
      const room = this.rooms.get(this.worldRoomId(inst));
      if (!room) continue;
      const def = room.sim.mapDef;
      const dots: LiveWorldDot[] = [];
      for (const m of room.members.values()) {
        const pos = room.sim.world.position.get(m.playerId);
        const p = room.sim.world.player.get(m.playerId);
        if (!pos || !p) continue;
        dots.push({ x: Math.round(pos.x), y: Math.round(pos.y), name: p.name, inParty: this.partyOf(m.client.accountId) !== null });
      }
      const town = def.safeZones?.[0];
      const planHash = room.planHash ?? null;
      const held = planHash !== null && have.get(inst.id) === planHash;
      worlds.push({ game: inst.id, name: inst.name, kind: inst.kind, seed: inst.seed, gen: inst.gen, genCurrent: worldGenKey(inst.gen) === current, width: def.width, height: def.height, town: town ? { x: town.x, y: town.y, w: town.w, h: town.h } : null, planHash, regions: held ? null : this.regionGrid(room), dots });
    }
    const mem = process.memoryUsage();
    let inGame = 0;
    for (const c of this.clients.values()) if (c.characterId !== null) inGame++;
    return {
      health: {
        build: SERVER_BUILD,
        uptimeSeconds: Math.round((now - startedAt) / 1000),
        memoryMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        connections: this.clients.size,
        inGame,
        ...serverStats.snapshot(),
      },
      players,
      rooms,
      worlds,
    };
  }

  private roomKind(room: Room): LiveRoomKind {
    if (this.sandboxes.has(room.id)) return 'sandbox';
    switch (room.desc.kind) {
      case 'world':
        return 'world';
      case 'dungeon':
        return 'dungeon';
      case 'staging':
        return 'antechamber';
      case 'arena':
        return 'arena';
      case 'arenaGate':
        return 'arenaGate';
      default:
        return 'other';
    }
  }

  /** Worked out once per world room: the plan never changes while the room is open. */
  private readonly regionGrids = new WeakMap<Room, LiveRegionGrid | null>();

  private regionGrid(room: Room): LiveRegionGrid | null {
    const known = this.regionGrids.get(room);
    if (known !== undefined) return known;
    const plan = room.sim.zone?.plan;
    let grid: LiveRegionGrid | null = null;
    if (plan) {
      const { width, height } = room.sim.mapDef;
      // 48 columns is finer than the minimap's few hundred pixels need to show region borders.
      const cols = 48;
      const rows = Math.max(1, Math.round((cols * height) / width));
      const names: string[] = [];
      const cells: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const name = ZONES[plan.regionAt(((c + 0.5) * width) / cols, ((r + 0.5) * height) / rows)].name;
          let i = names.indexOf(name);
          if (i < 0) i = names.push(name) - 1;
          cells.push(i);
        }
      }
      grid = { cols, rows, cells, names };
    }
    this.regionGrids.set(room, grid);
    return grid;
  }

  // -------------------------------------------------------------------------------------------

  private newInstance(kind: Instance['kind'], seed: number, name: string, partyId: string | null, gen: WorldGenValues): Instance {
    const inst: Instance = { id: `i${this.nextInstanceId++}`, seed, kind, name, rooms: new Set(), partyId, memory: null, gen };
    this.instances.set(inst.id, inst);
    return inst;
  }

  /** The first public copy on the current world seed with room, or a new one. */
  private publicInstance(): Instance {
    const seed = this.current.worldSeed;
    const open = [...this.instances.values()].find((i) => i.kind === 'public' && i.seed === seed && this.membersOf(i).length < INSTANCE_CAPACITY);
    if (open) return open;
    const n = [...this.instances.values()].filter((i) => i.kind === 'public').length + 1;
    return this.newInstance('public', seed, `Public world ${n}`, null, this.publicGen(seed));
  }

  /**
   * Every public copy on a seed is the same world, so they share the numbers stored for it; a seed
   * nothing is stored for takes the numbers in force now, and keeps them from then on.
   */
  private publicGen(seed: number): WorldGenValues {
    const stored = this.store.worldGen.publicGen(seed);
    if (stored) return stored;
    const gen = currentWorldGen();
    this.store.worldGen.savePublic(seed, gen);
    return gen;
  }

  private partyInstance(party: Party): Instance | null {
    return party.instanceId === null ? null : (this.instances.get(party.instanceId) ?? null);
  }

  private worldDesc(inst: Instance): Extract<MapDescriptor, { kind: 'world' }> {
    return this.worldDescFor(inst.seed, inst.gen);
  }

  private worldDescFor(instanceSeed: number, gen: WorldGenValues): Extract<MapDescriptor, { kind: 'world' }> {
    // From the instance seed, so a world copy is the same world each time it opens.
    const seed = (Math.imul(instanceSeed + 1, 2654435761) >>> 0) % 1_000_000;
    return { kind: 'world', seed, layout: this.townLayout, ...(worldGenKey(gen) === '' ? {} : { gen }) };
  }

  private worldRoomId(inst: Instance): string {
    return `${inst.id}-world`;
  }

  private worldRoom(inst: Instance): Room {
    const id = this.worldRoomId(inst);
    const open = this.rooms.get(id);
    if (open) return open;
    const room = this.createRoom(id, this.worldDesc(inst), inst);
    if (inst.memory) restoreWorld(room.sim, inst.memory);
    return room;
  }

  private instanceOf(client: Client): Instance | null {
    return client.instanceId === null ? null : (this.instances.get(client.instanceId) ?? null);
  }

  private membersOf(inst: Instance): Client[] {
    return [...this.clients.values()].filter((c) => c.instanceId === inst.id && c.characterId !== null);
  }

  start(): void {
    this.playerReport = setInterval(() => this.reportPlayers(), PLAYER_REPORT_MINUTES * 60_000);
    this.playerReport.unref();
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
        events.warn('server', `fell behind by ${target - ticks} ticks, skipping`);
        ticks = target;
      }
      this.timer = setTimeout(loop, Math.max(0, startedAt + (ticks + 1) * SIM.tickMs - performance.now()));
    };
    loop();
  }

  private playerReport: ReturnType<typeof setInterval> | null = null;

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.playerReport) clearInterval(this.playerReport);
  }

  private readonly roomErrors = new Map<string, number>();
  /** Clients that reported a world plan mismatch already. */
  private readonly planReported = new WeakSet<Client>();

  /** Logged once per room per minute at most, so a room that throws every tick cannot flood the log. */
  private reportRoomError(room: Room, err: unknown): void {
    const now = performance.now();
    if (now - (this.roomErrors.get(room.id) ?? -Infinity) < 60_000) return;
    this.roomErrors.set(room.id, now);
    events.error('error', `[room ${room.id}] tick failed`, err);
  }

  /** One server tick for every room. Public so tests can drive the world without timers. */
  tick(): void {
    // Before the autosave, so a tick that saves everyone shows as the slow tick it is.
    const tickStart = performance.now();
    if (++this.ticksSinceSave >= AUTOSAVE_SECONDS * SIM.tickRate) {
      this.ticksSinceSave = 0;
      this.saveAll();
    }
    this.syncParties();
    for (const room of [...this.rooms.values()]) {
      const roomStart = performance.now();
      // One broken room must not stop every other room, or kill the process before anyone is saved.
      try {
        for (const { client, request } of room.tick()) this.usePortal(client, room, request);
      } catch (err) {
        this.reportRoomError(room, err);
      }
      room.tickTimes.push(performance.now() - roomStart);
      if (this.closable(room)) this.close(room);
    }
    for (const staging of this.stagings.values()) {
      if (staging.runRoomId !== null && !this.rooms.has(staging.runRoomId)) staging.runRoomId = null;
      staging.recheck();
      if (staging.tick()) this.startRun(staging);
      if (staging.target.kind === 'arena') {
        let fighting = 0;
        for (const run of this.arenaRuns.values()) if (run.gateId === staging.room.id && !run.finished) fighting += run.room.members.size;
        staging.broadcast(fighting);
        continue;
      }
      const run = staging.runRoomId === null ? undefined : this.rooms.get(staging.runRoomId);
      if (run?.sim.cleared) staging.cleared = true;
      staging.broadcast(run?.members.size ?? 0);
    }
    for (const run of [...this.arenaRuns.values()]) this.tickArena(run);
    this.tickChannels();
    if (++this.ticksSinceStatus >= PARTY_STATUS_TICKS) {
      this.ticksSinceStatus = 0;
      for (const party of this.parties.values()) this.sendPartyStatus(party);
    }
    for (const inst of [...this.instances.values()]) {
      // A public copy on the current seed is kept, empty, for its memory: deleting it would let the
      // next player open a fresh copy of the same world with every boss and chest back.
      if (inst.kind === 'public' && inst.seed === this.current.worldSeed) continue;
      if (inst.rooms.size === 0 && this.membersOf(inst).length === 0) {
        this.instances.delete(inst.id);
        const party = inst.partyId === null ? undefined : this.parties.get(inst.partyId);
        if (party?.instanceId === inst.id) {
          party.instanceId = null;
          this.sendParty(party);
        }
      }
    }
    serverStats.recordTick(performance.now() - tickStart);
  }

  /**
   * Abandoned rooms close. An antechamber stays while its dungeon run is live, so latecomers can
   * still get in. An Arena run closes as soon as it is over and empty: nobody can go back into it.
   */
  private closable(room: Room): boolean {
    if (room.members.size > 0) return false;
    const run = this.arenaRuns.get(room.id);
    if (run) return run.finished;
    if (room.emptySeconds <= WILDS.idleCloseSeconds) return false;
    return room.desc.kind !== 'staging' || this.stagings.get(room.id)?.runRoomId === null;
  }

  private close(room: Room): void {
    const inst = room.instanceId === null ? undefined : this.instances.get(room.instanceId);
    if (inst && room.id === this.worldRoomId(inst)) inst.memory = rememberWorld(room.sim);
    this.rooms.delete(room.id);
    this.stagings.delete(room.id);
    this.arenaRuns.delete(room.id);
    this.sandboxes.delete(room.id);
    if (room.instanceId !== null) this.instances.get(room.instanceId)?.rooms.delete(room.id);
  }

  /** `gate`: the gate the entrance lies behind in the world, kept on the antechamber (see Room.entranceGate). */
  private stagingFor(inst: Instance, ref: DungeonRef, gate: GateInfo | null): Room {
    const room = this.antechamber(inst, `${inst.id}-st-${ref.seed}-${ref.level}`, { kind: 'staging', seed: ref.seed, level: ref.level }, { kind: 'dungeon', ref });
    room.entranceGate ??= gate;
    return room;
  }

  /** One Arena gate per world instance; parties in the same world share the hall and its board. */
  private arenaGateFor(inst: Instance): Room {
    return this.antechamber(inst, `${inst.id}-arena-gate`, { kind: 'arenaGate' }, { kind: 'arena' });
  }

  private antechamber(inst: Instance, id: string, desc: MapDescriptor, target: StagingTarget): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const room = this.createRoom(id, desc, inst);
    this.stagings.set(room.id, new Staging(room, target));
    return room;
  }

  /** Everyone in the antechamber goes into a brand new run together. */
  private startRun(staging: Staging): void {
    const inst = staging.room.instanceId === null ? undefined : this.instances.get(staging.room.instanceId);
    if (!inst) return;
    const target = staging.target;
    if (target.kind === 'arena') {
      // A server-wide counter: the gate can close and reopen during a long run, and a per-gate count
      // starting over would reuse a live run's room id.
      const room = this.createRoom(`${inst.id}-ar-${this.nextArenaRun++}`, { kind: 'arena' }, inst);
      // Before anyone arrives, so their welcome already carries the run's rules (no pause, no dev tools).
      startArena(room.sim, partyLevel(staging.levels()));
      for (const m of [...staging.room.members.values()]) this.move(m.client, room);
      this.arenaRuns.set(room.id, new ArenaRun(room, staging.room.id));
      return;
    }
    const run = this.createRoom(`${inst.id}-dg-${target.ref.seed}-${staging.runs}`, { kind: 'dungeon', seed: target.ref.seed, level: target.ref.level, run: staging.runs++ }, inst);
    run.entranceGate = staging.room.entranceGate;
    staging.runRoomId = run.id;
    staging.cleared = false;
    // Everyone in the antechamber passed its gate check on the way in.
    for (const m of [...staging.room.members.values()]) this.move(m.client, run, undefined, true);
  }

  /** Live score to the players; at the end, the leaderboard row, the score screen, then back to the gate. */
  private tickArena(run: ArenaRun): void {
    if (run.returnIn === null) {
      if (run.over) this.finishArena(run);
      else run.broadcast();
      return;
    }
    if (--run.returnIn > 0) return;
    const gate = this.rooms.get(run.gateId) ?? this.gateForRun(run);
    if (!gate) return;
    for (const m of [...run.room.members.values()]) this.move(m.client, gate);
  }

  /** The gate closes when empty for a while, so a long run may need it opened again. */
  private gateForRun(run: ArenaRun): Room | null {
    const inst = run.room.instanceId === null ? undefined : this.instances.get(run.room.instanceId);
    return inst ? this.arenaGateFor(inst) : null;
  }

  private finishArena(run: ArenaRun): void {
    const sim = run.room.sim;
    const score = sim.arena?.score ?? 0;
    const season = seasonOf(Date.now());
    const board = boardOf(run.party.length);
    // A run that ended before the first wave is not a run anyone would want on the board.
    const recorded = sim.wave >= 1 && run.party.length > 0;
    const rank = recorded
      ? this.store.recordArenaRun({ season, names: run.party.map((p) => p.name), classes: run.party.map((p) => p.cls), score, wave: sim.wave, seconds: run.seconds, finishedAt: Date.now(), staff: run.staff })
      : null;
    const result: ArenaResult = { t: 'arenaResult', score, wave: sim.wave, seconds: run.seconds, kills: sim.arena?.kills ?? 0, party: run.party, season, board, rank, returnIn: ARENA.resultSeconds };
    run.broadcast(true);
    for (const m of run.room.members.values()) m.client.send(result);
    run.returnIn = ARENA.resultSeconds * SIM.tickRate;
    if (recorded) events.log('server', `[arena] ${run.party.map((p) => p.name).join(', ')}: ${score} points, wave ${sim.wave}, ${board} #${rank ?? '?'} in ${season}`);
  }

  connect(socket: GameSocket): void {
    const client = new Client(`c${this.nextClientId++}`, socket);
    this.clients.set(client.id, client);
    socket.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    socket.on('close', () => {
      if (client.characterId !== null) this.leaves++;
      this.channels.delete(client.id);
      const room = client.room;
      if (room) this.persist(client, room.remove(client));
      this.clients.delete(client.id);
      const inst = this.instanceOf(client);
      if (inst) this.sendWorldToAll(inst);
      const party = this.partyOf(client.accountId);
      if (party) this.sendParty(party);
    });
    socket.on('error', () => socket.close());
  }

  private onMessage(client: Client, data: unknown, isBinary: boolean): void {
    serverStats.messagesIn++;
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
    if (!msg) return;
    // A bug one client can trigger must not restart the server for everyone.
    try {
      this.handle(client, msg);
    } catch (err) {
      events.error('error', `[client ${client.id}] ${msg.t} failed`, err);
    }
  }

  private handle(client: Client, msg: ClientMessage): void {
    if (client.characterId === null && msg.t !== 'ping' && msg.t !== 'join') return;
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', clientTime: msg.clientTime });
        return;
      case 'join':
        this.join(client, msg.token, msg.characterId);
        return;
      case 'townPortal':
        this.goHome(client);
        return;
      case 'traderList':
        client.send({ t: 'trader', stock: this.market.stock });
        return;
      case 'sell':
        this.sell(client, msg.uid);
        return;
      case 'buy':
        this.buy(client, msg.id);
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
        this.useWaypoint(client, msg.waypoint);
        return;
      case 'planMismatch':
        // Once per connection: a client stuck on a split plan rejoins rooms and would repeat itself.
        if (this.planReported.has(client)) return;
        this.planReported.add(client);
        events.warn('server', `[world] plan checksum differs for ${this.playerName(client)} in ${msg.roomId}: server ${msg.server}, client ${msg.client}`);
        return;
      case 'partyTeleport':
        this.startTeleport(client, msg.name);
        return;
      case 'chat':
        this.chat(client, msg.text, msg.links ?? []);
        return;
      case 'ready': {
        const room = client.room;
        const staging = room ? this.stagings.get(room.id) : undefined;
        staging?.setReady(client, msg.ready);
        return;
      }
      case 'saveTown': {
        if (client.accountId === null) {
          client.send({ t: 'notice', text: 'Log in before saving the town' });
          return;
        }
        if (!can(client.role, 'townEdit')) {
          client.send({ t: 'notice', text: 'The town editor needs the builder role' });
          return;
        }
        const saved = this.saveTown(client.accountId, msg.layout);
        if (!saved.ok) {
          client.send({ t: 'notice', text: saved.reason === 'wait' ? 'Wait a few seconds between town saves' : 'Could not save the town on the server' });
          return;
        }
        events.log('staff', `[town] saved by ${client.accountName}`);
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
    const world = this.worldRoom(inst);
    // The town is inside the world room, so going home from out in the world is a move within it.
    this.move(client, world, client.room === world ? world.sim.playerSpawnPoint() : undefined);
    if (before && before !== inst) this.sendWorldToAll(before);
    this.sendWorldToAll(inst);
  }

  // Trader ------------------------------------------------------------------------------------

  private sell(client: Client, uid: number): void {
    const room = client.room;
    const p = room ? this.playerIn(room, client) : undefined;
    if (!room || !p) return;
    const before = snapshotForTrade(p);
    const sold = room.sell(client, uid);
    if (typeof sold === 'string') return client.send({ t: 'notice', text: sold });
    const next = [...this.market.stock, { id: this.market.nextId, item: { ...sold, uid: 0 }, price: buyPrice(sold) }];
    // Past capacity the oldest item is destroyed for good, which keeps the shelf fresh.
    const market: Market = { nextId: this.market.nextId + 1, stock: next.slice(Math.max(0, next.length - TRADER.capacity)), runeFormat: 2, runeTiers: 6 };
    if (!this.saveTrade(client, room, market, p, before)) return;
    this.system(client, `Sold ${sold.name} for ${sellPrice(sold)} gold`);
  }

  private buy(client: Client, id: number): void {
    const room = client.room;
    const p = room ? this.playerIn(room, client) : undefined;
    if (!room || !p) return;
    const entry = this.market.stock.find((e) => e.id === id);
    if (!entry) return client.send({ t: 'notice', text: 'Someone else bought that' });
    // Priced now, not when it was sold, so a shelf saved under older prices cannot be bought cheap.
    const price = buyPrice(entry.item);
    const before = snapshotForTrade(p);
    const error = room.buy(client, entry.item, price);
    if (error) return client.send({ t: 'notice', text: error });
    if (!this.saveTrade(client, room, { ...this.market, stock: this.market.stock.filter((e) => e.id !== id) }, p, before)) return;
    this.system(client, `Bought ${entry.item.name} for ${price} gold`);
  }

  /**
   * The character, the stash and the new shelf are written in one transaction, and only then does
   * the shelf in memory change. A failed write rolls the player back to `before` and keeps the old
   * shelf, so memory matches the database again: otherwise the next autosave would store the
   * player's side alone, and after a restart a bought item would exist twice, a sold one not at all.
   */
  private saveTrade(client: Client, room: Room, market: Market, p: PlayerComp, before: TradeSnapshot): boolean {
    try {
      const save = room.exportMember(client);
      if (!save || client.characterId === null || client.accountId === null) throw new Error('no character to save');
      const { character, stash } = splitStash(save);
      this.store.saveCharacterAndStash(client.characterId, character, client.accountId, stash, market);
    } catch (err) {
      rollBackTrade(p, before);
      events.error('save', `[trader] trade by ${client.accountName ?? client.id} not saved; rolled back`, err);
      client.send({ t: 'notice', text: 'The trade could not be saved, so nothing changed' });
      return false;
    }
    this.market = market;
    for (const c of this.clients.values()) if (c.room?.sim.mapDef.trader) c.send({ t: 'trader', stock: this.market.stock });
    return true;
  }

  private playerIn(room: Room, client: Client): PlayerComp | undefined {
    const m = room.members.get(client.id);
    return m ? room.sim.world.player.get(m.playerId) : undefined;
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
    // Straight away, so a new member's frames do not wait for the next round.
    this.sendPartyStatus(party);
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
      party = { id: `p${this.nextPartyId++}`, leader: me, members: new Map([[me, this.playerName(client)]]), seen: new Map(), instanceId: null };
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
    if (there && there !== this.instanceOf(client) && this.membersOf(there).length < INSTANCE_HARD_CAP) this.enterInstance(client, there);
  }

  private partyLeave(client: Client): void {
    const me = client.accountId;
    const party = this.partyOf(me);
    if (me === null || !party) return this.system(client, 'You are not in a party');
    const inPartyWorld = this.instanceOf(client)?.partyId === party.id;
    party.members.delete(me);
    party.seen.delete(me);
    this.cancelTeleport(client, null);
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
      world = this.newInstance('party', seed, `${party.members.get(party.leader) ?? 'Party'}'s party world`, party.id, currentWorldGen());
      party.instanceId = world.id;
      for (const c of this.onlineMembers(party)) this.enterInstance(c, world);
      this.sendParty(party);
      return;
    }
    if (this.instanceOf(client) === world) return this.system(client, 'You are already in the party world');
    this.enterInstance(client, world);
  }

  /**
   * Saves a layout that already passed `validateLayout` and rebuilds every world room around it; the
   * town editor and `PUT /api/admin/town` both come through here, so they share the cooldown. It is
   * per account, since every save rebuilds the world room of every world copy.
   */
  saveTown(accountId: number, layout: TownLayout): TownSaveResult {
    const now = Date.now();
    const last = this.lastTownSave.get(accountId);
    if (last !== undefined && now - last < TOWN_SAVE_COOLDOWN_MS) return { ok: false, reason: 'wait' };
    // Old entries go, so the map holds only accounts inside their cooldown.
    for (const [id, at] of this.lastTownSave) if (now - at >= TOWN_SAVE_COOLDOWN_MS) this.lastTownSave.delete(id);
    this.lastTownSave.set(accountId, now);
    try {
      saveTownLayout(layout);
    } catch (err) {
      events.error('error', 'saving the town layout failed', err);
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, ...this.replaceTown(layout) };
  }

  /**
   * Rebuilds every world with the new town and carries everyone inside over, each to where they
   * stood (on open ground nearby), with the loot on the ground and the opened chests. The world's
   * roads start at the town's gates, so a town whose gates moved gets a new world around it, with
   * fresh monsters.
   */
  private replaceTown(layout: TownLayout): { rooms: number; players: number } {
    this.townLayout = layout;
    let rooms = 0;
    let players = 0;
    for (const inst of this.instances.values()) {
      const old = this.rooms.get(this.worldRoomId(inst));
      if (!old) continue;
      this.close(old);
      const next = this.worldRoom(inst);
      // What lies on the ground and which chests were opened stay as they were; only the town changed.
      // Gate and region boss timers and opened chests came over through the instance's memory, which
      // `close` took and `worldRoom` restored.
      players += this.carryInto(old, next);
      rooms++;
    }
    return { rooms, players };
  }

  /**
   * Everyone in a world room that was just closed goes into its rebuilt room, each to where they
   * stood on open ground, with the loot on the ground. A spot the new map lacks (a smaller world) or
   * cannot reach from the town (inside a new ridge) gives the town spawn instead.
   */
  private carryInto(old: Room, next: Room): number {
    // A world of another size centres the town elsewhere: everything moves with it, so whoever stood
    // at the stash still does, and what lay in town still lies there.
    const from = old.sim.mapDef.townAt ?? { x: 0, y: 0 };
    const to = next.sim.mapDef.townAt ?? { x: 0, y: 0 };
    const shift = { x: to.x - from.x, y: to.y - from.y };
    carryGroundLoot(old.sim, next.sim, shift);
    const { width, height } = next.sim.mapDef;
    const zone = next.sim.zone;
    let players = 0;
    for (const m of [...old.members.values()]) {
      const was = old.playerState(m.client);
      const save = old.remove(m.client);
      if (!save) continue;
      const at = was ? { x: was.x + shift.x, y: was.y + shift.y } : null;
      const inside = at && at.x > 0 && at.y > 0 && at.x < width && at.y < height;
      const open = at && inside ? next.sim.map.findOpen(at.x, at.y, SIM.playerRadius + 6) : null;
      const spot = open && (!zone || zone.reachable(open.x, open.y)) ? open : undefined;
      next.add(m.client, save.classId, save.name, save, spot);
      // The new world's seals may lie elsewhere: someone left standing behind one goes back out.
      this.keepOutOfSeal(m.client, next);
      players++;
    }
    return players;
  }

  /** A per-account cooldown shared by forced rebuilds and rerolls, as town saves have one. */
  private rebuildAllowed(accountId: number): boolean {
    const now = Date.now();
    const last = this.lastRebuild.get(accountId);
    if (last !== undefined && now - last < TOWN_SAVE_COOLDOWN_MS) return false;
    for (const [id, at] of this.lastRebuild) if (now - at >= TOWN_SAVE_COOLDOWN_MS) this.lastRebuild.delete(id);
    this.lastRebuild.set(accountId, now);
    return true;
  }

  /**
   * The copies one admin action acts on: every copy, or the one named; a public copy brings every
   * public copy on its seed, since they are one world and share its stored numbers.
   */
  private rebuildTargets(game: string | null): Instance[] | string {
    if (game === null) return [...this.instances.values()];
    const inst = this.instances.get(game);
    if (!inst) return 'No such world copy';
    return inst.kind === 'public' ? [...this.instances.values()].filter((i) => i.kind === 'public' && i.seed === inst.seed) : [inst];
  }

  private rebuildEach(targets: readonly Instance[], seed: (inst: Instance) => number, gen: WorldGenValues): WorldRebuildResult {
    const copies: WorldRebuildCopy[] = [];
    const failed: WorldRebuildFailure[] = [];
    for (const inst of targets) {
      const r = this.rebuildCopy(inst, seed(inst), gen);
      if ('reason' in r) failed.push(r);
      else copies.push(r);
    }
    return { copies, failed, gen };
  }

  /**
   * Force rebuild (admin): world copies take the generation numbers in force now and their open world
   * rooms are rebuilt at once, as a town save does. A copy whose ground moves forgets its dead bosses
   * and opened chests, since they belonged to spots and chunks of the old plan; one whose ground is
   * the same keeps them. `game` null rebuilds every copy. A copy that fails is reported and left as it
   * was; the others go on.
   */
  rebuildWorlds(accountId: number, game: string | null): WorldRebuildResult | string {
    const targets = this.rebuildTargets(game);
    if (typeof targets === 'string') return targets;
    if (!this.rebuildAllowed(accountId)) return 'wait';
    const gen = currentWorldGen();
    const result = this.rebuildEach(targets, (inst) => inst.seed, gen);
    const done = new Set(result.copies.map((c) => c.game));
    for (const seed of new Set(targets.filter((i) => i.kind === 'public' && done.has(i.id)).map((i) => i.seed))) this.store.worldGen.savePublic(seed, gen);
    return result;
  }

  /**
   * A new seed for a world copy (random, or `seed` to pin one). The public world is one world on the
   * `worldSeed` setting, so rerolling a public copy sets the setting and moves every public copy on
   * the old seed to the new one. One seed is one world: a public seed another copy is on, or that
   * numbers are stored for, keeps its numbers; any other takes the numbers in force now.
   */
  rerollWorld(accountId: number, game: string, seed: number | null): WorldRebuildResult | string {
    const targets = this.rebuildTargets(game);
    if (typeof targets === 'string') return targets;
    if (!this.rebuildAllowed(accountId)) return 'wait';
    const next = seed ?? (Math.imul(this.seedCounter++, 2654435761) >>> 0) % (SETTINGS_LIMITS.seedMax + 1);
    const isPublic = targets.some((i) => i.kind === 'public');
    const sharing = isPublic ? [...this.instances.values()].find((i) => i.kind === 'public' && i.seed === next && !targets.includes(i)) : undefined;
    const gen = sharing?.gen ?? (isPublic ? this.store.worldGen.publicGen(next) : null) ?? currentWorldGen();
    const result = this.rebuildEach(targets, () => next, gen);
    // Only once a copy is on the new seed, so a build that failed everywhere changes nothing stored.
    if (isPublic && result.copies.length > 0) {
      this.store.worldGen.savePublic(next, gen);
      this.updateSettings({ worldSeed: next });
    }
    return result;
  }

  /** When each world copy was last rebuilt or rerolled: a rebuild that moves the ground fills its chests again. */
  private readonly copyRebuiltAt = new Map<string, number>();

  /**
   * One copy onto `seed` and `gen`. The new room is built before anything changes, so a build that
   * throws leaves the copy as it was; the memory is kept when the ground it is keyed by (roads,
   * gates, chest and boss spots, `ZoneWorld.memoryLayout`) is the same.
   */
  private rebuildCopy(inst: Instance, seed: number, gen: WorldGenValues): WorldRebuildCopy | WorldRebuildFailure {
    const fail = (reason: string): WorldRebuildFailure => ({ game: inst.id, name: inst.name, reason });
    const now = Date.now();
    const last = this.copyRebuiltAt.get(inst.id);
    if (last !== undefined && now - last < COPY_REBUILD_COOLDOWN_MS) return fail(`rebuilt ${Math.round((now - last) / 1000)} s ago; a copy can be rebuilt once a minute`);
    const id = this.worldRoomId(inst);
    const old = this.rooms.get(id);
    const desc = this.worldDescFor(seed, gen);
    let next: Room | null = null;
    let planChanged: boolean;
    try {
      const before = old ? old.sim.zone?.memoryLayout() : loadMap(this.worldDesc(inst)).zone?.memoryLayout();
      if (old) next = this.buildRoom(id, desc, inst);
      const after = next ? next.sim.zone?.memoryLayout() : loadMap(desc).zone?.memoryLayout();
      planChanged = before !== after;
    } catch (err) {
      events.error('error', `[world] rebuilding ${inst.name} (${inst.id}) on seed ${seed} failed; it is left as it was`, err);
      return fail('the build failed; see the server log');
    }
    this.copyRebuiltAt.set(inst.id, now);
    for (const [k, at] of this.copyRebuiltAt) if (now - at >= COPY_REBUILD_COOLDOWN_MS) this.copyRebuiltAt.delete(k);
    inst.seed = seed;
    inst.gen = gen;
    const result = (open: boolean, players: number): WorldRebuildCopy => ({ game: inst.id, name: inst.name, seed, open, players, planChanged });
    if (!old || !next) {
      if (planChanged) inst.memory = null;
      return result(false, 0);
    }
    // `close` keeps the room's memory on the copy; it belongs to the old ground if that moved.
    this.close(old);
    if (planChanged) inst.memory = null;
    else if (inst.memory) restoreWorld(next.sim, inst.memory);
    this.register(next, inst);
    const players = this.carryInto(old, next);
    const text = planChanged ? 'An admin rebuilt this world: new ground, its bosses and chests are back' : 'An admin rebuilt this world: fresh monsters, bosses and chests as they were';
    for (const m of next.members.values()) this.system(m.client, text);
    events.log('server', `[world] ${inst.name} rebuilt on seed ${seed}${planChanged ? ', its ground moved: dead bosses and opened chests forgotten' : ''}; ${players} players carried over`);
    return result(true, players);
  }

  private usePortal(client: Client, from: Room, request: PortalRequest): void {
    const inst = this.instanceOf(client);
    switch (request.target) {
      case 'town':
        this.goHome(client);
        return;
      case 'arena':
        if (inst) this.move(client, this.arenaGateFor(inst));
        return;
      case 'waypoint': {
        const state = from.playerState(client);
        const current = request.portal.waypoint;
        if (!state || !current) return;
        const known = new Set((from.sim.mapDef.waypoints ?? []).map((w) => w.id));
        client.send({ t: 'waypoints', current, unlocked: [TOWN_WAYPOINT, ...state.waypoints.filter((w) => w !== TOWN_WAYPOINT && known.has(w))] });
        return;
      }
      case 'staging': {
        const portal = request.portal;
        if (!inst || !portal.dungeon) return;
        const gateId = from.sim.zone?.plan?.gateAt(portal.x, portal.y) ?? null;
        const gate = gateId === null ? null : (from.sim.mapDef.gates?.find((g) => g.id === gateId) ?? null);
        // Only someone carried past the seal (an admin's goto, the dev teleport) stands here without the gate.
        if (gate && !(from.playerState(client)?.gates.includes(gate.id) ?? false)) {
          client.send({ t: 'notice', text: `The ${gate.name} is sealed to you: slay its guardian first` });
          return;
        }
        this.move(client, this.stagingFor(inst, portal.dungeon, gate));
        return;
      }
      case 'dungeon': {
        const staging = this.stagings.get(from.id);
        if (staging?.target.kind === 'arena') {
          client.send({ t: 'notice', text: 'The pit opens when everyone here is ready (R)' });
          return;
        }
        const run = staging?.runRoomId ? this.rooms.get(staging.runRoomId) : undefined;
        if (run) this.move(client, run);
        else client.send({ t: 'notice', text: 'The gate is sealed until everyone here is ready (R)' });
        return;
      }
      case 'wilds': {
        // Out of a dungeon or its antechamber: back beside its entrance in this world copy's world.
        if (!inst) return this.goHome(client);
        const world = this.worldRoom(inst);
        const seed = from.desc.kind === 'staging' || from.desc.kind === 'dungeon' ? from.desc.seed : null;
        this.move(client, world, (seed === null ? null : entranceArrival(world.sim.mapDef, world.sim.map, seed)) ?? undefined);
      }
    }
  }

  private system(client: Client, text: string): void {
    client.send({ t: 'chat', kind: 'system', from: '', to: null, text });
  }

  /**
   * Item links resolve only against the sender's own items: every item the character holds (bag,
   * stash, equipment, the skill bar and pending) is in its item map, and inscribed runes live inside
   * their sigil. Another player's uid simply is not found, so links cannot be used to look at
   * anyone else's items.
   */
  private ownItem(client: Client): (uid: ItemUid) => Item | undefined {
    const room = client.room;
    const member = room?.members.get(client.id);
    const p = room && member ? room.sim.world.player.get(member.playerId) : undefined;
    return (uid) => {
      if (!p) return undefined;
      const direct = p.items.get(uid);
      if (direct) return direct;
      for (const it of p.items.values()) {
        if (it.kind !== 'sigil') continue;
        const rune = it.slots.find((r) => r.uid === uid);
        if (rune) return rune;
      }
      return undefined;
    };
  }

  /** Game chat plus a few D2-style commands. Rate limited so one player cannot flood a game. */
  private chat(client: Client, raw: string, links: readonly ItemUid[]): void {
    const now = performance.now();
    client.chatTimes = client.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (client.chatTimes.length >= CHAT_PER_WINDOW) {
      this.system(client, 'You are sending messages too quickly');
      return;
    }
    client.chatTimes.push(now);
    // Resolved before commands are read, so every token left in the text is a link the server made.
    const { text, items: linked } = resolveChatLinks(raw, links, this.ownItem(client));
    const items = linked.length > 0 ? { items: linked } : {};
    if (!text) return;
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
            const msg: ServerMessage = { t: 'chat', kind: 'whisper', from, to: this.playerName(target), text: body, ...items };
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
          else if (body) for (const c of this.onlineMembers(party)) c.send({ t: 'chat', kind: 'party', from, to: null, text: body, ...items });
          return;
        }
        case 'sandbox':
          if (!can(client.role, 'devTools')) {
            this.system(client, 'Unknown command /sandbox. Try /help');
            return;
          }
          this.toggleSandbox(client);
          return;
        case 'help':
          this.system(client, `Enter chats to your world. /p message to your party, /w name message whispers, /invite name, /accept, /decline, /leave, /who.${can(client.role, 'devTools') ? ' /sandbox opens or leaves your private test room.' : ''}`);
          return;
        default:
          this.system(client, `Unknown command /${cmd}. Try /help`);
          return;
      }
    }
    const inst = this.instanceOf(client);
    const to = inst ? this.membersOf(inst) : [client];
    for (const c of to) c.send({ t: 'chat', kind: 'game', from, to: null, text, ...items });
  }

  /**
   * A builder's private test room: the flat map with the free bench and dev tools. Waves are off,
   * so it is not a private farm; builders spawn what they want to test. Saved like anywhere else.
   */
  private toggleSandbox(client: Client): void {
    const room = client.room;
    if (room && this.sandboxes.has(room.id)) {
      this.goHome(client);
      return;
    }
    const inst = this.instanceOf(client);
    if (!inst || client.accountId === null) return;
    const id = `${inst.id}-sb-${client.accountId}`;
    const sandbox = this.rooms.get(id) ?? this.createRoom(id, { kind: 'flat' }, inst, { bench: true, waves: false });
    this.sandboxes.add(sandbox.id);
    this.move(client, sandbox);
    this.system(client, 'Your sandbox: free inscriptions and F3 dev tools. /sandbox or the town portal takes you back.');
  }

  /**
   * Checked on the server: standing on a waypoint, the destination unlocked by this character and in
   * this world. Inside the world room it is a teleport; from anywhere else it carries the character in.
   */
  private useWaypoint(client: Client, id: string): void {
    const room = client.room;
    const inst = this.instanceOf(client);
    const state = room?.playerState(client);
    if (!room || !inst || !state) return;
    const near = room.sim.mapDef.portals.some((p) => p.target === 'waypoint' && Math.hypot(p.x - state.x, p.y - state.y) <= p.r + WAYPOINT_REACH);
    if (!near) {
      client.send({ t: 'notice', text: 'Stand on a waypoint to travel' });
      return;
    }
    if (id !== TOWN_WAYPOINT && !state.waypoints.includes(id)) {
      client.send({ t: 'notice', text: 'You have not found that waypoint yet' });
      return;
    }
    const world = this.worldRoom(inst);
    // Found before its gate was this character's to pass (an old save, an admin's goto): still sealed.
    const behind = world.sim.mapDef.waypoints?.find((w) => w.id === id)?.behind ?? null;
    if (behind && !state.gates.includes(behind)) {
      const gate = world.sim.mapDef.gates?.find((g) => g.id === behind);
      client.send({ t: 'notice', text: `The ${gate?.name ?? 'gate'} is sealed to you: slay its guardian first` });
      return;
    }
    const at = waypointArrival(world.sim.mapDef, world.sim.map, id);
    if (!at) {
      client.send({ t: 'notice', text: 'That waypoint is not in this world' });
      return;
    }
    this.move(client, world, at);
  }

  /**
   * Every placement of a player goes through here: within the room (onto open ground near `at`), or
   * carried with the character (class, name, items, equipment) from the current room into `to`.
   *
   * The gate seals hold for every placement, whatever moved the player, except an `unchecked` one (an
   * admin's goto, or from an antechamber into its own dungeon run, checked on the way in): a dungeon or antechamber whose entrance lies behind a gate sealed to the player is
   * refused, and a spot in the world behind one becomes the town side of that gate (`keepOutOfSeal`).
   * Walking through the gate after its boss is the only way past it.
   */
  private move(client: Client, to: Room, at?: Vec2, unchecked = false): boolean {
    const from = client.room;
    if (!from) return false;
    if (!unchecked && to.entranceGate && !(from.playerState(client)?.gates.includes(to.entranceGate.id) ?? false)) return false;
    if (from === to) {
      if (at) to.placeMember(client, at.x, at.y);
    } else {
      const carried = from.remove(client);
      if (!carried) return false;
      this.persist(client, carried);
      to.add(client, carried.classId, carried.name, carried, at);
    }
    if (!unchecked) this.keepOutOfSeal(client, to);
    return true;
  }

  /** The gate a spot of the room lies behind that these gates do not open, or null. Only the world has seals. */
  private sealedAt(room: Room, x: number, y: number, gates: readonly string[]): string | null {
    const gate = room.sim.zone?.plan?.gateAt(x, y) ?? null;
    return gate === null || gates.includes(gate) ? null : gate;
  }

  /**
   * Checked where the player actually stands after a placement, so the open-ground search that moved
   * them a few units cannot cross a seal either. Behind a gate sealed to them, they go to the road on
   * the town side of it, or to the town if that spot is no good.
   */
  private keepOutOfSeal(client: Client, room: Room): void {
    const state = room.playerState(client);
    if (!state) return;
    const gate = this.sealedAt(room, state.x, state.y, state.gates);
    if (gate === null) return;
    const g = room.sim.mapDef.gates?.find((x) => x.id === gate);
    const back = g ? room.sim.map.findOpen(g.x - Math.cos(g.angle) * GATES.returnBack, g.y - Math.sin(g.angle) * GATES.returnBack, 20) : null;
    const safe = back && this.sealedAt(room, back.x, back.y, state.gates) === null ? back : room.sim.playerSpawnPoint();
    room.placeMember(client, safe.x, safe.y);
    const after = room.playerState(client);
    // Belt and braces: the town spawn is never sealed, so this only fires if `findOpen` strayed.
    if (after && this.sealedAt(room, after.x, after.y, after.gates) !== null) {
      const spawn = room.sim.playerSpawnPoint();
      room.placeMember(client, spawn.x, spawn.y);
    }
    events.log('server', `[world] ${this.playerName(client)} placed behind the ${g?.name ?? gate}, sealed to them; moved to the town side`);
  }

  // Party frames and teleport ----------------------------------------------------------------

  private placeOf(room: Room, x: number, y: number): PartyPlace {
    if (this.arenaRuns.has(room.id) || room.desc.kind === 'arenaGate' || room.desc.kind === 'arena') return 'arena';
    if (this.sandboxes.has(room.id)) return 'sandbox';
    if (room.desc.kind === 'staging' || room.desc.kind === 'dungeon') return 'dungeon';
    if (room.desc.kind === 'town' || (room.desc.kind === 'world' && room.inSafeZone(x, y))) return 'town';
    return 'wilds';
  }

  /**
   * Why `client` may not teleport to the party member `targetAccount` right now, or null when it
   * would go. Checked when the channel starts, again when it ends, and for the frames' hints.
   */
  private teleportRefusal(client: Client, party: Party, targetAccount: number, online: ReadonlyMap<number, Client>): string | null {
    const name = party.members.get(targetAccount) ?? 'That player';
    if (targetAccount === client.accountId) return 'That is you';
    if (!party.members.has(targetAccount)) return `${name} is not in your party`;
    const target = online.get(targetAccount);
    if (!target) return `${name} is offline`;
    const here = client.room;
    const me = here?.memberView(client);
    if (!here || !me) return 'Try again in a moment';
    if (me.dead) return 'You cannot teleport while dead';
    // A scored run is left by town portal or by dying, never by walking out halfway.
    if (this.arenaRuns.has(here.id)) return 'You cannot teleport out of an Arena run';
    const room = target.room;
    if (!room || !room.memberView(target)) return `${name} is between areas, try again`;
    // A run takes nobody who was not there at the start.
    if (this.arenaRuns.has(room.id)) return `${name} is in an Arena run`;
    if (this.sandboxes.has(room.id)) return `${name} is in a private sandbox`;
    // Dropping into strangers' dungeon run would skip their gate; only a run the party has to itself.
    if (room.desc.kind === 'dungeon' && [...room.members.values()].some((m) => m.client.accountId === null || !party.members.has(m.client.accountId))) {
      return `${name} is in a dungeon run with players outside your party`;
    }
    // Past a gate this character has not opened, a teleport would skip its boss; walking is the way in.
    const gate = this.gateBehind(target, room);
    if (gate && !(here.playerState(client)?.gates.includes(gate.id) ?? false)) return `${name} is past the ${gate.name}, which is sealed to you`;
    if (target.instanceId !== client.instanceId) {
      const inst = this.instanceOf(target);
      if (!inst) return `${name} is between areas, try again`;
      // A copy left behind by a party that broke up is nobody's any more, so only a live party's world is closed.
      if (inst.kind === 'party' && inst.partyId !== null && inst.partyId !== party.id) return `${name} is in another party's world`;
      // Party members always fit: the soft capacity only turns strangers away.
      if (this.membersOf(inst).length >= INSTANCE_HARD_CAP) return `${name}'s world is full`;
    }
    return null;
  }

  /**
   * The gate a player stands behind: in the world room by its own plan, in a dungeon or its
   * antechamber the gate its entrance lies behind, kept on the room when it opened, so the answer
   * never depends on the world room being open. Null anywhere else.
   */
  private gateBehind(target: Client, room: Room): GateInfo | null {
    if (room.entranceGate) return room.entranceGate;
    const at = room.playerState(target);
    const id = at ? (room.sim.zone?.plan?.gateAt(at.x, at.y) ?? null) : null;
    return id === null ? null : (room.sim.mapDef.gates?.find((g) => g.id === id) ?? null);
  }

  /**
   * Tells every room's simulation which party each player is in, since kill XP is shared only
   * inside the killer's party. Every tick rather than on each change, so a room change, a join or
   * a leave can never leave a stale party behind; it is one map lookup per player.
   */
  private syncParties(): void {
    const partyByAccount = new Map<number, string>();
    for (const party of this.parties.values()) for (const acc of party.members.keys()) partyByAccount.set(acc, party.id);
    for (const c of this.clients.values()) {
      if (c.accountId !== null) c.room?.setParty(c, partyByAccount.get(c.accountId) ?? null);
    }
  }

  private onlineByAccount(): Map<number, Client> {
    const out = new Map<number, Client>();
    for (const c of this.clients.values()) if (c.accountId !== null && c.characterId !== null) out.set(c.accountId, c);
    return out;
  }

  /** One small message per online member: everyone else in the party, where they are and whether a teleport would go. */
  private sendPartyStatus(party: Party): void {
    const online = this.onlineByAccount();
    const views = new Map<number, { client: Client | null; status: PartyMemberStatus; x: number; y: number }>();
    for (const [acc, name] of party.members) {
      const client = online.get(acc) ?? null;
      const room = client?.room ?? null;
      const v = client && room ? room.memberView(client) : null;
      if (!room || !v) {
        // Offline, or online but between rooms for this one tick.
        const seen = party.seen.get(acc);
        views.set(acc, { client, status: { name, cls: seen?.cls ?? null, level: seen?.level ?? 0, life: 0, maxLife: 0, dead: false, place: client ? 'wilds' : 'offline', zone: '' }, x: 0, y: 0 });
        continue;
      }
      party.seen.set(acc, { cls: v.cls, level: v.level });
      const status: PartyMemberStatus = { name, cls: v.cls, level: v.level, life: Math.ceil(v.life), maxLife: Math.round(v.maxLife), dead: v.dead, place: this.placeOf(room, v.x, v.y), zone: room.placeName(v.x, v.y) };
      views.set(acc, { client, status, x: Math.round(v.x), y: Math.round(v.y) });
    }
    for (const [acc, me] of views) {
      const receiver = me.client;
      if (!receiver) continue;
      const members: PartyMemberStatus[] = [];
      for (const [other, view] of views) {
        if (other === acc) continue;
        const status: PartyMemberStatus = { ...view.status };
        if (view.client?.room && view.client.room === receiver.room) {
          status.x = view.x;
          status.y = view.y;
        }
        const no = this.teleportRefusal(receiver, party, other, online);
        if (no) status.no = no;
        members.push(status);
      }
      receiver.send({ t: 'partyStatus', members });
    }
  }

  private watch(client: Client): ChannelWatch | null {
    const room = client.room;
    const v = room?.memberView(client);
    return room && v ? { roomId: room.id, x: v.x, y: v.y, life: v.life, castCooldown: v.castCooldown, dashing: v.dashing, dead: v.dead } : null;
  }

  /** Free and without a cooldown; the channel is the price. The client only asks. */
  private startTeleport(client: Client, name: string): void {
    const party = this.partyOf(client.accountId);
    if (!party) return client.send({ t: 'notice', text: 'You are not in a party' });
    const wanted = name.trim().toLowerCase();
    const targetAccount = [...party.members].find(([, n]) => n.toLowerCase() === wanted)?.[0];
    if (targetAccount === undefined) return client.send({ t: 'notice', text: `${name} is not in your party` });
    const refusal = this.teleportRefusal(client, party, targetAccount, this.onlineByAccount());
    const start = this.watch(client);
    if (refusal || !start) return client.send({ t: 'notice', text: refusal ?? 'Try again in a moment' });
    const targetName = party.members.get(targetAccount) ?? name;
    this.channels.set(client.id, { targetAccount, targetName, ticksLeft: TELEPORT_CHANNEL_SECONDS * SIM.tickRate, start, last: start });
    client.send({ t: 'teleportChannel', to: targetName, seconds: TELEPORT_CHANNEL_SECONDS });
  }

  private cancelTeleport(client: Client, reason: string | null): void {
    if (!this.channels.delete(client.id)) return;
    client.send({ t: 'teleportChannel', to: null, reason });
  }

  /** After the rooms stepped, so this tick's movement, hits and casts already show. */
  private tickChannels(): void {
    if (this.channels.size === 0) return;
    for (const [id, ch] of [...this.channels]) {
      const client = this.clients.get(id);
      if (!client) {
        this.channels.delete(id);
        continue;
      }
      const now = this.watch(client);
      const broke = channelBreak(ch.start, ch.last, now);
      if (broke || !now) {
        this.cancelTeleport(client, broke);
        continue;
      }
      ch.last = now;
      if (--ch.ticksLeft > 0) continue;
      // The target may have walked into an Arena run or logged off during the channel.
      const party = this.partyOf(client.accountId);
      const online = this.onlineByAccount();
      const target = online.get(ch.targetAccount);
      const refusal = !party ? 'You are not in a party' : this.teleportRefusal(client, party, ch.targetAccount, online);
      if (refusal || !target) {
        this.cancelTeleport(client, refusal ?? `${ch.targetName} is offline`);
        continue;
      }
      const error = this.travelTo(client, target);
      this.cancelTeleport(client, error);
      if (party && !error) this.sendPartyStatus(party);
    }
  }

  private join(client: Client, token: string, characterId: number): void {
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
    client.joinedAt = Date.now();
    // Back into the party's world if it is still running and has room, otherwise the public world.
    const party = this.partyOf(account.id);
    if (party) party.members.set(account.id, character.name);
    const partyWorld = party ? this.partyInstance(party) : null;
    const inst = partyWorld && this.membersOf(partyWorld).length < INSTANCE_CAPACITY ? partyWorld : this.publicInstance();
    client.instanceId = inst.id;
    const room = this.worldRoom(inst);
    const stash = this.store.loadStash(account.id);
    if (stash === 'unreadable') {
      // Joining would save an empty stash over it; leave the row alone for a human to look at.
      events.error('save', `account ${account.id} has an unreadable stash; the join is refused and the row kept`);
      this.endSession(client, 'Your stash could not be loaded. Nothing was lost; ask the server owner to look at it.');
      return;
    }
    // Before the welcome, so the first snapshot already draws overridden monsters with their models.
    client.send(this.tuning.modelsMessage());
    room.add(client, character.classId, character.name, character.save ?? undefined);
    this.keepOutOfSeal(client, room);
    if (stash) {
      // Gold for Linger and Pierce runes in a v1 stash; saved together with the converted stash, so paid once.
      if (stash.refundGold > 0) {
        const m = room.members.get(client.id);
        const p = m ? room.sim.world.player.get(m.playerId) : undefined;
        if (p) p.gold += stash.refundGold;
      }
      room.loadStash(client, stash.stash);
    }
    const waiting = room.pendingCount(client);
    if (waiting > 0) this.system(client, `${waiting} item${waiting === 1 ? '' : 's'} did not fit in your bag or stash. Make room in the stash and log in again to get them back.`);
    // A brand new character gets its starter kit on first entry; store it right away.
    if (!character.save) this.persist(client, room.exportMember(client));
    if (this.current.motd) this.system(client, this.current.motd);
    this.sendWorldToAll(inst);
    if (party) this.sendParty(party);
    client.send({ t: 'lighting', lighting: this.lighting() });
    client.send({ t: 'zoom', zoom: this.zoom() });
    this.joins++;
  }

  private joins = 0;
  private leaves = 0;

  /** Counts rather than a line per join, so a busy evening does not push everything else out of the log. */
  private reportPlayers(): void {
    if (this.joins === 0 && this.leaves === 0) return;
    const online = [...this.clients.values()].filter((c) => c.characterId !== null).length;
    events.log('players', `[players] ${this.joins} joined, ${this.leaves} left in the last ${PLAYER_REPORT_MINUTES} min; ${online} online`);
    this.joins = 0;
    this.leaves = 0;
  }


  private persist(client: Client, save: PlayerSave | null): void {
    if (!save || client.characterId === null || client.accountId === null) return;
    // The stash belongs to the account, so every character sees the same one. Both rows are written
    // together, or an item moved between bag and stash could land in neither.
    const { character, stash } = splitStash(save);
    this.store.saveCharacterAndStash(client.characterId, character, client.accountId, stash);
  }

  saveAll(): void {
    const saves: CharacterSaveRow[] = [];
    for (const room of this.rooms.values()) {
      for (const m of room.members.values()) {
        // One broken room or save must not cost everyone else theirs, least of all in the crash handler.
        try {
          const save = room.exportMember(m.client);
          const { characterId, accountId } = m.client;
          if (!save || characterId === null || accountId === null) continue;
          const { character, stash } = splitStash(save);
          saves.push({ characterId, save: character, accountId, stash });
        } catch (err) {
          events.error('error', `[room ${room.id}] could not export ${m.client.accountName ?? m.client.id} for saving`, err);
        }
      }
    }
    this.store.saveMany(saves);
  }

  /** Saves, removes and disconnects. Used for duplicate logins and deleted characters. */
  endSession(client: Client, reason: string): void {
    if (client.characterId !== null) this.leaves++;
    const room = client.room;
    if (room) this.persist(client, room.remove(client));
    client.characterId = null;
    client.accountId = null;
    client.send({ t: 'sessionEnded', reason });
    client.socket.close(4001, 'session ended');
  }

  endCharacterSession(characterId: number): void {
    for (const c of this.clients.values()) if (c.characterId === characterId) this.endSession(c, 'That character was deleted');
  }
}
