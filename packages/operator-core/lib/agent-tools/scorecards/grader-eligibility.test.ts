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
}));

import { resolveAcceptanceGraderEligibility, resolveAggregatedVettingCritics } from './grader-eligibility';

const RUBRIC = { rubricId: 'ar-some-plan', status: 'active', createdBy: 'su-author', proposedBy: 'su-author' };

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
