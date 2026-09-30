import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { adminUrl, saveDownload } from '../../../scripts/adminClient.js';

const base = new URL('https://arpg.akj.io');

function href(path: string): string {
  const url = adminUrl(path, base);
  return typeof url === 'string' ? `refused: ${url}` : url.href;
}

describe('pnpm admin: where the token goes', () => {
  it('builds admin API URLs on the server from ARPG_URL', () => {
    expect(href('overview')).toBe('https://arpg.akj.io/api/admin/overview');
    expect(href('log?since=120')).toBe('https://arpg.akj.io/api/admin/log?since=120');
    expect(href('/api/admin/settings')).toBe('https://arpg.akj.io/api/admin/settings');
    expect(href('accounts/3/role')).toBe('https://arpg.akj.io/api/admin/accounts/3/role');
    const local = adminUrl('overview', new URL('http://localhost:8080'));
    expect(typeof local === 'string' ? local : local.href).toBe('http://localhost:8080/api/admin/overview');
  });

  it('refuses anything that could send the token to another host or outside the admin API', () => {
    for (const path of [
      '//evil.example/x',
      '/\\evil.example/x',
      '\\\\evil.example/x',
      '/\t/evil.example/x',
      '/\n/evil.example/x',
      ' //evil.example/x',
      'https://evil.example/api/admin/overview',
      'HTTP://evil.example/x',
      'javascript:alert(1)',
      'mailto:x@evil.example',
      '/api/admin//evil.example',
      '/api/login',
      '/api/characters',
      '/api/admin/../login',
      '/api/admin/%2e%2e/login',
      '../characters',
      '/api/adminx/overview',
      '/api/admin',
      '',
    ]) {
      expect([path, href(path).startsWith('refused: ')]).toEqual([path, true]);
    }
  });
});

describe('pnpm admin: backup downloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rune-admin-client-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const stream = (chunks: string[], failAtEnd: boolean) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        if (failAtEnd) controller.error(new Error('connection reset'));
        else controller.close();
      },
    });

  it('writes a finished download with mode 600', async () => {
    const file = join(dir, 'ok.db');
    await saveDownload(stream(['SQLite ', 'format 3'], false), file);
    expect(readFileSync(file, 'utf8')).toBe('SQLite format 3');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('removes the partial file when the download fails', async () => {
    const file = join(dir, 'partial.db');
    await expect(saveDownload(stream(['half a database'], true), file)).rejects.toThrow('connection reset');
    expect(existsSync(file)).toBe(false);
  });

  it('never touches a file that was already there', async () => {
    const file = join(dir, 'taken.db');
    writeFileSync(file, 'keep me');
    await expect(saveDownload(stream(['new'], false), file)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('keep me');
  });
});
