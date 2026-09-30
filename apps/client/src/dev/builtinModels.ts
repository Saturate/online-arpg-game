import { ENEMIES, ENEMY_TYPE_IDS, MINION_DEFS, MINION_TYPE_IDS } from '@rune/shared';
import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, type KeyframeTrack, type Object3D } from 'three';
import { ENEMY_ASSETS, MINION_ASSETS } from '../render/characters.js';
import { beginRigFrame, buildEnemy, buildMinion, driveRig, rigAttack, rigHit, rigSpawn, rigWindup, uniqueMaterials, type Rig, type RigDrive } from '../render/models.js';
import { applyLeafTransforms, bakeExportTransform, bakeFlatShading, cleanForExport, exportFrame, mergeMaterials, pushDownScales, TO_GLTF_FORWARD } from './exportPrep.js';
import { download, toGlb } from './modelExport.js';

/**
 * Monsters with no model file: models.ts builds them from primitives at runtime. The Assets tab
 * lists them so they can be viewed and exported as .glb for editing in Blender.
 */
export interface BuiltinModel {
  id: string;
  label: string;
  /** Collision radius in world units; the rig is built at radius 1 and scaled by this in game. */
  radius: number;
  /** Move speed in world units per second, so the baked walk matches the game's stride. */
  speed: number;
  /**
   * The rig uncompiled, one mesh per part under its pivot. The game draws a compiled copy (one
   * skinned mesh, colours in vertex attributes); the parts are what Blender should edit.
   */
  build: () => Rig;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  ...ENEMY_TYPE_IDS.filter((id) => ENEMY_ASSETS[id] === undefined).map((id) => {
    const def = ENEMIES[id];
    return { id, label: def.name, radius: def.radius, speed: def.moveSpeed, build: () => buildEnemy(id, def.color) };
  }),
  ...MINION_TYPE_IDS.filter((id) => MINION_ASSETS[id] === undefined).map((id) => {
    const def = MINION_DEFS[id];
    return { id: `minion_${id}`, label: `${def.name} (minion)`, radius: def.radius, speed: def.moveSpeed, build: () => buildMinion(id, def.color) };
  }),
];

/** Builds the model at its in-game size, in world units. */
export function buildBuiltin(m: BuiltinModel): Rig {
  const rig = m.build();
  rig.root.scale.multiplyScalar(m.radius);
  uniqueMaterials(rig.root);
  return rig;
}

/** Keys on whole 1/30 s frames, so Blender at 30 fps puts every key on a whole frame. */
const FPS = 30;
/** The speeds the rig gallery walks and runs at. */
const WALK_RANGE = [40, 180] as const;
const RUN_SPEED = 240;
/** Seconds of driving before a loop is recorded, so the crossfade into it has finished. */
const WARM_SECONDS = 1.5;
const WARM_STEP = 1 / 120;

/**
 * The nodes the rig driver moves, named so the tracks and Blender's outliner read sensibly. The
 * head pivot is called neck: on some rigs (the mimic's lid) it is not at the front, and the Model
 * check reads any node called head as the way the model faces.
 */
function animatedNodes(rig: Rig): Object3D[] {
  const named: [Object3D | null, string][] = [
    [rig.body, 'body'],
    [rig.jaw, 'jaw'],
    [rig.legL, 'leg_l'],
    [rig.legR, 'leg_r'],
    [rig.armL, 'arm_l'],
    [rig.armR, 'arm_r'],
    [rig.tail, 'tail'],
    [rig.head, 'neck'],
    ...rig.extras.map((e, i): [Object3D, string] => {
      const kind: unknown = e.userData.kind;
      return [e, `${typeof kind === 'string' ? kind : 'extra'}_${i}`];
    }),
  ];
  const out: Object3D[] = [];
  for (const [node, name] of named) {
    if (!node || out.includes(node)) continue;
    node.name = name;
    out.push(node);
  }
  return out;
}

interface Rest {
  node: Object3D;
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
}

function snapshot(nodes: readonly Object3D[]): Rest[] {
  return nodes.map((node) => ({ node, p: [node.position.x, node.position.y, node.position.z], q: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w], s: [node.scale.x, node.scale.y, node.scale.z] }));
}

/** Puts the build pose back and forgets the driver's state, so every clip starts from the same rig. */
function restore(rig: Rig, rest: readonly Rest[]): void {
  for (const r of rest) {
    r.node.position.set(...r.p);
    r.node.quaternion.set(...r.q);
    r.node.scale.set(...r.s);
  }
  rig.motion = null;
}

const drive: RigDrive = { speed: 0, dead: false, dormant: false, hidden: false, dt: 0, seed: 0 };

interface Script {
  speed?: number;
  /** Whole leg cycles a locomotion loop must fit. */
  cycles?: number;
  dormant?: (t: number) => boolean;
  dead?: (t: number) => boolean;
  /** Game events (attack, hit, spawn) fired when the clip's time passes them. */
  events?: [number, (rig: Rig) => void][];
}

function step(rig: Rig, s: Script, t0: number, dt: number): void {
  const t1 = t0 + dt;
  for (const [at, fire] of s.events ?? []) if (at >= t0 && at < t1) fire(rig);
  drive.speed = s.speed ?? 0;
  drive.dormant = s.dormant?.(t1) ?? false;
  drive.dead = s.dead?.(t1) ?? false;
  drive.dt = dt;
  driveRig(rig, drive);
}

function varies(values: readonly number[], size: number): boolean {
  return values.some((v, k) => Math.abs(v - (values[k % size] ?? 0)) > 1e-5);
}

/**
 * Drives the rig through a script and records every moved node as keyframes. `seconds` is sampled
 * over `frames` keys placed on whole 1/30 s frames; for a loop the two differ by under half a frame,
 * so the clip plays that much slower than the game and its last key is exactly its first.
 * `warm` seconds of `warmScript` are driven first without recording (a loop starts in its steady state).
 */
function record(rig: Rig, rest: readonly Rest[], name: string, seconds: number, script: Script, warm = 0, warmScript: Script = { ...script, events: [] }): AnimationClip {
  restore(rig, rest);
  for (let t = 0; t < warm - 1e-9; t += WARM_STEP) step(rig, warmScript, t, Math.min(WARM_STEP, warm - t));
  const frames = Math.max(1, Math.round(seconds * FPS));
  const dt = seconds / frames;
  const nodes = rest.map((r) => r.node);
  const pos = nodes.map((): number[] => []);
  const rot = nodes.map((): number[] => []);
  const scl = nodes.map((): number[] => []);
  const times: number[] = [];
  const phase0 = rig.motion?.phase ?? 0;
  for (let f = 0; f <= frames; f++) {
    // Frame 0 poses the rig without moving time, so a loop's first key is its state at the start.
    step(rig, script, f * dt - (f === 0 ? 0 : dt), f === 0 ? 0 : dt);
    const m = rig.motion;
    if (script.cycles !== undefined && m && f > 0) {
      // Legs cycle at the rate that carries the rig at its speed, rarely a whole number of times
      // in the loop. Pinning the phase to whole cycles and posing again (a step of no time only
      // poses) closes the loop at the cost of a slightly faster or slower stride.
      m.phase = phase0 + (script.cycles * f) / frames;
      step(rig, script, f * dt, 0);
    }
    times.push(f / FPS);
    nodes.forEach((n, i) => {
      pos[i]?.push(n.position.x, n.position.y, n.position.z);
      rot[i]?.push(n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w);
      scl[i]?.push(n.scale.x, n.scale.y, n.scale.z);
    });
  }
  const tracks: KeyframeTrack[] = [];
  nodes.forEach((n, i) => {
    const p = pos[i] ?? [];
    const q = rot[i] ?? [];
    const s = scl[i] ?? [];
    if (varies(p, 3)) tracks.push(new VectorKeyframeTrack(`${n.name}.position`, times, p));
    if (varies(q, 4)) tracks.push(new QuaternionKeyframeTrack(`${n.name}.quaternion`, times, q));
    if (varies(s, 3)) tracks.push(new VectorKeyframeTrack(`${n.name}.scale`, times, s));
  });
  restore(rig, rest);
  return new AnimationClip(name, frames / FPS, tracks);
}

/** Walk cycles the rig completes in `seconds` at `speed`, measured from the driver itself. */
function cyclesIn(rig: Rig, rest: readonly Rest[], speed: number, seconds: number): number {
  restore(rig, rest);
  const s: Script = { speed };
  let t = 0;
  for (; t < WARM_SECONDS; t += WARM_STEP) step(rig, s, t, WARM_STEP);
  const start = rig.motion?.phase ?? 0;
  for (let k = 0; k < seconds; k += WARM_STEP) step(rig, s, t + k, Math.min(WARM_STEP, seconds - k));
  const cycles = (rig.motion?.phase ?? 0) - start;
  restore(rig, rest);
  return cycles;
}

/**
 * Every role the game drives a procedural monster through, baked from the rig driver the game
 * uses (render/rigs/motion.ts): Idle, Walk and Run loop; Attack is a contact blow, Cast and Shoot
 * a wind-up and release, Hit the flinch, Death the fall to the settled corpse. Dormant and Awaken
 * for statues and chests, Spawn for burrowers.
 */
export function bakeClips(rig: Rig, m: BuiltinModel): AnimationClip[] {
  // Culling is global to the page; with it on, a rig off the last camera's view is never posed.
  beginRigFrame(null);
  const nodes = animatedNodes(rig);
  const rest = snapshot(nodes);
  restore(rig, rest);
  step(rig, {}, 0, 0);
  const period = rig.motion?.period ?? 4;
  // Orbiting parts turn 2 times a period standing, 2.8 walking and 3.2 running; five periods cover both.
  const orbits = rig.extras.some((e) => e.userData.kind === 'orbit');
  const moveLoop = orbits ? period * 5 : period;
  const clips: AnimationClip[] = [record(rig, rest, 'Idle', period, {}, WARM_SECONDS)];
  if (m.speed > 0) {
    for (const [name, speed] of [
      ['Walk', Math.min(WALK_RANGE[1], Math.max(WALK_RANGE[0], m.speed))],
      ['Run', RUN_SPEED],
    ] as const) {
      const cycles = Math.max(1, Math.round(cyclesIn(rig, rest, speed, moveLoop)));
      clips.push(record(rig, rest, name, moveLoop, { speed, cycles }, WARM_SECONDS));
    }
  }
  clips.push(
    record(rig, rest, 'Attack', 0.9, { events: [[0.05, (r) => rigAttack(r, 0)]] }),
    record(rig, rest, 'Cast', 1.6, { events: [[0, (r) => rigWindup(r, 0.8, 'cast', 0)], [0.8, (r) => rigAttack(r, 0)]] }),
    record(rig, rest, 'Shoot', 1.3, { events: [[0, (r) => rigWindup(r, 0.55, 'shoot', 0)], [0.55, (r) => rigAttack(r, 0)]] }),
    record(rig, rest, 'Hit', 0.5, { events: [[0, (r) => rigHit(r, 0)]] }),
    // The driver settles a corpse 3 s after death.
    record(rig, rest, 'Death', 3.1, { dead: () => true }),
  );
  if (rig.profile.dormant) {
    clips.push(record(rig, rest, 'Dormant', period, { dormant: () => true }, WARM_SECONDS));
    clips.push(record(rig, rest, 'Awaken', 1.4, { dormant: (t) => t < 0.1 }, WARM_SECONDS, { dormant: () => true }));
  }
  if (rig.profile.burrows) clips.push(record(rig, rest, 'Spawn', 1.2, { events: [[0.05, (r) => rigSpawn(r, 0)]] }));
  // The rest pose is the build pose with orbiting parts where the first frame of Idle puts them:
  // built, they sit piled at the body's origin, and the game measures a model file's height and
  // feet from its rest pose.
  restore(rig, rest);
  step(rig, {}, 0, 0);
  const orbiting = snapshot(rig.extras.filter((e) => e.userData.kind === 'orbit'));
  restore(rig, rest);
  restore(rig, orbiting);
  return clips;
}

/**
 * Downloads the model as a binary glTF ready for Blender: metres, facing glTF +Z (Blender's Front
 * view) with its feet at the origin, every wrapper transform baked into the parts, with every
 * role's clip. The pivots stay as empties, so the parts can still be posed.
 */
export async function exportBuiltin(m: BuiltinModel): Promise<void> {
  const { root, clips } = prepareBuiltin(m);
  download(await toGlb(root, clips, new Map(), true), `${m.id}.glb`);
}

/** The export scene for a built-in model, before it is written out. */
export function prepareBuiltin(m: BuiltinModel): { root: Object3D; clips: AnimationClip[] } {
  const rig = buildBuiltin(m);
  const baked = bakeClips(rig, m);
  bakeFlatShading(rig.root);
  rig.root.name = m.id;
  cleanForExport(rig.root);
  const { root, clips } = bakeExportTransform(rig.root, baked, exportFrame(TO_GLTF_FORWARD), m.id);
  pushDownScales(root, clips);
  applyLeafTransforms(root, clips);
  mergeMaterials(root);
  return { root, clips };
}
