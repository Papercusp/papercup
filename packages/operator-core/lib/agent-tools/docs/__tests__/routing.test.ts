/**
 * Operator-side routing tests for context-aware docs:* tools.
 *
 * The engine package tests cover buildOutline/getDocs/searchDocs
 * against a mock DocSource. These tests cover the operator-side
 * branching: which adapter does each tool pick given ctx.harnessSlug,
 * ctx.isSuperuser, and PAPERCUSP_PROJECT_DOCS_ROOT?
 *
 * Resolution order (no-harness branch):
 *   1. PAPERCUSP_PROJECT_DOCS_ROOT set → project (D-001 / P-004)
 *   2. else isSuperuser → engineering (D-005 / P-016)
 *   3. else → error('no_docs_source')
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function mockHarnessRegistry(factory: () => Record<string, unknown>) {
  vi.doMock('../../../harness-registry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ...factory(),
  }));
}

const ORIGINAL_ENV = process.env.PAPERCUSP_PROJECT_DOCS_ROOT;

beforeEach(() => {
  vi.resetModules();
  delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
});

afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
  else process.env.PAPERCUSP_PROJECT_DOCS_ROOT = ORIGINAL_ENV;
});

// resolveAdapter's harness branch resolves the content path through this
// (hive → member repo, else the harness's own path). It is pure over the
// registry, so mirror it for the simple {slug,path} fixtures used here.
const resolveHarnessContentPath = (
  reg: { projects: Array<{ slug: string; path?: string }> },
  slug: string,
) => reg.projects.find((p) => p.slug === slug)?.path;

function mockEmptyRegistry() {
  mockHarnessRegistry(() => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    resolveHarnessContentPath,
  }));
}

function mockRegistryWith(slug: string, path: string) {
  mockHarnessRegistry(() => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug, path }] })),
    resolveHarnessContentPath,
  }));
}

describe('docs:outline resolveAdapter', () => {
  it('SU caller with no harness + no env var → engineering surface', async () => {
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter(undefined, { isSuperuser: true });
    expect(result.surface).toBe('engineering');
    expect(result.scope).toBe('_engineering');
    expect(result.error).toBeUndefined();
  });

  it("SU wildcard slug '*' → engineering surface, not harness_not_registered", async () => {
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter('*', { isSuperuser: true });
    expect(result.surface).toBe('engineering');
    expect(result.scope).toBe('_engineering');
    expect(result.error).toBeUndefined();
  });

  it('env var set → project surface (wins over isSuperuser)', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/my-project-docs';
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter(undefined, { isSuperuser: true });
    expect(result.surface).toBe('project');
    expect(result.scope).toBe('_project');
    expect(result.error).toBeUndefined();
  });

  it('non-SU caller with no harness + no env var → no_docs_source error (D-005)', async () => {
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter(undefined);
    expect(result.error?.code).toBe('no_docs_source');
    expect(result.error?.detail).toContain('PAPERCUSP_PROJECT_DOCS_ROOT');
  });

  it('non-SU caller with env var → project surface (still works without SU)', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/my-project-docs';
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('project');
    expect(result.error).toBeUndefined();
  });

  it('resolves to harness adapter when slug is registered', async () => {
    mockRegistryWith('sheets', '/tmp/harness-fixture');
    const mod = await import('../outline');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
    expect(result.scope).toBe('sheets');
    expect(result.error).toBeUndefined();
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    mockEmptyRegistry();
    const mod = await import('../outline');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
    expect(result.surface).toBe('engineering');
  });
});

describe('docs:get resolveAdapter', () => {
  it('SU caller with no harness + no env var → engineering surface', async () => {
    mockEmptyRegistry();
    const mod = await import('../get');
    const result = await mod.resolveAdapter(undefined, { isSuperuser: true });
    expect(result.surface).toBe('engineering');
    expect(result.error).toBeUndefined();
  });

  it("SU wildcard slug '*' → engineering surface, not harness_not_registered", async () => {
    mockEmptyRegistry();
    const mod = await import('../get');
    const result = await mod.resolveAdapter('*', { isSuperuser: true });
    expect(result.surface).toBe('engineering');
    expect(result.error).toBeUndefined();
  });

  it('env var set → project surface', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/my-project-docs';
    mockEmptyRegistry();
    const mod = await import('../get');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('project');
    expect(result.error).toBeUndefined();
  });

  it('non-SU caller with no harness + no env var → no_docs_source error', async () => {
    mockEmptyRegistry();
    const mod = await import('../get');
    const result = await mod.resolveAdapter(undefined);
    expect(result.error?.code).toBe('no_docs_source');
  });

  it('resolves to harness adapter when slug is registered', async () => {
    mockRegistryWith('sheets', '/tmp/harness-fixture');
    const mod = await import('../get');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
  });

  it('uses a declared docs root while preserving harness-state reads', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-get-routing-'));
    const docsRoot = path.join(projectRoot, 'apps', 'operator-docs', 'src', 'content', 'docs');
    try {
      await fs.mkdir(path.join(projectRoot, '.papercusp'), { recursive: true });
      await fs.mkdir(path.join(docsRoot, 'agent-insights'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, '.papercusp', 'docs.json'),
        JSON.stringify({ root: 'apps/operator-docs/src/content/docs' }),
        'utf-8',
      );
      await fs.writeFile(path.join(projectRoot, 'SPEC.md'), '# Spec\n\nState remains available.\n', 'utf-8');
      await fs.writeFile(
        path.join(docsRoot, 'agent-insights', 'declared-root.mdx'),
        '---\ntitle: Declared root\n---\n# Declared root\n\nThe canonical docs root.\n',
        'utf-8',
      );

      mockRegistryWith('sheets', projectRoot);
      const mod = await import('../get');
      const result = await mod.resolveAdapter('sheets');

      expect(result.surface).toBe('harness');
      expect(await result.adapter.getPage('agent-insights/declared-root')).not.toBeNull();
      expect(await result.adapter.getPage('harness-state/SPEC')).not.toBeNull();
      expect(await result.adapter.getPage('docs/declared-root')).toBeNull();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    mockEmptyRegistry();
    const mod = await import('../get');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
  });
});

describe('docs:search resolveAdapter', () => {
  it('SU caller with no harness + no env var → engineering surface', async () => {
    mockEmptyRegistry();
    const mod = await import('../search');
    const result = await mod.resolveAdapter(undefined, { isSuperuser: true });
    expect(result.surface).toBe('engineering');
  });

  it("SU wildcard slug '*' → engineering surface, not harness_not_registered", async () => {
    mockEmptyRegistry();
    const mod = await import('../search');
    const result = await mod.resolveAdapter('*', { isSuperuser: true });
    expect(result.surface).toBe('engineering');
    expect(result.error).toBeUndefined();
  });

  it('env var set → project surface', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/my-project-docs';
    mockEmptyRegistry();
    const mod = await import('../search');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('project');
  });

  it('non-SU caller with no harness + no env var → no_docs_source error', async () => {
    mockEmptyRegistry();
    const mod = await import('../search');
    const result = await mod.resolveAdapter(undefined);
    expect(result.error?.code).toBe('no_docs_source');
  });

  it('resolves to harness adapter when slug is registered', async () => {
    mockRegistryWith('sheets', '/tmp/harness-fixture');
    const mod = await import('../search');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    mockEmptyRegistry();
    const mod = await import('../search');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
  });
});
