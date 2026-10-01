/**
 * Agent-review routing policy (abolish-human-review-agent-review-only-2026-08-02 D-003).
 *
 * This leaf owns the two complementary queue predicates:
 *   - ordinary self-select excludes pending/revision-requested review work;
 *   - the reviewer lane admits pending review work only.
 *
 * It deliberately has no persistence dependencies. Both the queue implementation and
 * the lifecycle module import this file so the status vocabulary cannot drift.
 */
import type { OrgSql } from '../../work-items';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import {
  activeExternalBlockers,
  externalBlockerCapabilityPolicy,
  type ExternalBlockerCapability,
  type ExternalBlockerRecord,
} from '../../external-blockers';

export const AGENT_REVIEW_STATUSES = ['pending', 'revision-requested', 'approved'] as const;
export type AgentReviewStatus = (typeof AGENT_REVIEW_STATUSES)[number];

/**
 * Migration 864 cannot recover an originating principal for every legacy park.
 * The sentinel is deliberately not a routable owner id: revision handling treats
 * it as an instruction to release the item back to normal implementation instead
 * of assigning or waking a nonexistent submitter.
 */
export const LEGACY_AGENT_REVIEW_SUBMITTER = 'system:legacy-agent-review' as const;

export interface AgentReviewState {
  status: AgentReviewStatus;
  submittedBy: string;
  ledgerIdeaId: string;
  round: number;
}

/**
 * Versioned contract consumed by ordinary implementation self-selection.
 *
 * `unknown` is not a softer spelling of ready: it means the remaining problem,
 * its current evidence, or its acceptance check has not yet been established.
 * `not-ready` is an affirmative contradiction (for example a revision request,
 * terminal cited evidence, or a repair that is already present but undeployed).
 * `ready` is reserved for an explicit review approval or an existing immediate
 * capture-policy path. The `source` + `reason` fields keep those two bases honest.
 *
 * Rows without this payload predate the contract and retain the legacy claim
 * behavior. Presence of the key enrolls a row; malformed/unknown versions are
 * therefore held by the SQL floor instead of being mistaken for legacy rows.
 */
export const IMPLEMENTATION_READINESS_SCHEMA_VERSION = 'implementation-readiness-v1' as const;
export const IMPLEMENTATION_READINESS_STATUSES = ['unknown', 'not-ready', 'ready'] as const;
export type ImplementationReadinessStatus = (typeof IMPLEMENTATION_READINESS_STATUSES)[number];
export const IMPLEMENTATION_READINESS_SOURCES = ['capture-policy', 'agent-review', 'triage-freshness'] as const;
export type ImplementationReadinessSource = (typeof IMPLEMENTATION_READINESS_SOURCES)[number];

export interface ImplementationReadinessEvidence {
  /**
   * The minimum executable acceptance contract used by the intake-stage
   * derivation. Later acceptance-policy layers add authority, evidence and
   * revision binding to this same object rather than creating a second store.
   */
  acceptance?: {
    scope: string;
    completionCheck: string;
  };
  review?: {
    submittedBy?: string;
    reviewer?: string;
    round: number;
    grade?: number;
  };
  deployment?: {
    state: 'current' | 'stale' | 'unknown';
    toolName?: string;
    relPath?: string;
    unknownReason?: string;
  };
  citations?: {
    citedIds: string[];
    staleIds: string[];
    unresolvedIds: string[];
    circularIds: string[];
    lookupFailedIds: string[];
  };
}

export interface ImplementationReadinessState {
  schemaVersion: typeof IMPLEMENTATION_READINESS_SCHEMA_VERSION;
  status: ImplementationReadinessStatus;
  source: ImplementationReadinessSource;
  reason: string;
  updatedAt: string;
  evidence?: ImplementationReadinessEvidence;
}

const IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';
const IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN = new RegExp(IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE);

export function createImplementationReadiness(
  input: Omit<ImplementationReadinessState, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ImplementationReadinessState {
  return {
    schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
    status: input.status,
    source: input.source,
    reason: input.reason,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

/** Read only a complete current-version payload; malformed enrolled rows stay held in SQL. */
export function readImplementationReadiness(payload: unknown): ImplementationReadinessState | null {
  const row = record(record(payload).implementationReadiness);
  if (row.schemaVersion !== IMPLEMENTATION_READINESS_SCHEMA_VERSION) return null;
  if (!IMPLEMENTATION_READINESS_STATUSES.includes(row.status as ImplementationReadinessStatus)) return null;
  if (!IMPLEMENTATION_READINESS_SOURCES.includes(row.source as ImplementationReadinessSource)) return null;
  if (typeof row.reason !== 'string' || !row.reason.trim()) return null;
  if (
    typeof row.updatedAt !== 'string' ||
    !IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN.test(row.updatedAt) ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    return null;
  const evidence = record(row.evidence);
  return {
    schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
    status: row.status as ImplementationReadinessStatus,
    source: row.source as ImplementationReadinessSource,
    reason: row.reason,
    updatedAt: row.updatedAt,
    ...(Object.keys(evidence).length > 0 ? { evidence: evidence as ImplementationReadinessEvidence } : {}),
  };
}

export const WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION = 'work-item-intake-stage-v1' as const;
export const WORK_ITEM_INTAKE_PRIMARY_STAGES = ['observation', 'candidate', 'accepted', 'terminal', 'unknown'] as const;
export type WorkItemIntakePrimaryStage = (typeof WORK_ITEM_INTAKE_PRIMARY_STAGES)[number];
export const WORK_ITEM_INTAKE_READINESS_CLASSES = [
  'not-applicable',
  'legacy-missing',
  'malformed',
  ...IMPLEMENTATION_READINESS_STATUSES,
] as const;
export type WorkItemIntakeReadinessClass = (typeof WORK_ITEM_INTAKE_READINESS_CLASSES)[number];

export interface WorkItemIntakeStageInput {
  kind: string;
  status: string;
  payload?: unknown;
  terminalOwner?: string | null;
  terminalCompletionRef?: string | null;
}

export interface WorkItemIntakeStageDecision {
  schemaVersion: typeof WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION;
  primaryStage: WorkItemIntakePrimaryStage;
  readiness: WorkItemIntakeReadinessClass;
  reason:
    | 'observation-evidence'
    | 'terminal-history'
    | 'legacy-readiness-unknown'
    | 'malformed-readiness-unknown'
    | 'qualifying-acceptance'
    | 'ready-without-executable-acceptance'
    | 'awaiting-qualifying-acceptance';
  qualifyingAcceptance: boolean;
  countsAsBugWork: boolean;
}

export interface ImplementationAcceptanceEssentials {
  scope: string;
  completionCheck: string;
}

/**
 * Read the executable minimum of an acceptance record. A `ready` bit alone is
 * not acceptance: the work must say what may be executed and what completes it.
 */
export function readImplementationAcceptanceEssentials(payload: unknown): ImplementationAcceptanceEssentials | null {
  const readiness = readImplementationReadiness(payload);
  const acceptance = record(readiness?.evidence?.acceptance);
  const scope = typeof acceptance.scope === 'string' ? acceptance.scope.trim() : '';
  const completionCheck = typeof acceptance.completionCheck === 'string' ? acceptance.completionCheck.trim() : '';
  return scope && completionCheck ? { scope, completionCheck } : null;
}

/**
 * One primary intake stage for every supported work-item record.
 *
 * Observation identity outranks lifecycle state so closing or consuming a
 * sensor row never turns it into executable bug work. Terminal lifecycle is
 * otherwise authoritative. Missing and malformed versioned readiness remain
 * explicitly unknown; a current readiness verdict remains a candidate until a
 * minimal executable acceptance contract exists.
 */
export function deriveWorkItemIntakeStage(input: WorkItemIntakeStageInput): WorkItemIntakeStageDecision {
  const payload = record(input.payload);
  const observation = payload.lane === 'observation';
  const terminal =
    ALL_TERMINAL_STATUSES.has(input.status) ||
    Boolean(input.terminalOwner?.trim() && input.terminalCompletionRef?.trim());
  const readinessEnrolled = Object.prototype.hasOwnProperty.call(payload, 'implementationReadiness');
  const currentReadiness = readImplementationReadiness(payload);
  const readiness: WorkItemIntakeReadinessClass = observation
    ? 'not-applicable'
    : !readinessEnrolled
      ? 'legacy-missing'
      : (currentReadiness?.status ?? 'malformed');
  const qualifyingAcceptance =
    currentReadiness?.status === 'ready' && readImplementationAcceptanceEssentials(payload) !== null;

  let primaryStage: WorkItemIntakePrimaryStage;
  let reason: WorkItemIntakeStageDecision['reason'];
  if (observation) {
    primaryStage = 'observation';
    reason = 'observation-evidence';
  } else if (terminal) {
    primaryStage = 'terminal';
    reason = 'terminal-history';
  } else if (!readinessEnrolled) {
    primaryStage = 'unknown';
    reason = 'legacy-readiness-unknown';
  } else if (!currentReadiness) {
    primaryStage = 'unknown';
    reason = 'malformed-readiness-unknown';
  } else if (qualifyingAcceptance) {
    primaryStage = 'accepted';
    reason = 'qualifying-acceptance';
  } else {
    primaryStage = 'candidate';
    reason =
      currentReadiness.status === 'ready' ? 'ready-without-executable-acceptance' : 'awaiting-qualifying-acceptance';
  }

  return {
    schemaVersion: WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION,
    primaryStage,
    readiness,
    reason,
    qualifyingAcceptance,
    countsAsBugWork: input.kind === 'bug' && !observation && qualifyingAcceptance,
  };
}

type WorkItemIntakeStageSqlColumns = {
  payload?: 'payload' | 'wi.payload' | 'ei.payload';
  itemKind?: 'item_kind' | 'wi.item_kind' | 'ei.item_kind';
  status?: 'status' | 'wi.status' | 'ei.status';
  terminalOwner?: 'terminal_owner' | 'wi.terminal_owner' | 'ei.terminal_owner';
  terminalCompletionRef?: 'terminal_completion_ref' | 'wi.terminal_completion_ref' | 'ei.terminal_completion_ref';
};

/** SQL twin of deriveWorkItemIntakeStage for set-based queue projections. */
export function workItemIntakeStageSql(sql: OrgSql, columns: WorkItemIntakeStageSqlColumns = {}) {
  const payload = sql.unsafe(columns.payload ?? 'payload');
  const itemKind = sql.unsafe(columns.itemKind ?? 'item_kind');
  const status = sql.unsafe(columns.status ?? 'status');
  const terminalOwner = sql.unsafe(columns.terminalOwner ?? 'terminal_owner');
  const terminalCompletionRef = sql.unsafe(columns.terminalCompletionRef ?? 'terminal_completion_ref');
  const terminalStatuses = [...ALL_TERMINAL_STATUSES];
  const readinessStatuses = [...IMPLEMENTATION_READINESS_STATUSES];
  const readinessSources = [...IMPLEMENTATION_READINESS_SOURCES];
  const payloadJson = sql`COALESCE(${payload}, '{}'::jsonb)`;
  const readinessJson = sql`${payloadJson} -> 'implementationReadiness'`;
  const observation = sql`COALESCE(${payloadJson} ->> 'lane' = 'observation', FALSE)`;
  const terminal = sql`(
    ${status} = ANY(${terminalStatuses}::text[])
    OR (${terminalOwner} IS NOT NULL AND ${terminalCompletionRef} IS NOT NULL)
  )`;
  const readinessEnrolled = sql`${payloadJson} ? 'implementationReadiness'`;
  const readinessValid = sql`(
    jsonb_typeof(${readinessJson}) = 'object'
    AND ${readinessJson} ->> 'schemaVersion' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
    AND ${readinessJson} ->> 'status' = ANY(${readinessStatuses}::text[])
    AND ${readinessJson} ->> 'source' = ANY(${readinessSources}::text[])
    AND NULLIF(btrim(${readinessJson} ->> 'reason'), '') IS NOT NULL
    AND COALESCE(${readinessJson} ->> 'updatedAt', '') ~ ${IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE}
  )`;
  const qualifyingAcceptance = sql`(
    ${readinessValid}
    AND ${readinessJson} ->> 'status' = 'ready'
    AND NULLIF(btrim(${readinessJson} #>> '{evidence,acceptance,scope}'), '') IS NOT NULL
    AND NULLIF(btrim(${readinessJson} #>> '{evidence,acceptance,completionCheck}'), '') IS NOT NULL
  )`;

  return sql`jsonb_build_object(
    'schemaVersion', ${WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION}::text,
    'primaryStage', CASE
      WHEN ${observation} THEN 'observation'
      WHEN ${terminal} THEN 'terminal'
      WHEN NOT (${readinessEnrolled}) THEN 'unknown'
      WHEN NOT (${readinessValid}) THEN 'unknown'
      WHEN ${qualifyingAcceptance} THEN 'accepted'
      ELSE 'candidate'
    END,
    'readiness', CASE
      WHEN ${observation} THEN 'not-applicable'
      WHEN NOT (${readinessEnrolled}) THEN 'legacy-missing'
      WHEN NOT (${readinessValid}) THEN 'malformed'
      ELSE ${readinessJson} ->> 'status'
    END,
    'reason', CASE
      WHEN ${observation} THEN 'observation-evidence'
      WHEN ${terminal} THEN 'terminal-history'
      WHEN NOT (${readinessEnrolled}) THEN 'legacy-readiness-unknown'
      WHEN NOT (${readinessValid}) THEN 'malformed-readiness-unknown'
      WHEN ${qualifyingAcceptance} THEN 'qualifying-acceptance'
      WHEN ${readinessJson} ->> 'status' = 'ready' THEN 'ready-without-executable-acceptance'
      ELSE 'awaiting-qualifying-acceptance'
    END,
    'qualifyingAcceptance', ${qualifyingAcceptance},
    'countsAsBugWork', (${itemKind} = 'bug' AND NOT (${observation}) AND ${qualifyingAcceptance})
  )`;
}

const STRICT_OWNER_CAPABILITIES = new Set<ExternalBlockerCapability>([
  'credential',
  'physical-device',
  'external-service-action',
  'product-decision',
]);

// Product decisions are strict owner capabilities for typed blocker/lifecycle
// writes, but resolve-core deliberately sends them through agent review. Keep
// that review-specific distinction local instead of weakening the shared
// structured-owner-ask validator.
const AGENT_REVIEW_OWNER_ACTION_CAPABILITIES = new Set<ExternalBlockerCapability>([
  'credential',
  'physical-device',
  'external-service-action',
]);

export function isStrictOwnerActionCapability(value: unknown): value is ExternalBlockerCapability {
  return typeof value === 'string' && STRICT_OWNER_CAPABILITIES.has(value as ExternalBlockerCapability);
}

function isAgentReviewOwnerActionCapability(value: unknown): value is ExternalBlockerCapability {
  return typeof value === 'string' && AGENT_REVIEW_OWNER_ACTION_CAPABILITIES.has(value as ExternalBlockerCapability);
}

export function hasStrictOwnerAction(payloadValue: unknown): boolean {
  const payload = record(payloadValue);
  if (payload.needsOwnerAction === true) return true;
  if (isAgentReviewOwnerActionCapability(payload.humanCapability)) return true;
  return activeExternalBlockers(payload).some((blocker) => isAgentReviewOwnerActionCapability(blocker.capability));
}

/**
 * A durable owner ask encoded on the existing typed external-blocker surface.
 * The record already carries the four facts EI-13766 requires, under the shared
 * blocker vocabulary rather than a second parallel payload object:
 *   question    = summary
 *   askedOf     = the capability policy's resolutionOwner
 *   askedAt     = createdAt (createdBy records the asker)
 *   unblockedBy = nextVerb (ref is the stable condition identity)
 */
export interface StructuredOwnerAsk {
  blocker: ExternalBlockerRecord;
  question: string;
  askedOf: ReturnType<typeof externalBlockerCapabilityPolicy>['resolutionOwner'];
  askedAt: string;
  askedBy: string;
  unblockedBy: string;
}

export function readStructuredOwnerAsk(payloadValue: unknown): StructuredOwnerAsk | null {
  for (const blocker of activeExternalBlockers(payloadValue)) {
    if (blocker.kind !== 'human' || !isStrictOwnerActionCapability(blocker.capability)) continue;
    const question = blocker.summary.trim();
    const askedBy = blocker.createdBy.trim();
    const unblockedBy = blocker.nextVerb?.trim() ?? '';
    if (!question || !askedBy || !unblockedBy || !Number.isFinite(Date.parse(blocker.createdAt))) continue;
    return {
      blocker,
      question,
      askedOf: externalBlockerCapabilityPolicy(blocker.capability).resolutionOwner,
      askedAt: blocker.createdAt,
      askedBy,
      unblockedBy,
    };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readAgentReviewState(payload: unknown): AgentReviewState | null {
  const value = record(payload).agentReview;
  const row = record(value);
  if (!AGENT_REVIEW_STATUSES.includes(row.status as AgentReviewStatus)) return null;
  if (typeof row.submittedBy !== 'string' || !row.submittedBy.trim()) return null;
  if (typeof row.ledgerIdeaId !== 'string' || !row.ledgerIdeaId.trim()) return null;
  if (!Number.isInteger(row.round) || Number(row.round) < 1) return null;
  return {
    status: row.status as AgentReviewStatus,
    submittedBy: row.submittedBy,
    ledgerIdeaId: row.ledgerIdeaId,
    round: Number(row.round),
  };
}

/**
 * Narrow, server-only authority to claim one exact pending review. It is minted
 * after the reviewer lane checks the work-item and consumed by the shared claim
 * writer; the SQL still compares the full review snapshot so a concurrent grade,
 * resubmit, or submitter change invalidates the bypass.
 */
export interface AgentReviewClaimAdmission {
  readonly itemId: string;
  readonly reviewer: string;
  readonly harnessSlug: string;
  readonly submittedBy: string;
  readonly ledgerIdeaId: string;
  readonly round: number;
}

const agentReviewClaimAdmissions = new WeakSet<object>();

export function mintAgentReviewClaimAdmission(input: {
  itemId: string;
  reviewer: string;
  harnessSlug: string;
  review: AgentReviewState;
}): AgentReviewClaimAdmission | null {
  const itemId = input.itemId.trim();
  const reviewer = input.reviewer.trim();
  const harnessSlug = input.harnessSlug.trim();
  const review = input.review;
  if (
    !itemId ||
    !reviewer ||
    !harnessSlug ||
    review.status !== 'pending' ||
    review.submittedBy === reviewer ||
    !review.ledgerIdeaId.trim() ||
    !Number.isInteger(review.round) ||
    review.round < 1
  ) {
    return null;
  }
  const admission = Object.freeze({
    itemId,
    reviewer,
    harnessSlug,
    submittedBy: review.submittedBy,
    ledgerIdeaId: review.ledgerIdeaId,
    round: review.round,
  });
  agentReviewClaimAdmissions.add(admission);
  return admission;
}

export function isAgentReviewClaimAdmission(value: unknown): value is AgentReviewClaimAdmission {
  return typeof value === 'object' && value !== null && agentReviewClaimAdmissions.has(value);
}

export function matchesAgentReviewClaimAdmission(
  value: unknown,
  item: { id: string; harness?: string | null; payload: unknown },
  reviewer: string,
): value is AgentReviewClaimAdmission {
  if (
    !isAgentReviewClaimAdmission(value) ||
    value.itemId !== item.id ||
    value.reviewer !== reviewer ||
    value.harnessSlug !== item.harness
  ) {
    return false;
  }
  const current = readAgentReviewState(item.payload);
  return (
    current?.status === 'pending' &&
    current.submittedBy !== reviewer &&
    current.submittedBy === value.submittedBy &&
    current.ledgerIdeaId === value.ledgerIdeaId &&
    current.round === value.round
  );
}

/**
 * Admission-floor exception for an already-validated reviewer capability. The
 * UPDATE must still see `admission='pending'` and the same pending review payload
 * the reviewer inspected; an ordinary claim gets no such exception.
 */
export function agentReviewPendingAdmissionSql(
  sql: OrgSql,
  value: unknown,
  columns: { payload?: 'payload' | 'target.payload'; admission?: 'admission' | 'target.admission' } = {},
) {
  if (!isAgentReviewClaimAdmission(value)) return sql`FALSE`;
  const payload = sql.unsafe(columns.payload ?? 'payload');
  const admission = sql.unsafe(columns.admission ?? 'admission');
  return sql`(
    ${admission} = 'pending'
    AND ${payload} -> 'agentReview' ->> 'status' = 'pending'
    AND ${payload} -> 'agentReview' ->> 'submittedBy' = ${value.submittedBy}
    AND ${payload} -> 'agentReview' ->> 'ledgerIdeaId' = ${value.ledgerIdeaId}
    AND ${payload} -> 'agentReview' ->> 'round' = ${String(value.round)}
    AND ${value.submittedBy} <> ${value.reviewer}
  )`;
}

export interface AgentReviewCandidate {
  kind: string;
  origin?: string | null;
  payload?: unknown;
}

/**
 * Pure enrollment gate. Product decisions remain agent-reviewable by explicit
 * decision; only capabilities an agent cannot supply stay on the owner-capability
 * path. Remote rows remain owned by their authoring peer and never enter local review.
 */
export function agentReviewEligibility(
  candidate: AgentReviewCandidate,
):
  | { eligible: true }
  | { eligible: false; reason: 'not-review-kind' | 'remote-owned' | 'observation' | 'owner-capability' } {
  const payload = record(candidate.payload);
  // D-004: enrollment is a lifecycle layered onto the existing work-item. It must
  // preserve historical kinds rather than coercing review work to `change`.
  if (!['bug', 'change', 'task', 'feature'].includes(candidate.kind)) {
    return { eligible: false, reason: 'not-review-kind' };
  }
  if (candidate.origin === 'remote') return { eligible: false, reason: 'remote-owned' };
  if (payload.lane === 'observation') return { eligible: false, reason: 'observation' };
  if (hasStrictOwnerAction(payload)) {
    return { eligible: false, reason: 'owner-capability' };
  }
  return { eligible: true };
}

/**
 * Versioned readiness floor for ordinary self-selection. An absent key is the
 * explicit legacy exception; a present key passes only when this reader knows
 * its schema and it carries an affirmative ready verdict.
 */
export function implementationReadinessNormalExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'ei.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`(
    NOT (COALESCE(${payload}, '{}'::jsonb) ? 'implementationReadiness')
    OR (
      COALESCE(${payload}, '{}'::jsonb) #>> '{implementationReadiness,schemaVersion}' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
      AND COALESCE(${payload}, '{}'::jsonb) #>> '{implementationReadiness,status}' = 'ready'
    )
  )`;
}

/** Normal implementation lane: review/readiness work is invisible until approved. */
export function agentReviewNormalExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'ei.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`(
    (
      COALESCE(
        COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'revision-requested',
        FALSE
      )
      AND COALESCE(
        COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' = ${LEGACY_AGENT_REVIEW_SUBMITTER},
        FALSE
      )
    )
    OR (
      COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'
      AND COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'revision-requested'
      AND ${implementationReadinessNormalExclusionSql(sql, payloadCol)}
    )
  )`;
}

/** Reviewer lane: only submitted work, never revision work or approved work. */
export function agentReviewPendingSelectorSql(sql: OrgSql, payloadCol: 'wi.payload' | 'payload' = 'wi.payload') {
  const payload = sql.unsafe(payloadCol);
  return sql`COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'pending'`;
}
