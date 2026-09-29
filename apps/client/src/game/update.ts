import type { GameMode } from '@rune/shared';

/**
 * Stale tabs after a deploy: the server restarts, the tab reconnects, sees a different build in the
 * welcome and reloads itself, then resumes the same character without the player doing anything.
 */

// typeof keeps this safe where Vite's define did not run (tests).
export const CLIENT_BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const RESUME_KEY = 'rune.resume';
const ATTEMPT_KEY = 'rune.updateAttempt';

export interface Resume {
  characterId: number;
  mode: GameMode;
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Blocked storage: the tab still reloads, the player just picks the character again.
  }
}

/**
 * True when the tab is reloading. Returns false (and lets the caller warn) if this tab already
 * reloaded for the same server build and still does not match, so a bad deploy cannot loop.
 */
export function reloadForUpdate(serverBuild: string, resume: Resume): boolean {
  if (serverBuild === 'dev' || CLIENT_BUILD === 'dev' || serverBuild === CLIENT_BUILD) return false;
  if (read(ATTEMPT_KEY) === serverBuild) return false;
  write(ATTEMPT_KEY, serverBuild);
  write(RESUME_KEY, JSON.stringify(resume));
  location.reload();
  return true;
}

/** The character to jump back into after an update reload, read once. */
export function takeResume(): Resume | null {
  const raw = read(RESUME_KEY);
  write(RESUME_KEY, null);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const id: unknown = Reflect.get(v, 'characterId');
    const mode: unknown = Reflect.get(v, 'mode');
    return typeof id === 'number' && (mode === 'world' || mode === 'arena') ? { characterId: id, mode } : null;
  } catch {
    return null;
  }
}

export function isOutdated(serverBuild: string): boolean {
  return serverBuild !== 'dev' && CLIENT_BUILD !== 'dev' && serverBuild !== CLIENT_BUILD;
}
