/**
 * Agent-review lifecycle over the existing work-item queue + Blender ledger.
 *
 * `scout_routed_ideas` remains the sole grade authority. The work-item payload stores
 * routing state only; comments preserve round history.
 *
 * WHAT IS AND IS NOT RETRYABLE (WI-41691). `reconcileAgentReviewGrade` below is itself
 * convergent: it re-reads the standing ledger grade, recomputes the target status, and
 * dedupes its own side effects (`changed`, `ensureComment`), so re-invoking it after an
 * applied transition is a no-op and after a PARTIAL one completes the residue. That
 * property is NOT reachable through the supported surface. `blender:grade-idea` runs
 * `preflightAgentReviewGrade` first and returns `applied:false` with
 * `reason:'agent-review-not-pending'` — before the ledger write and before reconcile —
 * as soon as the payload has left 'pending', which a partial write is exactly what makes
 * it do. So a retry THROUGH THE TOOL cannot converge a partially-applied transition;
 * only a direct call to `reconcileAgentReviewGrade` can. That refusal is deliberate
 * (grade-idea.ts D-003/P-004: a non-pending regrade must not re-decide a settled round),
 * not an oversight — the claim that stood here until WI-41691 described the function and
 * silently promised the same of the tool.
 *
 * The gap is narrower than it was: WI-41687 removed the dominant partial-write path (the
 * revision transfer no longer throws when the submitter's session has been reaped).
 * `ensureComment` or `deliverRevision` throwing after `mergeWorkItemPayload` has
 * committed still reaches it. Whether a settled row may be re-driven at all is the
 * product question parked on WI-41689; until that is answered this comment states the
 * guarantee rather than assuming one.
 *
 * Pinned by lib/doc-claims/agent-review-retry-convergence.test.ts — if the pending guard
 * is ever relaxed to admit a converging regrade, that test fails and forces this
 * paragraph to be corrected in the same change.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  claimWorkItem,
  commentWorkItem,
  depsBlockedExclusionSql,
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  type WorkItem,
} from '../../work-items';
import { activeWorkspaceId } from '../../workspace-registry';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import {
  agentReviewEligibility,
  agentReviewPendingSelectorSql,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  readAgentReviewState,
  type AgentReviewState,
} from './agent-review-policy';

export const AGENT_REVIEW_MAX_REVISION_GRADE = 3;

export interface AgentReviewLedgerGrade {
  ideaId: string;
  workItemId: string;
  grade: number | null;
  feedback: string | null;
  gradedBy: string | null;
}

export interface AgentReviewDeps {
  getWorkItem: typeof getWorkItem;
  getWorkItemDetail: typeof getWorkItemDetail;
  mergeWorkItemPayload: typeof mergeWorkItemPayload;
  releaseWorkItem: typeof releaseWorkItem;
  claimWorkItem: typeof claimWorkItem;
  commentWorkItem: typeof commentWorkItem;
  recordRoutedIdea: typeof recordRoutedIdea;
  resolveLedgerIdeaId: (workItemId: string) => Promise<string>;
  readLedgerGrade: (ideaId: string) => Promise<AgentReviewLedgerGrade | null>;
  deliverRevision: (input: {
    to: string;
    workItemId: string;
    round: number;
    grade: number;
    feedback: string;
    gradedBy: string;
  }) => Promise<{ woken: number }>;
}

async function readLedgerGrade(ideaId: string): Promise<AgentReviewLedgerGrade | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    idea_id: string;
    routed_ref: string;
    human_grade: number | null;
    human_feedback: string | null;
    graded_by: string | null;
  }[]>`
    SELECT idea_id, routed_ref, human_grade, human_feedback, graded_by
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}`;
  const row = rows[0];
  if (!row?.routed_ref.startsWith('wi:')) return null;
  return {
    ideaId: row.idea_id,
    workItemId: row.routed_ref.slice(3),
    grade: row.human_grade == null ? null : Number(row.human_grade),
    feedback: row.human_feedback,
    gradedBy: row.graded_by,
  };
}

/**
 * Preserve a pre-existing same-id Blender row when it belongs to another
 * artifact. D-004 reserves exactly one deterministic fallback so migration
 * retries converge and payload.agentReview can point at the real grade authority.
 */
export async function resolveLedgerIdeaId(workItemId: string): Promise<string> {
  const { sql } = getOrgPg();
  const fallback = `agent-review:${workItemId}`;
  const rows = await sql<{ idea_id: string; routed_ref: string }[]>`
    SELECT idea_id, routed_ref
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id IN (${workItemId}, ${fallback})`;
  const byId = new Map(rows.map((row) => [row.idea_id, row.routed_ref]));
  const routedRef = `wi:${workItemId}`;
  const primary = byId.get(workItemId);
  if (primary == null || primary === routedRef) return workItemId;
  const fallbackRoute = byId.get(fallback);
  if (fallbackRoute == null || fallbackRoute === routedRef) return fallback;
  throw new Error(
    `agent review ledger collision: '${workItemId}' and '${fallback}' both route to other artifacts`,
  );
}

async function deliverRevision(input: {
  to: string;
  workItemId: string;
  round: number;
  grade: number;
  feedback: string;
  gradedBy: string;
}): Promise<{ woken: number }> {
  const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
    import('../../agent-tools/coordination/messages'),
    import('../../agent-tools/coordination/inbox-wake'),
  ]);
  const summary = `Agent review round ${input.round} requests revision on ${input.workItemId}`;
  const body =
    `${input.gradedBy} graded ${input.workItemId} ${input.grade}/5.\n\n${input.feedback}\n\n` +
    `Revise the same work item, then call improvements:agent-review { mode:'resubmit', id:'${input.workItemId}' }.`;
  await sendMessage(
    {
      ownerId: 'agent-review-revision',
      ownerLabel: 'agent review',
      source: 'static-client' as const,
      workspaceId: null,
      userId: null,
    },
    { to: [input.to], summary, body },
  );
  try {
    return await wakeRecipients([input.to], { summary, source: 'agent-review-revision' });
  } catch {
    return { woken: 0 };
  }
}

const defaultDeps: AgentReviewDeps = {
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  claimWorkItem,
  commentWorkItem,
  recordRoutedIdea,
  resolveLedgerIdeaId,
  readLedgerGrade,
  deliverRevision,
};

export interface EnterAgentReviewInput {
  id: string;
  submittedBy: string;
  harnessSlug?: string;
  workspaceId?: string;
}

export async function enterAgentReview(
  input: EnterAgentReviewInput,
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ entered: boolean; state?: AgentReviewState; reason?: string }> {
  const workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem) return { entered: false, reason: 'not-found' };
  const eligibility = agentReviewEligibility(workItem);
  if (!eligibility.eligible) return { entered: false, reason: eligibility.reason };

  const existing = readAgentReviewState(workItem.payload);
  if (existing?.status === 'approved') return { entered: false, state: existing, reason: 'already-approved' };
  const ledgerIdeaId = existing?.ledgerIdeaId ?? await deps.resolveLedgerIdeaId(workItem.id);
  const next: AgentReviewState = existing?.status === 'pending'
    ? existing
    : {
        status: 'pending',
        submittedBy: existing?.submittedBy ?? input.submittedBy,
        ledgerIdeaId,
        round: existing ? existing.round + 1 : 1,
      };

  const harnessSlug = input.harnessSlug ?? workItem.harness;
  if (!harnessSlug) throw new Error(`enterAgentReview: work item '${workItem.id}' has no harness`);
  await deps.recordRoutedIdea({
    ideaId: next.ledgerIdeaId,
    lens: 'agent-review',
    rail: 'improvement',
    routedRef: `wi:${workItem.id}`,
    harnessSlug,
    title: workItem.title,
    origin: 'agent-review',
    createdBy: next.submittedBy,
    preserveExisting: true,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const merged = await deps.mergeWorkItemPayload(workItem.id, { agentReview: next }, {
    harness: harnessSlug,
    unset: ['needsHuman', 'needsOwnerAction'],
  });
  if (!merged) throw new Error(`enterAgentReview: work item '${workItem.id}' disappeared during enrollment`);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      harness: harnessSlug,
      expectedAssignee: workItem.assignee,
    });
    if (!released) throw new Error(`enterAgentReview: could not release submitter claim on '${workItem.id}'`);
  }
  return { entered: !existing || existing.status !== 'pending', state: next };
}

export async function resubmitAgentReview(
  input: { id: string; submittedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ resubmitted: boolean; state?: AgentReviewState; reason?: string }> {
  const workItem = await deps.getWorkItem(input.id);
  if (!workItem) return { resubmitted: false, reason: 'not-found' };
  const current = readAgentReviewState(workItem.payload);
  if (!current) return { resubmitted: false, reason: 'not-agent-review' };
  const isLegacyRebind = current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER;
  if (isLegacyRebind && workItem.assignee !== input.submittedBy) {
    return { resubmitted: false, state: current, reason: 'legacy-revision-not-claimant' };
  }
  if (!isLegacyRebind && current.submittedBy !== input.submittedBy) {
    return { resubmitted: false, state: current, reason: 'not-submitter' };
  }
  if (current.status !== 'revision-requested') {
    return { resubmitted: false, state: current, reason: `not-revision-requested:${current.status}` };
  }
  const next: AgentReviewState = {
    ...current,
    status: 'pending',
    submittedBy: isLegacyRebind ? input.submittedBy : current.submittedBy,
    round: current.round + 1,
  };
  const merged = await deps.mergeWorkItemPayload(workItem.id, { agentReview: next }, {
    ...(workItem.harness ? { harness: workItem.harness } : {}),
    unset: ['needsHuman', 'needsOwnerAction'],
  });
  if (!merged) throw new Error(`resubmitAgentReview: work item '${workItem.id}' disappeared`);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: input.submittedBy,
    });
    if (!released) throw new Error(`resubmitAgentReview: '${workItem.id}' is held by another agent`);
  }
  return { resubmitted: true, state: next };
}

export interface AgentReviewGradePreflight {
  applicable: boolean;
  workItemId?: string;
  state?: AgentReviewState;
  refusal?: 'agent-review-feedback-required' | 'agent-review-not-pending';
}

export async function preflightAgentReviewGrade(
  input: { ideaId: string; grade: number; feedback?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewGradePreflight> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return { applicable: false };
  const workItem = await deps.getWorkItem(ledger.workItemId);
  const state = workItem ? readAgentReviewState(workItem.payload) : null;
  if (!state || state.ledgerIdeaId !== input.ideaId) return { applicable: false };
  if (state.status !== 'pending') {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-not-pending' };
  }
  if (input.grade <= AGENT_REVIEW_MAX_REVISION_GRADE && !input.feedback?.trim()) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-feedback-required' };
  }
  return { applicable: true, workItemId: workItem!.id, state };
}

function revisionComment(round: number, grade: number, feedback: string, gradedBy: string): string {
  return `Agent review round ${round}: revision requested by ${gradedBy} (grade ${grade}/5).\n\n${feedback}`;
}

function approvalComment(round: number, grade: number, gradedBy: string): string {
  return `Agent review round ${round}: approved by ${gradedBy} (grade ${grade}/5). Implementation is re-admitted; this approval does not close the work item.`;
}

async function ensureComment(
  workItem: WorkItem,
  body: string,
  author: string,
  deps: AgentReviewDeps,
): Promise<boolean> {
  const detail = await deps.getWorkItemDetail(workItem.id, workItem.harness ?? undefined);
  if (detail?.posts.some((post) => post.body === body)) return false;
  const written = await deps.commentWorkItem(
    workItem.id,
    body,
    author,
    workItem.harness ? { harness: workItem.harness } : {},
  );
  if (!written) throw new Error(`agent review could not persist round history on '${workItem.id}'`);
  return true;
}

export interface AgentReviewReconcileOutcome {
  workItemId: string;
  status: 'revision-requested' | 'approved';
  round: number;
  changed: boolean;
  woken?: number;
  /**
   * WI-41687: whether the row ended up held by its original submitter. False means the
   * transfer could not be made (typically a reaped submitter session) and the reviewer's
   * claim was dropped instead, leaving the row unassigned in 'revision-requested'. The
   * revision itself is still fully recorded — grade, payload and round comment — so this
   * reports a weaker DISPOSITION, never a failed review.
   */
  returnedToSubmitter?: boolean;
}

export async function reconcileAgentReviewGrade(
  input: { ideaId: string; gradedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewReconcileOutcome | null> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return null;
  const workItem = await deps.getWorkItem(ledger.workItemId);
  if (!workItem) return null;
  const current = readAgentReviewState(workItem.payload);
  if (!current || current.ledgerIdeaId !== input.ideaId) return null;
  if (ledger.grade == null) throw new Error(`agent review ledger '${input.ideaId}' has no standing grade`);

  const grade = ledger.grade;
  const gradedBy = ledger.gradedBy ?? input.gradedBy;
  if (grade <= AGENT_REVIEW_MAX_REVISION_GRADE) {
    const feedback = ledger.feedback?.trim();
    if (!feedback) throw new Error('agent-review-feedback-required');
    const next: AgentReviewState = { ...current, status: 'revision-requested' };
    const changed = current.status !== next.status;
    const merged = await deps.mergeWorkItemPayload(workItem.id, { agentReview: next }, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      unset: ['needsHuman', 'needsOwnerAction'],
    });
    if (!merged) throw new Error(`agent review could not persist revision state on '${workItem.id}'`);
    const commentAdded = await ensureComment(
      workItem,
      revisionComment(current.round, grade, feedback, gradedBy),
      gradedBy,
      deps,
    );
    if (current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER) {
      if (changed && workItem.assignee) {
        const released = await deps.releaseWorkItem(workItem.id, {
          ...(workItem.harness ? { harness: workItem.harness } : {}),
          expectedAssignee: gradedBy,
        });
        if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
      }
      return { workItemId: workItem.id, status: 'revision-requested', round: current.round, changed };
    }
    let returnedToSubmitter = true;
    if (changed) {
      const transferred = await deps.claimWorkItem(workItem.id, current.submittedBy, {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        ...(workItem.assignee ? { fromHolder: gradedBy } : {}),
      });
      if (!transferred) {
        // WI-41687: the submitter frequently no longer EXISTS by review time — a session
        // that filed a report hours earlier is routinely reaped, and a reaped owner cannot
        // take a claim. This is the common case, not an edge case.
        //
        // Throwing here stranded the row twice over. By this point the ledger grade, the
        // payload flip to 'revision-requested' and the round comment have ALL committed,
        // so the caller saw a hard error for a transition that was three-quarters applied;
        // the row kept the REVIEWER's claim (an agent who is not implementing it); and the
        // regrade path then refused to re-drive the transfer at all, because the payload had
        // already left 'pending' ('agent-review-not-pending'). Nothing could recover it
        // through the supported surface.
        //
        // Fall back to the disposition the LEGACY_AGENT_REVIEW_SUBMITTER branch above already
        // uses for "no real submitter to hand this to", and that the approval path below uses
        // unconditionally: drop the reviewer's claim and leave the row unassigned in
        // 'revision-requested'. Release is best-effort — if it also fails the row is no worse
        // off than before, and `returnedToSubmitter:false` reports the weaker disposition
        // rather than hiding it behind a thrown error.
        returnedToSubmitter = false;
        if (workItem.assignee) {
          await deps.releaseWorkItem(workItem.id, {
            ...(workItem.harness ? { harness: workItem.harness } : {}),
            expectedAssignee: gradedBy,
          });
        }
      }
    }
    let woken: number | undefined;
    if (changed || commentAdded) {
      woken = (await deps.deliverRevision({
        to: current.submittedBy,
        workItemId: workItem.id,
        round: current.round,
        grade,
        feedback,
        gradedBy,
      })).woken;
    }
    return { workItemId: workItem.id, status: 'revision-requested', round: current.round, changed, returnedToSubmitter, ...(woken === undefined ? {} : { woken }) };
  }

  const next: AgentReviewState = { ...current, status: 'approved' };
  const changed = current.status !== next.status;
  const merged = await deps.mergeWorkItemPayload(workItem.id, { agentReview: next }, {
    ...(workItem.harness ? { harness: workItem.harness } : {}),
    unset: ['needsHuman', 'needsOwnerAction'],
  });
  if (!merged) throw new Error(`agent review could not persist approval state on '${workItem.id}'`);
  await ensureComment(workItem, approvalComment(current.round, grade, gradedBy), gradedBy, deps);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: gradedBy,
    });
    if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
  }
  return { workItemId: workItem.id, status: 'approved', round: current.round, changed };
}

/** Reviewer pickup over the unified queue; direct claims still use claimWorkItem's CAS. */
export async function claimNextAgentReview(
  input: { reviewer: string; harnessSlug?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND status = 'open'
       AND item_kind IN ('bug', 'change', 'task', 'feature')
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND ${depsBlockedExclusionSql(sql)}
       AND ${agentReviewPendingSelectorSql(sql)}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${input.reviewer}
       AND ${input.harnessSlug ? sql`harness_slug = ${input.harnessSlug}` : sql`TRUE`}
     ORDER BY feature_order ASC NULLS LAST, created_ts ASC
     LIMIT 25`;
  for (const row of rows) {
    const workItem = await deps.getWorkItem(row.feature_id, input.harnessSlug);
    if (!workItem || !agentReviewEligibility(workItem).eligible) continue;
    const claimed = await deps.claimWorkItem(workItem.id, input.reviewer, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
    });
    if (claimed) return claimed;
  }
  return null;
}
