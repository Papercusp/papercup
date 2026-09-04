import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFeedbackCore: vi.fn(),
  reconcileInterestEventAwaits: vi.fn(),
  buildQueryEmbedder: vi.fn(async () => null),
  routeConsult: vi.fn(),
  resolveSessionStates: vi.fn(),
  notifyAgents: vi.fn(),
  makeConsultReviver: vi.fn(() => vi.fn()),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'requester-1', ownerLabel: 'Requester 1' }),
}));
vi.mock('../../interest-auto-arm', () => ({
  reconcileInterestEventAwaits: h.reconcileInterestEventAwaits,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../consult/get-feedback-core', () => ({ getFeedbackCore: h.getFeedbackCore }));
vi.mock('../../consult/relevance-router', () => ({ routeConsult: h.routeConsult }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedder: h.buildQueryEmbedder }));
vi.mock('../coordination/liveness-oracle', () => ({ resolveSessionStates: h.resolveSessionStates }));
vi.mock('../coordination/conversations', () => ({
  withConversationsIdentityScope: (_identity: unknown, _harness: unknown, fn: () => unknown) => fn(),
  conversationsScopeWorkspace: () => 'ws-test',
  openConversation: vi.fn(),
}));
vi.mock('../coordination/notify-agents', () => ({ notifyAgents: h.notifyAgents }));
vi.mock('../../consult/revive-responder', () => ({ makeConsultReviver: h.makeConsultReviver }));

import tool from './get-feedback';

const handle = {
  event_keys: ['consult:reply:consult-1'],
  await_ids: [61],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [61] } },
  handle_note: 'captured requester wake handle',
};

const routed = (latencyContract: 'proceed' | 'hard-blocked') => ({
  verdict: 'routed' as const,
  conversation_id: 'consult-1',
  thread_id: 'thread-1',
  responder: 'peer-1',
  responder_via: 'floor',
  remaining_candidates: [],
  origin_task_ref: 'WI-1',
  latency_contract: latencyContract,
  expires_at: '2026-08-21T00:10:00.000Z',
  wake: { woke: 1 },
  park_key: latencyContract === 'hard-blocked' ? 'consult:reply:consult-1' : null,
});

const call = async (latencyContract: 'proceed' | 'hard-blocked') => {
  const out = await (tool as any).handler(
    { question: 'What already failed here?', latency_contract: latencyContract },
    { harnessSlug: 'papercusp' },
  );
  return out.data as Record<string, unknown>;
};

beforeEach(() => {
  h.getFeedbackCore.mockReset();
  h.routeConsult.mockReset();
  h.resolveSessionStates.mockReset();
  h.reconcileInterestEventAwaits.mockReset().mockResolvedValue(handle);
  h.buildQueryEmbedder.mockClear();
  h.makeConsultReviver.mockClear();
});

describe('consult:get_feedback requester interest handle (P-024)', () => {
  it('arms and returns a cancel handle only for a routed hard-blocked park key', async () => {
    h.getFeedbackCore.mockResolvedValue(routed('hard-blocked'));
    const out = await call('hard-blocked');
    expect(h.reconcileInterestEventAwaits).toHaveBeenCalledWith({
      ownerId: 'requester-1',
      eventKeys: ['consult:reply:consult-1'],
      boundTo: { kind: 'consult-request', ref: 'consult-1' },
      note: 'hard-blocked consult requester auto-arm for consult-1',
    });
    expect(out.interest_watch).toEqual(handle);
  });

  it('does not arm or return a requester watch for proceed-mode consults', async () => {
    h.getFeedbackCore.mockResolvedValue(routed('proceed'));
    const out = await call('proceed');
    expect(h.reconcileInterestEventAwaits).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('interest_watch');
  });

  it('uses a live PTY host as positive authority when annotating routing candidates', async () => {
    h.resolveSessionStates.mockResolvedValue(
      new Map([['peer-host-live', { ownerId: 'peer-host-live', sessionState: 'recorded' }]]),
    );
    h.routeConsult.mockImplementation(
      async (
        _params: unknown,
        deps: { getLiveness: (ownerIds: string[]) => Promise<Record<string, string | null>> },
      ) => {
        expect(await deps.getLiveness(['peer-host-live'])).toEqual({
          'peer-host-live': 'recorded',
        });
        return {};
      },
    );
    h.getFeedbackCore.mockImplementation(
      async (
        _request: unknown,
        deps: { route: (params: Record<string, unknown>) => Promise<unknown> },
      ) => {
        await deps.route({});
        return routed('proceed');
      },
    );

    await call('proceed');

    expect(h.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'peer-host-live' }],
      { hydratePerId: true, psuHostPositiveAuthority: true },
    );
  });
});
