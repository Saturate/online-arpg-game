import { createStarterSigil, isServerMessage, starterDamageFor, starterSigilById, type SigilItem } from '@rune/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { receiveStarterDamage, useStarterTuning } from '../src/game/starterTuning.js';
import { compileFor } from '../src/ui/store.js';

function boneSpear(): SigilItem {
  const def = starterSigilById('bone_spear');
  if (!def) throw new Error('no bone_spear');
  let uid = 1;
  return createStarterSigil(() => uid++, def, { bound: true });
}

function rootDamage(item: SigilItem): number {
  const c = compileFor(item, 'binder');
  return c.ok ? (c.program.roots[0]?.tuning.damage ?? 0) : 0;
}

describe('the client reads the starter damage table', () => {
  beforeEach(() => useStarterTuning.setState({ damage: {} }));

  it('starts empty and takes the table from the welcome or a starterDamage message', () => {
    expect(useStarterTuning.getState().damage).toEqual({});
    receiveStarterDamage({ bone_spear: 1.5 });
    expect(useStarterTuning.getState().damage).toEqual({ bone_spear: 1.5 });
  });

  it('keeps the last good table when a bad one or none arrives', () => {
    receiveStarterDamage({ bone_spear: 2 });
    for (const bad of [undefined, null, 2, { bone_spear: 9 }, { nova: 2 }, { bone_spear: '2' }]) receiveStarterDamage(bad);
    expect(useStarterTuning.getState().damage).toEqual({ bone_spear: 2 });
  });

  it('drops a starterDamage message outside the admin limits before it reaches the game', () => {
    expect(isServerMessage({ t: 'starterDamage', damage: {} })).toBe(true);
    expect(isServerMessage({ t: 'starterDamage', damage: { bone_spear: 0.1 } })).toBe(false);
  });

  it('compiles tooltips and the forge with it, for the whole starter only', () => {
    const whole = boneSpear();
    const base = rootDamage(whole);
    receiveStarterDamage({ bone_spear: 1.5 });
    expect(rootDamage(whole)).toBeCloseTo(base * 1.5, 10);
    // The tooltip line and the forge note read the same multiplier.
    expect(starterDamageFor(whole, useStarterTuning.getState().damage)).toBe(1.5);
    const c = compileFor(whole, 'binder');
    expect(c.ok && c.notes.some((n) => n.includes('150% damage'))).toBe(true);
    const first = whole.slots[0];
    if (!first) throw new Error('no rune');
    const changed: SigilItem = { ...whole, slots: [{ ...first, affixes: first.affixes.slice(1) }] };
    const changedBase = (() => {
      const c0 = compileFor(changed, 'binder', {});
      return c0.ok ? (c0.program.roots[0]?.tuning.damage ?? 0) : 0;
    })();
    expect(rootDamage(changed)).toBe(changedBase);
    expect(starterDamageFor(changed, useStarterTuning.getState().damage)).toBe(1);
  });
});
