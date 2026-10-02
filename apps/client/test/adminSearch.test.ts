import { can, DEFAULT_SERVER_SETTINGS, ROLES, TUNABLES, type Role, type SearchAccount } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { accountEntries, allowedEntries, logEntries, rankEntries, scoreEntry, SETTING_LABELS, staticEntries, tokenEntries, type SearchEntry } from '../src/admin/search/searchIndex.js';
import { isSearchShortcut } from '../src/admin/search/SearchBox.js';
import { tabVisible, visibleTabs } from '../src/admin/tabs.js';

const accounts: SearchAccount[] = [
  { id: 7, username: 'ember', role: 'player', banned: false, guest: false, characters: [{ id: 70, name: 'Ashcaller', classId: 'mage', level: 12 }] },
  { id: 8, username: 'brother', role: 'admin', banned: false, guest: false, characters: [] },
];

function everything(): SearchEntry[] {
  return [
    ...staticEntries(),
    ...accountEntries(accounts),
    ...tokenEntries([{ id: 'abcdef0123456789', name: 'deploy bot', scopes: ['viewAdmin'], createdBy: 'boss', createdAt: 0, expiresAt: 1, lastUsedAt: null }]),
    ...logEntries([{ id: 3, at: 0, kind: 'error', text: '[room i1-world] tick failed: fire went out' }]),
  ];
}

describe('admin tabs per role', () => {
  it('shows exactly the tabs whose routes the role may call', () => {
    expect(visibleTabs('player')).toEqual([]);
    expect(visibleTabs('builder')).not.toContain('log');
    expect(visibleTabs('moderator')).not.toContain('tokens');
    expect(visibleTabs('admin')).toEqual(expect.arrayContaining(['log', 'tokens']));
    expect(visibleTabs('admin')).not.toContain('grant');
    expect(visibleTabs('owner')).toEqual(expect.arrayContaining(['live', 'log', 'tokens', 'grant']));
    for (const role of ROLES) if (role !== 'player') expect(visibleTabs(role)[0]).toBe('live');
  });

  it('shows the Guilds tab to every staff role; only the guilds permission reassigns a Leader', () => {
    for (const role of ROLES) expect(visibleTabs(role).includes('guilds')).toBe(role !== 'player');
    expect(ROLES.filter((r) => can(r, 'guilds'))).toEqual(['admin', 'owner']);
  });
});

describe('admin search', () => {
  it('has a label for every server setting', () => {
    for (const key of Object.keys(DEFAULT_SERVER_SETTINGS)) expect(SETTING_LABELS).toHaveProperty(key);
    const settings = staticEntries().filter((e) => e.kind === 'setting');
    expect(settings).toHaveLength(Object.keys(DEFAULT_SERVER_SETTINGS).length);
  });

  it('finds every tuning number by path, label and category', () => {
    const spec = TUNABLES[0];
    if (!spec) throw new Error('no tunables');
    const entries = staticEntries();
    expect(rankEntries(entries, spec.path)[0]?.target).toBe(spec.path);
    expect(rankEntries(entries, spec.label, 100).map((e) => e.target)).toContain(spec.path);
    expect(entries.filter((e) => e.kind === 'tuning')).toHaveLength(TUNABLES.length);
  });

  it('ranks a whole name above a start, a word start and a match inside a word', () => {
    const e = (title: string): SearchEntry => ({ id: title, kind: 'setting', tab: 'settings', target: title, title, detail: '', terms: [] });
    const ranked = rankEntries([e('Overloot'), e('Boss loot'), e('Loot rate'), e('Loot')], 'loot').map((x) => x.title);
    expect(ranked).toEqual(['Loot', 'Loot rate', 'Boss loot', 'Overloot']);
    expect(scoreEntry(e('Loot rate'), 'nothing')).toBe(0);
    // Every word must match somewhere.
    expect(rankEntries([e('Boss life'), e('Boss damage')], 'boss life').map((x) => x.title)).toEqual(['Boss life']);
  });

  it('puts players and settings above log lines that match as well', () => {
    const ranked = rankEntries(everything(), 'ember').map((x) => x.kind);
    expect(ranked[0]).toBe('player');
    const fire = rankEntries(everything(), 'fire', 100);
    const log = fire.findIndex((x) => x.kind === 'log');
    expect(log).toBeGreaterThan(0);
    expect(fire.findIndex((x) => x.kind === 'tuning')).toBeLessThan(log);
  });

  it('finds a character by name and lands on its account', () => {
    const [hit] = rankEntries(everything(), 'ashcal');
    expect(hit).toMatchObject({ kind: 'character', tab: 'players', target: '7' });
  });

  it('drops results for tabs the role cannot open', () => {
    const tabsOf = (role: Role) => new Set(allowedEntries(everything(), role).map((e) => e.tab));
    expect(tabsOf('player').size).toBe(0);
    expect(tabsOf('moderator').has('tokens')).toBe(false);
    expect(tabsOf('moderator').has('log')).toBe(false);
    expect(tabsOf('builder').has('settings')).toBe(true);
    expect(tabsOf('admin').has('log')).toBe(true);
    expect(tabsOf('admin').has('tokens')).toBe(true);
    for (const role of ROLES) for (const e of allowedEntries(everything(), role)) expect(tabVisible(role, e.tab)).toBe(true);
  });

  it('opens on Ctrl+K and Cmd+K only', () => {
    expect(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isSearchShortcut({ key: 'K', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isSearchShortcut({ key: 'k', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});
