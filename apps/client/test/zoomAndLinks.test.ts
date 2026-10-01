import { createGear, Rng, type InventoryMessage, type SigilItem } from '@rune/shared';
import { describe, expect, it } from 'vitest';
import { effectiveZoom, stepZoomScale, ZOOM_SCALE_RANGE } from '../src/game/zoom.js';
import { composeChat, ownItem } from '../src/ui/chatCompose.js';
import { parseSettings } from '../src/ui/settings.js';

const limits = { zoomDefault: 1, zoomDungeon: 1.2, zoomMin: 0.8, zoomMax: 1.4 };

describe('camera zoom', () => {
  it('starts at the area default and stays inside the admin limits', () => {
    expect(effectiveZoom(limits, false, 1)).toBe(1);
    expect(effectiveZoom(limits, true, 1)).toBe(1.2);
    expect(effectiveZoom(limits, false, 3)).toBe(1.4);
    expect(effectiveZoom(limits, false, 0.1)).toBe(0.8);
    expect(effectiveZoom(limits, false, Number.NaN)).toBe(1);
  });

  it('follows a tightened limit at once, with no reset needed', () => {
    expect(effectiveZoom({ ...limits, zoomMax: 1.1 }, false, 1.3)).toBe(1.1);
  });

  it('copes with limits that arrive swapped', () => {
    expect(effectiveZoom({ ...limits, zoomMin: 1.4, zoomMax: 0.8 }, false, 5)).toBe(1.4);
  });

  it('steps in and out, and does not bank factor past a limit', () => {
    let scale = 1;
    for (let i = 0; i < 50; i++) scale = stepZoomScale(limits, false, scale, -1);
    expect(effectiveZoom(limits, false, scale)).toBeCloseTo(1.4);
    // One step out from the limit moves the view straight away.
    expect(effectiveZoom(limits, false, stepZoomScale(limits, false, scale, 1))).toBeLessThan(1.4);
    for (let i = 0; i < 50; i++) scale = stepZoomScale(limits, false, scale, 1);
    expect(effectiveZoom(limits, false, scale)).toBeCloseTo(0.8);
  });

  it('keeps the stored factor sane', () => {
    expect(parseSettings(JSON.stringify({ options: { zoomScale: 1.2 } })).options.zoomScale).toBe(1.2);
    expect(parseSettings(JSON.stringify({ options: { zoomScale: ZOOM_SCALE_RANGE.max + 1 } })).options.zoomScale).toBe(1);
    expect(parseSettings(JSON.stringify({ options: { zoomScale: 'big' } })).options.zoomScale).toBe(1);
  });
});

describe('composing item links', () => {
  it('turns labels into tokens in the order links were added', () => {
    const msg = composeChat('trade [Axe] for [Ring]?', [
      { uid: 5, name: 'Ring' },
      { uid: 9, name: 'Axe' },
    ]);
    expect(msg).toEqual({ text: 'trade {2} for {1}?', links: [5, 9] });
  });

  it('drops a link whose label was deleted, and keeps two of the same name apart', () => {
    expect(composeChat('just text', [{ uid: 1, name: 'Axe' }])).toEqual({ text: 'just text', links: [] });
    expect(composeChat('[Axe] [Axe]', [{ uid: 1, name: 'Axe' }, { uid: 2, name: 'Axe' }])).toEqual({ text: '{1} {2}', links: [1, 2] });
  });

  it('sends at most three', () => {
    const links = [1, 2, 3, 4].map((uid) => ({ uid, name: `I${uid}` }));
    expect(composeChat('[I1][I2][I3][I4]', links).links).toEqual([1, 2, 3]);
  });

  it('finds runes inscribed in a sigil', () => {
    const gear = createGear(1, new Rng(1), 'common', 1);
    const sigil: SigilItem = { uid: 2, kind: 'sigil', tier: 'magic', name: 'S', ilvl: 1, affixes: [], corrupted: false, slots: [{ uid: 3, kind: 'rune', tier: 'common', name: 'Bolt Rune', ilvl: 1, rune: 'bolt', count: 1, affixes: [] }] };
    const inv: InventoryMessage = { t: 'inventory', items: [gear, sigil], inventory: [], stash: { stashFormat: 2, general: [], runes: { kind: 'runes', list: [] }, sigils: { kind: 'sigils', list: [] } }, stashTabPrice: null, gold: 0, sigils: [], warband: [], gear: { weapon: null, helmet: null, body: null, gloves: null, boots: null, belt: null, amulet: null, ring1: null, ring2: null } };
    expect(ownItem(inv, 3)?.name).toBe('Bolt Rune');
    expect(ownItem(inv, 1)).toBe(gear);
    expect(ownItem(inv, 99)).toBeUndefined();
  });
});
