/**
 * plan-spec-coverage-gate.test.ts — the plan-ship spec-coverage aggregate and the
 * proof-freshness refusal
 * (first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-008).
 *
 * The headline case is P-008's own acceptance sentence, and it is asserted in BOTH
 * directions in one test: a spec revision recorded after green evidence BLOCKS
 * shipping, and re-proving at the current revision UNBLOCKS it. Asserting only the
 * refusal would leave "until current proof exists" unproven, which is the half that
 * makes the gate escapable rather than a wall.
 *
 * Two further tests are deliberate SCOPE guards rather than behaviour coverage. They
 * pin the boundaries this gate was built inside, so a later widening has to be a
 * deliberate act that updates a test naming the ruling, not a quiet edit:
 *   · "REPORTS an enforceable clause with no evidence without refusing" — D-018/D-013
 *     leave enforcement widening to P-013.
 *   · "withholds the refusal when the evidence census is truncated" — the repo's
 *     bounded-measurement rule; a floor must never be rendered as a verdict.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ADEQUACY_CENSUS_CLAUSE_LIMIT,
  SPEC_EVIDENCE_CENSUS_LIMIT,
  computePlanSpecCoverage,
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageDeps,
} from './plan-spec-coverage-gate';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { ScorecardRow } from '../../scorecards';

const PLAN = 'first-class-spec-clauses-2026-08-20';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: PLAN,
    specId: 'SPEC-1',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'the gate refuses a stale proof',
    behaviorClass: 'failure',
    requiredEvidence: [],
    requiredTestLayers: [],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: { observation: 'a ship succeeds while the clause is proven only at r1' },
    contentHash: 'hash-1',
    createdBy: 'su-author',
    createdAt: '2026-08-20T00:00:00Z',
    acceptedBy: null,
    acceptedAt: null,
    acceptanceRef: null,
    ...over,
  };
}

function evidence(specId: string, specRevision: number) {
  return { specId, specRevision };
}

function adequacyCard(subjectRef: string, over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-adequacy',
    createdAt: '2026-08-20T02:00:00Z',
    createdBy: 'su-grader',
    rubricRef: 'spec-test-adequacy',
    subject: { kind: 'plan', ref: subjectRef },
    ratings: { traceability: { rating: 'pass', evidence: 'covered' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...over,
  } as ScorecardRow;
}

/** Deps with every leg empty; individual tests override only what they exercise. */
function deps(over: Partial<PlanSpecCoverageDeps> = {}): PlanSpecCoverageDeps {
  return {
    listClauses: vi.fn(async () => [] as SpecClauseRevision[]),
    listEvidence: vi.fn(async () => [] as Array<{ specId: string; specRevision: number }>),
    listCards: vi.fn(async () => [] as ScorecardRow[]),
    // ⚠ MUST be stubbed, and must default to an ENFORCING status.
    //
    // The real reader hits the database, and this gate deliberately catches a read failure
    // and degrades to non-enforcing (a status blip must not freeze every ship). Both
    // halves are correct, and together they mean an unstubbed dep here does not throw — it
    // SILENTLY TURNS ENFORCEMENT OFF, and every refusal assertion in this file passes for
    // the wrong reason while proving nothing. That is a fail-open no typecheck can see, so
    // the stub is the guard.
    readPlanStatuses: vi.fn(async ({ planSlugs }) => new Map(planSlugs.map((slug) => [slug, 'active']))),
    ...over,
  };
}

describe('evaluatePlanSpecCoverageGate — proof freshness', () => {
  it('a spec revision recorded AFTER green evidence blocks shipping, and current proof unblocks it', async () => {
    // The clause was proven at r1, then revised to r2: the existing green evidence is
    // proof of a promise that no longer applies.
    const revised = clause({ specId: 'SPEC-1', revision: 2, currentRevision: 2, contentHash: 'hash-2' });

    const blocked = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [revised]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1)]),
      }),
    );

    expect(blocked.satisfied).toBe(false);
    expect(blocked.code).toBe('spec_proof_stale');
    expect(blocked.mode).toBe('enforced');
    expect(blocked.aggregate?.coverage.staleProof).toBe(1);
    expect(blocked.aggregate?.coverage.proven).toBe(0);
    expect(blocked.aggregate?.coverage.staleProofClauses).toEqual([
      { specId: 'SPEC-1', planItemId: 'P-001', currentRevision: 2, provenRevisions: [1] },
    ]);
    // The refusal has to say which revision is missing proof, or it cannot be repaired.
    expect(blocked.message).toContain('SPEC-1');
    expect(blocked.message).toContain('r2');
    expect(blocked.message).toContain('plans:set-spec-evidence');

    // …and the SAME clause set, re-proven at the current revision, ships.
    const unblocked = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [revised]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1), evidence('SPEC-1', 2)]),
      }),
    );

    expect(unblocked.satisfied).toBe(true);
    expect(unblocked.mode).toBe('enforced');
    expect(unblocked.code).toBeUndefined();
    expect(unblocked.aggregate?.coverage.proven).toBe(1);
    expect(unblocked.aggregate?.coverage.staleProof).toBe(0);
  });

  it('REFUSES an enforceable clause with no evidence (P-013 lands the D-018 widening)', async () => {
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]) }),
    );

    // ⚠ INVERTED from what it asserted under P-008/D-018, deliberately. It read
    // `satisfied: true, wouldBlock: []` and carried the note "turning this into a refusal
    // is a deliberate P-013 change, and it must fail this test to land". It did.
    //
    // The condition it now refuses on is the WEAKER one: the gate already refused a proof
    // bound to a superseded revision, while accepting a clause with no proof at all.
    expect(verdict.satisfied).toBe(false);
    expect(verdict.mode).toBe('enforced');
    expect(verdict.code).toBe('spec_clause_unproven');
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
    expect(verdict.aggregate?.coverage.unproven).toBe(1);
    expect(verdict.aggregate?.coverage.unprovenSpecIds).toEqual(['SPEC-UNCOVERED']);
    expect(verdict.message).toContain('SPEC-UNCOVERED');
  });

  it('does NOT refuse an unproven clause on a plan that is not eligible to enforce', async () => {
    // The falsifier for the widening above. Enforcement is per-plan (D-018 keeps shipped
    // plans non-blocking; D-012 keeps drafts candidate-only), so without this case
    // "refuses unproven clauses" would pass just as happily if eligibility were ignored —
    // which would refuse every already-shipped plan the admin panel renders.
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]),
        readPlanStatuses: vi.fn(async ({ planSlugs }) => new Map(planSlugs.map((s) => [s, 'shipped']))),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.code).toBeUndefined();
    // ...but NOT silently: an exempt plan still names what it would have refused on, or a
    // migration lane is indistinguishable from a clean plan and never gets migrated.
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
    expect(verdict.reports.join(' ')).toContain('not-enforcing:historical');
  });

  it('degrades to report-only — never to a refusal — when the plan status cannot be read', async () => {
    // A status blip must not freeze every ship. The risk of a fail-OPEN is that it is
    // invisible, so the degradation is asserted to be REPORTED, not merely harmless.
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]),
        readPlanStatuses: vi.fn(async () => {
          throw new Error('pg unreachable');
        }),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.reports.join(' ')).toContain('not-enforcing:unreadable-plan-status');
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
  });

  it('withholds the refusal when the evidence census is truncated (a floor is not a verdict)', async () => {
    // A full page of rows for OTHER clauses: the row that would prove SPEC-1 current
    // could be exactly the one that fell off the end, so a stale verdict here would be
    // manufactured from a bounded read.
    const saturated = Array.from({ length: SPEC_EVIDENCE_CENSUS_LIMIT }, (_, i) => evidence(`SPEC-OTHER-${i}`, 1));
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ revision: 2, currentRevision: 2 })]),
        listEvidence: vi.fn(async () => [...saturated, evidence('SPEC-1', 1)]),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.code).toBeUndefined();
    expect(verdict.aggregate?.bounded.truncatedByLimit).toBe(true);
    expect(verdict.reports).toContain('evidence-census-truncated');
    expect(verdict.message).toContain('FLOOR');
  });

  it('a plan with no first-class clauses is report-only, never a refusal', async () => {
    const verdict = await evaluatePlanSpecCoverageGate({ harnessSlug: 'papercusp', planSlug: PLAN }, deps());
    expect(verdict).toMatchObject({ satisfied: true, applicable: false, mode: 'report-only' });
    expect(verdict.reports).toContain('no-first-class-spec-clauses');
  });

  it('a read failure degrades to report-only instead of freezing the ship', async () => {
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => {
          throw new Error('clause store unavailable');
        }),
      }),
    );

    expect(verdict).toMatchObject({ satisfied: true, applicable: false, code: 'spec_coverage_unavailable' });
    expect(verdict.aggregate).toBeNull();
    expect(verdict.message).toContain('clause store unavailable');
  });
});

describe('computePlanSpecCoverage — the aggregate', () => {
  it('counts only accepted/active clauses as enforceable, and partitions the rest', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [
          clause({ specId: 'A', lifecycleStatus: 'active' }),
          clause({ specId: 'B', lifecycleStatus: 'accepted' }),
          clause({ specId: 'C', lifecycleStatus: 'draft' }),
          clause({ specId: 'D', lifecycleStatus: 'exempt' }),
          clause({ specId: 'E', lifecycleStatus: 'superseded' }),
          clause({ specId: 'F', lifecycleStatus: 'retired' }),
        ]),
      }),
    );

    expect(aggregate.clauses).toMatchObject({ total: 6, enforceable: 2, draft: 1, exempt: 1, inactive: 2 });
    // A draft clause is a candidate input, not an uncovered promise (D-012): it must
    // not appear as a coverage gap in either direction.
    expect(aggregate.coverage.unprovenSpecIds).toEqual(['A', 'B']);
  });

  it('reports undeclared falsifiers without treating them as coverage (D-016)', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [
          clause({ specId: 'A', falsifier: { observation: 'a stale proof ships' } }),
          clause({ specId: 'B', falsifier: null }),
        ]),
        listEvidence: vi.fn(async () => [evidence('A', 1), evidence('B', 1)]),
      }),
    );

    expect(aggregate.clauses.falsifierDeclared).toBe(1);
    // Both are PROVEN — an undeclared falsifier is a gradeable gap, not missing proof.
    expect(aggregate.coverage.proven).toBe(2);
  });

  it('counts an adequacy scorecard only at the clause’s CURRENT revision', async () => {
    const listCards = vi.fn(async (filter: { subjectRef?: string } = {}) =>
      // Only the r1 card exists; the clause below is at r2.
      filter.subjectRef === `${PLAN}#SPEC-1@1` ? [adequacyCard(`${PLAN}#SPEC-1@1`)] : [],
    );
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ revision: 2, currentRevision: 2 })]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 2)]),
        listCards: listCards as unknown as PlanSpecCoverageDeps['listCards'],
      }),
    );

    expect(aggregate.adequacy).toMatchObject({ graded: 0, ungraded: 1, ungradedSpecIds: ['SPEC-1'] });
  });

  it('marks boundedness on the AGGREGATE, not only on the row list', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause()]), listEvidence: vi.fn(async () => [evidence('SPEC-1', 1)]) }),
    );

    expect(aggregate.bounded).toMatchObject({
      evidenceCensusLimit: SPEC_EVIDENCE_CENSUS_LIMIT,
      evidenceRowsRead: 1,
      truncatedByLimit: false,
      adequacyClauseLimit: ADEQUACY_CENSUS_CLAUSE_LIMIT,
      adequacyTruncatedByLimit: false,
    });
  });

  it('pins the census limit itself rather than inheriting listSpecEvidence’s 200-row page default', async () => {
    const listEvidence = vi.fn(async () => [] as Array<{ specId: string; specRevision: number }>);
    await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause()]), listEvidence }),
    );
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ planSlugs: [PLAN], limit: SPEC_EVIDENCE_CENSUS_LIMIT }),
    );
  });
});
