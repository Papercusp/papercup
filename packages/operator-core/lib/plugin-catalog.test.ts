/**
 * Unit tests for the catalog-side plugin lister.
 *
 * Specifically covers the `@scope/` recursion that was added 2026-04-30
 * after a real bug: `papercusp install <scoped-name>` extracts to
 * `~/.papercusp/global-plugins/<scope>/<name>/`, but the original
 * `listPluginsIn` did a single-level directory walk and missed scoped
 * plugins. The marketplace UI's "installed" detection is backed by this
 * function, so plugins were silently invisible after install.
 *
 * Relocated from `app/api/_hono/plugins.test.ts` (endpoint-hono
 * -elimination-2026-05-21 A3) alongside `listPluginsIn`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPluginsIn } from './plugin-catalog';

let ROOT: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'papercusp-list-'));
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makePlugin(parent: string, name: string, manifestName?: string): void {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'papercusp.json'),
    JSON.stringify({ name: manifestName ?? name, version: '0.1.0' }),
    'utf8',
  );
}

describe('listPluginsIn', () => {
  it('returns empty when the parent dir does not exist', async () => {
    const result = await listPluginsIn(join(ROOT, 'nonexistent'), 'global');
    expect(result).toEqual([]);
  });

  it('finds plugins at the top level', async () => {
    makePlugin(ROOT, 'foo');
    makePlugin(ROOT, 'bar');
    const result = await listPluginsIn(ROOT, 'global');
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['bar', 'foo']);
  });

  it('skips dirs without a papercusp.json', async () => {
    mkdirSync(join(ROOT, 'not-a-plugin'), { recursive: true });
    makePlugin(ROOT, 'real-plugin');
    const result = await listPluginsIn(ROOT, 'global');
    expect(result.map((p) => p.name)).toEqual(['real-plugin']);
  });

  it('skips dotfiles (e.g., .DS_Store, .git)', async () => {
    mkdirSync(join(ROOT, '.git'), { recursive: true });
    writeFileSync(join(ROOT, '.git', 'papercusp.json'), JSON.stringify({ name: '.git', version: '0.1.0' }));
    makePlugin(ROOT, 'real');
    const result = await listPluginsIn(ROOT, 'global');
    expect(result.map((p) => p.name)).toEqual(['real']);
  });

  it('recurses into @scope/ subdirs (the regression fix)', async () => {
    // `@papercupai` itself has no manifest — it's a scope dir.
    mkdirSync(join(ROOT, '@papercupai'), { recursive: true });
    makePlugin(join(ROOT, '@papercupai'), 'notion-export', '@papercupai/notion-export');
    makePlugin(join(ROOT, '@papercupai'), 'cloudflare-pages', '@papercupai/cloudflare-pages');
    const result = await listPluginsIn(ROOT, 'global');
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['@papercupai/cloudflare-pages', '@papercupai/notion-export']);
  });

  it('does NOT recurse into non-scope dirs (only `@`-prefixed)', async () => {
    // A regular subdir with a child that has a manifest must NOT surface
    // — only `@scope/` dirs trigger the one-level recursion.
    mkdirSync(join(ROOT, 'random-subdir'), { recursive: true });
    makePlugin(join(ROOT, 'random-subdir'), 'nested-plugin');
    const result = await listPluginsIn(ROOT, 'global');
    expect(result).toEqual([]);
  });

  it('mixes top-level and scoped plugins, deduping by manifest name', async () => {
    // Top-level symlink `cloudflare-pages` → @papercupai/cloudflare-pages
    // would resolve to the same manifest name. Dedup keeps only one.
    makePlugin(ROOT, 'cap-violator2');
    mkdirSync(join(ROOT, '@papercupai'), { recursive: true });
    makePlugin(join(ROOT, '@papercupai'), 'cloudflare-pages', '@papercupai/cloudflare-pages');
    // Top-level symlink to the scoped dir — same manifest.name.
    symlinkSync(
      join(ROOT, '@papercupai/cloudflare-pages'),
      join(ROOT, 'cloudflare-pages'),
    );
    const result = await listPluginsIn(ROOT, 'global');
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['@papercupai/cloudflare-pages', 'cap-violator2']);
  });

  it('accepts symlinks-to-dirs at the top level', async () => {
    const externalDir = join(ROOT, '_external');
    makePlugin(externalDir, 'real-plugin');
    symlinkSync(join(externalDir, 'real-plugin'), join(ROOT, 'symlinked'));
    const result = await listPluginsIn(ROOT, 'global');
    expect(result.map((p) => p.name)).toContain('real-plugin');
  });

  it('skips manifest entries missing required fields', async () => {
    const dir = join(ROOT, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'papercusp.json'), JSON.stringify({ name: 'broken' }), 'utf8'); // no version
    makePlugin(ROOT, 'good');
    const result = await listPluginsIn(ROOT, 'global');
    expect(result.map((p) => p.name)).toEqual(['good']);
  });

  it('annotates each result with source + absolute path', async () => {
    makePlugin(ROOT, 'tagged');
    const result = await listPluginsIn(ROOT, 'harness');
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('harness');
    expect(result[0].path).toBe(join(ROOT, 'tagged'));
  });
});
