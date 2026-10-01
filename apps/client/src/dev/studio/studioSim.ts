import {
  compileSigilItem,
  createStarterSigil,
  formatRunes,
  SIM,
  SKILL_BUTTONS,
  Simulation,
  tokenizeSpell,
  type ClassId,
  type EntityId,
  type EnemyTypeId,
  type GameEvent,
  sigilCastDelayShare,
  type SigilCompile,
  type SigilItem,
  type StarterSigilDef,
} from '@rune/shared';
import { StudioMetrics, type TickSample } from './metrics.js';

export type DummyLayout = 'pack' | 'line' | 'ring';
export type CastMode = 'hold' | 'interval' | 'manual';

export interface StudioSetup {
  seed: number;
  classId: ClassId;
  dummies: number;
  dummyType: EnemyTypeId;
  layout: DummyLayout;
  /** Distance from the player to the pack centre, or the ring radius. */
  distance: number;
}

export interface CastSettings {
  mode: CastMode;
  intervalSeconds: number;
  infiniteForce: boolean;
}

/** Dummies must never die, or the measurement turns into a kill-speed test. */
const DUMMY_LIFE = 1e9;
const DUMMY_SPACING = 46;

/** A skill being drafted: a starter sigil's fields, with its runes in the text form. */
export interface StudioSkill {
  id: string;
  name: string;
  description: string;
  classId: ClassId;
  text: string;
}

export function studioSkillOf(def: StarterSigilDef): StudioSkill {
  return { id: def.id, name: def.name, description: def.description, classId: def.classId, text: formatRunes(def.runes) };
}

/**
 * The sigil the game would hand a new character for this draft: a starter sigil holding its runes,
 * so the studio compiles it with the same slots, Force multiplier and cast delay as play does.
 */
export function studioSigil(def: StudioSkill): SigilItem | null {
  const t = tokenizeSpell(def.text);
  if (t.errors.length > 0) return null;
  let uid = 1;
  return createStarterSigil(() => uid++, { id: def.id, name: def.name, description: def.description, classId: def.classId, runes: t.runes }, { bound: true });
}

/** Compiles the draft exactly as the game compiles an equipped starter sigil. */
export function compileSkill(def: StudioSkill): SigilCompile {
  const sigil = studioSigil(def);
  if (!sigil) return { ok: false, errors: tokenizeSpell(def.text).errors, force: 0 };
  return compileSigilItem(sigil, def.classId);
}

function skillCastDelayShare(def: StudioSkill): number {
  const sigil = studioSigil(def);
  return sigil ? sigilCastDelayShare(sigil) : 1;
}

function dummyPositions(setup: StudioSetup, cx: number, cy: number): { x: number; y: number }[] {
  const n = setup.dummies;
  const out: { x: number; y: number }[] = [];
  if (setup.layout === 'ring') {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      out.push({ x: cx + Math.cos(a) * setup.distance, y: cy + Math.sin(a) * setup.distance });
    }
    return out;
  }
  if (setup.layout === 'line') {
    // Across the line of fire, so piercing and splitting shots show their spread.
    for (let i = 0; i < n; i++) out.push({ x: cx + setup.distance, y: cy + (i - (n - 1) / 2) * DUMMY_SPACING * 1.4 });
    return out;
  }
  // Pack: a sunflower spiral keeps any count evenly packed around the centre.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = DUMMY_SPACING * 0.62 * Math.sqrt(i);
    out.push({ x: cx + setup.distance + Math.cos(i * golden) * r, y: cy + Math.sin(i * golden) * r });
  }
  return out;
}

/**
 * A local, serverless simulation: one god-mode player and pinned training dummies on the flat map.
 * Everything is seeded, so the same setup and skill always produce the same numbers.
 */
export class StudioSim {
  readonly sim: Simulation;
  readonly playerId: EntityId;
  readonly metrics = new StudioMetrics();
  readonly dummies: { id: EntityId; x: number; y: number }[] = [];
  readonly home: { x: number; y: number };
  compiled: SigilCompile;
  /** The sigil's cast delay; a spell from the Spell Lab has no sigil and uses the default. */
  castDelayShare = 1;
  cast: CastSettings = { mode: 'hold', intervalSeconds: 1, infiniteForce: false };
  /** Events from the last step, for the renderer. */
  lastEvents: GameEvent[] = [];
  private seq = 0;
  private sinceCast = Infinity;
  private manualAim: number | null = null;

  constructor(
    readonly setup: StudioSetup,
    skill: StudioSkill,
  ) {
    this.sim = new Simulation(setup.seed, { kind: 'flat' });
    this.playerId = this.sim.addPlayer('studio', setup.classId, 'Studio');
    const p = this.sim.world.player.get(this.playerId);
    const pos = this.sim.world.position.get(this.playerId);
    if (!p || !pos) throw new Error('studio player missing');
    p.god = true;
    // No minions and no kit skills: only the skill under test may deal damage.
    p.warband = [null, null, null, null];
    p.sigils = [null, null, null, null];
    this.home = { x: pos.x, y: pos.y };
    for (const spot of dummyPositions(setup, pos.x, pos.y)) {
      const id = this.sim.spawnEnemy(setup.dummyType, spot.x, spot.y);
      const h = this.sim.world.health.get(id);
      if (h) {
        h.maxLife = DUMMY_LIFE;
        h.life = DUMMY_LIFE;
      }
      const at = this.sim.world.position.get(id) ?? spot;
      this.dummies.push({ id, x: at.x, y: at.y });
    }
    this.compiled = compileSkill(skill);
    this.castDelayShare = skillCastDelayShare(skill);
    this.equip();
  }

  /** Swaps the skill under test without resetting the world. Metrics restart so numbers stay honest. */
  setSkill(skill: StudioSkill): void {
    this.setCompiled(compileSkill(skill), skillCastDelayShare(skill));
  }

  /** Tests an already compiled spell, such as one from the Spell Lab. */
  setCompiled(compiled: SigilCompile, castDelayShare = 1): void {
    this.compiled = compiled;
    this.castDelayShare = castDelayShare;
    this.equip();
    this.metrics.reset();
  }

  private equip(): void {
    const p = this.sim.world.player.get(this.playerId);
    if (!p) return;
    p.sigils[0] = { uid: -1, compiled: this.compiled, misfireMultiplier: 1, castDelayShare: this.castDelayShare };
    p.sigils[1] = null;
    p.sigils[2] = null;
    p.sigils[3] = null;
  }

  /** Casts once on the next tick, aimed at a ground point. */
  castAt(x: number, y: number): void {
    this.manualAim = Math.atan2(y - this.home.y, x - this.home.x);
  }

  get heat(): number {
    return this.sim.world.player.get(this.playerId)?.heat ?? 0;
  }

  get heatMax(): number {
    return this.sim.world.player.get(this.playerId)?.stats.heatMax ?? 0;
  }

  private aimAtDummies(): number {
    if (this.setup.layout === 'ring' || this.dummies.length === 0) return 0;
    let x = 0;
    let y = 0;
    for (const d of this.dummies) {
      x += d.x;
      y += d.y;
    }
    return Math.atan2(y / this.dummies.length - this.home.y, x / this.dummies.length - this.home.x);
  }

  private buttons(): { buttons: number; aim: number } {
    const bit = SKILL_BUTTONS[0] ?? 0;
    if (this.manualAim !== null) {
      const aim = this.manualAim;
      this.manualAim = null;
      return { buttons: bit, aim };
    }
    const aim = this.aimAtDummies();
    if (this.cast.mode === 'hold') {
      // The game only fizzles a dud on a fresh press, so holding would show nothing; tap instead.
      if (!this.compiled.ok) return { buttons: this.seq % 2 === 0 ? bit : 0, aim };
      return { buttons: bit, aim };
    }
    if (this.cast.mode === 'interval' && this.sinceCast >= this.cast.intervalSeconds) {
      this.sinceCast = 0;
      return { buttons: bit, aim };
    }
    return { buttons: 0, aim };
  }

  step(): void {
    const sim = this.sim;
    const w = sim.world;
    const p = w.player.get(this.playerId);
    if (!p) return;
    this.sinceCast += SIM.dt;
    if (this.cast.infiniteForce) p.heat = 0;
    const heatBefore = p.heat;
    const { buttons, aim } = this.buttons();
    this.seq++;
    sim.applyInput(this.playerId, { seq: this.seq, moveDir: { x: 0, y: 0 }, aimAngle: aim, buttons });
    const heatSpent = Math.max(0, p.heat - heatBefore);
    // The flat map runs arena waves; dummies alone should be on the field.
    sim.waveTimer = Infinity;
    sim.step();
    this.pin();

    const events = sim.takeEvents().map((e) => e.ev);
    this.lastEvents = events;
    const dummyIds = new Set(this.dummies.map((d) => d.id));
    const sample: TickSample = { tick: sim.tick, casts: 0, hits: 0, damage: 0, explodes: 0, fizzles: 0, heatSpent, live: 0 };
    for (const ev of events) {
      if (ev.e === 'dmg' && dummyIds.has(ev.id)) {
        sample.hits++;
        sample.damage += ev.amt;
      } else if (ev.e === 'cast' && ev.id === this.playerId) sample.casts++;
      else if (ev.e === 'explode') sample.explodes++;
      else if (ev.e === 'fizzle' && ev.id === this.playerId) sample.fizzles++;
    }
    for (const [id, pr] of w.projectile) if (pr.ownerId === this.playerId && w.isAlive(id)) sample.live++;
    for (const [id, n] of w.nova) if (n.spell.casterId === this.playerId && w.isAlive(id)) sample.live++;
    for (const [id, z] of w.zone) if (z.spell.casterId === this.playerId && w.isAlive(id)) sample.live++;
    this.metrics.push(sample);
  }

  /** Dummies stay put at full life; the player returns home once a dash is over. */
  private pin(): void {
    const w = this.sim.world;
    for (const d of this.dummies) {
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
    const p = w.player.get(this.playerId);
    const pos = w.position.get(this.playerId);
    if (p && pos && p.dash === null && p.dashSpell === null) {
      pos.x = this.home.x;
      pos.y = this.home.y;
    }
  }
}
