import { describe, expect, it, vi } from 'vitest';
import type { GetFeedbackResult } from '../consult/get-feedback-core';
import {
  buildGoalFeedbackConsultPort,
  extractGoalConsultFeedback,
  resolvePendingGoalConsults,
  selectPendingGoalConsults,
  type GoalConsultArtifactRow,
  type GoalConsultStateRow,
  type GoalFeedbackRunner,
} from './goal-consult';
import type { Proposal, ProposalConsultation } from './types';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    framing: 'A bounded multi-plan reliability goal',
    mechanism: 'Run one measured rollout and retain rollback evidence',
    whyNew: 'The existing plans do not join the evidence',
    bet: 'One goal closes the cross-plan outcome gap',
    cheapExperiment: {
      hypothesis: 'one bounded rollout exposes the missing join',
      method: 'run on one workspace',
      falsifiableSignal: 'the evidence remains unjoinable',
    },
    sourceIdeaIds: ['idea-1'],
    addressesPatternRefs: ['plan:reliability'],
    routeHint: 'goal',
    ...over,
  };
}

function result(over: Partial<GetFeedbackResult>): GetFeedbackResult {
  return {
    ok: true,
    verdict: 'routed',
    conversation_id: 'conv-1',
    thread_id: 'thread-1',
    state: 'awaiting_responder',
    responder: { ownerId: 'reviewer-1' } as never,
    responder_via: 'floor',
    remaining_candidates: [],
    origin_task_ref: 'scout-goal:cycle-1:proposal-1',
    latency_contract: 'proceed',
    expires_at: '2026-08-22T08:00:00.000Z',
    wake: { attempted: true, queued: 1, woke: 1, pickupConfirmed: false },
    park_key: null,
    hint: 'routed',
    ...over,
  };
}

describe('buildGoalFeedbackConsultPort', () => {
  const opts = {
    harnessSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    cycleId: 'cycle-1',
    requesterId: 'system:scout:papercusp',
  };

  it('persists a routed live review as pending before any goal write', async () => {
    const run = vi.fn(async (_request: Parameters<GoalFeedbackRunner>[0]) => result({}));
    const port = buildGoalFeedbackConsultPort(opts, run);
    const out = await port({ proposal: proposal() });

    expect(out.consultation).toMatchObject({
      originCycleId: 'cycle-1',
      originalProposalId: 'proposal-1',
      conversationId: 'conv-1',
      status: 'pending',
      verdict: 'routed',
    });
    expect(out.proposal.consultation).toEqual(out.consultation);
    expect(run.mock.calls[0][0]).toMatchObject({
      latencyContract: 'proceed',
      minResponders: 1,
      maxResponders: 3,
      originTaskRef: 'scout-goal:cycle-1:proposal-1',
    });
  });

  it('folds an archive-served critique into the proposal immediately', async () => {
    const run = vi.fn(async () =>
      result({
        verdict: 'served_from_archive',
        state: 'served_from_archive',
        responder: null,
        responder_via: null,
        wake: { attempted: false, queued: 0, woke: 0, pickupConfirmed: false },
        archive: {
          source_conversation_id: 'conv-old',
          responder_id: 'reviewer-old',
          closed_at: '2026-08-21T00:00:00.000Z',
          sim: 0.93,
          answer: { answer: 'Preserve a one-workspace canary and explicit rollback evidence.' },
        },
      }),
    );
    const out = await buildGoalFeedbackConsultPort(opts, run)({ proposal: proposal() });

    expect(out.consultation).toMatchObject({
      status: 'answered',
      verdict: 'served_from_archive',
      feedback: 'Preserve a one-workspace canary and explicit rollback evidence.',
    });
  });

  it('records no-qualified and thrown infrastructure outcomes as honest unavailability', async () => {
    const noRoute = await buildGoalFeedbackConsultPort(opts, async () =>
      result({
        verdict: 'no_qualified_responder',
        state: 'no_qualified_responder',
        responder: null,
        responder_via: null,
        reason: 'below_floor',
        wake: { attempted: false, queued: 0, woke: 0, pickupConfirmed: false },
      }),
    )({ proposal: proposal() });
    expect(noRoute.consultation).toMatchObject({ status: 'unavailable', verdict: 'no_qualified_responder' });

    // EI-21485716602970457: an embedder outage must NOT be re-labelled as a
    // measured absence on the way through Scout. Both dispositions are
    // 'unavailable', which is exactly what made the old hardcoded literal look
    // harmless — and why the typechecker could never have caught it.
    const unmeasured = await buildGoalFeedbackConsultPort(opts, async () =>
      result({
        verdict: 'relevance_unmeasured',
        state: 'no_qualified_responder',
        responder: null,
        responder_via: null,
        reason: 'embed_unavailable',
        wake: { attempted: false, queued: 0, woke: 0, pickupConfirmed: false },
      }),
    )({ proposal: proposal() });
    expect(unmeasured.consultation).toMatchObject({
      status: 'unavailable',
      verdict: 'relevance_unmeasured',
    });
    expect(unmeasured.consultation?.verdict).not.toBe('no_qualified_responder');

    const failed = await buildGoalFeedbackConsultPort(opts, async () => {
      throw new Error('embedder offline');
    })({ proposal: proposal() });
    expect(failed.consultation).toMatchObject({
      status: 'unavailable',
      state: 'binding_error',
      verdict: 'failed',
      reason: 'embedder offline',
    });
  });
});

describe('stage-artifact continuation', () => {
  const consultation: ProposalConsultation = {
    originCycleId: 'cycle-origin',
    originalProposalId: 'proposal-1',
    conversationId: 'conv-1',
    status: 'pending',
    state: 'awaiting_responder',
    verdict: 'routed',
  };
  const artifact = (routingDecisions: unknown[] = []): GoalConsultArtifactRow => ({
    cycle_id: 'cycle-origin',
    created_at: '2026-08-22T03:00:00.000Z',
    ideas: [{ id: 'idea-1', lens: 'analogical', addressesPatternRefs: ['plan:reliability'] }],
    proposals: [proposal({ consultation })],
    routing_decisions: routingDecisions,
  });

  it('waits while open, then folds a terminal answer and restores source-lens provenance', () => {
    const pending = selectPendingGoalConsults([artifact()]);
    expect(resolvePendingGoalConsults(pending, new Map())).toEqual([]);

    const state: GoalConsultStateRow = {
      conversation_id: 'conv-1',
      state: 'closed_answered',
      responder_id: 'reviewer-1',
      outcome: { answer: 'Keep the canary bounded to one workspace.' },
    };
    const [resumed] = resolvePendingGoalConsults(pending, new Map([['conv-1', state]]));

    expect(resumed.id).toBe('consulted:cycle-origin:proposal-1');
    expect(resumed.consultation).toMatchObject({
      status: 'answered',
      state: 'closed_answered',
      feedback: 'Keep the canary bounded to one workspace.',
      reviewerId: 'reviewer-1',
    });
    expect(resumed.sourceIdeaProvenance).toEqual([
      { id: 'idea-1', lens: 'analogical', addressesPatternRefs: ['plan:reliability'] },
    ]);
  });

  it('proceeds after terminal unavailability and never replays an already-routed origin key', () => {
    const pending = selectPendingGoalConsults([artifact()]);
    const unavailable: GoalConsultStateRow = {
      conversation_id: 'conv-1',
      state: 'expired',
      responder_id: null,
      outcome: null,
    };
    expect(resolvePendingGoalConsults(pending, new Map([['conv-1', unavailable]]))[0].consultation).toMatchObject({
      status: 'unavailable',
      state: 'expired',
    });

    const completed = artifact([
      { proposalId: 'consulted:cycle-origin:proposal-1', routedRef: 'goal:g-1', consultation },
    ]);
    expect(selectPendingGoalConsults([completed])).toEqual([]);
  });
});

describe('extractGoalConsultFeedback', () => {
  it('unwraps archive/structured answers but ignores empty values', () => {
    expect(extractGoalConsultFeedback({ source: 'archive', answer: { answer: 'use the existing seam' } })).toBe(
      'use the existing seam',
    );
    expect(extractGoalConsultFeedback({ answer: '   ' })).toBeNull();
  });
});
