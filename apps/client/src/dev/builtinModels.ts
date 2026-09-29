import { ENEMIES, ENEMY_TYPE_IDS, MINION_DEFS, MINION_TYPE_IDS } from '@rune/shared';
import { AnimationClip, Group, QuaternionKeyframeTrack, VectorKeyframeTrack, type KeyframeTrack, type Object3D } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ENEMY_ASSETS, MINION_ASSETS } from '../render/characters.js';
import { animate, enemyModel, minionModel, uniqueMaterials, type Rig } from '../render/models.js';

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
  build: () => Rig;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  ...ENEMY_TYPE_IDS.filter((id) => ENEMY_ASSETS[id] === undefined).map((id) => {
    const def = ENEMIES[id];
    return { id, label: def.name, radius: def.radius, speed: def.moveSpeed, build: () => enemyModel(id, def.color) };
  }),
  ...MINION_TYPE_IDS.filter((id) => MINION_ASSETS[id] === undefined).map((id) => {
    const def = MINION_DEFS[id];
    return { id: `minion_${id}`, label: `${def.name} (minion)`, radius: def.radius, speed: def.moveSpeed, build: () => minionModel(id, def.color) };
  }),
];

/** At game size the player is 54 units tall; KayKit heroes are about 1.8 m, so 30 units make a metre. */
const UNITS_PER_METRE = 30;

/** Builds the model at its in-game size, in world units. */
export function buildBuiltin(m: BuiltinModel): Rig {
  const rig = m.build();
  rig.root.scale.multiplyScalar(m.radius);
  uniqueMaterials(rig.root);
  return rig;
}

const FPS = 30;

/**
 * animate() mixes sines of `t` whose frequencies differ per style (see models.ts). An idle clip
 * only loops cleanly over a whole multiple of every period, in units of 2 pi seconds; orbiting
 * extras add periods of 2 pi / 2 and 2 pi / 3, which a whole 2 pi also covers.
 */
function loopSeconds(rig: Rig): number {
  const turns = { biped: 1, hop: 1, float: rig.extras.some((e) => e.userData.orbit !== undefined) ? 5 : 5 / 3, hover: 2 }[rig.style];
  return turns * 2 * Math.PI;
}

/** The nodes animate() moves, named so the tracks and Blender's outliner read sensibly. */
function animatedNodes(rig: Rig): Object3D[] {
  const named: [Object3D | null, string][] = [
    [rig.body, 'body'],
    [rig.legL, 'leg_l'],
    [rig.legR, 'leg_r'],
    [rig.armL, 'arm_l'],
    [rig.armR, 'arm_r'],
    [rig.tail, 'tail'],
    ...rig.extras.map((e, i): [Object3D, string] => [e, `extra_${i}`]),
  ];
  const out: Object3D[] = [];
  for (const [node, name] of named) {
    if (!node || out.includes(node)) continue;
    node.name = name;
    out.push(node);
  }
  return out;
}

/**
 * Runs animate() frame by frame and records every moved node's position and rotation as keyframes.
 * `drive` gives the speed and attack at each moment. The rig is put back to its rest pose after.
 */
function bake(rig: Rig, name: string, seconds: number, drive: (t: number) => { speed: number; attack: number }): AnimationClip {
  const nodes = animatedNodes(rig);
  const rest = nodes.map((n) => ({ p: n.position.clone(), q: n.quaternion.clone() }));
  const armRest = [rig.armL, rig.armR].map((a) => a?.userData.rest);
  rig.root.userData.phase = undefined;
  const frames = Math.round(seconds * FPS);
  const times: number[] = [];
  const pos = nodes.map((): number[] => []);
  const rot = nodes.map((): number[] => []);
  const dt = 1 / FPS;
  for (let f = 0; f <= frames; f++) {
    const t = f * dt;
    const { speed, attack } = drive(t);
    // The first frame must not advance the walk phase, or frame 0 and the last frame differ.
    animate(rig, t, f === 0 ? 0 : dt, speed, attack, 0);
    times.push(t);
    nodes.forEach((n, i) => {
      pos[i]?.push(n.position.x, n.position.y, n.position.z);
      rot[i]?.push(n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w);
    });
  }
  const tracks: KeyframeTrack[] = [];
  nodes.forEach((n, i) => {
    const p = pos[i] ?? [];
    const q = rot[i] ?? [];
    if (p.some((v, k) => Math.abs(v - (p[k % 3] ?? 0)) > 1e-5)) tracks.push(new VectorKeyframeTrack(`${n.name}.position`, times, p));
    if (q.some((v, k) => Math.abs(v - (q[k % 4] ?? 0)) > 1e-5)) tracks.push(new QuaternionKeyframeTrack(`${n.name}.quaternion`, times, q));
    const r = rest[i];
    if (r) {
      n.position.copy(r.p);
      n.quaternion.copy(r.q);
    }
  });
  [rig.armL, rig.armR].forEach((a, i) => {
    if (a) a.userData.rest = armRest[i];
  });
  rig.root.userData.phase = undefined;
  return new AnimationClip(name, seconds, tracks);
}

/** Idle and Walk loop; Attack is one swing, shaped like the game's (a snap to 1 at the hit, then a 0.25 s decay). */
export function bakeClips(rig: Rig, m: BuiltinModel): AnimationClip[] {
  const loop = loopSeconds(rig);
  // A whole number of stride cycles in the loop, at about the monster's own speed. Below 60 units a
  // second animate() shortens the stride, so the walk never goes slower than that.
  const cycle = rig.stride * 10;
  const cycles = cycle > 0 ? Math.max(1, Math.round((Math.max(60, m.speed) * loop) / cycle)) : 0;
  let walkSpeed = cycle > 0 ? (cycles * cycle) / loop : Math.max(60, m.speed);
  while (cycle > 0 && walkSpeed < 60) walkSpeed += cycle / loop;
  const windUp = 0.12;
  return [
    bake(rig, 'Idle', loop, () => ({ speed: 0, attack: 0 })),
    bake(rig, 'Walk', loop, () => ({ speed: walkSpeed, attack: 0 })),
    bake(rig, 'Attack', 0.6, (t) => ({ speed: 0, attack: t < windUp ? t / windUp : Math.max(0, 1 - (t - windUp) * 4) })),
  ];
}

/** Downloads the model as a binary glTF in metres, facing +x with its feet at the origin, with Idle, Walk and Attack clips. */
export async function exportBuiltin(m: BuiltinModel): Promise<void> {
  const rig = buildBuiltin(m);
  const animations = bakeClips(rig, m);
  const wrap = new Group();
  wrap.name = m.id;
  wrap.scale.setScalar(1 / UNITS_PER_METRE);
  wrap.add(rig.root);
  const data = await new GLTFExporter().parseAsync(wrap, { binary: true, animations });
  if (!(data instanceof ArrayBuffer)) throw new Error('Exporter returned JSON instead of a binary file');
  const url = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${m.id}.glb`;
  a.click();
  // Revoked on the next task: some browsers start the download only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
