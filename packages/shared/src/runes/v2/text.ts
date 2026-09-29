import { parseSpell, type ParseResult } from './parse.js';
import type { GrammarContext } from './rules.js';
import { tokenizeSpell, type RuneToken } from './tokenize.js';

export interface TextParseResult extends ParseResult {
  tokens: RuneToken[];
}

/** Tokenizes and parses the text form. Tokenizer errors stop before the grammar runs, so indices always match tokens. */
export function parseSpellText(text: string, context: Partial<GrammarContext> = {}): TextParseResult {
  const t = tokenizeSpell(text);
  if (t.errors.length > 0) {
    return {
      ok: false,
      tree: null,
      errors: t.errors,
      stats: { depth: 0, peakEntities: 0, lifetimeEntities: 0, shapes: 0, persistent: false },
      tokens: t.tokens,
    };
  }
  return { ...parseSpell(t.runes, context), tokens: t.tokens };
}
