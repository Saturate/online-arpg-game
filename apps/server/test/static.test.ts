import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticHandler } from '../src/static.js';

describe('static pages', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-static-'));
    mkdirSync(join(root, 'admin', 'dev'), { recursive: true });
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), 'game');
    writeFileSync(join(root, 'admin', 'index.html'), 'admin');
    writeFileSync(join(root, 'admin', 'dev', 'index.html'), 'dev');
    writeFileSync(join(root, 'assets', 'a.js'), 'js');
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

  it('never redirects to another host', async () => {
    const res = await get('/%2Fadmin');
    expect(res.headers.get('location')).toBe('/admin/');
  });
});
