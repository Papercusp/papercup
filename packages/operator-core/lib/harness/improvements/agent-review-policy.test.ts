import { describe, expect, it } from 'vitest';

import {
  agentReviewEligibility,
  readAgentReviewState,
} from './agent-review-policy';

describe('readAgentReviewState', () => {
  it('accepts only complete, versionable routing state', () => {
    expect(readAgentReviewState({
      agentReview: {
        status: 'pending',
        submittedBy: 'su-filer',
        ledgerIdeaId: 'WI-7',
        round: 1,
      },
    })).toEqual({
      status: 'pending',
      submittedBy: 'su-filer',
      ledgerIdeaId: 'WI-7',
      round: 1,
    });

    expect(readAgentReviewState({ agentReview: { status: 'pending', round: 1 } })).toBeNull();
    expect(readAgentReviewState({ agentReview: { status: 'unknown', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 1 } })).toBeNull();
    expect(readAgentReviewState({ agentReview: { status: 'approved', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 0 } })).toBeNull();
  });
});

describe('agentReviewEligibility (abolish-human-review D-003)', () => {
  it('admits issue-family changes and feature improvements', () => {
    expect(agentReviewEligibility({ kind: 'change', payload: {} })).toEqual({ eligible: true });
    expect(agentReviewEligibility({ kind: 'change', payload: { improvementKind: 'feature' } })).toEqual({ eligible: true });
  });

  it('keeps observations and non-review kinds out of the lane', () => {
    expect(agentReviewEligibility({ kind: 'bug', payload: {} })).toEqual({
      eligible: false,
      reason: 'not-review-kind',
    });
    expect(agentReviewEligibility({ kind: 'change', payload: { lane: 'observation' } })).toEqual({
      eligible: false,
      reason: 'observation',
    });
  });

  it('keeps remote-owned rows on peer reconciliation', () => {
    expect(agentReviewEligibility({ kind: 'change', origin: 'remote', payload: {} })).toEqual({
      eligible: false,
      reason: 'remote-owned',
    });
  });

  it.each(['credential', 'physical-device', 'external-service-action'] as const)(
    'keeps strict %s needs on the owner-capability path',
    (humanCapability) => {
      expect(agentReviewEligibility({ kind: 'change', payload: { humanCapability } })).toEqual({
        eligible: false,
        reason: 'owner-capability',
      });
      expect(agentReviewEligibility({
        kind: 'change',
        payload: {
          externalBlockers: [{
            kind: 'human',
            capability: humanCapability,
            capabilitySource: 'explicit',
            ref: `test:${humanCapability}`,
            summary: 'required',
            status: 'active',
            createdAt: '2026-08-20T00:00:00.000Z',
            createdBy: 'su-filer',
            updatedAt: '2026-08-20T00:00:00.000Z',
          }],
        },
      })).toEqual({ eligible: false, reason: 'owner-capability' });
    },
  );

  it('keeps product decisions agent-reviewable', () => {
    expect(agentReviewEligibility({
      kind: 'change',
      payload: { humanCapability: 'product-decision' },
    })).toEqual({ eligible: true });
  });
});
