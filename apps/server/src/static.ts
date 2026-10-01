import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * Serves the built client in production, so game, API and WebSocket share one origin and one port.
 * In dev Vite serves the client instead and this is never mounted.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Fonts come from Google Fonts; everything else is same-origin. Inline styles are React style props. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  // blob: because GLTFLoader fetches a model's embedded textures through blob URLs.
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const UNHASHED = ['/assets/kaykit/', '/assets/monsters/'];

/** `path` is the served file relative to the root, with forward slashes and a leading one. */
export function hashedAsset(path: string): boolean {
  return path.startsWith('/assets/') && !UNHASHED.some((p) => path.startsWith(p));
}

/** Weak because it comes from size and modification time, not the bytes. */
export function weakEtag(info: Pick<Stats, 'size' | 'mtimeMs'>): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

/**
 * Whether the browser's copy is current. If-None-Match wins over If-Modified-Since when both are
 * sent (RFC 9110 13.2.2); weak comparison, since every tag here is weak.
 */
export function notModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const inm = req.headers['if-none-match'];
  if (inm !== undefined) {
    const strip = (t: string) => t.trim().replace(/^W\//, '');
    return inm.split(',').some((t) => t.trim() === '*' || strip(t) === strip(etag));
  }
  const ims = req.headers['if-modified-since'];
  if (ims === undefined) return false;
  const since = Date.parse(ims);
  // HTTP dates have whole seconds.
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

export function staticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const base = resolve(root);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let path: string;
    try {
      // Leading slashes collapse to one: a decoded "//admin" would otherwise turn the folder redirect
      // below into a protocol-relative link to another host.
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '/');
    } catch {
      return false;
    }
    // Staff pages are folders (/admin/, /admin/dev/), each with its own index.html.
    if (path.endsWith('/')) path += 'index.html';
    // normalize collapses "..", and the prefix check rejects anything that still escapes the root.
    const file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return false;
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      // Only redirect to folders that are pages, so a bare /assets does not advertise the folder.
      const index = await stat(join(file, 'index.html')).catch(() => null);
      if (!index?.isFile()) return false;
      res.writeHead(301, { location: `${path}/` });
      res.end();
      return true;
    }
    if (!info?.isFile()) return false;
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // Judged on the file actually served, so "/x/../assets/a.js" or a folder index gets the rule of what it is.
    const served = '/' + relative(base, file).split(sep).join('/');
    // Vite puts a content hash in every file it builds under /assets, so those can be cached
    // forever. The model folders are copied from public/ under fixed names, so a fixed model
    // would never reach a browser that has the old one: those revalidate, cheaply, by ETag.
    const hashed = hashedAsset(served);
    const etag = weakEtag(info);
    const common = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      ...(hashed ? { 'cache-control': 'public, max-age=31536000, immutable' } : { 'cache-control': 'no-cache', etag, 'last-modified': info.mtime.toUTCString() }),
    };
    if (!hashed && notModified(req, etag, info.mtimeMs)) {
      res.writeHead(304, common);
      res.end();
      return true;
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      ...common,
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}
