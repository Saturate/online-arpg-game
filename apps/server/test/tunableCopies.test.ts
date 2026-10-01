import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TUNABLES } from '@rune/shared';
import { describe, expect, it } from 'vitest';

/**
 * Live tuning writes the config objects in place, so a number copied out of one at module load
 * keeps the code default. This fails on any top-level statement that reads a tunable without a
 * function around it; move the read to where the number is used.
 */
describe('no module-level copies of tunable numbers', () => {
  const roots = ['SPELL', 'AURA', 'LINK', 'AILMENTS', 'RUNE_FORCE', 'RUNE_SPIRIT', 'RUNE_PRICE', 'PLAIN_MODIFIER_EFFECT', 'CONCENTRATED', 'DEFAULTS'];
  const heatKeys = TUNABLES.filter((t) => t.path.startsWith('force.') && !t.path.startsWith('force.rune.') && t.path !== 'force.splitPerCopy').map((t) => t.path.slice('force.'.length));
  const read = new RegExp(`\\b(?:(?:${roots.join('|')})\\.|HEAT\\.(?:${heatKeys.join('|')})\\b)`);
  const repo = join(import.meta.dirname, '..', '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });

  it('finds none in shared, the server or the client', () => {
    const found: string[] = [];
    for (const dir of ['packages/shared/src', 'apps/server/src', 'apps/client/src']) {
      for (const file of files(join(repo, dir))) {
        if (file.endsWith(join('tuning', 'registry.ts'))) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!/^(export )?(const|let) /.test(line)) return;
          // The statement runs to the next line that starts at column 0.
          let end = i + 1;
          while (end < lines.length && !/^\S/.test(lines[end] ?? '')) end++;
          const statement = [line, ...lines.slice(i + 1, end)]
            .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
            .map((l) => l.replace(/\/\/.*$/, ''))
            .join('\n');
          if (/=>|function\b/.test(statement)) return;
          if (read.test(statement)) found.push(`${file.slice(repo.length + 1)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
