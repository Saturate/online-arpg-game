import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, DEFAULT_OPTIONS, keyLabel, parseSettings, rebind } from '../src/ui/settings.js';

describe('settings', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    expect(parseSettings(null)).toEqual({ bindings: DEFAULT_BINDINGS, options: DEFAULT_OPTIONS });
    expect(parseSettings('{not json')).toEqual({ bindings: DEFAULT_BINDINGS, options: DEFAULT_OPTIONS });
  });

  it('keeps valid stored values and drops bad ones', () => {
    const raw = JSON.stringify({ bindings: { skill1: 'KeyQ', inventory: 'Escape', moveUp: 42 }, options: { damageNumbers: false, uiScale: 3 } });
    const s = parseSettings(raw);
    expect(s.bindings.skill1).toBe('KeyQ');
    // Escape is reserved, so it can never be bound over the menu key.
    expect(s.bindings.inventory).toBe(DEFAULT_BINDINGS.inventory);
    expect(s.bindings.moveUp).toBe(DEFAULT_BINDINGS.moveUp);
    expect(s.options.damageNumbers).toBe(false);
    expect(s.options.uiScale).toBe(1);
  });

  it('swaps bindings on a clash so every action keeps a key', () => {
    const next = rebind(DEFAULT_BINDINGS, 'skill1', 'KeyW');
    expect(next.skill1).toBe('KeyW');
    expect(next.moveUp).toBe('Digit1');
  });

  it('labels keys for display', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('AltLeft')).toBe('Alt');
  });
});
