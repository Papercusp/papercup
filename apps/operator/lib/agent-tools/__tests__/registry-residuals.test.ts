/**
 * Registry-residual tools — actions:recent, notifications:recent,
 * harness:escalation, harness:pending_reviews, harness:health,
 * harness:list_features.
 *
 * All thin fetch wrappers around operator-local HTTP routes; tests
 * mock global fetch and assert call shape + payload projection.
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

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof global.fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

describe('actions:recent', () => {
  it('returns count + actions slice', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ actions: [{ id: 'a1' }, { id: 'a2' }] }),
    );
    const { default: tool } = await import('@/lib/agent-tools/operator/actions_recent');
    const result = await tool.handler({ slug: 'sheets', limit: 5 }, MAKE_CTX());
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/user-actions/sheets');
    expect(url).toContain('limit=5');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ count: 2, actions: [{ id: 'a1' }, { id: 'a2' }] });
  });

  it('returns empty list on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}, 404));
    const { default: tool } = await import('@/lib/agent-tools/operator/actions_recent');
    const result = await tool.handler({ slug: 'unknown' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ count: 0, actions: [] });
  });

  it('throws on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}, 500));
    const { default: tool } = await import('@/lib/agent-tools/operator/actions_recent');
    await expect(tool.handler({ slug: 'sheets' }, MAKE_CTX())).rejects.toThrow(/HTTP 500/);
  });
});

describe('notifications:recent', () => {
  it('returns toasts unfiltered when level=all (default)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        toasts: [
          { level: 'error', message: 'oops' },
          { level: 'info', message: 'hi' },
        ],
      }),
    );
    const { default: tool } = await import('@/lib/agent-tools/operator/notifications_recent');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.count).toBe(2);
  });

  it('filters by level', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        toasts: [
          { level: 'error', message: 'e1' },
          { level: 'info', message: 'i1' },
          { level: 'error', message: 'e2' },
        ],
      }),
    );
    const { default: tool } = await import('@/lib/agent-tools/operator/notifications_recent');
    const result = await tool.handler({ level: 'error' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.count).toBe(2);
    expect((payload.notifications as Array<{ level: string }>).every((t) => t.level === 'error'))
      .toBe(true);
  });
});

describe('harness:escalation', () => {
  it('hasEscalation:true when escalation text present', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        escalation: 'something is broken',
        supervisorNotes: 'investigate X',
        mtimeMs: 1234,
      }),
    );
    const { default: tool } = await import('@/lib/agent-tools/harness/escalation');
    const result = await tool.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.hasEscalation).toBe(true);
    expect(payload.escalation).toBe('something is broken');
  });

  it('hasEscalation:false when escalation field is empty', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ escalation: '   ', supervisorNotes: null }));
    const { default: tool } = await import('@/lib/agent-tools/harness/escalation');
    const result = await tool.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.hasEscalation).toBe(false);
  });

  it('returns null shape on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}, 404));
    const { default: tool } = await import('@/lib/agent-tools/harness/escalation');
    const result = await tool.handler({ slug: 'unknown' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      hasEscalation: false,
      escalation: null,
      supervisorNotes: null,
      mtimeMs: null,
    });
  });
});

describe('harness:pending_reviews', () => {
  it('returns count + reviews slice', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ reviews: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }),
    );
    const { default: tool } = await import('@/lib/agent-tools/harness/pending_reviews');
    const result = await tool.handler({ slug: 'sheets', limit: 2 }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.count).toBe(2);
  });
});

describe('harness:health', () => {
  it('returns whatever the route emits', async () => {
    const health = {
      slug: 'sheets',
      alive: true,
      escalated: false,
      feature_counts: { passed: 5, failing: 0, in_progress: 1, blocked: 0 },
      lastRunMs: 1234,
    };
    fetchMock.mockResolvedValueOnce(mockResponse(health));
    const { default: tool } = await import('@/lib/agent-tools/harness/health');
    const result = await tool.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(health);
  });
});

describe('harness:list_features', () => {
  it('projects to id/title/status/claims/attempts only', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        features: [
          { id: 'f1', title: 'A', status: 'passed', claims: [], attempts: 1, extra: 'drop me' },
          { id: 'f2', title: 'B', status: 'failing', claims: ['x'], attempts: 3, extra: 'drop' },
        ],
      }),
    );
    const { default: tool } = await import('@/lib/agent-tools/harness/list_features');
    const result = await tool.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    const features = payload.features as Array<Record<string, unknown>>;
    expect(features).toHaveLength(2);
    expect(features[0]).toEqual({
      id: 'f1', title: 'A', status: 'passed', claims: [], attempts: 1,
    });
    expect(features[0].extra).toBeUndefined();
  });

  it('filters by status', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        features: [
          { id: 'f1', status: 'passed' },
          { id: 'f2', status: 'failing' },
        ],
      }),
    );
    const { default: tool } = await import('@/lib/agent-tools/harness/list_features');
    const result = await tool.handler({ slug: 'sheets', status: 'failing' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.count).toBe(1);
    expect((payload.features as Array<{ id: string }>)[0].id).toBe('f2');
  });

  it('passes phase=testing query when arg given', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ features: [] }));
    const { default: tool } = await import('@/lib/agent-tools/harness/list_features');
    await tool.handler({ slug: 'sheets', phase: 'testing' }, MAKE_CTX());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('phase=testing');
  });
});
