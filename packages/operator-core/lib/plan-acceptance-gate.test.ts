/**
 * plan-acceptance-gate.test.ts — the plan-completion acceptance gate
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-005/P-008).
 *
 * Unit-level: every collaborator is mocked; the subject is the VERDICT logic —
 * flag gating, exemptions, missing/ungraded/self-graded refusals (each with its
 * teaching message), and the independent-grader satisfaction path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import { getAcceptanceRubricForPlan, type Rubric } from './rubrics';
import { listScorecards, type ScorecardRow } from './scorecards';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';

vi.mock('./rubrics', () => ({
  getAcceptanceRubricForPlan: vi.fn(),
  getRubric: vi.fn(),
  getRubricPlanRevision: vi.fn(),
  META_ACCEPTANCE_RUBRIC_ID: 'meta-acceptance-rubric',
}));
vi.mock('./scorecards', () => ({
  listScorecards: vi.fn(),
}));
vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// rubric-template self-registers into the template registry on import; keep the real
// module (it is dependency-free) so RUBRIC_TEMPLATE_NAME stays the real constant.

const mockRubric = vi.mocked(getAcceptanceRubricForPlan);
const mockScorecards = vi.mocked(listScorecards);
const mockFlag = vi.mocked(getFlag);
const mockPg = vi.mocked(getOrgPg);

/** A sql`` tag that resolves the same rows for any query. */
const sqlReturning = (rows: unknown[]) => {
  const sql = (() => Promise.resolve(rows)) as unknown as ReturnType<typeof getOrgPg>['sql'];
  return { sql } as ReturnType<typeof getOrgPg>;
};

const acceptanceRubric = (over: Partial<Rubric> = {}): Rubric => ({
  rubricId: 'ar-some-plan',
  workspaceId: 'test-ws',
  kind: 'acceptance',
  subjectPlan: 'some-plan-2026-08-11',
  characteristic: 'plan-acceptance',
  title: 'Acceptance: some plan',
  description: '',
  criteria: [{ key: 'k1', title: 'K1', model: '', method: '', driftMarkers: '' }],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-implementer',
  proposedBy: 'su-implementer',
  ratifiedBy: null,
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
  ...over,
});

const scorecard = (over: Partial<ScorecardRow> = {}): ScorecardRow => ({
  issueId: 'EI-1',
  createdAt: '2026-08-11T01:00:00Z',
  createdBy: 'su-grader',
  rubricRef: 'ar-some-plan',
  ratings: { k1: { rating: 'pass', evidence: 'verified live' } },
  nKeys: 1,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  score10: 10,
  linkedItems: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  // This suite exercises the acceptance-rubric family in isolation. The newer
  // code-truth gates have their own focused suite and deliberately run first in
  // production, so leave them disabled here unless a test opts in explicitly.
  mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
  // Default: the subject plan row exists and is a plain work plan (no exemption).
  mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null }]));
});

describe('evaluatePlanAcceptanceGate', () => {
  it('flag OFF → satisfied, skipped:flag-off (no rubric read at all)', async () => {
    mockFlag.mockResolvedValue(false);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockRubric).not.toHaveBeenCalled();
  });

  it('a rubric-template plan is exempt (no rubric-of-a-rubric)', async () => {
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'some-rubric', template: 'rubric', template_slug: null }]));
    const v = await evaluatePlanAcceptanceGate('some-rubric');
    expect(v).toMatchObject({ satisfied: true, skipped: 'rubric-template-plan' });
  });

  it('a scheduled template INSTANCE is exempt', async () => {
    mockPg.mockReturnValue(
      sqlReturning([{ plan_slug: 'run-2026-08-11', template: null, template_slug: 'daily-ops' }]),
    );
    const v = await evaluatePlanAcceptanceGate('run-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'template-instance' });
  });

  it('no acceptance rubric → acceptance_rubric_missing with the propose recipe', async () => {
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('acceptance_rubric_missing');
    expect(v.message).toContain("rubrics:propose { kind:'acceptance'");
    expect(v.message).toContain('some-plan-2026-08-11');
    expect(v.message).toContain('plan-class-investigation');
  });

  it('rubric present but ungraded → acceptance_ungraded naming the rubric + implementer', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_ungraded', rubricId: 'ar-some-plan' });
    expect(v.message).toContain('su-implementer');
    expect(v.message).toContain('scorecards:emit');
  });

  it('incomplete or synthesized scorecards do NOT satisfy (still acceptance_ungraded)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ missingKeys: ['k1'] }),
      scorecard({ synthesized: true }),
      scorecard({ rubricResolved: false }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
  });

  it('only self-graded → self_graded_only (grader ≠ implementer, D-005)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-implementer' })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'self_graded_only', rubricId: 'ar-some-plan' });
    expect(v.message).toContain('su-implementer');
  });

  it('an independent complete grading satisfies the gate and names the grader', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ createdBy: 'su-implementer' }),
      scorecard({ createdBy: 'su-grader' }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, rubricId: 'ar-some-plan', gradedBy: 'su-grader' });
  });

  it('flag read failure degrades toward ON (the gate still applies)', async () => {
    mockFlag.mockImplementation(async (flag) => {
      if (flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE) throw new Error('flags backend down');
      return false;
    });
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });

  it('exemption-read failure degrades toward NOT exempt (falls through to the rubric check)', async () => {
    mockPg.mockImplementation(() => {
      throw new Error('pg down');
    });
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });
});
