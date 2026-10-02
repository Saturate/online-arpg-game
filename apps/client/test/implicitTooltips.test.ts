import { compileRunes, createRune, DEFAULT_SIGIL_CONTEXT, tokenizeSpell, type RuneItem } from '@rune/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DamageLines, RuneImplicit } from '../src/ui/DamageLines.js';
import { ItemDetails } from '../src/ui/parts.js';

const rolledBolt: RuneItem = {
  ...createRune(1, 'bolt'),
  tier: 'rare',
  name: 'Honed Bolt Rune',
  implicit: { id: 'implicit_base', tier: 4, value: 112 },
  affixes: [
    { id: 'rune_damage', tier: 3, value: 20, max: 60 },
    { id: 'rune_pierce', tier: 1, value: 0, max: 2 },
  ],
};

describe('implicits and ranged rolls in tooltips', () => {
  it('a rune shows its implicit and its base hit above its affixes, and ranges as "1 to 4"', () => {
    const html = renderToStaticMarkup(createElement(ItemDetails, { item: rolledBolt, classId: 'mage' }));
    const implicit = html.indexOf('112% base damage');
    const affix = html.indexOf('+20 to 60% damage');
    expect(implicit).toBeGreaterThan(-1);
    expect(affix).toBeGreaterThan(implicit);
    expect(html).toContain('Pierces 0 to 2 enemies');
    // 12 to 20 at 112%.
    expect(html).toContain('13 to 22 physical');
    expect(html).toContain('T2');
  });

  it('every rune shows its implicit, plain ones too, with its tier', () => {
    const fire = renderToStaticMarkup(createElement(RuneImplicit, { item: createRune(2, 'fire') }));
    expect(fire).toContain('Converts at 100% to fire');
    expect(fire).toContain('T4');
    const split = renderToStaticMarkup(createElement(RuneImplicit, { item: { ...createRune(3, 'split'), implicit: { id: 'implicit_split', tier: 5, value: 2 } } }));
    expect(split).toContain('Up to 2 extra copies on a cast');
  });

  it('the damage lines read a ranged Split as a copy range', () => {
    const c = compileRunes(tokenizeSpell('bolt split(2 to 4)').runes, { ...DEFAULT_SIGIL_CONTEXT, classId: 'mage' });
    if (!c.ok) throw new Error('compile');
    const html = renderToStaticMarkup(createElement(DamageLines, { program: c.program }));
    expect(html).toContain('Bolt x2 to 4');
  });
});
