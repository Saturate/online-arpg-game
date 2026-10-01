/**
 * Calls the admin API with a token made on the admin page (API tokens tab):
 *
 *   pnpm admin GET overview
 *   pnpm admin GET 'log?since=120'
 *   pnpm admin PUT settings '{"xpRate":2}'
 *   pnpm admin PATCH tuning '{"spell.bolt.damage":20,"force.rune.nova":null}'
 *   pnpm admin backup ./rune-copy.db
 *
 * A path without a leading slash is under /api/admin/; any path must end up there. The token is read from
 * ~/.config/arpg/admin-token, which must be readable by its owner only (chmod 600), and the server
 * from ARPG_URL (default https://arpg.akj.io). Prints the JSON reply; exits non-zero on an error.
 */
import { existsSync, statSync } from 'node:fs';
import { adminUrl, saveDownload } from './adminClient.js';
import { baseUrl, fail, readToken } from './adminAuth.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

function isMethod(v: string): v is Method {
  return METHODS.some((m) => m === v);
}

function urlFor(path: string, base: URL): URL {
  const url = adminUrl(path, base);
  if (typeof url === 'string') fail(url);
  return url;
}

async function main(): Promise<void> {
  const [first, second, third] = process.argv.slice(2);
  if (!first) fail('Usage: pnpm admin <GET|POST|PUT|PATCH|DELETE> <path> [json]  or  pnpm admin backup <file>');
  const token = readToken();
  const base = baseUrl();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };

  if (first === 'backup') {
    if (!second) fail('Usage: pnpm admin backup <file>');
    // Checked before asking, so a typo does not cost the server a full copy for nothing.
    if (existsSync(second)) fail(`${second} already exists; pick a new file name`);
    const res = await fetch(urlFor('backup', base), { headers, redirect: 'error' });
    if (!res.ok || !res.body) fail(`${res.status}: ${await res.text()}`);
    try {
      await saveDownload(res.body, second);
    } catch (err) {
      fail(`The download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`Wrote ${statSync(second).size} bytes to ${second}`);
    return;
  }

  const method = first.toUpperCase();
  if (!isMethod(method) || !second) fail('Usage: pnpm admin <GET|POST|PUT|PATCH|DELETE> <path> [json]');
  const url = urlFor(second, base);
  // A redirect would be followed with the token; the admin API never redirects, so one is an error.
  const init: RequestInit = { method, headers, redirect: 'error' };
  if (third !== undefined) {
    try {
      JSON.parse(third);
    } catch {
      fail('The body must be JSON');
    }
    headers['content-type'] = 'application/json';
    init.body = third;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON (a proxy error page); print it as it came.
  }
  if (!res.ok) fail(`${res.status}: ${out}`);
  console.log(out);
}

await main();
