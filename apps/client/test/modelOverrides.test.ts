import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { instantiateNow, registerFile, unregisterFile } from '../src/render/assets.js';
import { characterAsset, setModelOverrides } from '../src/render/characters.js';

/** Only the fields characterAsset reads; client tests are not typechecked against the full snapshot. */
function enemy(et: string, rare: boolean) {
  return { k: 'enemy', et, rare, boss: false, id: 1, x: 0, y: 0, r: 13 };
}

describe('model overrides in the game', () => {
  it('keeps the champion model swap on a height-only override', () => {
    setModelOverrides({ monsters: { chaser: { height: 50 } }, minions: {} });
    expect(characterAsset(enemy('chaser', true))?.id).toBe('skel_warrior@50');
    expect(characterAsset(enemy('chaser', false))?.id).toBe('skel_minion@50');
    setModelOverrides({ monsters: { chaser: { model: 'mon_ghoul' } }, minions: {} });
    expect(characterAsset(enemy('chaser', true))?.id).toBe('mon_ghoul');
    setModelOverrides({ monsters: {}, minions: {} });
    expect(characterAsset(enemy('chaser', true))?.id).toBe('skel_warrior');
  });

  it('forgets an unregistered local file', () => {
    const def = { id: 'local_test', label: 'x', category: 'monster', url: 'check:test', height: 40 };
    registerFile(def.url, new Group(), []);
    expect(instantiateNow(def)).not.toBeNull();
    unregisterFile(def.url);
    expect(instantiateNow(def)).toBeNull();
  });
});
