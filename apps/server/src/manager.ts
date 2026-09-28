import { jsonCodec, parseClientMessage, SIM, WILDS, type ClientMessage, type DungeonRef, type PlayerSave, type PortalRequest } from '@rune/shared';
import type { WebSocket } from 'ws';
import type { AccountStore } from './accounts.js';
import { Client, MAX_MESSAGES_PER_SECOND } from './client.js';
import { Room, roomIdFor } from './room.js';
import { Staging } from './staging.js';
import { loadTownLayout, saveTownLayout, townEditorEnabled } from './townStore.js';

/** Encounter sandbox and other dev commands. Off unless explicitly enabled. */
const devToolsEnabled = process.env.DEV_TOOLS === '1';

/** Bounds what a crash can lose; room changes and disconnects save straight away. */
const AUTOSAVE_SECONDS = 30;

/**
 * Owns every room and every connection. Town and arena are permanent; Wilds instances are created
 * on demand, each with a fresh seed and therefore its own layout, and closed once abandoned.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<string, Client>();
  /** Ready-check state per antechamber, keyed by the staging room id. */
  private readonly stagings = new Map<string, Staging>();
  private town: Room;
  private readonly arena: Room;
  private nextClientId = 1;
  private seedCounter: number;
  private timer: NodeJS.Timeout | null = null;
  private ticksSinceSave = 0;

  constructor(
    seed: number,
    private readonly store: AccountStore,
  ) {
    this.seedCounter = seed;
    this.town = this.createRoom({ kind: 'town', layout: loadTownLayout() });
    this.town.townEditor = townEditorEnabled;
    this.arena = this.createRoom({ kind: 'arena' });
  }

  private createRoom(desc: Room['desc']): Room {
    const room = new Room(roomIdFor(desc), desc, this.seedCounter++);
    room.devTools = devToolsEnabled;
    this.rooms.set(room.id, room);
    return room;
  }

  private newWilds(seed: number | null = null): Room {
    // Random seeds only need to differ between instances; a mixed counter keeps layouts varied.
    const s = seed ?? (Math.imul(this.seedCounter++, 2654435761) >>> 0) % 1_000_000;
    const existing = this.rooms.get(roomIdFor({ kind: 'wilds', seed: s }));
    return existing ?? this.createRoom({ kind: 'wilds', seed: s });
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
      for (const { client, request } of room.tick()) this.usePortal(client, request);
      if (this.closable(room)) this.close(room);
    }
    for (const staging of this.stagings.values()) {
      if (staging.runRoomId !== null && !this.rooms.has(staging.runRoomId)) staging.runRoomId = null;
      staging.recheck();
      if (staging.tick()) this.startRun(staging);
      const run = staging.runRoomId === null ? undefined : this.rooms.get(staging.runRoomId);
      staging.broadcast(run?.members.size ?? 0);
    }
  }

  /** Instances close once abandoned. An antechamber stays while its run is live, so latecomers can still get in. */
  private closable(room: Room): boolean {
    if (room.members.size > 0 || room.emptySeconds <= WILDS.idleCloseSeconds) return false;
    if (room.desc.kind === 'wilds' || room.desc.kind === 'dungeon') return true;
    return room.desc.kind === 'staging' && this.stagings.get(room.id)?.runRoomId === null;
  }

  private close(room: Room): void {
    this.rooms.delete(room.id);
    this.stagings.delete(room.id);
  }

  private stagingFor(ref: DungeonRef): Room {
    const desc = { kind: 'staging', seed: ref.seed, level: ref.level } as const;
    const existing = this.rooms.get(roomIdFor(desc));
    if (existing) return existing;
    const room = this.createRoom(desc);
    this.stagings.set(room.id, new Staging(room, ref));
    return room;
  }

  /** Everyone in the antechamber goes into a brand new run together. */
  private startRun(staging: Staging): void {
    const run = this.createRoom({ kind: 'dungeon', seed: staging.ref.seed, level: staging.ref.level, run: staging.runs++ });
    staging.runRoomId = run.id;
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
        this.join(client, msg.token, msg.characterId, msg.mode === 'arena' ? this.arena : this.town);
        return;
      case 'townPortal':
        this.move(client, this.town);
        return;
      case 'newInstance':
        this.move(client, this.newWilds(msg.seed));
        return;
      case 'ready': {
        const room = client.room;
        const staging = room ? this.stagings.get(room.id) : undefined;
        staging?.setReady(client, msg.ready);
        return;
      }
      case 'joinInstance': {
        const room = this.rooms.get(msg.roomId);
        if (room && (room.desc.kind === 'wilds' || room.desc.kind === 'staging')) this.move(client, room);
        else client.send({ t: 'notice', text: 'That instance has closed' });
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
          list: [...this.rooms.values()]
            .flatMap((r) => (r.desc.kind === 'wilds' || r.desc.kind === 'staging' ? [{ r, kind: r.desc.kind, seed: r.desc.seed }] : []))
            .map(({ r, kind, seed }) => ({
              roomId: r.id,
              kind,
              name: r.name,
              seed,
              players: [...r.members.values()].map((m) => this.nameOf(r, m.playerId)),
            })),
        });
        return;
      default:
        client.room?.handle(client, msg);
    }
  }

  /** Swaps in a rebuilt town and carries everyone inside over to it. */
  private replaceTown(layout: Parameters<typeof saveTownLayout>[0]): void {
    const old = this.town;
    const next = this.createRoom({ kind: 'town', layout });
    next.townEditor = townEditorEnabled;
    this.town = next;
    for (const m of [...old.members.values()]) {
      const save = old.remove(m.client);
      if (save) next.add(m.client, save.classId, save.name, save);
    }
    if (old.id !== next.id) this.rooms.delete(old.id);
  }

  private nameOf(room: Room, playerId: number): string {
    return room.sim.world.player.get(playerId)?.name ?? '?';
  }

  private usePortal(client: Client, request: PortalRequest): void {
    switch (request.target) {
      case 'town':
        this.move(client, this.town);
        return;
      case 'arena':
        this.move(client, this.arena);
        return;
      case 'staging':
        if (request.portal.dungeon) this.move(client, this.stagingFor(request.portal.dungeon));
        return;
      case 'dungeon': {
        const staging = client.room ? this.stagings.get(client.room.id) : undefined;
        const run = staging?.runRoomId ? this.rooms.get(staging.runRoomId) : undefined;
        if (run) this.move(client, run);
        else client.send({ t: 'notice', text: 'The gate is sealed until everyone here is ready (R)' });
        return;
      }
      case 'wilds': {
        const last = client.lastWildsId === null ? undefined : this.rooms.get(client.lastWildsId);
        this.move(client, last ?? this.newWilds());
      }
    }
  }

  /** Carries the character (class, name, items, equipment) from the current room into `to`. */
  private move(client: Client, to: Room): void {
    const from = client.room;
    if (!from || from === to) return;
    const carried = from.remove(client);
    if (!carried) return;
    this.persist(client, from, carried);
    // Leaving the sandbox restores the stored character, so free rune editing never leaks into the world.
    const stored = isSandbox(from) && !isSandbox(to) ? this.loadSave(client) : null;
    const save = stored ?? carried;
    if (to.desc.kind === 'wilds') client.lastWildsId = to.id;
    to.add(client, save.classId, save.name, save);
  }

  private join(client: Client, token: string, characterId: number, room: Room): void {
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
    client.characterId = character.id;
    room.add(client, character.classId, character.name, character.save ?? undefined);
    // A brand new character gets its starter kit on first entry; store it right away.
    if (!character.save) this.persist(client, room, room.exportMember(client));
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
