/** Per-clause spec-test-adequacy evaluator (P-006 / D-004..D-006, D-009). */
import { getBuildInfo } from '../../build-info';
import { SPEC_PROOF_OBLIGATION_ID_RE, type SpecBehaviorClass, type SpecClauseRevision } from './spec-clauses-store';
import type {
  EvidenceCurrentInput,
  EvidenceCurrentness,
  ProvisionalScorecardProof,
  SpecEvidenceKind,
} from './spec-evidence-store';
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
  id?: number;
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
  observedAt?: string;
  createdAt?: string;
  currentness: EvidenceCurrentness;
  /** True when evidenceRef resolves to a provisional scorecard working note. */
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
}

/**
 * Bindings are immutable history, but adequacy grades the active VERSION of a
 * logical evidence reference. A corrected re-bind must not remain poisoned by
 * an older incomplete row with the same work item/spec/kind/ref.
 */
export function latestLogicalEvidence(rows: readonly SpecEvidenceForAdequacy[]): SpecEvidenceForAdequacy[] {
  const selected = new Map<string, { row: SpecEvidenceForAdequacy; index: number }>();
  // A logical correction is a newer APPEND, not a later claimed observation.
  // `observedAt` is caller-authored evidence metadata and may be skewed or even
  // future-dated; letting it order versions makes an old row permanently poison
  // every later correction. `createdAt` is server-authored, with the immutable DB
  // id and input order as deterministic fallbacks for legacy/test rows.
  const appendTimestamp = (row: SpecEvidenceForAdequacy): number => {
    const value = Date.parse(row.createdAt ?? '');
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  rows.forEach((row, index) => {
    const key = [row.workItemId, row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef].join(
      '\0',
    );
    const prior = selected.get(key);
    if (!prior) {
      selected.set(key, { row, index });
      return;
    }
    const rowTs = appendTimestamp(row);
    const priorTs = appendTimestamp(prior.row);
    const rowId = row.id ?? Number.NEGATIVE_INFINITY;
    const priorId = prior.row.id ?? Number.NEGATIVE_INFINITY;
    if (rowTs > priorTs || (rowTs === priorTs && (rowId > priorId || (rowId === priorId && index > prior.index)))) {
      selected.set(key, { row, index });
    }
  });
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ row }) => row);
}

export type SpecEvidenceLineage = 'durable' | 'ephemeral' | 'unknown';

export interface SpecEvidenceLineageAssessment {
  lineage: SpecEvidenceLineage;
  reason: string;
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
  scenarioIds?: string[];
  causalPairIds?: string[];
  contractMetadataIssues?: string[];
  provisionalProofBase?: boolean;
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
const REPAIRED_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded']);
const FAILURE_OUTCOMES = new Set(['fail', 'failed', 'error', 'timed-out', 'timeout', 'survived']);
const EXECUTABLE_EVIDENCE_KINDS = new Set<SpecEvidenceKind>([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);

const DURABLE_WORK_ITEM_REF_RE = /\b(?:WI|EI|F)-\d+\b/i;
const DURABLE_ARTIFACT_REF_RE =
  /\b(?:artifact|artifact[-_ ]?ref|artifact[-_ ]?id)\s*(?:[:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_TEST_RUN_REF_RE =
  /\b(?:test[-_ ]?run|testing[-_ ]?run)(?:[-_ ]?id)?\s*(?:[-:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_COVERAGE_REF_RE = /\bcoverage(?:[-_ ]?(?:evidence|run))(?:[-_ ]?id)?\s*[:/#=]\s*\d+\b/i;
const DURABLE_FILE_REF_RE =
  /(?:^|[\s:(])(?:(?:file|path|repo-file):(?:\/\/)?|(?:\.\.\/|\.\/)?)(?:apps|packages|libs|scripts|src|lib|test|tests|bin|docs|rubrics)\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?:[#:].*)?$/i;
const DURABLE_ABSOLUTE_FILE_REF_RE =
  /^(?!\/?(?:tmp|var\/tmp)(?:\/|$))\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?:[#:].*)?$/i;

function ephemeralEvidenceRefReason(evidenceRef: string): string | null {
  const normalized = evidenceRef.trim().replaceAll('\\', '/');
  if (/(^|\/)(?:tmp|var\/tmp)(?:\/|$)/i.test(normalized)) return 'temporary filesystem path';
  if (/(?:^|[\s:/#])bash(?:$|[\s:/#])/i.test(normalized)) return 'bash/session-local command reference';
  if (/\bsession[-_ ]local\b/i.test(normalized)) return 'session-local reference';
  if (/\bephemeral\b/i.test(normalized)) return 'ephemeral reference';
  return null;
}

/**
 * A binding row is durable only when its proof can be found again by another
 * evaluator. The work-item/spec edge itself is deliberately not an anchor:
 * every binding has one, and it does not identify a rerunnable proof.
 */
export function classifySpecEvidenceLineage(
  evidence: Pick<SpecEvidenceForAdequacy, 'evidenceRef' | 'coverageEvidenceRef' | 'testRunId'>,
): SpecEvidenceLineageAssessment {
  const evidenceRef = evidence.evidenceRef.trim();
  const ephemeralReason = ephemeralEvidenceRefReason(evidenceRef);
  const hasCoverageId = Number.isSafeInteger(evidence.coverageEvidenceRef) && evidence.coverageEvidenceRef! > 0;
  const hasTestRunId = Number.isSafeInteger(evidence.testRunId) && evidence.testRunId! > 0;
  if (hasTestRunId) return { lineage: 'durable', reason: 'durable testRunId' };
  if (hasCoverageId) return { lineage: 'durable', reason: 'durable coverageEvidenceRef' };
  if (
    DURABLE_WORK_ITEM_REF_RE.test(evidenceRef) ||
    DURABLE_ARTIFACT_REF_RE.test(evidenceRef) ||
    DURABLE_TEST_RUN_REF_RE.test(evidenceRef) ||
    DURABLE_COVERAGE_REF_RE.test(evidenceRef) ||
    DURABLE_FILE_REF_RE.test(evidenceRef) ||
    DURABLE_ABSOLUTE_FILE_REF_RE.test(evidenceRef)
  ) {
    return { lineage: 'durable', reason: 'explicit durable evidence reference' };
  }
  if (ephemeralReason) return { lineage: 'ephemeral', reason: ephemeralReason };
  return { lineage: 'unknown', reason: 'no durable rerun anchor' };
}

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
  const contractMetadataIssues: string[] = [];
  const idList = (key: 'scenarioIds' | 'causalPairIds'): string[] | undefined => {
    if (!(key in raw)) return undefined;
    const value = raw[key];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((id) => typeof id !== 'string' || !SPEC_PROOF_OBLIGATION_ID_RE.test(id.trim())) ||
      new Set(value.map((id) => (typeof id === 'string' ? id.trim() : ''))).size !== value.length
    ) {
      contractMetadataIssues.push(`${key}:invalid`);
      return undefined;
    }
    return value.map((id) => id.trim()).sort();
  };
  const scenarioIds = idList('scenarioIds');
  const causalPairIds = idList('causalPairIds');
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
    ...(scenarioIds ? { scenarioIds } : {}),
    ...(causalPairIds ? { causalPairIds } : {}),
    ...(contractMetadataIssues.length > 0 ? { contractMetadataIssues } : {}),
    ...(evidence.provisionalProofBase === true || raw.provisionalProofBase === true
      ? { provisionalProofBase: true }
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
  const args = JSON.stringify({
    slug: clause.planSlug,
    specIds: [clause.specId],
  });
  return (
    `Probe plans:get-spec-evidence with args=${args}. ` +
    `This selects the canonical current revision for ${clause.specId}@${clause.revision} ` +
    `(fingerprint ${JSON.stringify(clause.contentHash)}); the read has no direct revision or fingerprint selector.`
  );
}

function bindingDescription(row: SpecEvidenceForAdequacy): string {
  const details = detailsOf(row);
  const lineage = classifySpecEvidenceLineage(row);
  const fields = [
    `kind=${row.evidenceKind}`,
    `ref=${JSON.stringify(row.evidenceRef)}`,
    `lineage=${lineage.lineage}`,
    `lineageReason=${JSON.stringify(lineage.reason)}`,
    details.provisionalProofBase ? 'provisionalProofBase=true' : null,
    row.provisionalScorecard ? `provisionalScorecard=${JSON.stringify(row.provisionalScorecard)}` : null,
    `currentness=${row.currentness.overall}`,
    `currentnessProvenance=${row.currentness.provenance ?? 'legacy-implicit'}`,
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
    details.scenarioIds ? `scenarioIds=${JSON.stringify(details.scenarioIds)}` : null,
    details.causalPairIds ? `causalPairIds=${JSON.stringify(details.causalPairIds)}` : null,
    details.contractMetadataIssues ? `contractMetadataIssues=${JSON.stringify(details.contractMetadataIssues)}` : null,
    row.currentness.staleReasons.length > 0 ? `staleReasons=${JSON.stringify(row.currentness.staleReasons)}` : null,
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

/**
 * Presence-and-sign ONLY, deliberately — this is not where fakery is stopped.
 *
 * REFERENTIAL EXISTENCE IS ENFORCED IN POSTGRES, at bind time, by the
 * `spec_evidence_bindings_validate_refs` BEFORE INSERT trigger installed in
 * migration 855 (`harness_shared.validate_spec_evidence_binding_refs`). It
 * rejects a `test_run_id` / `coverage_evidence_ref` that does not resolve with
 * ERRCODE 23503, and matches on `workspace_id` AND `harness_slug`, so a
 * fabricated or cross-tenant id can never reach a row this function ever sees.
 *
 * Read this predicate on its own and `execution-integrity` looks trivially
 * fakeable (`testRunId: 1` would satisfy it). That reading is wrong, and it has
 * cost a bogus bug filing at least once — EI-22684973731417610, filed against
 * this exact function and retracted after the trigger was verified live via
 * pg_trigger + pg_get_functiondef. Audit the DB before concluding the ledger
 * reference is unchecked.
 *
 * Corollary worth knowing: because the trigger matches harness_slug exactly, a
 * test run recorded under a DIFFERENT harness than the binding (or with the
 * NULL scope that CI/dogfood-reporter rows carry by design) cannot be bound as
 * evidence at all.
 */
function hasExecutionLedgerReference(row: SpecEvidenceForAdequacy): boolean {
  return (
    (Number.isSafeInteger(row.testRunId) && row.testRunId! > 0) ||
    (Number.isSafeInteger(row.coverageEvidenceRef) && row.coverageEvidenceRef! > 0)
  );
}

function isSuccessfulExecutableEvidence(row: SpecEvidenceForAdequacy): boolean {
  const details = detailsOf(row);
  return (
    EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind) &&
    hasExecutionLedgerReference(row) &&
    details.collected === true &&
    details.skipped === false &&
    details.executed === true &&
    SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')
  );
}

function isSuccessfulRepairedEvidence(row: SpecEvidenceForAdequacy): boolean {
  const details = detailsOf(row);
  return isSuccessfulExecutableEvidence(row) && REPAIRED_OUTCOMES.has(details.outcome?.toLowerCase() ?? '');
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

export function requiredProofFloor(clause: SpecClauseRevision, classRef: PlanClassRubricRef): 'none' | 'l3' | 'l4' {
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
  const isL4Proof = ({ row, details }: (typeof detailRows)[number]): boolean =>
    details.coverageRungs?.l4 === true ||
    ((row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
      details.targeted === true &&
      SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? ''));
  const meetsL4 = detailRows.some(isL4Proof);
  const meetsL3 = meetsL4 || detailRows.some(({ details }) => details.coverageRungs?.l3 === true);
  const meetsL3Rows = detailRows.filter(
    ({ row, details }) => details.coverageRungs?.l3 === true || isL4Proof({ row, details }),
  );
  if (floor === 'l4') {
    if (meetsL4) {
      return {
        floor,
        rating: {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L4 proof meets the ${clauseIdentity(clause)} floor.`,
            detailRows.filter(isL4Proof).map(({ row }) => row),
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
            `Targeted L3 or stronger proof meets the ${clauseIdentity(clause)} floor.`,
            meetsL3Rows.map(({ row }) => row),
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
  harness: string | undefined,
  classRef: PlanClassRubricRef,
  selection: { workItemIds?: string[]; evidenceRefs?: string[]; planItemIds?: string[] } | undefined,
): SpecTestAdequacyRerunRecipe {
  const evaluatorBuild = getBuildInfo();
  const selectedEvidence = [
    ...new Map(
      evidence.map((row) => [
        `${row.evidenceKind}\0${row.evidenceRef}`,
        {
          evidenceKind: row.evidenceKind,
          evidenceRef: row.evidenceRef,
        },
      ]),
    ).values(),
  ].sort((a, b) => `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`));
  const selectedKeys = new Set(selectedEvidence.map((row) => `${row.evidenceKind}\0${row.evidenceRef}`));
  const selectedEvidenceRefs = [...new Set(selectedEvidence.map((row) => row.evidenceRef))].sort((a, b) =>
    a.localeCompare(b),
  );
  // Preserve an explicit caller selector even when the in-memory evidence rows
  // are empty for this clause (for example, an uncovered or legacy binding).
  // Omitting it would widen the persisted recipe into an unfiltered replay.
  const replayEvidenceRefs = selectedEvidenceRefs.length > 0
    ? selectedEvidenceRefs
    : [...new Set(selection?.evidenceRefs ?? [])].sort((a, b) => a.localeCompare(b));
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
    .sort((a, b) => `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`));
  return {
    schemaVersion: 1,
    evaluator: 'plans:evaluate-spec-test-adequacy',
    evaluatorBuild: {
      sha: evaluatorBuild.sha,
      version: evaluatorBuild.version,
    },
    classRef,
    // Submittable as-is. `selection` below spells planSlug/specId/specRevision/
    // specFingerprint, none of which the evaluator accepts — it takes slug/specIds and
    // REQUIRES classRef. Emitting only `selection` made every card's rerun recipe fail
    // its own evaluator with `invalid_args`, leaving a re-runner to guess classRef and
    // silently move plan-class-risk-floor.
    args: {
      ...(harness !== undefined ? { harness } : {}),
      slug: clause.planSlug,
      classRef,
      specIds: [clause.specId],
      ...(selection?.workItemIds?.length ? { workItemIds: [...selection.workItemIds] } : {}),
      // The recipe must replay the exact evidence population the evaluator graded,
      // even when the caller selected it indirectly through a work item or plan
      // item. Reusing only the caller's optional evidenceRefs would let later
      // bindings silently widen a persisted scorecard's replay.
      ...(replayEvidenceRefs.length ? { evidenceRefs: replayEvidenceRefs } : {}),
      ...(selection?.planItemIds?.length ? { planItemIds: [...selection.planItemIds] } : {}),
      includeDraft: true,
      // Fingerprints classify the selected bindings; the selectors above define
      // the population. Keeping those roles separate prevents a partial current[]
      // input from silently excluding an unmeasured historical binding.
      ...(current !== undefined ? { current: fingerprints } : {}),
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

function appendRatingRerunProbes(
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>,
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): void {
  const args = JSON.stringify(rerunRecipe.args);
  for (const criterion of ADEQUACY_CRITERIA) {
    const rating = ratings[criterion];
    ratings[criterion] = {
      ...rating,
      evidence:
        `${rating.evidence} Re-run ${rerunRecipe.evaluator} with args=${args}; ` +
        `inspect rows[0].ratings[${JSON.stringify(criterion)}].`,
    };
  }
}

/** Grade one clause/evidence row into the exact ratings map accepted by scorecards:emit. */
export function evaluateSpecTestAdequacy(input: {
  clause: SpecClauseRevision;
  evidence: SpecEvidenceForAdequacy[];
  classRef: PlanClassRubricRef;
  /** Resolved harness scope to persist for operator-scope reruns. */
  harness?: string;
  /** The caller-attested current fingerprints used by listSpecEvidence. */
  current?: EvidenceCurrentInput[];
  /** Exact caller selectors that constrain the evidence population on replay. */
  rerunSelection?: { workItemIds?: string[]; evidenceRefs?: string[]; planItemIds?: string[] };
  now?: Date;
}): SpecTestAdequacyResult {
  const { clause, classRef } = input;
  const exactEvidence = latestLogicalEvidence(
    input.evidence.filter(
      (row) =>
        row.planSlug === clause.planSlug &&
        row.specId === clause.specId &&
        row.specRevision === clause.revision &&
        row.specFingerprint === clause.contentHash,
    ),
  );
  const currentEvidence = exactEvidence.filter(
    (row) =>
      row.currentness.overall === 'current' ||
      (row.currentness.overall === 'unknown' && row.currentness.provenance === 'attested-current'),
  );
  // A caller-supplied `current[]` is a per-binding comparison input, not a population
  // selector. Keep every exact binding in that case so an omitted fingerprint remains
  // visible as unknown instead of silently disappearing from the graded population. The
  // historical current-cohort behavior is retained only for internally/server-classified
  // evidence when no caller comparison input was supplied.
  const evidence =
    input.current !== undefined ? exactEvidence : currentEvidence.length > 0 ? currentEvidence : exactEvidence;
  const ratings = {} as Record<AdequacyCriterion, AdequacyRatingEntry>;

  const lineageAssessments = evidence.map((row) => ({ row, assessment: classifySpecEvidenceLineage(row) }));
  const ephemeralEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'ephemeral')
    .map(({ row }) => row);
  const unknownLineageEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'unknown')
    .map(({ row }) => row);
  ratings.traceability = !evidence.length
    ? {
        rating: 'fail',
        evidence: `No immutable evidence binding resolves ${clauseIdentity(clause)}. ${clauseProbe(clause)}`,
        suggestion: 'Bind the work item and proof through plans:bind-spec-evidence.',
      }
    : ephemeralEvidence.length > 0
      ? {
          rating: 'fail',
          evidence: evidenceWithBindings(
            `Ephemeral-only evidence cannot establish independently rerunnable traceability for ${clauseIdentity(clause)}.`,
            ephemeralEvidence,
          ),
          suggestion:
            'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
        }
      : unknownLineageEvidence.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Evidence lineage is not anchored to a durable rerunnable record for ${clauseIdentity(clause)}.`,
              unknownLineageEvidence,
            ),
            suggestion:
              'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `${evidence.length} immutable binding(s) have durable rerunnable lineage for ${clauseIdentity(clause)}.`,
              evidence,
            ),
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

  let layerRating: AdequacyRatingEntry;
  if (clause.requiredTestLayers.length === 0) {
    layerRating = {
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
    layerRating =
      missing.length || unreachable.length
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
                    typeof details.testLayer === 'string' && unresolved.includes(normalizedLayer(details.testLayer))
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

  const requiredScenarios = [...new Set(clause.falsifier?.requiredScenarios ?? [])].sort();
  let scenarioRating: AdequacyRatingEntry | null = null;
  if (requiredScenarios.length > 0) {
    const malformedScenarioRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('scenarioIds:invalid'),
    );
    const successfulScenarioRows = evidence.filter(
      (row) => isSuccessfulExecutableEvidence(row) && detailsOf(row).pathReachable === true,
    );
    const covered = new Set(successfulScenarioRows.flatMap((row) => detailsOf(row).scenarioIds ?? []));
    const missing = requiredScenarios.filter((scenario) => !covered.has(scenario));
    scenarioRating =
      missing.length > 0
        ? {
            rating: 'fail',
            evidence: evidenceWithBindings(
              `Canonical acceptance scenario(s) are not covered by successful ledger-backed path proof for ${clauseIdentity(clause)}: ${missing.join(', ')}. Required scenarios: ${requiredScenarios.join(', ')}.`,
              successfulScenarioRows,
            ),
            suggestion:
              'Bind successful executed proof whose adequacy.scenarioIds cover every falsifier.requiredScenarios id.',
          }
        : malformedScenarioRows.length > 0
          ? {
              rating: 'unknown',
              evidence: evidenceWithBindings(
                `All named scenarios are represented, but malformed scenarioIds metadata prevents a complete scenario-cohort verdict for ${clauseIdentity(clause)}.`,
                malformedScenarioRows,
              ),
              suggestion: 'Supersede malformed bindings with schema-valid adequacy.scenarioIds.',
            }
          : {
              rating: 'pass',
              evidence: evidenceWithBindings(
                `Every canonical acceptance scenario has successful ledger-backed path proof for ${clauseIdentity(clause)}: ${requiredScenarios.join(', ')}.`,
                successfulScenarioRows.filter((row) =>
                  (detailsOf(row).scenarioIds ?? []).some((scenario) => requiredScenarios.includes(scenario)),
                ),
              ),
            };
  }
  if (scenarioRating === null) {
    ratings['correct-layer'] = layerRating;
  } else {
    const combinedRating: AdequacyRating =
      layerRating.rating === 'fail' || scenarioRating.rating === 'fail'
        ? 'fail'
        : layerRating.rating === 'unknown' || scenarioRating.rating === 'unknown'
          ? 'unknown'
          : 'pass';
    ratings['correct-layer'] = {
      rating: combinedRating,
      evidence: `${layerRating.evidence} Scenario completeness: ${scenarioRating.evidence}`,
      ...([layerRating.suggestion, scenarioRating.suggestion].filter(Boolean).length > 0
        ? { suggestion: [layerRating.suggestion, scenarioRating.suggestion].filter(Boolean).join(' ') }
        : {}),
    };
  }

  ratings['oracle-independence'] = booleanRating(evidence, (d) => d.oracleIndependent, {
    pass: `A bound proof explicitly uses an implementation-independent oracle for ${clauseIdentity(clause)}.`,
    fail: `Bound metadata explicitly reports oracleIndependent=false for ${clauseIdentity(clause)}.`,
    unknown: `No bound evidence establishes oracle independence for ${clauseIdentity(clause)}.`,
  });

  const executable = evidence.filter((row) => EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind));
  const unbackedExecution = executable.filter((row) => !hasExecutionLedgerReference(row));
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
    return (
      hasExecutionLedgerReference(row) &&
      d.collected === true &&
      d.skipped === false &&
      d.executed === true &&
      SUCCESS_OUTCOMES.has(d.outcome?.toLowerCase() ?? '')
    );
  });
  const executionRating: AdequacyRatingEntry = explicitBadExecution
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
    : unbackedExecution.length > 0
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            `Executable binding(s) attest execution details but have no testRunId or coverageEvidenceRef in the execution ledger for ${clauseIdentity(clause)}; author-attested booleans cannot establish execution-integrity.`,
            unbackedExecution,
          ),
          suggestion:
            'Bind a recorded testRunId or coverageEvidenceRef; details.adequacy booleans alone are insufficient.',
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

  let causalPairRating: AdequacyRatingEntry | null = null;
  if (clause.falsifier?.causalPairing === 'one-to-one') {
    const canonicalPairIds = [...new Set(clause.falsifier.requiredScenarios ?? [])].sort();
    const malformedPairRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('causalPairIds:invalid'),
    );
    const negativeRows = evidence.filter(
      (row) => row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample',
    );
    const recurrenceRows = evidence.filter(
      (row) =>
        row.evidenceKind !== 'mutation' &&
        row.evidenceKind !== 'counterexample' &&
        detailsOf(row).causalPairIds !== undefined,
    );
    const violations: string[] = [];
    const negativeByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const recurrenceByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const add = (target: Map<string, SpecEvidenceForAdequacy[]>, pairId: string, row: SpecEvidenceForAdequacy) =>
      target.set(pairId, [...(target.get(pairId) ?? []), row]);

    for (const row of malformedPairRows) violations.push(`${row.evidenceRef}:malformed causalPairIds`);
    if (negativeRows.length === 0) violations.push('no mutation/counterexample binding declares the original failure');
    for (const row of negativeRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the negative binding`);
        continue;
      }
      add(negativeByPair, details.causalPairIds[0]!, row);
    }
    for (const row of recurrenceRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the recurrence binding`);
        continue;
      }
      add(recurrenceByPair, details.causalPairIds[0]!, row);
    }
    const pairIds = [...new Set([...negativeByPair.keys(), ...recurrenceByPair.keys()])].sort();
    if (canonicalPairIds.length > 0) {
      const missingCanonicalPairs = canonicalPairIds.filter((pairId) => !pairIds.includes(pairId));
      const unexpectedPairs = pairIds.filter((pairId) => !canonicalPairIds.includes(pairId));
      if (missingCanonicalPairs.length > 0) {
        violations.push(`canonical causalPairId(s) missing: ${missingCanonicalPairs.join(', ')}`);
      }
      if (unexpectedPairs.length > 0) {
        violations.push(`causalPairId(s) not named by requiredScenarios: ${unexpectedPairs.join(', ')}`);
      }
    }
    for (const pairId of pairIds) {
      const negatives = negativeByPair.get(pairId) ?? [];
      const recurrences = recurrenceByPair.get(pairId) ?? [];
      if (negatives.length !== 1) violations.push(`${pairId}:expected 1 negative binding, found ${negatives.length}`);
      if (recurrences.length !== 1)
        violations.push(`${pairId}:expected 1 recurrence binding, found ${recurrences.length}`);
      if (negatives.length === 1 && !isSuccessfulExecutableEvidence(negatives[0]!)) {
        violations.push(`${pairId}:negative binding is not successful ledger-backed counterexample proof`);
      }
      if (recurrences.length === 1 && !isSuccessfulRepairedEvidence(recurrences[0]!)) {
        violations.push(`${pairId}:recurrence binding is not successful ledger-backed repaired proof`);
      }
    }
    causalPairRating =
      violations.length > 0
        ? {
            rating: 'fail',
            evidence: evidenceWithBindings(
              `The canonical one-to-one causal-pair contract is incomplete for ${clauseIdentity(clause)}: ${violations.join('; ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
            suggestion:
              'Bind exactly one successful ledger-backed mutation/counterexample row and one successful repaired row for each stable adequacy.causalPairIds id.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every original failure has exactly one successful ledger-backed negative and repaired recurrence binding for ${clauseIdentity(clause)}: ${pairIds.join(', ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
          };
  }
  if (causalPairRating === null) {
    ratings['execution-integrity'] = executionRating;
  } else {
    const combinedRating: AdequacyRating =
      executionRating.rating === 'fail' || causalPairRating.rating === 'fail'
        ? 'fail'
        : executionRating.rating === 'unknown' || causalPairRating.rating === 'unknown'
          ? 'unknown'
          : 'pass';
    ratings['execution-integrity'] = {
      rating: combinedRating,
      evidence: `${executionRating.evidence} Causal pairing: ${causalPairRating.evidence}`,
      ...([executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).length > 0
        ? { suggestion: [executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).join(' ') }
        : {}),
    };
  }

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
            (() => {
              const unknownEvidence = evidence.filter((row) => row.currentness.overall === 'unknown');
              const refs = unknownEvidence.map((row) => row.evidenceRef).join(', ');
              const callerOmittedCurrent = unknownEvidence.some((row) => !row.currentness.comparisonSupplied);
              const callerAttestedCurrent = unknownEvidence.some(
                (row) => row.currentness.provenance === 'attested-current',
              );
              const partiallyServerMeasured = unknownEvidence.filter(
                (row) => row.currentness.provenance === 'partially-server-measured',
              );
              return partiallyServerMeasured.length > 0
                ? `Repository fingerprints were server-measured, but applicable non-repository dimensions ` +
                    `were only caller-attested and cannot establish freshness for: ${partiallyServerMeasured
                      .map((row) => row.evidenceRef)
                      .join(', ')}.`
                : callerAttestedCurrent
                  ? `Current fingerprints were caller-supplied and are labeled attested-current; matching stored values cannot establish independently measured freshness, so freshness is unknown for this replay input. Missing comparison for: ${refs}.`
                  : callerOmittedCurrent
                    ? `Current fingerprints were not supplied by this call (current[] was omitted), so freshness is unknown for this replay input—not evidence that stored bindings are stale. If replaying a rerunRecipe, pass rerunRecipe.current.fingerprints. Missing comparison for: ${refs}.`
                    : `Current fingerprints are missing for: ${refs}.`;
            })(),
            evidence.filter((row) => row.currentness.overall === 'unknown'),
          ),
        }
      : evidence.length
        ? {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every bound proof dimension is current for ${clauseIdentity(clause)}.`,
              evidence,
            ),
          }
        : {
            rating: 'fail',
            evidence: `No evidence exists whose freshness can be established for ${clauseIdentity(clause)}. ${clauseProbe(clause)}`,
          };

  const risk = riskFloorRating(clause, classRef, evidence, input.now ?? new Date());
  ratings['plan-class-risk-floor'] = risk.rating;

  const rerunRecipe = rerunRecipeFor(clause, evidence, input.current, input.harness, classRef, input.rerunSelection);
  appendRatingRerunProbes(ratings, rerunRecipe);

  const wouldBlock = ADEQUACY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  const evidenceRefs = [...new Set(evidence.map((row) => row.evidenceRef))].sort();
  const subjectRef = specTestAdequacySubjectRef(
    rerunRecipe.selection.planSlug,
    rerunRecipe.selection.specId,
    rerunRecipe.selection.specRevision,
  );
  const rawRefs = evidenceRefs.join(', ') || '(none)';
  const bodyRefs =
    rawRefs.length <= 7_000 ? rawRefs : `${rawRefs.slice(0, 6_980)}… (see evidenceRefs for the full set)`;
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
