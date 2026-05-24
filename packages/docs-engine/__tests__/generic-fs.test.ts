import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { genericFsAdapter } from '../src/adapters/generic-fs';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-fs-test-'));
  await fs.mkdir(path.join(tmpDir, 'guides'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'reference'), { recursive: true });

  await fs.writeFile(
    path.join(tmpDir, 'index.md'),
    '# My Project\n\nWelcome.\n\n## Getting started\n\nRun `npm install`.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'guides', 'auth.md'),
    '# Auth guide\n\nHow auth works.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'reference', 'api.mdx'),
    '# API reference\n\nEndpoints listed below.\n',
    'utf-8',
  );
  // Should be ignored — dotfile dir
  await fs.mkdir(path.join(tmpDir, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.hidden', 'secret.md'), '# Secret\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('genericFsAdapter', () => {
  it('walks <root>/ directly (not <root>/docs/)', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toEqual(['guides/auth', 'index', 'reference/api']);
  });

  it('skips dotfile directories', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    expect(pages.map((p) => p.slug)).not.toContain('.hidden/secret');
  });

  it('handles both .md and .mdx', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain('guides/auth'); // .md
    expect(slugs).toContain('reference/api'); // .mdx
  });

  it('extracts title from first h1', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.title).toBe('My Project');
  });

  it('extracts TOC from headings', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.toc.map((h) => h.text)).toEqual(['My Project', 'Getting started']);
  });

  it('serves raw markdown for .md', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const page = await adapter.getPage('guides/auth');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('How auth works.');
  });

  it('renders .mdx to markdown', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const page = await adapter.getPage('reference/api');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('Endpoints listed below.');
  });

  it('default name is `generic-fs:<basename>`', () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(adapter.name).toBe(`generic-fs:${path.basename(tmpDir)}`);
  });

  it('honors opts.name', () => {
    const adapter = genericFsAdapter(tmpDir, { name: 'project' });
    expect(adapter.name).toBe('project');
  });

  it('url is empty string when no baseUrl given', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.url).toBe('');
  });

  it('url is `<baseUrl>/<slug>` when baseUrl given', async () => {
    const adapter = genericFsAdapter(tmpDir, { baseUrl: '/project-docs' });
    const index = await adapter.getPage('index');
    expect(index?.url).toBe('/project-docs/index');
  });

  it('returns null for unknown slug', async () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(await adapter.getPage('does/not/exist')).toBeNull();
  });

  it('getSectionMeta returns empty (generic-fs has no section concept)', async () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(await adapter.getSectionMeta?.('guides')).toEqual({});
  });
});
