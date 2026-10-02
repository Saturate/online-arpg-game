import { activeTunables, compileSigilItem, createStarterSigil, resetTunables, SPELL, starterSigilById, type SigilItem } from '@rune/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReplay, Recorder } from '../src/game/replay.js';
import { receiveTunables, useTunables } from '../src/game/tunables.js';
import { compileSkill, studioSkillOf } from '../src/dev/studio/studioSim.js';

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
  it('shows a kit sigil at its own rolls, and the Spell Studio casts a draft as written', () => {
    const def = starterSigilById('fireball');
    if (!def) throw new Error('no Fireball kit');
    const sigil = fireball();
    const plain = compileSigilItem(sigil, 'mage');
    expect(plain.ok && plain.program.roots[0]?.tuning.damage).toBeCloseTo(1.55, 5);
    const skill = studioSkillOf(def);
    expect(skill.text).toContain('+55% damage');
    const studio = compileSkill(skill);
    expect(studio.ok && plain.ok && studio.force).toBeCloseTo(plain.ok ? plain.force : 0, 5);
    // A draft past the tables casts what it says: the studio is where kit numbers are drafted.
    const edited = compileSkill({ ...skill, text: skill.text.replace('+55% damage', '+100% damage') });
    expect(edited.ok && edited.program.roots[0]?.tuning.damage).toBeCloseTo(2, 5);
  });

  it('applies a change to the numbers tooltips compile from, and bumps the version memos watch', () => {
    const before = tooltipForce();
    const version = useTunables.getState().version;
    receiveTunables({ 'force.rune.orb': 30, 'spell.orb.damageMax': 24 });
    expect(tooltipForce()).toBeGreaterThan(before);
    expect(SPELL.orb.damageMax).toBe(24);
    expect(useTunables.getState().version).toBeGreaterThan(version);
  });

  it('drops values it does not know or that are out of range, and keeps the rest', () => {
    receiveTunables({ 'force.rune.orb': 30, 'spell.from.a.newer.server': 1, 'spell.bolt.damageMax': -10 });
    expect(activeTunables()).toEqual({ 'force.rune.orb': 30 });
    expect(SPELL.bolt.damageMax).toBe(20);
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
      { t: 'tunables', values: { 'spell.orb.damageMax': 24 } },
    ]);
    const file = parseReplay(JSON.parse(JSON.stringify(rec.finish())));
    if (typeof file === 'string') throw new Error(file);
    const msg = file.frames[1]?.msg;
    expect(msg?.t === 'tunables' && msg.values).toEqual({ 'spell.orb.damageMax': 24 });
  });
});
