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
import { activeExternalBlockers, type ExternalBlockerCapability } from '../../external-blockers';

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

const STRICT_OWNER_CAPABILITIES = new Set<ExternalBlockerCapability>([
  'credential',
  'physical-device',
  'external-service-action',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
export function agentReviewEligibility(candidate: AgentReviewCandidate):
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
  if (payload.needsOwnerAction === true) return { eligible: false, reason: 'owner-capability' };

  const directCapability = payload.humanCapability as ExternalBlockerCapability | undefined;
  if (directCapability && STRICT_OWNER_CAPABILITIES.has(directCapability)) {
    return { eligible: false, reason: 'owner-capability' };
  }
  if (activeExternalBlockers(payload).some((blocker) => STRICT_OWNER_CAPABILITIES.has(blocker.capability))) {
    return { eligible: false, reason: 'owner-capability' };
  }
  return { eligible: true };
}

/** Normal implementation lane: review work is invisible until approved. */
export function agentReviewNormalExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'ei.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`(
    COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'
    AND (
      COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'revision-requested'
      OR COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' = ${LEGACY_AGENT_REVIEW_SUBMITTER}
    )
  )`;
}

/** Reviewer lane: only submitted work, never revision work or approved work. */
export function agentReviewPendingSelectorSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'pending'`;
}
