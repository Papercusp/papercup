import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicDocsRelativePath, servePublicDocs } from './public-docs';

describe('public manual read boundary', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'public-docs-test-'));
    root = join(dir, 'public');
    await mkdir(join(root, 'pagefind'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'index.html'), '<h1>Public manual</h1>'),
      writeFile(join(root, 'using-the-app.html'), '<h1>Get started</h1>'),
      writeFile(join(root, '404.html'), '<h1>Not found</h1>'),
      writeFile(join(root, 'pagefind', 'pagefind.js'), 'export const search = true;'),
      writeFile(join(dir, 'private.txt'), 'private-engineering-secret'),
    ]);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET') => new Request(`https://portal.example${path}`, { method });

  it.each(['/docs', '/docs/', '/docs/index.html'])('serves the anonymous home at %s', async (path) => {
    const response = await servePublicDocs(request(path), root);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Public manual');
    expect(response.headers.get('content-type')).toContain('text/html');
  });
  it('serves extensionless articles and correct search MIME without auth', async () => {
    expect(await (await servePublicDocs(request('/docs/using-the-app/'), root)).text()).toContain('Get started');
    const asset = await servePublicDocs(request('/docs/pagefind/pagefind.js'), root);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('HEAD matches GET status and headers with no body', async () => {
    for (const path of ['/docs', '/docs/using-the-app', '/docs/missing']) {
      const get = await servePublicDocs(request(path), root);
      const head = await servePublicDocs(request(path, 'HEAD'), root);
      expect(head.status).toBe(get.status);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(await head.text()).toBe('');
    }
  });
  it('returns genuine missing-page and unavailable-artifact statuses', async () => {
    expect((await servePublicDocs(request('/docs/missing'), root)).status).toBe(404);
    expect((await servePublicDocs(request('/docs'), join(dir, 'absent'))).status).toBe(503);
  });
  it.each(['/docs/%', '/docs/%2e%2e%2fprivate.txt', '/docs/%252e%252e/private.txt',
    '/docs/%5c..%5cprivate.txt', '/docs/%00secret', '/internal/docs/index.html', '/api/config'])(
    'rejects an invalid namespace or path: %s', async (path) => {
      expect(publicDocsRelativePath(path)).toBeNull();
      const response = await servePublicDocs(request(path), root);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('private-engineering-secret');
    });
  it('refuses symlink escape and non-read methods', async () => {
    await symlink(join(dir, 'private.txt'), join(root, 'escape.txt'));
    expect((await servePublicDocs(request('/docs/escape.txt'), root)).status).toBe(404);
    const response = await servePublicDocs(request('/docs', 'POST'), root);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
