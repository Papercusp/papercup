import { describe, expect, it } from 'vitest';

import {
  agentReviewEligibility,
  createImplementationReadiness,
  hasStrictOwnerAction,
  IMPLEMENTATION_READINESS_SCHEMA_VERSION,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  isStrictOwnerActionCapability,
  readAgentReviewState,
  readImplementationReadiness,
  readStructuredOwnerAsk,
} from './agent-review-policy';

describe('implementation readiness payload', () => {
  it('round-trips a current three-valued verdict with a stable schema version', () => {
    const readiness = createImplementationReadiness({
      status: 'ready',
      source: 'agent-review',
      reason: 'agent-review-approved',
      updatedAt: '2026-09-05T00:00:00.000Z',
      evidence: { review: { submittedBy: 'su-a', reviewer: 'su-b', round: 2, grade: 5 } },
    });
    expect(readiness.schemaVersion).toBe(IMPLEMENTATION_READINESS_SCHEMA_VERSION);
    expect(readImplementationReadiness({ implementationReadiness: readiness })).toEqual(readiness);
  });

  it('keeps absent legacy metadata distinct from malformed enrolled metadata', () => {
    expect(readImplementationReadiness({})).toBeNull();
    expect(
      readImplementationReadiness({
        implementationReadiness: {
          schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
          status: 'ready',
        },
      }),
    ).toBeNull();
  });
});

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
  it.each(['bug', 'change', 'task', 'feature'])('admits preserved %s work-item kinds', (kind) => {
    expect(agentReviewEligibility({ kind, payload: {} })).toEqual({ eligible: true });
  });

  it('keeps observations and non-review kinds out of the lane', () => {
    expect(agentReviewEligibility({ kind: 'chunk', payload: {} })).toEqual({
      eligible: false,
      reason: 'not-review-kind',
    });
    expect(agentReviewEligibility({ kind: 'change', payload: { lane: 'observation' } })).toEqual({
      eligible: false,
      reason: 'observation',
    });
  });

  it('exports a stable non-owner sentinel for unattributed migrated revisions', () => {
    expect(LEGACY_AGENT_REVIEW_SUBMITTER).toBe('system:legacy-agent-review');
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

  it('recognizes product-decision as a strict structured owner capability', () => {
    expect(isStrictOwnerActionCapability('product-decision')).toBe(true);
    expect(readStructuredOwnerAsk({
      externalBlockers: [{
        kind: 'human',
        capability: 'product-decision',
        capabilitySource: 'explicit',
        ref: 'decision:scope',
        summary: 'Choose the supported scope.',
        nextVerb: 'Record the product decision.',
        status: 'active',
        createdAt: '2026-08-20T00:00:00.000Z',
        createdBy: 'su-filer',
        updatedAt: '2026-08-20T00:00:00.000Z',
      }],
    })).toMatchObject({
      question: 'Choose the supported scope.',
      askedOf: 'product-owner',
      askedBy: 'su-filer',
      unblockedBy: 'Record the product decision.',
    });
  });

  it('keeps product decisions agent-reviewable', () => {
    expect(agentReviewEligibility({
      kind: 'change',
      payload: { humanCapability: 'product-decision' },
    })).toEqual({ eligible: true });
    expect(hasStrictOwnerAction({ humanCapability: 'product-decision' })).toBe(false);
  });
});
