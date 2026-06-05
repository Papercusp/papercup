/**
 * operator:* misc tools — decisions, notes, dedup_check, preview_prompt.
 * (parse_suggestions was removed with the scanner card stream — D-005.)
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
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('../../../workspace-registry');
  vi.doUnmock('../../../operator-notes');
  vi.doUnmock('../../../operator-fuzzy-dedup');
  vi.doUnmock('../../../operator-preferences');
  vi.doUnmock('../../../operator-prompt');
  vi.doUnmock('drizzle-orm/postgres-js');
  vi.doUnmock('drizzle-orm');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:decisions', () => {
  // Tool was rewritten to use drizzle's typed query builder (phase 3).
  // Mock the drizzle builder chain + use importOriginal for @papercusp/db-org
  // so other internals (schemaOf etc.) keep working when drizzle reaches
  // into the module during select/from.
  async function setupMocks(rowsToReturn: unknown[]) {
    let capturedLimit: number | null = null;
    const builder = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation((n: number) => {
        capturedLimit = n;
        return Promise.resolve(rowsToReturn);
      }),
    };
    vi.doMock('drizzle-orm/postgres-js', () => ({
      drizzle: vi.fn(() => builder),
    }));
    vi.doMock('drizzle-orm', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, desc: vi.fn((c) => c) };
    });
    vi.doMock('@papercusp/db-org', async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        withWorkspace: vi.fn(async (_w: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      };
    });
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    return { getCapturedLimit: () => capturedLimit };
  }

  it('reads operator_decisions view via withWorkspace', async () => {
    const rows = [{ id: '1', ts: 1234, actor: 'u', action: 'a', target: 't', details: {} }];
    await setupMocks(rows);
    const { default: tool } = await import('../decisions');
    const result = await tool.handler({ limit: 5 }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ decisions: rows });
  });

  it('defaults limit to 50', async () => {
    const ctl = await setupMocks([]);
    const { default: tool } = await import('../decisions');
    await tool.handler({}, MAKE_CTX());
    expect(ctl.getCapturedLimit()).toBe(50);
  });
});

describe('operator:notes', () => {
  it('read returns lib output', async () => {
    const result = { raw: '## title\n\nbody', blocks: [{ author: 'u', ts: 1, body: 'body' }] };
    vi.doMock('../../../operator-notes', () => ({
      readOperatorNotes: vi.fn(async () => result),
      appendOperatorNote: vi.fn(),
    }));
    const { default: tool } = await import('../notes');
    const r = await tool.handler({ op: 'read', featureId: 'F-1' }, MAKE_CTX());
    const payload = parsePayload(r as never);
    expect(payload).toEqual(result);
  });

  it('append throws when lib returns error', async () => {
    vi.doMock('../../../operator-notes', () => ({
      readOperatorNotes: vi.fn(),
      appendOperatorNote: vi.fn(async () => ({ error: 'no such harness' })),
    }));
    const { default: tool } = await import('../notes');
    await expect(
      tool.handler(
        { op: 'append', featureId: 'F-1', content: 'note' },
        MAKE_CTX(),
      ),
    ).rejects.toThrow(/no such harness/i);
  });

  it('append happy path returns ok', async () => {
    vi.doMock('../../../operator-notes', () => ({
      readOperatorNotes: vi.fn(),
      appendOperatorNote: vi.fn(async () => ({ bytesWritten: 42 })),
    }));
    const { default: tool } = await import('../notes');
    const r = await tool.handler(
      { op: 'append', featureId: 'F-1', content: 'note', author: 'me' },
      MAKE_CTX(),
    );
    const payload = parsePayload(r as never);
    expect(payload.ok).toBe(true);
    expect(payload.bytesWritten).toBe(42);
  });

  it('falls back to ctx.harnessSlug when slug arg omitted', async () => {
    const appendOperatorNote = vi.fn(async () => ({ bytesWritten: 1 }));
    vi.doMock('../../../operator-notes', () => ({
      readOperatorNotes: vi.fn(),
      appendOperatorNote,
    }));
    const { default: tool } = await import('../notes');
    await tool.handler(
      { op: 'append', featureId: 'F-1', content: 'x' },
      MAKE_CTX({ harnessSlug: 'fallback-slug' }),
    );
    expect(appendOperatorNote).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'fallback-slug' }),
    );
  });
});

describe('operator:dedup_check', () => {
  it('returns lib output verbatim with threshold', async () => {
    vi.doMock('../../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate: vi.fn(() => ({ matchedId: 'a1', similarity: 0.9 })),
      FUZZY_THRESHOLD: 0.82,
    }));
    const { default: tool } = await import('../dedup_check');
    const result = await tool.handler(
      {
        candidate: 'X',
        existing: [{ id: 'a1', title: 'Y' }],
      },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      match: { matchedId: 'a1', similarity: 0.9 },
      threshold: 0.82,
    });
  });

  it('returns match:null when no fuzzy hit', async () => {
    vi.doMock('../../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate: vi.fn(() => null),
      FUZZY_THRESHOLD: 0.82,
    }));
    const { default: tool } = await import('../dedup_check');
    const result = await tool.handler(
      { candidate: 'X', existing: [] },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.match).toBeNull();
  });
});

describe('operator:preview_prompt', () => {
  it('builds with default placeholder userId', async () => {
    const buildOperatorPrompt = vi.fn(async () => ({
      promptText: 'fixture',
      isFirstRun: false,
    }));
    vi.doMock('../../../operator-prompt', () => ({ buildOperatorPrompt }));
    const { default: tool } = await import('../preview_prompt');
    const result = await tool.handler({ request: 'do it' }, MAKE_CTX());
    expect(buildOperatorPrompt).toHaveBeenCalledWith({
      request: 'do it',
      userId: 'debug-preview',
      showFirstRun: undefined,
    });
    const payload = parsePayload(result as never);
    expect(payload.promptText).toBe('fixture');
  });

  it('passes through showFirstRun + userId overrides', async () => {
    const buildOperatorPrompt = vi.fn(async () => ({ promptText: '', isFirstRun: true }));
    vi.doMock('../../../operator-prompt', () => ({ buildOperatorPrompt }));
    const { default: tool } = await import('../preview_prompt');
    await tool.handler(
      { request: 'r', userId: 'u', showFirstRun: true },
      MAKE_CTX(),
    );
    expect(buildOperatorPrompt).toHaveBeenCalledWith({
      request: 'r',
      userId: 'u',
      showFirstRun: true,
    });
  });
});
