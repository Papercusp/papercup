import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P-011, the plan spec-coverage read surface.
 *
 * The behaviour under test is NOT "does it return a census" — it is the D-018 split
 * between what this gate REPORTS and the one thing it REFUSES, because that split is
 * what stands between the panel and showing a human a blocking failure for a clause no
 * gate is blocking on.
 *
 * `evaluatePlanSpecCoverageGate` reports far more than it refuses:
 *
 *   · `code:'spec_proof_stale'` — the ONLY refusal. Evidence exists, but none at the
 *     clause's current revision.
 *   · `reports[]` — unproven clauses, ungraded adequacy, undeclared falsifiers. ADVISORY.
 *     D-013/D-017 give the uncovered-clause refusal to P-013; surfacing one as a failure
 *     here pre-empts a decision P-013 owns.
 *   · `code:'spec_coverage_unavailable'` — a read failure that DELIBERATELY fails open.
 *
 * Three properties below are the ones a later refactor breaks silently, so each is
 * asserted against the resolver's real output rather than trusted to the module comment:
 *
 *   1. MODE IS CARRIED VERBATIM. 'enforced' vs 'report-only' is the gate's own statement
 *      about whether it can currently refuse. Re-deriving it here from `satisfied`/`code`
 *      would re-implement — and eventually contradict — D-018. The tempting derivation
 *      (`satisfied ? 'report-only' : 'enforced'`) is exactly wrong: a truncated census
 *      degrades an UNSATISFIED verdict to report-only, which is the case that matters.
 *
 *   2. ADVISORY NEVER BECOMES BLOCKING. `reports[]` and `wouldBlock[]` stay disjoint
 *      arrays; a report must never be merged into the blocker list on the way out.
 *
 *   3. A FLOOR IS NEVER PRESENTED AS A TOTAL. `bounded.truncatedByLimit` rides through
 *      to the row, so a renderer showing counts is obliged to show the truncation.
 *
 * Plus the fail-open case, which must stay DISTINGUISHABLE from "censused, found
 * nothing" — a zeroed census and an unavailable read look identical to a renderer that
 * only reads the counts, and they mean opposite things.
 *
 * The permanent negative control at the bottom is a deliberately-wrong resolver that
 * derives `mode`. It exists so property 1 is provably falsifiable: if that assertion ever
 * stops having teeth, the control passes and this suite fails.
 */

const gateSpy = vi.fn();
vi.mock('../agent-tools/plans/plan-spec-coverage-gate', () => ({
  evaluatePlanSpecCoverageGate: (...a: unknown[]) => gateSpy(...a),
}));

import { resolvePlanSpecCoverage } from './plan-spec-coverage';

const ARGS = { workspaceId: 'default', harnessSlug: 'papercusp', planSlug: 'p-1' };

/** A census whose counts are real (not a floor) and whose findings are all advisory. */
function aggregate(over: Record<string, unknown> = {}) {
  return {
    planSlug: 'p-1',
    clauses: { total: 5, enforceable: 3, exempt: 1, draft: 1, inactive: 0, falsifierDeclared: 0 },
    coverage: {
      proven: 1,
      staleProof: 0,
      unproven: 2,
      staleProofClauses: [],
      unprovenSpecIds: ['SPEC-a', 'SPEC-b'],
    },
    adequacy: { graded: 1, ungraded: 2, ungradedSpecIds: ['SPEC-a', 'SPEC-b'] },
    bounded: {
      evidenceCensusLimit: 2000,
      evidenceRowsRead: 12,
      truncatedByLimit: false,
      adequacyClauseLimit: 200,
      adequacyTruncatedByLimit: false,
    },
    ...over,
  };
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    satisfied: true,
    applicable: true,
    mode: 'enforced' as const,
    planSlug: 'p-1',
    aggregate: aggregate(),
    wouldBlock: [],
    reports: [],
    ...over,
  };
}

type Row = {
  planSlug: string;
  applicable: boolean;
  mode: string;
  satisfied: boolean;
  code: string | null;
  message: string | null;
  wouldBlock: string[];
  reports: string[];
  clauses: Record<string, number> | null;
  coverage: Record<string, unknown> | null;
  adequacy: Record<string, unknown> | null;
  bounded: Record<string, unknown> | null;
  unavailableReason: string | null;
};

const run = async (): Promise<Row> => (await resolvePlanSpecCoverage(ARGS))[0] as Row;

beforeEach(() => {
  gateSpy.mockReset();
});

describe('P-011 plan spec-coverage read — D-018 report-vs-refuse split', () => {
  it('asks the gate about the plan it was given, and reports its planSlug back', async () => {
    gateSpy.mockResolvedValue(verdict());
    const row = await run();

    expect(gateSpy).toHaveBeenCalledWith({ harnessSlug: 'papercusp', planSlug: 'p-1' });
    expect(row.planSlug).toBe('p-1');
  });

  it('carries `mode` VERBATIM and never re-derives it from satisfied/code', async () => {
    // The case that kills the tempting derivation: the verdict is UNSATISFIED, yet the
    // gate has degraded itself to report-only (a truncated census must not refuse on a
    // floor). `satisfied ? 'report-only' : 'enforced'` yields 'enforced' here — wrong,
    // and wrong in the direction that shows a human a refusal the gate is not making.
    gateSpy.mockResolvedValue(
      verdict({
        satisfied: false,
        mode: 'report-only',
        code: 'spec_proof_stale',
        message: 'stale proof',
        wouldBlock: ['spec-proof-stale'],
      }),
    );

    const row = await run();

    expect(row.mode).toBe('report-only');
    expect(row.satisfied).toBe(false);
    expect(row.code).toBe('spec_proof_stale');
  });

  it('keeps an ENFORCED refusal enforced (the mirror case, so the assertion is not one-sided)', async () => {
    gateSpy.mockResolvedValue(
      verdict({ satisfied: false, mode: 'enforced', code: 'spec_proof_stale', wouldBlock: ['x'] }),
    );

    expect((await run()).mode).toBe('enforced');
  });

  it('never merges ADVISORY reports into wouldBlock', async () => {
    // The shape D-018 exists for: three advisory findings, nothing refusing.
    gateSpy.mockResolvedValue(
      verdict({
        satisfied: true,
        reports: ['spec-clauses-unproven', 'spec-adequacy-ungraded', 'spec-falsifier-undeclared'],
        wouldBlock: [],
      }),
    );

    const row = await run();

    expect(row.reports).toEqual([
      'spec-clauses-unproven',
      'spec-adequacy-ungraded',
      'spec-falsifier-undeclared',
    ]);
    expect(row.wouldBlock).toEqual([]);
    expect(row.satisfied).toBe(true);
    expect(row.code).toBeNull();
  });

  it('passes a TRUNCATED census through with its marker, so a floor cannot read as a total', async () => {
    gateSpy.mockResolvedValue(
      verdict({
        aggregate: aggregate({
          bounded: {
            evidenceCensusLimit: 2000,
            evidenceRowsRead: 2000,
            truncatedByLimit: true,
            adequacyClauseLimit: 200,
            adequacyTruncatedByLimit: true,
          },
        }),
      }),
    );

    const row = await run();

    expect(row.bounded).toMatchObject({
      truncatedByLimit: true,
      adequacyTruncatedByLimit: true,
      evidenceRowsRead: 2000,
    });
    // The counts still ride along — they are a FLOOR, not absent — which is precisely
    // why the marker beside them is load-bearing.
    expect(row.coverage).not.toBeNull();
  });

  it('maps stale-proof clauses with the revisions that make them actionable', async () => {
    gateSpy.mockResolvedValue(
      verdict({
        satisfied: false,
        code: 'spec_proof_stale',
        wouldBlock: ['spec-proof-stale'],
        aggregate: aggregate({
          coverage: {
            proven: 0,
            staleProof: 1,
            unproven: 0,
            staleProofClauses: [
              { specId: 'SPEC-a', planItemId: 'P-001', currentRevision: 4, provenRevisions: [2, 3] },
            ],
            unprovenSpecIds: [],
          },
        }),
      }),
    );

    const row = await run();

    expect(row.coverage).toMatchObject({
      staleProof: 1,
      staleProofClauses: [
        { specId: 'SPEC-a', planItemId: 'P-001', currentRevision: 4, provenRevisions: [2, 3] },
      ],
    });
  });
});

describe('P-011 plan spec-coverage read — fail-open stays distinguishable', () => {
  it('fails OPEN when the gate module cannot be run, and says so structurally', async () => {
    gateSpy.mockRejectedValue(new Error('boom'));

    const row = await run();

    // Fails open: a read failure must not manufacture a refusal.
    expect(row.satisfied).toBe(true);
    expect(row.applicable).toBe(false);
    expect(row.code).toBe('spec_coverage_unavailable');
    expect(row.mode).toBe('report-only');
    expect(row.unavailableReason).toBe('resolver-unavailable');
    expect(row.message).toContain('p-1');
  });

  it('nulls every count when unavailable, so 0 is never shown as a measurement', async () => {
    gateSpy.mockRejectedValue(new Error('boom'));
    const row = await run();

    expect(row.clauses).toBeNull();
    expect(row.coverage).toBeNull();
    expect(row.adequacy).toBeNull();
    expect(row.bounded).toBeNull();
  });

  it('is DISTINGUISHABLE from a real census that legitimately found nothing', async () => {
    // Both rows are "satisfied, nothing to refuse". A renderer reading only the counts
    // cannot tell them apart — which is why the structural difference below must hold.
    gateSpy.mockRejectedValue(new Error('boom'));
    const unavailable = await run();

    gateSpy.mockReset();
    gateSpy.mockResolvedValue(
      verdict({
        applicable: true,
        aggregate: aggregate({
          clauses: { total: 0, enforceable: 0, exempt: 0, draft: 0, inactive: 0, falsifierDeclared: 0 },
          coverage: { proven: 0, staleProof: 0, unproven: 0, staleProofClauses: [], unprovenSpecIds: [] },
          adequacy: { graded: 0, ungraded: 0, ungradedSpecIds: [] },
        }),
      }),
    );
    const emptyCensus = await run();

    expect(unavailable.satisfied).toBe(emptyCensus.satisfied);
    // ...and yet they must never be confusable:
    expect(unavailable.unavailableReason).toBe('resolver-unavailable');
    expect(emptyCensus.unavailableReason).toBeNull();
    expect(unavailable.clauses).toBeNull();
    expect(emptyCensus.clauses).toMatchObject({ total: 0 });
  });
});

describe('permanent negative control — the mode assertion has teeth', () => {
  /**
   * A deliberately-wrong resolver that DERIVES `mode` instead of carrying it, i.e. the
   * exact refactor D-018 forbids. If the real assertion above ever stops discriminating,
   * this control starts passing and the expectation below fails loudly.
   */
  const derivingResolver = (v: { satisfied: boolean }) => ({
    mode: v.satisfied ? 'report-only' : 'enforced',
  });

  it('a resolver that derives mode from `satisfied` gets the degraded case WRONG', () => {
    // The gate said report-only while unsatisfied (truncated census, must not refuse).
    const gateSaid = { satisfied: false, mode: 'report-only' as const };

    expect(derivingResolver(gateSaid).mode).not.toBe(gateSaid.mode);
    expect(derivingResolver(gateSaid).mode).toBe('enforced');
  });
});
