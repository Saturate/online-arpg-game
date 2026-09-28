import { SIM, serializeEntities, type EntitySnap, type GameEvent } from '@rune/shared';
import { COLORS, ELEMENT_COLORS } from '../../render/config.js';
import { EntityRenderer, type RenderItem } from '../../render/entities.js';
import { Effects } from '../../render/fx.js';
import { WorldScene } from '../../render/scene.js';
import type { StudioSim } from './studioSim.js';

/** Floating numbers past this per tick turn into an unreadable wall; the metrics carry the totals. */
const MAX_TEXTS_PER_TICK = 10;
/** Frames can stall (tab in background); never try to catch up more than this many ticks at once. */
const MAX_STEPS_PER_FRAME = 16;
const ZOOM = 0.85;

/**
 * Draws a local StudioSim with the game's own renderer. There is no network, so entities are
 * interpolated between the last two local ticks instead of a server buffer.
 */
export class StudioView {
  readonly world: WorldScene;
  private readonly entities: EntityRenderer;
  private readonly fx: Effects;
  private prev = new Map<number, EntitySnap>();
  private cur = new Map<number, EntitySnap>();
  private accumulator = 0;
  private last = performance.now();
  private frame = 0;
  playing = true;
  timeScale = 1;
  /** Called after each simulation tick, so the UI can refresh on its own schedule. */
  onTick: (() => void) | null = null;

  constructor(
    private studio: StudioSim,
    host: HTMLElement,
    fxLayer: HTMLElement,
  ) {
    this.world = new WorldScene(host, studio.sim.mapDef);
    this.world.setZoom(ZOOM);
    this.entities = new EntityRenderer(this.world.scene, this.world.camera);
    this.fx = new Effects(this.world.scene, this.world, fxLayer);
    this.capture();
    this.capture();
    this.frame = requestAnimationFrame(this.loop);
  }

  /** A reset keeps the scene (the map is always the same flat field) and swaps the simulation. */
  swap(studio: StudioSim): void {
    this.studio = studio;
    this.prev.clear();
    this.cur.clear();
    this.capture();
    this.capture();
    this.accumulator = 0;
  }

  stepOnce(): void {
    this.tick();
    this.accumulator = 0;
  }

  groundAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.world.canvas.getBoundingClientRect();
    return this.world.screenToGround(clientX - r.left, clientY - r.top);
  }

  private capture(): void {
    this.prev = this.cur;
    this.cur = new Map(serializeEntities(this.studio.sim).map((e) => [e.id, e]));
  }

  private tick(): void {
    this.studio.step();
    this.capture();
    this.playEvents(this.studio.lastEvents);
    this.onTick?.();
  }

  private readonly loop = (now: number): void => {
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.playing) {
      this.accumulator += dt * this.timeScale;
      let steps = 0;
      while (this.accumulator >= SIM.dt && steps < MAX_STEPS_PER_FRAME) {
        this.accumulator -= SIM.dt;
        this.tick();
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    }
    this.draw(this.playing ? this.accumulator / SIM.dt : 1, dt);
  };

  private draw(t: number, dt: number): void {
    const items: RenderItem[] = [];
    const playerId = this.studio.playerId;
    for (const [id, to] of this.cur) {
      const from = this.prev.get(id) ?? to;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const r = from.r + (to.r - from.r) * t;
      items.push({ key: `s${id}`, snap: { ...to, x, y, r }, x, y, isSelf: id === playerId, isAlly: to.k === 'player' || to.k === 'minion' });
    }
    this.entities.render(items, dt);
    this.fx.update(dt);
    const home = this.studio.home;
    this.world.follow(home.x + 120, home.y, dt);
    this.world.render();
  }

  private playEvents(events: readonly GameEvent[]): void {
    let texts = 0;
    for (const ev of events) {
      switch (ev.e) {
        case 'dmg': {
          this.entities.flash(`s${ev.id}`);
          if (ev.id === this.studio.playerId || ev.amt < 1) break;
          const color = ev.el ? ELEMENT_COLORS[ev.el] : 0xffffff;
          if (texts++ < MAX_TEXTS_PER_TICK) this.fx.text(ev.x, ev.y, String(ev.amt), color, ev.amt >= 30);
          this.fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xffe0c0, 3, 90, { up: 120, size: 3, life: 0.3 });
          break;
        }
        case 'heal':
          this.fx.text(ev.x, ev.y, `+${ev.amt}`, COLORS.heal);
          break;
        case 'fizzle':
          this.fx.burst(ev.x, ev.y, ev.why === 'misfire' ? 0xff5030 : 0x999999, 14, 80, { up: 60, size: 6, gravity: -30, life: 0.7 });
          this.fx.text(ev.x, ev.y - 20, ev.why === 'misfire' ? 'misfire' : `dud: ${ev.reason ?? '?'}`, ev.why === 'misfire' ? 0xff5030 : 0xaaaaaa);
          break;
        case 'explode':
          this.fx.shockwave(ev.x, ev.y, ev.r, 0xff8a3a, 0.4);
          this.fx.burst(ev.x, ev.y, 0xff8a3a, 30, 260);
          break;
        case 'cast':
          this.entities.attack(`s${ev.id}`);
          this.fx.burst(ev.x, ev.y, ev.el ? ELEMENT_COLORS[ev.el] : 0xd0d8ff, 8, 70, { up: 140, size: 3, life: 0.35 });
          break;
        case 'attack':
          this.entities.attack(`s${ev.id}`);
          break;
        case 'death':
        case 'pickup':
          break;
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.fx.dispose();
    this.world.dispose();
  }
}
