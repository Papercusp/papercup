import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const routingSettings = {
    allowlist: [{ rank: 1, agent: 'codex' as const, model: 'sol' }],
    recencyHalfLifeDays: 14,
  };
  return {
    routingSettings,
    getFeedbackCore: vi.fn(async (_request: unknown, _deps: unknown) => ({})),
    acceptFeedbackRequestCore: vi.fn(async (_request: unknown, _deps: unknown) => ({
      ok: true as const, verdict: 'accepted' as const, state: 'routing', pending: true,
      conversation_id: 'accepted-conv', thread_id: 'thr-accepted-conv', request_key: 'retry-key',
      latency_contract: 'proceed' as const, park_key: null, hint: 'pending',
    })),
    continueFeedbackRequestCore: vi.fn(async (_workspace: string, _conversation: string, _deps: unknown) => false),
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
vi.mock('./get-feedback-core', () => ({ getFeedbackCore: h.getFeedbackCore,
  acceptFeedbackRequestCore: h.acceptFeedbackRequestCore, continueFeedbackRequestCore: h.continueFeedbackRequestCore }));
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

import { acceptFeedbackRequestProd, getFeedbackProd } from './get-feedback-prod';

describe('getFeedbackProd expert-routing settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists and returns acceptance before embedder/settings acquisition, then resumes the same identity', async () => {
    const result = await acceptFeedbackRequestProd({ workspaceId: 'workspace-1', requesterId: 'requester',
      question: 'slow routing', requestKey: 'retry-key' }, { ownerId: 'requester' } as never,
      { harnessSlug: 'papercusp', allowDispatch: false });
    expect(result).toMatchObject({ verdict: 'accepted', conversation_id: 'accepted-conv', pending: true });
    expect(h.acceptFeedbackRequestCore.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'retry-key', harnessSlug: 'papercusp', allowDispatch: false,
    });
    expect(h.readConsultExpertRoutingSettings).not.toHaveBeenCalled();
    expect(h.buildQueryEmbedderResolved).not.toHaveBeenCalled();
    expect(h.getFeedbackCore).not.toHaveBeenCalled();
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.continueFeedbackRequestCore).toHaveBeenCalledWith(
      'workspace-1', 'accepted-conv', expect.objectContaining({ execute: expect.any(Function) })));
  });

  it.each([true, false])('passes actual dispatch permission %s to creation without launching when disabled', async (allowDispatch) => {
    await getFeedbackProd(
      { workspaceId: 'workspace-1', requesterId: 'requester', question: 'question' },
      { ownerId: 'requester' } as never,
      { allowDispatch },
    );
    expect(h.getFeedbackCore.mock.calls[0]?.[0]).toMatchObject({ allowDispatch });
    expect(h.makeConsultReachDispatcher).toHaveBeenCalledTimes(allowDispatch ? 1 : 0);
  });

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
      telemetry?: { caller: string; policy: string; buildSha: string | null };
    };
    expect(routeParams.recencyHalfLifeDays).toBe(14);
    expect(routeParams.subjectRef).toBe('acceptance-x');
    expect(routeParams.telemetry).toMatchObject({ caller: 'consult:get_feedback', policy: 'consult-default' });

    const routeDeps = h.routeConsult.mock.calls[0]?.[1] as {
      getLiveness?: (ownerIds: string[]) => Promise<unknown>;
    };
    h.resolveSessionStates.mockResolvedValue(new Map());
    h.listLoopStanddownOwners.mockResolvedValue(new Set());
    await routeDeps.getLiveness?.(['expert-a', 'expert-b']);
    expect(h.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'expert-a' }, { ownerId: 'expert-b' }],
      { hydrateBatch: true, psuHostPositiveAuthority: true },
    );

    await deps.reach({ responder: 'expert', conversationId: 'conversation', summary: 'summary', body: 'body' });
    const dispatchDeps = h.makeConsultReachDispatcher.mock.calls[0]?.[1] as {
      loadRanks: (workspaceId: string) => Promise<readonly unknown[]>;
    };
    await expect(dispatchDeps.loadRanks('workspace-1')).resolves.toEqual(h.routingSettings.allowlist);
  });
});
