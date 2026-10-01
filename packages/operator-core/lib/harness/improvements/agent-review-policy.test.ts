import { describe, expect, it, vi } from 'vitest';

import {
  acceptanceSourceRevision,
  agentReviewEligibility,
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  evaluateImplementationAcceptance,
  hasStrictOwnerAction,
  IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
  IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS,
  IMPLEMENTATION_READINESS_SCHEMA_VERSION,
  implementationReadinessIsLegacyEquivalent,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  isStrictOwnerActionCapability,
  readAgentReviewState,
  readImplementationReadiness,
  readStructuredOwnerAsk,
  sealImplementationAcceptance,
  type ImplementationAcceptanceAuthority,
  type ImplementationAcceptanceContract,
  type ImplementationAcceptanceSource,
  type ImplementationReadinessState,
  WORK_ITEM_INTAKE_PRIMARY_STAGES,
} from './agent-review-policy';

// Copy-out mutation-probe seam: the regular suite imports the real policy, while
// scripts/mutation-probe.sh can point the same behavioral fixtures at a mutated
// copy without ever dirtying the shared checkout.
vi.mock('./agent-review-policy', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_AGENT_REVIEW_POLICY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const BUG_SOURCE: ImplementationAcceptanceSource = {
  kind: 'bug',
  title: 'Bounded parser drops the trailing token',
  summary: 'The bounded parser drops the last token of every line.',
};

const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};

const REVIEW_AUTHORITY: ImplementationAcceptanceAuthority = {
  kind: 'agent-review',
  reviewer: 'su-reviewer',
  submittedBy: 'su-author',
  round: 1,
};

function sealedContract(
  source: ImplementationAcceptanceSource = BUG_SOURCE,
  authority: ImplementationAcceptanceAuthority = REVIEW_AUTHORITY,
): ImplementationAcceptanceContract {
  const sealed = sealImplementationAcceptance({
    proposal: PROPOSAL,
    authority,
    reason: 'agent-review-approved (grade 5/5)',
    source,
    acceptedAt: '2026-09-05T00:00:00.000Z',
  });
  if (!sealed.ok) throw new Error(`fixture contract must seal: ${JSON.stringify(sealed)}`);
  return sealed.contract;
}

const readinessWith = (
  acceptance: Record<string, unknown> | undefined,
  status: ImplementationReadinessState['status'] = 'ready',
) =>
  createImplementationReadiness({
    status,
    source: 'agent-review',
    reason: status === 'ready' ? 'agent-review-approved' : 'awaiting-review',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...(acceptance ? { evidence: { acceptance } } : {}),
  });

const acceptedReadiness = (source: ImplementationAcceptanceSource = BUG_SOURCE) => readinessWith(sealedContract(source));

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

describe('versioned work-item intake stage', () => {
  it.each([
    {
      name: 'observation evidence outranks terminal lifecycle and never becomes bug work',
      input: {
        kind: 'bug',
        status: 'done',
        payload: { lane: 'observation', implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'observation', readiness: 'not-applicable', countsAsBugWork: false },
    },
    {
      name: 'unverified current candidate stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'unknown',
            source: 'agent-review',
            reason: 'awaiting-review',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'unknown', countsAsBugWork: false },
    },
    {
      name: 'revision-requested candidate stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'not-ready',
            source: 'agent-review',
            reason: 'revision-requested',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'not-ready', countsAsBugWork: false },
    },
    {
      name: 'ready without executable acceptance remains a candidate',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'ready',
            source: 'capture-policy',
            reason: 'legacy-immediate-policy',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'ready', countsAsBugWork: false },
    },
    {
      name: 'qualifying accepted bug is executable bug work',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'accepted', readiness: 'ready', countsAsBugWork: true },
    },
    {
      name: 'accepted non-bug work is not a bug count',
      input: {
        kind: 'feature',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'accepted', readiness: 'ready', countsAsBugWork: false },
    },
    {
      name: 'terminal accepted work remains terminal history',
      input: {
        kind: 'bug',
        status: 'done',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'terminal', readiness: 'ready', countsAsBugWork: true },
    },
    {
      name: 'missing legacy readiness is explicitly unknown',
      input: { kind: 'bug', status: 'open', payload: {} },
      expected: { primaryStage: 'unknown', readiness: 'legacy-missing', countsAsBugWork: false },
    },
    {
      name: 'malformed enrolled readiness is explicitly unknown',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } },
      },
      expected: { primaryStage: 'unknown', readiness: 'malformed', countsAsBugWork: false },
    },
  ])('$name', ({ input, expected }) => {
    const before = structuredClone(input);
    const decision = deriveWorkItemIntakeStage(input);
    expect(decision).toMatchObject(expected);
    expect(WORK_ITEM_INTAKE_PRIMARY_STAGES.filter((stage) => stage === decision.primaryStage)).toHaveLength(1);
    expect(input).toEqual(before);
  });
});

describe('readAgentReviewState', () => {
  it('accepts only complete, versionable routing state', () => {
    expect(
      readAgentReviewState({
        agentReview: {
          status: 'pending',
          submittedBy: 'su-filer',
          ledgerIdeaId: 'WI-7',
          round: 1,
        },
      }),
    ).toEqual({
      status: 'pending',
      submittedBy: 'su-filer',
      ledgerIdeaId: 'WI-7',
      round: 1,
    });

    expect(readAgentReviewState({ agentReview: { status: 'pending', round: 1 } })).toBeNull();
    expect(
      readAgentReviewState({ agentReview: { status: 'unknown', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 1 } }),
    ).toBeNull();
    expect(
      readAgentReviewState({ agentReview: { status: 'approved', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 0 } }),
    ).toBeNull();
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
      expect(
        agentReviewEligibility({
          kind: 'change',
          payload: {
            externalBlockers: [
              {
                kind: 'human',
                capability: humanCapability,
                capabilitySource: 'explicit',
                ref: `test:${humanCapability}`,
                summary: 'required',
                status: 'active',
                createdAt: '2026-08-20T00:00:00.000Z',
                createdBy: 'su-filer',
                updatedAt: '2026-08-20T00:00:00.000Z',
              },
            ],
          },
        }),
      ).toEqual({ eligible: false, reason: 'owner-capability' });
    },
  );

  it('recognizes product-decision as a strict structured owner capability', () => {
    expect(isStrictOwnerActionCapability('product-decision')).toBe(true);
    expect(
      readStructuredOwnerAsk({
        externalBlockers: [
          {
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
          },
        ],
      }),
    ).toMatchObject({
      question: 'Choose the supported scope.',
      askedOf: 'product-owner',
      askedBy: 'su-filer',
      unblockedBy: 'Record the product decision.',
    });
  });

  it('keeps product decisions agent-reviewable', () => {
    expect(
      agentReviewEligibility({
        kind: 'change',
        payload: { humanCapability: 'product-decision' },
      }),
    ).toEqual({ eligible: true });
    expect(hasStrictOwnerAction({ humanCapability: 'product-decision' })).toBe(false);
  });
});
