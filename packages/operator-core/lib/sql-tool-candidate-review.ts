/** Passive demand enters the existing review queue; never generates or executes tools. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { newCollisionResistantIssueTail } from './issues-engineer';
import { captureImprovement, type CaptureImprovementInput } from './harness/improvements/capture-core';
import { enterAgentReview } from './harness/improvements/agent-review';
import { readAgentReviewState } from './harness/improvements/agent-review-policy';
import { getWorkItem, setWorkItemStateWithAliasInfo, type WorkItem } from './work-items';
import type { SqlToolCandidateScore } from './sql-tool-candidate-score';
import type { SqlToolRecommendation } from './bash-substitution/sql-tool-recommendations';
import { activeWorkspaceId } from './workspace-registry';
import { ALL_SUCCESSFUL_STATUSES, ALL_TERMINAL_STATUSES } from './work-item-blocking';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface SqlCandidateReviewInput {
  workspaceId: string;
  harnessSlug: string;
  submittedBy: string;
  candidate: SqlToolCandidateScore;
  /** Versioned contract identity; counts and observation dates are not material editions. */
  contractRef: string;
  recommendation?: SqlToolRecommendation;
}
export function sqlCandidateReviewIdentity(input: SqlCandidateReviewInput) {
  if (!input.workspaceId || !input.harnessSlug || !input.submittedBy || !input.contractRef)
    throw new Error('invalid_sql_candidate_review_identity');
  const lifecycleId = hash([input.workspaceId, input.harnessSlug, input.candidate.id]);
  const r = input.recommendation;
  const editionId = hash([input.contractRef, r?.kind ?? 'review-demand', r?.toolName ?? null,
    [...(r?.missingFeatures ?? [])].sort()]);
  return { lifecycleId, editionId, conditionKey: `sql-candidate:${lifecycleId}:${editionId}` };
}
export interface SqlCandidateReviewDeps {
  client?: ReturnType<typeof getOrgPg>['sql'];
  capture?: (input: CaptureImprovementInput) => Promise<unknown>;
  enroll?: typeof enterAgentReview;
  read?: (id: string, harness: string) => Promise<WorkItem | null>;
  open?: (id: string, harness: string, by: string) => Promise<void>;
}
export interface SqlCandidateReviewResult {
  status: 'ineligible' | 'suppressed' | 'pending' | 'accepted' | 'declined' | 'UNKNOWN';
  lifecycleId: string;
  editionId: string;
  workItemId: string | null;
  /** Authoritative post-review read; the initial capture assignment is never proof. */
  owner: string | null;
  queue: 'agent-review' | 'implementation' | null;
}
export async function submitSqlCandidateReview(
  input: SqlCandidateReviewInput, deps: SqlCandidateReviewDeps = {},
): Promise<SqlCandidateReviewResult> {
  const identity = sqlCandidateReviewIdentity(input);
  const answer = (status: SqlCandidateReviewResult['status'], workItemId: string | null = null,
    owner: string | null = null, queue: SqlCandidateReviewResult['queue'] = null): SqlCandidateReviewResult =>
    ({ status, lifecycleId: identity.lifecycleId, editionId: identity.editionId, workItemId, owner, queue });
  if (!input.candidate.eligible) return answer('ineligible');
  if (input.recommendation?.kind === 'insufficient-evidence') return answer('ineligible');
  // Production capture writes through the existing workspace context. Fail closed
  // before reserving or filing if that context differs from the candidate's scope.
  if (!deps.capture && activeWorkspaceId() !== input.workspaceId) return answer('UNKNOWN');
  const sql = deps.client ?? getOrgPg().sql;
  const suppress = ['keep-sql', 'route-existing'].includes(input.recommendation?.kind ?? '');
  const rows = await sql<{ artifact_id: string; suppressed: boolean }[]>`
    INSERT INTO harness_shared.sql_candidate_reviews
      (workspace_id,harness_slug,lifecycle_id,edition_id,artifact_id,suppressed)
    VALUES (${input.workspaceId},${input.harnessSlug},${identity.lifecycleId},${identity.editionId},
      ${'EI-' + newCollisionResistantIssueTail()},${suppress})
    ON CONFLICT (workspace_id,harness_slug,lifecycle_id,edition_id) DO UPDATE
      SET lifecycle_id=EXCLUDED.lifecycle_id
    RETURNING artifact_id,suppressed`;
  const reservation = rows[0];
  if (!reservation) return answer('UNKNOWN');
  if (reservation.suppressed) return answer('suppressed');
  const id = reservation.artifact_id;
  const read = deps.read ?? getWorkItem;
  let item = await read(id, input.harnessSlug);
  if (!item) {
    await (deps.capture ?? captureImprovement)({
      artifactId: id, watchdogKey: identity.conditionKey, kind: 'feature',
      scope: `harness:${input.harnessSlug}`, workspaceId: input.workspaceId,
      createdBy: input.submittedBy, reviewRequired: true, reviewHarness: input.harnessSlug,
      title: 'Review recurring SQL intent ' + identity.lifecycleId.slice(0, 12),
      body: 'Passive recurring SQL demand. Review scoped evidence and current contracts before proposing implementation. No tool is generated or executed.\n'
        + JSON.stringify({ lifecycleId: identity.lifecycleId, editionId: identity.editionId,
          contractRef: input.contractRef, policyVersion: input.candidate.policyVersion,
          recommendation: input.recommendation?.kind ?? 'review-demand' }),
      payloadExtra: { sqlCandidateReview: { lifecycleId: identity.lifecycleId, editionId: identity.editionId } },
    });
    item = await read(id, input.harnessSlug);
  }
  if (!item || item.harness !== input.harnessSlug) return answer('UNKNOWN', id);
  const review = readAgentReviewState(item.payload);
  if (ALL_TERMINAL_STATUSES.has(item.state))
    return answer(ALL_SUCCESSFUL_STATUSES.has(item.state) ? 'accepted' : 'declined', id, item.assignee);
  if (review?.status === 'approved') return answer('accepted', id, item.assignee, 'implementation');
  if (!review) {
    const enrolled = await (deps.enroll ?? enterAgentReview)({ id, submittedBy: input.submittedBy,
      harnessSlug: input.harnessSlug, workspaceId: input.workspaceId });
    if (!enrolled.entered && enrolled.state?.status !== 'pending') return answer('UNKNOWN', id);
  }
  // Recovery after enrollment committed but the subsequent reopen was interrupted.
  if (!review || (review.status === 'pending' && item.state === 'blocked')) {
    await (deps.open ?? (async (workId, harness, by) => {
      const result = await setWorkItemStateWithAliasInfo(workId, 'open', { harness, by, reason: 'SQL candidate entered canonical review' });
      if ((result.appliedState ?? result.workItem?.state) !== 'open') throw new Error('sql_candidate_review_reopen_failed');
    }))(id, input.harnessSlug, input.submittedBy);
  }
  item = await read(id, input.harnessSlug);
  if (!item) return answer('UNKNOWN', id);
  const post = readAgentReviewState(item.payload);
  if (post?.status === 'approved') return answer('accepted', id, item.assignee, 'implementation');
  return post && item.state === 'open'
    ? answer('pending', id, item.assignee, 'agent-review') : answer('UNKNOWN', id);
}
