import {
  SKILL_BUTTONS,
  FORGE_REACH,
  STASH_REACH,
  TRADER,
  CLASSES,
  loadMap,
  NET,
  LOOT,
  SIM,
  type CharacterSummary,
  type ClientMessage,
  type ClassId,
  type EntityId,
  type EntitySnap,
  type GameEvent,
  type GameMap,
  type MapDescriptor,
  type ServerMessage,
  type Snapshot,
  type TownLayout,
  type Vec2,
  type WorldMap,
  type ZoneId,
  DEFAULT_TOWN_LAYOUT,
  ENEMIES,
  parseModelOverrides,
  HOME_ZONE,
  ZONES,
  enemyDisplayName,
} from '@rune/shared';
import { Connection } from '../net/connection.js';
import { Recorder, encodeReplay } from './replay.js';
import { isOutdated, reloadForUpdate } from './update.js';
import { netSettings } from '../net/settings.js';
import { COLORS, cssColor, ELEMENT_COLORS, FX, TIER_COLORS, VIEW } from '../render/config.js';
import { EntityRenderer, type RenderItem } from '../render/entities.js';
import { Effects } from '../render/fx.js';
import { Minimap } from '../render/minimap.js';
import { WorldScene } from '../render/scene.js';
import { initSkillPicks, pickSkill, useUi } from '../ui/store.js';
import { ClickMover } from './clickMove.js';
import { GamepadInput, type PadState } from './gamepad.js';
import { InputState, screenToWorld, type SampledInput } from './input.js';
import { InterpolationBuffer } from './interpolation.js';
import { SpellTable } from './spellTable.js';
import { Predictor } from './prediction.js';
import { TownEditor } from './townEditor.js';
import { useDevCursor } from '../ui/DevPanel.js';
import { clearItemInteractions, noteInventory } from '../ui/Inventory.js';
import { lighting } from '../render/daylight.js';
import { setModelOverrides } from '../render/characters.js';
import { applyTryOns, watchTryOns } from '../render/tryOn.js';
import { actionFor, useSettings } from '../ui/settings.js';

/** Frames spent in a background tab should not turn into a burst of inputs on return. */
/** How long a chat line hangs over the speaker's head. */
const BUBBLE_MS = 6000;
const MAX_CATCHUP_TICKS = 3;
const DEBUG_PUBLISH_MS = 250;
const MINIMAP_MS = 100;
/** The server re-offers the waypoint menu every 3 s while you stand on one; an older offer is stale. */
const WAYPOINT_OFFER_MS = 3500;
/** How close to a station's centre a click has to land; the props are about this big on screen. */
const STATION_PICK = 60;
/** The leaderboard stone is only read, never checked by the server, so this is just a comfortable distance. */
const BOARD_REACH = 110;

type Station = { kind: 'stash' | 'forge' | 'trader' | 'board' } | { kind: 'waypoint'; zone: ZoneId; x: number; y: number; r: number };

function stationPos(def: WorldMap, s: Station): Vec2 | null {
  return s.kind === 'waypoint' ? s : (def[s.kind] ?? null);
}

/** Inside the server's reach, less a margin so latency cannot leave a request just out of range. */
function stationInReach(def: WorldMap, s: Station | Station['kind'], at: Vec2): boolean {
  const station: Station | null = typeof s === 'string' ? (s === 'waypoint' ? null : { kind: s }) : s;
  const pos = station ? stationPos(def, station) : null;
  if (!station || !pos) return false;
  const d = Math.hypot(pos.x - at.x, pos.y - at.y);
  if (station.kind === 'waypoint') return d <= station.r * 0.7;
  const reach = station.kind === 'stash' ? STASH_REACH : station.kind === 'forge' ? FORGE_REACH : station.kind === 'board' ? BOARD_REACH : TRADER.reach;
  return d <= reach - 10;
}

/** The station under a clicked ground point, if any. */
function stationAt(def: WorldMap, p: Vec2): Station | null {
  for (const kind of ['stash', 'forge', 'trader', 'board'] as const) {
    const pos = def[kind];
    if (pos && Math.hypot(pos.x - p.x, pos.y - p.y) <= STATION_PICK) return { kind };
  }
  for (const w of def.portals) {
    if (w.target === 'waypoint' && w.zone && Math.hypot(w.x - p.x, w.y - p.y) <= w.r + 10) return { kind: 'waypoint', zone: w.zone, x: w.x, y: w.y, r: w.r };
  }
  return null;
}

type PlayerSnap = Extract<EntitySnap, { k: 'player' }>;

/** Everything tied to one room. Replaced wholesale when the server moves us to another room. */
interface RoomView {
  id: string;
  def: WorldMap;
  map: GameMap;
  world: WorldScene;
  entities: EntityRenderer;
  fx: Effects;
  input: InputState;
  predictor: Predictor;
  interp: InterpolationBuffer;
  /** Spell entities arrive once and are carried forward here; see onSnapshot. */
  spells: SpellTable;
  mover: ClickMover;
  minimap: Minimap | null;
}

export interface GameMounts {
  host: HTMLElement;
  fxLayer: HTMLElement;
  minimap: HTMLCanvasElement | null;
}

/** Recorded playback: messages come from a file on a virtual clock, and nothing is sent anywhere. */
export interface ReplaySource {
  start(onMessage: (msg: ServerMessage) => void): void;
  stop(): void;
  /** Virtual milliseconds; runs slower or faster than real time with the playback speed. */
  now(): number;
}

export type GameSession =
  | { kind: 'live'; token: string; character: CharacterSummary }
  | { kind: 'replay'; source: ReplaySource; classId: ClassId; name: string };

export class Game {
  private readonly conn: Connection | null = null;
  private readonly replay: ReplaySource | null = null;
  private recorder: Recorder | null = null;
  /** The latest room state, so a recording started mid-room still plays back on its own. */
  private lastWelcome: ServerMessage | null = null;
  private lastInventory: ServerMessage | null = null;
  private lastStaging: ServerMessage | null = null;
  private room: RoomView | null = null;
  private destroyed = false;
  private rafId = 0;
  private lastFrame = 0;

  private playerId: EntityId | null = null;
  private latest: Snapshot | null = null;
  private paused = false;
  private seq = 0;
  private accumulator = 0;
  private localAim = 0;
  private visualOffset = { x: 0, y: 0 };
  private renderedEnemies: { x: number; y: number; r: number; snap: Extract<EntitySnap, { k: 'enemy' }> }[] = [];
  /** Item bags on screen, for clicking them up. Gold needs no click, so it is not listed. */
  private renderedLoot: { id: EntityId; x: number; y: number; r: number }[] = [];
  /** A bag the player clicked: walk to it, then pick it up. */
  private pickupTarget: EntityId | null = null;
  /** A town station or waypoint the player clicked: walk to it, then open its window. */
  private stationTarget: Station | null = null;
  /** The latest waypoint menu the server offered; it only opens once the waypoint is clicked. */
  private waypointOffer: { current: ZoneId; unlocked: ZoneId[]; at: number } | null = null;
  /** The left button went down on loot or a station, so this press interacts instead of casting or walking. */
  private leftOnLoot = false;
  private pickPresses = 0;
  /** Keeps the target frame up briefly after the cursor slips off, so it does not flicker in a fight. */
  private targetHeldUntil = 0;
  private hoverEnemyId: EntityId | null = null;
  /** Click-to-move: the monster a left-click locked onto, attacked for as long as the button is held. */
  private attackLock: EntityId | null = null;
  private lastLeftPresses = 0;
  private readonly pad = new GamepadInput();
  private chatSeq = 0;
  /** Latest chat line per speaker name, shown over their head until it expires. */
  private readonly bubbles = new Map<string, { text: string; until: number }>();
  private pendingEvents: { tick: number; ev: GameEvent }[] = [];
  private lastFizzle: string | null = null;
  private townLayout: TownLayout | null = null;
  private townEditorAllowed = false;
  private editor: TownEditor | null = null;
  /** Saving rebuilds the town room; the editor reopens on the new scene. */
  private reopenEditor = false;
  private editorCamera: { x: number; y: number } | null = null;

  private rttMs: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastDebugPublish = 0;
  private lastMinimap = 0;
  private frameCount = 0;
  private fps = 0;
  private frameNo = 0;

  private readonly classId: ClassId;
  private readonly name: string;
  /** Set when the server ends the session, so the socket close that follows keeps its reason. */
  private ended = false;
  private unwatchTryOns: (() => void) | null = null;

  constructor(
    private readonly mounts: GameMounts,
    private readonly session: GameSession,
  ) {
    if (session.kind === 'replay') {
      this.classId = session.classId;
      this.name = session.name;
      this.replay = session.source;
      return;
    }
    this.classId = session.character.classId;
    this.name = session.character.name;
    this.conn = new Connection({
      url: netSettings.serverUrl,
      oneWayLagMs: netSettings.addedRttMs / 2,
      onMessage: (msg) => this.onMessage(msg),
      onClose: () => {
        if (!this.destroyed && !this.ended) useUi.getState().connectionLost('Disconnected from server');
      },
    });
    void this.loadTryOns();
    this.unwatchTryOns = watchTryOns(() => void this.loadTryOns());
  }

  /** Local models the admin page's Model check is trying on; only this browser draws them. */
  private async loadTryOns(): Promise<void> {
    try {
      const names = await applyTryOns();
      if (names.length > 0 && !this.destroyed) useUi.getState().notify(`Model check: trying ${names.join(', ')}`);
    } catch {
      // No IndexedDB (a private window, say) just means nothing is being tried on.
    }
  }

  /** Interpolation runs on the replay's virtual clock during playback, so slow motion and fast forward both work. */
  private clock(): number {
    return this.replay ? this.replay.now() : performance.now();
  }

  private send(msg: ClientMessage): void {
    this.conn?.send(msg);
  }

  async start(): Promise<void> {
    if (this.replay) {
      this.replay.start((msg) => this.onMessage(msg));
      this.startLoop();
      return;
    }
    const conn = this.conn;
    const session = this.session;
    if (!conn || session.kind !== 'live') return;
    try {
      await conn.ready();
    } catch (err) {
      if (this.destroyed) return;
      useUi.getState().connectionLost(err instanceof Error ? err.message : 'Connection failed');
      return;
    }
    if (this.destroyed) return;
    conn.send({ t: 'join', token: session.token, characterId: session.character.id });
    useUi.setState({ send: (msg) => conn.send(msg), toggleRecording: () => this.toggleRecording() });
    this.pingTimer = setInterval(() => conn.send({ t: 'ping', clientTime: performance.now() }), NET.pingIntervalMs);
    this.startLoop();
  }

  private startLoop(): void {
    this.lastFrame = performance.now();
    const loop = (now: number): void => {
      if (this.destroyed) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy(): void {
    this.destroyed = true;
    this.unwatchTryOns?.();
    cancelAnimationFrame(this.rafId);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.teardownRoom();
    this.conn?.close();
    this.replay?.stop();
    if (this.recorder) {
      this.recorder = null;
      useUi.setState({ recording: false });
    }
    useUi.setState({ toggleRecording: null });
  }

  /** Starts recording, or stops and downloads the file. */
  private toggleRecording(): void {
    if (!this.recorder) {
      const seed = [this.lastWelcome, this.lastInventory, this.lastStaging].filter((m): m is ServerMessage => m !== null);
      this.recorder = new Recorder(this.classId, this.name, seed);
      useUi.setState({ recording: true });
      useUi.getState().notify('Recording replay');
      return;
    }
    const file = this.recorder.finish();
    this.recorder = null;
    useUi.setState({ recording: false });
    void encodeReplay(file).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rune-replay-${new Date(file.recordedAt).toISOString().replace(/[:.]/g, '-')}.json.gz`;
      a.click();
      // Revoked a tick later: some browsers cancel the download if the URL dies during the click.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      useUi.getState().notify(`Replay saved (${Math.round(file.durationMs / 1000)} s, ${Math.round(blob.size / 1024)} KB)`);
    });
  }

  private teardownRoom(): void {
    this.editor?.dispose();
    this.editor = null;
    if (!this.room) return;
    this.room.input.dispose();
    this.room.fx.dispose();
    this.room.world.dispose();
    this.room = null;
  }

  /** Builds the scene for a room. The map is regenerated locally from its descriptor, identical to the server's. */
  private enterRoom(id: string, desc: MapDescriptor): void {
    this.teardownRoom();
    useUi.setState({ staging: null, arena: null, boardOpen: false });
    clearItemInteractions();
    const { def, game } = loadMap(desc);
    useUi.setState({
      roomPortals: def.portals.map((p) => {
        // Land on the spawn side of the portal: open ground, and close enough to step in.
        const d = Math.hypot(def.spawn.x - p.x, def.spawn.y - p.y) || 1;
        return { label: p.label, x: p.x + ((def.spawn.x - p.x) / d) * (p.r + 50), y: p.y + ((def.spawn.y - p.y) / d) * (p.r + 50) };
      }),
    });
    const world = new WorldScene(this.mounts.host, def);
    const entities = new EntityRenderer(world.scene, world.camera);
    const fx = new Effects(world.scene, world, this.mounts.fxLayer);
    const input = new InputState(
      world.canvas,
      (code) => this.onKey(code),
      (step, shift) => {
        if (!useSettings.getState().options.wheelCyclesSkill) return;
        const ui = useUi.getState();
        const side = shift ? 'left' : 'right';
        const from = shift ? ui.leftSkill : ui.rightSkill;
        pickSkill(side, (from + step + SKILL_BUTTONS.length) % SKILL_BUTTONS.length);
      },
    );
    this.room = {
      id,
      def,
      map: game,
      world,
      entities,
      fx,
      input,
      predictor: new Predictor(CLASSES[this.classId].moveSpeed, game),
      interp: new InterpolationBuffer(SIM.tickMs, NET.interpolationDelayMs),
      spells: new SpellTable(),
      mover: new ClickMover(game),
      minimap: this.mounts.minimap ? new Minimap(this.mounts.minimap, def, `${id}:${def.width}x${def.height}:${def.spawn.x},${def.spawn.y}`) : null,
    };
    this.latest = null;
    this.pendingEvents = [];
    this.visualOffset = { x: 0, y: 0 };
    // Dev-only handle for inspecting the scene from the browser console.
    if (import.meta.env.DEV) Object.assign(window, { __rune: { world, entities } });
    useUi.setState({ roomName: def.name, roomTheme: def.theme, roomSeed: desc.kind === 'wilds' || desc.kind === 'zone' ? desc.seed : null, waypointMenu: null });
    // The town editor works on the town part of the home zone, which sits at the map origin.
    this.townLayout = desc.kind === 'town' || (desc.kind === 'zone' && desc.zone === HOME_ZONE) ? (desc.layout ?? DEFAULT_TOWN_LAYOUT) : null;
  }

  private toggleTownEditor(): void {
    const room = this.room;
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
      this.editorCamera = null;
      // Drop any unsaved preview by rebuilding from the server's layout.
      if (room) room.world.rebuildWorld(room.def);
      return;
    }
    if (!room || !this.townLayout) {
      useUi.getState().notify('The town editor works in town');
      return;
    }
    if (!this.townEditorAllowed) {
      useUi.getState().notify('The town editor needs the builder role');
      return;
    }
    // After a save the room is rebuilt before the first snapshot arrives, so keep the editor's own camera.
    const start = this.editorCamera ?? (this.latest ? room.predictor.position : this.townLayout.spawn);
    this.editor = new TownEditor(room.world, this.townLayout, { x: start.x, y: start.y }, (layout) => {
      this.reopenEditor = true;
      this.editorCamera = this.editor ? { ...this.editor.camera } : null;
      this.send({ t: 'saveTown', layout });
    });
  }

  private onKey(code: string): void {
    const ui = useUi.getState();
    if (code === 'F2') {
      this.toggleTownEditor();
      return;
    }
    // While editing, the editor owns the keyboard.
    if (this.editor) return;
    if (code === 'F1') ui.toggleDebug();
    else if (code === 'F3') useUi.setState((s) => ({ devOpen: !s.devOpen }));
    else if (code === 'Escape') {
      if (ui.settingsOpen) useUi.setState({ settingsOpen: false });
      else if (ui.inventoryOpen || ui.editorOpen || ui.characterOpen) useUi.setState({ inventoryOpen: false, editorOpen: false, characterOpen: false });
      else ui.toggleMenu();
    }
    // A settings panel waiting for a key press gets it instead of the game.
    if (ui.settingsOpen) return;
    switch (actionFor(code)) {
      case 'record':
        if (!this.replay) this.toggleRecording();
        break;
      case 'inventory':
        ui.toggleInventory();
        break;
      case 'character':
        useUi.setState((s) => ({ characterOpen: !s.characterOpen }));
        break;
      case 'sigilEditor':
        if (ui.forgeOpen || (ui.editorAllowed && ui.devTools)) ui.toggleEditor();
        else ui.notify('Sigils are inscribed at the forge in town');
        break;
      case 'stance':
        this.send({ t: 'cycleStance' });
        break;
      case 'ready':
        if (ui.staging) {
          const me = ui.staging.members.find((m) => m.name === ui.name);
          this.send({ t: 'ready', ready: !(me?.ready ?? false) });
        }
        break;
      case 'minimap':
        useUi.setState((s) => ({ minimapVisible: !s.minimapVisible }));
        break;
      default:
        break;
    }
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.t === 'welcome') this.lastWelcome = msg;
    else if (msg.t === 'inventory') this.lastInventory = msg;
    else if (msg.t === 'staging') this.lastStaging = msg;
    if (this.recorder) {
      this.recorder.record(msg);
      if (this.recorder.full) this.toggleRecording();
    }
    switch (msg.t) {
      case 'welcome':
        if (this.session.kind === 'live' && isOutdated(msg.build)) {
          if (reloadForUpdate(msg.build, { characterId: this.session.character.id })) return;
          useUi.getState().notify('A new version is out. Reload the page to update.');
        }
        if (useUi.getState().reconnectAttempt > 0) useUi.getState().notify('Reconnected');
        useUi.getState().connected();
        this.playerId = msg.playerId;
        this.townEditorAllowed = msg.townEditor;
        // A role change resends the welcome; an open editor would otherwise linger with saves refused.
        if (!msg.townEditor && this.editor) this.toggleTownEditor();
        if (this.room?.id !== msg.roomId) {
          this.enterRoom(msg.roomId, msg.map);
          if (this.reopenEditor) {
            this.reopenEditor = false;
            this.toggleTownEditor();
          }
        }
        useUi.setState({ playerId: msg.playerId, canPause: msg.canPause, editorAllowed: msg.editor, devTools: msg.devTools });
        return;
      case 'sessionEnded':
        this.ended = true;
        useUi.getState().leave(msg.reason);
        return;
      case 'pong':
        this.rttMs = performance.now() - msg.clientTime;
        return;
      case 'inventory':
        if (!useUi.getState().inventory) initSkillPicks(msg);
        noteInventory(useUi.getState().inventory, msg);
        useUi.setState({ inventory: msg });
        return;
      case 'notice':
        useUi.getState().notify(msg.text);
        return;
      case 'inscribed':
        useUi.getState().inscribed(msg);
        return;
      case 'banner': {
        const id = performance.now();
        useUi.setState({ banner: { id, title: msg.title, text: msg.text } });
        setTimeout(() => {
          if (useUi.getState().banner?.id === id) useUi.setState({ banner: null });
        }, 5000);
        return;
      }
      case 'chat': {
        const line = { id: ++this.chatSeq, kind: msg.kind, from: msg.from, to: msg.to, text: msg.text, at: performance.now() };
        useUi.setState((s) => ({ chat: [...s.chat, line].slice(-60) }));
        // Speech bubble over the speaker, when they are in this room, like D2's overhead text.
        if (msg.kind === 'game') this.bubbles.set(msg.from, { text: msg.text, until: performance.now() + BUBBLE_MS });
        return;
      }
      case 'waypoints':
        // Touching a waypoint still activates it on the server; the menu waits for a click, as in D2.
        this.waypointOffer = { current: msg.current, unlocked: msg.unlocked, at: performance.now() };
        return;
      case 'staging':
        useUi.setState({ staging: msg });
        return;
      case 'arena':
        // A new run's first status clears the last run's score screen.
        useUi.setState((s) => ({ arena: msg, arenaResult: msg.wave === 0 ? null : s.arenaResult }));
        return;
      case 'arenaResult':
        useUi.setState({ arenaResult: msg });
        return;
      case 'world':
        useUi.setState({ world: msg.world });
        return;
      case 'party':
        useUi.setState({ partyInfo: msg.party });
        return;
      case 'trader':
        useUi.setState({ traderStock: msg.stock });
        return;
      case 'lighting':
        Object.assign(lighting, msg.lighting);
        return;
      case 'models': {
        const models = parseModelOverrides(msg.models);
        if (typeof models !== 'string') setModelOverrides(models);
        return;
      }
      case 'partyInvite':
        useUi.setState({ partyInvite: msg.from });
        useUi.getState().notify(`${msg.from} invited you to a party`);
        return;
      case 'snapshot':
        this.onSnapshot(msg);
        return;
    }
  }

  private onSnapshot(sent: Snapshot): void {
    const room = this.room;
    if (!room) return;
    const snap = room.spells.expand(sent);
    const first = this.latest === null;
    this.latest = snap;
    if (snap.paused !== this.paused) {
      this.paused = snap.paused;
      useUi.setState({ paused: snap.paused });
    }
    room.interp.push(snap, this.clock());
    for (const ev of snap.events) this.pendingEvents.push({ tick: snap.tick, ev });

    const self = this.findSelf(snap);
    if (self) {
      const p = room.predictor;
      if (first) p.reset(self);
      const wasFrozen = p.frozen;
      // Replay with the server's current speed, so gear changes never show up as corrections.
      if (snap.self) p.moveSpeed = snap.self.moveSpeed;
      p.reconcile(self, snap.self?.dash ?? null, snap.lastProcessedInputSeq, self.dead);
      const v = p.lastCorrectionVector;
      // Respawns and large corrections snap; small ones blend out over a few frames.
      if (p.lastCorrection > FX.maxSmoothedCorrection || wasFrozen !== self.dead) {
        this.visualOffset = { x: 0, y: 0 };
        p.previous = { x: self.x, y: self.y };
      } else {
        this.visualOffset.x += v.x;
        this.visualOffset.y += v.y;
      }
      this.publishHud(self, snap);
    }
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.frameCount++;
    this.frameNo++;
    this.accumulator += dt * 1000;
    if (this.accumulator > SIM.tickMs * MAX_CATCHUP_TICKS) this.accumulator = SIM.tickMs * MAX_CATCHUP_TICKS;
    while (this.accumulator >= SIM.tickMs) {
      if (!this.editor) this.fixedStep();
      this.accumulator -= SIM.tickMs;
    }
    this.editor?.update(dt);
    const decay = Math.exp(-VIEW.correctionSmoothingPerSecond * dt);
    this.visualOffset.x *= decay;
    this.visualOffset.y *= decay;
    this.draw(this.replay ? this.clock() : now, this.paused ? 0 : dt);
    this.publishDebug(now);
  }

  private fixedStep(): void {
    const room = this.room;
    // While paused the server drops input, so predicting it would only produce a correction later.
    // Playback has no input: the recorded snapshots move the player, so prediction just follows them.
    if (!room || this.paused || this.playerId === null || !this.latest || this.replay) return;
    const origin = room.predictor.position;
    // Stations open on a click (see walkToStation) and close once you walk out of the server's reach.
    const ui = useUi.getState();
    if (ui.stashOpen && !stationInReach(room.def, 'stash', origin)) useUi.setState({ stashOpen: false });
    if (ui.forgeOpen && !stationInReach(room.def, 'forge', origin)) useUi.setState({ forgeOpen: false, editorOpen: false });
    if (ui.traderOpen && !stationInReach(room.def, 'trader', origin)) useUi.setState({ traderOpen: false });
    const aimPoint = room.world.screenToGround(room.input.mouseX, room.input.mouseY);
    if (aimPoint && room.input.overCanvas) useDevCursor.setState(aimPoint);
    const sampled = room.input.sample(room.world.basis, origin, aimPoint, this.localAim);
    // No basic attack: each mouse button casts its picked skill, D2 style; the wheel or a slot click picks them.
    const { leftSkill, rightSkill } = useUi.getState();
    const leftBit = SKILL_BUTTONS[leftSkill] ?? 0;
    const rightBit = SKILL_BUTTONS[rightSkill] ?? 0;
    if (room.input.rightDown && room.input.overCanvas) sampled.buttons |= rightBit;
    if (useSettings.getState().options.controls === 'keyboard' && room.input.leftDown && room.input.overCanvas) sampled.buttons |= leftBit;
    const now = performance.now();
    // D2 style: items stay on the ground until clicked. A press on a bag starts a pickup instead of a cast.
    const input = room.input;
    if (input.leftPresses !== this.pickPresses) {
      this.pickPresses = input.leftPresses;
      const hit = input.overCanvas && aimPoint ? this.renderedLoot.find((l) => Math.hypot(l.x - aimPoint.x, l.y - aimPoint.y) <= l.r + 26) : undefined;
      const station = !hit && input.overCanvas && aimPoint ? stationAt(room.def, aimPoint) : null;
      this.leftOnLoot = hit !== undefined || station !== null;
      // Any other press cancels a walk to loot or a station, so a click elsewhere always wins.
      this.pickupTarget = hit?.id ?? null;
      this.stationTarget = station;
      if (station || hit) room.mover.stop();
    }
    if (!input.leftDown) this.leftOnLoot = false;
    if (this.leftOnLoot) sampled.buttons &= ~leftBit;
    if (this.pickupTarget !== null) this.walkToPickup(room, sampled, origin, now);
    else if (this.stationTarget !== null) this.walkToStation(room, sampled, origin, now);
    else if (useSettings.getState().options.controls === 'click' && !this.leftOnLoot) this.applyClickScheme(room, sampled, origin, aimPoint, now);
    const pad = this.pad.poll(now);
    // The pad only takes over while it is in use, so a controller left plugged in does not fight the mouse.
    if (pad && now - this.pad.lastActive < 3000) this.applyPad(room, sampled, pad);
    if (useUi.getState().menuOpen) sampled.buttons = 0;
    const frame = { seq: this.seq++, ...sampled };
    this.send({ t: 'input', ...frame });
    room.predictor.apply(frame);
    this.localAim = frame.aimAngle;

  }

  /**
   * D2-style mouse control. Left button walks toward the cursor along a path; pressing it on a
   * monster locks onto it and casts the left skill at it while held, walking into range first.
   * Shift holds position and casts toward the cursor. The right button's skill is added elsewhere.
   */
  private applyClickScheme(room: RoomView, sampled: SampledInput, origin: Vec2, aimPoint: Vec2 | null, now: number): void {
    const input = room.input;
    const keysMoving = sampled.moveDir.x !== 0 || sampled.moveDir.y !== 0;
    const leftBit = SKILL_BUTTONS[useUi.getState().leftSkill] ?? 0;

    const pressed = input.leftPresses !== this.lastLeftPresses;
    this.lastLeftPresses = input.leftPresses;
    if (!input.leftDown) this.attackLock = null;
    else if (pressed) this.attackLock = input.overCanvas ? this.hoverEnemyId : null;
    if (keysMoving) {
      room.mover.stop();
      return;
    }
    if (input.leftDown && input.overCanvas && input.shiftDown) {
      room.mover.stop();
      sampled.buttons |= leftBit;
      sampled.moveDir = { x: 0, y: 0 };
      return;
    }
    const target = this.attackLock === null ? undefined : this.renderedEnemies.find((e) => e.snap.id === this.attackLock);
    if (this.attackLock !== null && !target) this.attackLock = null;
    if (input.leftDown && target) {
      sampled.aimAngle = Math.atan2(target.y - origin.y, target.x - origin.x);
      // The class's old attack range still says how close it likes to fight: melee walks up, casters hold off.
      const style = CLASSES[this.classId].primary;
      const reach = style.kind === 'melee' ? style.range + target.r : style.range * 0.85;
      if (Math.hypot(target.x - origin.x, target.y - origin.y) > reach) room.mover.moveTo(origin, target, now);
      else {
        room.mover.stop();
        sampled.buttons |= leftBit;
      }
    } else if (input.leftDown && input.overCanvas && aimPoint) {
      room.mover.moveTo(origin, aimPoint, now);
    }
    sampled.moveDir = room.mover.direction(origin);
  }

  /** Walks to the clicked bag and picks it up on arrival; movement keys or the bag vanishing cancel it. */
  private walkToPickup(room: RoomView, sampled: SampledInput, origin: Vec2, now: number): void {
    const bag = this.renderedLoot.find((l) => l.id === this.pickupTarget);
    const keysMoving = sampled.moveDir.x !== 0 || sampled.moveDir.y !== 0;
    if (!bag || keysMoving) {
      this.pickupTarget = null;
      room.mover.stop();
      return;
    }
    // A little inside the server's reach, so latency cannot put the request just out of range.
    if (Math.hypot(bag.x - origin.x, bag.y - origin.y) <= bag.r + SIM.playerRadius + LOOT.pickupReach - 12) {
      this.send({ t: 'pickup', id: bag.id });
      this.pickupTarget = null;
      room.mover.stop();
      return;
    }
    room.mover.moveTo(origin, bag, now);
    // No path (behind a river or wall): give up rather than stand frozen waiting for one.
    if (!room.mover.moving) this.pickupTarget = null;
    sampled.moveDir = room.mover.direction(origin);
  }

  /** Walks to the clicked station and opens it on arrival; movement keys cancel it. */
  private walkToStation(room: RoomView, sampled: SampledInput, origin: Vec2, now: number): void {
    const station = this.stationTarget;
    const at = station ? stationPos(room.def, station) : null;
    const keysMoving = sampled.moveDir.x !== 0 || sampled.moveDir.y !== 0;
    if (!station || !at || keysMoving) {
      this.stationTarget = null;
      room.mover.stop();
      return;
    }
    if (stationInReach(room.def, station, origin)) {
      if (station.kind === 'waypoint') {
        // The server re-offers every few seconds while you stand on it; wait for a fresh offer.
        const offer = this.waypointOffer;
        if (!offer || offer.current !== station.zone || now - offer.at > WAYPOINT_OFFER_MS) {
          room.mover.moveTo(origin, at, now);
          sampled.moveDir = room.mover.direction(origin);
          return;
        }
        useUi.setState({ waypointMenu: { current: offer.current, unlocked: offer.unlocked } });
      } else if (station.kind === 'stash') useUi.setState({ stashOpen: true, inventoryOpen: true });
      else if (station.kind === 'board') useUi.setState({ boardOpen: true });
      else if (station.kind === 'forge') {
        useUi.setState({ forgeOpen: true, inventoryOpen: true });
        if (!useUi.getState().editorOpen) useUi.getState().toggleEditor();
      }
      else {
        useUi.setState({ traderOpen: true, inventoryOpen: true });
        this.send({ t: 'traderList' });
      }
      this.stationTarget = null;
      room.mover.stop();
      return;
    }
    room.mover.moveTo(origin, at, now);
    if (!room.mover.moving) this.stationTarget = null;
    sampled.moveDir = room.mover.direction(origin);
  }

  /** A click on a loot label: same as clicking the bag. */
  private pickUpFromLabel(id: EntityId): void {
    this.pickupTarget = id;
  }

  private applyPad(room: RoomView, sampled: SampledInput, pad: PadState): void {
    const basis = room.world.basis;
    const move = screenToWorld(basis, pad.move.x, pad.move.y);
    if (move.x !== 0 || move.y !== 0) {
      sampled.moveDir = move;
      room.mover.stop();
    }
    const aim = pad.aim ? screenToWorld(basis, pad.aim.x, pad.aim.y) : move;
    if (aim.x !== 0 || aim.y !== 0) sampled.aimAngle = Math.atan2(aim.y, aim.x);
    sampled.buttons |= pad.buttons;
    const ui = useUi.getState();
    for (const action of pad.pressed) {
      if (action === 'menu') ui.toggleMenu();
      else if (action === 'inventory') ui.toggleInventory();
      else if (action === 'stance') this.send({ t: 'cycleStance' });
      else useUi.setState((s) => ({ minimapVisible: !s.minimapVisible }));
    }
  }

  /** The waypoint menu belongs to the waypoint you stand on; walking off closes it, as in D2. */
  private closeWaypointMenuWhenAway(room: RoomView, at: { x: number; y: number }): void {
    if (!useUi.getState().waypointMenu) return;
    const near = room.def.portals.some((p) => p.target === 'waypoint' && Math.hypot(p.x - at.x, p.y - at.y) <= p.r + 45);
    if (!near) useUi.setState({ waypointMenu: null });
  }

  private updateTarget(room: RoomView, now: number): void {
    const aim = room.input.overCanvas ? room.world.screenToGround(room.input.mouseX, room.input.mouseY) : null;
    let best: (typeof this.renderedEnemies)[number] | null = null;
    let bestD = Infinity;
    if (aim) {
      for (const e of this.renderedEnemies) {
        // Generous pick radius: monsters move and the cursor is usually a little ahead of them.
        const d = Math.hypot(e.x - aim.x, e.y - aim.y) - e.r;
        if (d < 28 && d < bestD) {
          best = e;
          bestD = d;
        }
      }
    }
    const ui = useUi.getState();
    this.hoverEnemyId = best?.snap.id ?? null;
    if (!best) {
      const still = ui.target ? this.renderedEnemies.find((e) => e.snap.id === ui.target?.id) : undefined;
      if (ui.target && (!still || now > this.targetHeldUntil)) useUi.setState({ target: null });
      else if (ui.target && still && still.snap.life !== ui.target.life) useUi.setState({ target: { ...ui.target, life: still.snap.life } });
      return;
    }
    this.targetHeldUntil = now + 800;
    const s = best.snap;
    if (ui.target?.id === s.id && ui.target.life === s.life) return;
    useUi.setState({
      target: {
        id: s.id,
        name: s.rare || s.boss ? enemyDisplayName(s.et, s.ax) : ENEMIES[s.et].name,
        level: s.lvl,
        life: s.life,
        maxLife: s.maxLife,
        rare: s.rare,
        boss: s.boss,
        affixes: s.ax,
      },
    });
  }

  private draw(now: number, dt: number): void {
    const room = this.room;
    if (!room || !this.latest || this.playerId === null) return;
    const { world, entities, fx } = room;
    const playerId = this.playerId;
    const items: RenderItem[] = [];
    const labels: Parameters<Effects['syncLabels']>[0][number][] = [];
    const sample = room.interp.sample(now);
    this.renderedEnemies = [];
    this.renderedLoot = [];
    const trail = fx.trailDue(dt);
    const showAllLoot = room.input.showLootDown;

    if (sample) {
      for (const [id, to] of sample.to) {
        if (id === playerId) continue;
        const from = sample.from.get(id) ?? to;
        const x = from.x + (to.x - from.x) * sample.t;
        const y = from.y + (to.y - from.y) * sample.t;
        const r = from.r + (to.r - from.r) * sample.t;
        const snap: EntitySnap = { ...to, x, y, r };
        if (to.k === 'enemy') this.renderedEnemies.push({ x, y, r, snap: to });
        if (to.k === 'player') {
          labels.push({ key: `p${id}`, x, y, text: to.name, color: '#cfe6ff', height: 78, className: 'fx-label' });
          const bubble = this.bubbles.get(to.name);
          if (bubble && bubble.until > performance.now()) labels.push({ key: `b${id}`, x, y, text: bubble.text, color: '#fff6dc', height: 104, className: 'fx-label bubble' });
        }
        if (to.k === 'loot') {
          if (to.count > 0) this.renderedLoot.push({ id, x, y, r });
          // D2 style: good drops are always labelled, everything shows while Alt is held. Labels are
          // clickable, the easy way to pick a drop out of a pile.
          to.names.forEach((n, i) => {
            if (!showAllLoot && n.tier !== 'rare' && n.tier !== 'relic') return;
            labels.push({ key: `l${id}-${i}`, x, y, text: n.n, color: cssColor(TIER_COLORS[n.tier]), height: 40 + i * 18, className: 'fx-label loot', onClick: () => this.pickUpFromLabel(id) });
          });
          if (to.gold > 0) labels.push({ key: `g${id}`, x, y, text: `${to.gold} gold`, color: '#e8c860', height: 34, className: 'fx-label loot gold' });
        }
        if (to.k === 'projectile' && trail) {
          const color = to.team === 'enemies' ? COLORS.enemyBullet : to.el ? ELEMENT_COLORS[to.el] : COLORS.playerProjectile;
          if (to.orb) fx.orbTrail(x, y, color, r);
          else fx.trail(x, y, color, to.r * (to.team === 'enemies' ? 0.8 : 0.9));
        }
        items.push({ key: `s${id}`, snap, x, y, isSelf: false, isAlly: to.k === 'player' || to.k === 'minion' });
      }
    }

    this.updateTarget(room, now);
    this.closeWaypointMenuWhenAway(room, room.predictor.position);

    const alpha = this.paused ? 1 : this.accumulator / SIM.tickMs;
    const prev = room.predictor.previous;
    const cur = room.predictor.position;
    const px = prev.x + (cur.x - prev.x) * alpha + this.visualOffset.x;
    const py = prev.y + (cur.y - prev.y) * alpha + this.visualOffset.y;

    const self = this.findSelf(this.latest);
    if (self) {
      items.push({
        key: `s${self.id}`,
        snap: { ...self, a: this.localAim, dashing: room.predictor.state.dash !== null },
        x: px,
        y: py,
        isSelf: true,
        isAlly: true,
      });
      const bubble = this.bubbles.get(self.name);
      if (bubble && bubble.until > performance.now()) labels.push({ key: `b${self.id}`, x: px, y: py, text: bubble.text, color: '#fff6dc', height: 104, className: 'fx-label bubble' });
    }
    for (const p of room.def.portals) labels.push({ key: `portal-${p.x}-${p.y}`, x: p.x, y: p.y, text: p.label, color: '#e0d0ff', height: p.r * 2 + 40, className: 'fx-label portal' });
    // The trader's stall and the stash chest look like any other props, so they are named.
    if (room.def.trader) labels.push({ key: 'trader', x: room.def.trader.x, y: room.def.trader.y, text: 'Trader', color: '#e8c860', height: 110, className: 'fx-label portal' });
    if (room.def.forge) labels.push({ key: 'forge', x: room.def.forge.x, y: room.def.forge.y, text: 'Forge', color: '#e8c860', height: 90, className: 'fx-label portal' });
    if (room.def.board) labels.push({ key: 'board', x: room.def.board.x, y: room.def.board.y, text: 'Champions of the Pit', color: '#e8c860', height: 90, className: 'fx-label portal' });
    if (room.def.stash) labels.push({ key: 'stash', x: room.def.stash.x, y: room.def.stash.y, text: 'Stash', color: '#e8c860', height: 70, className: 'fx-label portal' });

    this.playEvents(now);
    entities.render(items, dt);
    fx.syncLabels(labels);
    fx.update(dt);
    const focus = this.editor?.camera ?? { x: px, y: py };
    world.follow(focus.x, focus.y, dt);
    world.render();

    if (room.minimap && now - this.lastMinimap > MINIMAP_MS) {
      this.lastMinimap = now;
      room.minimap.update(px, py, this.latest.entities, playerId, new Set(useUi.getState().partyInfo?.members.map((m) => m.name) ?? []));
    }
  }

  /** Events play when the interpolated view reaches their tick, so hits line up with what is on screen. */
  private playEvents(now: number): void {
    const room = this.room;
    if (!room) return;
    const { fx, world, entities } = room;
    const renderTick = room.interp.renderTick(now) ?? Infinity;
    const ready = this.pendingEvents.filter((p) => p.tick <= renderTick + 1);
    this.pendingEvents = this.pendingEvents.filter((p) => p.tick > renderTick + 1);
    for (const { ev } of ready) {
      switch (ev.e) {
        case 'dmg': {
          entities.flash(`s${ev.id}`);
          if (ev.amt < 1) break;
          const own = ev.id === this.playerId;
          if (own) world.addShake(VIEW.shakeOnHit);
          if (useSettings.getState().options.damageNumbers) fx.text(ev.x, ev.y, String(ev.amt), own ? 0xff4040 : ev.el ? ELEMENT_COLORS[ev.el] : 0xffffff, ev.amt >= 30);
          fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xffe0c0, 4, 90, { up: 120, size: 3, life: 0.3 });
          break;
        }
        case 'heal':
          fx.text(ev.x, ev.y, `+${ev.amt}`, COLORS.heal);
          fx.burst(ev.x, ev.y, COLORS.heal, 6, 40, { up: 90, size: 3, gravity: -60 });
          break;
        case 'levelUp': {
          fx.shockwave(ev.x, ev.y, 160, 0xffd76a, 0.8);
          fx.burst(ev.x, ev.y, 0xffd76a, 40, 220, { up: 260, size: 5, life: 1 });
          if (ev.id === this.playerId) {
            const id = performance.now();
            useUi.setState({ banner: { id, title: `Level ${ev.level}`, text: 'You feel stronger. Life and Force restored.' } });
            setTimeout(() => {
              if (useUi.getState().banner?.id === id) useUi.setState({ banner: null });
            }, 4000);
          }
          break;
        }
        case 'raise':
          entities.removeCorpseNear(ev.x, ev.y);
          break;
        case 'waypoint':
          if (ev.id === this.playerId) useUi.getState().notify(`Waypoint activated: ${ZONES[ev.zone].name}`);
          break;
        case 'death':
          fx.clearTelegraphs(ev.id);
          if (ev.k === 'enemy') entities.markDying(ev.id);
          fx.burst(ev.x, ev.y, ev.color, ev.big ? FX.deathParticles * 2 : FX.deathParticles, ev.big ? 260 : 180, { size: ev.big ? 8 : 6 });
          fx.shockwave(ev.x, ev.y, ev.big ? 140 : 70, ev.big ? COLORS.rareOutline : ev.color);
          if (ev.big) world.addShake(5);
          break;
        case 'fizzle':
          fx.burst(ev.x, ev.y, ev.why === 'misfire' ? 0xff5030 : 0x999999, 14, 80, { up: 60, size: 6, gravity: -30, life: 0.7 });
          fx.text(ev.x, ev.y - 20, ev.why === 'misfire' ? 'misfire' : 'fizzle', ev.why === 'misfire' ? 0xff5030 : 0xaaaaaa);
          if (ev.id === this.playerId) this.lastFizzle = ev.why === 'misfire' ? 'misfire' : `dud: ${ev.reason ?? '?'}`;
          break;
        case 'explode':
          fx.shockwave(ev.x, ev.y, ev.r, 0xff8a3a, 0.4);
          fx.burst(ev.x, ev.y, 0xff8a3a, 30, 260);
          world.addShake(4);
          break;
        case 'pickup':
          fx.burst(ev.x, ev.y, COLORS.selfRing, 16, 60, { up: 200, size: 4, gravity: 200 });
          if (ev.id === this.playerId) useUi.getState().notify(`Picked up ${ev.count} item${ev.count > 1 ? 's' : ''}`);
          break;
        case 'attack':
          entities.attack(`s${ev.id}`);
          break;
        case 'tele':
          fx.telegraph(ev);
          break;
        case 'hazard':
          fx.hazard(ev);
          break;
        case 'cast':
          entities.attack(`s${ev.id}`);
          fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xd0d8ff, 8, 70, { up: 140, size: 3, life: 0.35 });
          break;
      }
    }
  }

  private findSelf(snap: Snapshot): PlayerSnap | null {
    for (const e of snap.entities) if (e.k === 'player' && e.id === this.playerId) return e;
    return null;
  }

  private publishHud(self: PlayerSnap, snap: Snapshot): void {
    const ui = useUi.getState();
    const s = snap.self;
    const patch: Partial<ReturnType<typeof useUi.getState>> = {};
    const respawnIn = s?.respawnIn == null ? null : Math.ceil(s.respawnIn);
    if (ui.life !== self.life) patch.life = self.life;
    if (ui.maxLife !== self.maxLife) patch.maxLife = self.maxLife;
    if (ui.respawnIn !== respawnIn) patch.respawnIn = respawnIn;
    if (ui.wave !== snap.wave) patch.wave = snap.wave;
    if (s) {
      const heat = Math.round(s.heat);
      if (ui.heat !== heat) patch.heat = heat;
      if (ui.spiritMax !== s.spiritMax) patch.spiritMax = s.spiritMax;
      if (ui.spiritReserved !== s.spiritReserved) patch.spiritReserved = s.spiritReserved;
      if (ui.stance !== s.stance) patch.stance = s.stance;
      if (ui.heatMax !== s.heatMax) patch.heatMax = s.heatMax;
      if (ui.level !== s.level) patch.level = s.level;
      if (ui.xp !== s.xp) patch.xp = s.xp;
      if (ui.xpNext !== s.xpNext) patch.xpNext = s.xpNext;
      if (JSON.stringify(ui.stats) !== JSON.stringify(s.stats)) patch.stats = s.stats;
      const cd = Math.round(s.castCooldown * 10) / 10;
      if (ui.castCooldown !== cd) patch.castCooldown = cd;
      if (ui.castCooldownFull !== s.castCooldownFull) patch.castCooldownFull = s.castCooldownFull;
      const respawns = s.minionRespawn.map((t) => Math.ceil(t));
      if (respawns.join() !== ui.minionRespawn.join()) patch.minionRespawn = respawns;
    }
    const partyKey = snap.players.map((p) => `${p.id}:${p.life}:${p.dead}`).join();
    if (partyKey !== ui.party.map((p) => `${p.id}:${p.life}:${p.dead}`).join()) patch.party = snap.players;
    if (Object.keys(patch).length > 0) useUi.setState(patch);
  }

  private publishDebug(now: number): void {
    if (now - this.lastDebugPublish < DEBUG_PUBLISH_MS) return;
    this.fps = Math.round((this.frameCount * 1000) / (now - this.lastDebugPublish));
    this.frameCount = 0;
    this.lastDebugPublish = now;
    if (!useUi.getState().debugVisible) return;
    const room = this.room;
    useUi.setState({
      debug: {
        tick: this.latest?.tick ?? 0,
        rttMs: this.rttMs === null ? null : Math.round(this.rttMs),
        roomEntities: this.latest?.roomEntityCount ?? 0,
        visibleEntities: this.latest?.entities.length ?? 0,
        fps: this.fps,
        pendingInputs: room?.predictor.pendingCount ?? 0,
        heldKeys: room?.input.heldKeys.join(' ') ?? '',
        correctionPx: Math.round((room?.predictor.lastCorrection ?? 0) * 10) / 10,
        addedRttMs: netSettings.addedRttMs,
        drawCalls: room?.world.renderer.info.render.calls ?? 0,
        heat: this.latest?.self?.heat ?? 0,
        lastFizzle: this.lastFizzle,
      },
    });
  }
}

// Game state lives in module scope. A hot update would split it between an old and a new copy
// (the symptom: panels that stop opening), so edits to this module reload the page instead.
import.meta.hot?.accept(() => location.reload());
