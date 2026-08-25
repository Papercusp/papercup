/** Per-clause spec-test-adequacy evaluator (P-006 / D-004..D-006, D-009). */
import type { SpecBehaviorClass, SpecClauseRevision } from './spec-clauses-store';
import type { EvidenceCurrentInput, EvidenceCurrentness, SpecEvidenceKind } from './spec-evidence-store';
import type {
  SpecTestAdequacyCurrentFingerprint,
  SpecTestAdequacyRerunRecipe,
} from '../../harness/improvements/observation-types';

export const SPEC_TEST_ADEQUACY_RUBRIC_REF = 'spec-test-adequacy';

export const PLAN_CLASS_RUBRIC_REFS = [
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
] as const;
export type PlanClassRubricRef = (typeof PLAN_CLASS_RUBRIC_REFS)[number];

export const ADEQUACY_CRITERIA = [
  'traceability',
  'fixture-calibration',
  'falsifiability',
  'correct-layer',
  'oracle-independence',
  'execution-integrity',
  'freshness',
  'plan-class-risk-floor',
] as const;
export type AdequacyCriterion = (typeof ADEQUACY_CRITERIA)[number];
export type AdequacyRating = 'pass' | 'fail' | 'unknown' | 'waived' | 'not-applicable';

export interface AdequacyRatingEntry {
  rating: AdequacyRating;
  evidence: string;
  suggestion?: string;
}

export interface SpecEvidenceForAdequacy {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  fingerprints: {
    sourceFingerprint: string;
    testFingerprint: string | null;
    fixtureFingerprint: string | null;
    rubricFingerprint: string | null;
    environmentFingerprint: string | null;
  };
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  details: Record<string, unknown>;
  currentness: EvidenceCurrentness;
}

interface AdequacyDetails {
  fixtureCalibrated?: boolean;
  falsifiable?: boolean;
  testLayer?: string;
  pathReachable?: boolean;
  oracleIndependent?: boolean;
  collected?: boolean;
  skipped?: boolean;
  executed?: boolean;
  outcome?: string;
  targeted?: boolean;
  coverageRungs?: Partial<Record<'l1' | 'l2' | 'l3' | 'l4', boolean>>;
}

interface L4Waiver {
  justification: string;
  approvalRef: string;
  expiresAt?: string;
}

export interface SpecTestAdequacyResult {
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  planItemId: string;
  classRef: PlanClassRubricRef;
  behaviorClass: SpecBehaviorClass;
  evidenceRefs: string[];
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
  requiredProofFloor: 'none' | 'l3' | 'l4';
  verdict: 'pass' | 'fail' | 'unknown';
  wouldBlock: string[];
  scorecardDraft: {
    rubricRef: typeof SPEC_TEST_ADEQUACY_RUBRIC_REF;
    subject: { kind: 'plan'; ref: string };
    title: string;
    body: string;
    ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
    rerunRecipe: SpecTestAdequacyRerunRecipe;
    terminal: true;
  };
}

const HIGH_RISK_BEHAVIOR_CLASSES = new Set<SpecBehaviorClass>([
  'authorization',
  'concurrency',
  'lifecycle',
  'migration-data-integrity',
]);

const SUCCESS_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded', 'killed']);
const FAILURE_OUTCOMES = new Set(['fail', 'failed', 'error', 'timed-out', 'timeout', 'survived']);

function detailsOf(evidence: SpecEvidenceForAdequacy): AdequacyDetails {
  const nested = evidence.details.adequacy;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return {};
  const raw = nested as Record<string, unknown>;
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : undefined;
  const coverageRaw = raw.coverageRungs;
  const coverage =
    coverageRaw && typeof coverageRaw === 'object' && !Array.isArray(coverageRaw)
      ? (coverageRaw as Record<string, unknown>)
      : null;
  return {
    ...(bool('fixtureCalibrated') !== undefined ? { fixtureCalibrated: bool('fixtureCalibrated') } : {}),
    ...(bool('falsifiable') !== undefined ? { falsifiable: bool('falsifiable') } : {}),
    ...(typeof raw.testLayer === 'string' ? { testLayer: raw.testLayer } : {}),
    ...(bool('pathReachable') !== undefined ? { pathReachable: bool('pathReachable') } : {}),
    ...(bool('oracleIndependent') !== undefined ? { oracleIndependent: bool('oracleIndependent') } : {}),
    ...(bool('collected') !== undefined ? { collected: bool('collected') } : {}),
    ...(bool('skipped') !== undefined ? { skipped: bool('skipped') } : {}),
    ...(bool('executed') !== undefined ? { executed: bool('executed') } : {}),
    ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
    ...(bool('targeted') !== undefined ? { targeted: bool('targeted') } : {}),
    ...(coverage
      ? {
          coverageRungs: Object.fromEntries(
            ['l1', 'l2', 'l3', 'l4']
              .filter((key) => typeof coverage[key] === 'boolean')
              .map((key) => [key, coverage[key]]),
          ) as AdequacyDetails['coverageRungs'],
        }
      : {}),
  };
}

function normalizedLayer(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function booleanRating(
  evidence: SpecEvidenceForAdequacy[],
  pick: (details: AdequacyDetails) => boolean | undefined,
  labels: { pass: string; fail: string; unknown: string },
): AdequacyRatingEntry {
  const values = evidence.map((row) => pick(detailsOf(row))).filter((v): v is boolean => v !== undefined);
  if (values.includes(true)) return { rating: 'pass', evidence: labels.pass };
  if (values.includes(false)) return { rating: 'fail', evidence: labels.fail };
  return { rating: 'unknown', evidence: labels.unknown };
}

function l4WaiverOf(exemption: Record<string, unknown> | null, now: Date): L4Waiver | null {
  const root = exemption?.testAdequacyWaivers;
  const raw = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>).l4 : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const waiver = raw as Record<string, unknown>;
  if (typeof waiver.justification !== 'string' || waiver.justification.trim().length < 12) return null;
  if (typeof waiver.approvalRef !== 'string' || waiver.approvalRef.trim().length === 0) return null;
  if (waiver.expiresAt !== undefined) {
    if (typeof waiver.expiresAt !== 'string') return null;
    const expiry = new Date(waiver.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  }
  return {
    justification: waiver.justification.trim(),
    approvalRef: waiver.approvalRef.trim(),
    ...(typeof waiver.expiresAt === 'string' ? { expiresAt: waiver.expiresAt } : {}),
  };
}

export function requiredProofFloor(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
): 'none' | 'l3' | 'l4' {
  if (clause.behaviorClass === 'non-automated' && clause.requiredTestLayers.length === 0) return 'none';
  if (classRef === 'plan-class-migration' || classRef === 'plan-class-bugfix') return 'l4';
  if (clause.mutationRequired || HIGH_RISK_BEHAVIOR_CLASSES.has(clause.behaviorClass)) return 'l4';
  if (classRef === 'plan-class-investigation' && clause.requiredTestLayers.length === 0) return 'none';
  return 'l3';
}

function riskFloorRating(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
  evidence: SpecEvidenceForAdequacy[],
  now: Date,
): { floor: 'none' | 'l3' | 'l4'; rating: AdequacyRatingEntry } {
  const floor = requiredProofFloor(clause, classRef);
  if (floor === 'none') {
    return { floor, rating: { rating: 'not-applicable', evidence: 'This non-automated clause declares no test layer.' } };
  }
  const detailRows = evidence.map((row) => ({ row, details: detailsOf(row) }));
  const meetsL3 = detailRows.some(({ details }) => details.coverageRungs?.l3 === true);
  const meetsL4 = detailRows.some(
    ({ row, details }) =>
      details.coverageRungs?.l4 === true ||
      ((row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
        details.targeted === true &&
        SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')),
  );
  if (floor === 'l4') {
    if (meetsL4) {
      return {
        floor,
        rating: { rating: 'pass', evidence: 'Targeted L4 proof is bound to this exact clause revision.' },
      };
    }
    const waiver = l4WaiverOf(clause.exemption, now);
    if (waiver) {
      return {
        floor,
        rating: {
          rating: 'waived',
          evidence: `L4 explicitly waived by ${waiver.approvalRef}: ${waiver.justification}${waiver.expiresAt ? ` (expires ${waiver.expiresAt})` : ''}`,
        },
      };
    }
    const hasExplicitL4Miss = detailRows.some(({ details }) => details.coverageRungs?.l4 === false);
    return {
      floor,
      rating: {
        rating: hasExplicitL4Miss ? 'fail' : 'unknown',
        evidence: hasExplicitL4Miss
          ? 'The bound coverage row explicitly misses L4 and no current approved waiver exists.'
          : 'No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound.',
        suggestion: 'Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision.',
      },
    };
  }
  const hasExplicitL3Miss = detailRows.some(({ details }) => details.coverageRungs?.l3 === false);
  return {
    floor,
    rating: meetsL3
      ? { rating: 'pass', evidence: 'Targeted L3 intent proof is bound to this exact clause revision.' }
      : {
          rating: hasExplicitL3Miss ? 'fail' : 'unknown',
          evidence: hasExplicitL3Miss
            ? 'The bound coverage row explicitly misses the L3 intent-test floor.'
            : 'No explicit meets_l3 result is bound; depth or a generic passing test is not a rung verdict.',
          suggestion: 'Bind a coverage-census row whose independent meets_l3 flag is current.',
        },
  };
}

function compactSubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

function rerunRecipeFor(
  clause: SpecClauseRevision,
  evidence: SpecEvidenceForAdequacy[],
  current: EvidenceCurrentInput[] | undefined,
): SpecTestAdequacyRerunRecipe {
  const selectedEvidence = [...new Map(
    evidence.map((row) => [`${row.evidenceKind}\0${row.evidenceRef}`, {
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
    }]),
  ).values()].sort((a, b) =>
    `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
  );
  const selectedKeys = new Set(selectedEvidence.map((row) => `${row.evidenceKind}\0${row.evidenceRef}`));
  const fingerprints: SpecTestAdequacyCurrentFingerprint[] = (current ?? [])
    .filter((row) => selectedKeys.has(`${row.evidenceKind}\0${row.evidenceRef}`))
    .map((row) => ({
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
      sourceFingerprint: row.sourceFingerprint,
      testFingerprint: row.testFingerprint ?? null,
      fixtureFingerprint: row.fixtureFingerprint ?? null,
      rubricFingerprint: row.rubricFingerprint ?? null,
      environmentFingerprint: row.environmentFingerprint ?? null,
    }))
    .sort((a, b) =>
      `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
    );
  return {
    schemaVersion: 1,
    evaluator: 'plans:evaluate-spec-test-adequacy',
    selection: {
      planSlug: clause.planSlug,
      specId: clause.specId,
      specRevision: clause.revision,
      specFingerprint: clause.contentHash,
      evidence: selectedEvidence,
    },
    current: {
      supplied: current !== undefined,
      fingerprints,
    },
    derivation: {
      kind: 'listSpecEvidence.currentness',
      classifier: 'classifySpecEvidenceCurrentness',
      unknownWhenMissing: true,
    },
  };
}

/** Grade one clause/evidence row into the exact ratings map accepted by scorecards:emit. */
export function evaluateSpecTestAdequacy(input: {
  clause: SpecClauseRevision;
  evidence: SpecEvidenceForAdequacy[];
  classRef: PlanClassRubricRef;
  /** The caller-attested current fingerprints used by listSpecEvidence. */
  current?: EvidenceCurrentInput[];
  now?: Date;
}): SpecTestAdequacyResult {
  const { clause, classRef } = input;
  const exactEvidence = input.evidence.filter(
    (row) =>
      row.planSlug === clause.planSlug &&
      row.specId === clause.specId &&
      row.specRevision === clause.revision &&
      row.specFingerprint === clause.contentHash,
  );
  const currentEvidence = exactEvidence.filter((row) => row.currentness.overall === 'current');
  // Immutable historical bindings remain available to the evidence store, but once an exact
  // current cohort exists they can neither satisfy nor veto the verdict for that cohort. When
  // there is no current cohort, retain the full exact set so stale/unknown diagnostics survive.
  const evidence = currentEvidence.length > 0 ? currentEvidence : exactEvidence;
  const ratings = {} as Record<AdequacyCriterion, AdequacyRatingEntry>;

  ratings.traceability = evidence.length
    ? {
        rating: 'pass',
        evidence: `${evidence.length} immutable binding(s) name ${clause.planSlug}/${clause.specId}@${clause.revision} (${clause.contentHash}).`,
      }
    : {
        rating: 'fail',
        evidence: `No immutable evidence binding names ${clause.planSlug}/${clause.specId}@${clause.revision}.`,
        suggestion: 'Bind the work item and proof through plans:bind-spec-evidence.',
      };

  const fixtureApplicable =
    clause.requiredEvidence.some((entry) => /fixture/i.test(entry)) ||
    evidence.some((row) => row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null);
  ratings['fixture-calibration'] = fixtureApplicable
    ? booleanRating(evidence, (d) => d.fixtureCalibrated, {
        pass: 'At least one applicable binding explicitly demonstrates fixture calibration.',
        fail: 'Applicable binding metadata explicitly reports an uncalibrated fixture.',
        unknown: 'A fixture is required or used, but no binding attests fixture calibration.',
      })
    : { rating: 'not-applicable', evidence: 'The clause and its bindings use no fixture.' };

  const falsificationEvidence = evidence.some((row) => {
    const details = detailsOf(row);
    return (
      details.falsifiable === true ||
      ((row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
        SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? ''))
    );
  });
  ratings.falsifiability = falsificationEvidence
    ? { rating: 'pass', evidence: 'A bound negative control, counterexample, or killed mutant demonstrates red capability.' }
    : booleanRating(evidence, (d) => d.falsifiable, {
        pass: 'A bound proof explicitly demonstrates falsifiability.',
        fail: 'Bound metadata explicitly reports non-falsifiable proof.',
        unknown: 'No bound evidence demonstrates how the proof fails when behavior is wrong.',
      });

  if (clause.requiredTestLayers.length === 0) {
    ratings['correct-layer'] = {
      rating: 'not-applicable',
      evidence: 'The clause declares no required test layer.',
    };
  } else {
    const required = [...new Set(clause.requiredTestLayers.map(normalizedLayer))];
    const present = new Map<string, boolean | undefined>();
    for (const row of evidence) {
      const details = detailsOf(row);
      if (typeof details.testLayer !== 'string') continue;
      const layer = normalizedLayer(details.testLayer);
      if (!required.includes(layer)) continue;
      const prior = present.get(layer);
      present.set(layer, prior === true || details.pathReachable === true ? true : details.pathReachable);
    }
    const missing = required.filter((layer) => !present.has(layer));
    const unreachable = required.filter((layer) => present.get(layer) === false);
    const unresolved = required.filter((layer) => present.get(layer) === undefined);
    ratings['correct-layer'] = missing.length || unreachable.length
      ? {
          rating: 'fail',
          evidence: `Required layer/path gaps: ${[
            ...missing.map((layer) => `${layer}:missing`),
            ...unreachable.map((layer) => `${layer}:unreachable`),
          ].join(', ')}.`,
          suggestion: 'Bind proof for every requiredTestLayer and attest that it reaches the real path.',
        }
      : unresolved.length
        ? {
            rating: 'unknown',
            evidence: `Required layer(s) are represented but path reachability is unverified: ${unresolved.join(', ')}.`,
          }
        : {
            rating: 'pass',
            evidence: `Every required layer reaches the claimed path: ${required.join(', ')}.`,
          };
  }

  ratings['oracle-independence'] = booleanRating(evidence, (d) => d.oracleIndependent, {
    pass: 'At least one bound proof explicitly uses an implementation-independent oracle.',
    fail: 'Bound metadata explicitly reports an implementation-coupled oracle.',
    unknown: 'No bound evidence establishes oracle independence.',
  });

  const executable = evidence.filter((row) =>
    ['test', 'coverage-census', 'mutation', 'counterexample', 'check', 'operational'].includes(row.evidenceKind),
  );
  const explicitBadExecution = executable.some((row) => {
    const d = detailsOf(row);
    return (
      d.collected === false ||
      d.skipped === true ||
      d.executed === false ||
      FAILURE_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
    );
  });
  const successfulExecution = executable.some((row) => {
    const d = detailsOf(row);
    return d.collected === true && d.skipped === false && d.executed === true && SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '');
  });
  ratings['execution-integrity'] = explicitBadExecution
    ? {
        rating: 'fail',
        evidence: 'At least one relied-on binding reports an uncollected, skipped, unexecuted, or failing outcome.',
      }
    : successfulExecution
      ? {
          rating: 'pass',
          evidence: 'Bound proof was collected, not skipped, executed, and produced a successful outcome.',
        }
      : {
          rating: executable.length ? 'unknown' : 'fail',
          evidence: executable.length
            ? 'Executable bindings exist, but collection/skip/execution/outcome metadata is incomplete.'
            : 'No executable test/check/mutation/counterexample/coverage/operational proof is bound.',
        };

  const freshnessStates = evidence.map((row) => row.currentness.overall);
  ratings.freshness = freshnessStates.includes('stale')
    ? {
        rating: 'fail',
        evidence: `Stale binding(s): ${evidence
          .filter((row) => row.currentness.overall === 'stale')
          .map((row) => `${row.evidenceRef} [${row.currentness.staleReasons.join(',')}]`)
          .join('; ')}.`,
      }
    : freshnessStates.includes('unknown')
      ? {
          rating: 'unknown',
          evidence: `Current fingerprints are missing for: ${evidence
            .filter((row) => row.currentness.overall === 'unknown')
            .map((row) => `${row.evidenceRef} [${row.currentness.unknownReasons.join(',')}]`)
            .join('; ')}.`,
        }
      : evidence.length
        ? { rating: 'pass', evidence: 'Every bound proof dimension is current.' }
        : { rating: 'fail', evidence: 'No evidence exists whose freshness can be established.' };

  const risk = riskFloorRating(clause, classRef, evidence, input.now ?? new Date());
  ratings['plan-class-risk-floor'] = risk.rating;

  const wouldBlock = ADEQUACY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  const evidenceRefs = [...new Set(evidence.map((row) => row.evidenceRef))].sort();
  const subjectRef = compactSubjectRef(clause.planSlug, clause.specId, clause.revision);
  const rerunRecipe = rerunRecipeFor(clause, evidence, input.current);
  const rawRefs = evidenceRefs.join(', ') || '(none)';
  const bodyRefs = rawRefs.length <= 7_000 ? rawRefs : `${rawRefs.slice(0, 6_980)}… (see evidenceRefs for the full set)`;
  return {
    planSlug: clause.planSlug,
    specId: clause.specId,
    specRevision: clause.revision,
    specFingerprint: clause.contentHash,
    planItemId: clause.planItemId,
    classRef,
    behaviorClass: clause.behaviorClass,
    evidenceRefs,
    ratings,
    requiredProofFloor: risk.floor,
    verdict,
    wouldBlock,
    scorecardDraft: {
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subject: { kind: 'plan', ref: subjectRef },
      title: `${clause.specId}@${clause.revision} test adequacy`,
      body: `Exact clause ${clause.planSlug}/${clause.specId}@${clause.revision}; fingerprint ${clause.contentHash}; work item evidence refs: ${bodyRefs}.`,
      ratings,
      rerunRecipe,
      terminal: true,
    },
  };
}
