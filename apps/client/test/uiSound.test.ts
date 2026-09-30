import { describe, expect, it } from 'vitest';
import { synthClick, synthHover } from '../src/ui/uiSound.js';

function peak(a: Float32Array, from = 0, to = a.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m;
}

describe('ui sounds', () => {
  for (const [name, synth] of [
    ['click', synthClick],
    ['hover', synthHover],
  ] as const) {
    it(`${name} is short, finite, quiet and dies away`, () => {
      const rate = 48000;
      const a = synth(rate);
      expect(a.length).toBeGreaterThan(0);
      expect(a.length / rate).toBeLessThan(0.1);
      expect(a.every((v) => Number.isFinite(v))).toBe(true);
      expect(peak(a)).toBeLessThan(0.9);
      const tail = Math.floor(a.length * 0.8);
      expect(peak(a, tail)).toBeLessThan(peak(a) * 0.25);
    });
  }

  it('the hover tick is quieter than the click', () => {
    expect(peak(synthHover(44100))).toBeLessThan(peak(synthClick(44100)));
  });

  it('sounds the same every time', () => {
    expect(synthClick(44100)).toEqual(synthClick(44100));
  });
});
