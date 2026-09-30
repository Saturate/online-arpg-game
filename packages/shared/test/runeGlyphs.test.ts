import { describe, expect, it } from 'vitest';
import { RUNE_GLYPHS, RUNE_IDS } from '../src/runes/v2/index.js';

describe('rune glyphs', () => {
  it('gives every rune a two-letter glyph no other rune shares', () => {
    const glyphs = RUNE_IDS.map((id) => RUNE_GLYPHS[id].toLowerCase());
    expect(glyphs.every((g) => g.length === 2)).toBe(true);
    expect(new Set(glyphs).size).toBe(RUNE_IDS.length);
  });
});
