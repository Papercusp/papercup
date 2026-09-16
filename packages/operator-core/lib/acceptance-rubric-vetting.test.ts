import { describe, expect, it } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import { getAcceptanceRubricVettingStatus } from './acceptance-rubric-vetting';

const rubric = {
  rubricId: 'acceptance-plan',
  revision: 4,
  criteriaHash: 'hash-current',
  workspaceId: 'ws-test',
  kind: 'acceptance',
  characteristic: 'plan',
  title: 'Acceptance plan',
  description: '',
  criteria: [{ key: 'criterion', title: 'Criterion', model: 'observable' }],
  ratingScale: ['pass', 'fail'],
  methodRef: null,
} as Rubric;

function card(over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-vetting',
    createdAt: '2026-09-08T00:00:00.000Z',
    createdBy: 'su-author',
    rubricRef: 'meta-acceptance-rubric',
    ratings: { criterion: { rating: 'pass', evidence: 'reviewed' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    linkedItems: [],
    vetting: { consultId: 'consult-vetting', rubricRevision: 4, criteriaHash: 'hash-current' },
    ...over,
  } as ScorecardRow;
}

function deps(cards: ScorecardRow[]) {
  return {
    vettingGateEnabled: true,
    getRubric: async () => ({ ...rubric, rubricId: 'meta-acceptance-rubric', kind: 'standard' }) as Rubric,
    getRubricPlanRevision: async () => 4,
    listScorecards: async () => cards,
  };
}

describe('getAcceptanceRubricVettingStatus grading-audit admission', () => {
  it.each([
    ['pending', false],
    ['failed', false],
    ['passed', true],
  ] as const)('counts a stamped meta-scorecard only when its audit is %s', async (state, satisfied) => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({
          gradingAudit: {
            state,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-09-08T00:01:00.000Z',
          },
        }),
      ]),
    );

    expect(result.satisfied).toBe(satisfied);
    expect(result.state).toBe(satisfied ? 'vetted' : 'unvetted');
  });

  it('preserves pre-P-013 compatibility for a complete unstamped attestation', async () => {
    await expect(getAcceptanceRubricVettingStatus(rubric, deps([card()]))).resolves.toMatchObject({
      required: true,
      satisfied: true,
      state: 'vetted',
      reason: 'current',
      attestedRevision: 4,
    });
  });

  it('reuses unchanged vetting across a revision-only rubric edit', async () => {
    await expect(
      getAcceptanceRubricVettingStatus(
        { ...rubric, revision: 6 },
        { ...deps([card()]), getRubricPlanRevision: async () => 6 },
      ),
    ).resolves.toMatchObject({
      satisfied: true,
      state: 'vetted',
      reason: 'current',
      currentRevision: 6,
      attestedRevision: 4,
      currentCriteriaHash: 'hash-current',
      attestedCriteriaHash: 'hash-current',
    });
  });

  it('invalidates same-revision vetting when criterion or method identity changes', async () => {
    await expect(
      getAcceptanceRubricVettingStatus(
        rubric,
        deps([card({ vetting: { consultId: 'consult-vetting', rubricRevision: 4, criteriaHash: 'hash-old' } })]),
      ),
    ).resolves.toMatchObject({
      satisfied: false,
      state: 'unvetted',
      reason: 'stale-attestation',
      currentCriteriaHash: 'hash-current',
      attestedCriteriaHash: 'hash-old',
    });
  });
});

describe('getAcceptanceRubricVettingStatus refusal diagnostics', () => {
  // The defect this covers: the refusal reason used to be derived from the
  // SURVIVOR COUNT alone, so every cause below collapsed to the single string
  // 'missing-attestation' and named no card. Each row must now map to its OWN
  // rejection — if two rows ever agree, the collapse is back.
  it.each([
    ['rubric-unresolved', { rubricResolved: false }, "did not resolve"],
    ['incomplete-ratings', { missingKeys: ['criterion'] }, 'criterion'],
    ['synthesized', { synthesized: true }, 'synthesized floor card'],
    [
      'grading-audit-unsettled',
      {
        gradingAudit: {
          state: 'pending' as const,
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-09-08T00:01:00.000Z',
        },
      },
      "audit is 'pending'",
    ],
    ['no-critique-channel', { vetting: undefined }, 'no vetting linkage'],
  ] as const)('reports %s as its own rejection, naming the card', async (rejectedBy, over, detailFragment) => {
    const result = await getAcceptanceRubricVettingStatus(rubric, deps([card(over as Partial<ScorecardRow>)]));

    expect(result.satisfied).toBe(false);
    // Not 'missing-attestation': a card DOES exist, it was rejected.
    expect(result.reason).toBe('rejected-attestation');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ issueId: 'EI-vetting', rejectedBy });
    expect(result.candidates[0]!.detail).toContain(detailFragment);
    // The whole point: the one-line diagnosis names WHICH card and WHICH check.
    expect(result.diagnosis).toContain('EI-vetting');
    expect(result.diagnosis).toContain(rejectedBy);
  });

  it('distinguishes no card at all from a card that was rejected', async () => {
    const none = await getAcceptanceRubricVettingStatus(rubric, deps([]));
    expect(none).toMatchObject({ reason: 'missing-attestation', candidates: [], diagnosis: null });

    const rejected = await getAcceptanceRubricVettingStatus(rubric, deps([card({ synthesized: true })]));
    expect(rejected.reason).toBe('rejected-attestation');
    expect(rejected.diagnosis).not.toBeNull();
  });

  it('keeps a stale attestation distinct from a rejected one and dates the mismatch', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([card({ vetting: { consultId: 'consult-vetting', rubricRevision: 3, criteriaHash: 'hash-old' } })]),
    );

    expect(result.reason).toBe('stale-attestation');
    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'stale-revision', attestedRevision: 3 });
    expect(result.candidates[0]!.detail).toContain('revision 3');
    expect(result.candidates[0]!.detail).toContain('revision 4');
  });

  it('records the per-card verdict for every card, including the one that carried', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({ issueId: 'EI-good', createdAt: '2026-09-09T00:00:00.000Z' }),
        card({ issueId: 'EI-synth', createdAt: '2026-09-08T00:00:00.000Z', synthesized: true }),
      ]),
    );

    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('current');
    // Newest first, and the accepted card is reported alongside the rejected one
    // rather than being the only thing a reader can see.
    expect(result.candidates.map((c) => [c.issueId, c.rejectedBy])).toEqual([
      ['EI-good', null],
      ['EI-synth', 'synthesized'],
    ]);
    expect(result.diagnosis).toContain('EI-synth');
    expect(result.diagnosis).not.toContain('EI-good');
  });
});
