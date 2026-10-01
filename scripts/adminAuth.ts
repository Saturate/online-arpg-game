/**
 * The token and server for scripts that call the admin API (`pnpm admin`, `pnpm town:push`). The
 * token is read from ~/.config/arpg/admin-token, which must be readable by its owner only, and the
 * server from ARPG_URL (default https://arpg.akj.io). Neither function ever prints the token.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = join(homedir(), '.config', 'arpg', 'admin-token');
const TOKEN = /^arpg_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function readToken(): string {
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

export function baseUrl(): URL {
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
