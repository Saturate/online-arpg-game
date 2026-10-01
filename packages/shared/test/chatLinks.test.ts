import { describe, expect, it } from 'vitest';
import {
  CHAT_LINKS,
  chatPlainText,
  chatSegments,
  createGear,
  createRolledRune,
  createSigil,
  createVessel,
  DEFAULT_SERVER_SETTINGS,
  isChatMessage,
  isLinkedItem,
  isServerMessage,
  isZoomSettings,
  linkCopy,
  parseClientMessage,
  parseSettingsPatch,
  resolveChatLinks,
  Rng,
  settingsConflict,
  SETTINGS_LIMITS,
  SIGIL_MAX_SLOTS,
  type Item,
  type SigilItem,
} from '../src/index.js';

const rng = new Rng(7);
const sword = createGear(11, rng, 'rare', 20);
const vessel = { ...createVessel(12, rng, 'relic', 'zombie_brute', 25), lore: 'Made by two brothers', fixedName: true };
const rune = createRolledRune(13, rng, 'rare', 25);
const sigil: SigilItem = { ...createSigil(14, rng, 'relic', { ilvl: 30 }), slots: [{ ...rune, uid: 15 }] };
const mine = new Map<number, Item>([sword, vessel, rune, sigil].map((i) => [i.uid, i]));
const lookup = (uid: number) => mine.get(uid);

describe('resolveChatLinks', () => {
  it('links the sender own items and renumbers by first use', () => {
    const r = resolveChatLinks('look {2} and {1}', [sword.uid, vessel.uid], lookup);
    expect(r.text).toBe('look {1} and {2}');
    expect(r.items.map((i) => i.name)).toEqual([vessel.name, sword.name]);
  });

  it('drops an unknown uid (another player, or made up) along with its token', () => {
    const r = resolveChatLinks('mine {1}, yours {2}', [sword.uid, 999], lookup);
    expect(r.text).toBe('mine {1}, yours');
    expect(r.items).toHaveLength(1);
  });

  it('strips tokens the sender typed without a link, so every token left is real', () => {
    expect(resolveChatLinks('{1} {0} {7} {12}', [], lookup)).toEqual({ text: '{12}', items: [] });
  });

  it('allows at most three links, counting repeats of one', () => {
    const r = resolveChatLinks('{1}{1}{1}{1}{1}', [sword.uid], lookup);
    expect(r.text).toBe('{1}{1}{1}');
    expect(r.items).toHaveLength(1);
    const four = resolveChatLinks('{1}{2}{3}{4}', [11, 12, 13, 14], lookup);
    expect(four.items).toHaveLength(CHAT_LINKS.max);
  });

  it('links a rune inside a sigil when the lookup finds it', () => {
    const inner = (uid: number) => (uid === 15 ? sigil.slots[0] : undefined);
    expect(resolveChatLinks('{1}', [15], inner).items[0]?.kind).toBe('rune');
  });
});

describe('linkCopy', () => {
  it('carries no real uid, here or in inscribed runes', () => {
    const copy = linkCopy(sigil);
    expect(copy.uid).toBeLessThan(0);
    expect(copy.kind === 'sigil' && copy.slots.every((s) => s.uid < 0)).toBe(true);
    expect(isLinkedItem(copy)).toBe(true);
  });

  it('copies only the listed fields', () => {
    const extra = { ...sword, secret: 'owner notes' };
    expect(Object.keys(linkCopy(extra))).not.toContain('secret');
    expect(linkCopy(vessel)).toMatchObject({ lore: vessel.lore, fixedName: true, minion: 'zombie_brute' });
  });

  it('never changes the original', () => {
    linkCopy(sigil);
    expect(sigil.uid).toBe(14);
    expect(sigil.slots[0]?.uid).toBe(15);
  });
});

describe('isLinkedItem', () => {
  const ok = linkCopy(sword);
  it.each([
    ['a real uid', { ...ok, uid: 5 }],
    ['an unknown kind', { ...ok, kind: 'potion' }],
    ['an unknown tier', { ...ok, tier: 'mythic' }],
    ['a huge name', { ...ok, name: 'x'.repeat(CHAT_LINKS.nameMax + 1) }],
    ['too many affixes', { ...ok, affixes: Array.from({ length: CHAT_LINKS.maxAffixes + 1 }, () => ok.affixes[0] ?? { id: 'damage_pct', tier: 0, value: 1 }) }],
    ['an unknown affix', { ...ok, affixes: [{ id: 'free_gold', tier: 0, value: 1 }] }],
    ['a non-number affix value', { ...ok, affixes: [{ id: ok.affixes[0]?.id, tier: 0, value: '<b>' }] }],
    ['too many sigil slots', { ...linkCopy(sigil), slots: Array.from({ length: SIGIL_MAX_SLOTS + 1 }, () => linkCopy(rune)) }],
    ['a sigil slot holding gear', { ...linkCopy(sigil), slots: [ok] }],
    ['a long lore', { ...linkCopy(vessel), lore: 'x'.repeat(CHAT_LINKS.loreMax + 1) }],
  ])('refuses %s', (_, value) => {
    expect(isLinkedItem(value)).toBe(false);
  });
});

describe('chat messages', () => {
  it('parses links from the client and refuses more than three or bad uids', () => {
    expect(parseClientMessage({ t: 'chat', text: 'hi {1}', links: [4] })).toEqual({ t: 'chat', text: 'hi {1}', links: [4] });
    expect(parseClientMessage({ t: 'chat', text: 'hi' })).toEqual({ t: 'chat', text: 'hi' });
    expect(parseClientMessage({ t: 'chat', text: 'hi', links: [1, 2, 3, 4] })).toBeNull();
    expect(parseClientMessage({ t: 'chat', text: 'hi', links: [-1] })).toBeNull();
    expect(parseClientMessage({ t: 'chat', text: 'hi', links: ['1'] })).toBeNull();
    expect(parseClientMessage({ t: 'chat', text: 'hi', links: { 0: 1 } })).toBeNull();
  });

  it('checks a received line field by field', () => {
    const line = { t: 'chat', kind: 'game', from: 'Hero', to: null, text: '{1}', items: [linkCopy(sword)] };
    expect(isServerMessage(line)).toBe(true);
    expect(isChatMessage({ ...line, items: [{ ...sword }] })).toBe(false);
    expect(isChatMessage({ ...line, items: [linkCopy(sword), linkCopy(sword), linkCopy(sword), linkCopy(sword)] })).toBe(false);
    expect(isChatMessage({ ...line, kind: 'admin' })).toBe(false);
    expect(isChatMessage({ ...line, text: 'x'.repeat(5000) })).toBe(false);
  });

  it('keeps the largest possible line small', () => {
    // A relic sigil full of rolled runes, three times, is the most a line can carry.
    const big: SigilItem = { ...sigil, name: 'x'.repeat(CHAT_LINKS.nameMax), slots: Array.from({ length: SIGIL_MAX_SLOTS }, (_, i) => ({ ...rune, uid: 100 + i })) };
    const many = new Map<number, Item>([[1, big], [2, big], [3, big]]);
    const r = resolveChatLinks('x'.repeat(190) + '{1}{2}{3}', [1, 2, 3], (u) => many.get(u));
    expect(r.items).toHaveLength(3);
    expect(JSON.stringify({ t: 'chat', kind: 'game', from: 'Hero', to: null, ...r }).length).toBeLessThan(16_000);
  });

  it('splits text around links and renders them as plain names', () => {
    const items = [linkCopy(sword)];
    expect(chatSegments('a {1} b {2}', items)).toEqual(['a ', items[0], ' b {2}']);
    expect(chatPlainText('look {1}', items)).toBe(`look [${sword.name}]`);
    // Markup in a name stays text: the client renders segments through React, never as HTML.
    const evil: Item = { ...linkCopy(sword), name: '<img src=x onerror=alert(1)>' };
    expect(chatPlainText('{1}', [evil])).toBe('[<img src=x onerror=alert(1)>]');
  });
});

describe('zoom settings', () => {
  it('accepts zoom in range and refuses outside it', () => {
    expect(parseSettingsPatch({ zoomDefault: 1.2, zoomMin: 0.7 })).toEqual({ zoomDefault: 1.2, zoomMin: 0.7 });
    expect(typeof parseSettingsPatch({ zoomMin: SETTINGS_LIMITS.zoomMin - 0.01 })).toBe('string');
    expect(typeof parseSettingsPatch({ zoomMax: SETTINGS_LIMITS.zoomMax + 0.01 })).toBe('string');
    expect(typeof parseSettingsPatch({ zoomDungeon: Number.NaN })).toBe('string');
    expect(typeof parseSettingsPatch({ zoomDefault: '1' })).toBe('string');
  });

  it('needs both defaults inside the limits', () => {
    const d = DEFAULT_SERVER_SETTINGS;
    expect(settingsConflict(d)).toBeNull();
    expect(settingsConflict({ ...d, zoomMin: 1.5, zoomMax: 1.2 })).toMatch(/zoomMin/);
    expect(settingsConflict({ ...d, zoomDefault: 1.6 })).toMatch(/zoomDefault/);
    expect(settingsConflict({ ...d, zoomDungeon: 0.7 })).toMatch(/zoomDungeon/);
  });

  it('checks the zoom message the client acts on', () => {
    const z = { zoomDefault: 1, zoomDungeon: 1, zoomMin: 0.8, zoomMax: 1.4 };
    expect(isZoomSettings(z)).toBe(true);
    expect(isServerMessage({ t: 'zoom', zoom: z })).toBe(true);
    expect(isServerMessage({ t: 'zoom', zoom: { ...z, zoomMax: 50 } })).toBe(false);
    expect(isServerMessage({ t: 'zoom', zoom: { ...z, zoomMin: undefined } })).toBe(false);
  });
});
