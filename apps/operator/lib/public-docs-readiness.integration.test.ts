import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { servePublicDocs } from '@papercusp/operator-core/lib/public-docs';

const root = resolve(import.meta.dirname, '../../papercusp-docs/dist');

describe('built public manual contract', () => {
  it('builds searchable HTML with the public canonical origin', async () => {
    const index = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(index).toContain('https://app.papercusp.com/docs');
    expect(index).not.toContain('href="/docs/docs.html"');
    expect(existsSync(resolve(root, 'pagefind/pagefind.js'))).toBe(true);
    expect(existsSync(resolve(root, 'sitemap-index.xml'))).toBe(true);
    const page = await servePublicDocs(new Request('https://app.papercusp.com/docs'), root);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('public user manual');
  });
  it('built page links and local assets resolve through the actual public reader', async () => {
    const targets = new Set<string>();
    for (const file of readdirSync(root).filter((name) => name.endsWith('.html') && name !== '404.html')) {
      const text = readFileSync(resolve(root, file), 'utf8');
      for (const match of text.matchAll(/(?:href|src)="(\/docs[^"#?]*)/g)) targets.add(match[1]);
    }
    expect(targets.size).toBeGreaterThan(10);
    for (const target of targets) {
      const response = await servePublicDocs(new Request(`https://app.papercusp.com${target}`), root);
      expect(response.status, target).toBe(200);
    }
  });
});
