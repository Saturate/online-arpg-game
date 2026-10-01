import { activeTunables, compileSigilItem, createStarterSigil, resetTunables, SPELL, starterSigilById, type SigilItem } from '@rune/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReplay, Recorder } from '../src/game/replay.js';
import { receiveTunables, useTunables } from '../src/game/tunables.js';

afterEach(() => resetTunables());

function fireball(): SigilItem {
  const def = starterSigilById('fireball');
  if (!def) throw new Error('no Fireball starter');
  let uid = 1;
  return createStarterSigil(() => uid++, def, { bound: true });
}

function tooltipForce(): number {
  const r = compileSigilItem(fireball(), 'mage');
  if (!r.ok) throw new Error('Fireball does not compile');
  return r.force;
}

describe('the client follows the server live tuning', () => {
  it('applies a change to the numbers tooltips compile from, and bumps the version memos watch', () => {
    const before = tooltipForce();
    const version = useTunables.getState().version;
    receiveTunables({ 'force.rune.orb': 30, 'spell.orb.damage': 24 });
    expect(tooltipForce()).toBeGreaterThan(before);
    expect(SPELL.orb.damage).toBe(24);
    expect(useTunables.getState().version).toBeGreaterThan(version);
  });

  it('drops values it does not know or that are out of range, and keeps the rest', () => {
    receiveTunables({ 'force.rune.orb': 30, 'spell.from.a.newer.server': 1, 'spell.bolt.damage': -10 });
    expect(activeTunables()).toEqual({ 'force.rune.orb': 30 });
    expect(SPELL.bolt.damage).toBe(16);
  });

  it('goes back to code defaults on a welcome without tuning (an old replay) or with a bad one', () => {
    const plain = tooltipForce();
    receiveTunables({ 'force.rune.orb': 30 });
    receiveTunables(undefined);
    expect(tooltipForce()).toBe(plain);
    receiveTunables({ 'force.rune.orb': 30 });
    receiveTunables('nonsense');
    expect(activeTunables()).toEqual({});
  });

  it('lets a recording carry the tuning it ran with', () => {
    const rec = new Recorder('mage', 'Ember', [
      { t: 'welcome', playerId: 1, tick: 0, tickMs: 50, roomId: 'town', map: { kind: 'flat' }, canPause: false, editor: false, townEditor: false, devTools: false, tunables: {} },
      { t: 'tunables', values: { 'spell.orb.damage': 24 } },
    ]);
    const file = parseReplay(JSON.parse(JSON.stringify(rec.finish())));
    if (typeof file === 'string') throw new Error(file);
    const msg = file.frames[1]?.msg;
    expect(msg?.t === 'tunables' && msg.values).toEqual({ 'spell.orb.damage': 24 });
  });
});
