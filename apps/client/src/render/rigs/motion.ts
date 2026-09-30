import { Box3, Euler, Frustum, Matrix4, Sphere, Vector3, type Camera, type Object3D } from 'three';
import type { AnimRole } from '../assets.js';
import { locomotionRole } from '../characters.js';
import type { Rig } from './parts.js';

/**
 * Procedural animation for the code-built monsters. Each rig plays the same roles as the KayKit
 * models (idle, walk, run, dormant as a base layer; attack, cast, shoot, awaken, spawn and death as
 * one-shots; hit as a flinch on top), picked from the same inputs with the same speed thresholds,
 * and crossfaded by weight instead of snapping. Every pose is an offset from the rig's rest pose,
 * so roles blend by adding their weighted offsets.
 *
 * All oscillations use whole multiples of one period per rig (`period`), so any window of that
 * length loops cleanly; the .glb export depends on that.
 *
 * Nothing here allocates per frame: state lives in preallocated objects on the rig.
 */

export type Gait = 'biped' | 'quad' | 'hop' | 'scurry' | 'skitter' | 'fly' | 'hover' | 'float' | 'slither' | 'bounce' | 'still' | 'crawl';

/** How an attack moves: the wind-up pose and the strike it releases into. */
export type Strike = 'bite' | 'slam' | 'claw' | 'spit' | 'cast' | 'shoot' | 'charge' | 'leap' | 'sting' | 'burst' | 'pulse' | 'chomp' | 'ram' | 'scream';

export type Death = 'topple' | 'roll' | 'curl' | 'collapse' | 'dissolve' | 'splat' | 'fall' | 'slump' | 'tip' | 'crumble';

export interface MotionProfile {
  gait: Gait;
  /** A melee touch with no telegraph. */
  contact: Strike;
  /** The telegraphed signature move. */
  ability: Strike;
  cast: Strike;
  shoot: Strike;
  death: Death;
  /** 0 light and quick to 1 slow and heavy: slows idles, shortens swings, lengthens falls. */
  weight: number;
  /** Types that sit perfectly still until woken: a stone crouch, or a shut chest. */
  dormant?: 'statue' | 'chest';
  /** Burrowers play spawn when they surface. */
  burrows?: boolean;
}

export function motion(gait: Gait, contact: Strike, death: Death, weight: number, more: Partial<MotionProfile> = {}): MotionProfile {
  return { gait, contact, ability: contact, cast: contact, shoot: contact, death, weight, ...more };
}

type Action = 'none' | 'windup' | 'strike' | 'awaken' | 'spawn';

/** One animated node: its rest transform and this frame's accumulated offsets. */
class Channel {
  rx = 0;
  ry = 0;
  rz = 0;
  px = 0;
  py = 0;
  pz = 0;
  sx = 0;
  sy = 0;
  sz = 0;
  readonly r0x: number;
  readonly r0y: number;
  readonly r0z: number;
  readonly p0x: number;
  readonly p0y: number;
  readonly p0z: number;
  readonly s0x: number;
  readonly s0y: number;
  readonly s0z: number;
  /** +1 on the +z side, -1 on the -z side, 0 in the middle. */
  readonly side: number;
  readonly phase: number;
  readonly front: boolean;
  constructor(readonly node: Object3D) {
    this.r0x = node.rotation.x;
    this.r0y = node.rotation.y;
    this.r0z = node.rotation.z;
    this.p0x = node.position.x;
    this.p0y = node.position.y;
    this.p0z = node.position.z;
    this.s0x = node.scale.x;
    this.s0y = node.scale.y;
    this.s0z = node.scale.z;
    const side: unknown = node.userData.side;
    const phase: unknown = node.userData.phase;
    this.side = typeof side === 'number' && side !== 0 ? side : node.position.z > 0.01 ? 1 : node.position.z < -0.01 ? -1 : 0;
    this.phase = typeof phase === 'number' ? phase : 0;
    this.front = node.userData.front === true;
  }
  clear(): void {
    this.rx = this.ry = this.rz = this.px = this.py = this.pz = this.sx = this.sy = this.sz = 0;
  }
  apply(): void {
    const n = this.node;
    n.rotation.set(this.r0x + this.rx, this.r0y + this.ry, this.r0z + this.rz);
    n.position.set(this.p0x + this.px, this.p0y + this.py, this.p0z + this.pz);
    n.scale.set(this.s0x * (1 + this.sx), this.s0y * (1 + this.sy), this.s0z * (1 + this.sz));
  }
}

function rot(c: Channel | null, x: number, y: number, z: number, w: number): void {
  if (!c) return;
  c.rx += x * w;
  c.ry += y * w;
  c.rz += z * w;
}

function pos(c: Channel | null, x: number, y: number, z: number, w: number): void {
  if (!c) return;
  c.px += x * w;
  c.py += y * w;
  c.pz += z * w;
}

function scl(c: Channel | null, x: number, y: number, z: number, w: number): void {
  if (!c) return;
  c.sx += x * w;
  c.sy += y * w;
  c.sz += z * w;
}

/** Base roles, crossfaded by weight. */
const IDLE = 0;
const WALK = 1;
const RUN = 2;
const DORMANT = 3;
const BASE_ROLES: readonly AnimRole[] = ['idle', 'walk', 'run', 'dormant'];

/** Swing amplitudes in radians, per gait family. */
const WALK_SWING = 0.45;
const RUN_SWING = 0.7;
/** Fastest leg cycle a gait may play, in cycles per second; tiny fast legs slide rather than blur. */
const MAX_CYCLE: Record<Gait, number> = { biped: 2.4, quad: 3.2, hop: 3, scurry: 4.5, skitter: 5, fly: 0, hover: 0, float: 0, slither: 1.6, bounce: 2.2, still: 0, crawl: 2.6 };
/** Ground covered per cycle for legless gaits, in model units. */
const GLIDE_STRIDE: Partial<Record<Gait, number>> = { hover: 5, float: 5, slither: 3.5, bounce: 2.6, fly: 6 };

const CROSSFADE = 0.2;
const STRIKE_SECONDS = 0.14;
const RECOVER_SECONDS = 0.45;
/** Contact hits have no telegraph; a short cock-back still reads as a blow. */
const QUICK_WINDUP = 0.08;
/** An attack this soon after a wind-up begins is the cast event of the same ability, not its release. */
const CAST_MARK = 0.06;
const HIT_SECONDS = 0.34;
const AWAKEN_SECONDS = 1;
const SPAWN_SECONDS = 0.9;

export interface RigMotion {
  readonly body: Channel;
  readonly head: Channel | null;
  readonly jaw: Channel | null;
  readonly armL: Channel | null;
  readonly armR: Channel | null;
  readonly legL: Channel | null;
  readonly legR: Channel | null;
  readonly tail: Channel | null;
  readonly extras: readonly Channel[];
  readonly all: readonly Channel[];
  /** Orbiting parts' current angles, advanced by activity rather than wall time. */
  readonly orbit: Float64Array;
  /** Seconds in one loop: every oscillation fits a whole number of times. */
  readonly period: number;
  /** Rest-pose extent in root space: min x, max x, min y, max y, min z, max z. */
  readonly extent: readonly [number, number, number, number, number, number];
  readonly seed: number;
  time: number;
  /** Walk cycles completed, fractional. */
  phase: number;
  readonly weights: Float64Array;
  base: number;
  action: Action;
  actionT: number;
  windupSeconds: number;
  style: Strike;
  /** The pose weight of the current action, eased in and out. */
  actionW: number;
  hitT: number;
  deathT: number;
  wasDormant: boolean;
  wasHidden: boolean;
  /** Death finished and posed: the corpse needs no more work. */
  settled: boolean;
  /** The role the rig is showing, for the gallery's label. */
  label: AnimRole;
  /** How far a pulse pushes orbiting parts out this frame. */
  push: number;
}

const box = new Box3();

function extentOf(rig: Rig): [number, number, number, number, number, number] {
  const stored: unknown = rig.root.userData.extent;
  if (Array.isArray(stored) && stored.length === 6 && stored.every((v) => typeof v === 'number')) {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = stored.filter((v): v is number => typeof v === 'number');
    return [a, b, c, d, e, f];
  }
  // An uncompiled rig (the .glb export) measures itself once.
  rig.root.updateMatrixWorld(true);
  box.setFromObject(rig.root);
  const s = rig.root.scale.x || 1;
  return [box.min.x / s, box.max.x / s, box.min.y / s, box.max.y / s, box.min.z / s, box.max.z / s];
}

function initMotion(rig: Rig, seed: number): RigMotion {
  const ch = (o: Object3D | null): Channel | null => (o ? new Channel(o) : null);
  const body = new Channel(rig.body);
  const parts = { head: ch(rig.head), jaw: ch(rig.jaw), armL: ch(rig.armL), armR: ch(rig.armR), legL: ch(rig.legL), legR: ch(rig.legR), tail: ch(rig.tail) };
  // A head that is the body itself (eyes and elementals) must not be moved twice.
  if (rig.head === rig.body) parts.head = null;
  const extras = rig.extras.map((e) => new Channel(e));
  const all = [body, ...Object.values(parts).filter((c): c is Channel => c !== null), ...extras];
  const orbit = new Float64Array(extras.length);
  extras.forEach((e, i) => {
    const o: unknown = e.node.userData.orbit;
    orbit[i] = typeof o === 'number' ? o : 0;
  });
  const weights = new Float64Array(4);
  weights[IDLE] = 1;
  return {
    body,
    ...parts,
    extras,
    all,
    orbit,
    period: 3.5 + 2.5 * rig.profile.weight,
    extent: extentOf(rig),
    seed,
    time: 0,
    phase: 0,
    weights,
    base: IDLE,
    action: 'none',
    actionT: 0,
    windupSeconds: 0,
    style: rig.profile.contact,
    actionW: 0,
    hitT: Infinity,
    deathT: -1,
    wasDormant: false,
    wasHidden: false,
    settled: false,
    label: 'idle',
    push: 0,
  };
}

function ensure(rig: Rig, seed: number): RigMotion {
  if (!rig.motion) rig.motion = initMotion(rig, seed);
  return rig.motion;
}

/** sin of `k` whole turns per period, so it loops with the rig. */
function osc(m: RigMotion, k: number, offset = 0): number {
  return Math.sin((m.time / m.period) * Math.PI * 2 * k + offset);
}

function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ---------------------------------------------------------------------------------------------
// Events

/** A telegraphed ability began; the rig holds its wind-up pose until the strike releases it. */
export function rigWindup(rig: Rig, seconds: number, kind: 'ability' | 'cast' | 'shoot' = 'ability', seed = 0): void {
  const m = ensure(rig, seed);
  if (m.deathT >= 0) return;
  m.action = 'windup';
  m.actionT = 0;
  m.windupSeconds = Math.max(0.15, seconds);
  m.style = rig.profile[kind];
  m.label = kind === 'ability' ? 'attack' : kind;
}

/** The moment an attack lands. Releases a held wind-up, or plays a quick blow. */
export function rigAttack(rig: Rig, seed = 0): void {
  const m = ensure(rig, seed);
  if (m.deathT >= 0) return;
  if (m.action === 'windup') {
    if (m.actionT < CAST_MARK) {
      // The cast event of an ability that is still winding up: raise the hands for it.
      m.style = rig.profile.cast;
      m.label = 'cast';
      return;
    }
    m.action = 'strike';
    m.actionT = 0;
    return;
  }
  m.action = 'strike';
  m.actionT = -QUICK_WINDUP;
  m.style = rig.profile.contact;
  m.label = 'attack';
}

export function rigHit(rig: Rig, seed = 0): void {
  const m = ensure(rig, seed);
  if (m.deathT < 0) m.hitT = 0;
}

/** Plays the emerge; burrowers get it when they surface, the gallery on demand. */
export function rigSpawn(rig: Rig, seed = 0): void {
  const m = ensure(rig, seed);
  if (m.deathT >= 0) return;
  m.action = 'spawn';
  m.actionT = 0;
  m.label = 'spawn';
}

/** Back to a living idle, for a gallery that loops the death. */
export function rigReset(rig: Rig): void {
  const m = rig.motion;
  if (!m) return;
  m.deathT = -1;
  m.settled = false;
  m.action = 'none';
  m.actionW = 0;
  m.hitT = Infinity;
  m.weights.fill(0);
  m.weights[IDLE] = 1;
  m.base = IDLE;
  m.label = 'idle';
}

// ---------------------------------------------------------------------------------------------
// Culling

const frustum = new Frustum();
const viewProj = new Matrix4();
const cullSphere = new Sphere();
const cullCentre = new Vector3();
let culling = false;

/**
 * Called once a frame with the camera the rigs are drawn with; rigs outside its view skip posing.
 * Null turns culling off (the gallery draws every rig).
 */
export function beginRigFrame(camera: Camera | null): void {
  culling = camera !== null;
  if (!camera) return;
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProj);
}

function onScreen(rig: Rig, m: RigMotion): boolean {
  if (!culling) return true;
  const p = rig.root.parent ? rig.root.parent.position : rig.root.position;
  const s = rig.root.scale.y;
  // The camera moves after entities are posed, so the frustum is a frame old; the slack covers it.
  cullCentre.set(p.x, p.y + m.extent[3] * s * 0.5, p.z);
  cullSphere.set(cullCentre, Math.max(m.extent[3], m.extent[1] - m.extent[0]) * s + 40);
  return frustum.intersectsSphere(cullSphere);
}

// ---------------------------------------------------------------------------------------------
// Driving

export interface RigDrive {
  /** Ground speed in world units per second. */
  speed: number;
  dead: boolean;
  dormant: boolean;
  /** Burrowed out of sight. */
  hidden: boolean;
  dt: number;
  /** Per entity, so a pack does not move in lockstep. */
  seed: number;
}

/** World units the rig covers in one locomotion cycle at the given swing. */
export function cycleLength(rig: Rig, swing: number): number {
  const scale = rig.root.scale.y * rig.body.scale.y;
  const glide = GLIDE_STRIDE[rig.profile.gait];
  if (glide !== undefined || rig.legLength <= 0) return (glide ?? 4) * scale;
  // A stiff leg planted for half a cycle carries the body 2 L sin(swing); two legs per cycle.
  const splay = rig.profile.gait === 'skitter' || rig.profile.gait === 'crawl' ? 0.6 : 1;
  return 4 * rig.legLength * scale * Math.sin(swing) * splay;
}

function swingFor(m: RigMotion, heavy: number): number {
  const walk = m.weights[WALK] ?? 0;
  const run = m.weights[RUN] ?? 0;
  const moving = walk + run;
  const w = WALK_SWING * (1 - 0.2 * heavy);
  const r = RUN_SWING * (1 - 0.15 * heavy);
  return moving > 0 ? (walk * w + run * r) / moving : w;
}

export function driveRig(rig: Rig, d: RigDrive): void {
  const m = ensure(rig, d.seed);
  const p = rig.profile;
  const dt = d.dt;
  m.time += dt;

  if (d.dead && m.deathT < 0) {
    m.deathT = 0;
    m.action = 'none';
    m.label = 'death';
  } else if (m.deathT >= 0) m.deathT += dt;
  if (m.deathT < 0) {
    if (m.wasDormant && !d.dormant) {
      m.action = 'awaken';
      m.actionT = 0;
      m.label = 'awaken';
    }
    if (m.wasHidden && !d.hidden && p.burrows) rigSpawn(rig, d.seed);
  }
  m.wasDormant = d.dormant;
  m.wasHidden = d.hidden;

  // Base layer, from the same speed thresholds as the KayKit models.
  const current = BASE_ROLES[m.base] ?? 'idle';
  const role = d.dormant ? 'dormant' : locomotionRole(d.speed, current);
  m.base = role === 'dormant' ? DORMANT : role === 'run' ? RUN : role === 'walk' ? WALK : IDLE;
  const fade = dt / (CROSSFADE * (1 + p.weight * 0.5));
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const w = m.weights[i] ?? 0;
    const next = i === m.base ? Math.min(1, w + fade) : Math.max(0, w - fade);
    m.weights[i] = next;
    total += next;
  }
  if (total > 0) for (let i = 0; i < 4; i++) m.weights[i] = (m.weights[i] ?? 0) / total;
  if (m.deathT < 0 && m.action === 'none') m.label = BASE_ROLES[m.base] ?? 'idle';

  // Legs cycle at the rate that carries the body at its actual speed.
  const swing = swingFor(m, p.weight);
  const cycle = cycleLength(rig, swing);
  const cap = MAX_CYCLE[p.gait];
  if (cycle > 0 && cap > 0) m.phase += Math.min(cap, d.speed / cycle) * dt;
  else if (cycle > 0) m.phase += (d.speed / cycle) * dt;

  advanceAction(m, dt);
  if (m.hitT < HIT_SECONDS) m.hitT += dt;
  advanceOrbits(m, dt);

  if (m.settled) return;
  if (d.hidden || !onScreen(rig, m)) return;
  pose(rig, m);
  if (m.deathT > 3) m.settled = true;
}

function advanceAction(m: RigMotion, dt: number): void {
  m.actionT += dt;
  let target = 0;
  switch (m.action) {
    case 'windup':
      target = 1;
      // A wind-up nobody released (the monster was interrupted) lets go on its own.
      if (m.actionT > m.windupSeconds + 1.5) m.action = 'none';
      break;
    case 'strike':
      target = 1;
      if (m.actionT > STRIKE_SECONDS + RECOVER_SECONDS) m.action = 'none';
      break;
    case 'awaken':
      target = 1;
      if (m.actionT > AWAKEN_SECONDS) m.action = 'none';
      break;
    case 'spawn':
      target = 1;
      if (m.actionT > SPAWN_SECONDS) m.action = 'none';
      break;
    case 'none':
      break;
  }
  if (m.deathT >= 0) target = 0;
  const rate = dt / 0.08;
  m.actionW = target > m.actionW ? Math.min(target, m.actionW + rate) : Math.max(target, m.actionW - rate * 0.6);
}

function advanceOrbits(m: RigMotion, dt: number): void {
  const busy = m.action === 'windup' || m.action === 'strike' ? 1.6 : 1;
  const moving = (m.weights[WALK] ?? 0) + (m.weights[RUN] ?? 0) * 1.5;
  const dead = m.deathT >= 0 ? Math.max(0, 1 - m.deathT) : 1;
  const rate = ((Math.PI * 2 * 2) / m.period) * (1 + 0.4 * moving) * busy * dead;
  for (let i = 0; i < m.orbit.length; i++) m.orbit[i] = (m.orbit[i] ?? 0) + rate * dt;
}

// ---------------------------------------------------------------------------------------------
// Posing

function pose(rig: Rig, m: RigMotion): void {
  for (const c of m.all) c.clear();
  const p = rig.profile;
  const death = m.deathT >= 0 ? smooth(m.deathT / 0.2) : 0;
  const live = 1 - death;
  const wi = (m.weights[IDLE] ?? 0) * live;
  const ww = (m.weights[WALK] ?? 0) * live;
  const wr = (m.weights[RUN] ?? 0) * live;
  const wd = (m.weights[DORMANT] ?? 0) * live;

  // Idle breathing runs under walking too, a little weaker, so a step never freezes the chest.
  idle(rig, m, wi + (ww + wr) * 0.4 + (p.dormant ? 0 : wd));
  if (ww > 0) locomote(rig, m, ww, WALK_SWING * (1 - 0.2 * p.weight), false);
  if (wr > 0) locomote(rig, m, wr, RUN_SWING * (1 - 0.15 * p.weight), true);
  if (wd > 0) dormant(rig, m, wd);
  secondary(rig, m, live);
  if (m.actionW > 0) action(rig, m, m.actionW * live);
  if (m.hitT < HIT_SECONDS) flinch(rig, m, live * (1 - 0.5 * p.weight));
  if (m.deathT >= 0) die(rig, m);
  orbits(m);
  for (const c of m.all) c.apply();
}

function idle(rig: Rig, m: RigMotion, w: number): void {
  if (w <= 0) return;
  const p = rig.profile;
  const b = m.body;
  const breathe = osc(m, 2, m.seed);
  // Stone and wood do not breathe.
  const breath = p.gait === 'still' ? 0 : 0.016;
  scl(b, -breath * 0.4 * breathe, breath * breathe, -breath * 0.4 * breathe, w);
  const look = osc(m, 1, m.seed * 3);
  switch (p.gait) {
    case 'biped':
    case 'quad':
    case 'crawl':
      rot(m.head, 0, 0.22 * look, 0.05 * osc(m, 3, m.seed), w);
      rot(b, 0.015 * osc(m, 1, m.seed * 2), 0, 0, w);
      rot(m.armL, 0.03 * breathe, 0, 0.05 * breathe, w);
      rot(m.armR, -0.03 * breathe, 0, 0.05 * breathe, w);
      rot(m.tail, 0, 0.3 * osc(m, 2, m.seed), 0.04 * breathe, w);
      rot(m.jaw, 0, 0, -0.05 - 0.05 * breathe, w);
      break;
    case 'hop':
      // Imps and toads twitch: small, quick head turns and a restless weight shift.
      rot(m.head, 0, 0.3 * osc(m, 3, m.seed), 0.06 * osc(m, 5, m.seed), w);
      pos(b, 0, 0.02 * Math.abs(osc(m, 4, m.seed)), 0, w);
      rot(m.armL, 0, 0, -0.6 + 0.15 * osc(m, 5, m.seed), w);
      rot(m.armR, 0, 0, -0.6 + 0.1 * osc(m, 4, m.seed + 1), w);
      rot(m.tail, 0, 0.5 * osc(m, 4, m.seed), 0, w);
      break;
    case 'scurry':
      rot(m.head, 0, 0.15 * look, 0.05 * osc(m, 17, m.seed), w);
      rot(m.tail, 0, 0.4 * osc(m, 3, m.seed), 0, w);
      break;
    case 'skitter':
      pos(b, 0, 0.012 * breathe, 0, w);
      break;
    case 'fly':
      pos(b, 0, 0.08 * osc(m, flapTurns(rig), m.seed + Math.PI), 0, w);
      rot(b, 0, 0, 0.04 * osc(m, 1, m.seed), w);
      rot(m.head, 0, 0.3 * look, 0, w);
      break;
    case 'hover':
      pos(b, 0, 0.3 + 0.12 * osc(m, 2, m.seed), 0, w);
      rot(b, 0.03 * osc(m, 1, m.seed), 0, 0.03 * osc(m, 1, m.seed + 1), w);
      rot(m.armL, 0.3 + 0.3 * osc(m, 2, m.seed), 0, 0, w);
      rot(m.armR, -0.3 - 0.3 * osc(m, 2, m.seed), 0, 0, w);
      break;
    case 'float':
      pos(b, 0, 0.15 * osc(m, 2, m.seed), 0, w);
      break;
    case 'slither':
      rot(b, 0, 0.1 * look, 0, w);
      break;
    case 'bounce': {
      const wob = osc(m, 4, m.seed);
      scl(b, -0.025 * wob, 0.05 * wob, -0.025 * wob, w);
      break;
    }
    case 'still':
      break;
  }
}

/** Oscillations that run whatever the role: wings, tentacles, flames, hair, segments. */
function secondary(rig: Rig, m: RigMotion, live: number): void {
  const moving = (m.weights[WALK] ?? 0) + (m.weights[RUN] ?? 0);
  for (const c of m.extras) {
    const kind: unknown = c.node.userData.kind;
    switch (kind) {
      case 'wing':
        if (rig.profile.gait === 'fly') {
          const turns = flapTurns(rig);
          // Wing tips on +z rise with negative x rotation; both sides mirror.
          const flap = osc(m, turns, m.seed) * (0.55 + 0.3 * moving) + 0.1;
          rot(c, -c.side * flap, 0, 0, live);
        }
        break;
      case 'tentacle':
        rot(c, 0, 0, 0.45 * osc(m, 5, c.phase + m.seed), live);
        break;
      case 'strand':
        rot(c, 0.1 * osc(m, 3, c.phase), 0, 0.25 * osc(m, 2, c.phase + m.seed) + 0.3 * moving, live);
        break;
      case 'flame': {
        const f = 0.15 * osc(m, 23, c.phase) + 0.08 * osc(m, 37, c.phase * 2);
        scl(c, -f * 0.3, f, -f * 0.3, live);
        rot(c, 0.08 * osc(m, 11, c.phase), 0, 0.1 * osc(m, 13, c.phase) + 0.25 * moving, live);
        break;
      }
      case 'claw':
        rot(c, 0, 0.12 * osc(m, 3, c.phase + m.seed), 0, live);
        break;
      case 'tongue':
        scl(c, 0, 0.1 * osc(m, 5, m.seed), 0, live);
        break;
      case 'segment': {
        // A wave down the body, faster when it moves.
        const k = c.phase;
        rot(c, 0.08 * osc(m, 2, m.seed - k * 0.7), 0, 0.06 * osc(m, 3, m.seed - k * 0.6) * (1 + moving), live);
        break;
      }
      default:
        break;
    }
  }
}

/** Wing beats per period: small wings beat fast, big wings slow. */
function flapTurns(rig: Rig): number {
  return Math.round(14 - 9 * rig.profile.weight);
}

function locomote(rig: Rig, m: RigMotion, w: number, amp: number, run: boolean): void {
  const p = rig.profile;
  const phi = m.phase * Math.PI * 2;
  const s = Math.sin(phi);
  const b = m.body;
  const heavy = p.weight;
  // Keeps the planted foot on the ground: a stiff leg swung by `a` lifts the hip by L (1 - cos a).
  const drop = rig.legLength * rig.body.scale.y * (1 - Math.cos(amp * s));
  switch (p.gait) {
    case 'biped': {
      rot(m.legL, 0, 0, amp * s, w);
      rot(m.legR, 0, 0, -amp * s, w);
      rot(m.armL, 0, 0, -amp * 0.6 * s, w);
      rot(m.armR, 0, 0, amp * 0.6 * s, w);
      pos(b, 0, -drop, 0, w);
      const lean = run ? 0.16 : 0.05 + 0.04 * heavy;
      // Heavy things roll their weight from foot to foot.
      rot(b, (0.03 + 0.05 * heavy) * s, 0.05 * s, -lean, w);
      rot(m.head, 0, -0.04 * s, lean * 0.5, w);
      rot(m.tail, 0, -0.25 * s, 0, w);
      break;
    }
    case 'quad': {
      const g = run ? 0.5 : Math.PI;
      // Walk: diagonal pairs. Run: a gallop, front and back pairs in opposition.
      rot(m.legL, 0, 0, amp * s, w);
      rot(m.legR, 0, 0, amp * Math.sin(phi + g), w);
      rot(m.armL, 0, 0, amp * Math.sin(phi + (run ? Math.PI : Math.PI)), w);
      rot(m.armR, 0, 0, amp * Math.sin(phi + (run ? Math.PI + 0.5 : 0)), w);
      pos(b, 0, run ? 0.06 * Math.abs(Math.sin(phi + 0.8)) - drop : -drop, 0, w);
      rot(b, 0.02 * s, 0, run ? 0.1 * Math.sin(phi + Math.PI / 2) - 0.04 : 0.015 * Math.sin(phi * 2), w);
      rot(m.head, 0, 0.03 * s, run ? -0.18 : -0.03 * Math.sin(phi * 2), w);
      rot(m.tail, 0, 0.25 * s, run ? 0.3 : 0.05, w);
      break;
    }
    case 'hop': {
      const hop = Math.abs(s);
      pos(b, 0, (run ? 0.3 : 0.16) * hop * (1 - heavy * 0.5), 0, w);
      rot(b, 0, 0, -0.08 - 0.06 * Math.cos(phi * 2), w);
      rot(m.legL, 0, 0, amp * 1.1 * s, w);
      rot(m.legR, 0, 0, -amp * 1.1 * s, w);
      rot(m.armL, 0, 0, -0.5 - 0.3 * s, w);
      rot(m.armR, 0, 0, -0.5 + 0.3 * s, w);
      rot(m.tail, 0, 0.5 * s, 0, w);
      // A mimic chatters its lid as it hops.
      if (p.dormant === 'chest') rot(m.head, 0, 0, 0.2 * hop, w);
      break;
    }
    case 'scurry': {
      rot(m.legL, 0, 0, amp * 1.2 * s, w);
      rot(m.legR, 0, 0, -amp * 1.2 * s, w);
      pos(b, 0, 0.05 * Math.abs(Math.sin(phi * 2)), 0, w);
      rot(b, 0, 0.06 * s, 0.06 * Math.sin(phi * 2), w);
      rot(m.head, 0, 0, -0.05 * Math.sin(phi * 2 + 1), w);
      rot(m.tail, 0, -0.5 * s, 0, w);
      break;
    }
    case 'skitter': {
      for (const c of m.extras) {
        if (c.node.userData.kind !== 'leg') continue;
        // Alternating sets: a tripod or tetrapod gait, neighbours out of step.
        const k: unknown = c.node.userData.k;
        const set = ((typeof k === 'number' ? k : 0) + (c.side > 0 ? 0 : 1)) % 2;
        const q = phi + set * Math.PI;
        rot(c, c.side * 0.3 * Math.max(0, Math.cos(q)), 0, amp * 0.8 * Math.sin(q), w);
      }
      pos(b, 0, 0.03 * Math.abs(Math.sin(phi * 2)), 0, w);
      rot(b, 0, 0.04 * s, 0, w);
      rot(m.tail, 0, 0.06 * s, 0, w);
      break;
    }
    case 'crawl': {
      // A sprawling low walk: diagonal legs and the whole body snaking.
      rot(m.legL, 0, 0, amp * s, w);
      rot(m.armR, 0, 0, amp * s, w);
      rot(m.legR, 0, 0, -amp * s, w);
      rot(m.armL, 0, 0, -amp * s, w);
      rot(b, 0, 0.12 * s, 0, w);
      rot(m.head, 0, -0.08 * s, 0, w);
      rot(m.tail, 0, -0.35 * s, 0, w);
      break;
    }
    case 'fly':
      rot(b, 0, 0, run ? -0.35 : -0.2, w);
      rot(m.head, 0, 0, run ? 0.2 : 0.1, w);
      pos(b, 0, 0.06 * osc(m, flapTurns(rig), m.seed + Math.PI), 0, w);
      break;
    case 'hover':
      pos(b, 0, 0.3 + 0.08 * osc(m, 2, m.seed), 0, w);
      rot(b, 0, 0, run ? -0.35 : -0.22, w);
      rot(m.armL, 0.4, 0, -0.5, w);
      rot(m.armR, -0.4, 0, -0.5, w);
      break;
    case 'float':
      pos(b, 0, 0.12 * osc(m, 2, m.seed), 0, w);
      rot(b, 0, 0, -0.15, w);
      break;
    case 'slither':
      for (const c of m.extras) if (c.node.userData.kind === 'segment') rot(c, 0, 0.2 * Math.sin(phi - c.phase * 0.9), 0, w);
      break;
    case 'bounce': {
      // Squash on landing, stretch in the air.
      const air = Math.abs(s);
      const land = Math.pow(1 - air, 3);
      pos(b, 0, 0.22 * air, 0, w);
      scl(b, 0.14 * land - 0.05 * air, -0.2 * land + 0.1 * air, 0.14 * land - 0.05 * air, w);
      rot(b, 0, 0, -0.1 * Math.cos(phi * 2), w);
      break;
    }
    case 'still':
      break;
  }
}

function dormant(rig: Rig, m: RigMotion, w: number): void {
  const p = rig.profile;
  const b = m.body;
  if (p.dormant === 'statue') {
    // Crouched on its haunches, wings folded, not a breath.
    const sit = 0.9;
    rot(m.legL, 0, 0, sit, w);
    rot(m.legR, 0, 0, sit, w);
    pos(b, 0, -rig.legLength * rig.body.scale.y * (1 - Math.cos(sit)), 0, w);
    rot(b, 0, 0, -0.3, w);
    rot(m.head, 0, 0, -0.15, w);
    rot(m.armL, 0, 0, 0.5, w);
    rot(m.armR, 0, 0, 0.5, w);
    for (const c of m.extras) if (c.node.userData.kind === 'wing') rot(c, c.side * 0.7, 0, 0.3, w);
    return;
  }
  if (p.dormant === 'chest') {
    // Shut, sitting on the floor, legs and tongue drawn in.
    rot(m.head, 0, 0, -0.35, w);
    pos(b, 0, -0.1, 0, w);
    scl(m.legL, 0, -0.9, 0, w);
    scl(m.legR, 0, -0.9, 0, w);
    for (const c of m.extras) if (c.node.userData.kind === 'tongue') scl(c, -0.99, -0.99, -0.99, w);
    return;
  }
  // Not yet aware: head low, brooding or sniffing the ground.
  rot(m.head, 0, 0, -0.14 + 0.04 * osc(m, 1, m.seed), w);
  rot(b, 0, 0, -0.04, w);
}

function action(rig: Rig, m: RigMotion, w: number): void {
  switch (m.action) {
    case 'windup': {
      const a = smooth(m.actionT / m.windupSeconds);
      // A held wind-up trembles with effort.
      strike(rig, m, m.style, a, 0, w, a * 0.5);
      break;
    }
    case 'strike': {
      const t = m.actionT;
      let a: number;
      let s: number;
      if (t < 0) {
        a = smooth(1 + t / QUICK_WINDUP);
        s = 0;
      } else if (t < STRIKE_SECONDS) {
        const k = t / STRIKE_SECONDS;
        // Fast out of the wind-up, a hard stop at full extension.
        s = 1 - (1 - k) * (1 - k);
        a = 1 - s;
      } else {
        a = 0;
        s = 1 - smooth((t - STRIKE_SECONDS) / RECOVER_SECONDS);
      }
      strike(rig, m, m.style, a, s, w, 0);
      break;
    }
    case 'awaken':
      awaken(rig, m, w);
      break;
    case 'spawn':
      emerge(m, w);
      break;
    case 'none':
      break;
  }
}

/**
 * The attack poses. `a` is how far into the wind-up (0 to 1), `s` how far into the strike; the
 * strike blends out of the wind-up as `a` falls and `s` rises.
 */
function strike(rig: Rig, m: RigMotion, style: Strike, a: number, s: number, w: number, strain: number): void {
  const b = m.body;
  const shake = strain * 0.02 * osc(m, 90, m.seed);
  pos(b, 0, 0, shake, w);
  const arms = m.armL !== null || m.armR !== null;
  const ghost = rig.profile.gait === 'hover';
  const legs = rig.profile.gait === 'skitter';
  switch (style) {
    case 'bite':
      pos(b, -0.1 * a + 0.24 * s, rig.profile.gait === 'fly' ? -0.25 * s : 0, 0, w);
      rot(b, 0, 0, 0.14 * a - 0.18 * s, w);
      rot(m.head, 0, 0, 0.35 * a - 0.3 * s, w);
      rot(m.jaw, 0, 0, -0.55 * a + 0.05 * s, w);
      if (legs) for (const c of m.extras) if (c.front) rot(c, c.side * 0.5 * a, 0, 0.3 * a - 0.3 * s, w);
      if (rig.profile.gait === 'fly') rot(b, 0, 0, -0.35 * s, w);
      break;
    case 'claw':
      if (ghost) {
        rot(m.armL, 0, 0, -0.4 * a + 1.3 * s, w);
        rot(m.armR, 0, 0, -0.4 * a + 1.3 * s, w);
        pos(b, -0.08 * a + 0.2 * s, 0, 0, w);
        rot(b, 0, 0, 0.1 * a - 0.2 * s, w);
        break;
      }
      rot(m.armR, 0.3 * a - 0.2 * s, 0, -0.9 * a + 1.9 * s, w);
      rot(m.armL, 0, 0, 0.2 * a - 0.3 * s, w);
      rot(b, 0, 0.3 * a - 0.35 * s, 0.08 * a - 0.14 * s, w);
      rot(m.head, 0, 0, 0.1 * a - 0.1 * s, w);
      pos(b, 0.12 * s, 0, 0, w);
      break;
    case 'slam':
      if (arms) {
        rot(m.armL, -0.2 * a, 0, 2.7 * a + 0.6 * s, w);
        rot(m.armR, 0.2 * a, 0, 2.7 * a + 0.6 * s, w);
        rot(b, 0, 0, 0.15 * a - 0.38 * s, w);
        pos(b, 0.1 * s, 0.05 * a - 0.1 * s, 0, w);
        rot(m.head, 0, 0, 0.15 * a - 0.2 * s, w);
      } else {
        // Worms rear back and crash down.
        for (const c of m.extras) if (c.node.userData.kind === 'segment') rot(c, 0, 0, 0.14 * a - 0.24 * s, w);
        rot(b, 0, 0, 0.1 * a - 0.2 * s, w);
        rot(m.head, 0, 0, 0.3 * a - 0.5 * s, w);
        pos(b, 0, 0.1 * a - 0.15 * s, 0, w);
      }
      break;
    case 'spit':
      rot(b, 0, 0, 0.2 * a - 0.15 * s, w);
      rot(m.head, 0, 0, 0.35 * a - 0.3 * s, w);
      rot(m.jaw, 0, 0, -0.5 * s, w);
      scl(b, 0.08 * a - 0.04 * s, 0.1 * a - 0.05 * s, 0.08 * a - 0.04 * s, w);
      pos(b, 0.08 * s, 0, 0, w);
      break;
    case 'cast':
      if (!arms || ghost) {
        pulse(rig, m, a, s, w);
        if (ghost) {
          rot(m.armL, -0.6 * a - 0.2 * s, 0, 1.2 * a + 1.4 * s, w);
          rot(m.armR, 0.6 * a + 0.2 * s, 0, 1.2 * a + 1.4 * s, w);
        }
        break;
      }
      rot(m.armL, -0.5 * a - 0.1 * s, 0, 2.3 * a + 1.4 * s, w);
      rot(m.armR, 0.5 * a + 0.1 * s, 0, 2.3 * a + 1.4 * s, w);
      rot(m.head, 0, 0, 0.25 * a - 0.1 * s, w);
      rot(b, 0, 0, 0.08 * a - 0.15 * s, w);
      pos(b, 0.06 * s, 0.05 * a, 0, w);
      break;
    case 'scream':
      rot(m.head, 0, 0, -0.2 * a + 0.5 * s, w);
      rot(m.armL, -0.8 * a - 0.9 * s, 0, 0.3 * a + 0.6 * s, w);
      rot(m.armR, 0.8 * a + 0.9 * s, 0, 0.3 * a + 0.6 * s, w);
      pos(b, 0, -0.05 * a + 0.15 * s, 0, w);
      scl(b, 0.05 * s, 0.05 * s, 0.05 * s, w);
      for (const c of m.extras) if (c.node.userData.kind === 'strand') rot(c, 0, 0, 0.7 * s, w);
      break;
    case 'shoot':
      if (!arms) {
        (rig.profile.gait === 'fly' ? flare : pulse)(rig, m, a, s, w);
        break;
      }
      rot(m.armR, 0, 0, 2.9 * a + 0.9 * s, w);
      rot(m.armL, 0, 0, 0.6 * a + 0.2 * s, w);
      rot(b, 0, 0.35 * a - 0.3 * s, 0.1 * a - 0.12 * s, w);
      rot(m.head, 0, -0.2 * a, 0, w);
      break;
    case 'charge': {
      const paw = a * Math.max(0, osc(m, 40, m.seed));
      rot(m.head, 0, 0, -0.3 * a + 0.3 * s, w);
      rot(b, 0, 0, -0.12 * a - 0.2 * s, w);
      pos(b, -0.05 * a + 0.3 * s, -0.06 * a, 0, w);
      rot(m.legL, 0, 0, 0.5 * paw, w);
      if (rig.profile.gait === 'biped') {
        rot(m.armL, 0, 0, -0.7 * a + 0.3 * s, w);
        rot(m.armR, 0, 0, -0.7 * a + 0.3 * s, w);
        rot(b, 0, 0, -0.2 * a, w);
      }
      break;
    }
    case 'leap':
      pos(b, 0.1 * s, -0.22 * a + 0.5 * s, 0, w);
      rot(b, 0, 0, -0.25 * a - 0.1 * s, w);
      rot(m.legL, 0, 0, 0.6 * a - 0.4 * s, w);
      rot(m.legR, 0, 0, 0.6 * a - 0.4 * s, w);
      rot(m.armL, 0, 0, -0.6 * a + 2 * s, w);
      rot(m.armR, 0, 0, -0.6 * a + 2 * s, w);
      for (const c of m.extras) {
        if (c.node.userData.kind === 'wing') rot(c, -c.side * (0.7 * a - 0.4 * s), 0, 0, w);
        if (c.node.userData.kind === 'leg') rot(c, c.side * (-0.2 * a + 0.4 * s), 0, 0, w);
      }
      break;
    case 'sting':
      rot(m.tail, 0, 0, 0.35 * a - 1.05 * s, w);
      rot(b, 0, 0, 0.1 * a - 0.1 * s, w);
      pos(b, 0.12 * s, 0, 0, w);
      for (const c of m.extras) if (c.node.userData.kind === 'claw') rot(c, 0, c.side * 0.35 * a, 0, w);
      break;
    case 'burst': {
      const jitter = a * 0.04 * osc(m, 120, m.seed);
      pos(b, jitter, 0, jitter, w);
      scl(b, 0.35 * a + 0.6 * s, 0.3 * a + 0.5 * s, 0.35 * a + 0.6 * s, w);
      rot(m.head, 0, 0, 0.2 * a, w);
      break;
    }
    case 'pulse':
      pulse(rig, m, a, s, w);
      break;
    case 'chomp':
      rot(m.head, 0, 0, 0.45 * a - 0.35 * s, w);
      rot(b, 0, 0, 0.1 * a - 0.08 * s, w);
      pos(b, 0.2 * s, 0.15 * s, 0, w);
      for (const c of m.extras) if (c.node.userData.kind === 'tongue') scl(c, 0.3 * a, 0.3 * a, 0.3 * a, w);
      break;
    case 'ram':
      pos(b, -0.12 * a + 0.3 * s, 0, 0, w);
      rot(b, 0, 0, 0.1 * a - 0.2 * s, w);
      scl(b, -0.06 * a + 0.25 * s, -0.08 * a - 0.1 * s, -0.04 * a, w);
      rot(m.head, 0, 0, -0.2 * s, w);
      break;
  }
}

/** Armless casters gather in and burst out; flames surge, orbiting shards pull in and fling out. */
function pulse(rig: Rig, m: RigMotion, a: number, s: number, w: number): void {
  scl(m.body, -0.12 * a + 0.2 * s, -0.12 * a + 0.2 * s, -0.12 * a + 0.2 * s, w);
  pos(m.body, 0, 0.05 * a, 0, w);
  for (const c of m.extras) {
    const kind: unknown = c.node.userData.kind;
    if (kind === 'flame') scl(c, 0.2 * s, -0.3 * a + 0.9 * s, 0.2 * s, w);
    if (kind === 'tentacle') rot(c, 0, 0, -0.5 * a + 0.8 * s, w);
  }
  m.push += (-0.45 * a + 0.6 * s) * w;
  if (rig.profile.gait === 'still') rot(m.body, 0.03 * osc(m, 60, m.seed) * a, 0, 0, w);
}

/** Fliers without hands throw with the wings: a flare back and a hard beat forward. */
function flare(_rig: Rig, m: RigMotion, a: number, s: number, w: number): void {
  for (const c of m.extras) if (c.node.userData.kind === 'wing') rot(c, -c.side * (0.8 * a - 0.5 * s), 0, 0.4 * a - 0.3 * s, w);
  rot(m.body, 0, 0, 0.25 * a - 0.3 * s, w);
  rot(m.head, 0, 0, 0.2 * a - 0.2 * s, w);
}

function flinch(rig: Rig, m: RigMotion, w: number): void {
  const t = m.hitT;
  const e = t < 0.05 ? t / 0.05 : Math.pow(Math.max(0, 1 - (t - 0.05) / (HIT_SECONDS - 0.05)), 2);
  const k = w * e;
  const side = Math.sin(m.seed * 7) > 0 ? 1 : -1;
  rot(m.body, 0.06 * side, 0, 0.14, k);
  pos(m.body, -0.06, rig.profile.gait === 'fly' ? 0.1 : 0, 0, k);
  rot(m.head, 0, 0.15 * side, 0.25, k);
  rot(m.armL, 0, 0, -0.25, k);
  rot(m.armR, 0, 0, -0.25, k);
  rot(m.jaw, 0, 0, -0.2, k);
  rot(m.tail, 0, 0.3 * side, 0, k);
  if (rig.profile.gait === 'bounce' || rig.profile.gait === 'still') scl(m.body, 0.08, -0.1, 0.08, k);
}

function awaken(rig: Rig, m: RigMotion, w: number): void {
  const u = clamp01(m.actionT / AWAKEN_SECONDS);
  const env = Math.sin(Math.PI * u) * w;
  const b = m.body;
  if (rig.profile.dormant === 'chest') {
    // The lid bursts open and the chest jumps.
    rot(m.head, 0, 0, 0.6, env);
    pos(b, 0, 0.3 * Math.sin(Math.PI * clamp01(u * 2)), 0, w);
    for (const c of m.extras) if (c.node.userData.kind === 'tongue') scl(c, 0.2, 0.5, 0.2, env);
    return;
  }
  // The rest: the head snaps up, the body jolts, wings spread wide once.
  rot(m.head, 0, 0, 0.35, env);
  pos(b, 0, 0.08, 0, env);
  rot(b, 0, 0, 0.1, env);
  rot(m.armL, -0.3, 0, 0.6, env);
  rot(m.armR, 0.3, 0, 0.6, env);
  for (const c of m.extras) if (c.node.userData.kind === 'wing') rot(c, -c.side * 0.9, 0, 0, env);
}

function emerge(m: RigMotion, w: number): void {
  const u = clamp01(m.actionT / SPAWN_SECONDS);
  const rise = 1 - Math.pow(1 - u, 3);
  const height = m.extent[3];
  const b = m.body;
  // Up out of the ground, shaking off earth, with a little overshoot at the top.
  pos(b, 0, -height * (1 - rise) + 0.08 * Math.sin(Math.PI * u), 0, w);
  rot(b, 0.12 * Math.sin(u * 40) * (1 - u), 0, 0.15 * (1 - rise), w);
  rot(m.head, 0, 0, 0.4 * Math.sin(Math.PI * u), w);
  for (const c of m.extras) if (c.node.userData.kind === 'segment') rot(c, 0, 0, 0.1 * (1 - rise), w);
}

// ---------------------------------------------------------------------------------------------
// Death

/** Falls speed up like a real fall. */
function fallK(t: number, delay: number, seconds: number): number {
  const k = clamp01((t - delay) / seconds);
  return k * k;
}

/** A short dull bounce on impact. */
function bounceK(t: number, delay: number, seconds: number, size: number): number {
  const u = (t - delay - seconds) / 0.25;
  return u > 0 && u < 1 ? size * Math.sin(Math.PI * u) : 0;
}

/** The last kicks of something dying, fading over a second. */
function twitchK(t: number, delay: number): number {
  return t > delay && t < delay + 1.2 ? Math.sin(t * 26) * (1 - (t - delay) / 1.2) : 0;
}

function die(rig: Rig, m: RigMotion): void {
  const t = m.deathT;
  const p = rig.profile;
  const heavy = p.weight;
  const b = m.body;
  const e = m.extent;
  const minX = e[0];
  const maxX = e[1];
  const minY = e[2];
  const maxY = e[3];
  const minZ = e[4];
  const maxZ = e[5];
  const dir = Math.sin(m.seed * 13.7) > 0 ? 1 : -1;
  const fallT = 0.5 + 0.3 * heavy;
  switch (p.death) {
    case 'topple': {
      const buckle = smooth(t / 0.15);
      const k = fallK(t, 0.1, fallT);
      pos(b, 0, -0.1 * buckle * (1 - k), 0, 1);
      if (dir > 0) rot(b, 0, 0, (Math.PI / 2) * k - bounceK(t, 0.1, fallT, 0.08), 1);
      else rot(b, (Math.PI / 2) * k - bounceK(t, 0.1, fallT, 0.08), 0, 0, 1);
      rot(m.armL, -0.3 * k, 0, 0.7 * k, 1);
      rot(m.armR, 0.3 * k, 0, 0.9 * k, 1);
      rot(m.legL, 0, 0, 0.25 * k, 1);
      rot(m.legR, 0, 0, -0.15 * k, 1);
      rot(m.head, 0, 0.3 * dir * k, 0.35 * k, 1);
      rot(m.jaw, 0, 0, -0.4 * k, 1);
      break;
    }
    case 'roll': {
      const k = fallK(t, 0.05, fallT);
      rot(b, dir * ((Math.PI / 2) * k - bounceK(t, 0.05, fallT, 0.1)), 0, 0, 1);
      const kick = 0.25 * twitchK(t, 0.1 + fallT);
      rot(m.legL, 0, 0, 0.35 * k + kick, 1);
      rot(m.legR, 0, 0, 0.25 * k - kick, 1);
      rot(m.armL, 0, 0, -0.35 * k - kick, 1);
      rot(m.armR, 0, 0, -0.25 * k + kick, 1);
      rot(m.head, 0, 0, -0.25 * k, 1);
      rot(m.jaw, 0, 0, -0.5 * k, 1);
      rot(m.tail, 0, 0.4 * k, 0, 1);
      break;
    }
    case 'curl': {
      // Onto its back, legs drawn in over the belly, a last twitch.
      const k = smooth(t / 0.45);
      rot(b, Math.PI * k * dir, 0, 0, 1);
      const kick = 0.2 * twitchK(t, 0.45);
      for (const c of m.extras) {
        if (c.node.userData.kind === 'leg') rot(c, -c.side * (0.7 * k + kick), 0, 0.2 * k, 1);
        if (c.node.userData.kind === 'claw') rot(c, 0, -c.side * 0.4 * k, 0, 1);
      }
      rot(m.tail, 0, 0, 0.5 * k, 1);
      break;
    }
    case 'collapse': {
      // Down on the knees, then forward onto the face.
      const kneel = smooth(t / 0.35);
      const k = fallK(t, 0.35, fallT);
      // The knees fold forward, then straighten out behind as it hits the ground.
      rot(m.legL, 0, 0, 0.8 * kneel * (1 - k) - 0.25 * k, 1);
      rot(m.legR, 0, 0, 0.7 * kneel * (1 - k) - 0.15 * k, 1);
      const legDrop = rig.legLength * rig.body.scale.y * (1 - Math.cos(0.75));
      pos(b, 0, -legDrop * kneel * (1 - k), 0, 1);
      rot(b, 0.1 * dir * k, 0, -(Math.PI / 2) * k + bounceK(t, 0.35, fallT, 0.06), 1);
      // Arms flung out past the head, lying along the ground.
      rot(m.armL, -0.35 * k, 0, 3 * k + 0.3 * kneel * (1 - k), 1);
      rot(m.armR, 0.35 * k, 0, 2.85 * k + 0.3 * kneel * (1 - k), 1);
      rot(m.head, 0, 0.4 * dir * k, -0.2 * kneel, 1);
      break;
    }
    case 'crumble': {
      const k = smooth(t / 1.1);
      rot(b, 0.2 * dir * k, 0, -0.35 * k, 1);
      pos(b, 0, -maxY * 0.45 * k, 0, 1);
      scl(b, 0.05 * k, -0.15 * k, 0.05 * k, 1);
      for (const c of m.extras) if (c.node.userData.kind === 'flame') scl(c, -0.9 * k, -0.95 * k, -0.9 * k, 1);
      break;
    }
    case 'dissolve': {
      // The cloak or core sinks and spreads into the ground as the light goes out of it.
      const k = smooth(t / 0.9);
      pos(b, 0, -minY * k * 0.9, 0, 1);
      scl(b, 0.35 * k, -0.8 * k, 0.35 * k, 1);
      rot(b, 0.1 * dir * k, 0, 0.2 * k, 1);
      rot(m.armL, 0.6 * k, 0, -0.4 * k, 1);
      rot(m.armR, -0.6 * k, 0, -0.4 * k, 1);
      rot(m.head, 0, 0, -0.5 * k, 1);
      for (const c of m.extras) {
        const kind: unknown = c.node.userData.kind;
        if (kind === 'flame') scl(c, -0.9 * k, -0.95 * k, -0.9 * k, 1);
        if (kind === 'strand') rot(c, 0, 0, -0.8 * k, 1);
      }
      break;
    }
    case 'splat': {
      const k = smooth(t / 0.35);
      const wob = t < 1 ? 0.08 * Math.sin(t * 18) * (1 - t) : 0;
      scl(b, 0.22 * k + wob, -0.62 * k - wob, 0.22 * k + wob, 1);
      rot(m.head, 0, 0, -0.4 * k, 1);
      rot(m.legL, 0, 0, 1 * k, 1);
      rot(m.legR, 0, 0, -1 * k, 1);
      break;
    }
    case 'fall': {
      // Drops out of the air, wings go slack, lands on its side.
      const k = fallK(t, 0, fallT);
      pos(b, 0, -minY * k, 0, 1);
      rot(b, dir * 0.6 * k, 0, -0.3 * k + bounceK(t, 0, fallT, 0.1), 1);
      for (const c of m.extras) if (c.node.userData.kind === 'wing' || c.node.userData.kind === 'tentacle') rot(c, c.side * 0.5 * k, 0, 0.3 * k, 1);
      rot(m.head, 0, 0, -0.4 * k, 1);
      rot(m.armL, 0, 0, 0.8 * k, 1);
      rot(m.armR, 0, 0, 0.6 * k, 1);
      break;
    }
    case 'slump': {
      const k = smooth(t / 1);
      for (const c of m.extras) if (c.node.userData.kind === 'segment') rot(c, 0, 0.1 * dir * k, -0.32 * k, 1);
      rot(b, 0, 0, -0.25 * k, 1);
      pos(b, 0, -maxY * 0.2 * k, 0, 1);
      rot(m.head, 0, 0, -0.6 * k, 1);
      break;
    }
    case 'tip': {
      const shut = smooth(t / 0.15);
      const k = fallK(t, 0.15, fallT);
      rot(m.head, 0, 0, -0.35 * shut, 1);
      rot(b, dir * (Math.PI / 2) * k, 0, 0, 1);
      for (const c of m.extras) if (c.node.userData.kind === 'tongue') scl(c, -0.5 * shut, -0.5 * shut, -0.5 * shut, 1);
      break;
    }
  }
  groundBody(m);
}

const corner = new Vector3();
const turn = new Euler();

/**
 * Raises a falling body just enough that its rotated rest box stays above the ground: the fall
 * pivots on whatever part touches down, not on the feet sinking through the floor.
 */
function groundBody(m: RigMotion): void {
  const b = m.body;
  const e = m.extent;
  turn.set(b.rx, b.ry, b.rz);
  let low = Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? e[1] : e[0], i & 2 ? e[3] : e[2], i & 4 ? e[5] : e[4]);
    corner.x *= 1 + b.sx;
    corner.y *= 1 + b.sy;
    corner.z *= 1 + b.sz;
    corner.applyEuler(turn);
    if (corner.y < low) low = corner.y;
  }
  const floor = -b.p0y - low;
  if (b.py < floor) b.py = floor;
}

// ---------------------------------------------------------------------------------------------
// Orbiting parts

function orbits(m: RigMotion): void {
  const push = m.push;
  m.push = 0;
  const dead = m.deathT >= 0 ? smooth(m.deathT / 0.8) : 0;
  for (let i = 0; i < m.extras.length; i++) {
    const c = m.extras[i];
    if (!c || c.node.userData.kind !== 'orbit') continue;
    const a = m.orbit[i] ?? 0;
    const base: unknown = c.node.userData.orbit;
    const o = typeof base === 'number' ? base : 0;
    const r = 0.9 * (1 + push) * (1 - 0.7 * dead);
    const y = (2.2 + 0.15 * osc(m, 3, o)) * (1 - dead) + 0.25 * dead;
    c.px += Math.cos(a) * r;
    c.py += y;
    c.pz += Math.sin(a) * r;
  }
}
