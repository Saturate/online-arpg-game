import { SIM } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { InputBuffer } from '../src/inputBuffer.js';

const frame = (seq: number) => ({ seq, moveDir: { x: 1, y: 0 }, aimAngle: 0, buttons: 0 });

describe('InputBuffer', () => {
  it('never applies more inputs than ticks elapsed, even when flooded', () => {
    const buf = new InputBuffer();
    let applied = 0;
    let seq = 0;
    for (let tick = 0; tick < 100; tick++) {
      for (let i = 0; i < 5; i++) buf.push(frame(seq++));
      applied += buf.drain().length;
    }
    expect(applied).toBeLessThanOrEqual(100);
  });

  it('catches up after a gap in arrivals', () => {
    const buf = new InputBuffer();
    expect(buf.drain()).toHaveLength(0);
    expect(buf.drain()).toHaveLength(0);
    buf.push(frame(0));
    buf.push(frame(1));
    buf.push(frame(2));
    expect(buf.drain()).toHaveLength(SIM.inputCreditCap);
  });

  it('drops duplicate or out-of-order sequence numbers and bounds the queue', () => {
    const buf = new InputBuffer();
    buf.push(frame(3));
    buf.push(frame(3));
    buf.push(frame(1));
    expect(buf.size).toBe(1);
    for (let s = 4; s < 100; s++) buf.push(frame(s));
    expect(buf.size).toBe(SIM.inputQueueMax);
  });
});
