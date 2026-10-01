/**
 * Saves a town layout on the server through the admin API, as the in-game editor would: the server
 * validates it the same way, writes it and rebuilds every world room, carrying players over.
 *
 *   pnpm town:push apps/server/data/town-layout.json
 *
 * Needs a token with the townEdit scope in ~/.config/arpg/admin-token, and ARPG_URL for another
 * server than https://arpg.akj.io (see scripts/admin.ts). Exits non-zero on an error.
 */
import { readFileSync } from 'node:fs';
import { checkLayout } from '../packages/shared/src/index.js';
import { adminUrl } from './adminClient.js';
import { baseUrl, fail, readToken } from './adminAuth.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const file = process.argv[2];
if (!file) fail('Usage: pnpm town:push <layout.json>');
let text: string;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  fail(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
}
let body: unknown;
try {
  body = JSON.parse(text);
} catch {
  fail(`${file} is not JSON`);
}
// The server checks it again; checked here first so a broken file never costs a call.
const layout = checkLayout(body);
if (typeof layout === 'string') fail(`${file} is not a valid town layout: ${layout}`);

const base = baseUrl();
const url = adminUrl('town', base);
if (typeof url === 'string') fail(url);
// A redirect would be followed with the token; the admin API never redirects, so one is an error.
const res = await fetch(url, {
  method: 'PUT',
  headers: { authorization: `Bearer ${readToken()}`, 'content-type': 'application/json' },
  body: text,
  redirect: 'error',
});
const reply = await res.text();
let parsed: unknown = null;
try {
  parsed = JSON.parse(reply);
} catch {
  // Not JSON (a proxy error page); printed as it came below.
}
if (!res.ok) fail(`${res.status}: ${isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : reply}`);
if (!isRecord(parsed)) fail(`Unexpected reply: ${reply}`);
const { name, props, paths, decor, hash, rooms, players } = parsed;
console.log(`Saved ${String(name)} on ${base.origin} (${String(props)} props, ${String(paths)} paths, ${String(decor)} decor, hash ${String(hash)}): ${String(rooms)} world rooms rebuilt, ${String(players)} players carried over.`);
