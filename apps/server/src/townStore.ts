import { DEFAULT_TOWN_LAYOUT, validateLayout, type TownLayout } from '@rune/shared';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import committedTown from '../data/town-layout.json' with { type: 'json' };

/**
 * Where the town editor saves. In dev that is the committed town file itself, so towns built
 * locally land straight in git; production points it at the data volume (see the Dockerfile).
 */
const LAYOUT_PATH = resolve(process.env.TOWN_LAYOUT ?? 'data/town-layout.json');

export function loadTownLayout(): TownLayout {
  try {
    // A piece whose asset the game no longer has is dropped rather than losing the whole town.
    const layout = validateLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')), { unknownDecor: 'drop' });
    if (layout) return layout;
    console.warn(`${LAYOUT_PATH} is invalid, using the committed town`);
  } catch {
    // Nothing saved on this server yet.
  }
  // The committed town (pull the live one with `pnpm town:pull`) is bundled in, so a fresh server starts from it.
  return validateLayout(committedTown, { unknownDecor: 'drop' }) ?? DEFAULT_TOWN_LAYOUT;
}

export function saveTownLayout(layout: TownLayout): void {
  mkdirSync(dirname(LAYOUT_PATH), { recursive: true });
  // Written aside and renamed, so a crash mid-write cannot leave a half file that loads as the default town.
  const tmp = `${LAYOUT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`);
  renameSync(tmp, LAYOUT_PATH);
}
