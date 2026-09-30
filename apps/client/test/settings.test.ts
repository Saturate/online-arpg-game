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

  it('keeps the interface volume only inside 0 to 1', () => {
    expect(parseSettings(JSON.stringify({ options: { uiVolume: 0.2 } })).options.uiVolume).toBe(0.2);
    expect(parseSettings(JSON.stringify({ options: { uiVolume: 0 } })).options.uiVolume).toBe(0);
    expect(parseSettings(JSON.stringify({ options: { uiVolume: 4 } })).options.uiVolume).toBe(DEFAULT_OPTIONS.uiVolume);
    expect(parseSettings(JSON.stringify({ options: { uiVolume: '1' } })).options.uiVolume).toBe(DEFAULT_OPTIONS.uiVolume);
  });

  it('keeps the sell and drop prompt off unless it was turned on', () => {
    expect(DEFAULT_OPTIONS.confirmValuable).toBe(false);
    expect(parseSettings(JSON.stringify({ options: { damageNumbers: false } })).options.confirmValuable).toBe(false);
    expect(parseSettings(JSON.stringify({ options: { confirmValuable: true } })).options.confirmValuable).toBe(true);
    expect(parseSettings(JSON.stringify({ options: { confirmValuable: 'yes' } })).options.confirmValuable).toBe(false);
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
