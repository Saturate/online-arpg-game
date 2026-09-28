import { CLASSES, loadMap, SPELL, Simulation, type InputFrame } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { Predictor } from '../src/game/prediction.js';

function run(inputs: InputFrame[], acked: number, withDash: boolean) {
  const sim = new Simulation(1);
  const id = sim.addPlayer('c1', 'ranger');
  const p = sim.world.player.get(id)!;
  const predictor = new Predictor(CLASSES.ranger.moveSpeed, loadMap({ kind: 'flat' }).game);
  predictor.reset(sim.world.position.get(id)!);
  if (withDash) {
    // Start a dash on both sides, as if the server cast it and the client learned it earlier.
    p.dash = { vx: 900, vy: 0, ticksLeft: SPELL.dash.ticks };
    predictor.state.dash = { ...p.dash };
  }
  for (const f of inputs) predictor.apply(f);
  for (const f of inputs.slice(0, acked)) {
    sim.applyInput(id, f);
    sim.step();
  }
  const before = { ...predictor.position };
  predictor.reconcile(sim.world.position.get(id)!, p.dash, acked - 1, false);
  return { predictor, before };
}

const inputs = Array.from({ length: 20 }, (_, seq) => ({ seq, moveDir: { x: Math.cos(seq), y: Math.sin(seq) }, aimAngle: 0, buttons: 0 }));

describe('Predictor', () => {
  it('matches the server exactly after reconciling against a delayed snapshot', () => {
    const { predictor, before } = run(inputs, 12, false);
    expect(predictor.pendingCount).toBe(8);
    expect(predictor.lastCorrection).toBeLessThan(1e-6);
    expect(predictor.position.x).toBeCloseTo(before.x, 6);
  });

  it('replays an in-progress dash from the server state without correction', () => {
    const { predictor } = run(inputs, 2, true);
    expect(predictor.lastCorrection).toBeLessThan(1e-6);
  });

  it('does not move while dead', () => {
    const p = new Predictor(200, loadMap({ kind: 'flat' }).game);
    p.reset({ x: 500, y: 500 });
    p.reconcile({ x: 500, y: 500 }, null, -1, true);
    p.apply({ seq: 0, moveDir: { x: 1, y: 0 }, aimAngle: 0, buttons: 0 });
    expect(p.position.x).toBe(500);
  });
});
