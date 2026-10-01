import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { changedSettings, mergeStarterChanges, settingsDirty, starterChanges } from '../src/admin/settingsDiff.js';
import { settingsFromReply } from '../src/net/api.js';

const loaded: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, xpRate: 2, starterDamage: { bone_spear: 1.5, smite: 2 } };

describe('the admin Settings form sends only what changed', () => {
  it('sends the changed fields and none of the rest', () => {
    expect(changedSettings(loaded, loaded)).toEqual({});
    expect(changedSettings(loaded, { ...loaded, motd: 'hi', castCooldownSeconds: 0.7 })).toEqual({ motd: 'hi', castCooldownSeconds: 0.7 });
    // The starter table never goes as a plain field; it is merged separately.
    expect(changedSettings(loaded, { ...loaded, starterDamage: {} })).toEqual({});
  });

  it('lays only the changed starter rows over the server table as it is now', () => {
    const draft = { ...loaded, starterDamage: { bone_spear: 2, smite: 2 } };
    const changes = starterChanges(loaded.starterDamage, draft.starterDamage);
    expect([...changes]).toEqual([['bone_spear', 2]]);
    // Someone else set Fireball and reset Smite meanwhile; both survive this save.
    expect(mergeStarterChanges({ smite: 1.25, fireball: 3 }, changes)).toEqual({ smite: 1.25, fireball: 3, bone_spear: 2 });
    const reset = starterChanges(loaded.starterDamage, { smite: 2 });
    expect([...reset]).toEqual([['bone_spear', 1]]);
    expect(mergeStarterChanges({ bone_spear: 1.5, fireball: 3 }, reset)).toEqual({ fireball: 3 });
  });

  it('compares the starter table by entries, not key order', () => {
    expect(settingsDirty(loaded, { ...loaded, starterDamage: { smite: 2, bone_spear: 1.5 } })).toBe(false);
    expect(settingsDirty(loaded, { ...loaded, starterDamage: { smite: 2 } })).toBe(true);
    expect(settingsDirty(loaded, { ...loaded, xpRate: 3 })).toBe(true);
  });
});

describe('the admin page reads the settings reply', () => {
  it('takes a reply from a server without starter tuning as every starter at 1', () => {
    const { starterDamage: _gone, ...old } = DEFAULT_SERVER_SETTINGS;
    expect(settingsFromReply(old)).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromReply(loaded)).toEqual(loaded);
  });

  it('refuses a reply with a bad starter table or a missing field it once skipped', () => {
    expect(settingsFromReply({ ...loaded, starterDamage: { bone_spear: 40 } })).toBeNull();
    for (const key of ['castCooldownSeconds', 'forceMax', 'forceCostRate', 'forceCoolRate', 'forceRampMax', 'zoomDefault', 'zoomDungeon', 'zoomMin', 'zoomMax'] as const) {
      const { [key]: _missing, ...rest } = loaded;
      expect(settingsFromReply(rest), key).toBeNull();
    }
  });
});
