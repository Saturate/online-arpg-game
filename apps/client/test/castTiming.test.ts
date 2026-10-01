import { createSigil, DEFAULT_SERVER_SETTINGS, isServerMessage, Rng, type SigilItem } from '@rune/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatCooldown, receiveCastCooldown, sigilCooldown, useCastTiming } from '../src/game/castTiming.js';

function sigil(castDelay: number | null): SigilItem {
  const base = createSigil(1, new Rng(1), 'common');
  return { ...base, affixes: castDelay === null ? [] : [{ id: 'cast_delay', tier: 1, value: castDelay }] };
}

describe('the client reads the server cast cooldown', () => {
  beforeEach(() => useCastTiming.setState({ globalSeconds: DEFAULT_SERVER_SETTINGS.castCooldownSeconds }));

  it('starts at the default until the server says otherwise', () => {
    expect(useCastTiming.getState().globalSeconds).toBe(0.5);
  });

  it('takes the value from the welcome or a castCooldown message', () => {
    receiveCastCooldown(1.25);
    expect(useCastTiming.getState().globalSeconds).toBe(1.25);
  });

  it('keeps the last good value when a message has none or a bad one', () => {
    receiveCastCooldown(0.8);
    for (const bad of [undefined, null, '1', Number.NaN, 0, 0.05, 10]) receiveCastCooldown(bad);
    expect(useCastTiming.getState().globalSeconds).toBe(0.8);
  });

  it('drops a castCooldown message outside the admin limits before it reaches the game', () => {
    expect(isServerMessage({ t: 'castCooldown', seconds: 0.7 })).toBe(true);
    expect(isServerMessage({ t: 'castCooldown', seconds: 99 })).toBe(false);
    expect(isServerMessage({ t: 'castCooldown' })).toBe(false);
  });

  it('shows the cooldown after cast delay and cast speed, in the whole ticks the server waits', () => {
    expect(sigilCooldown(sigil(null), 0.5, 1)).toBe(0.5);
    expect(sigilCooldown(sigil(20), 0.5, 1)).toBeCloseTo(0.4);
    // 0.32 s waits seven whole ticks on the server, so it reads 0.35 s.
    expect(sigilCooldown(sigil(20), 0.5, 1.25)).toBeCloseTo(0.35);
    expect(formatCooldown(sigilCooldown(sigil(14), 0.5, 1))).toBe('0.45 s');
    expect(sigilCooldown(sigil(null), 1, 0)).toBe(1);
    expect(formatCooldown(sigilCooldown(sigil(10), 0.5, 1))).toBe('0.45 s');
  });
});
