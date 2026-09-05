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

function clauseIdentity(clause: SpecClauseRevision): string {
  return `${clause.planSlug}/${clause.specId}@${clause.revision} (${clause.contentHash})`;
}

function clauseProbe(clause: SpecClauseRevision): string {
  return (
    `Probe plans:get-spec-evidence with planSlug=${JSON.stringify(clause.planSlug)}, ` +
    `specId=${JSON.stringify(clause.specId)}, specRevision=${clause.revision}, ` +
    `specFingerprint=${JSON.stringify(clause.contentHash)}.`
  );
}

function bindingDescription(row: SpecEvidenceForAdequacy): string {
  const details = detailsOf(row);
  const fields = [
    `kind=${row.evidenceKind}`,
    `ref=${JSON.stringify(row.evidenceRef)}`,
    `currentness=${row.currentness.overall}`,
    `sourceFingerprint=${JSON.stringify(row.fingerprints.sourceFingerprint)}`,
    row.fingerprints.testFingerprint ? `testFingerprint=${JSON.stringify(row.fingerprints.testFingerprint)}` : null,
    row.fingerprints.fixtureFingerprint
      ? `fixtureFingerprint=${JSON.stringify(row.fingerprints.fixtureFingerprint)}`
      : null,
    row.fingerprints.rubricFingerprint
      ? `rubricFingerprint=${JSON.stringify(row.fingerprints.rubricFingerprint)}`
      : null,
    row.fingerprints.environmentFingerprint
      ? `environmentFingerprint=${JSON.stringify(row.fingerprints.environmentFingerprint)}`
      : null,
    row.coverageEvidenceRef !== null ? `coverageEvidenceRef=${row.coverageEvidenceRef}` : null,
    row.testRunId !== null ? `testRunId=${row.testRunId}` : null,
    details.fixtureCalibrated !== undefined ? `fixtureCalibrated=${details.fixtureCalibrated}` : null,
    details.falsifiable !== undefined ? `falsifiable=${details.falsifiable}` : null,
    details.testLayer !== undefined ? `testLayer=${JSON.stringify(details.testLayer)}` : null,
    details.pathReachable !== undefined ? `pathReachable=${details.pathReachable}` : null,
    details.oracleIndependent !== undefined ? `oracleIndependent=${details.oracleIndependent}` : null,
    details.collected !== undefined ? `collected=${details.collected}` : null,
    details.skipped !== undefined ? `skipped=${details.skipped}` : null,
    details.executed !== undefined ? `executed=${details.executed}` : null,
    details.outcome !== undefined ? `outcome=${JSON.stringify(details.outcome)}` : null,
    details.targeted !== undefined ? `targeted=${details.targeted}` : null,
    details.coverageRungs
      ? `coverageRungs=${(['l1', 'l2', 'l3', 'l4'] as const)
          .filter((rung) => details.coverageRungs?.[rung] !== undefined)
          .map((rung) => `${rung}:${details.coverageRungs?.[rung]}`)
          .join('|')}`
      : null,
    row.currentness.staleReasons.length > 0
      ? `staleReasons=${JSON.stringify(row.currentness.staleReasons)}`
      : null,
    row.currentness.unknownReasons.length > 0
      ? `unknownReasons=${JSON.stringify(row.currentness.unknownReasons)}`
      : null,
  ].filter((field): field is string => field !== null);
  return fields.join(', ');
}

function bindingSummary(rows: SpecEvidenceForAdequacy[]): string {
  const ordered = [...rows].sort((a, b) =>
    `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
  );
  if (ordered.length === 0) {
    return '(no bound evidence rows; probe plans:get-spec-evidence for the exact clause)';
  }
  const maxRows = 6;
  const shown = ordered.slice(0, maxRows).map(bindingDescription).join('; ');
  return ordered.length > maxRows ? `${shown}; +${ordered.length - maxRows} more binding(s)` : shown;
}

function evidenceWithBindings(statement: string, rows: SpecEvidenceForAdequacy[]): string {
  return `${statement} Bound evidence: ${bindingSummary(rows)}.`;
}

function booleanRating(
  evidence: SpecEvidenceForAdequacy[],
  pick: (details: AdequacyDetails) => boolean | undefined,
  labels: { pass: string; fail: string; unknown: string },
): AdequacyRatingEntry {
  const evaluated = evidence
    .map((row) => ({ row, value: pick(detailsOf(row)) }))
    .filter((entry): entry is { row: SpecEvidenceForAdequacy; value: boolean } => entry.value !== undefined);
  const inspected = evaluated.length > 0 ? evaluated.map(({ row }) => row) : evidence;
  const passing = evaluated.filter(({ value }) => value).map(({ row }) => row);
  const failing = evaluated.filter(({ value }) => !value).map(({ row }) => row);
  if (passing.length > 0) return { rating: 'pass', evidence: evidenceWithBindings(labels.pass, passing) };
  if (failing.length > 0) return { rating: 'fail', evidence: evidenceWithBindings(labels.fail, failing) };
  return { rating: 'unknown', evidence: evidenceWithBindings(labels.unknown, inspected) };
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
    return {
      floor,
      rating: {
        rating: 'not-applicable',
        evidence: `Clause ${clauseIdentity(clause)} is non-automated and declares no required test layer. ${clauseProbe(clause)}`,
      },
    };
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
        rating: {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L4 proof meets the ${clauseIdentity(clause)} floor.`,
            detailRows
              .filter(
                ({ row, details }) =>
                  details.coverageRungs?.l4 === true ||
                  ((row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
                    details.targeted === true &&
                    SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')),
              )
              .map(({ row }) => row),
          ),
        },
      };
    }
    const waiver = l4WaiverOf(clause.exemption, now);
    if (waiver) {
      return {
        floor,
        rating: {
          rating: 'waived',
          evidence:
            `L4 for ${clauseIdentity(clause)} is explicitly waived by approvalRef=${waiver.approvalRef}: ` +
            `${waiver.justification}${waiver.expiresAt ? ` (expires ${waiver.expiresAt})` : ''}. ${clauseProbe(clause)}`,
        },
      };
    }
    const hasExplicitL4Miss = detailRows.some(({ details }) => details.coverageRungs?.l4 === false);
    return {
      floor,
      rating: {
        rating: hasExplicitL4Miss ? 'fail' : 'unknown',
        evidence: hasExplicitL4Miss
          ? evidenceWithBindings(
              `Bound coverage explicitly reports L4=false for ${clauseIdentity(clause)} and no current approved waiver exists.`,
              detailRows.filter(({ details }) => details.coverageRungs?.l4 === false).map(({ row }) => row),
            )
          : `${evidenceWithBindings(
              `No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for ${clauseIdentity(clause)}.`,
              evidence,
            )} ${clauseProbe(clause)}`,
        suggestion: 'Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision.',
      },
    };
  }
  const hasExplicitL3Miss = detailRows.some(({ details }) => details.coverageRungs?.l3 === false);
  return {
    floor,
    rating: meetsL3
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L3 intent proof meets the ${clauseIdentity(clause)} floor.`,
            detailRows.filter(({ details }) => details.coverageRungs?.l3 === true).map(({ row }) => row),
          ),
        }
      : {
          rating: hasExplicitL3Miss ? 'fail' : 'unknown',
          evidence: hasExplicitL3Miss
            ? evidenceWithBindings(
                `Bound coverage explicitly reports L3=false for ${clauseIdentity(clause)}.`,
                detailRows.filter(({ details }) => details.coverageRungs?.l3 === false).map(({ row }) => row),
              )
            : `${evidenceWithBindings(
                `No explicit meets_l3 result is bound for ${clauseIdentity(clause)}; depth or a generic passing test is not a rung verdict.`,
                evidence,
              )} ${clauseProbe(clause)}`,
          suggestion: 'Bind a coverage-census row whose independent meets_l3 flag is current.',
        },
  };
}

/**
 * Return the stable subject reference used by every spec-test-adequacy surface.
 * Keep the truncation deterministic so the write boundary and completion gate
 * cannot disagree about a long plan/spec identifier.
 */
export function specTestAdequacySubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

function rerunRecipeFor(
  clause: SpecClauseRevision,
  evidence: SpecEvidenceForAdequacy[],
  current: EvidenceCurrentInput[] | undefined,
  classRef: PlanClassRubricRef,
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
    classRef,
    // Submittable as-is. `selection` below spells planSlug/specId/specRevision/
    // specFingerprint, none of which the evaluator accepts — it takes slug/specIds and
    // REQUIRES classRef. Emitting only `selection` made every card's rerun recipe fail
    // its own evaluator with `invalid_args`, leaving a re-runner to guess classRef and
    // silently move plan-class-risk-floor.
    args: {
      slug: clause.planSlug,
      classRef,
      specIds: [clause.specId],
      includeDraft: true,
    },
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
        evidence: evidenceWithBindings(
          `${evidence.length} immutable binding(s) resolve ${clauseIdentity(clause)}.`,
          evidence,
        ),
      }
    : {
        rating: 'fail',
        evidence: `No immutable evidence binding resolves ${clauseIdentity(clause)}. ${clauseProbe(clause)}`,
        suggestion: 'Bind the work item and proof through plans:bind-spec-evidence.',
      };

  const fixtureApplicable =
    clause.requiredEvidence.some((entry) => /fixture/i.test(entry)) ||
    evidence.some((row) => row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null);
  ratings['fixture-calibration'] = fixtureApplicable
    ? booleanRating(evidence, (d) => d.fixtureCalibrated, {
        pass: 'An applicable binding explicitly attests fixtureCalibrated=true.',
        fail: 'Applicable binding metadata explicitly attests fixtureCalibrated=false.',
        unknown: 'A fixture is required or used, but no binding attests fixtureCalibrated=true/false.',
      })
    : {
        rating: 'not-applicable',
        evidence: `No fixture binding or fixture fingerprint is present for ${clauseIdentity(clause)}; the exact bindings inspected were ${bindingSummary(evidence)}.`,
      };

  // EI-22128161413448729: a self-attested `adequacy.falsifiable=true` flag is a WEAKER claim
  // than an actually-bound mutation/counterexample row with a killed/survived outcome — the two
  // must never share one evidence sentence, or an auditor reads "bound negative control" when
  // only an attestation exists. Branch the template on which basis is actually present.
  const boundMutationOrCounterexample = evidence.filter((row) => {
    const details = detailsOf(row);
    return (
      (row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
      SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')
    );
  });
  const attestedFalsifiableOnly = evidence.filter((row) => detailsOf(row).falsifiable === true);
  ratings.falsifiability =
    boundMutationOrCounterexample.length > 0
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `A bound mutation or counterexample binding demonstrates red capability for ${clauseIdentity(clause)}.`,
            boundMutationOrCounterexample,
          ),
        }
      : attestedFalsifiableOnly.length > 0
        ? {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Attested falsifiable by binder on ${attestedFalsifiableOnly.length} binding(s); no mutation or counterexample binding is bound for ${clauseIdentity(clause)}.`,
              attestedFalsifiableOnly,
            ),
          }
        : booleanRating(evidence, (d) => d.falsifiable, {
            pass: `A bound proof explicitly demonstrates falsifiability for ${clauseIdentity(clause)}.`,
            fail: `Bound metadata explicitly reports falsifiable=false for ${clauseIdentity(clause)}.`,
            unknown: `No bound evidence demonstrates how ${clauseIdentity(clause)} fails when behavior is wrong.`,
          });

  if (clause.requiredTestLayers.length === 0) {
    ratings['correct-layer'] = {
      rating: 'not-applicable',
      evidence: `The clause ${clauseIdentity(clause)} declares no required test layer. ${clauseProbe(clause)}`,
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
          evidence: `${evidenceWithBindings(
            `Required layer/path gaps for ${clauseIdentity(clause)}: ${[
              ...missing.map((layer) => `${layer}:missing`),
              ...unreachable.map((layer) => `${layer}:unreachable`),
            ].join(', ')}.`,
            evidence,
          )} ${clauseProbe(clause)}`,
          suggestion: 'Bind proof for every requiredTestLayer and attest that it reaches the real path.',
        }
      : unresolved.length
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Required layer(s) are represented but path reachability is unverified for ${clauseIdentity(clause)}: ${unresolved.join(', ')}.`,
              evidence.filter((row) => {
                const details = detailsOf(row);
                return (
                  typeof details.testLayer === 'string' &&
                  unresolved.includes(normalizedLayer(details.testLayer))
                );
              }),
            ),
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every required layer reaches the claimed path for ${clauseIdentity(clause)}: ${required.join(', ')}.`,
              evidence.filter((row) => {
                const details = detailsOf(row);
                return (
                  typeof details.testLayer === 'string' &&
                  required.includes(normalizedLayer(details.testLayer)) &&
                  details.pathReachable === true
                );
              }),
            ),
          };
  }

  ratings['oracle-independence'] = booleanRating(evidence, (d) => d.oracleIndependent, {
    pass: `A bound proof explicitly uses an implementation-independent oracle for ${clauseIdentity(clause)}.`,
    fail: `Bound metadata explicitly reports oracleIndependent=false for ${clauseIdentity(clause)}.`,
    unknown: `No bound evidence establishes oracle independence for ${clauseIdentity(clause)}.`,
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
        evidence: evidenceWithBindings(
          `At least one relied-on binding reports an uncollected, skipped, unexecuted, or failing outcome for ${clauseIdentity(clause)}.`,
          executable.filter((row) => {
            const d = detailsOf(row);
            return (
              d.collected === false ||
              d.skipped === true ||
              d.executed === false ||
              FAILURE_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
            );
          }),
        ),
      }
    : successfulExecution
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Bound proof was collected, not skipped, executed, and produced a successful outcome for ${clauseIdentity(clause)}.`,
            executable.filter((row) => {
              const d = detailsOf(row);
              return (
                d.collected === true &&
                d.skipped === false &&
                d.executed === true &&
                SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
              );
            }),
          ),
        }
      : {
          rating: executable.length ? 'unknown' : 'fail',
          evidence: executable.length
            ? evidenceWithBindings(
                `Executable bindings exist for ${clauseIdentity(clause)}, but collection/skip/execution/outcome metadata is incomplete.`,
                executable,
              )
            : `No executable test/check/mutation/counterexample/coverage/operational proof is bound for ${clauseIdentity(clause)}. ${clauseProbe(clause)}`,
        };

  const freshnessStates = evidence.map((row) => row.currentness.overall);
  ratings.freshness = freshnessStates.includes('stale')
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          `Stale binding(s) invalidate freshness for ${clauseIdentity(clause)}.`,
          evidence.filter((row) => row.currentness.overall === 'stale'),
        ),
      }
    : freshnessStates.includes('unknown')
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            `Current fingerprints are missing for: ${evidence
              .filter((row) => row.currentness.overall === 'unknown')
              .map((row) => row.evidenceRef)
              .join(', ')}.`,
            evidence.filter((row) => row.currentness.overall === 'unknown'),
          ),
        }
      : evidence.length
        ? {
            rating: 'pass',
            evidence: evidenceWithBindings(`Every bound proof dimension is current for ${clauseIdentity(clause)}.`, evidence),
          }
        : {
            rating: 'fail',
            evidence: `No evidence exists whose freshness can be established for ${clauseIdentity(clause)}. ${clauseProbe(clause)}`,
          };

  const risk = riskFloorRating(clause, classRef, evidence, input.now ?? new Date());
  ratings['plan-class-risk-floor'] = risk.rating;

  const wouldBlock = ADEQUACY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  const evidenceRefs = [...new Set(evidence.map((row) => row.evidenceRef))].sort();
  const rerunRecipe = rerunRecipeFor(clause, evidence, input.current, classRef);
  const subjectRef = specTestAdequacySubjectRef(
    rerunRecipe.selection.planSlug,
    rerunRecipe.selection.specId,
    rerunRecipe.selection.specRevision,
  );
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
