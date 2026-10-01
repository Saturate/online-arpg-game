/**
 * Headless skill strength measurement, written against plain sim APIs so it can measure any sigil
 * the engine can run (v1 skills today, v2-compiled spells after the rune rework).
 *
 * Setup, identical for every skill:
 * - `new Simulation(seed, { kind: 'flat' })` with seed 1337 and arena waves disabled every tick.
 * - One level-1 player of the given class, god mode on so enemy hits never interrupt casting.
 *   All gear is unequipped and stats recomputed, so only class base stats apply (damageMult 1,
 *   castSpeedMult 1, heatMax 1000). The warband is emptied so no minions spawn and deal damage.
 * - The skill under test sits alone in sigil slot 0; `equip` builds it, so the harness never knows
 *   which rune system compiled it.
 * - Dummies are `chaser` enemies with 1e9 life that are pinned in place every tick (position,
 *   knockback and speed zeroed). Damage is read as life lost per tick, then life is topped back up,
 *   so no dummy ever dies and the sum is exact rather than the rounded `dmg` event amounts.
 *   Ailments (chill, shock) stay on the dummies, since they are part of a skill's strength.
 * - The target point is `distance` units east of the player (250 by default; callers pass a short
 *   distance for spells that go off on the caster). One dummy sits on it for `single`, a sunflower
 *   pack of 6 around it for `pack` (same layout as the Spell Studio, dummies within 64 units of the target).
 * - Casts go off every 7 ticks (0.35 s, `castCooldown`), not at the game's admin setting. The v1
 *   baseline was recorded at that cadence (a 0.3 s cooldown that waited seven ticks through a float
 *   remainder) and Force pricing was balanced against it, so the harness compares strength per cast
 *   at a fixed cadence whatever the live server's cooldown is.
 * - The skill button is held every tick while Force is at or below the bar, and released above it.
 *   That honours the sim's cast cooldown, Force cost and overheat cap, and never risks a misfire,
 *   which would spend a cast on self damage and make the numbers depend on the misfire roll.
 * - The player snaps back home after each dash, so dashes and leaps cast from the same spot.
 */
import {
  SIM,
  SKILL_BUTTONS,
  Simulation,
  computeStats,
  type ClassId,
  type EntityId,
  type EquippedSigil,
  type GearSlot,
} from '../../src/index.js';
import { pendingReleases } from '../../src/sim/spells.js';

export type EquipSkill = (sim: Simulation, playerId: EntityId) => EquippedSigil;

export type SkillKind = 'damage' | 'movement' | 'persistent' | 'support';

export interface SkillDpsOptions {
  classId: ClassId;
  equip: EquipSkill;
  seed?: number;
  distance?: number;
  seconds?: number;
  packSize?: number;
  /** Global cast cooldown in seconds; the v1 cadence unless a test asks for another. */
  castCooldown?: number;
}

export interface SkillDpsResult {
  kind: SkillKind;
  /** Player to target point, in world units. */
  distance: number;
  /** Force charged by one cast, as the sim applies it. Null for persistent skills. */
  forcePerCast: number | null;
  /** Spirit reserved while equipped. Null for everything that is cast. */
  spiritReserved: number | null;
  /** How far one cast moves the player on an empty map. Null when it does not move them. */
  dashDistance: number | null;
  /** Casts that went off in the `single` run, as a check on the cast rate. */
  casts: number | null;
  single: number | null;
  pack: number | null;
  perCast: number | null;
  /** Most of the caster's projectiles, novas and zones alive at once in the `pack` run. */
  peakEntities: number | null;
}

export const HARNESS_DEFAULTS = { seed: 1337, distance: 250, seconds: 10, packSize: 6, castCooldown: 0.35 } as const;

/** Matches the Spell Studio's pack spacing, so harness and studio numbers line up. */
const DUMMY_SPACING = 46;
const DUMMY_LIFE = 1e9;
/** Upper bound for "run until everything it spawned is gone", so a runaway spell cannot hang a test. */
const DRAIN_LIMIT_SECONDS = 30;

interface Bench {
  sim: Simulation;
  pid: EntityId;
  home: { x: number; y: number };
  dummies: { id: EntityId; x: number; y: number }[];
  seq: number;
}

const NO_GEAR: Record<GearSlot, null> = {
  weapon: null,
  helmet: null,
  body: null,
  gloves: null,
  boots: null,
  belt: null,
  amulet: null,
  ring1: null,
  ring2: null,
};

function setup(opts: Required<SkillDpsOptions>, dummyCount: number): Bench {
  const sim = new Simulation(opts.seed, { kind: 'flat' });
  sim.setRates({ ...sim.rates, castCooldown: opts.castCooldown });
  sim.waveTimer = Infinity;
  const pid = sim.addPlayer('baseline', opts.classId, 'Baseline');
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  const h = w.health.get(pid);
  if (!p || !pos || !h) throw new Error('harness player missing');
  p.god = true;
  p.warband = p.warband.map(() => null);
  p.gear = { ...NO_GEAR };
  p.stats = computeStats(p, sim.rates.forceMax);
  h.maxLife = p.stats.maxLife;
  h.life = h.maxLife;
  p.sigils = [opts.equip(sim, pid), null, null, null];

  const home = { x: pos.x, y: pos.y };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dummies: Bench['dummies'] = [];
  for (let i = 0; i < dummyCount; i++) {
    const r = DUMMY_SPACING * 0.62 * Math.sqrt(i);
    const id = sim.spawnEnemy('chaser', home.x + opts.distance + Math.cos(i * golden) * r, home.y + Math.sin(i * golden) * r);
    const dh = w.health.get(id);
    const at = w.position.get(id);
    if (!dh || !at) throw new Error('harness dummy missing');
    dh.maxLife = DUMMY_LIFE;
    dh.life = DUMMY_LIFE;
    dummies.push({ id, x: at.x, y: at.y });
  }
  return { sim, pid, home, dummies, seq: 0 };
}

function liveEntities(b: Bench): number {
  const w = b.sim.world;
  let n = 0;
  for (const [id, pr] of w.projectile) if (pr.ownerId === b.pid && w.isAlive(id)) n++;
  for (const [id, nv] of w.nova) if (nv.spell.casterId === b.pid && w.isAlive(id)) n++;
  for (const [id, z] of w.zone) if (z.spell.casterId === b.pid && w.isAlive(id)) n++;
  return n;
}

/** Live entities plus payloads still waiting to go off, so a single cast is measured to its end. */
function castInFlight(b: Bench): boolean {
  return liveEntities(b) > 0 || pendingReleases(b.sim, b.pid) > 0;
}

function dashing(b: Bench): boolean {
  const p = b.sim.world.player.get(b.pid);
  return p !== undefined && (p.dash !== null || p.dashSpell !== null);
}

interface TickResult {
  damage: number;
  casts: number;
  heatSpent: number;
}

/** One tick: input, step, then read damage and re-pin everything. `pinPlayer` false lets a dash run free. */
function tick(b: Bench, cast: boolean, pinPlayer = true): TickResult {
  const { sim, pid } = b;
  const w = sim.world;
  const p = w.player.get(pid);
  const pos = w.position.get(pid);
  if (!p || !pos) throw new Error('harness player missing');
  // Every target sits due east of home, so the aim angle is always 0.
  const aim = 0;
  const heatBefore = p.heat;
  sim.applyInput(pid, { seq: ++b.seq, moveDir: { x: 0, y: 0 }, aimAngle: aim, buttons: cast ? (SKILL_BUTTONS[0] ?? 0) : 0 });
  const heatSpent = Math.max(0, p.heat - heatBefore);
  sim.waveTimer = Infinity;
  sim.step();

  let damage = 0;
  for (const d of b.dummies) {
    const h = w.health.get(d.id);
    const at = w.position.get(d.id);
    const e = w.enemy.get(d.id);
    if (!h || !at || !e || !w.isAlive(d.id)) throw new Error('harness dummy died');
    damage += h.maxLife - h.life;
    h.life = h.maxLife;
    at.x = d.x;
    at.y = d.y;
    e.knockX = 0;
    e.knockY = 0;
    e.speedMult = 0;
  }
  let casts = 0;
  for (const { ev } of sim.takeEvents()) if (ev.e === 'cast' && ev.id === pid) casts++;
  if (pinPlayer && !dashing(b)) {
    pos.x = b.home.x;
    pos.y = b.home.y;
  }
  return { damage, casts, heatSpent };
}

function canCastWithoutMisfire(b: Bench): boolean {
  const p = b.sim.world.player.get(b.pid);
  return p !== undefined && p.heat <= p.stats.heatMax;
}

function sustained(opts: Required<SkillDpsOptions>, dummyCount: number): { damage: number; casts: number; peak: number } {
  const b = setup(opts, dummyCount);
  let damage = 0;
  let casts = 0;
  let peak = 0;
  for (let t = 0; t < opts.seconds * SIM.tickRate; t++) {
    const r = tick(b, canCastWithoutMisfire(b));
    damage += r.damage;
    casts += r.casts;
    peak = Math.max(peak, liveEntities(b));
  }
  return { damage, casts, peak };
}

function singleCast(opts: Required<SkillDpsOptions>, dummyCount: number): { damage: number; force: number } {
  const b = setup(opts, dummyCount);
  const first = tick(b, true);
  let damage = first.damage;
  for (let t = 0; t < DRAIN_LIMIT_SECONDS * SIM.tickRate && (castInFlight(b) || dashing(b)); t++) damage += tick(b, false).damage;
  return { damage, force: first.heatSpent };
}

function dashDistance(opts: Required<SkillDpsOptions>): number {
  const b = setup(opts, 0);
  tick(b, true, false);
  for (let t = 0; t < DRAIN_LIMIT_SECONDS * SIM.tickRate && dashing(b); t++) tick(b, false, false);
  const pos = b.sim.world.position.get(b.pid);
  return pos ? Math.hypot(pos.x - b.home.x, pos.y - b.home.y) : 0;
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function measureSkill(options: SkillDpsOptions): SkillDpsResult {
  const opts: Required<SkillDpsOptions> = { ...HARNESS_DEFAULTS, ...options };
  const probe = setup(opts, 0);
  const compiled = probe.sim.world.player.get(probe.pid)?.sigils[0]?.compiled;
  if (!compiled) throw new Error('equip did not produce a sigil');
  if (!compiled.ok) throw new Error(`skill does not compile: ${compiled.errors.map((e) => e.message).join('; ')}`);
  if (compiled.persistent) {
    return {
      kind: 'persistent',
      distance: opts.distance,
      forcePerCast: null,
      spiritReserved: compiled.spirit,
      dashDistance: null,
      casts: null,
      single: null,
      pack: null,
      perCast: null,
      peakEntities: null,
    };
  }

  const single = sustained(opts, 1);
  const pack = sustained(opts, opts.packSize);
  const once = singleCast(opts, opts.packSize);
  const moved = dashDistance(opts);
  // Anything under a player radius is jitter from collision, not a dash.
  const dash = moved > SIM.playerRadius ? round(moved) : null;
  const dealsDamage = single.damage + pack.damage + once.damage > 0;
  // A dash that spawns nothing is movement even though its contact hit deals a little damage.
  const kind: SkillKind = dash !== null && pack.peak === 0 ? 'movement' : dealsDamage ? 'damage' : 'support';
  return {
    kind,
    distance: opts.distance,
    forcePerCast: round(once.force),
    spiritReserved: null,
    dashDistance: dash,
    casts: single.casts,
    single: dealsDamage ? round(single.damage) : null,
    pack: dealsDamage ? round(pack.damage) : null,
    perCast: dealsDamage ? round(once.damage) : null,
    peakEntities: pack.peak,
  };
}
