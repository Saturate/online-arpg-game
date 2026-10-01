import { AnimationClip, AnimationMixer, Group, LoopOnce, LoopRepeat, NumberKeyframeTrack, type AnimationAction } from 'three';
import { describe, expect, it } from 'vitest';
import type { AnimRole } from '../src/render/assets.js';
import { driveCharacter, windupCharacter, type CharacterModel } from '../src/render/characters.js';

/** A model whose clips each move the root's x to a value of their own, so the pose shows which plays. */
function model(): { cm: CharacterModel; root: Group } {
  const root = new Group();
  const mixer = new AnimationMixer(root);
  const clip = (name: string, seconds: number, x: number) => new AnimationClip(name, seconds, [new NumberKeyframeTrack('.position[x]', [0, seconds], [x, x])]);
  const coil = new AnimationClip('Windup', 0.8, [new NumberKeyframeTrack('.position[x]', [0, 0.8], [0, 5])]);
  const actions = new Map<AnimRole, AnimationAction>();
  const add = (role: AnimRole, c: AnimationClip, once: boolean) => {
    const a = mixer.clipAction(c);
    a.setLoop(once ? LoopOnce : LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    actions.set(role, a);
  };
  add('idle', clip('Idle', 1, 1), false);
  add('windup', coil, true);
  add('attack', clip('Attack', 0.6, 9), true);
  return { cm: { root, mixer, actions, current: null, tintMeshes: [], owned: [], attackRole: 'attack', windupHold: 0 }, root };
}

const STEP = 1 / 60;
const drive = (cm: CharacterModel, seconds: number, attack = false) => {
  for (let t = 0; t < seconds; t += STEP) driveCharacter(cm, { speed: 0, attack, dead: false, dormant: false, dt: STEP });
};

describe('windupCharacter', () => {
  it('stretches the wind-up to the telegraph and holds the coiled frame until the attack', () => {
    const { cm, root } = model();
    drive(cm, 0.3);
    expect(cm.current).toBe('idle');
    windupCharacter(cm, 0.9);
    expect(cm.current).toBe('windup');
    expect(cm.actions.get('windup')?.timeScale).toBeCloseTo(0.8 / 0.9);
    // Past the end of the telegraph, with the attack event a few frames late.
    drive(cm, 1.0);
    expect(cm.current).toBe('windup');
    expect(root.position.x).toBeCloseTo(5, 1);
    driveCharacter(cm, { speed: 0, attack: true, dead: false, dormant: false, dt: STEP });
    expect(cm.current).toBe('attack');
    expect(cm.windupHold).toBe(0);
  });

  it('lets go of the pose when no attack comes within the grace', () => {
    const { cm } = model();
    windupCharacter(cm, 0.9);
    drive(cm, 1.6);
    expect(cm.current).toBe('idle');
  });

  it('leaves a model without a wind-up clip alone', () => {
    const { cm } = model();
    cm.actions.delete('windup');
    drive(cm, 0.1);
    windupCharacter(cm, 0.9);
    expect(cm.current).toBe('idle');
    expect(cm.windupHold).toBe(0);
  });
});
