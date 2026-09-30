/**
 * Calls the admin API with a token made on the admin page (API tokens tab):
 *
 *   pnpm admin GET overview
 *   pnpm admin GET 'log?since=120'
 *   pnpm admin PUT settings '{"xpRate":2}'
 *   pnpm admin backup ./rune-copy.db
 *
 * A path without a leading slash is under /api/admin/; any path must end up there. The token is read from
 * ~/.config/arpg/admin-token, which must be readable by its owner only (chmod 600), and the server
 * from ARPG_URL (default https://arpg.akj.io). Prints the JSON reply; exits non-zero on an error.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adminUrl, saveDownload } from './adminClient.js';

const TOKEN_FILE = join(homedir(), '.config', 'arpg', 'admin-token');
const TOKEN = /^arpg_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isMethod(v: string): v is Method {
  return METHODS.some((m) => m === v);
}

function readToken(): string {
  let mode: number;
  try {
    mode = statSync(TOKEN_FILE).mode;
  } catch {
    fail(`No token file at ${TOKEN_FILE}. Make a token on the admin page, then:\n  mkdir -p ~/.config/arpg && (umask 077; pbpaste > ${TOKEN_FILE})`);
  }
  // Same rule as ssh keys: a token others on the machine can read is as good as theirs.
  if ((mode & 0o077) !== 0) fail(`${TOKEN_FILE} is readable by others; run chmod 600 ${TOKEN_FILE}`);
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!TOKEN.test(token)) fail(`${TOKEN_FILE} does not hold an admin token (arpg_...)`);
  return token;
}

function baseUrl(): URL {
  const raw = process.env.ARPG_URL ?? 'https://arpg.akj.io';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`ARPG_URL is not a URL: ${raw}`);
  }
  // The token would cross the network in the clear otherwise.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('ARPG_URL must be https (plain http only for localhost)');
  return url;
}

function urlFor(path: string, base: URL): URL {
  const url = adminUrl(path, base);
  if (typeof url === 'string') fail(url);
  return url;
}

async function main(): Promise<void> {
  const [first, second, third] = process.argv.slice(2);
  if (!first) fail('Usage: pnpm admin <GET|POST|PUT|DELETE> <path> [json]  or  pnpm admin backup <file>');
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
  if (!isMethod(method) || !second) fail('Usage: pnpm admin <GET|POST|PUT|DELETE> <path> [json]');
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
