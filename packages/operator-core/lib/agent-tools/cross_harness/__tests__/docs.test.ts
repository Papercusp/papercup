/**
 * cross_harness:docs_* tool wrapper tests.
 *
 * Covers the operator-side glue: harness-registry lookup, error
 * envelope when the slug is unknown, workspaceId passthrough, and
 * metadata emission. Engine logic (outline/get/search shape) is
 * covered by @papercusp/docs-engine's own tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    metadata: vi.fn(),
    workspaceId: 'default',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

type TextToolResult = { content: Array<{ text: string }>; isError?: boolean };
const textResult = (result: unknown) => result as TextToolResult;
function parsePayload(result: unknown): Record<string, unknown> {
  return JSON.parse(textResult(result).content[0].text);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-harness-docs-test-'));
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'SPEC.md'), '# Spec\n\nProject spec.\n', 'utf-8');
  await fs.writeFile(path.join(tmpDir, 'docs', 'architecture.md'), '# Architecture\n\nLayout details.\n', 'utf-8');
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('../../../harness-registry');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('cross_harness:docs_outline', () => {
  it('returns harness_not_registered when slug is unknown', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const tool = (await import('../docs_outline')).default;
    const result = await tool.handler({ harnessSlug: 'missing' }, MAKE_CTX());
    expect(textResult(result).isError).toBe(true);
    expect(parsePayload(result)).toEqual({ error: 'harness_not_registered', slug: 'missing' });
  });

  it('returns outline when slug is registered', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    const tool = (await import('../docs_outline')).default;
    const result = await tool.handler({ harnessSlug: 'target' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('target');
    expect(payload.cached).toBe(false);
    expect((payload.sections as unknown[]).length).toBeGreaterThan(0);
  });

  it('forwards workspaceId to loadHarnessRegistry', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    const tool = (await import('../docs_outline')).default;
    await tool.handler({ harnessSlug: 'target', workspaceId: 'other-ws' }, MAKE_CTX());
    expect(reg).toHaveBeenCalledWith('other-ws');
  });

  it('uses active workspace when workspaceId is unset', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    const tool = (await import('../docs_outline')).default;
    await tool.handler({ harnessSlug: 'target' }, MAKE_CTX());
    expect(reg).toHaveBeenCalledWith(undefined);
  });

  it('emits surface + harness_slug in ctx.metadata', async () => {
    const metadata = vi.fn();
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] })),
    }));
    const tool = (await import('../docs_outline')).default;
    await tool.handler({ harnessSlug: 'target' }, MAKE_CTX({ metadata }));
    const call = metadata.mock.calls.find((c) => (c[0] as { surface?: string }).surface === 'cross_harness');
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({ surface: 'cross_harness', harness_slug: 'target' });
  });
});

describe('cross_harness:docs_get', () => {
  it('returns harness_not_registered when slug is unknown', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const tool = (await import('../docs_get')).default;
    const result = await tool.handler({ harnessSlug: 'missing', slugs: ['x'] }, MAKE_CTX());
    expect(textResult(result).isError).toBe(true);
    expect(parsePayload(result)).toEqual({ error: 'harness_not_registered', slug: 'missing' });
  });

  it('returns content for a known slug + path', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] })),
    }));
    const tool = (await import('../docs_get')).default;
    const result = await tool.handler(
      { harnessSlug: 'target', slugs: ['harness-state/SPEC'] },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('target');
    const r0 = (payload.results as Array<{ found: boolean }>)[0];
    expect(r0.found).toBe(true);
  });

  it('forwards workspaceId to loadHarnessRegistry', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    const tool = (await import('../docs_get')).default;
    await tool.handler(
      { harnessSlug: 'target', workspaceId: 'other-ws', slugs: ['harness-state/SPEC'] },
      MAKE_CTX(),
    );
    expect(reg).toHaveBeenCalledWith('other-ws');
  });
});

describe('cross_harness:docs_search', () => {
  it('returns harness_not_registered when slug is unknown', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const tool = (await import('../docs_search')).default;
    const result = await tool.handler(
      { harnessSlug: 'missing', query: 'spec', limit: 8 },
      MAKE_CTX(),
    );
    expect(textResult(result).isError).toBe(true);
  });

  it('returns ranked hits for known slug', async () => {
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] })),
    }));
    const tool = (await import('../docs_search')).default;
    const result = await tool.handler(
      { harnessSlug: 'target', query: 'spec', limit: 8 },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('target');
    expect((payload.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it('forwards workspaceId to loadHarnessRegistry', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'target', path: tmpDir }] }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: reg }));
    const tool = (await import('../docs_search')).default;
    await tool.handler(
      { harnessSlug: 'target', workspaceId: 'other-ws', query: 'spec', limit: 8 },
      MAKE_CTX(),
    );
    expect(reg).toHaveBeenCalledWith('other-ws');
  });
});
