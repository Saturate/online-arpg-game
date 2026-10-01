import {
  compileSigilItem,
  SIM,
  SKILL_BUTTONS,
  Simulation,
  STARTER_SIGILS,
  serializeEntities,
  sigilCastDelay,
  type ClassId,
  type EnemyTypeId,
  type EntityId,
  type EntitySnap,
  type GameEvent,
  type MapDescriptor,
  type TownLayout,
  type WorldMap,
} from '@rune/shared';
import { EntityRenderer, type RenderItem } from '../../render/entities.js';
import { Effects } from '../../render/fx.js';
import { playFxEvent, type FxEventContext } from '../../render/fxEvents.js';
import { WorldScene } from '../../render/scene.js';
import type { VfxQuality } from '../../render/vfx/quality.js';
import { studioSigil, studioSkillOf, type StudioSkill } from '../studio/studioSim.js';

/** One caster: a held skill in slot 1 and, optionally, a persistent one (aura or bond) in slot 2. */
interface CasterDef {
  skill: string;
  persistent?: string;
  /** Where the caster stands, relative to the pack centre. */
  at: { x: number; y: number };
}

export interface BenchScene {
  id: string;
  label: string;
  casters: CasterDef[];
  monsters: number;
  /** Another map than the wilds, for looking at the world's own fires; `town` takes the live town layout. */
  map?: 'town' | MapDescriptor;
  /** Where the camera looks on that map. */
  focus?: (def: WorldMap) => { x: number; y: number };
}

/** Starter skill ids, or rune text for anything that is not a starter. */
const SCENES: readonly BenchScene[] = [
  {
    id: 'crowd',
    label: '8 casters, 120 monsters',
    monsters: 120,
    casters: [
      { skill: 'frozen_orb', at: { x: -330, y: -150 } },
      { skill: 'frozen_orb', at: { x: -360, y: 0 } },
      { skill: 'frozen_orb', at: { x: -330, y: 150 } },
      { skill: 'fireball', at: { x: -300, y: -75 } },
      { skill: 'fireball', at: { x: -300, y: 75 } },
      { skill: 'fireball', at: { x: -390, y: -250 } },
      { skill: 'frost_mire', at: { x: -390, y: 250 } },
      { skill: 'zone[+75% duration] fire', at: { x: -250, y: 0 } },
    ],
  },
  { id: 'still', label: 'The same 120 monsters, no spells: the baseline', monsters: 120, casters: [] },
  {
    id: 'fire',
    label: 'Fire',
    monsters: 20,
    casters: [
      { skill: 'fireball', at: { x: -300, y: -120 } },
      { skill: 'flame_cleave', at: { x: -240, y: 40 } },
      { skill: 'zone[+75% duration] fire', at: { x: -300, y: 150 } },
      { skill: 'corpse_blast', persistent: 'aura fire', at: { x: 30, y: -150 } },
    ],
  },
  {
    id: 'cold',
    label: 'Cold',
    monsters: 20,
    casters: [
      { skill: 'frozen_orb', at: { x: -300, y: -120 } },
      { skill: 'freezing_arrow', at: { x: -280, y: 40 } },
      { skill: 'frost_mire', at: { x: -300, y: 160 } },
      { skill: 'nova[+50% size] cold', persistent: 'aura cold', at: { x: 30, y: -150 } },
    ],
  },
  {
    id: 'lightning',
    label: 'Lightning',
    monsters: 20,
    casters: [
      { skill: 'orb[onhit] lightning nova', at: { x: -300, y: -120 } },
      { skill: 'smite', at: { x: -260, y: 40 } },
      { skill: 'zone[+75% duration] lightning', at: { x: -300, y: 160 } },
      { skill: 'static_nova', persistent: 'aura lightning', at: { x: 30, y: -150 } },
    ],
  },
  {
    id: 'plain',
    label: 'Plain, impact and dash',
    monsters: 20,
    casters: [
      { skill: 'bone_spear', at: { x: -300, y: -120 } },
      { skill: 'orb[onhit] nova', at: { x: -280, y: 20 } },
      { skill: 'zone[+75% duration]', at: { x: -300, y: 160 } },
      { skill: 'war_cry', at: { x: 30, y: -150 } },
      { skill: 'blink', at: { x: -120, y: 220 } },
    ],
  },
  {
    id: 'support',
    label: 'Restore, ward, aura and bond',
    monsters: 12,
    casters: [
      { skill: 'sanctuary', persistent: 'prayer', at: { x: -260, y: -60 } },
      { skill: 'holy_nova', persistent: 'iron_skin', at: { x: -200, y: 110 } },
      { skill: 'zone[+75% duration] ward', persistent: 'soul_link', at: { x: -380, y: 60 } },
      { skill: 'bolt[onhit] fire zone ward', at: { x: -330, y: 200 } },
    ],
  },
  {
    // Casters stand on the nearest road, so every ground effect lies over a road patch: ground
    // effects must draw above roads (RENDER_ORDER in render/config.ts).
    id: 'road',
    label: 'Ground effects on a road',
    monsters: 8,
    casters: [
      { skill: 'zone[+75% duration] fire', at: { x: 0, y: 0 } },
      { skill: 'frost_mire', at: { x: 0, y: 0 } },
      { skill: 'zone[+75% duration] lightning', at: { x: 0, y: 0 } },
      { skill: 'sanctuary', persistent: 'aura cold', at: { x: 0, y: 0 } },
      { skill: 'war_cry', at: { x: 0, y: 0 } },
    ],
  },
  // World fires, no spells: the town square with its lamps and the forge, the wilds camp fire, a torch-lit dungeon room.
  { id: 'town-fires', label: 'Town square: lamps and the forge fire', monsters: 0, casters: [], map: 'town', focus: (def) => ({ x: def.spawn.x + 60, y: def.spawn.y - 110 }) },
  { id: 'camp-fire', label: 'The wilds camp fire', monsters: 0, casters: [], focus: (def) => ({ x: def.spawn.x + 40, y: def.spawn.y + 60 }) },
  {
    id: 'dungeon-fires',
    label: 'A torch-lit dungeon room',
    monsters: 0,
    casters: [],
    map: { kind: 'dungeon', run: 0, seed: 4242, level: 3 },
    focus: (def) => {
      // Between the two torches of one room, so both are on screen.
      const a = def.lamps?.[2] ?? def.spawn;
      const b = def.lamps?.[3] ?? a;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    },
  },
];

export const BENCH_SCENES = SCENES;

/** Monsters that stand and fight without summoning more, with a few archers for enemy bullets. */
const DUMMY_TYPES: readonly EnemyTypeId[] = ['grave_brute', 'plague_rat', 'dire_wolf', 'ghoul', 'bandit_archer', 'cave_spider', 'tusked_boar', 'bone_archer', 'lizardman', 'ogre'];
const DUMMY_LIFE = 1e9;
/** Recorded ticks after the warm-up; the playback loops over them. */
const RECORD_TICKS = 240;
const WARMUP_TICKS = 60;

interface Frame {
  entities: Map<EntityId, EntitySnap>;
  events: GameEvent[];
}

export interface VfxBenchResult {
  scene: string;
  frames: number;
  drawCalls: number;
  triangles: number;
  /** Mean CPU milliseconds per frame in EntityRenderer.render. */
  entitiesMs: number;
  /** Mean CPU milliseconds per frame in effect events and Effects.update. */
  fxMs: number;
  /** Mean CPU milliseconds per frame in WorldScene.render. */
  renderMs: number;
  frameMs: number;
  /** Mean JS heap growth per frame in bytes, counting only rises. Chrome only. */
  heapPerFrame: number | null;
  spells: number;
  /** Mean live particles, both layers. */
  particles: number;
  quality: VfxQuality;
}

interface ChromeMemory {
  usedJSHeapSize: number;
}

function heapNow(): number | null {
  const perf: Performance & { memory?: ChromeMemory } = performance;
  return perf.memory ? perf.memory.usedJSHeapSize : null;
}

function skillOf(ref: string): StudioSkill {
  const starter = STARTER_SIGILS.find((s) => s.id === ref);
  if (starter) return studioSkillOf(starter);
  const classId: ClassId = 'mage';
  return { id: 'bench', name: 'Bench', description: '', classId, text: ref };
}

/**
 * A recorded fight for measuring and looking at spell effects: the shared simulation plays a scene
 * of god-mode casters holding their skills into pinned, unkillable monsters on the wilds map, once,
 * up front. The recording then loops through the game's own EntityRenderer, Effects and event
 * visuals, so the simulation costs nothing per frame and every run of a scene draws the same thing.
 */
export class VfxBench {
  readonly world: WorldScene;
  readonly entities: EntityRenderer;
  readonly fx: Effects;
  readonly scene: BenchScene;
  private readonly frames: Frame[] = [];
  private readonly ctx: FxEventContext;
  private readonly centre: { x: number; y: number };
  private raf = 0;
  private last = performance.now();
  private clock = 0;
  private played = -1;
  private sample: { frames: number; entities: number; fx: number; render: number; wall: number; heap: number; calls: number; tris: number; spells: number; particles: number; lastHeap: number | null; done: (r: VfxBenchResult) => void; want: number } | null = null;
  paused = false;
  private roadFocus: { x: number; y: number } | null = null;
  /** Camera offset from the default framing and zoom, for close-up screenshots. */
  readonly view = { dx: 0, dy: 0, zoom: 1 };

  constructor(host: HTMLElement, fxLayer: HTMLElement, sceneId: string, town?: TownLayout) {
    this.scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0] ?? { id: 'none', label: 'none', casters: [], monsters: 0 };
    const map: MapDescriptor = this.scene.map === 'town' ? { kind: 'world', seed: 7, ...(town ? { layout: town } : {}) } : (this.scene.map ?? { kind: 'wilds', seed: 7 });
    const sim = new Simulation(7, map, { waves: false });
    this.world = new WorldScene(host, sim.mapDef, sim.zone);
    this.fx = new Effects(this.world.scene, this.world, fxLayer);
    this.entities = new EntityRenderer(this.world.scene, this.world.camera, this.fx.vfx);
    this.ctx = { fx: this.fx, entities: this.entities, selfId: null, damageNumbers: false, shake: () => {} };
    this.centre = sim.map.findOpen(sim.mapDef.width / 2, sim.mapDef.height / 2, 200);
    if (this.scene.focus) this.roadFocus = this.scene.focus(sim.mapDef);
    this.record(sim);
    this.raf = requestAnimationFrame(this.loop);
  }

  private record(sim: Simulation): void {
    const w = sim.world;
    for (const id of [...w.enemy.keys()]) w.destroy(id);
    w.flushDestroyed();
    const { x: cx, y: cy } = this.centre;
    const dummies: { id: EntityId; x: number; y: number }[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.scene.monsters; i++) {
      const r = 30 * Math.sqrt(i);
      const type = DUMMY_TYPES[i % DUMMY_TYPES.length] ?? 'ghoul';
      const id = sim.spawnEnemy(type, cx + 60 + Math.cos(i * golden) * r, cy + Math.sin(i * golden) * r);
      const h = w.health.get(id);
      if (h) {
        h.maxLife = DUMMY_LIFE;
        h.life = DUMMY_LIFE;
      }
      const at = w.position.get(id);
      if (at) dummies.push({ id, x: at.x, y: at.y });
    }
    const casters: { id: EntityId; x: number; y: number; hasPersistent: boolean }[] = [];
    const road = this.scene.id === 'road' ? nearestRoad(sim, cx, cy) : null;
    if (road) this.roadFocus = { x: (road.ax + road.bx) / 2, y: (road.ay + road.by) / 2 };
    this.scene.casters.forEach((c, i) => {
      const skill = skillOf(c.skill);
      const along = (i + 0.5) / this.scene.casters.length;
      const at = road ? { x: road.ax + (road.bx - road.ax) * along, y: road.ay + (road.by - road.ay) * along } : { x: cx + c.at.x, y: cy + c.at.y };
      const id = sim.addPlayer(`bench${i}`, skill.classId, `Caster ${i + 1}`, undefined, at);
      const p = w.player.get(id);
      const pos = w.position.get(id);
      if (!p || !pos) return;
      p.god = true;
      p.warband = [null, null, null, null];
      p.sigils = [null, null, null, null];
      const sigil = studioSigil(skill);
      if (sigil) p.sigils[0] = { uid: -1 - i * 2, compiled: compileSigilItem(sigil, skill.classId), misfireMultiplier: 1, castDelay: sigilCastDelay(sigil) };
      if (c.persistent) {
        const ps = skillOf(c.persistent);
        const psigil = studioSigil(ps);
        if (psigil) p.sigils[1] = { uid: -2 - i * 2, compiled: compileSigilItem(psigil, ps.classId), misfireMultiplier: 1, castDelay: sigilCastDelay(psigil) };
      }
      casters.push({ id, x: pos.x, y: pos.y, hasPersistent: c.persistent !== undefined });
    });

    const bit0 = SKILL_BUTTONS[0] ?? 0;
    const bit1 = SKILL_BUTTONS[1] ?? 0;
    let seq = 0;
    for (let tick = 0; tick < WARMUP_TICKS + RECORD_TICKS; tick++) {
      seq++;
      casters.forEach((c, i) => {
        const p = w.player.get(c.id);
        if (p) p.heat = 0;
        // A bond looks for the nearest ally in its cone; aim it at the next caster once, on press.
        const next = casters[(i + 1) % casters.length] ?? c;
        const bondAim = Math.atan2(next.y - c.y, next.x - c.x);
        const aim = Math.atan2(cy - c.y, cx + 60 - c.x) + Math.sin(tick * 0.05 + i) * 0.25;
        const pressBond = c.hasPersistent && tick % 40 === 1;
        sim.applyInput(c.id, { seq, moveDir: { x: 0, y: 0 }, aimAngle: pressBond ? bondAim : aim, buttons: pressBond ? bit1 : bit0 });
      });
      sim.waveTimer = Infinity;
      sim.step();
      for (const d of dummies) {
        const pos = w.position.get(d.id);
        if (pos) {
          pos.x = d.x;
          pos.y = d.y;
        }
        const h = w.health.get(d.id);
        if (h) h.life = h.maxLife;
        const e = w.enemy.get(d.id);
        if (e) {
          e.knockX = 0;
          e.knockY = 0;
        }
      }
      for (const c of casters) {
        const p = w.player.get(c.id);
        const pos = w.position.get(c.id);
        if (p && pos && p.dash === null && p.dashSpell === null && tick % 30 === 0) {
          pos.x = c.x;
          pos.y = c.y;
        }
      }
      const events = sim.takeEvents().map((e) => e.ev);
      if (tick < WARMUP_TICKS) continue;
      this.frames.push({ entities: new Map(serializeEntities(sim).map((e) => [e.id, e])), events });
    }
  }

  private readonly loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const wall = now - this.last;
    const dt = Math.min(0.1, wall / 1000);
    this.last = now;
    if (!this.paused) this.clock += dt;
    const total = this.frames.length;
    if (total < 2) return;
    const pos = this.clock / SIM.dt;
    const index = Math.floor(pos) % (total - 1);
    const t = pos - Math.floor(pos);
    const from = this.frames[index];
    const to = this.frames[index + 1];
    if (!from || !to) return;

    const t0 = performance.now();
    if (index !== this.played) {
      // Looping back replays from the start; skipping ticks still plays every event once.
      let i = this.played < 0 || index < this.played ? index : this.played + 1;
      for (; i <= index; i++) for (const ev of this.frames[i]?.events ?? []) playFxEvent(ev, this.ctx);
      this.played = index;
    }
    const items: RenderItem[] = [];
    let spells = 0;
    for (const [id, snapTo] of to.entities) {
      const prev = from.entities.get(id) ?? snapTo;
      const x = prev.x + (snapTo.x - prev.x) * t;
      const y = prev.y + (snapTo.y - prev.y) * t;
      const r = prev.r + (snapTo.r - prev.r) * t;
      if (snapTo.k === 'projectile' || snapTo.k === 'nova' || snapTo.k === 'zone') spells++;
      items.push({ key: `s${id}`, snap: { ...snapTo, x, y, r }, x, y, isSelf: false, isAlly: snapTo.k === 'player' || snapTo.k === 'minion' });
    }
    const t1 = performance.now();
    this.entities.render(items, dt);
    const t2 = performance.now();
    this.fx.update(dt);
    const t3 = performance.now();
    if (this.world.camera.zoom !== this.view.zoom) this.world.setZoom(this.view.zoom);
    const f = this.roadFocus ?? { x: this.centre.x - 110, y: this.centre.y };
    this.world.follow(f.x + this.view.dx, f.y + this.view.dy, dt);
    this.world.render();
    const t4 = performance.now();

    const s = this.sample;
    if (!s) return;
    const info = this.world.renderer.info.render;
    s.frames++;
    s.fx += t1 - t0 + (t3 - t2);
    s.entities += t2 - t1;
    s.render += t4 - t3;
    s.wall += wall;
    s.calls += info.calls;
    s.tris += info.triangles;
    s.spells += spells;
    s.particles += this.fx.vfx.particleCount;
    const heap = heapNow();
    if (heap !== null && s.lastHeap !== null && heap > s.lastHeap) s.heap += heap - s.lastHeap;
    s.lastHeap = heap;
    if (s.frames >= s.want) {
      this.sample = null;
      s.done({
        scene: this.scene.id,
        frames: s.frames,
        drawCalls: Math.round(s.calls / s.frames),
        triangles: Math.round(s.tris / s.frames),
        entitiesMs: s.entities / s.frames,
        fxMs: s.fx / s.frames,
        renderMs: s.render / s.frames,
        frameMs: s.wall / s.frames,
        heapPerFrame: heap === null ? null : Math.round(s.heap / s.frames),
        spells: Math.round(s.spells / s.frames),
        particles: Math.round(s.particles / s.frames),
        quality: this.fx.vfx.quality,
      });
    }
  };

  measure(frames: number): Promise<VfxBenchResult> {
    return new Promise((done) => {
      this.sample = { frames: 0, entities: 0, fx: 0, render: 0, wall: 0, heap: 0, calls: 0, tris: 0, spells: 0, particles: 0, lastHeap: heapNow(), done, want: frames };
    });
  }

  setQuality(q: VfxQuality): void {
    this.fx.setQuality(q);
  }

  /** Jumps the playback to a recorded second, for screenshots. */
  seek(seconds: number): void {
    this.clock = seconds;
    this.played = -1;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.entities.render([], 0);
    this.fx.dispose();
    this.world.dispose();
  }
}

/** The road segment nearest a point, as its end points. */
function nearestRoad(sim: Simulation, x: number, y: number): { ax: number; ay: number; bx: number; by: number } | null {
  let best: { ax: number; ay: number; bx: number; by: number } | null = null;
  let bestD = Infinity;
  for (const g of sim.mapDef.ground) {
    const s = g.shape;
    if (g.kind !== 'road' || s.type !== 'capsule') continue;
    const d = Math.hypot((s.ax + s.bx) / 2 - x, (s.ay + s.by) / 2 - y);
    if (d < bestD) {
      bestD = d;
      best = { ax: s.ax, ay: s.ay, bx: s.bx, by: s.by };
    }
  }
  return best;
}
