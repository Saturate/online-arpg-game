import { applyTunables, compileRunes, DEFAULT_SIGIL_CONTEXT, resetTunables, tokenizeSpell, type SpellProgram } from '@rune/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { addedType, DamageLines, ShapeImplicit } from '../src/ui/DamageLines.js';

function program(text: string): SpellProgram {
  const c = compileRunes(tokenizeSpell(text).runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage' });
  if (!c.ok) throw new Error(text);
  return c.program;
}

afterEach(() => resetTunables());

describe('damage in tooltips and the forge', () => {
  it('shows each shape with its damage by type, each type in its own colour class', () => {
    const html = renderToStaticMarkup(createElement(DamageLines, { program: program('bolt[onhit, adds 4 cold] fire nova') }));
    expect(html).toContain('<span class="dmg dmg-fire">12 to 20 fire</span>');
    expect(html).toContain('<span class="dmg dmg-cold">4 to 8 cold</span>');
    expect(html).toContain('Nova');
    expect(html).toContain('<span class="dmg dmg-fire">10 to 18 fire</span>');
    expect(html).toContain('a hit');
  });

  it('shows nothing for a spell that deals no damage', () => {
    expect(renderToStaticMarkup(createElement(DamageLines, { program: program('nova restore') }))).toBe('');
  });

  it("a shape rune's implicit is its live base range, physical; other runes have none", () => {
    expect(renderToStaticMarkup(createElement(ShapeImplicit, { rune: 'bolt' }))).toContain('Deals <span class="dmg dmg-physical">12 to 20 physical</span> damage');
    applyTunables({ 'spell.bolt.damageMin': 8, 'spell.bolt.damageMax': 14 });
    expect(renderToStaticMarkup(createElement(ShapeImplicit, { rune: 'bolt' }))).toContain('8 to 14 physical');
    expect(renderToStaticMarkup(createElement(ShapeImplicit, { rune: 'fire' }))).toBe('');
    expect(renderToStaticMarkup(createElement(ShapeImplicit, { rune: 'aura' }))).toBe('');
  });

  it('colours an "Adds" roll by its element', () => {
    expect(addedType({ id: 'rune_added_lightning', tier: 0, value: 1 })).toBe('lightning');
    expect(addedType({ id: 'rune_damage', tier: 0, value: 10 })).toBeNull();
  });
});
