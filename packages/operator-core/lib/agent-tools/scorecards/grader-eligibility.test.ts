/**
 * grader-eligibility.test.ts — resolveAggregatedVettingCritics /
 * resolveAcceptanceGraderEligibility's sole-vetting-critic rail
 * (EI-22182364716054326).
 *
 * Unit-level: `listScorecards` / `readRubricPlanRevision` / the lineage
 * predicate are mocked. The subject is the critic-population READ the
 * sole-vetting-critic rail acts on — it must UNION critics recorded across
 * EVERY current-revision vetting attestation (both the consult channel and
 * the work-item channel), not just whichever ONE matching card a `.find()`
 * happened to return first. Before this fix, a rubric vetted twice — once per
 * channel, by two genuinely independent critics — was judged sole-critic
 * because only one channel's attestation was ever read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listScorecards = vi.fn();
const readRubricPlanRevision = vi.fn();
const lineageRelated = vi.fn();
const sameAcceptanceAuthor = vi.fn();
const resolvePlanImplementerIdentities = vi.fn();

vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return { ...real, readRubricPlanRevision: (...a: unknown[]) => readRubricPlanRevision(...a) };
});
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: (...a: unknown[]) => sameAcceptanceAuthor(...a),
  areAcceptanceLineageRelated: (...a: unknown[]) => lineageRelated(...a),
  resolvePlanImplementerIdentities: (...a: unknown[]) => resolvePlanImplementerIdentities(...a),
}));

import { resolveAcceptanceGraderEligibility, resolveAggregatedVettingCritics } from './grader-eligibility';

const RUBRIC = {
  rubricId: 'ar-some-plan',
  status: 'active',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  subjectPlan: 'some-plan-2026-08-11',
};

/** A minimal vetting scorecard row, shaped like `ScorecardRow`. */
const vettingCard = (over: Record<string, unknown> = {}) => ({
  issueId: 'EI-vetting',
  createdAt: '2026-09-02T00:00:00Z',
  createdBy: 'su-x',
  rubricRef: 'meta-acceptance-rubric',
  ratings: {},
  nKeys: 0,
  missingKeys: [] as string[],
  extraKeys: [] as string[],
  rubricResolved: true,
  synthesized: false,
  score10: null,
  linkedItems: [],
  ...over,
});

beforeEach(() => {
  listScorecards.mockReset().mockResolvedValue([]);
  readRubricPlanRevision.mockReset().mockResolvedValue({ ok: true, revision: 7 });
  sameAcceptanceAuthor.mockReset().mockImplementation(async (a: unknown, b: unknown) => a === b);
  lineageRelated.mockReset().mockImplementation(async (a: unknown, b: unknown) => a === b);
  resolvePlanImplementerIdentities.mockReset().mockResolvedValue([]);
});

describe('resolveAggregatedVettingCritics (EI-22182364716054326)', () => {
  it('unions critics across a consult-channel card and a work-item-channel card at the same revision', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({
        vetting: { consultId: 'conv-1', rubricRevision: 7, critiquePosts: 2, critics: ['su-reviewer-a'] },
      }),
      vettingCard({
        vetting: { workItemId: 'WI-review', rubricRevision: 7, critiquePosts: 1, critics: ['su-reviewer-b'] },
      }),
    ]);
    const { critics, cardsConsidered } = await resolveAggregatedVettingCritics('ar-some-plan', 7);
    expect(cardsConsidered).toBe(2);
    expect([...critics].sort()).toEqual(['su-reviewer-a', 'su-reviewer-b']);
  });

  it('dedupes a critic recorded on both channels and excludes stale-revision, synthesized, and unresolved cards', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: ['su-reviewer-a'] } }),
      vettingCard({
        vetting: { workItemId: 'WI-review', rubricRevision: 7, critics: ['su-reviewer-a', 'su-reviewer-b'] },
      }),
      // Stale revision — must not count toward the CURRENT vetting population.
      vettingCard({ vetting: { consultId: 'conv-stale', rubricRevision: 6, critics: ['su-reviewer-c'] } }),
      // Synthesized floor cards are not a real critique.
      vettingCard({ synthesized: true, vetting: { consultId: 'conv-synth', rubricRevision: 7, critics: ['su-reviewer-d'] } }),
      // Unresolved rubric — missingKeys/rubricResolved say this card cannot be trusted as vetting evidence.
      vettingCard({ rubricResolved: false, vetting: { consultId: 'conv-unresolved', rubricRevision: 7, critics: ['su-reviewer-e'] } }),
    ]);
    const { critics } = await resolveAggregatedVettingCritics('ar-some-plan', 7);
    expect([...critics].sort()).toEqual(['su-reviewer-a', 'su-reviewer-b']);
  });

  it('returns no critics when no vetting card names one', async () => {
    listScorecards.mockResolvedValue([vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: [] } })]);
    const { critics, cardsConsidered } = await resolveAggregatedVettingCritics('ar-some-plan', 7);
    expect(cardsConsidered).toBe(1);
    expect(critics).toEqual([]);
  });

  it('reuses critics across revision-only changes when the criteria hash is unchanged', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({
        vetting: {
          consultId: 'conv-1',
          rubricRevision: 6,
          criteriaHash: 'hash-current',
          critics: ['su-reviewer-a'],
        },
      }),
    ]);

    const result = await resolveAggregatedVettingCritics('ar-some-plan', 7, 'hash-current');
    expect(result).toEqual({ critics: ['su-reviewer-a'], cardsConsidered: 1 });
  });

  it('excludes a same-revision vetting card whose criteria hash is stale', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({
        vetting: {
          consultId: 'conv-1',
          rubricRevision: 7,
          criteriaHash: 'hash-old',
          critics: ['su-reviewer-a'],
        },
      }),
    ]);

    const result = await resolveAggregatedVettingCritics('ar-some-plan', 7, 'hash-current');
    expect(result).toEqual({ critics: [], cardsConsidered: 0 });
  });
});

describe('resolveAcceptanceGraderEligibility sole-vetting-critic rail (EI-22182364716054326)', () => {
  it('does NOT refuse a critic when a second, independent critic vetted through the OTHER channel', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: ['su-reviewer-a'] } }),
      vettingCard({ vetting: { workItemId: 'WI-review', rubricRevision: 7, critics: ['su-reviewer-b'] } }),
    ]);

    const forA = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-reviewer-a',
      workspaceId: 'ws-test',
    });
    expect(forA.refusal).toBeNull();

    const forB = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-reviewer-b',
      workspaceId: 'ws-test',
    });
    expect(forB.refusal).toBeNull();
  });

  it('CONTROL: still refuses the sole critic when only ONE channel recorded vetting', async () => {
    listScorecards.mockResolvedValue([
      vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: ['su-reviewer-a'] } }),
    ]);
    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-reviewer-a',
      workspaceId: 'ws-test',
    });
    expect(result.refusal?.code).toBe('grader_is_sole_vetting_critic');
    expect(result.refusal?.error).toContain('second genuinely independent critic');
    expect(result.refusal?.error).toContain('other supported vetting channel (consult or work-item)');
    expect(result.refusal?.error).toContain('current rubric revision');
  });

  it('CONTROL (regression guard): two channel attestations that resolve to ONE lineage are still refused', async () => {
    // Two channels does not by itself mean two INDEPENDENT parties — if both
    // recorded critics resolve to the same lineage as the candidate grader,
    // the fix must not have widened the rail into a free pass. Scoped to leave
    // the EARLIER implementer-lineage check (su-author vs the caller) untouched,
    // so this exercises the sole-vetting-critic rail specifically rather than
    // tripping the unrelated grader_in_implementer_lineage refusal first.
    lineageRelated.mockImplementation(async (a: unknown, b: unknown) => {
      if (a === 'su-author' || b === 'su-author') return a === b;
      return true;
    });
    listScorecards.mockResolvedValue([
      vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: ['su-reviewer-a'] } }),
      vettingCard({ vetting: { workItemId: 'WI-review', rubricRevision: 7, critics: ['su-reviewer-a-rebound'] } }),
    ]);
    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-reviewer-a',
      workspaceId: 'ws-test',
    });
    expect(result.refusal?.code).toBe('grader_is_sole_vetting_critic');
  });
});

describe('principal plan implementers are independent-grader exclusions', () => {
  it('refuses a plan implementer while keeping the rubric author as the acceptance seat', async () => {
    resolvePlanImplementerIdentities.mockResolvedValue(['su-plan-implementer']);

    const grading = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-plan-implementer',
      workspaceId: 'ws-test',
    });
    expect(grading).toMatchObject({
      implementer: 'su-author',
      principalImplementers: ['su-plan-implementer'],
      callerIsImplementer: false,
      refusal: { code: 'grader_in_implementer_lineage' },
    });

    const acceptance = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-author',
      workspaceId: 'ws-test',
      intent: 'acceptance',
    });
    expect(acceptance).toMatchObject({
      implementer: 'su-author',
      principalImplementers: ['su-plan-implementer'],
      callerIsImplementer: true,
      refusal: null,
    });
  });

  it('excludes a grader in a principal implementer lineage, not only the author lineage', async () => {
    resolvePlanImplementerIdentities.mockResolvedValue(['su-plan-implementer']);
    lineageRelated.mockImplementation(
      async (a: unknown, b: unknown) =>
        a === b || (a === 'su-plan-implementer' && b === 'su-plan-successor'),
    );

    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-plan-successor',
      workspaceId: 'ws-test',
    });
    expect(result.refusal?.code).toBe('grader_in_implementer_lineage');
    expect(result.refusal?.error).toContain("plan implementer 'su-plan-implementer'");
  });
});

describe('grader_in_implementer_lineage remedy text (EI-22268985547402093)', () => {
  /**
   * The refusal message is the ONE surface where a blocked author learns how to
   * route the grading, so a wrong remedy there is not cosmetic — it is executed.
   * It used to advise "use an unassigned grading work-item for scheduler pull",
   * which admission screening refuses for a promoter-tick window; WI-2142286 and
   * WI-2140951 both followed that advice into open-for-40h+ strands. The working
   * route is `assign_to` + `bypass:explicit-assignment` (live since 2026-08-31),
   * which is born-admitted and claimable by the named grader in the same write.
   */
  const remedy = async () => {
    lineageRelated.mockResolvedValue(true);
    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-launched-by-author',
      workspaceId: 'ws-test',
    });
    expect(result.refusal?.code).toBe('grader_in_implementer_lineage');
    return result.refusal?.error ?? '';
  };

  it('names the assign_to / explicit-assignment route that actually admits the item', async () => {
    const error = await remedy();
    expect(error).toContain('assign_to');
    expect(error).toContain('bypass:explicit-assignment');
  });

  it('CONTROL: does NOT recommend filing the grading request unassigned for scheduler pull', async () => {
    const error = await remedy();
    expect(error).not.toMatch(/unassigned grading work-item for scheduler pull/);
    expect(error).toMatch(/Do NOT file it unassigned/);
  });
});

/**
 * R-5 / P-005 of plan `bar-reporting-layer-repairs-2026-09-07`.
 *
 * `grader_is_sole_vetting_critic` and `bar_snapshot_vetting_stale` read as a
 * two-party deadlock: vet first and you are the sole critic, grade first and
 * there is no attestation. It is NOT a deadlock — the axis is independence,
 * not ordering — but the escape (a second INDEPENDENT critic at the current
 * revision, recorded on the OTHER vetting channel) lived only in
 * `resolveAggregatedVettingCritics` and in no document.
 *
 * That mattered because of WHEN this refusal lands: at the END of the ceremony,
 * after implementation, audit and rubric authoring are all paid for. So the
 * clause's falsifier is satisfied only if the route is in BOTH places — this
 * block covers the refusal payload; the documentation half is pinned in
 * `doc-claims/acceptance-vetting-escape-route.test.ts`.
 */
describe('grader_is_sole_vetting_critic carries the escape route (R-5 / P-005)', () => {
  const soleCriticRefusal = async () => {
    listScorecards.mockResolvedValue([
      vettingCard({ vetting: { consultId: 'conv-1', rubricRevision: 7, critics: ['su-reviewer-a'] } }),
    ]);
    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-reviewer-a',
      workspaceId: 'ws-test',
    });
    expect(result.refusal?.code).toBe('grader_is_sole_vetting_critic');
    return result.refusal!;
  };

  it('states the second-independent-critic route as a structured remedy', async () => {
    const { remedy } = await soleCriticRefusal();

    expect(remedy?.summary).toMatch(/SECOND vetting critic/i);
    expect(remedy?.summary).toMatch(/independent/i);
    // The refusal must say the SAME grader becomes eligible — otherwise the honest
    // reading stays "hand this plan to someone else", which is the expensive one.
    expect(remedy?.summary).toMatch(/this same grader becomes eligible/i);
  });

  it('gives executable steps naming the other channel and the current revision', async () => {
    const steps = (await soleCriticRefusal()).remedy?.steps ?? [];

    expect(steps.length).toBeGreaterThan(0);
    const joined = steps.join('\n');
    expect(joined).toContain('coord:presence');
    expect(joined).toMatch(/vettingConsult \/ vettingWorkItem/);
    expect(joined).toMatch(/CURRENT revision/i);
    expect(joined).toContain('meta-acceptance-rubric');
  });

  it('names the three routes that LOOK like the escape and are not', async () => {
    const doesNotWork = (await soleCriticRefusal()).remedy?.doesNotWork ?? [];
    const joined = doesNotWork.join('\n');

    // Each of these is a plausible next move that costs a full cycle to disprove.
    expect(joined).toMatch(/lineage/i); // a second critic who is really the same party
    expect(joined).toMatch(/bar_snapshot_vetting_(missing|stale)/); // grading first to change the order
    expect(joined).toMatch(/newer revision/i); // re-vetting yourself
  });

  it('points at the agent-facing runbook rather than at the source file', async () => {
    const { remedy } = await soleCriticRefusal();

    expect(remedy?.docRef).toBe('agent-insights/acceptance-rubric-vetting');
  });

  it('CONTROL: the sibling implementer-lineage refusal does NOT carry this remedy', async () => {
    // Falsifiability. If a remedy were attached to every refusal, or defaulted onto
    // the type, every assertion above would pass while proving nothing about THIS
    // code path. `grader_in_implementer_lineage` carries its route in `error` prose
    // (asserted in the block above) and no structured `remedy`.
    lineageRelated.mockResolvedValue(true);
    const result = await resolveAcceptanceGraderEligibility({
      rubric: RUBRIC,
      callerId: 'su-launched-by-author',
      workspaceId: 'ws-test',
    });

    expect(result.refusal?.code).toBe('grader_in_implementer_lineage');
    expect(result.refusal?.remedy).toBeUndefined();
  });
});
