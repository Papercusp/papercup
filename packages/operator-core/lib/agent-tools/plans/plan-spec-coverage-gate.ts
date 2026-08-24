/**
 * plan-spec-coverage-gate — the plan-ship spec-coverage aggregate and the
 * proof-freshness refusal
 * (first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-008).
 *
 * The plan acceptance gate already asks four independent questions at ship time: are
 * the items finished, does a code-truth audit still resolve against the tree, does a
 * vetted acceptance rubric exist, and did a non-implementer grade it. None of them
 * reads the plan's first-class spec clauses, so a plan could ship with a clause whose
 * only proof was recorded against a revision that has since been superseded — green
 * evidence for a promise nobody makes any more.
 *
 * This module adds the fifth question as a STRUCTURED AGGREGATE over the plan's
 * CURRENT clauses — coverage, adequacy scorecards, exemptions, and freshness — and
 * turns exactly one of its findings into a refusal:
 *
 *   A clause that HAS evidence, but none of it bound to the clause's CURRENT
 *   revision, is UNPROVEN AT ITS PRESENT MEANING. Shipping refuses until current
 *   proof exists.
 *
 * ⚠ SCOPE, and why it is drawn here (see this plan's D-018).
 *
 * `unproven` — an enforceable clause with NO evidence at all — is REPORTED and never
 * refused. That refusal is a widening of the enforced set, which D-013/D-017 assign to
 * P-013, and turning it on here would refuse plan ships fleet-wide for clauses authored
 * as documentation. The freshness refusal is a different claim: it does not widen WHICH
 * clauses are enforced, it only declines to accept a proof the author has already
 * invalidated by revising the clause. Every clause it reads is in the plan's OWN
 * namespace, so no cross-namespace applicability is enforced here either.
 *
 * ⚠ BOUNDEDNESS. The evidence census is a MEASUREMENT, and the repo rule is that a
 * count computed over a capped fetch must mark boundedness ON THE AGGREGATE, not just
 * on the row list. The census fetch is pinned to {@link SPEC_EVIDENCE_CENSUS_LIMIT}
 * independently of any caller's limit, and a truncated census degrades the whole gate
 * to report-only: a truncated read can miss the very row that proves a clause current,
 * so refusing on one would manufacture a false stale verdict.
 */
import { listScorecards, type ScorecardRow } from '../../scorecards';
import { listSpecClauses, type SpecClauseRevision } from './spec-clauses-store';
import { listSpecEvidence } from './spec-evidence-store';
import { SPEC_TEST_ADEQUACY_RUBRIC_REF } from './spec-test-adequacy';

/** Lifecycle states carrying an enforceable promise (D-012), mirrored from the resolver. */
const ENFORCEABLE_LIFECYCLE = new Set(['accepted', 'active']);

/**
 * The evidence census cap, pinned independently of any caller-supplied limit.
 *
 * `listSpecEvidence` defaults to 200 rows ordered newest-first, which is a fine page
 * size for a reader and a silently wrong denominator for a census: the row that proves
 * a clause current can fall off the end. Pinning it here — and reporting truncation on
 * the aggregate — is what keeps the count a measurement rather than an impression.
 */
export const SPEC_EVIDENCE_CENSUS_LIMIT = 2_000;

/** How many clauses the adequacy leg will read scorecards for before it reports bounded. */
export const ADEQUACY_CENSUS_CLAUSE_LIMIT = 200;

export interface StaleProofClause {
  specId: string;
  planItemId: string;
  /** The clause revision that is currently in force. */
  currentRevision: number;
  /** The superseded revision(s) the existing evidence was bound to. */
  provenRevisions: number[];
}

export interface PlanSpecCoverageAggregate {
  planSlug: string;
  /** Every CURRENT clause, partitioned by the lifecycle role it plays (D-012). */
  clauses: {
    total: number;
    /** accepted | active — the enforceable promises. */
    enforceable: number;
    /** lifecycleStatus 'exempt' — a declared non-behavioral carve-out. */
    exempt: number;
    /** Candidate inputs, never enforceable until promotion (D-012). */
    draft: number;
    /** superseded | retired. */
    inactive: number;
    /** D-016: how many enforceable clauses declare what would falsify them. */
    falsifierDeclared: number;
  };
  coverage: {
    /** Enforceable clauses with at least one evidence row at the CURRENT revision. */
    proven: number;
    /** Enforceable clauses with evidence, but NONE at the current revision. Blocks. */
    staleProof: number;
    /** Enforceable clauses with no evidence at all. Reported, never refused here. */
    unproven: number;
    staleProofClauses: StaleProofClause[];
    unprovenSpecIds: string[];
  };
  adequacy: {
    /** Enforceable clauses carrying a complete adequacy scorecard at the current revision. */
    graded: number;
    ungraded: number;
    ungradedSpecIds: string[];
  };
  /**
   * Boundedness of the measurement itself, carried ON the aggregate so a floor can
   * never be read as a total.
   */
  bounded: {
    evidenceCensusLimit: number;
    evidenceRowsRead: number;
    /** True ⇒ every count above is a FLOOR, and the gate must not refuse on it. */
    truncatedByLimit: boolean;
    adequacyClauseLimit: number;
    adequacyTruncatedByLimit: boolean;
  };
}

export type PlanSpecCoverageGateCode = 'spec_proof_stale' | 'spec_coverage_unavailable';

export interface PlanSpecCoverageGateVerdict {
  satisfied: boolean;
  /** False ⇒ the plan has adopted no first-class clauses, so the gate has nothing to say. */
  applicable: boolean;
  mode: 'report-only' | 'enforced';
  planSlug: string;
  aggregate: PlanSpecCoverageAggregate | null;
  code?: PlanSpecCoverageGateCode;
  message?: string;
  /** Conditions that DID refuse (enforced) or WOULD refuse were the gate enforcing. */
  wouldBlock: string[];
  /** Findings this gate deliberately reports without refusing (see the scope note). */
  reports: string[];
}

/**
 * The census's view of the evidence reader — deliberately narrower than
 * `listSpecEvidence`'s full row.
 *
 * A census asks one question of each row: which clause revision does this prove? Typing
 * the dep to exactly that keeps the contract honest (a reader can see the census cannot
 * silently start depending on fingerprints or details) and keeps the real
 * `listSpecEvidence` assignable to it unchanged.
 */
export type SpecEvidenceCensusReader = (options: {
  harnessSlug?: string;
  /**
   * An array to stay assignable to `listSpecEvidence`, which widened to `planSlugs` in
   * P-013 so the work-item gate could scope evidence to every namespace it enforces. A
   * plan census still passes exactly one slug — the narrowing is in the CALL, not the
   * type, so the real reader remains substitutable here without a wrapper.
   */
  planSlugs: string[];
  limit?: number;
}) => Promise<ReadonlyArray<{ specId: string; specRevision: number }>>;

export interface PlanSpecCoverageDeps {
  listClauses?: typeof listSpecClauses;
  listEvidence?: SpecEvidenceCensusReader;
  listCards?: typeof listScorecards;
}

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

/**
 * A usable adequacy grading for the clause revision named by `subjectRef`.
 *
 * Deliberately does NOT compare an evidence fingerprint the way the work-item adequacy
 * gate does: that gate holds one exact evaluation to compare against, and this one is
 * taking a census. The revision-pinned subject ref is what makes the count honest —
 * a clause revision changes the ref, so an old card cannot satisfy a new revision.
 */
function usableAdequacyCard(card: ScorecardRow, subjectRef: string): boolean {
  return (
    card.rubricRef === SPEC_TEST_ADEQUACY_RUBRIC_REF &&
    card.subject?.kind === 'plan' &&
    card.subject.ref === subjectRef &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    !card.synthesized &&
    !card.retracted &&
    !card.supersededBy &&
    card.provisional === undefined &&
    card.gradingAudit?.state !== 'pending' &&
    card.gradingAudit?.state !== 'failed' &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

/** The revision-pinned adequacy subject ref, mirroring spec-test-adequacy's own. */
function adequacySubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

function isEnforceable(clause: SpecClauseRevision): boolean {
  return ENFORCEABLE_LIFECYCLE.has(clause.lifecycleStatus);
}

/**
 * Census the plan's current clauses against the evidence bound to them.
 *
 * Reads only the plan's OWN namespace — this is a plan-ship aggregate, not the
 * cross-namespace behavior contract that `resolveWorkItemBehaviorContract` resolves
 * for a work item.
 */
export async function computePlanSpecCoverage(
  input: { harnessSlug?: string; planSlug: string },
  deps: PlanSpecCoverageDeps = {},
): Promise<PlanSpecCoverageAggregate> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;

  const clauses = await listClauses({ harnessSlug: input.harnessSlug, planSlug: input.planSlug });
  const enforceable = clauses.filter(isEnforceable);

  // Genuinely single-plan: this is a census of ONE plan's own coverage, unlike the
  // work-item completion gate, whose contract spans namespaces.
  const evidence = await listEvidence({
    harnessSlug: input.harnessSlug,
    planSlugs: [input.planSlug],
    limit: SPEC_EVIDENCE_CENSUS_LIMIT,
  });
  const truncatedByLimit = evidence.length >= SPEC_EVIDENCE_CENSUS_LIMIT;

  // Fold the evidence into per-clause revision sets ONCE; a per-clause filter over the
  // whole array would be quadratic on plans with many clauses.
  const revisionsBySpecId = new Map<string, Set<number>>();
  for (const row of evidence) {
    const set = revisionsBySpecId.get(row.specId);
    if (set) set.add(row.specRevision);
    else revisionsBySpecId.set(row.specId, new Set([row.specRevision]));
  }

  const staleProofClauses: StaleProofClause[] = [];
  const unprovenSpecIds: string[] = [];
  let proven = 0;
  for (const clause of enforceable) {
    const revisions = revisionsBySpecId.get(clause.specId);
    if (!revisions || revisions.size === 0) {
      unprovenSpecIds.push(clause.specId);
      continue;
    }
    if (revisions.has(clause.revision)) {
      proven += 1;
      continue;
    }
    staleProofClauses.push({
      specId: clause.specId,
      planItemId: clause.planItemId,
      currentRevision: clause.revision,
      provenRevisions: [...revisions].sort((a, b) => a - b),
    });
  }

  // The adequacy leg is a per-subject read, like every other adequacy consumer. Bounded
  // by clause count so a pathological plan cannot turn one gate into hundreds of reads.
  const adequacyScope = enforceable.slice(0, ADEQUACY_CENSUS_CLAUSE_LIMIT);
  const adequacyTruncatedByLimit = enforceable.length > ADEQUACY_CENSUS_CLAUSE_LIMIT;
  const ungradedSpecIds: string[] = [];
  let graded = 0;
  await Promise.all(
    adequacyScope.map(async (clause) => {
      const subjectRef = adequacySubjectRef(clause.planSlug, clause.specId, clause.revision);
      const cards = await listCards({
        rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
        subjectRef,
        limit: 20,
      });
      if (cards.some((card) => usableAdequacyCard(card, subjectRef))) graded += 1;
      else ungradedSpecIds.push(clause.specId);
    }),
  );

  return {
    planSlug: input.planSlug,
    clauses: {
      total: clauses.length,
      enforceable: enforceable.length,
      exempt: clauses.filter((c) => c.lifecycleStatus === 'exempt').length,
      draft: clauses.filter((c) => c.lifecycleStatus === 'draft').length,
      inactive: clauses.filter((c) => c.lifecycleStatus === 'superseded' || c.lifecycleStatus === 'retired').length,
      falsifierDeclared: enforceable.filter((c) => c.falsifier != null).length,
    },
    coverage: {
      proven,
      staleProof: staleProofClauses.length,
      unproven: unprovenSpecIds.length,
      staleProofClauses: staleProofClauses.sort((a, b) => a.specId.localeCompare(b.specId)),
      unprovenSpecIds: unprovenSpecIds.sort(),
    },
    adequacy: {
      graded,
      ungraded: ungradedSpecIds.length,
      ungradedSpecIds: ungradedSpecIds.sort(),
    },
    bounded: {
      evidenceCensusLimit: SPEC_EVIDENCE_CENSUS_LIMIT,
      evidenceRowsRead: evidence.length,
      truncatedByLimit,
      adequacyClauseLimit: ADEQUACY_CENSUS_CLAUSE_LIMIT,
      adequacyTruncatedByLimit,
    },
  };
}

/**
 * Evaluate the spec-coverage gate for a plan about to ship.
 *
 * Never throws: a read failure degrades to report-only rather than freezing every ship
 * on an infrastructure blip, matching the acceptance gate's stated posture and the
 * sibling spec-quality gate's clause-read leg. Four independent gates still enforce
 * alongside it, and the degradation is reported rather than silent.
 */
export async function evaluatePlanSpecCoverageGate(
  input: { harnessSlug?: string; planSlug: string },
  deps: PlanSpecCoverageDeps = {},
): Promise<PlanSpecCoverageGateVerdict> {
  let aggregate: PlanSpecCoverageAggregate;
  try {
    aggregate = await computePlanSpecCoverage(input, deps);
  } catch (error) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate: null,
      code: 'spec_coverage_unavailable',
      wouldBlock: [],
      reports: ['spec-coverage-read-unavailable'],
      message:
        `Spec-coverage census could not be read for plan '${input.planSlug}' ` +
        `(${error instanceof Error ? error.message : String(error)}). Reporting the gap rather than ` +
        `freezing the ship: the item, audit, rubric and vetting gates are unaffected.`,
    };
  }

  const reports: string[] = [];
  if (aggregate.coverage.unproven > 0) {
    reports.push(`${aggregate.coverage.unproven}-enforceable-clause(s)-with-no-evidence`);
  }
  if (aggregate.adequacy.ungraded > 0) {
    reports.push(`${aggregate.adequacy.ungraded}-enforceable-clause(s)-without-a-current-adequacy-scorecard`);
  }
  if (aggregate.clauses.enforceable > aggregate.clauses.falsifierDeclared) {
    reports.push(
      `${aggregate.clauses.enforceable - aggregate.clauses.falsifierDeclared}-enforceable-clause(s)-declare-no-falsifier`,
    );
  }

  if (aggregate.clauses.total === 0) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate,
      wouldBlock: [],
      reports: ['no-first-class-spec-clauses'],
      message:
        `Report-only: plan '${input.planSlug}' has adopted no first-class spec clauses, so there is no ` +
        `proof freshness to check. Adopting any clause makes this gate enforcing at ship time.`,
    };
  }

  // A truncated census is a FLOOR, not a total. Refusing on one would manufacture a
  // stale verdict from a row that simply fell off the end of the read.
  if (aggregate.bounded.truncatedByLimit) {
    return {
      satisfied: true,
      applicable: true,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate,
      wouldBlock: [],
      reports: [...reports, 'evidence-census-truncated'],
      message:
        `Report-only: plan '${input.planSlug}' returned ${aggregate.bounded.evidenceRowsRead} evidence rows at the ` +
        `${SPEC_EVIDENCE_CENSUS_LIMIT}-row census cap, so every coverage count is a FLOOR and a stale-proof ` +
        `verdict could not be distinguished from a truncated read. The freshness refusal is withheld rather ` +
        `than guessed.`,
    };
  }

  if (aggregate.coverage.staleProof > 0) {
    const listed = aggregate.coverage.staleProofClauses
      .slice(0, 5)
      .map((c) => `${c.specId} (proof at r${c.provenRevisions.join('/r')}, clause now r${c.currentRevision})`)
      .join('; ');
    const more =
      aggregate.coverage.staleProofClauses.length > 5
        ? ` (+${aggregate.coverage.staleProofClauses.length - 5} more)`
        : '';
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      aggregate,
      code: 'spec_proof_stale',
      wouldBlock: [`${aggregate.coverage.staleProof}-clause(s)-proven-only-at-a-superseded-revision`],
      reports,
      message:
        `plan '${input.planSlug}' cannot be marked shipped: ${aggregate.coverage.staleProof} spec clause(s) were ` +
        `REVISED after their evidence was recorded, so their only proof is against a promise that no longer ` +
        `applies — ${listed}${more}. Re-prove each at its current revision: run the covering test, then ` +
        `plans:set-spec-evidence { slug:'${input.planSlug}', specId:'<spec>', specRevision:<current>, ... }. ` +
        `A clause whose behavior genuinely did not change still needs the evidence rebound, because the ` +
        `revision is what records that someone re-checked it. To ship anyway, pass force:{ reason } — it is ` +
        `recorded on the plan.`,
    };
  }

  return {
    satisfied: true,
    applicable: true,
    mode: 'enforced',
    planSlug: input.planSlug,
    aggregate,
    wouldBlock: [],
    reports,
  };
}
