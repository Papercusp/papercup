import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const routingSettings = {
    allowlist: [{ rank: 1, agent: 'codex' as const, model: 'sol' }],
    recencyHalfLifeDays: 14,
  };
  return {
    routingSettings,
    getFeedbackCore: vi.fn(async (_request: unknown, _deps: unknown) => ({})),
    getOrgPg: vi.fn(() => ({ sql: {} })),
    buildQueryEmbedderResolved: vi.fn(async () => null),
    interactiveEmbedAcquireBudgetMs: vi.fn(() => 10),
    resolveProseProfileSelection: vi.fn(),
    resolveSessionStates: vi.fn(),
    listLoopStanddownOwners: vi.fn(),
    openConversation: vi.fn(),
    routeConsult: vi.fn(async (_params: unknown, _deps: unknown) => ({ verdict: 'no_qualified_responder' })),
    makeConsultReachDispatcher: vi.fn((_context: unknown, _deps: unknown) => async () => ({})),
    readConsultExpertRoutingSettings: vi.fn(async () => routingSettings),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: h.getOrgPg,
}));
vi.mock('./get-feedback-core', () => ({ getFeedbackCore: h.getFeedbackCore }));
vi.mock('./relevance-router', () => ({ routeConsult: h.routeConsult }));
vi.mock('../agent-tools/search/embedder', () => ({
  buildQueryEmbedderResolved: h.buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs: h.interactiveEmbedAcquireBudgetMs,
}));
vi.mock('../search/prose-vector-dims', () => ({ resolveProseProfileSelection: h.resolveProseProfileSelection }));
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: h.resolveSessionStates }));
vi.mock('../harness/routines/release-pause-ttl', () => ({ listLoopStanddownOwners: h.listLoopStanddownOwners }));
vi.mock('../agent-tools/coordination/conversations', () => ({ openConversation: h.openConversation }));
vi.mock('./consult-dispatch', () => ({ makeConsultReachDispatcher: h.makeConsultReachDispatcher }));
vi.mock('./expert-routing-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./expert-routing-settings')>();
  return { ...actual, readConsultExpertRoutingSettings: h.readConsultExpertRoutingSettings };
});

import { getFeedbackProd } from './get-feedback-prod';

describe('getFeedbackProd expert-routing settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses one persisted snapshot for comparison recency and dispatch ranks', async () => {
    await getFeedbackProd(
      { workspaceId: 'workspace-1', requesterId: 'requester', question: 'question', subjectRef: 'acceptance-x' },
      { ownerId: 'requester' } as never,
    );

    expect(h.readConsultExpertRoutingSettings).toHaveBeenCalledTimes(1);

    const deps = h.getFeedbackCore.mock.calls[0]?.[1] as {
      route: (params: unknown) => Promise<unknown>;
      reach: (params: unknown) => Promise<unknown>;
    };
    await deps.route({
      workspaceId: 'workspace-1',
      requesterId: 'requester',
      question: 'question',
      subjectRef: 'acceptance-x',
    });
    const routeParams = h.routeConsult.mock.calls[0]?.[0] as {
      recencyHalfLifeDays?: number;
      subjectRef?: string | null;
    };
    expect(routeParams.recencyHalfLifeDays).toBe(14);
    expect(routeParams.subjectRef).toBe('acceptance-x');

    await deps.reach({ responder: 'expert', conversationId: 'conversation', summary: 'summary', body: 'body' });
    const dispatchDeps = h.makeConsultReachDispatcher.mock.calls[0]?.[1] as {
      loadRanks: (workspaceId: string) => Promise<readonly unknown[]>;
    };
    await expect(dispatchDeps.loadRanks('workspace-1')).resolves.toEqual(h.routingSettings.allowlist);
  });
});
