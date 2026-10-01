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
  // `object`, not Record<string, unknown>: fixtures pass interface values and
  // deliberately malformed shapes alike.
  acceptance: object | undefined,
  status: ImplementationReadinessState['status'] = 'ready',
) =>
  createImplementationReadiness({
    status,
    source: 'agent-review',
    reason: status === 'ready' ? 'agent-review-approved' : 'awaiting-review',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
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
        payload: { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, kind: 'feature' }) },
      },
      expected: { primaryStage: 'accepted', readiness: 'ready', countsAsBugWork: false },
    },
    {
      name: 'R-21: a title edit after acceptance makes it stale and requests re-review',
      input: {
        kind: 'bug',
        status: 'open',
        title: 'Bounded parser drops the trailing token (rescoped)',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'acceptance-revision-stale',
        acceptance: 'stale-revision',
        reReviewRequested: true,
        countsAsBugWork: false,
      },
    },
    {
      name: 'R-21: a kind change after acceptance makes it stale',
      input: {
        kind: 'change',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'candidate', acceptance: 'stale-revision', reReviewRequested: true },
    },
    {
      name: 'fail-closed: acceptance cannot qualify when the current source was not supplied',
      input: {
        kind: 'bug',
        status: 'open',
        title: null,
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'candidate', acceptance: 'stale-revision', qualifyingAcceptance: false },
    },
    {
      name: 'R-20: self-review is not acceptance authority',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' },
          }),
        },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'acceptance-authority-invalid',
        acceptance: 'invalid-authority',
        countsAsBugWork: false,
      },
    },
    {
      name: 'R-20: confidence is never acceptance authority',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { kind: 'confidence', confidence: 0.99 },
          }),
        },
      },
      expected: { primaryStage: 'candidate', acceptance: 'invalid-authority' },
    },
    {
      name: 'R-20: dedup admission is not an allowlisted acceptance policy',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { kind: 'policy', policy: 'duplicate-admission', actor: 'system:dedup' },
          }),
        },
      },
      expected: { primaryStage: 'candidate', acceptance: 'invalid-authority' },
    },
    {
      name: 'an allowlisted existing policy may write qualifying acceptance',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith(
            sealedContract(BUG_SOURCE, {
              kind: 'policy',
              policy: 'trusted-tool-failure-promotion',
              actor: 'system:tool-failure-watchdog',
            }),
          ),
        },
      },
      expected: { primaryStage: 'accepted', acceptance: 'qualifying', countsAsBugWork: true },
    },
    {
      name: 'R-4: a ready verdict missing the completion check stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith(
            Object.fromEntries(Object.entries(sealedContract()).filter(([key]) => key !== 'completionCheck')),
          ),
        },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'ready-without-executable-acceptance',
        acceptance: 'incomplete',
        countsAsBugWork: false,
      },
    },
    {
      name: 'an unsealed producer proposal on an unknown verdict stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: readinessWith(PROPOSAL, 'unknown') },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'awaiting-qualifying-acceptance',
        acceptance: 'incomplete',
      },
    },
    {
      name: 'a qualifying contract under a not-ready verdict is not accepted',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: readinessWith(sealedContract(), 'not-ready') },
      },
      expected: { primaryStage: 'candidate', acceptance: 'qualifying', qualifyingAcceptance: false },
    },
    {
      name: 'D-009a: a creation-enrollment stamp is a measurable candidate in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'unknown',
            source: 'creation-enrollment',
            reason: 'no-acceptance-evidence-at-creation',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: {
        primaryStage: 'candidate',
        readiness: 'unknown',
        reason: 'awaiting-qualifying-acceptance',
        acceptance: 'absent',
      },
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
    // The current source content the acceptance revision is checked against;
    // a case overrides title (or kind) to model an edit after acceptance.
    const full = { title: BUG_SOURCE.title, summary: BUG_SOURCE.summary, ...input };
    const before = structuredClone(full);
    const decision = deriveWorkItemIntakeStage(full);
    expect(decision).toMatchObject(expected);
    expect(WORK_ITEM_INTAKE_PRIMARY_STAGES.filter((stage) => stage === decision.primaryStage)).toHaveLength(1);
    expect(full).toEqual(before);
  });
});

describe('implementation acceptance contract (R-4 / R-20 / R-21)', () => {
  it('seals a complete proposal bound to the judged source revision', () => {
    const contract = sealedContract();
    expect(contract).toEqual({
      contractVersion: IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
      ...PROPOSAL,
      authority: REVIEW_AUTHORITY,
      reason: 'agent-review-approved (grade 5/5)',
      sourceRevision: acceptanceSourceRevision(BUG_SOURCE),
      acceptedAt: '2026-09-05T00:00:00.000Z',
    });
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(contract) }, BUG_SOURCE)).toMatchObject({
      state: 'qualifying',
      contract,
    });
  });

  it.each(IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS.map((field) => ({ field })))(
    'refuses — never defaults — a proposal missing $field',
    ({ field }) => {
      const proposal: Record<string, unknown> = { ...PROPOSAL, [field]: field === 'evidence' ? ['  '] : '   ' };
      expect(
        sealImplementationAcceptance({ proposal, authority: REVIEW_AUTHORITY, reason: 'approved', source: BUG_SOURCE }),
      ).toEqual({ ok: false, refusal: 'incomplete', missing: [field] });
      delete proposal[field];
      expect(
        sealImplementationAcceptance({ proposal, authority: REVIEW_AUTHORITY, reason: 'approved', source: BUG_SOURCE }),
      ).toEqual({ ok: false, refusal: 'incomplete', missing: [field] });
    },
  );

  it('refuses a missing reason and confidence never substitutes for a field', () => {
    const { scope: _scope, ...withoutScope } = PROPOSAL;
    expect(
      sealImplementationAcceptance({
        proposal: { ...withoutScope, confidence: 1, deduplicated: true } as never,
        authority: REVIEW_AUTHORITY,
        reason: ' ',
        source: BUG_SOURCE,
      }),
    ).toEqual({ ok: false, refusal: 'incomplete', missing: ['scope', 'reason'] });
  });

  it.each([
    { name: 'self-review', authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' } },
    { name: 'round zero', authority: { ...REVIEW_AUTHORITY, round: 0 } },
    { name: 'blank reviewer', authority: { ...REVIEW_AUTHORITY, reviewer: '  ' } },
    { name: 'a non-allowlisted policy', authority: { kind: 'policy', policy: 'explicit-assignment', actor: 'su-x' } },
    { name: 'an allowlisted policy without an actor', authority: { kind: 'policy', policy: 'trusted-tool-failure-promotion', actor: '' } },
    { name: 'a confidence score', authority: { kind: 'confidence', confidence: 0.99 } },
  ])('refuses $name as acceptance authority', ({ authority }) => {
    expect(
      sealImplementationAcceptance({
        proposal: PROPOSAL,
        authority: authority as ImplementationAcceptanceAuthority,
        reason: 'approved',
        source: BUG_SOURCE,
      }),
    ).toEqual({ ok: false, refusal: 'invalid-authority' });
  });

  it('revision changes with kind, title or body and treats a null body as empty', () => {
    const base = acceptanceSourceRevision(BUG_SOURCE);
    expect(base).toMatch(/^src-v1:[0-9a-f]{64}$/);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, kind: 'change' })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, title: `${BUG_SOURCE.title}.` })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, summary: `${BUG_SOURCE.summary} More.` })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, summary: null })).toBe(
      acceptanceSourceRevision({ ...BUG_SOURCE, summary: '' }),
    );
  });

  it('reports the seal fields a bare proposal is missing, and an array authority as missing', () => {
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(PROPOSAL) }, BUG_SOURCE)).toEqual({
      state: 'incomplete',
      missing: ['contractVersion', 'authority', 'reason', 'sourceRevision', 'acceptedAt'],
    });
    expect(
      evaluateImplementationAcceptance(
        { implementationReadiness: readinessWith({ ...sealedContract(), authority: [REVIEW_AUTHORITY] }) },
        BUG_SOURCE,
      ),
    ).toEqual({ state: 'incomplete', missing: ['authority'] });
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(undefined) }, BUG_SOURCE)).toEqual({
      state: 'absent',
      missing: [],
    });
  });
});

describe('implementationReadinessIsLegacyEquivalent (D-011 creation enrollment)', () => {
  const stamp = (overrides: Partial<ImplementationReadinessState> = {}) => ({
    implementationReadiness: {
      ...createImplementationReadiness({
        status: 'unknown',
        source: 'creation-enrollment',
        reason: 'no-acceptance-evidence-at-creation',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
      ...overrides,
    },
  });

  it('treats an absent key and a well-formed creation stamp as the legacy exception only', () => {
    expect(implementationReadinessIsLegacyEquivalent({})).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(null)).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(stamp())).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ source: 'capture-policy' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ status: 'ready' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ reason: '' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent({ implementationReadiness: null })).toBe(false);
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
