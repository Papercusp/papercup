/**
 * plan-acceptance-gate.test.ts — the plan-completion acceptance gate
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-005/P-008).
 *
 * Unit-level: every collaborator is mocked; the subject is the VERDICT logic —
 * flag gating, exemptions, missing/ungraded/self-graded refusals (each with its
 * teaching message), and the independent-grader satisfaction path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCEPTANCE_VERDICT_REQUIRED_AFTER, evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import { getAcceptanceRubricForPlan, getRubric, getRubricPlanRevision, type Rubric } from './rubrics';
import { listScorecards, type ScorecardRow } from './scorecards';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { isAcceptanceAuthorIdentity } from './acceptance-author-identity';
import {
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageGateVerdict,
} from './agent-tools/plans/plan-spec-coverage-gate';

vi.mock('./rubrics', () => ({
  getAcceptanceRubricForPlan: vi.fn(),
  getRubric: vi.fn(),
  getRubricPlanRevision: vi.fn(),
  META_ACCEPTANCE_RUBRIC_ID: 'meta-acceptance-rubric',
}));
vi.mock('./scorecards', () => ({
  listScorecards: vi.fn(),
}));
vi.mock('./acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
}));
vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// P-008's spec-coverage census is mocked here on purpose: this suite's subject is the
// WIRING (does the acceptance gate refuse, waive under force, and carry the aggregate),
// not the census itself — that has its own suite next to the module.
vi.mock('./agent-tools/plans/plan-spec-coverage-gate', () => ({
  evaluatePlanSpecCoverageGate: vi.fn(),
}));
// rubric-template self-registers into the template registry on import; keep the real
// module (it is dependency-free) so RUBRIC_TEMPLATE_NAME stays the real constant.

const mockRubric = vi.mocked(getAcceptanceRubricForPlan);
const mockGetRubric = vi.mocked(getRubric);
const mockRevision = vi.mocked(getRubricPlanRevision);
const mockScorecards = vi.mocked(listScorecards);
const mockFlag = vi.mocked(getFlag);
const mockPg = vi.mocked(getOrgPg);
const mockAuthorIdentity = vi.mocked(isAcceptanceAuthorIdentity);
const mockSpecCoverage = vi.mocked(evaluatePlanSpecCoverageGate);

const coverageVerdict = (over: Partial<PlanSpecCoverageGateVerdict> = {}): PlanSpecCoverageGateVerdict => ({
  satisfied: true,
  applicable: true,
  mode: 'enforced',
  planSlug: 'some-plan-2026-08-11',
  aggregate: null,
  wouldBlock: [],
  reports: [],
  ...over,
});

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
  mockAuthorIdentity.mockImplementation(async (author, candidate) => author === candidate);
  // This suite exercises the acceptance-rubric family in isolation. The newer
  // code-truth gates have their own focused suite and deliberately run first in
  // production, so leave them disabled here unless a test opts in explicitly.
  mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
  // Safe default so a suite that never opts the P-008 flag in cannot trip over an
  // unstubbed mock if the flag mapping above is ever widened.
  mockSpecCoverage.mockResolvedValue(coverageVerdict());
  // Default: the subject plan row exists and is a plain work plan (no exemption).
  mockPg.mockReturnValue(
    sqlReturning([{ plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null, content: null }]),
  );
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
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'run-2026-08-11', template: null, template_slug: 'daily-ops' }]));
    const v = await evaluatePlanAcceptanceGate('run-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'template-instance' });
  });

  it('refuses an ephemeral deliverable reference without a durable companion', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content: '## Now\n\nReport: https://claude.ai/code/artifact/abc123',
        },
      ]),
    );

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'ephemeral_deliverable_unbacked' });
    expect(v.message).toContain('claude.ai/code/artifact/abc123');
    expect(v.message).toContain('durable companion/source reference');
    expect(v.message).toContain('not waived by');
  });

  it('allows an ephemeral URL when the plan records its durable source path', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content:
            'Report: https://claude.ai/code/artifact/abc123\nDurable source: `packages/reports/retraction-log.md`',
        },
      ]),
    );
    mockRubric.mockResolvedValue(null);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });

  it('does not let the code-truth force escape hatch bypass deliverable durability', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content: 'Report: https://claude.ai/artifacts/abc123',
        },
      ]),
    );

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { force: { reason: 'owner waiver' } });
    expect(v).toMatchObject({ satisfied: false, code: 'ephemeral_deliverable_unbacked' });
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

  it('a new independent grading without an implementer verdict refuses acceptance_not_recorded', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_not_recorded',
      rubricId: 'ar-some-plan',
      gradedBy: 'su-grader',
    });
    expect(v.message).toContain("acceptance:{ verdict:'accept'|'reject'");
  });

  it('a post-grading implementer accept satisfies and a newer reject refuses', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    const independent = scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' });
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
      }),
      independent,
    ]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });

    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-reject',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'reject', reasoning: 'The regression evidence remains unresolved.' },
      }),
      independent,
    ]);
    const rejected = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(rejected).toMatchObject({ satisfied: false, code: 'acceptance_rejected' });
    expect(rejected.message).toContain('regression evidence remains unresolved');
  });

  it('accepts an audited successor verdict but never counts that successor as the independent grader', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockAuthorIdentity.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    const successorVerdict = scorecard({
      issueId: 'EI-successor-accept',
      createdAt: '2026-08-21T02:00:00Z',
      createdBy: 'su-successor',
      acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
    });
    mockScorecards.mockResolvedValue([
      successorVerdict,
      scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
    ]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });

    mockScorecards.mockResolvedValue([successorVerdict]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: false,
      code: 'self_graded_only',
    });
  });

  it('an implementer verdict filed before independent grading does not count', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ createdAt: '2026-08-21T03:00:00Z', createdBy: 'su-grader' }),
      scorecard({
        issueId: 'EI-early-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'Filed before the independent card.' },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_not_recorded' });
  });

  it('a newer independent grading invalidates an older accept and legacy grading', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-new-grading',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-new-grader',
      }),
      scorecard({
        issueId: 'EI-old-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The earlier grading met the plan.' },
      }),
      scorecard({
        issueId: 'EI-legacy-grading',
        createdAt: '2026-08-11T01:00:00Z',
        createdBy: 'su-old-grader',
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_not_recorded',
      gradedBy: 'su-new-grader',
    });
  });

  it('grandfathers complete independent gradings created before the rollout boundary', async () => {
    expect(Date.parse(scorecard().createdAt)).toBeLessThan(Date.parse(ACCEPTANCE_VERDICT_REQUIRED_AFTER));
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-grader', acceptance: undefined })]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });
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

describe('the vetting check (consult-min-max-and-rubric-vetting-2026-08-17 P-004)', () => {
  /** A complete vetting scorecard: meta-rubric grading of the acceptance rubric,
   *  self-emitted by the AUTHOR (self-vetting is the design — the external critique
   *  comes from the linked consult, not from grader independence). */
  const metaVettingCard = (over: Partial<ScorecardRow> = {}): ScorecardRow =>
    scorecard({
      issueId: 'EI-vet',
      rubricRef: 'meta-acceptance-rubric',
      createdBy: 'su-implementer',
      subject: { kind: 'rubric', ref: 'ar-some-plan' },
      vetting: { consultId: 'conv-vet-1', rubricRevision: 7 },
      ...over,
    });

  /** Scorecard store split by rubric: meta cards for the meta-rubric read, an
   *  independent complete acceptance grading for everything else (so the ONLY
   *  variable under test is the vetting state). */
  const stockScorecards = (metaCards: ScorecardRow[], acceptanceCards?: ScorecardRow[]) => {
    mockScorecards.mockImplementation(async (filter?: { rubricRef?: string }) =>
      filter?.rubricRef === 'meta-acceptance-rubric'
        ? metaCards
        : (acceptanceCards ?? [scorecard({ createdBy: 'su-grader' })]),
    );
  };

  beforeEach(() => {
    mockFlag.mockImplementation(
      async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE,
    );
    mockRubric.mockResolvedValue(acceptanceRubric());
    // The meta-rubric is REGISTERED but deliberately still 'proposed': the gate must
    // tolerate it (ratification governs content authority, not gate mechanics) or the
    // whole ship gate deadlocks on the owner's ratification.
    mockGetRubric.mockResolvedValue(
      acceptanceRubric({ rubricId: 'meta-acceptance-rubric', kind: 'standard', subjectPlan: null, status: 'proposed' }),
    );
    mockRevision.mockResolvedValue(7);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null }]));
  });

  it('refuses acceptance_rubric_unvetted when no meta-scorecard exists — even with an independent acceptance grading already filed', async () => {
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted', rubricId: 'ar-some-plan' });
    // The refusal is the teaching surface: it must name the full flow.
    expect(v.message).toContain('vettingConsult');
    expect(v.message).toContain('meta-acceptance-rubric');
    expect(v.message).toContain('consult:get_feedback');
  });

  it('a plain meta-grade WITHOUT the linked consult does not satisfy — the consult is what makes an attestation a vetting', async () => {
    stockScorecards([metaVettingCard({ vetting: undefined })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('a vetting pinned to an OLDER revision refuses, naming both revisions', async () => {
    stockScorecards([metaVettingCard({ vetting: { consultId: 'conv-vet-1', rubricRevision: 6 } })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
    expect(v.message).toContain('revision 6');
    expect(v.message).toContain('revision 7');
  });

  it('a current-revision vetting with a linked consult satisfies (meta-rubric still proposed — tolerance proven)', async () => {
    stockScorecards([metaVettingCard()]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, rubricId: 'ar-some-plan', gradedBy: 'su-grader' });
  });

  it('CONTROL (falsifiability, in-test — no tree mutation): the vetting stamp ALONE flips the verdict', async () => {
    // Identical state twice; the only delta is the stamp. If the check were vacuous
    // (or wired to the wrong field), both runs would agree and this control fails.
    stockScorecards([metaVettingCard()]);
    const withStamp = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    stockScorecards([metaVettingCard({ vetting: undefined })]);
    const withoutStamp = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(withStamp.satisfied).toBe(true);
    expect(withoutStamp).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('synthesized or incomplete meta-cards never count as a vetting', async () => {
    stockScorecards([
      metaVettingCard({ synthesized: true }),
      metaVettingCard({ issueId: 'EI-vet-2', missingKeys: ['k2'] }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('a criteria:[] investigation rubric is exempt from vetting (D-009 — nothing to vet)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric({ criteria: [], classRef: 'plan-class-investigation' }));
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.code).toBeUndefined();
  });

  it('no registered meta-rubric ⇒ the check disables rather than deadlocking every ship', async () => {
    mockGetRubric.mockResolvedValue(null);
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
  });

  it('vetting flag OFF ⇒ the sibling rubric checks run unchanged and no vetting is demanded', async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
  });

  it('an unreadable current revision degrades OPEN: any linked vetting satisfies (never throws, never deadlocks)', async () => {
    mockRevision.mockResolvedValue(null);
    stockScorecards([metaVettingCard({ vetting: { consultId: 'conv-vet-1', rubricRevision: 3 } })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
  });

  // EI-20821478338037350: a rubric vetted under an explicit no-critique waiver still
  // ships, but the verdict must SAY so — same posture as `forcedPast`, whose whole
  // point is that a waiver which is easy to hide is worth very little.
  it('a vetting stamped `unanswered` still satisfies, but reports vettedUnderWaiver', async () => {
    stockScorecards([
      metaVettingCard({
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 0,
          unanswered: true,
          unansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
        },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: true,
      vettedUnderWaiver: {
        consultId: 'conv-vet-1',
        reason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
      },
    });
  });

  it('CONTROL: a genuinely critiqued vetting satisfies with NO vettedUnderWaiver marker', async () => {
    // Without this, a `vettedUnderWaiver` hard-wired on would pass the test above.
    stockScorecards([
      metaVettingCard({
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-reviewer'] },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.vettedUnderWaiver).toBeUndefined();
  });
});

/**
 * The spec-proof check (first-class-spec-clauses-…-2026-08-20 P-008).
 *
 * The census itself is proven in plan-spec-coverage-gate.test.ts. What is asserted here
 * is only what the WIRING promises: the refusal reaches the caller, `force` waives it
 * like its code-truth siblings, the aggregate rides along on the satisfied verdict so a
 * successful ship still exposes what was proven, and the check sits ahead of rubric
 * ceremony.
 */
describe('the spec-proof check (first-class-spec-clauses-2026-08-20 P-008)', () => {
  const staleVerdict = coverageVerdict({
    satisfied: false,
    code: 'spec_proof_stale',
    wouldBlock: ['1-clause(s)-proven-only-at-a-superseded-revision'],
    message: "plan 'some-plan-2026-08-11' cannot be marked shipped: SPEC-1 (proof at r1, clause now r2)",
  });

  beforeEach(() => {
    mockFlag.mockImplementation(
      async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
    );
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-implementer' }), scorecard({ createdBy: 'su-grader' })]);
  });

  it('a stale spec proof refuses the ship and carries the aggregate verdict', async () => {
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'spec_proof_stale' });
    expect(v.message).toContain('SPEC-1');
    expect(v.specCoverage).toMatchObject({ code: 'spec_proof_stale', satisfied: false });
  });

  it('refuses BEFORE rubric ceremony — a plan with no rubric at all is still sent to re-prove', async () => {
    // Ordering guard: refusing acceptance_rubric_missing here would send the agent to
    // author a rubric for promises that are no longer proven.
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.code).toBe('spec_proof_stale');
  });

  it('an explicit reasoned force waives it like its code-truth siblings, and records the waiver', async () => {
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
      force: { reason: 'clause reworded only; behaviour unchanged and re-verified by hand' },
    });
    expect(v.satisfied).toBe(true);
    expect(v.forcedPast?.checks).toContain('spec_proof_stale');
    expect(v.forcedPast?.reason).toContain('behaviour unchanged');
  });

  it('a satisfied ship still carries the coverage aggregate (advisory reports included)', async () => {
    mockSpecCoverage.mockResolvedValue(
      coverageVerdict({ reports: ['2-enforceable-clause(s)-with-no-evidence'] }),
    );
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    // Reported, NOT refused — an uncovered clause is P-013's to enforce (D-018).
    expect(v.code).toBeUndefined();
    expect(v.specCoverage?.reports).toEqual(['2-enforceable-clause(s)-with-no-evidence']);
  });

  it('CONTROL: with the P-008 flag OFF the census is never read and the ship is unaffected', async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.specCoverage).toBeUndefined();
    expect(mockSpecCoverage).not.toHaveBeenCalled();
  });
});
