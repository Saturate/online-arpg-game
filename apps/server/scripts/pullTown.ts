import { validateLayout } from '@rune/shared';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Copies the live town into the repo, so builds made in game on the server end up in git.
 * Usage: pnpm town:pull [url]   (defaults to the public server)
 */

const url = process.argv[2] ?? process.env.TOWN_URL ?? 'https://arpg.akj.io/api/town';
const target = fileURLToPath(new URL('../data/town-layout.json', import.meta.url));

const res = await fetch(url);
if (!res.ok) throw new Error(`${url} answered ${res.status}`);
// Validated like a save from the editor, so a broken or hostile response never reaches git.
const layout = validateLayout(await res.json());
if (!layout) throw new Error(`${url} did not return a valid town layout`);

const next = `${JSON.stringify(layout, null, 2)}\n`;
let current = '';
try {
  current = readFileSync(target, 'utf8');
} catch {
  // First pull.
}
if (current === next) {
  console.log('The committed town already matches the live one.');
} else {
  writeFileSync(target, next);
  console.log(`Wrote ${layout.name} (${layout.props.length} props, ${layout.paths.length} paths) to ${target}`);
}
