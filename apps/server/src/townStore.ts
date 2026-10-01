import { DEFAULT_TOWN_LAYOUT, validateLayout, type TownLayout } from '@rune/shared';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

/** Copies of the layout each save replaced, newest last; enough to undo a run of bad pushes. */
export const TOWN_BACKUPS = 10;

/** The rotated copies beside the layout, oldest first (the names sort by time). */
export function townBackups(path = LAYOUT_PATH): string[] {
  const prefix = `${basename(path)}.bak.`;
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(prefix)).sort().map((n) => join(dirname(path), n));
}

/**
 * Keeps the layout being replaced as `<file>.bak.<time>`, so a bad save can be rolled back by
 * copying one over the layout and restarting. Done before anything is written: if the copy fails,
 * the save fails with the old town untouched.
 */
function backUp(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${path}.bak.${stamp}`;
  // Two saves in one millisecond (only tests manage it) still keep both.
  for (let n = 1; existsSync(target); n++) target = `${path}.bak.${stamp}-${n}`;
  copyFileSync(path, target);
  const all = townBackups(path);
  for (const old of all.slice(0, Math.max(0, all.length - TOWN_BACKUPS))) rmSync(old, { force: true });
}

export function saveTownLayout(layout: TownLayout): void {
  mkdirSync(dirname(LAYOUT_PATH), { recursive: true });
  backUp(LAYOUT_PATH);
  // Written aside and renamed, so a crash mid-write cannot leave a half file that loads as the default town.
  const tmp = `${LAYOUT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`);
  renameSync(tmp, LAYOUT_PATH);
}
