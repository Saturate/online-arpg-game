/**
 * The parts of `pnpm admin` that decide where the token goes and what is left on disk, kept apart
 * from the script so tests can import them without running it.
 */
import { createWriteStream, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ADMIN_PREFIX = '/api/admin/';

/**
 * The URL for an admin API path, or why it is refused. The Bearer token is sent to whatever this
 * returns, so anything the URL parser could turn into another host is refused before parsing:
 * `//host` and `/\host` are protocol-relative to it, a scheme replaces the base, and it silently
 * drops tabs and newlines (`/\t/host` becomes `//host`). The origin and prefix are checked again on
 * the parsed URL, after `..` and `%2e` segments are resolved.
 */
export function adminUrl(path: string, base: URL): URL | string {
  if (path.length === 0) return 'The path is empty';
  // Control characters, spaces and DEL: the parser strips or rewrites some of them.
  if (/[\u0000- \u007f]/.test(path)) return 'The path may not hold spaces or control characters';
  if (path.includes('\\')) return 'The path may not hold a backslash';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return 'Give a path, not a URL; the server is ARPG_URL';
  const full = path.startsWith('/') ? path : `${ADMIN_PREFIX}${path}`;
  if (full.split(/[?#]/, 1)[0]?.includes('//')) return 'The path may not hold //';
  let url: URL;
  try {
    url = new URL(full, base);
  } catch {
    return `Not a valid path: ${path}`;
  }
  if (url.origin !== base.origin) return 'The path points at another server';
  if (!url.pathname.startsWith(ADMIN_PREFIX)) return `Only paths under ${ADMIN_PREFIX} are allowed`;
  return url;
}

/**
 * Streams a download into a new file. 'wx' never overwrites, and 600 because a backup holds every
 * account's password hash. A failed download removes the partial file, but only one this call made:
 * when the open itself fails (the name was taken in the meantime) the file is someone else's.
 */
export async function saveDownload(body: ReadableStream<Uint8Array>, file: string): Promise<void> {
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let created = false;
  out.once('open', () => {
    created = true;
  });
  try {
    await pipeline(Readable.fromWeb(body), out);
  } catch (err) {
    if (created) rmSync(file, { force: true });
    throw err;
  }
}
