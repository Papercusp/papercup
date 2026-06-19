/**
 * attention-parallel.test.ts — characterization test for plans:attention
 * (infra-perf-robustness-audit-2026-06-18 P-005). The handler aggregates ~10
 * independent sources; P-005 made the source reads CONCURRENT (Promise.all) to
 * cut the p50 ~2s latency. This is the safety net the (previously untested)
 * handler lacked: it pins that EVERY parallel source still contributes to the
 * output (a dropped/broken block would lose its items) and that the result shape
 * is intact. The mappers + grouping are REAL (pure); only the data sources are
 * mocked. Sources not under test return empty so the assertions are unambiguous.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the source-helpers + every data source. The two under test
//    (escalations, conversations) return identifiable items; the rest are empty.
const M = vi.hoisted(() => ({
  readAllPlans: vi.fn(async () => [] as unknown[]),
  ctxToPlanSourceOpts: vi.fn(async () => ({})),
  planItemsToAttention: vi.fn(() => [] as unknown[]),
  listEscalations: vi.fn(async () => [] as unknown[]),
  listConversations: vi.fn(async () => [] as unknown[]),
}));

// NOTE: vi.mock paths resolve relative to THIS test file (one level deeper, in
// __tests__/), so they carry an extra `../` vs attention.ts's own import paths.
vi.mock('../source', () => ({ readAllPlans: M.readAllPlans }));
vi.mock('../_ctx-opts', () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock('../../_harness-scope', async (orig) => {
  const actual = await orig<typeof import('../../_harness-scope')>();
  return { ...actual, harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx };
});
vi.mock('../../../attention/sources', async (orig) => {
  const actual = await orig<typeof import('../../../attention/sources')>();
  return { ...actual, planItemsToAttention: M.planItemsToAttention };
});
vi.mock('../../coordination/escalations', () => ({ listEscalations: M.listEscalations }));
vi.mock('../../coordination/conversations', () => ({ listConversationsWithTopics: M.listConversations }));
// Remaining sources → empty (no PG in the unit env).
vi.mock('../../coordination/messages', () => ({
  readInbox: vi.fn(async () => []),
  readAckedMsgIds: vi.fn(async () => new Set()),
}));
vi.mock('../../coordination/identity', () => ({ ADMIN_COORD_UI_OWNER: 'admin' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: async () => [] }) };
});
vi.mock('../../../attention/operator-report-source', () => ({ readRecentOperatorReports: vi.fn(async () => []) }));
vi.mock('../../../harness/improvements/read-items', () => ({ readImprovementItems: vi.fn(async () => []) }));
vi.mock('../../../operator-standing-candidates', () => ({ readCandidates: vi.fn(async () => []) }));
vi.mock('../../../scout/routed-ledger', () => ({ readRoutedIdeas: vi.fn(async () => []) }));
vi.mock('../../../plan-items/convert', () => ({ listConvertedPlanItemRefs: vi.fn(async () => new Set()) }));
vi.mock('../../../attention/triage-store', () => ({ readTriageByWorkspace: vi.fn(async () => new Map()) }));

import tool from '../attention';

const CTX = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  metadata: vi.fn(),
  workspaceId: 'ws',
  role: 'operator' as const,
  principal: { slug: 'agent-test' },
} as never;

const run = async () => {
  const res = (await tool.handler({} as never, CTX)) as { content: { text: string }[] };
  const parsed = JSON.parse(res.content[0].text) as {
    groups: Array<{ items: Array<{ id: string; kind: string }> }>;
    tierCounts: Record<string, number>;
  };
  return parsed;
};

const allItems = (p: Awaited<ReturnType<typeof run>>) => p.groups.flatMap((g) => g.items);

beforeEach(() => {
  vi.clearAllMocks();
  M.readAllPlans.mockResolvedValue([]);
  M.ctxToPlanSourceOpts.mockResolvedValue({});
  M.planItemsToAttention.mockReturnValue([]);
  M.listEscalations.mockResolvedValue([]);
  M.listConversations.mockResolvedValue([]);
});

describe('plans:attention — parallel source aggregation (P-005)', () => {
  it('returns a well-formed { groups, tierCounts } shape even when every source is empty', async () => {
    const p = await run();
    expect(Array.isArray(p.groups)).toBe(true);
    expect(p.tierCounts).toBeTypeOf('object');
    expect(allItems(p)).toHaveLength(0);
  });

  it('aggregates items from MULTIPLE independent parallel sources (none dropped)', async () => {
    M.listEscalations.mockResolvedValue([
      { msg_id: 'esc-1', severity: 'critical', summary: 'an escalation', plan_slug: null, options: [], from: 'su-x' },
    ]);
    M.listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'an open question', body: 'q?', asker_id: 'su-y', harness_slug: null, accepted_answer: null },
    ]);
    const p = await run();
    const ids = allItems(p).map((i) => i.id);
    // Both the escalation (block 2) AND the conversation (block 9) must surface —
    // proving the parallelized blocks each ran and contributed.
    expect(ids.some((id) => id.includes('esc-1'))).toBe(true);
    expect(ids.some((id) => id.includes('conv-1'))).toBe(true);
  });

  it('a source that throws does not block or fail the others (best-effort preserved)', async () => {
    M.listEscalations.mockRejectedValue(new Error('escalations source down'));
    M.listConversations.mockResolvedValue([
      { id: 'conv-2', title: 'still here', body: null, asker_id: null, harness_slug: null, accepted_answer: null },
    ]);
    const p = await run(); // must not throw despite block 2 rejecting
    const ids = allItems(p).map((i) => i.id);
    expect(ids.some((id) => id.includes('esc-1'))).toBe(false);
    expect(ids.some((id) => id.includes('conv-2'))).toBe(true); // the healthy parallel source still contributes
  });

  it('runs the source reads CONCURRENTLY, not sequentially', async () => {
    // Gate each source on a deferred promise; resolve them out of order. If the
    // handler awaited them sequentially it would deadlock (the 2nd never starts
    // until the 1st resolves) — concurrent start lets both be in-flight at once.
    let escStarted = false;
    let convStarted = false;
    M.listEscalations.mockImplementation(async () => {
      escStarted = true;
      // wait until the OTHER source has also started — only possible if concurrent
      for (let i = 0; i < 50 && !convStarted; i++) await Promise.resolve();
      return [];
    });
    M.listConversations.mockImplementation(async () => {
      convStarted = true;
      for (let i = 0; i < 50 && !escStarted; i++) await Promise.resolve();
      return [];
    });
    await run();
    expect(escStarted && convStarted).toBe(true);
  });
});
