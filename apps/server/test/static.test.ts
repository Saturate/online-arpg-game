import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashedAsset, staticHandler } from '../src/static.js';

describe('static pages', () => {
  let server: Server;
  let base = '';
  let root = '';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rune-static-'));
    mkdirSync(join(root, 'admin', 'dev'), { recursive: true });
    mkdirSync(join(root, 'assets', 'monsters'), { recursive: true });
    writeFileSync(join(root, 'index.html'), 'game');
    writeFileSync(join(root, 'admin', 'index.html'), 'admin');
    writeFileSync(join(root, 'admin', 'dev', 'index.html'), 'dev');
    writeFileSync(join(root, 'assets', 'a.js'), 'js');
    writeFileSync(join(root, 'assets', 'monsters', 'charger.glb'), 'glb');
    const handle = staticHandler(root);
    server = createServer((req, res) => {
      void handle(req, res).then((served) => {
        if (served) return;
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('server has no TCP address');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const get = (path: string) => fetch(base + path, { redirect: 'manual' });

  it('serves a folder index for a trailing slash', async () => {
    expect(await (await get('/')).text()).toBe('game');
    expect(await (await get('/admin/')).text()).toBe('admin');
    expect(await (await get('/admin/dev/')).text()).toBe('dev');
  });

  it('redirects a page folder without its slash', async () => {
    const res = await get('/admin/dev');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/admin/dev/');
  });

  it('does not expose folders that are not pages', async () => {
    expect((await get('/assets')).status).toBe(404);
    expect((await get('/assets/')).status).toBe(404);
    expect((await get('/admin.html')).status).toBe(404);
  });

  it('caches hashed bundles forever but revalidates models kept under fixed names', async () => {
    const js = await get('/assets/a.js');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('etag')).toBeNull();
    const glb = await get('/assets/monsters/charger.glb');
    expect(glb.headers.get('cache-control')).toBe('no-cache');
    expect(glb.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(glb.headers.get('last-modified')).not.toBeNull();
    expect(hashedAsset('/assets/index-3f2a.js')).toBe(true);
    expect(hashedAsset('/assets/kaykit/adventurers/Barbarian.glb')).toBe(false);
    expect(hashedAsset('/assets/monsters/grave_hound.glb')).toBe(false);
  });

  it('answers 304 to a current ETag or date, and sends the file again when it changed', async () => {
    const first = await get('/assets/monsters/charger.glb');
    const etag = first.headers.get('etag') ?? '';
    const modified = first.headers.get('last-modified') ?? '';
    const again = (headers: Record<string, string>) => fetch(base + '/assets/monsters/charger.glb', { headers });
    const byTag = await again({ 'if-none-match': etag });
    expect(byTag.status).toBe(304);
    expect(byTag.headers.get('etag')).toBe(etag);
    expect((await again({ 'if-none-match': `"other", ${etag}` })).status).toBe(304);
    expect((await again({ 'if-modified-since': modified })).status).toBe(304);
    expect((await again({ 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() })).status).toBe(200);
    // A tag that no longer matches wins over a date that would.
    expect((await again({ 'if-none-match': '"stale"', 'if-modified-since': modified })).status).toBe(200);
    writeFileSync(join(root, 'assets', 'monsters', 'charger.glb'), 'glb, fixed');
    utimesSync(join(root, 'assets', 'monsters', 'charger.glb'), new Date(), new Date(Date.now() + 5000));
    const changed = await again({ 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('glb, fixed');
  });

  it('judges caching by the file served, not the raw path', async () => {
    // fetch normalizes dot segments before sending, so these go out raw.
    const raw = (path: string) =>
      new Promise<{ status: number; cache: string | undefined }>((done, fail) => {
        httpGet(base + '/', { path }, (res) => {
          res.resume();
          done({ status: res.statusCode ?? 0, cache: res.headers['cache-control'] });
        }).on('error', fail);
      });
    expect(await raw('/assets/../assets/monsters/charger.glb')).toEqual({ status: 200, cache: 'no-cache' });
    expect(await raw('/assets/monsters/../a.js')).toEqual({ status: 200, cache: 'public, max-age=31536000, immutable' });
    expect(await raw('/assets//monsters/charger.glb')).toEqual({ status: 200, cache: 'no-cache' });
  });

  it('never redirects to another host', async () => {
    const res = await get('/%2Fadmin');
    expect(res.headers.get('location')).toBe('/admin/');
  });
});
