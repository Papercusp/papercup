/**
 * Acceptance BAR contract snapshot — one bounded, versioned read model over the
 * existing plan/rubric/spec/evidence/grading authorities.
 *
 * The snapshot is deliberately NOT a table and NOT a second validator. Writers keep
 * owning their canonical rows; this module reads each source once, records exact
 * revisions/boundedness, and projects a deterministic contract that lifecycle gates
 * can evaluate without rebuilding their own partial joins.
 */
import { createHash } from 'node:crypto';
import type { SelectionVia } from '@papercusp/ranked-selection';
import { getOrgPg } from '@papercusp/db-org';
import {
  computeAcceptanceBarHash,
  computeAcceptanceBarSetHash,
  getAcceptanceRubricsForPlan,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import { listSpecClauses, type SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import { listSpecEvidence, type EvidenceCurrentInput } from './agent-tools/plans/spec-evidence-store';
import { evaluateSpecTestAdequacy, PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './agent-tools/plans/spec-test-adequacy';
import { listScorecardPage, type ScorecardRow } from './scorecards';
import { activeWorkspaceId } from './workspace-registry';
import { lineagePartyKeys } from './acceptance-author-identity';
import { gradingViaOf, pickAuthoritativeGrading, readGraderSelectionVia } from './acceptance-grading-authority';
import { parseWorkedByHistory } from './work-item-prior-work';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';
import { requirementSections } from './requirement-contract';
import {
  ACCEPTANCE_BAR_CONTRACT_EPOCH,
  MAX_BAR_PROJECTION_EDGES,
  MAX_REQUIREMENT_BARS,
  type AcceptanceBarCohort,
} from './acceptance-bar-seed';

export const ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION = 1 as const;
export const ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT = 2;
export const ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT = 500;
export const ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT = 2_000;
export const ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT = 50;
export const ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT = 1_000;

export type AcceptanceBarSnapshotSource =
  | 'plan'
  | 'rubric'
  | 'plan-items'
  | 'clauses'
  | 'work-contracts'
  | 'evidence'
  | 'lineage'
  | 'lineage-parties'
  | 'grading'
  | 'vetting';

export type AcceptanceBarSnapshotCode =
  | 'bar_snapshot_source_unavailable'
  | 'bar_snapshot_source_truncated'
  | 'bar_snapshot_plan_missing'
  | 'bar_snapshot_plan_ambiguous'
  | 'bar_snapshot_cohort_incomplete'
  | 'bar_snapshot_rubric_missing'
  | 'bar_snapshot_rubric_ambiguous'
  | 'bar_snapshot_rubric_revision_mismatch'
  | 'bar_snapshot_bar_set_empty'
  | 'bar_snapshot_bar_set_too_large'
  | 'bar_snapshot_bar_key_duplicate'
  | 'bar_snapshot_bar_hash_missing'
  | 'bar_snapshot_bar_hash_mismatch'
  | 'bar_snapshot_bar_set_hash_mismatch'
  | 'bar_snapshot_bar_provenance_missing'
  | 'bar_snapshot_mapping_missing'
  | 'bar_snapshot_mapping_dropped_only'
  | 'bar_snapshot_projection_stale'
  | 'bar_snapshot_method_missing'
  | 'bar_snapshot_work_contract_missing'
  | 'bar_snapshot_work_contract_stale'
  | 'bar_snapshot_proof_missing'
  | 'bar_snapshot_proof_stale'
  | 'bar_snapshot_grading_missing'
  | 'bar_snapshot_grading_stale'
  | 'bar_snapshot_grading_not_pass'
  | 'bar_snapshot_vetting_missing'
  | 'bar_snapshot_vetting_stale'
  | 'bar_snapshot_author_verdict_missing'
  | 'bar_snapshot_author_verdict_stale'
  | 'bar_snapshot_author_rejected'
  // P-003 lifecycle contract checks. These are deliberately separate from the
  // phase evaluator: the snapshot remains an explainable read model while the
  // evaluator decides which of these become blocking at each door.
  | 'bar_snapshot_falsifier_missing'
  | 'bar_snapshot_role_invalid'
  | 'bar_snapshot_mandatory_invalid'
  | 'bar_snapshot_scope_invalid'
  | 'bar_snapshot_pass_ratings_invalid'
  | 'bar_snapshot_coverage_invalid'
  | 'bar_snapshot_check_missing'
  | 'bar_snapshot_check_invalid'
  | 'bar_snapshot_proof_uncertain'
  | 'bar_snapshot_proof_depth_missing'
  | 'bar_snapshot_proof_inadequate'
  | 'bar_snapshot_evidence_plane_unmet';

export interface BoundedAcceptanceBarRows<T> {
  rows: T[];
  limit: number;
  truncated: boolean;
}

export interface AcceptanceBarSubjectPlanSource {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  status: string | null;
  revision: number;
  contentHash: string | null;
  adoptionEpoch: number | null;
  cohort: AcceptanceBarCohort | null;
  barSetHash: string | null;
  rubricSlug: string | null;
  rubricRevision: number | null;
  seededAt: string | null;
  seededBy: string | null;
}

export interface AcceptanceBarPlanItemSource {
  itemId: string;
  status: string;
}

export interface AcceptanceBarWorkContractSource {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
}

export type AcceptanceBarEvidenceSource = Awaited<ReturnType<typeof listSpecEvidence>>[number];

export interface AcceptanceBarLineageSource {
  identities: string[];
  workItemRowsRead: number;
  auditRowsRead: number;
  rowLimit: number;
  truncated: boolean;
}

export interface AcceptanceBarSnapshotProblem {
  code: AcceptanceBarSnapshotCode;
  source: AcceptanceBarSnapshotSource;
  severity: 'error' | 'warning';
  detail: string;
  barKey?: string;
}

export interface AcceptanceBarContractSnapshotInput {
  planRows: BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>;
  rubrics: BoundedAcceptanceBarRows<Rubric>;
  planItems: BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>;
  clauses: BoundedAcceptanceBarRows<SpecClauseRevision>;
  workContracts: BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>;
  evidence: BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>;
  scorecards: BoundedAcceptanceBarRows<ScorecardRow>;
  vettingScorecards: BoundedAcceptanceBarRows<ScorecardRow>;
  lineage: AcceptanceBarLineageSource;
  partyByIdentity: ReadonlyMap<string, string>;
  graderSelectionVia: ReadonlyMap<string, SelectionVia>;
  readFailures?: Partial<Record<AcceptanceBarSnapshotSource, string>>;
}

export interface AcceptanceBarTrace {
  barKey: string;
  criterionKey: string;
  /** Additive read fields; older cached snapshots may omit them. */
  title?: string;
  requirement?: ReturnType<typeof requirementSections>;
  barHash: string | null;
  model: string;
  method: string;
  /** Structured verification contract, when declared. Required from pre-vetting onward. */
  check: RubricCriterion['check'] | null;
  /** Explicit manual replication procedure, when the check uses instrument:'none'. */
  replication: string | null;
  falsifier: string;
  role: string | null;
  mandatory: boolean | null;
  requiredScope: string[];
  evidencePlane: 'tree' | 'deployed' | 'live' | null;
  requiredTestLayers?: string[];
  passRatings: string[];
  coversBarKeys: string[];
  provenance: RubricCriterion['barProvenance'] | null;
  mappings: Array<{
    planItemId: string;
    planItemStatus: string | null;
    specId: string;
    sourceValId?: string | null;
    specRevision: number;
    specContentHash: string;
    sourceBarHash: string | null;
    sourceBarSetHash: string | null;
    sourceRubricRevision: number | null;
    evidencePlane: 'tree' | 'deployed' | 'live' | null;
  }>;
  workContracts: Array<{
    workItemId: string;
    specId: string;
    specRevision: number;
    specFingerprint: string;
    current: boolean;
  }>;
  proof: {
    state: 'current' | 'stale' | 'missing' | 'truncated';
    history?: Array<Pick<AcceptanceBarEvidenceSource,
      'id' | 'workItemId' | 'specId' | 'specRevision' | 'specFingerprint' | 'evidenceKind' |
      'evidenceRef' | 'testRunId' | 'observedAt' | 'createdBy' | 'details' | 'currentness'> & {
        matchesCurrentSpec: boolean;
      }>;
    currentEvidence: number;
    staleEvidence: number;
    kinds: string[];
    evidenceRefs: string[];
    /** Evidence rows whose currentness could not be established. */
    uncertainEvidence: number;
    /** Explicit planes recorded by evidence details, when producers supplied one. */
    evidencePlanes: string[];
    adequacy?: {
      state: 'pass' | 'fail' | 'unknown' | 'undeclared';
      checks: Array<{ specId: string; revision: number; verdict: 'pass' | 'fail' | 'unknown'; wouldBlock: string[]; evidenceRefs: string[] }>;
    };
  };
  grading: {
    state: 'pass' | 'not-pass' | 'stale' | 'missing' | 'truncated';
    history?: Array<{
      scorecardId: string; createdAt: string; createdBy: string | null; rubricRevision: number | null;
      role: 'author' | 'implementer' | 'independent' | 'unattributed';
      authoritative: boolean; currentRevision: boolean; complete: boolean; retracted: boolean;
      supersedes: string | null; supersededBy: string | null; selectedVia: SelectionVia | null;
      rating: string | null; evidence: string | null; authorVerdict: string | null; reasoning: string | null;
    }>;
    scorecardId: string | null;
    rubricRevision: number | null;
    gradedBy: string | null;
    selectedVia: SelectionVia | null;
    rating: string | null;
    evidence: string | null;
  };
  readiness: {
    state: 'ready' | 'blocked';
    codes: AcceptanceBarSnapshotCode[];
    mapping: 'live' | 'dropped-only' | 'missing';
    method: 'declared' | 'missing';
    workContract: 'current' | 'stale' | 'missing';
  };
}

export interface AcceptanceBarContractSnapshot {
  schemaVersion: typeof ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION;
  contentHash: string;
  planSlug: string;
  applicable: boolean;
  plan: AcceptanceBarSubjectPlanSource | null;
  rubric: {
    rubricId: string;
    revision: number | null;
    criteriaHash: string | null;
    barSetHash: string | null;
    contract: Rubric['barContract'] | null;
    createdBy: string | null;
    ratingScale: string[];
    classRef: string | null;
  } | null;
  sourceRevisions: {
    subjectPlan: number | null;
    rubricPlan: number | null;
    clauses: Array<{ specId: string; revision: number; contentHash: string }>;
    workContracts: Array<{ workItemId: string; specId: string; revision: number; fingerprint: string }>;
    scorecardIds: string[];
  };
  bounded: Record<
    'plans' | 'rubrics' | 'planItems' | 'clauses' | 'workContracts' | 'evidence' | 'scorecards' | 'vetting' | 'lineage',
    { rowsRead: number; limit: number; truncated: boolean }
  >;
  completeness: {
    complete: boolean;
    truncated: boolean;
    problems: AcceptanceBarSnapshotProblem[];
  };
  lineage: {
    identities: string[];
    parties: Array<{ identity: string; party: string }>;
    complete: boolean;
  };
  grading: {
    authoritativeScorecardId: string | null;
    gradedBy: string | null;
    selectedVia: SelectionVia | null;
    rubricRevision: number | null;
    vetting: {
      state: 'current' | 'stale' | 'missing' | 'truncated';
      scorecardId: string | null;
      rubricRevision: number | null;
    };
    authorVerdict: {
      state: 'accepted' | 'rejected' | 'stale' | 'missing';
      scorecardId: string | null;
      verdict: string | null;
      createdBy?: string | null;
      rubricRevision?: number | null;
      supersedes?: string | null;
      reasoning?: string | null;
    };
  };
  bars: AcceptanceBarTrace[];
  readiness: {
    state: 'ready' | 'blocked' | 'not-applicable';
    codes: AcceptanceBarSnapshotCode[];
    nextRepair: { code: AcceptanceBarSnapshotCode; barKey: string | null; action: string } | null;
  };
}

export interface AcceptanceBarSnapshotDeps {
  readPlans: (planSlug: string) => Promise<BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>>;
  readRubrics: (planSlug: string) => Promise<BoundedAcceptanceBarRows<Rubric>>;
  readPlanItems: (
    plan: AcceptanceBarSubjectPlanSource,
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>>;
  readClauses: (plan: AcceptanceBarSubjectPlanSource) => Promise<BoundedAcceptanceBarRows<SpecClauseRevision>>;
  readWorkContracts: (
    plan: AcceptanceBarSubjectPlanSource,
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>>;
  readEvidence: (
    plan: AcceptanceBarSubjectPlanSource,
    current?: EvidenceCurrentInput[],
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>>;
  readLineage: (plan: AcceptanceBarSubjectPlanSource) => Promise<AcceptanceBarLineageSource>;
  readScorecards: (rubric: Rubric) => Promise<BoundedAcceptanceBarRows<ScorecardRow>>;
  readVettingScorecards: (rubric: Rubric) => Promise<BoundedAcceptanceBarRows<ScorecardRow>>;
  readParties: (identities: string[], workspaceId: string) => Promise<Map<string, string>>;
  readGraderSelectionVia: (workspaceId: string, rubricId: string) => Promise<Map<string, SelectionVia>>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function bounded<T>(rows: T[], limit: number): BoundedAcceptanceBarRows<T> {
  return { rows: rows.slice(0, limit), limit, truncated: rows.length > limit };
}

function emptyBounded<T>(limit: number): BoundedAcceptanceBarRows<T> {
  return { rows: [], limit, truncated: false };
}

function normalized(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function problemKey(problem: AcceptanceBarSnapshotProblem): string {
  return `${problem.code}\0${problem.source}\0${problem.barKey ?? ''}\0${problem.detail}`;
}

function addProblem(problems: AcceptanceBarSnapshotProblem[], problem: AcceptanceBarSnapshotProblem): void {
  const key = problemKey(problem);
  if (!problems.some((candidate) => problemKey(candidate) === key)) problems.push(problem);
}

function scorecardAcceptance(card: ScorecardRow): {
  verdict?: string;
  reasoning?: string;
  seat?: { succeededFrom?: string };
} | null {
  const value = card.acceptance;
  return value && typeof value === 'object'
    ? (value as { verdict?: string; reasoning?: string; seat?: { succeededFrom?: string } })
    : null;
}

function completeScorecard(card: ScorecardRow): boolean {
  return card.rubricResolved && card.missingKeys.length === 0 && !card.synthesized && !card.retracted;
}

function partyOf(identity: string | null | undefined, parties: ReadonlyMap<string, string>): string | null {
  const id = identity?.trim() ?? '';
  return id ? (parties.get(id) ?? id) : null;
}

function authoritativeGrading(input: AcceptanceBarContractSnapshotInput, rubric: Rubric | null) {
  if (!rubric) return { card: undefined, via: null as SelectionVia | null, authorVerdict: undefined,
    roleOf: (_card: ScorecardRow) => 'unattributed' as const };
  const allComplete = input.scorecards.rows.filter(completeScorecard);
  const author = rubric.createdBy ?? rubric.proposedBy ?? null;
  const authorParty = partyOf(author, input.partyByIdentity);
  const principalParties = new Set(
    input.lineage.identities.map((id) => partyOf(id, input.partyByIdentity)).filter(Boolean),
  );
  const holdsAuthorAuthority = (card: ScorecardRow): boolean => {
    if (partyOf(card.createdBy, input.partyByIdentity) === authorParty && authorParty !== null) return true;
    return scorecardAcceptance(card)?.seat?.succeededFrom === author;
  };
  const isPrincipal = (card: ScorecardRow): boolean => {
    const party = partyOf(card.createdBy, input.partyByIdentity);
    return party !== null && principalParties.has(party);
  };
  const standingAuthorVerdicts = new Map(
    allComplete
      .filter((card) => !card.supersededBy && holdsAuthorAuthority(card) && card.acceptance && card.supersedes)
      .map((card) => [card.issueId, card.supersedes!] as const),
  );
  const standing = allComplete.filter(
    (card) =>
      !card.supersededBy ||
      (standingAuthorVerdicts.get(card.supersededBy) === card.issueId &&
        !holdsAuthorAuthority(card) &&
        !isPrincipal(card)),
  );
  const independent = standing.filter((card) => !holdsAuthorAuthority(card) && !isPrincipal(card));
  const card = pickAuthoritativeGrading(independent, (candidate) => gradingViaOf(candidate, input.graderSelectionVia));
  const authorVerdict = standing
    .filter((candidate) => holdsAuthorAuthority(candidate) && scorecardAcceptance(candidate))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return {
    card,
    via: card ? gradingViaOf(card, input.graderSelectionVia) : null,
    authorVerdict,
    roleOf: (candidate: ScorecardRow) => !candidate.createdBy ? 'unattributed' as const
      : holdsAuthorAuthority(candidate) ? 'author' as const
        : isPrincipal(candidate) ? 'implementer' as const : 'independent' as const,
  };
}

function nextRepair(
  codes: AcceptanceBarSnapshotCode[],
  bars: AcceptanceBarTrace[],
): AcceptanceBarContractSnapshot['readiness']['nextRepair'] {
  const order: AcceptanceBarSnapshotCode[] = [
    'bar_snapshot_source_unavailable',
    'bar_snapshot_source_truncated',
    'bar_snapshot_plan_missing',
    'bar_snapshot_plan_ambiguous',
    'bar_snapshot_cohort_incomplete',
    'bar_snapshot_rubric_missing',
    'bar_snapshot_rubric_ambiguous',
    'bar_snapshot_rubric_revision_mismatch',
    'bar_snapshot_bar_set_empty',
    'bar_snapshot_bar_set_too_large',
    'bar_snapshot_bar_key_duplicate',
    'bar_snapshot_bar_hash_missing',
    'bar_snapshot_bar_hash_mismatch',
    'bar_snapshot_bar_set_hash_mismatch',
    'bar_snapshot_bar_provenance_missing',
    'bar_snapshot_mapping_missing',
    'bar_snapshot_mapping_dropped_only',
    'bar_snapshot_projection_stale',
    'bar_snapshot_method_missing',
    'bar_snapshot_work_contract_missing',
    'bar_snapshot_work_contract_stale',
    'bar_snapshot_proof_missing',
    'bar_snapshot_proof_stale',
    'bar_snapshot_proof_depth_missing',
    'bar_snapshot_proof_inadequate',
    'bar_snapshot_grading_missing',
    'bar_snapshot_grading_stale',
    'bar_snapshot_grading_not_pass',
    'bar_snapshot_vetting_missing',
    'bar_snapshot_vetting_stale',
    'bar_snapshot_author_verdict_missing',
    'bar_snapshot_author_verdict_stale',
    'bar_snapshot_author_rejected',
  ];
  const code = order.find((candidate) => codes.includes(candidate));
  if (!code) return null;
  const bar = bars.find((candidate) => candidate.readiness.codes.includes(code));
  const actions: Record<AcceptanceBarSnapshotCode, string> = {
    bar_snapshot_source_unavailable: 'Repair or retry the named canonical source read; unreadable is not empty.',
    bar_snapshot_source_truncated:
      'Reduce the contract population or use the bounded continuation before evaluating it.',
    bar_snapshot_plan_missing: 'Restore or identify the canonical subject plan row.',
    bar_snapshot_plan_ambiguous: 'Resolve the duplicate subject-plan identity before evaluating a contract.',
    bar_snapshot_cohort_incomplete: 'Repair the server-owned adoption epoch/cohort seed on the subject plan.',
    bar_snapshot_rubric_missing: "Seed or restore the plan's canonical acceptance rubric.",
    bar_snapshot_rubric_ambiguous: 'Retire the competing active acceptance rubric before continuing.',
    bar_snapshot_rubric_revision_mismatch: 'Re-seed or amend atomically so subject and rubric revision pins agree.',
    bar_snapshot_bar_set_empty: 'Declare at least one canonical outcome BAR for this post-epoch plan.',
    bar_snapshot_bar_set_too_large: 'Reduce the BAR set to the declared bounded contract limit.',
    bar_snapshot_bar_key_duplicate: 'Give every BAR one unique stable barKey.',
    bar_snapshot_bar_hash_missing: 'Run the canonical rubric writer so every BAR receives a server-derived hash.',
    bar_snapshot_bar_hash_mismatch: 'Amend through the canonical writer; stored BAR meaning and hash diverge.',
    bar_snapshot_bar_set_hash_mismatch: 'Reconcile the complete BAR set and its subject/rubric hash pins atomically.',
    bar_snapshot_bar_provenance_missing: 'Backfill server-owned BAR provenance for the adopted cohort.',
    bar_snapshot_mapping_missing: 'Map the BAR to at least one live P-NNN projection.',
    bar_snapshot_mapping_dropped_only: 'Map the outstanding BAR to a live replacement item or amend the BAR.',
    bar_snapshot_projection_stale: 'Regenerate the clause projection from the current BAR revision.',
    bar_snapshot_method_missing: 'Fill the BAR METHOD/check contract before vetting or grading.',
    bar_snapshot_work_contract_missing: 'Promote the BAR/spec revision into the relevant work-item contract.',
    bar_snapshot_work_contract_stale: 'Rebind the open work-item contract to the current spec revision.',
    bar_snapshot_proof_missing: 'Bind evidence at the current spec revision on the declared evidence plane.',
    bar_snapshot_proof_stale: 'Re-prove the current spec revision; superseded proof does not cover it.',
    bar_snapshot_grading_missing: 'Record a complete independent grading against the current rubric revision.',
    bar_snapshot_grading_stale: 'Re-grade against the current rubric revision.',
    bar_snapshot_grading_not_pass: 'Satisfy the BAR and record a pass-equivalent independent rating.',
    bar_snapshot_vetting_missing: 'Vet the current acceptance-rubric revision.',
    bar_snapshot_vetting_stale: 'Re-vet the current acceptance-rubric revision.',
    bar_snapshot_author_verdict_missing: 'Record the author-side verdict after reading the independent grading.',
    bar_snapshot_author_verdict_stale: 'Record a new author verdict for the authoritative grading.',
    bar_snapshot_author_rejected: 'Address the rejected grading before recording a newer verdict.',
    bar_snapshot_falsifier_missing: 'Declare a concrete falsifier/drift marker for the BAR.',
    bar_snapshot_role_invalid: 'Make each BAR an outcome or make a disclosure explicitly cover outcome BARs.',
    bar_snapshot_mandatory_invalid: 'Mark every BAR outcome mandatory; disclosures must not satisfy the ship floor.',
    bar_snapshot_scope_invalid: 'Declare a non-empty tree, deployed, or live evidence scope.',
    bar_snapshot_pass_ratings_invalid:
      'Use non-empty positive pass ratings from the rubric scale for mandatory outcomes.',
    bar_snapshot_coverage_invalid: 'Repair disclosure coverage so it references existing outcome BAR keys only.',
    bar_snapshot_check_missing: 'Add a runnable structured check or explicit manual instrument contract.',
    bar_snapshot_check_invalid: 'Repair the structured check or provide an explicit manual replication contract.',
    bar_snapshot_proof_uncertain: 'Re-bind evidence with complete currentness/fingerprint metadata.',
    bar_snapshot_proof_depth_missing: 'Declare requiredTestLayers in the requirement Acceptance section through rubrics:amend.',
    bar_snapshot_proof_inadequate: 'Run plans:evaluate-spec-test-adequacy for the mapped outcome with current fingerprints; fix every fail/unknown proof obligation before ship.',
    bar_snapshot_evidence_plane_unmet: "Record current evidence on the BAR's declared evidence plane.",
  };
  return { code, barKey: bar?.barKey ?? null, action: actions[code] };
}

/** Pure projection. The same source rows always produce byte-identical contentHash. */
export function projectAcceptanceBarContractSnapshot(
  input: AcceptanceBarContractSnapshotInput,
): AcceptanceBarContractSnapshot {
  const problems: AcceptanceBarSnapshotProblem[] = [];
  for (const [source, detail] of Object.entries(input.readFailures ?? {}) as Array<
    [AcceptanceBarSnapshotSource, string]
  >) {
    if (!detail) continue;
    addProblem(problems, {
      code: 'bar_snapshot_source_unavailable',
      source,
      severity: 'error',
      detail,
    });
  }

  const boundedInputs = [
    ['plan', input.planRows],
    ['rubric', input.rubrics],
    ['plan-items', input.planItems],
    ['clauses', input.clauses],
    ['work-contracts', input.workContracts],
    ['evidence', input.evidence],
    ['grading', input.scorecards],
    ['vetting', input.vettingScorecards],
  ] as const;
  for (const [source, read] of boundedInputs) {
    if (!read.truncated) continue;
    addProblem(problems, {
      code: 'bar_snapshot_source_truncated',
      source,
      severity: 'error',
      detail: `${source} read reached its ${read.limit}-row contract limit`,
    });
  }
  if (input.lineage.truncated) {
    addProblem(problems, {
      code: 'bar_snapshot_source_truncated',
      source: 'lineage',
      severity: 'error',
      detail: `lineage read reached its ${input.lineage.rowLimit}-row contract limit`,
    });
  }

  const plan = input.planRows.rows[0] ?? null;
  if (!plan) {
    addProblem(problems, {
      code: 'bar_snapshot_plan_missing',
      source: 'plan',
      severity: 'error',
      detail: 'canonical subject plan row is absent',
    });
  }
  if (input.planRows.truncated || input.planRows.rows.length > 1) {
    addProblem(problems, {
      code: 'bar_snapshot_plan_ambiguous',
      source: 'plan',
      severity: 'error',
      detail: 'more than one subject plan row matched the slug',
    });
  }
  const applicable = plan?.adoptionEpoch != null;
  if (
    applicable &&
    (plan?.adoptionEpoch !== ACCEPTANCE_BAR_CONTRACT_EPOCH || !plan.cohort || !plan.seededAt || !plan.seededBy)
  ) {
    addProblem(problems, {
      code: 'bar_snapshot_cohort_incomplete',
      source: 'plan',
      severity: 'error',
      detail: 'post-epoch subject plan lacks a complete server-owned cohort/seed identity',
    });
  }

  if (input.rubrics.rows.length === 0 && applicable) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_missing',
      source: 'rubric',
      severity: 'error',
      detail: 'post-epoch subject plan has no active acceptance rubric',
    });
  }
  if (input.rubrics.rows.length > 1 || input.rubrics.truncated) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_ambiguous',
      source: 'rubric',
      severity: 'error',
      detail: `subject plan has ${input.rubrics.rows.length}${input.rubrics.truncated ? '+' : ''} active acceptance rubrics`,
    });
  }
  const rubric = input.rubrics.rows.length === 1 && !input.rubrics.truncated ? input.rubrics.rows[0]! : null;
  if (
    applicable &&
    plan &&
    rubric &&
    (plan.rubricSlug !== rubric.rubricId ||
      plan.rubricRevision !== (rubric.revision ?? null) ||
      rubric.barContract?.subjectPlanRevision !== plan.revision)
  ) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_revision_mismatch',
      source: 'rubric',
      severity: 'error',
      detail: 'subject-plan pins and current rubric/subject revisions do not agree',
    });
  }

  const rawCriteria = rubric?.criteria ?? [];
  const barCriteria = rawCriteria.filter((criterion) => criterion.barKey || criterion.barHash);
  if (applicable && barCriteria.length === 0) {
    addProblem(problems, {
      code: 'bar_snapshot_bar_set_empty',
      source: 'rubric',
      severity: 'error',
      detail: 'post-epoch acceptance rubric contains zero BAR criteria',
    });
  }
  if (barCriteria.length > MAX_REQUIREMENT_BARS) {
    addProblem(problems, {
      code: 'bar_snapshot_bar_set_too_large',
      source: 'rubric',
      severity: 'error',
      detail: `rubric contains ${barCriteria.length} BARs; maximum is ${MAX_REQUIREMENT_BARS}`,
    });
  }
  const boundedCriteria = barCriteria.slice(0, MAX_REQUIREMENT_BARS);
  const seenBarKeys = new Set<string>();
  for (const criterion of boundedCriteria) {
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    if (seenBarKeys.has(barKey)) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_key_duplicate',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: `duplicate BAR key '${barKey}'`,
      });
    }
    seenBarKeys.add(barKey);
    if (!criterion.barHash) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_hash_missing',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: `BAR '${barKey}' has no server-derived hash`,
      });
      continue;
    }
    try {
      if (computeAcceptanceBarHash(criterion) !== criterion.barHash) {
        addProblem(problems, {
          code: 'bar_snapshot_bar_hash_mismatch',
          source: 'rubric',
          severity: 'error',
          barKey,
          detail: `BAR '${barKey}' meaning no longer matches its stored hash`,
        });
      }
    } catch (error) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_hash_mismatch',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (applicable && boundedCriteria.length > 0 && boundedCriteria.every((criterion) => criterion.barHash)) {
    try {
      const computed = computeAcceptanceBarSetHash(boundedCriteria);
      if (computed !== plan?.barSetHash || computed !== rubric?.barSetHash) {
        addProblem(problems, {
          code: 'bar_snapshot_bar_set_hash_mismatch',
          source: 'rubric',
          severity: 'error',
          detail: 'recomputed BAR-set hash does not match both subject-plan and rubric pins',
        });
      }
    } catch (error) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_set_hash_mismatch',
        source: 'rubric',
        severity: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const itemStatus = new Map(input.planItems.rows.map((item) => [item.itemId, item.status]));
  const grading = authoritativeGrading(input, rubric);
  const rubricRevision = rubric?.revision ?? null;
  const bars: AcceptanceBarTrace[] = [];
  for (const criterion of boundedCriteria
    .slice()
    .sort((a, b) => (a.barKey ?? a.key).localeCompare(b.barKey ?? b.key))) {
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    const clauses = input.clauses.rows
      .filter((clause) => clause.sourceBar?.barKey === barKey)
      .sort((a, b) => a.specId.localeCompare(b.specId));
    const mappings = clauses.map((clause) => ({
      planItemId: clause.planItemId,
      planItemStatus: itemStatus.get(clause.planItemId) ?? null,
      specId: clause.specId,
      sourceValId: clause.sourceValId ?? null,
      specRevision: clause.revision,
      specContentHash: clause.contentHash,
      sourceBarHash: clause.sourceBar?.barHash ?? null,
      sourceBarSetHash: clause.sourceBar?.barSetHash ?? null,
      sourceRubricRevision: clause.sourceBar?.rubricRevision ?? null,
      evidencePlane: clause.sourceBar?.evidencePlane ?? null,
    }));
    const contracts = clauses
      .flatMap((clause) =>
        input.workContracts.rows
          .filter((edge) => edge.planSlug === clause.planSlug && edge.specId === clause.specId)
          .map((edge) => ({
            workItemId: edge.workItemId,
            specId: edge.specId,
            specRevision: edge.specRevision,
            specFingerprint: edge.specFingerprint,
            current: edge.specRevision === clause.revision && edge.specFingerprint === clause.contentHash,
          })),
      )
      .sort((a, b) => `${a.workItemId}\0${a.specId}`.localeCompare(`${b.workItemId}\0${b.specId}`));
    const evidence = clauses.flatMap((clause) =>
      input.evidence.rows.filter((row) => row.planSlug === clause.planSlug && row.specId === clause.specId),
    );
    const currentEvidence = evidence.filter((row) =>
      clauses.some(
        (clause) =>
          clause.specId === row.specId &&
          row.specRevision === clause.revision &&
          row.currentRevision === clause.revision &&
          row.specFingerprint === clause.contentHash &&
          row.currentness.overall !== 'stale',
      ),
    );
    const staleEvidence = evidence.filter((row) => !currentEvidence.includes(row));
    const requiredTestLayers = normalized(criterion.requiredTestLayers);
    const planeOf = (row: AcceptanceBarEvidenceSource): string | undefined => {
      const plane = row.details.evidencePlane ?? row.details.evidence_plane ?? row.details.plane;
      return typeof plane === 'string' ? plane.trim().toLowerCase() : undefined;
    };
    // Only current proof on the promised plane can establish adequacy. Keep all
    // historical rows for inspection; do not let a stale live row lend its plane
    // to a current unit test. Unknown fingerprints remain unknown to the evaluator.
    const proofCandidates = currentEvidence.filter((row) =>
      criterion.evidencePlane === 'tree' || planeOf(row) === criterion.evidencePlane);
    const classRef: PlanClassRubricRef = PLAN_CLASS_RUBRIC_REFS.includes(rubric?.classRef as PlanClassRubricRef)
      ? rubric!.classRef as PlanClassRubricRef : 'plan-class-feature-ship';
    const adequacyChecks = requiredTestLayers.length === 0 ? [] : clauses.map((clause) => {
      const result = evaluateSpecTestAdequacy({ clause: { ...clause, requiredTestLayers },
        evidence: proofCandidates, classRef });
      return { specId: clause.specId, revision: clause.revision, verdict: result.verdict,
        wouldBlock: result.wouldBlock, evidenceRefs: result.evidenceRefs };
    });
    const adequacyState = requiredTestLayers.length === 0 ? 'undeclared' as const
      : adequacyChecks.some((check) => check.verdict === 'pass') ? 'pass' as const
        : adequacyChecks.some((check) => check.verdict === 'unknown') ? 'unknown' as const : 'fail' as const;
    const ratingEntry = grading.card?.ratings[criterion.key] as { rating?: string; evidence?: string } | undefined;
    const rating = ratingEntry?.rating?.trim() || null;
    const passRatings = normalized(criterion.passRatings).map((value) => value.toLowerCase());
    const gradingCurrent = grading.card?.rubricRevision === rubricRevision;
    const gradingState: AcceptanceBarTrace['grading']['state'] = input.scorecards.truncated
      ? 'truncated'
      : !grading.card || !rating
        ? 'missing'
        : !gradingCurrent
          ? 'stale'
          : passRatings.includes(rating.toLowerCase())
            ? 'pass'
            : 'not-pass';
    const mappingState: AcceptanceBarTrace['readiness']['mapping'] =
      mappings.length === 0
        ? 'missing'
        : mappings.every((mapping) => mapping.planItemStatus === 'dropped')
          ? 'dropped-only'
          : 'live';
    const workContractState: AcceptanceBarTrace['readiness']['workContract'] =
      contracts.length === 0 ? 'missing' : contracts.some((contract) => contract.current) ? 'current' : 'stale';
    const proofState: AcceptanceBarTrace['proof']['state'] = input.evidence.truncated
      ? 'truncated'
      : currentEvidence.length > 0
        ? 'current'
        : staleEvidence.length > 0
          ? 'stale'
          : 'missing';
    const codes: AcceptanceBarSnapshotCode[] = [];
    const addCode = (code: AcceptanceBarSnapshotCode) => {
      if (!codes.includes(code)) codes.push(code);
    };
    if (!criterion.barProvenance) addCode('bar_snapshot_bar_provenance_missing');
    if (mappingState === 'missing') addCode('bar_snapshot_mapping_missing');
    if (mappingState === 'dropped-only') addCode('bar_snapshot_mapping_dropped_only');
    if (
      clauses.some(
        (clause) =>
          clause.sourceBar?.barHash !== criterion.barHash ||
          clause.sourceBar?.barSetHash !== plan?.barSetHash ||
          clause.sourceBar?.rubricSlug !== rubric?.rubricId ||
          clause.sourceBar?.rubricRevision !== rubricRevision ||
          clause.sourceBar?.evidencePlane !== criterion.evidencePlane ||
          JSON.stringify(normalized(clause.requiredTestLayers)) !== JSON.stringify(requiredTestLayers),
      )
    )
      addCode('bar_snapshot_projection_stale');
    if (!criterion.method?.trim()) addCode('bar_snapshot_method_missing');
    if (workContractState === 'missing') addCode('bar_snapshot_work_contract_missing');
    if (workContractState === 'stale') addCode('bar_snapshot_work_contract_stale');
    if (proofState === 'missing') addCode('bar_snapshot_proof_missing');
    if (proofState === 'stale' || proofState === 'truncated') addCode('bar_snapshot_proof_stale');
    if (criterion.role === 'outcome') {
      if (adequacyState === 'undeclared') addCode('bar_snapshot_proof_depth_missing');
      else if (adequacyState !== 'pass') addCode('bar_snapshot_proof_inadequate');
    }
    if (gradingState === 'missing' || gradingState === 'truncated') addCode('bar_snapshot_grading_missing');
    if (gradingState === 'stale') addCode('bar_snapshot_grading_stale');
    if (gradingState === 'not-pass') addCode('bar_snapshot_grading_not_pass');

    bars.push({
      barKey,
      criterionKey: criterion.key,
      title: criterion.title,
      requirement: requirementSections(criterion),
      barHash: criterion.barHash ?? null,
      model: criterion.model ?? criterion.bar ?? '',
      method: criterion.method ?? '',
      check: criterion.check ?? null,
      replication: criterion.replication ?? null,
      falsifier: criterion.driftMarkers ?? '',
      role: criterion.role ?? null,
      mandatory: criterion.mandatory ?? null,
      requiredScope: normalized(criterion.requiredScope),
      evidencePlane: criterion.evidencePlane ?? null,
      requiredTestLayers,
      passRatings: normalized(criterion.passRatings),
      coversBarKeys: normalized(criterion.coversBarKeys),
      provenance: criterion.barProvenance ?? null,
      mappings,
      workContracts: contracts,
      proof: {
        state: proofState,
        history: evidence.slice().sort((a, b) =>
          `${a.observedAt}\0${a.id}`.localeCompare(`${b.observedAt}\0${b.id}`)).map((row) => ({
          id: row.id, workItemId: row.workItemId, specId: row.specId, specRevision: row.specRevision,
          specFingerprint: row.specFingerprint, evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
          testRunId: row.testRunId, observedAt: row.observedAt, createdBy: row.createdBy,
          details: row.details, currentness: row.currentness,
          matchesCurrentSpec: clauses.some((clause) => clause.specId === row.specId &&
            clause.revision === row.specRevision && clause.contentHash === row.specFingerprint),
        })),
        currentEvidence: currentEvidence.length,
        staleEvidence: staleEvidence.length,
        kinds: normalized(evidence.map((row) => row.evidenceKind)),
        evidenceRefs: normalized(evidence.map((row) => row.evidenceRef)),
        adequacy: { state: adequacyState, checks: adequacyChecks },
        // WI-2146375: `unknown` is what the classifier returns when the READER supplied no
        // current-fingerprint input, not a property of the evidence. `source_fingerprint` is
        // NOT NULL, and `defaultReadEvidence` passes no `current`, so counting bare `unknown`
        // here made `bar_snapshot_proof_uncertain` fire on EVERY bound row — which, since the
        // empty-evidence case already raises `bar_snapshot_proof_missing`, left the ship gate
        // with no satisfiable state at all. Only a reader that actually ASKED can be uncertain.
        uncertainEvidence: evidence.filter((row) => {
          const currentness = (
            row as {
              currentness?: { overall?: string; dimensions?: Record<string, string>; comparisonSupplied?: boolean };
            }
          ).currentness;
          if (currentness?.comparisonSupplied !== true) return false;
          return (
            currentness.overall === 'unknown' ||
            Object.values(currentness.dimensions ?? {}).some((value) => value === 'unknown')
          );
        }).length,
        evidencePlanes: normalized(
          currentEvidence.flatMap((row) => {
            const details =
              row.details && typeof row.details === 'object' ? (row.details as Record<string, unknown>) : {};
            const plane = details.evidencePlane ?? details.evidence_plane ?? details.plane;
            return typeof plane === 'string' ? [plane] : [];
          }),
        ),
      },
      grading: {
        state: gradingState,
        history: input.scorecards.rows
          .filter((card) => card.ratings[criterion.key] || scorecardAcceptance(card))
          .slice().sort((a, b) => `${a.createdAt}\0${a.issueId}`.localeCompare(`${b.createdAt}\0${b.issueId}`))
          .map((card) => {
            const entry = card.ratings[criterion.key];
            const acceptance = scorecardAcceptance(card);
            return {
              scorecardId: card.issueId, createdAt: card.createdAt, createdBy: card.createdBy,
              rubricRevision: card.rubricRevision ?? null, role: grading.roleOf(card),
              authoritative: card.issueId === grading.card?.issueId || card.issueId === grading.authorVerdict?.issueId,
              currentRevision: card.rubricRevision === rubricRevision, complete: completeScorecard(card),
              retracted: Boolean(card.retracted), supersedes: card.supersedes ?? null,
              supersededBy: card.supersededBy ?? null, selectedVia: gradingViaOf(card, input.graderSelectionVia),
              rating: entry?.rating ?? null, evidence: entry?.evidence ?? null,
              authorVerdict: acceptance?.verdict ?? null, reasoning: acceptance?.reasoning ?? null,
            };
          }),
        scorecardId: grading.card?.issueId ?? null,
        rubricRevision: grading.card?.rubricRevision ?? null,
        gradedBy: grading.card?.createdBy ?? null,
        selectedVia: grading.via,
        rating,
        evidence: ratingEntry?.evidence ?? null,
      },
      readiness: {
        state: codes.length === 0 ? 'ready' : 'blocked',
        codes,
        mapping: mappingState,
        method: criterion.method?.trim() ? 'declared' : 'missing',
        workContract: workContractState,
      },
    });
  }

  const currentVetting = input.vettingScorecards.rows
    .filter(
      (card) =>
        completeScorecard(card) &&
        Boolean(card.vetting?.consultId || card.vetting?.workItemId) &&
        card.vetting?.rubricRevision === rubricRevision &&
        !card.supersededBy,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const anyVetting = input.vettingScorecards.rows
    .filter((card) => completeScorecard(card) && Boolean(card.vetting?.consultId || card.vetting?.workItemId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const vettingState: AcceptanceBarContractSnapshot['grading']['vetting']['state'] = input.vettingScorecards.truncated
    ? 'truncated'
    : currentVetting
      ? 'current'
      : anyVetting
        ? 'stale'
        : 'missing';
  const authorAcceptance = grading.authorVerdict ? scorecardAcceptance(grading.authorVerdict) : null;
  const authorVerdictState: AcceptanceBarContractSnapshot['grading']['authorVerdict']['state'] = !grading.authorVerdict
    ? 'missing'
    : grading.card && Date.parse(grading.authorVerdict.createdAt) < Date.parse(grading.card.createdAt)
      ? 'stale'
      : authorAcceptance?.verdict === 'reject'
        ? 'rejected'
        : authorAcceptance?.verdict === 'accept'
          ? 'accepted'
          : 'missing';

  const allCodes = [
    ...problems.map((problem) => problem.code),
    ...bars.flatMap((bar) => bar.readiness.codes),
    ...(rubric && rubric.criteria.length > 0
      ? [
          ...(vettingState === 'missing' || vettingState === 'truncated'
            ? ['bar_snapshot_vetting_missing' as const]
            : []),
          ...(vettingState === 'stale' ? ['bar_snapshot_vetting_stale' as const] : []),
        ]
      : []),
    ...(grading.card
      ? [
          ...(authorVerdictState === 'missing' ? ['bar_snapshot_author_verdict_missing' as const] : []),
          ...(authorVerdictState === 'stale' ? ['bar_snapshot_author_verdict_stale' as const] : []),
          ...(authorVerdictState === 'rejected' ? ['bar_snapshot_author_rejected' as const] : []),
        ]
      : []),
  ];
  const codes = [...new Set(allCodes)];
  const truncated =
    barCriteria.length > MAX_REQUIREMENT_BARS ||
    problems.some((problem) => problem.code === 'bar_snapshot_source_truncated');
  const base = {
    schemaVersion: ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
    planSlug: plan?.planSlug ?? '',
    applicable,
    plan,
    rubric: rubric
      ? {
          rubricId: rubric.rubricId,
          revision: rubric.revision ?? null,
          criteriaHash: rubric.criteriaHash ?? null,
          barSetHash: rubric.barSetHash ?? null,
          contract: rubric.barContract ?? null,
          createdBy: rubric.createdBy ?? rubric.proposedBy ?? null,
          ratingScale: [...rubric.ratingScale],
          classRef: rubric.classRef ?? null,
        }
      : null,
    sourceRevisions: {
      subjectPlan: plan?.revision ?? null,
      rubricPlan: rubric?.revision ?? null,
      clauses: input.clauses.rows
        .map((clause) => ({ specId: clause.specId, revision: clause.revision, contentHash: clause.contentHash }))
        .sort((a, b) => a.specId.localeCompare(b.specId)),
      workContracts: input.workContracts.rows
        .map((edge) => ({
          workItemId: edge.workItemId,
          specId: edge.specId,
          revision: edge.specRevision,
          fingerprint: edge.specFingerprint,
        }))
        .sort((a, b) => `${a.workItemId}\0${a.specId}`.localeCompare(`${b.workItemId}\0${b.specId}`)),
      scorecardIds: input.scorecards.rows.map((card) => card.issueId).sort(),
    },
    bounded: {
      plans: { rowsRead: input.planRows.rows.length, limit: input.planRows.limit, truncated: input.planRows.truncated },
      rubrics: { rowsRead: input.rubrics.rows.length, limit: input.rubrics.limit, truncated: input.rubrics.truncated },
      planItems: {
        rowsRead: input.planItems.rows.length,
        limit: input.planItems.limit,
        truncated: input.planItems.truncated,
      },
      clauses: { rowsRead: input.clauses.rows.length, limit: input.clauses.limit, truncated: input.clauses.truncated },
      workContracts: {
        rowsRead: input.workContracts.rows.length,
        limit: input.workContracts.limit,
        truncated: input.workContracts.truncated,
      },
      evidence: {
        rowsRead: input.evidence.rows.length,
        limit: input.evidence.limit,
        truncated: input.evidence.truncated,
      },
      scorecards: {
        rowsRead: input.scorecards.rows.length,
        limit: input.scorecards.limit,
        truncated: input.scorecards.truncated,
      },
      vetting: {
        rowsRead: input.vettingScorecards.rows.length,
        limit: input.vettingScorecards.limit,
        truncated: input.vettingScorecards.truncated,
      },
      lineage: {
        rowsRead: input.lineage.workItemRowsRead + input.lineage.auditRowsRead,
        limit: input.lineage.rowLimit,
        truncated: input.lineage.truncated,
      },
    },
    completeness: {
      complete: problems.every((problem) => problem.severity !== 'error'),
      truncated,
      problems: problems.sort((a, b) =>
        `${a.source}\0${a.barKey ?? ''}\0${a.code}`.localeCompare(`${b.source}\0${b.barKey ?? ''}\0${b.code}`),
      ),
    },
    lineage: {
      identities: [...input.lineage.identities].sort(),
      parties: [...input.partyByIdentity.entries()]
        .map(([identity, party]) => ({ identity, party }))
        .sort((a, b) => a.identity.localeCompare(b.identity)),
      complete: !input.lineage.truncated && !input.readFailures?.lineage && !input.readFailures?.['lineage-parties'],
    },
    grading: {
      authoritativeScorecardId: grading.card?.issueId ?? null,
      gradedBy: grading.card?.createdBy ?? null,
      selectedVia: grading.via,
      rubricRevision: grading.card?.rubricRevision ?? null,
      vetting: {
        state: vettingState,
        scorecardId: currentVetting?.issueId ?? anyVetting?.issueId ?? null,
        rubricRevision: currentVetting?.vetting?.rubricRevision ?? anyVetting?.vetting?.rubricRevision ?? null,
      },
      authorVerdict: {
        state: authorVerdictState,
        scorecardId: grading.authorVerdict?.issueId ?? null,
        verdict: authorAcceptance?.verdict ?? null,
        createdBy: grading.authorVerdict?.createdBy ?? null,
        rubricRevision: grading.authorVerdict?.rubricRevision ?? null,
        supersedes: grading.authorVerdict?.supersedes ?? null,
        reasoning: authorAcceptance?.reasoning ?? null,
      },
    },
    bars,
    readiness: {
      state: !applicable ? ('not-applicable' as const) : codes.length === 0 ? ('ready' as const) : ('blocked' as const),
      codes,
      nextRepair: nextRepair(codes, bars),
    },
  };
  return { ...base, contentHash: contentHash(base) };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function captured<T>(
  source: AcceptanceBarSnapshotSource,
  read: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; failure?: [AcceptanceBarSnapshotSource, string] }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { value: fallback, failure: [source, errorText(error)] };
  }
}

async function defaultReadPlans(planSlug: string): Promise<BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      plan_slug: string;
      status: string | null;
      version: number | string;
      content_hash: string | null;
      acceptance_bar_epoch: number | string | null;
      acceptance_bar_cohort: AcceptanceBarCohort | null;
      acceptance_bar_set_hash: string | null;
      acceptance_bar_rubric_slug: string | null;
      acceptance_bar_rubric_revision: number | string | null;
      acceptance_bar_seeded_at: Date | string | null;
      acceptance_bar_seeded_by: string | null;
    }>
  >`
    SELECT workspace_id, harness_slug, plan_slug, status, version, content_hash,
           acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_set_hash,
           acceptance_bar_rubric_slug, acceptance_bar_rubric_revision,
           acceptance_bar_seeded_at, acceptance_bar_seeded_by
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${planSlug}
     ORDER BY updated_at DESC NULLS LAST, harness_slug
     LIMIT ${2}`;
  return bounded(
    rows.map((row) => ({
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
      planSlug: row.plan_slug,
      status: row.status,
      revision: Number(row.version),
      contentHash: row.content_hash,
      adoptionEpoch: row.acceptance_bar_epoch == null ? null : Number(row.acceptance_bar_epoch),
      cohort: row.acceptance_bar_cohort,
      barSetHash: row.acceptance_bar_set_hash,
      rubricSlug: row.acceptance_bar_rubric_slug,
      rubricRevision: row.acceptance_bar_rubric_revision == null ? null : Number(row.acceptance_bar_rubric_revision),
      seededAt: pgTimestampToIsoOrNull(row.acceptance_bar_seeded_at),
      seededBy: row.acceptance_bar_seeded_by,
    })),
    1,
  );
}

async function defaultReadRubrics(planSlug: string): Promise<BoundedAcceptanceBarRows<Rubric>> {
  const rows = await getAcceptanceRubricsForPlan(planSlug, {
    limit: ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT + 1,
  });
  return bounded(rows, ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
}

async function defaultReadPlanItems(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ item_id: string; status: string }>>`
    SELECT item_id, status
      FROM harness_shared.plan_items
     WHERE workspace_id = ${plan.workspaceId}
       AND plan_slug = ${plan.planSlug}
     ORDER BY seq
     LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT + 1}`;
  return bounded(
    rows.map((row) => ({ itemId: row.item_id, status: row.status })),
    ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT,
  );
}

async function defaultReadClauses(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<SpecClauseRevision>> {
  const rows = await listSpecClauses({
    harnessSlug: plan.harnessSlug,
    planSlug: plan.planSlug,
    limit: MAX_BAR_PROJECTION_EDGES + 1,
  });
  return bounded(rows, MAX_BAR_PROJECTION_EDGES);
}

async function defaultReadWorkContracts(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      work_item_id: string;
      plan_slug: string;
      spec_id: string;
      spec_revision: number | string;
      spec_fingerprint: string;
    }>
  >`
    SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
      FROM harness_shared.work_item_spec_revision_edges
     WHERE workspace_id = ${plan.workspaceId}
       AND harness_slug = ${plan.harnessSlug}
       AND plan_slug = ${plan.planSlug}
     ORDER BY work_item_id, spec_id, spec_revision
     LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
  return bounded(
    rows.map((row) => ({
      workItemId: row.work_item_id,
      planSlug: row.plan_slug,
      specId: row.spec_id,
      specRevision: Number(row.spec_revision),
      specFingerprint: row.spec_fingerprint,
    })),
    MAX_BAR_PROJECTION_EDGES,
  );
}

async function defaultReadEvidence(
  plan: AcceptanceBarSubjectPlanSource,
  current?: EvidenceCurrentInput[],
): Promise<BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>> {
  const rows = await listSpecEvidence({
    harnessSlug: plan.harnessSlug,
    planSlugs: [plan.planSlug],
    current,
    limit: ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT + 1,
  });
  return bounded(rows, ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT);
}

async function defaultReadLineage(plan: AcceptanceBarSubjectPlanSource): Promise<AcceptanceBarLineageSource> {
  const { sql } = getOrgPg();
  const [workItems, audits] = await Promise.all([
    sql<
      Array<{
        terminal_owner: string | null;
        taken_by: string | null;
        last_released_by: string | null;
        worked_by_history: unknown;
      }>
    >`
      SELECT terminal_owner, taken_by, last_released_by, worked_by_history
        FROM harness_shared.work_items
       WHERE workspace_id = ${plan.workspaceId}
         AND source_plan_slug = ${plan.planSlug}
       ORDER BY feature_id
       LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT + 1}`,
    sql<Array<{ created_by: string | null }>>`
      SELECT created_by
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${plan.workspaceId}
         AND plan_slug = ${plan.planSlug}
         AND audit_kind IN ('activation', 'completion')
       ORDER BY audit_seq
       LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT + 1}`,
  ]);
  const identities = new Set<string>();
  const add = (value: string | null | undefined) => {
    const id = value?.trim() ?? '';
    if (id) identities.add(id);
  };
  for (const row of workItems.slice(0, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT)) {
    add(row.terminal_owner);
    add(row.taken_by);
    add(row.last_released_by);
    if (row.worked_by_history != null && !Array.isArray(row.worked_by_history)) {
      throw new Error(`acceptance_lineage_unreadable: work item history for '${plan.planSlug}' is not an array`);
    }
    for (const owner of parseWorkedByHistory(row.worked_by_history)) add(owner);
  }
  for (const row of audits.slice(0, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT)) add(row.created_by);
  return {
    identities: [...identities].sort(),
    workItemRowsRead: Math.min(workItems.length, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT),
    auditRowsRead: Math.min(audits.length, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT),
    rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
    truncated:
      workItems.length > ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT ||
      audits.length > ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
  };
}

async function defaultReadScorecards(rubric: Rubric): Promise<BoundedAcceptanceBarRows<ScorecardRow>> {
  const page = await listScorecardPage({
    rubricRef: rubric.rubricId,
    includeSuperseded: true,
    includeRetracted: true,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  });
  return {
    rows: page.rows,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
    truncated: page.hasMore,
  };
}

async function defaultReadVettingScorecards(rubric: Rubric): Promise<BoundedAcceptanceBarRows<ScorecardRow>> {
  const page = await listScorecardPage({
    rubricRef: 'meta-acceptance-rubric',
    subjectRef: rubric.rubricId,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  });
  return {
    rows: page.rows,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
    truncated: page.hasMore,
  };
}

const DEFAULT_DEPS: AcceptanceBarSnapshotDeps = {
  readPlans: defaultReadPlans,
  readRubrics: defaultReadRubrics,
  readPlanItems: defaultReadPlanItems,
  readClauses: defaultReadClauses,
  readWorkContracts: defaultReadWorkContracts,
  readEvidence: defaultReadEvidence,
  readLineage: defaultReadLineage,
  readScorecards: defaultReadScorecards,
  readVettingScorecards: defaultReadVettingScorecards,
  readParties: (identities, workspaceId) => lineagePartyKeys(identities, { workspaceId }),
  readGraderSelectionVia,
};

/**
 * Read every source in two fixed batches (identity, then rubric-addressed rows) and
 * build the pure snapshot. No reader is called per BAR; every collection is capped
 * with an over-fetch row so truncation is data, never inference.
 */
export async function readAcceptanceBarContractSnapshot(
  planSlug: string,
  deps: Partial<AcceptanceBarSnapshotDeps> = {},
  options: { current?: EvidenceCurrentInput[] } = {},
): Promise<AcceptanceBarContractSnapshot> {
  const d: AcceptanceBarSnapshotDeps = { ...DEFAULT_DEPS, ...deps };
  const failures: Partial<Record<AcceptanceBarSnapshotSource, string>> = {};
  const [planRead, rubricRead] = await Promise.all([
    captured('plan', () => d.readPlans(planSlug), emptyBounded<AcceptanceBarSubjectPlanSource>(1)),
    captured(
      'rubric',
      () => d.readRubrics(planSlug),
      emptyBounded<Rubric>(ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT),
    ),
  ]);
  if (planRead.failure) failures[planRead.failure[0]] = planRead.failure[1];
  if (rubricRead.failure) failures[rubricRead.failure[0]] = rubricRead.failure[1];
  const plan = planRead.value.rows[0] ?? null;
  const rubric = rubricRead.value.rows.length === 1 && !rubricRead.value.truncated ? rubricRead.value.rows[0]! : null;

  const emptyPlanItems = emptyBounded<AcceptanceBarPlanItemSource>(ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT);
  const emptyClauses = emptyBounded<SpecClauseRevision>(MAX_BAR_PROJECTION_EDGES);
  const emptyContracts = emptyBounded<AcceptanceBarWorkContractSource>(MAX_BAR_PROJECTION_EDGES);
  const emptyEvidence = emptyBounded<AcceptanceBarEvidenceSource>(ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT);
  const emptyScorecards = emptyBounded<ScorecardRow>(ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT);
  const emptyLineage: AcceptanceBarLineageSource = {
    identities: [],
    workItemRowsRead: 0,
    auditRowsRead: 0,
    rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
    truncated: false,
  };
  const [planItems, clauses, workContracts, evidence, lineage, scorecards, vetting] = await Promise.all([
    captured('plan-items', () => (plan ? d.readPlanItems(plan) : Promise.resolve(emptyPlanItems)), emptyPlanItems),
    captured('clauses', () => (plan ? d.readClauses(plan) : Promise.resolve(emptyClauses)), emptyClauses),
    captured(
      'work-contracts',
      () => (plan ? d.readWorkContracts(plan) : Promise.resolve(emptyContracts)),
      emptyContracts,
    ),
    captured('evidence', () => (plan ? d.readEvidence(plan, options.current) : Promise.resolve(emptyEvidence)), emptyEvidence),
    captured('lineage', () => (plan ? d.readLineage(plan) : Promise.resolve(emptyLineage)), emptyLineage),
    captured('grading', () => (rubric ? d.readScorecards(rubric) : Promise.resolve(emptyScorecards)), emptyScorecards),
    captured(
      'vetting',
      () => (rubric ? d.readVettingScorecards(rubric) : Promise.resolve(emptyScorecards)),
      emptyScorecards,
    ),
  ]);
  for (const result of [planItems, clauses, workContracts, evidence, lineage, scorecards, vetting]) {
    if (result.failure) failures[result.failure[0]] = result.failure[1];
  }

  const partyIds = [
    ...(rubric ? [rubric.createdBy, rubric.proposedBy] : []),
    ...lineage.value.identities,
    ...scorecards.value.rows.map((card) => card.createdBy),
  ].filter((value): value is string => Boolean(value?.trim()));
  const [parties, selectionVia] = await Promise.all([
    captured(
      'lineage-parties',
      () => (plan ? d.readParties(partyIds, plan.workspaceId) : Promise.resolve(new Map<string, string>())),
      new Map<string, string>(),
    ),
    captured(
      'grading',
      () => (rubric ? d.readGraderSelectionVia(rubric.workspaceId, rubric.rubricId) : Promise.resolve(new Map())),
      new Map<string, SelectionVia>(),
    ),
  ]);
  if (parties.failure) failures[parties.failure[0]] = parties.failure[1];
  if (selectionVia.failure) failures[selectionVia.failure[0]] = selectionVia.failure[1];

  const snapshot = projectAcceptanceBarContractSnapshot({
    planRows: planRead.value,
    rubrics: rubricRead.value,
    planItems: planItems.value,
    clauses: clauses.value,
    workContracts: workContracts.value,
    evidence: evidence.value,
    scorecards: scorecards.value,
    vettingScorecards: vetting.value,
    lineage: lineage.value,
    partyByIdentity: parties.value,
    graderSelectionVia: selectionVia.value,
    readFailures: failures,
  });
  return snapshot.planSlug ? snapshot : { ...snapshot, planSlug };
}

export type AcceptanceBarDiffKind =
  | 'added'
  | 'removed'
  | 'bar-meaning'
  | 'method-only'
  | 'mapping'
  | 'evidence-plane'
  | 'provenance-cohort';

export interface AcceptanceBarContractDiff {
  schemaVersion: 1;
  operation: 'compare' | 'seed' | 'amend' | 'migration';
  beforeHash: string | null;
  afterHash: string;
  changed: boolean;
  requiresAmendment: boolean;
  changes: Array<{
    barKey: string;
    kinds: AcceptanceBarDiffKind[];
    fields: string[];
  }>;
  contentHash: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Pure semantic diff used by seed/amend/migration dry-runs. */
export type AcceptanceBarContractDiffView = Pick<AcceptanceBarContractSnapshot, 'contentHash'> & {
  plan: Pick<AcceptanceBarSubjectPlanSource, 'cohort' | 'adoptionEpoch'> | null;
  bars: Array<Pick<AcceptanceBarTrace, 'barKey' | 'barHash' | 'model' | 'method' | 'falsifier' |
    'role' | 'mandatory' | 'requiredScope' | 'evidencePlane' | 'requiredTestLayers' | 'passRatings' |
    'coversBarKeys' | 'provenance'> & {
      mappings: Array<{ planItemId: string; specId: string }>;
    }>;
};

// The comparable subset also admits the canonical seed compiler's pre-write
// view, before execution proof exists. It is never a separate gate authority.
export function diffAcceptanceBarContractSnapshots(
  before: AcceptanceBarContractDiffView | null,
  after: AcceptanceBarContractDiffView,
  operation: AcceptanceBarContractDiff['operation'] = 'compare',
): AcceptanceBarContractDiff {
  const prior = new Map((before?.bars ?? []).map((bar) => [bar.barKey, bar]));
  const next = new Map(after.bars.map((bar) => [bar.barKey, bar]));
  const keys = [...new Set([...prior.keys(), ...next.keys()])].sort();
  const changes: AcceptanceBarContractDiff['changes'] = [];
  for (const barKey of keys) {
    const a = prior.get(barKey);
    const b = next.get(barKey);
    if (!a) {
      changes.push({ barKey, kinds: ['added'], fields: ['bar'] });
      continue;
    }
    if (!b) {
      changes.push({ barKey, kinds: ['removed'], fields: ['bar'] });
      continue;
    }
    const kinds: AcceptanceBarDiffKind[] = [];
    const fields: string[] = [];
    const meaningFields = [
      'model',
      'falsifier',
      'role',
      'mandatory',
      'requiredScope',
      'requiredTestLayers',
      'passRatings',
      'coversBarKeys',
    ] as const;
    for (const field of meaningFields) {
      if (sameValue(a[field], b[field])) continue;
      fields.push(field);
    }
    if (fields.length > 0 || a.barHash !== b.barHash) kinds.push('bar-meaning');
    if (a.evidencePlane !== b.evidencePlane) {
      kinds.push('evidence-plane');
      fields.push('evidencePlane');
    }
    if (a.method !== b.method) {
      kinds.push('method-only');
      fields.push('method');
    }
    const mappingOf = (bar: AcceptanceBarContractDiffView['bars'][number]) =>
      bar.mappings.map((mapping) => `${mapping.planItemId}\0${mapping.specId}`).sort();
    if (!sameValue(mappingOf(a), mappingOf(b))) {
      kinds.push('mapping');
      fields.push('mappings');
    }
    if (
      !sameValue(a.provenance, b.provenance) ||
      before?.plan?.cohort !== after.plan?.cohort ||
      before?.plan?.adoptionEpoch !== after.plan?.adoptionEpoch
    ) {
      kinds.push('provenance-cohort');
      fields.push('provenance');
    }
    if (kinds.length > 0) {
      changes.push({ barKey, kinds: [...new Set(kinds)], fields: [...new Set(fields)].sort() });
    }
  }
  const base = {
    schemaVersion: 1 as const,
    operation,
    beforeHash: before?.contentHash ?? null,
    afterHash: after.contentHash,
    changed: changes.length > 0,
    requiresAmendment: changes.some((change) =>
      change.kinds.some((kind) => ['added', 'removed', 'bar-meaning', 'mapping', 'evidence-plane'].includes(kind)),
    ),
    changes,
  };
  return { ...base, contentHash: contentHash(base) };
}

// Public vocabulary aliases. Keeping the explicit `project/read/diff` names above
// makes call sites describe whether they are pure or I/O-bearing; these aliases let
// lifecycle writers refer to the domain contract without inventing a second API.
export const buildAcceptanceBarContractSnapshot = projectAcceptanceBarContractSnapshot;
export const getAcceptanceBarContractSnapshot = readAcceptanceBarContractSnapshot;
export const diffAcceptanceBarContract = diffAcceptanceBarContractSnapshots;
