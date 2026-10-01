import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../papercusp-docs');
const content = resolve(root, 'src/content/docs');
const pages = ['index', 'using-the-app', 'workspaces-and-agents', 'harness-templates',
  'harness-snapshots', 'plugins', 'remote-access', 'troubleshooting'];

describe('public user manual source readiness', () => {
  it.each(pages)('publishes a substantive maintained guide: %s', (slug) => {
    const text = readFileSync(resolve(content, `${slug}.mdx`), 'utf8');
    expect(text).toMatch(/^---\ntitle: /);
    expect(text).toMatch(/description: /);
    expect(text).toContain('## ');
    expect(text.length).toBeGreaterThan(800);
    expect(text).not.toMatch(/localhost:3055|papercup\.ai|papercuspai\.com|\*\(Screenshot:|papercusp publish|brew install papercupai/);
    expect(text).not.toMatch(/github\.com\/Papercusp\/papercup(?:[)\s/]|$)/);
  });
  it('uses the public portal canonical origin and real sidebar home slug', () => {
    const config = readFileSync(resolve(root, 'astro.config.mjs'), 'utf8');
    expect(config).toContain("site: 'https://app.papercusp.com'");
    expect(config).toContain("base: '/docs'");
    expect(config).toContain("{ label: 'Welcome', slug: '' }");
    expect(config).toContain('https://github.com/Papercusp/papercusp-app');
  });
  it('source article links name existing public guides, not private documentation', () => {
    for (const file of readdirSync(content).filter((name) => name.endsWith('.mdx'))) {
      const text = readFileSync(resolve(content, file), 'utf8');
      expect(text).not.toMatch(/\]\(\/internal\/docs/);
      for (const match of text.matchAll(/\]\(\/docs\/([^)#?]*)/g)) {
        const slug = match[1].replace(/\/$/, '') || 'index';
        expect(existsSync(resolve(content, `${slug}.mdx`)), `${file}: ${match[0]}`).toBe(true);
      }
    }
  });
});
