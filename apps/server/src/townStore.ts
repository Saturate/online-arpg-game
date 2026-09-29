import { DEFAULT_TOWN_LAYOUT, validateLayout, type TownLayout } from '@rune/shared';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Where the town editor saves. Kept in the repo by default so a designed town can be committed. */
const LAYOUT_PATH = resolve(process.env.TOWN_LAYOUT ?? 'data/town-layout.json');

export function loadTownLayout(): TownLayout {
  try {
    const layout = validateLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
    if (layout) return layout;
    console.warn(`${LAYOUT_PATH} is invalid, using the default town`);
  } catch {
    // No saved layout yet: the shipped default town is used.
  }
  return DEFAULT_TOWN_LAYOUT;
}

export function saveTownLayout(layout: TownLayout): void {
  mkdirSync(dirname(LAYOUT_PATH), { recursive: true });
  // Written aside and renamed, so a crash mid-write cannot leave a half file that loads as the default town.
  const tmp = `${LAYOUT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`);
  renameSync(tmp, LAYOUT_PATH);
}
