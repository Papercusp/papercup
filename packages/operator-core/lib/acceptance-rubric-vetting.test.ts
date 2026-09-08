import { describe, expect, it } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import { getAcceptanceRubricVettingStatus } from './acceptance-rubric-vetting';

const rubric = {
  rubricId: 'acceptance-plan',
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
    vetting: { consultId: 'consult-vetting', rubricRevision: 4 },
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
      attestedRevision: 4,
    });
  });
});
