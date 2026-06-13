/**
 * harness:* tools — phase_path, markdown_index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../harness-phases');
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../harness-markdown-index');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('harness:phase_path', () => {
  it('resolves (slug, phase) → path via phasePath', async () => {
    const phasePath = vi.fn(() => '/tmp/sheets--testing');
    vi.doMock('../../../harness-phases', () => ({ phasePath }));
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/sheets' }],
      })),
    }));
    const { default: tool } = await import('../phase_path');
    const result = await tool.handler(
      { harnessSlug: 'sheets', phase: 'testing' },
      MAKE_CTX(),
    );
    expect(phasePath).toHaveBeenCalledWith(
      { slug: 'sheets', path: '/tmp/sheets' },
      'testing',
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      slug: 'sheets',
      phase: 'testing',
      found: true,
      path: '/tmp/sheets--testing',
    });
  });

  it('returns found:false when slug not in registry', async () => {
    vi.doMock('../../../harness-phases', () => ({ phasePath: vi.fn() }));
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('../phase_path');
    const result = await tool.handler(
      { harnessSlug: 'unknown', phase: 'staging' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      slug: 'unknown',
      phase: 'staging',
      found: false,
      path: null,
    });
  });

  it('falls back to ctx.harnessSlug when arg omitted', async () => {
    const phasePath = vi.fn(() => '/p');
    vi.doMock('../../../harness-phases', () => ({ phasePath }));
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'fallback', path: '/p' }],
      })),
    }));
    const { default: tool } = await import('../phase_path');
    await tool.handler({ phase: 'staging' }, MAKE_CTX({ harnessSlug: 'fallback' }));
    expect(phasePath).toHaveBeenCalled();
  });
});

describe('harness:markdown_index', () => {
  it('returns loadHarnessMarkdownIndex output', async () => {
    const index = [
      {
        slug: 'sheets',
        files: [{ filename: 'SPEC.md', headings: [{ level: 1, text: 'X', anchor: 'X' }] }],
      },
    ];
    vi.doMock('../../../harness-markdown-index', () => ({
      loadHarnessMarkdownIndex: vi.fn(async () => index),
    }));
    const { default: tool } = await import('../markdown_index');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ index });
  });
});
