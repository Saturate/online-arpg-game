import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TUNABLES } from '@rune/shared';
import { describe, expect, it } from 'vitest';

/**
 * Live tuning writes the config objects in place, so a number copied out of one when a module loads
 * (a constant, a destructured name, a class field) keeps the code default. This scans every source
 * file for such a read outside a function body and fails naming the line.
 */

const ROOTS = ['SPELL', 'AURA', 'LINK', 'AILMENTS', 'RUNE_FORCE', 'RUNE_SPIRIT', 'RUNE_PRICE', 'PLAIN_MODIFIER_EFFECT', 'CONCENTRATED', 'DEFAULTS'];
const HEAT_KEYS = TUNABLES.filter((t) => t.path.startsWith('force.') && !t.path.startsWith('force.rune.') && t.path !== 'force.splitPerCopy').map((t) => t.path.slice('force.'.length));
/** Any mention of a tunable config object, not only a property read: `const { bolt } = SPELL` copies too. */
const READ = new RegExp(`\\b(?:${ROOTS.join('|')})\\b|\\bHEAT\\.(?:${HEAT_KEYS.join('|')})\\b`);

/** Comments and string contents blanked, so a mention in prose or a message does not count. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
}

/** End index (exclusive) of the bracketed block opening at `open`. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

/**
 * The statement with every function body removed: `function ... { }`, arrow bodies in braces, and
 * expression arrows up to the comma or bracket that ends them. What remains runs at module load.
 */
function eagerPart(stmt: string): string {
  let s = stmt;
  for (;;) {
    const fn = /\bfunction\b[^{]*\{|=>\s*/.exec(s);
    if (!fn) return s;
    const start = fn.index;
    let end: number;
    if (fn[0].startsWith('function')) end = closeOf(s, start + fn[0].length - 1);
    else {
      const bodyAt = start + fn[0].length;
      if (s[bodyAt] === '{' || s[bodyAt] === '(') end = closeOf(s, bodyAt);
      else {
        let depth = 0;
        end = bodyAt;
        while (end < s.length) {
          const c = s[end];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth--;
          } else if ((c === ',' || c === ';') && depth === 0) break;
          end++;
        }
      }
    }
    s = s.slice(0, start) + s.slice(end);
  }
}

/** Every statement that runs when the module loads: top-level `const` and `let`, and class fields. */
function eagerStatements(src: string): { line: number; text: string }[] {
  const lines = src.split('\n');
  const out: { line: number; text: string }[] = [];
  let depth = 0;
  /** Brace depths of the class bodies we are inside. */
  const classes: number[] = [];
  const statementFrom = (i: number): string => {
    let text = '';
    let d = 0;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j] ?? '';
      text += `${l}\n`;
      for (const c of l) {
        if (c === '{' || c === '(' || c === '[') d++;
        else if (c === '}' || c === ')' || c === ']') d--;
      }
      if (d <= 0 && /;\s*$|^\S.*[^,{(\[=]\s*$/.test(l) && (j > i || /;\s*$/.test(l))) break;
      if (d <= 0 && j > i && lines[j + 1] !== undefined && /^\S/.test(lines[j + 1] ?? '')) break;
    }
    return text;
  };
  lines.forEach((l, i) => {
    const inClassBody = classes.length > 0 && classes[classes.length - 1] === depth;
    if (depth === 0 && /^(export )?(const|let) /.test(l)) out.push({ line: i + 1, text: statementFrom(i) });
    else if (inClassBody && /^\s+(?:(?:private|public|protected|readonly|static|override)\s+)*#?\w+\s*(?:[?!]?:[^=;(]+)?=(?!>)/.test(l)) out.push({ line: i + 1, text: statementFrom(i) });
    if (depth === 0 && /^(export )?(abstract )?class\b/.test(l) || (inClassBody && /\bclass\b/.test(l))) classes.push(depth + 1);
    for (const c of l) {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (classes.length > 0 && depth < (classes[classes.length - 1] ?? 0)) classes.pop();
      }
    }
  });
  return out;
}

function offenders(src: string): string[] {
  return eagerStatements(code(src)).flatMap(({ line, text }) => {
    // The config objects' own definitions.
    if (new RegExp(`^(export )?const (${ROOTS.join('|')})\\b`).test(text)) return [];
    return READ.test(eagerPart(text)) ? [`${line}: ${text.split('\n')[0]?.trim() ?? ''}`] : [];
  });
}

describe('no module-level copies of tunable numbers', () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });

  it('catches constants, destructuring, class fields and eager reads beside a function', () => {
    expect(offenders('const A = SPELL.bolt.damage * 2;')).toHaveLength(1);
    expect(offenders('export const { bolt } = SPELL;')).toHaveLength(1);
    expect(offenders('const pick = { f: () => 1, d: AURA.radius };')).toHaveLength(1);
    expect(offenders('const cost = HEAT.payloadAffixShare;')).toHaveLength(1);
    expect(offenders('class Foo {\n  private readonly r = AURA.radius;\n  m() {\n    const x = SPELL.bolt;\n  }\n}')).toHaveLength(1);
    expect(offenders('const f = (n: number) => SPELL.bolt.damage * n;')).toEqual([]);
    expect(offenders('export function g() {\n  return SPELL.bolt.damage;\n}')).toEqual([]);
    expect(offenders('const max = HEAT.max;')).toEqual([]);
    expect(offenders("// const A = SPELL.bolt.damage;\nconst s = 'SPELL.bolt';")).toEqual([]);
  });

  it('finds none in shared, the server or the client', () => {
    const found: string[] = [];
    for (const dir of ['packages/shared/src', 'apps/server/src', 'apps/client/src']) {
      for (const file of files(join(repo, dir))) {
        if (file.endsWith(join('tuning', 'registry.ts'))) continue;
        for (const o of offenders(readFileSync(file, 'utf8'))) found.push(`${file.slice(repo.length + 1)}:${o}`);
      }
    }
    expect(found).toEqual([]);
  });
});
