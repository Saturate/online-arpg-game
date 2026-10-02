import type { AdminLive, LiveRoom, LiveWorld } from '@rune/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isAdminLive, isWorldRebuildResult, rebuildSummary } from '../src/admin/live/liveApi.js';
import { MAX_POLL_MS, nextPollDelay, RegionCache } from '../src/admin/live/poll.js';
import { duration, HealthPanel, LogTail, PlayersTable, RoomsTable, Sparkline, tickClass, WorldMinimap, type PlayerActions } from '../src/admin/live/parts.js';

const worldRoom: LiveRoom = { id: 'i1-world', name: 'The World', kind: 'world', game: 'i1', players: 2, monsters: 140, minions: 3, spells: 12, tickMs: 2.1, tickMaxMs: 9 };
const world: LiveWorld = { game: 'i1', name: 'Public world 1', kind: 'public', seed: 1, gen: {}, genCurrent: true, width: 1000, height: 800, town: { x: 400, y: 300, w: 200, h: 200 }, planHash: '0a1b2c3d', regions: { cols: 4, rows: 2, cells: [0, 0, 1, 1, 0, 2, 2, 1], names: ['Mossy Barrens', 'Gloomvale', 'Ashen Steppe'] }, dots: [{ x: 500, y: 400, name: 'Ashcaller', inParty: true }] };

const live: AdminLive = {
  health: { build: 'abcdef1234', uptimeSeconds: 3700, memoryMb: 210, heapMb: 90, tickMs: 3.2, tickMaxMs: 61, tickHistory: { mean: [2, 3, 4], max: [5, 61, 8] }, connections: 3, inGame: 2, messagesIn: 40, messagesOut: 380 },
  players: [{ characterId: 1, accountId: 9, account: 'ember', name: 'Ashcaller', classId: 'mage', level: 12, game: 'i1', roomId: 'i1-world', room: 'The World', region: 'Gloomvale', party: "Ashcaller's party (2)", onlineSeconds: 1500 }],
  rooms: [
    worldRoom,
    { id: 'i1-dg-1-0', name: 'Crypt', kind: 'dungeon', game: 'i1', players: 0, monsters: 30, minions: 0, spells: 0, tickMs: 0.1, tickMaxMs: 0.2 },
  ],
  worlds: [world],
  log: [{ id: 2, at: 0, kind: 'error', text: 'tick failed' }],
  staff: [],
};

const noActions: PlayerActions = { canTeleport: false, canKick: false, onGoto: () => undefined, onKick: () => undefined, onOpen: () => undefined };

describe('the Live view parts', () => {
  it('accepts a full reply and refuses a broken one', () => {
    expect(isAdminLive(live)).toBe(true);
    expect(isAdminLive({ ...live, log: null, staff: null })).toBe(true);
    expect(isAdminLive({ ...live, rooms: [{ ...worldRoom, kind: 'castle' }] })).toBe(false);
    expect(isAdminLive({ ...live, health: { ...live.health, tickHistory: { mean: ['x'], max: [] } } })).toBe(false);
  });

  it('colours tick time against the 50 ms budget', () => {
    expect(tickClass(10)).toBe('ok');
    expect(tickClass(30)).toBe('warn');
    expect(tickClass(51)).toBe('bad');
    expect(duration(30)).toBe('<1 min');
    expect(duration(3700)).toBe('1 h 1 min');
  });

  it('renders health with the worst tick flagged and a sparkline with the budget line', () => {
    const html = renderToStaticMarkup(createElement(HealthPanel, { health: live.health }));
    expect(html).toContain('3.2 ms');
    expect(html).toContain('live-stat bad');
    expect(html).toContain('380');
    expect(html).toContain('abcdef1');
    expect(html).toContain('live-spark-budget');
    const empty = renderToStaticMarkup(createElement(Sparkline, { mean: [], max: [] }));
    expect(empty).toContain('No tick samples yet');
  });

  it('renders players with region, party and time online, and actions only when allowed', () => {
    const none = renderToStaticMarkup(createElement(PlayersTable, { players: live.players, actions: noActions }));
    expect(none).toContain('Gloomvale');
    expect(none).toContain('Ashcaller&#x27;s party (2)');
    expect(none).toContain('25 min');
    expect(none).not.toContain('Kick');
    expect(none).not.toContain('Go to');
    const all = renderToStaticMarkup(createElement(PlayersTable, { players: live.players, actions: { ...noActions, canKick: true, canTeleport: true } }));
    expect(all).toContain('Kick');
    expect(all).toContain('Go to');
    expect(renderToStaticMarkup(createElement(PlayersTable, { players: [], actions: noActions }))).toContain('Nobody is playing');
  });

  it('renders rooms busiest first with their kind and tick', () => {
    const html = renderToStaticMarkup(createElement(RoomsTable, { rooms: live.rooms }));
    expect(html.indexOf('The World')).toBeLessThan(html.indexOf('Crypt'));
    expect(html).toContain('World copy');
    expect(html).toContain('Dungeon');
    expect(html).toContain('2.1 / 9.0');
    const slow: LiveRoom = { ...worldRoom, tickMs: 40, tickMaxMs: 80 };
    expect(renderToStaticMarkup(createElement(RoomsTable, { rooms: [slow] }))).toContain('class="bad"');
  });

  it('renders the log tail with errors marked, and a minimap with regions, the town and dots', () => {
    const tail = renderToStaticMarkup(createElement(LogTail, { entries: live.log ?? [], label: 'log', empty: 'none' }));
    expect(tail).toContain('class="err"');
    expect(renderToStaticMarkup(createElement(LogTail, { entries: [], label: 'log', empty: 'Quiet' }))).toContain('Quiet');
    const map = renderToStaticMarkup(createElement(WorldMinimap, { world }));
    expect(map).toContain('live-map-town');
    expect(map).toContain('live-dot party');
    expect(map).toContain('<title>Gloomvale</title>');
    // Runs of one region in a row are one rect: row 0 is two runs, row 1 three.
    expect(map.match(/<rect [^>]*fill=/g)).toHaveLength(5);
  });
});

describe('Live view polling', () => {
  it('backs off on 429 up to 30 s and returns to its interval on the next answer', () => {
    let d = 3000;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push((d = nextPollDelay(d, 3000, true)));
    expect(seen).toEqual([6000, 12000, 24000, MAX_POLL_MS, MAX_POLL_MS, MAX_POLL_MS]);
    expect(nextPollDelay(d, 3000, false)).toBe(3000);
  });

  it('keeps each world copy\'s region grid after the first reply and asks for it no more', () => {
    const cache = new RegionCache();
    expect(cache.have()).toBe('');
    expect(cache.resolve([world])[0]?.regions).toBe(world.regions);
    expect(cache.have()).toBe('i1:0a1b2c3d');
    // Later replies leave the grid out; the cache fills it back in for the same plan only.
    expect(cache.resolve([{ ...world, regions: null }])[0]?.regions).toBe(world.regions);
    expect(cache.resolve([{ ...world, planHash: 'ffffffff', regions: null }])[0]?.regions).toBeNull();
    // A copy that closed is forgotten.
    cache.resolve([]);
    expect(cache.have()).toBe('');
    // A rebuild changes the plan hash, so the next reply's grid replaces the held one.
    const rebuilt = { cols: 2, rows: 1, cells: [0, 1], names: ['Mossy Barrens', 'Thornwood'] };
    cache.resolve([world]);
    expect(cache.resolve([{ ...world, planHash: '12345678', regions: rebuilt }])[0]?.regions).toBe(rebuilt);
    expect(cache.have()).toBe('i1:12345678');
  });

  it('shows a copy\'s seed and flags one built with older generation numbers', () => {
    const current = renderToStaticMarkup(createElement(WorldMinimap, { world }));
    expect(current).toContain('seed <span class="mono">1</span>');
    expect(current).not.toContain('older generation numbers');
    const older = renderToStaticMarkup(createElement(WorldMinimap, { world: { ...world, gen: { packs: 300 }, genCurrent: false } }));
    expect(older).toContain('older generation numbers');
    expect(older).toContain('packs 300');
    expect(isAdminLive({ ...live, worlds: [{ ...world, gen: { packs: 99999 } }] })).toBe(false);
    expect(isAdminLive({ ...live, worlds: [{ ...world, kind: 'secret' }] })).toBe(false);
  });

  it('reads a rebuild reply and sums it up, naming the copies that forgot their bosses and chests', () => {
    const copy = { game: 'i1', name: 'Public world 1', seed: 7, open: true, players: 3, planChanged: true };
    const reply = { copies: [copy, { ...copy, game: 'i4', name: "Bob's party world", open: false, players: 0, planChanged: false }], gen: { size: 12000 } };
    expect(isWorldRebuildResult(reply)).toBe(true);
    expect(isWorldRebuildResult({ copies: [{ ...copy, players: 'x' }], gen: {} })).toBe(false);
    expect(rebuildSummary(reply, 'Rebuilt')).toBe('Rebuilt 2 world copies, 3 players carried over; 1 closed, built anew when next entered; a new plan in Public world 1: dead bosses and opened chests there are forgotten');
    expect(rebuildSummary({ copies: [{ ...copy, planChanged: false, players: 1 }], gen: {} }, 'Rebuilt')).toBe('Rebuilt 1 world copy, 1 player carried over; the plan is unchanged, so bosses and chests stay as they were');
    expect(rebuildSummary({ copies: [], gen: {} }, 'Rebuilt')).toBe('No world copy to rebuild');
  });
});
