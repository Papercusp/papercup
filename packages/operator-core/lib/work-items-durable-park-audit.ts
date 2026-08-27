/**
 * Deterministic, report-only durable-park audit (work-queue-admission-and-bulk-dedup P-020).
 *
 * This extends the existing admission run ledger instead of creating another audit store.
 * The four queue-control axes deliberately overlap: a row may have an active claim, a
 * hold-open lease, a durable park, and an agent-review state at the same time. Nothing in
 * this module clears a hold or changes a work-item.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { readAgentReviewState } from './harness/improvements/agent-review-policy';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { readWorkItemClaimHoldProvenance, type OrgSql } from './work-items';

export const WORK_ITEM_DURABLE_PARK_AUDIT = 'work-item-durable-park-audit';
export const DURABLE_PARK_AUDIT_RUN_KIND = 'daily-digest' as const;
export const DEFAULT_AGENT_REVIEW_OVERDUE_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1_000;
const STATED_UNPARK_CONDITION =
  /\b(?:unpark|unhold|release|resume|clear)\b|\b(?:when|once|after|until|unless)\b/i;

export type AuditAgeStatus = 'known' | 'missing' | 'invalid';
export type AuditAgeBucket = 'under-1d' | '1-7d' | '7-30d' | '30d-plus' | 'unknown';
export type UnparkConditionStatus = 'stated' | 'missing' | 'unresolved';

export interface DurableParkAuditSourceRow {
  id: string;
  title: string | null;
  state: string;
  takenBy: string | null;
  takenAt: string | null;
  updatedAtMs: number | null;
  payload: unknown;
  reviewRoutedAtMs: number | null;
}

export interface AuditAge {
  status: AuditAgeStatus;
  ageMs: number | null;
  bucket: AuditAgeBucket;
}

export interface DurableParkAuditParkRow {
  id: string;
  title: string | null;
  state: string;
  parker: string;
  reason: string | null;
  parkedAt: string | null;
  age: AuditAge;
  unparkCondition: {
    status: UnparkConditionStatus;
    text: string | null;
  };
}

export interface DurableParkAuditLeaseRow {
  id: string;
  holder: string;
  reason: string | null;
  heldAt: string | null;
  age: AuditAge;
}

export interface DurableParkAuditReviewRow {
  id: string;
  status: 'pending';
  submittedBy: string;
  ledgerIdeaId: string;
  round: number;
  routedAt: string;
  ageMs: number;
}

export interface DurableParkAuditReport {
  schemaVersion: 'durable-park-audit-v1';
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  generatedAt: string;
  reportOnly: true;
  modelCalled: false;
  population: {
    nonTerminal: number;
    axes: {
      activeClaims: number;
      rawClaimHolds: number;
      holdOpenLeases: number;
      durableParks: number;
      pendingAgentReview: number;
      revisionRequestedAgentReview: number;
    };
    note: string;
  };
  parkAgeBuckets: Record<AuditAgeBucket, number>;
  unparkConditions: Record<UnparkConditionStatus, number>;
  missingMetadata: {
    unattributedClaimHolds: number;
    parkReason: number;
    parkTimestamp: number;
    invalidParkTimestamp: number;
    pendingReviewTimestamp: number;
  };
  reasons: Array<{ reason: string; count: number }>;
  durableParks: DurableParkAuditParkRow[];
  holdOpenLeases: DurableParkAuditLeaseRow[];
  overdueReviews: {
    thresholdHours: number;
    timestampBasis: 'scout_routed_ideas.routed_at';
    rows: DurableParkAuditReviewRow[];
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ageBucket(ageMs: number): AuditAgeBucket {
  if (ageMs < DAY_MS) return 'under-1d';
  if (ageMs < 7 * DAY_MS) return '1-7d';
  if (ageMs < 30 * DAY_MS) return '7-30d';
  return '30d-plus';
}

export function classifyAuditAge(at: string | null, nowMs: number): AuditAge {
  if (!at) return { status: 'missing', ageMs: null, bucket: 'unknown' };
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return { status: 'invalid', ageMs: null, bucket: 'unknown' };
  const ageMs = Math.max(0, nowMs - parsed);
  return { status: 'known', ageMs, bucket: ageBucket(ageMs) };
}

export function classifyUnparkCondition(reason: string | null): {
  status: UnparkConditionStatus;
  text: string | null;
} {
  const text = reason?.trim() || null;
  if (!text) return { status: 'missing', text: null };
  return {
    status: STATED_UNPARK_CONDITION.test(text) ? 'stated' : 'unresolved',
    text,
  };
}

export function buildDurableParkAuditReport(input: {
  rows: readonly DurableParkAuditSourceRow[];
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  nowMs: number;
  reviewOverdueHours?: number;
}): DurableParkAuditReport {
  const parkAgeBuckets: Record<AuditAgeBucket, number> = {
    'under-1d': 0,
    '1-7d': 0,
    '7-30d': 0,
    '30d-plus': 0,
    unknown: 0,
  };
  const unparkConditions: Record<UnparkConditionStatus, number> = {
    stated: 0,
    missing: 0,
    unresolved: 0,
  };
  const missingMetadata = {
    unattributedClaimHolds: 0,
    parkReason: 0,
    parkTimestamp: 0,
    invalidParkTimestamp: 0,
    pendingReviewTimestamp: 0,
  };
  const axes = {
    activeClaims: 0,
    rawClaimHolds: 0,
    holdOpenLeases: 0,
    durableParks: 0,
    pendingAgentReview: 0,
    revisionRequestedAgentReview: 0,
  };
  const durableParks: DurableParkAuditParkRow[] = [];
  const holdOpenLeases: DurableParkAuditLeaseRow[] = [];
  const overdueRows: DurableParkAuditReviewRow[] = [];
  const reasonCounts = new Map<string, number>();
  const reviewOverdueHours = Math.max(1, Math.floor(input.reviewOverdueHours ?? DEFAULT_AGENT_REVIEW_OVERDUE_HOURS));
  const reviewOverdueMs = reviewOverdueHours * 60 * 60 * 1_000;

  for (const row of input.rows) {
    if (row.takenBy) axes.activeClaims += 1;
    const payload = record(row.payload);
    const rawClaimHold = String(payload._claimHold) === 'true';
    if (rawClaimHold) axes.rawClaimHolds += 1;
    const provenance = readWorkItemClaimHoldProvenance(payload);
    if (rawClaimHold && !provenance.attributed) missingMetadata.unattributedClaimHolds += 1;

    if (provenance.heldOpen) {
      axes.holdOpenLeases += 1;
      holdOpenLeases.push({
        id: row.id,
        holder: provenance.heldOpen.by,
        reason: provenance.heldOpen.reason,
        heldAt: provenance.heldOpen.at,
        age: classifyAuditAge(provenance.heldOpen.at, input.nowMs),
      });
    }

    if (provenance.parked) {
      axes.durableParks += 1;
      const age = classifyAuditAge(provenance.parked.at, input.nowMs);
      const unparkCondition = classifyUnparkCondition(provenance.parked.reason);
      parkAgeBuckets[age.bucket] += 1;
      unparkConditions[unparkCondition.status] += 1;
      if (!provenance.parked.reason?.trim()) missingMetadata.parkReason += 1;
      if (age.status === 'missing') missingMetadata.parkTimestamp += 1;
      if (age.status === 'invalid') missingMetadata.invalidParkTimestamp += 1;
      const reason = provenance.parked.reason?.trim();
      if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      durableParks.push({
        id: row.id,
        title: row.title,
        state: row.state,
        parker: provenance.parked.by,
        reason: provenance.parked.reason,
        parkedAt: provenance.parked.at,
        age,
        unparkCondition,
      });
    }

    const review = readAgentReviewState(payload);
    if (review?.status === 'pending') {
      axes.pendingAgentReview += 1;
      const routedAtMs = numberOrNull(row.reviewRoutedAtMs);
      if (routedAtMs == null) {
        missingMetadata.pendingReviewTimestamp += 1;
      } else {
        const reviewAgeMs = Math.max(0, input.nowMs - routedAtMs);
        if (reviewAgeMs >= reviewOverdueMs) {
          overdueRows.push({
            id: row.id,
            status: 'pending',
            submittedBy: review.submittedBy,
            ledgerIdeaId: review.ledgerIdeaId,
            round: review.round,
            routedAt: new Date(routedAtMs).toISOString(),
            ageMs: reviewAgeMs,
          });
        }
      }
    } else if (review?.status === 'revision-requested') {
      axes.revisionRequestedAgentReview += 1;
    }
  }

  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  durableParks.sort(byId);
  holdOpenLeases.sort(byId);
  overdueRows.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
  const reasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    schemaVersion: 'durable-park-audit-v1',
    runId: input.runId,
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    generatedAt: new Date(input.nowMs).toISOString(),
    reportOnly: true,
    modelCalled: false,
    population: {
      nonTerminal: input.rows.length,
      axes,
      note:
        'Axes overlap by design: active claim, hold-open lease, durable park, and agent review are independent facts.',
    },
    parkAgeBuckets,
    unparkConditions,
    missingMetadata,
    reasons,
    durableParks,
    holdOpenLeases,
    overdueReviews: {
      thresholdHours: reviewOverdueHours,
      timestampBasis: 'scout_routed_ideas.routed_at',
      rows: overdueRows,
    },
  };
}

type AuditDbRow = {
  id: string;
  title: string | null;
  state: string;
  taken_by: string | null;
  taken_at: Date | string | null;
  updated_ts: bigint | number | string | null;
  payload: unknown;
  review_routed_at_ms: bigint | number | string | null;
};

function instant(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function runWorkItemDurableParkAudit(opts: {
  workspaceId: string;
  harnessSlug: string;
  runId?: string;
  now?: () => number;
  reviewOverdueHours?: number;
  sql?: OrgSql;
}): Promise<DurableParkAuditReport> {
  const sql = opts.sql ?? getOrgPg().sql;
  const runId = opts.runId?.trim() || `${WORK_ITEM_DURABLE_PARK_AUDIT}:${randomUUID()}`;
  const now = opts.now ?? Date.now;
  const startedAtMs = now();

  const existing = await sql<Array<{ detail: Record<string, unknown> | null }>>`
    SELECT detail
      FROM harness_shared.admission_runs
     WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}
     LIMIT 1`;
  const existingDetail = record(existing[0]?.detail);
  if (existingDetail.status === 'complete' && existingDetail.mode === 'durable-park-audit') {
    const report = record(existingDetail.report);
    if (report.schemaVersion === 'durable-park-audit-v1') return report as unknown as DurableParkAuditReport;
  }

  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES
      (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, ${DURABLE_PARK_AUDIT_RUN_KIND},
       ${new Date(startedAtMs)},
       ${JSON.stringify({ status: 'running', mode: 'durable-park-audit', reportOnly: true })}::text::jsonb)
    ON CONFLICT (id) DO NOTHING`;

  try {
    const rows = await sql<AuditDbRow[]>`
      SELECT wi.feature_id AS id,
             wi.title,
             wi.status AS state,
             wi.taken_by,
             wi.taken_at,
             wi.updated_ts,
             wi.payload,
             sri.routed_at AS review_routed_at_ms
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.scout_routed_ideas sri
          ON sri.workspace_id = wi.workspace_id
         AND sri.idea_id = COALESCE(wi.payload, '{}'::jsonb) -> 'agentReview' ->> 'ledgerIdeaId'
       WHERE wi.workspace_id = ${opts.workspaceId}
         AND wi.harness_slug = ${opts.harnessSlug}
         AND NOT (wi.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       ORDER BY wi.feature_id`;
    const report = buildDurableParkAuditReport({
      rows: rows.map((row) => ({
        id: row.id,
        title: row.title,
        state: row.state,
        takenBy: row.taken_by,
        takenAt: instant(row.taken_at),
        updatedAtMs: numberOrNull(row.updated_ts),
        payload: row.payload,
        reviewRoutedAtMs: numberOrNull(row.review_routed_at_ms),
      })),
      runId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      nowMs: now(),
      reviewOverdueHours: opts.reviewOverdueHours,
    });
    const latencyMs = Math.max(0, now() - startedAtMs);
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(now())},
             batch_size = ${report.population.nonTerminal},
             held = ${report.population.axes.durableParks},
             model_id = NULL,
             tokens_in = 0,
             tokens_out = 0,
             latency_ms = ${latencyMs},
             detail = ${JSON.stringify({
               status: 'complete',
               mode: 'durable-park-audit',
               reportOnly: true,
               report,
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    return report;
  } catch (error) {
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(now())},
             latency_ms = ${Math.max(0, now() - startedAtMs)},
             detail = ${JSON.stringify({
               status: 'failed',
               mode: 'durable-park-audit',
               reportOnly: true,
               error: error instanceof Error ? error.message : String(error),
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    throw error;
  }
}
