/**
 * operator:* scan-family tools — stats, scans_list, last_scan,
 * scanner_reset, scanner_bootstrap.
 *
 * Tests the handler directly with mocked lib helpers. The dispatcher
 * (role gates, quotas, telemetry) is exhaustively covered in the
 * @papercusp/agent-mcp package's own tests; this file only validates
 * each handler's behavior + per-tool metadata.
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
  vi.doUnmock('../../../operator-stats');
  vi.doUnmock('../../../operator-scans');
  vi.doUnmock('../../../operator-last-scan');
  vi.doUnmock('../../../operator-card-reconstruction');
  vi.doUnmock('../../../operator-scanner-session');
  vi.doUnmock('../../../operator-scanner-bootstrap');
  vi.doUnmock('../../../workspace-registry');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:stats', () => {
  it('returns readOperatorStats output verbatim', async () => {
    const stats = {
      windowDays: 7,
      cardsTotal: 12,
      dispatched: 8,
      dismissed: 4,
      consumed: 6,
    };
    vi.doMock('../../../operator-stats', () => ({
      readOperatorStats: vi.fn(async () => stats),
    }));
    const { default: tool } = await import('../stats');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(stats);
  });

  it('exposes any-role allowlist', async () => {
    vi.doMock('../../../operator-stats', () => ({
      readOperatorStats: vi.fn(async () => ({})),
    }));
    const { default: tool } = await import('../stats');
    expect(tool.requirePrincipal).toBe(false);
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('architect');
    expect(tool.agentRoles).toContain('reviewer');
  });
});

describe('operator:scans_list', () => {
  it('returns single scan when id is given', async () => {
    const scan = { id: 42, summary: 'fixture' };
    const getOperatorScan = vi.fn(async () => scan);
    vi.doMock('../../../operator-scans', () => ({
      getOperatorScan,
      listOperatorScans: vi.fn(),
      searchOperatorScans: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('../scans_list');
    const result = await tool.handler({ id: 42 }, MAKE_CTX());
    expect(getOperatorScan).toHaveBeenCalledWith({ workspaceId: 'default', id: 42 });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ scan });
  });

  it('routes to searchOperatorScans when query is given', async () => {
    const searchOperatorScans = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
    vi.doMock('../../../operator-scans', () => ({
      getOperatorScan: vi.fn(),
      listOperatorScans: vi.fn(),
      searchOperatorScans,
    }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('../scans_list');
    await tool.handler({ query: 'sheets' }, MAKE_CTX());
    expect(searchOperatorScans).toHaveBeenCalledWith({
      workspaceId: 'default',
      query: 'sheets',
      limit: 10,
    });
  });

  it('routes to listOperatorScans by default', async () => {
    const listOperatorScans = vi.fn(async () => []);
    vi.doMock('../../../operator-scans', () => ({
      getOperatorScan: vi.fn(),
      listOperatorScans,
      searchOperatorScans: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('../scans_list');
    await tool.handler({ limit: 5 }, MAKE_CTX());
    expect(listOperatorScans).toHaveBeenCalledWith({ workspaceId: 'default', limit: 5 });
  });

  it('returns empty list gracefully when the scans table doesn\'t exist', async () => {
    vi.doMock('../../../operator-scans', () => ({
      getOperatorScan: vi.fn(),
      listOperatorScans: vi.fn(async () => {
        throw new Error('relation "harness_shared.operator_scans" does not exist');
      }),
      searchOperatorScans: vi.fn(),
    }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('../scans_list');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ scans: [] });
  });
});

describe('operator:last_scan', () => {
  it('returns last-scan-only snapshot when reconstructCards is empty', async () => {
    const last = {
      cards: [{ id: 'a' }],
      scanCompletedAt: '2026-05-10T00:00:00Z',
    };
    vi.doMock('../../../operator-last-scan', () => ({
      readLastScan: vi.fn(async () => last),
    }));
    vi.doMock('../../../operator-card-reconstruction', () => ({
      reconstructCards: vi.fn(async () => []),
    }));
    const { default: tool } = await import('../last_scan');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect((payload.snapshot as Record<string, unknown>).cards).toEqual(last.cards);
  });

  it('merges reconstructed lifecycle metadata into cards', async () => {
    vi.doMock('../../../operator-last-scan', () => ({
      readLastScan: vi.fn(async () => ({
        cards: [{ id: 'a' }],
        scanCompletedAt: '2026-05-10T00:00:00Z',
      })),
    }));
    vi.doMock('../../../operator-card-reconstruction', () => ({
      reconstructCards: vi.fn(async () => [
        {
          payload: { id: 'a', title: 't' },
          status: 'dispatched',
          dispatchedAt: 1234,
          ackedAt: null,
          undoCancelled: false,
        },
      ]),
    }));
    const { default: tool } = await import('../last_scan');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    const cards = (payload.snapshot as Record<string, unknown>).cards as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);
    expect(cards[0]._status).toBe('dispatched');
    expect(cards[0]._dispatchedAt).toBe(1234);
  });

  it('returns null snapshot when neither last-scan nor reconstruction has data', async () => {
    vi.doMock('../../../operator-last-scan', () => ({
      readLastScan: vi.fn(async () => null),
    }));
    vi.doMock('../../../operator-card-reconstruction', () => ({
      reconstructCards: vi.fn(async () => []),
    }));
    const { default: tool } = await import('../last_scan');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.snapshot).toBeNull();
  });
});

describe('operator:scanner_reset', () => {
  it('resets the session and surfaces enabled flag (operator-only)', async () => {
    const resetScannerSession = vi.fn(async () => undefined);
    vi.doMock('../../../operator-scanner-session', () => ({
      resetScannerSession,
      isScannerResumeEnabled: vi.fn(() => true),
    }));
    const { default: tool } = await import('../scanner_reset');
    expect(tool.agentRoles).toEqual(['operator']);
    const result = await tool.handler({}, MAKE_CTX({ role: 'operator' }));
    expect(resetScannerSession).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
    expect(payload.enabled).toBe(true);
    expect(payload.note).toMatch(/cleared|fresh/i);
  });

  it('emits a different note when scanner-resume is disabled', async () => {
    vi.doMock('../../../operator-scanner-session', () => ({
      resetScannerSession: vi.fn(async () => undefined),
      isScannerResumeEnabled: vi.fn(() => false),
    }));
    const { default: tool } = await import('../scanner_reset');
    const result = await tool.handler({}, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload.enabled).toBe(false);
    expect(payload.note).toMatch(/disabled|no-op/i);
  });
});

describe('operator:scanner_bootstrap', () => {
  it('passes ctx-resolved workspaceId to buildScannerBootstrap when arg omitted', async () => {
    const buildScannerBootstrap = vi.fn(async () => '## State bootstrap\n\nfixture');
    vi.doMock('../../../operator-scanner-bootstrap', () => ({ buildScannerBootstrap }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'workspace-from-registry'),
    }));
    const { default: tool } = await import('../scanner_bootstrap');
    const result = await tool.handler({}, MAKE_CTX());
    expect(buildScannerBootstrap).toHaveBeenCalledWith({
      workspaceId: 'workspace-from-registry',
      maxPriorSummaryChars: undefined,
    });
    const payload = parsePayload(result as never);
    expect(payload.workspaceId).toBe('workspace-from-registry');
    expect(payload.bootstrap).toMatch(/State bootstrap/);
  });

  it('honors explicit workspaceId arg', async () => {
    const buildScannerBootstrap = vi.fn(async () => 'explicit-blob');
    vi.doMock('../../../operator-scanner-bootstrap', () => ({ buildScannerBootstrap }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'wrong'),
    }));
    const { default: tool } = await import('../scanner_bootstrap');
    await tool.handler(
      { workspaceId: 'overridden', maxPriorSummaryChars: 200 },
      MAKE_CTX(),
    );
    expect(buildScannerBootstrap).toHaveBeenCalledWith({
      workspaceId: 'overridden',
      maxPriorSummaryChars: 200,
    });
  });
});
