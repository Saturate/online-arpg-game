import { DEFAULT_TOWN_LAYOUT, validateLayout, type TownLayout } from '@rune/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Where the town editor saves. Kept in the repo by default so a designed town can be committed. */
const LAYOUT_PATH = resolve(process.env.TOWN_LAYOUT ?? 'data/town-layout.json');

export const townEditorEnabled = process.env.TOWN_EDITOR === '1';

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
  writeFileSync(LAYOUT_PATH, `${JSON.stringify(layout, null, 2)}\n`);
}
