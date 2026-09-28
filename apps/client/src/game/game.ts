import {
  BUTTON,
  CLASSES,
  distSq,
  loadMap,
  NET,
  SIM,
  type CharacterSummary,
  type ClassId,
  type EntityId,
  type EntitySnap,
  type GameEvent,
  type GameMap,
  type GameMode,
  type MapDescriptor,
  type ServerMessage,
  type Snapshot,
  type TownLayout,
  type WorldMap,
  DEFAULT_TOWN_LAYOUT,
} from '@rune/shared';
import { Connection } from '../net/connection.js';
import { netSettings } from '../net/settings.js';
import { COLORS, cssColor, ELEMENT_COLORS, FX, TIER_COLORS, VIEW } from '../render/config.js';
import { EntityRenderer, type RenderItem } from '../render/entities.js';
import { Effects } from '../render/fx.js';
import { Minimap } from '../render/minimap.js';
import { WorldScene } from '../render/scene.js';
import { useUi } from '../ui/store.js';
import { InputState } from './input.js';
import { InterpolationBuffer } from './interpolation.js';
import { Predictor } from './prediction.js';
import { TownEditor } from './townEditor.js';
import { useDevCursor } from '../ui/DevPanel.js';

/** Frames spent in a background tab should not turn into a burst of inputs on return. */
const MAX_CATCHUP_TICKS = 3;
const DEBUG_PUBLISH_MS = 250;
const MINIMAP_MS = 100;

type PlayerSnap = Extract<EntitySnap, { k: 'player' }>;

interface CosmeticBolt {
  key: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  lifetime: number;
  spawnedAt: number;
  serverId: EntityId | null;
}

interface CosmeticSwing {
  key: string;
  angle: number;
  arc: number;
  range: number;
  lifetime: number;
}

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
  minimap: Minimap | null;
}

export interface GameMounts {
  host: HTMLElement;
  fxLayer: HTMLElement;
  minimap: HTMLCanvasElement | null;
}

export class Game {
  private readonly conn: Connection;
  private room: RoomView | null = null;
  private destroyed = false;
  private rafId = 0;
  private lastFrame = 0;

  private playerId: EntityId | null = null;
  private latest: Snapshot | null = null;
  private paused = false;
  private seq = 0;
  private accumulator = 0;
  private localPrimaryCooldown = 0;
  private localAim = 0;
  private visualOffset = { x: 0, y: 0 };
  private cosmeticId = 0;
  private bolts: CosmeticBolt[] = [];
  private swings: CosmeticSwing[] = [];
  private seenOwnProjectiles = new Set<EntityId>();
  private renderedEnemies: { x: number; y: number; r: number }[] = [];
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
  /** Set when the server ends the session, so the socket close that follows keeps its reason. */
  private ended = false;

  constructor(
    private readonly mounts: GameMounts,
    private readonly token: string,
    private readonly character: CharacterSummary,
    private readonly mode: GameMode,
  ) {
    this.classId = character.classId;
    this.conn = new Connection({
      url: netSettings.serverUrl,
      oneWayLagMs: netSettings.addedRttMs / 2,
      onMessage: (msg) => this.onMessage(msg),
      onClose: () => {
        if (!this.destroyed && !this.ended) useUi.getState().leave('Disconnected from server');
      },
    });
  }

  async start(): Promise<void> {
    try {
      await this.conn.ready();
    } catch (err) {
      if (this.destroyed) return;
      useUi.getState().leave(err instanceof Error ? err.message : 'Connection failed');
      return;
    }
    if (this.destroyed) return;
    this.conn.send({ t: 'join', token: this.token, characterId: this.character.id, mode: this.mode });
    useUi.setState({ send: (msg) => this.conn.send(msg) });
    this.pingTimer = setInterval(() => this.conn.send({ t: 'ping', clientTime: performance.now() }), NET.pingIntervalMs);
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
    cancelAnimationFrame(this.rafId);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.teardownRoom();
    this.conn.close();
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
    useUi.setState({ staging: null });
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
    const input = new InputState(world.canvas, (code) => this.onKey(code));
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
      minimap: this.mounts.minimap ? new Minimap(this.mounts.minimap, def) : null,
    };
    this.latest = null;
    this.bolts = [];
    this.swings = [];
    this.pendingEvents = [];
    this.seenOwnProjectiles.clear();
    this.visualOffset = { x: 0, y: 0 };
    // Dev-only handle for inspecting the scene from the browser console.
    if (import.meta.env.DEV) Object.assign(window, { __rune: { world, entities } });
    useUi.setState({ roomName: def.name, roomTheme: def.theme, roomSeed: desc.kind === 'wilds' ? desc.seed : null });
    this.townLayout = desc.kind === 'town' ? (desc.layout ?? DEFAULT_TOWN_LAYOUT) : null;
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
      useUi.getState().notify('The town editor is disabled on this server (set TOWN_EDITOR=1)');
      return;
    }
    // After a save the room is rebuilt before the first snapshot arrives, so keep the editor's own camera.
    const start = this.editorCamera ?? (this.latest ? room.predictor.position : this.townLayout.spawn);
    this.editor = new TownEditor(room.world, this.townLayout, { x: start.x, y: start.y }, (layout) => {
      this.reopenEditor = true;
      this.editorCamera = this.editor ? { ...this.editor.camera } : null;
      this.conn.send({ t: 'saveTown', layout });
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
    else if (code === 'KeyI') ui.toggleInventory();
    else if (code === 'KeyC') useUi.setState((s) => ({ characterOpen: !s.characterOpen }));
    else if (code === 'KeyK') {
      if (ui.editorAllowed) ui.toggleEditor();
      else ui.notify('Skills are locked for now. The sigil editor works in the Arena.');
    } else if (code === 'KeyT') this.conn.send({ t: 'cycleStance' });
    else if (code === 'KeyR' && ui.staging) {
      const me = ui.staging.members.find((m) => m.name === ui.name);
      this.conn.send({ t: 'ready', ready: !(me?.ready ?? false) });
    }
    else if (code === 'Tab') useUi.setState((s) => ({ minimapVisible: !s.minimapVisible }));
    else if (code === 'Escape') {
      if (ui.inventoryOpen || ui.editorOpen || ui.characterOpen) useUi.setState({ inventoryOpen: false, editorOpen: false, characterOpen: false });
      else ui.toggleMenu();
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.townEditorAllowed = msg.townEditor;
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
        useUi.setState({ inventory: msg });
        return;
      case 'notice':
        useUi.getState().notify(msg.text);
        return;
      case 'staging':
        useUi.setState({ staging: msg });
        return;
      case 'instances':
        useUi.setState({ instances: msg.list });
        return;
      case 'snapshot':
        this.onSnapshot(msg);
        return;
    }
  }

  private onSnapshot(snap: Snapshot): void {
    const room = this.room;
    if (!room) return;
    const first = this.latest === null;
    this.latest = snap;
    if (snap.paused !== this.paused) {
      this.paused = snap.paused;
      useUi.setState({ paused: snap.paused });
    }
    room.interp.push(snap, performance.now());
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
    this.pairCosmeticBolts(snap);
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
    if (!this.paused) this.updateCosmetics(dt);
    this.draw(now, this.paused ? 0 : dt);
    this.publishDebug(now);
  }

  private fixedStep(): void {
    const room = this.room;
    // While paused the server drops input, so predicting it would only produce a correction later.
    if (!room || this.paused || this.playerId === null || !this.latest) return;
    const origin = room.predictor.position;
    const aimPoint = room.world.screenToGround(room.input.mouseX, room.input.mouseY);
    if (aimPoint && room.input.overCanvas) useDevCursor.setState(aimPoint);
    const sampled = room.input.sample(room.world.basis, origin, aimPoint, this.localAim);
    if (useUi.getState().menuOpen) sampled.buttons = 0;
    const frame = { seq: this.seq++, ...sampled };
    this.conn.send({ t: 'input', ...frame });
    room.predictor.apply(frame);
    this.localAim = frame.aimAngle;

    if (this.localPrimaryCooldown > 0) this.localPrimaryCooldown = Math.max(0, this.localPrimaryCooldown - SIM.dt);
    if ((frame.buttons & BUTTON.primary) !== 0 && this.localPrimaryCooldown <= 0 && !room.predictor.frozen && !room.def.safe) {
      this.spawnCosmeticPrimary(frame.aimAngle);
      this.localPrimaryCooldown = CLASSES[this.classId].primary.cooldown;
      room.entities.attack(`s${this.playerId}`);
    }
  }

  /** Visual only. The server spawns the real attack; these hide the round trip on the player's own shots. */
  private spawnCosmeticPrimary(angle: number): void {
    const room = this.room;
    if (!room) return;
    const attack = CLASSES[this.classId].primary;
    const { x, y } = room.predictor.position;
    if (attack.kind === 'melee') {
      this.swings.push({ key: `l${this.cosmeticId++}`, angle, arc: attack.arc, range: attack.range, lifetime: SIM.swingVisualSeconds });
      return;
    }
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    this.bolts.push({
      key: `l${this.cosmeticId++}`,
      x: x + dx * SIM.playerRadius,
      y: y + dy * SIM.playerRadius,
      vx: dx * attack.speed,
      vy: dy * attack.speed,
      r: attack.radius,
      lifetime: attack.range / attack.speed,
      spawnedAt: performance.now(),
      serverId: null,
    });
  }

  /**
   * Each new server primary-attack projectile of ours takes over the oldest unpaired cosmetic bolt.
   * Once the server projectile is gone (hit or expired), the cosmetic one goes too.
   */
  private pairCosmeticBolts(snap: Snapshot): void {
    const present = new Set<EntityId>();
    for (const e of snap.entities) {
      if (e.k !== 'projectile' || e.owner !== this.playerId || e.el !== null || e.fx !== 'damage') continue;
      present.add(e.id);
      if (this.seenOwnProjectiles.has(e.id)) continue;
      this.seenOwnProjectiles.add(e.id);
      const unpaired = this.bolts.find((b) => b.serverId === null);
      if (unpaired && Math.abs(e.r - unpaired.r) < 0.5) unpaired.serverId = e.id;
    }
    for (const id of this.seenOwnProjectiles) if (!present.has(id)) this.seenOwnProjectiles.delete(id);
    this.bolts = this.bolts.filter((b) => b.serverId === null || present.has(b.serverId));
  }

  private updateCosmetics(dt: number): void {
    const room = this.room;
    if (!room) return;
    const now = performance.now();
    const echoDeadline = (this.rttMs ?? 0) + SIM.tickMs * 2 + FX.cosmeticGraceMs;
    const map = room.map;
    this.bolts = this.bolts.filter((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.lifetime -= dt;
      if (b.lifetime <= 0) return false;
      if (map.pointBlocked(b.x, b.y, b.r * 0.5, 'shots')) return false;
      if (this.hitsRenderedEnemy(b)) return false;
      return b.serverId !== null || now - b.spawnedAt < echoDeadline;
    });
    this.swings = this.swings.filter((s) => (s.lifetime -= dt) > 0);
  }

  /** Hides a cosmetic bolt where the player sees it connect, instead of waiting for the server's verdict. */
  private hitsRenderedEnemy(b: CosmeticBolt): boolean {
    for (const e of this.renderedEnemies) {
      const reach = b.r + e.r + SIM.enemyHitLeniency;
      if (distSq(b.x, b.y, e.x, e.y) <= reach * reach) return true;
    }
    return false;
  }

  private draw(now: number, dt: number): void {
    const room = this.room;
    if (!room || !this.latest || this.playerId === null) return;
    const { world, entities, fx } = room;
    const playerId = this.playerId;
    const items: RenderItem[] = [];
    const labels: Parameters<Effects['syncLabels']>[0][number][] = [];
    const sample = room.interp.sample(now);
    const pairedIds = new Set<EntityId>();
    for (const b of this.bolts) if (b.serverId !== null) pairedIds.add(b.serverId);
    this.renderedEnemies = [];
    const trail = dt > 0 && this.frameNo % FX.trailEveryFrames === 0;
    const showAllLoot = room.input.altDown;

    if (sample) {
      for (const [id, to] of sample.to) {
        if (id === playerId) continue;
        if (to.k === 'swing' && to.owner === playerId) continue;
        if (to.k === 'projectile' && pairedIds.has(id)) continue;
        const from = sample.from.get(id) ?? to;
        const x = from.x + (to.x - from.x) * sample.t;
        const y = from.y + (to.y - from.y) * sample.t;
        const r = from.r + (to.r - from.r) * sample.t;
        const snap: EntitySnap = { ...to, x, y, r };
        if (to.k === 'enemy') this.renderedEnemies.push({ x, y, r });
        if (to.k === 'player') labels.push({ key: `p${id}`, x, y, text: to.name, color: '#cfe6ff', height: 78, className: 'fx-label' });
        if (to.k === 'loot') {
          // D2 style: good drops are always labelled, everything shows while Alt is held.
          to.names.forEach((n, i) => {
            if (!showAllLoot && n.tier !== 'rare' && n.tier !== 'relic') return;
            labels.push({ key: `l${id}-${i}`, x, y, text: n.n, color: cssColor(TIER_COLORS[n.tier]), height: 40 + i * 18, className: 'fx-label loot' });
          });
        }
        if (to.k === 'projectile' && trail) {
          const color = to.team === 'enemies' ? COLORS.enemyBullet : to.el ? ELEMENT_COLORS[to.el] : COLORS.playerProjectile;
          fx.trail(x, y, color, to.r * (to.team === 'enemies' ? 0.8 : 0.9));
        }
        items.push({ key: `s${id}`, snap, x, y, isSelf: false, isAlly: to.k === 'player' || to.k === 'minion' });
      }
    }

    const alpha = this.paused ? 1 : this.accumulator / SIM.tickMs;
    const prev = room.predictor.previous;
    const cur = room.predictor.position;
    const px = prev.x + (cur.x - prev.x) * alpha + this.visualOffset.x;
    const py = prev.y + (cur.y - prev.y) * alpha + this.visualOffset.y;

    for (const s of this.swings) {
      items.push({
        key: s.key,
        snap: { id: -1, k: 'swing', x: px, y: py, r: s.range, a: s.angle, arc: s.arc, owner: playerId },
        x: px,
        y: py,
        isSelf: false,
        isAlly: true,
      });
    }
    for (const b of this.bolts) {
      if (trail) fx.trail(b.x, b.y, COLORS.playerProjectile, b.r * 1.2);
      items.push({
        key: b.key,
        snap: { id: -1, k: 'projectile', x: b.x, y: b.y, r: b.r, team: 'players', owner: playerId, el: null, fx: 'damage' },
        x: b.x,
        y: b.y,
        isSelf: false,
        isAlly: true,
      });
    }
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
    }
    for (const p of room.def.portals) labels.push({ key: `portal-${p.x}-${p.y}`, x: p.x, y: p.y, text: p.label, color: '#e0d0ff', height: p.r * 2 + 40, className: 'fx-label portal' });

    this.playEvents(now);
    entities.render(items, dt);
    fx.syncLabels(labels);
    fx.update(dt);
    const focus = this.editor?.camera ?? { x: px, y: py };
    world.follow(focus.x, focus.y, dt);
    world.render();

    if (room.minimap && now - this.lastMinimap > MINIMAP_MS) {
      this.lastMinimap = now;
      room.minimap.update(px, py, this.latest.entities, playerId);
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
          fx.text(ev.x, ev.y, String(ev.amt), own ? 0xff4040 : ev.el ? ELEMENT_COLORS[ev.el] : 0xffffff, ev.amt >= 30);
          fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xffe0c0, 4, 90, { up: 120, size: 3, life: 0.3 });
          break;
        }
        case 'heal':
          fx.text(ev.x, ev.y, `+${ev.amt}`, COLORS.heal);
          fx.burst(ev.x, ev.y, COLORS.heal, 6, 40, { up: 90, size: 3, gravity: -60 });
          break;
        case 'death':
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
          // The own player's swing already played on input; others play it when the server says so.
          if (ev.id !== this.playerId) entities.attack(`s${ev.id}`);
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
      if (JSON.stringify(ui.stats) !== JSON.stringify(s.stats)) patch.stats = s.stats;
      const cd = Math.round(s.castCooldown * 10) / 10;
      if (ui.castCooldown !== cd) patch.castCooldown = cd;
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
        correctionPx: Math.round((room?.predictor.lastCorrection ?? 0) * 10) / 10,
        addedRttMs: netSettings.addedRttMs,
        drawCalls: room?.world.renderer.info.render.calls ?? 0,
        heat: this.latest?.self?.heat ?? 0,
        lastFizzle: this.lastFizzle,
      },
    });
  }
}
