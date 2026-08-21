/**
 * Agent-review lifecycle over the existing work-item queue + Blender ledger.
 *
 * `scout_routed_ideas` remains the sole grade authority. The work-item payload stores
 * routing state only; comments preserve round history. Every write is retryable: a
 * retry re-reads the standing ledger grade and converges the payload before returning.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  claimIssue,
  commentIssue,
  getIssue,
  getIssueDetail,
  getIssueInWorkspace,
  issuesScopeWorkspace,
  mergeIssuePayload,
  releaseIssue,
  type EngineerIssue,
} from '../../issues-engineer';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { depsBlockedExclusionSql } from '../../work-items';
import {
  agentReviewEligibility,
  agentReviewPendingSelectorSql,
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
  getIssue: typeof getIssue;
  getIssueDetail: typeof getIssueDetail;
  mergeIssuePayload: typeof mergeIssuePayload;
  releaseIssue: typeof releaseIssue;
  claimIssue: typeof claimIssue;
  commentIssue: typeof commentIssue;
  recordRoutedIdea: typeof recordRoutedIdea;
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
  getIssue,
  getIssueDetail,
  mergeIssuePayload,
  releaseIssue,
  claimIssue,
  commentIssue,
  recordRoutedIdea,
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
  const issue = await deps.getIssue(input.id);
  if (!issue) return { entered: false, reason: 'not-found' };
  const eligibility = agentReviewEligibility(issue);
  if (!eligibility.eligible) return { entered: false, reason: eligibility.reason };

  const existing = readAgentReviewState(issue.payload);
  if (existing?.status === 'approved') return { entered: false, state: existing, reason: 'already-approved' };
  const next: AgentReviewState = existing?.status === 'pending'
    ? existing
    : {
        status: 'pending',
        submittedBy: existing?.submittedBy ?? input.submittedBy,
        ledgerIdeaId: existing?.ledgerIdeaId ?? issue.id,
        round: existing ? existing.round + 1 : 1,
      };

  const harnessSlug = input.harnessSlug ?? (issue.scope.startsWith('harness:') ? issue.scope.slice(8) : 'papercusp');
  await deps.recordRoutedIdea({
    ideaId: next.ledgerIdeaId,
    lens: 'agent-review',
    rail: 'improvement',
    routedRef: `wi:${issue.id}`,
    harnessSlug,
    title: issue.title,
    origin: 'agent-review',
    createdBy: next.submittedBy,
    preserveExisting: true,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const merged = await deps.mergeIssuePayload(issue.id, { agentReview: next }, { unset: ['needsHuman'] });
  if (!merged) throw new Error(`enterAgentReview: work item '${issue.id}' disappeared during enrollment`);
  if (issue.assignee) {
    const released = await deps.releaseIssue(issue.id, { expectedAssignee: issue.assignee });
    if (!released) throw new Error(`enterAgentReview: could not release submitter claim on '${issue.id}'`);
  }
  return { entered: !existing || existing.status !== 'pending', state: next };
}

export async function resubmitAgentReview(
  input: { id: string; submittedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ resubmitted: boolean; state?: AgentReviewState; reason?: string }> {
  const issue = await deps.getIssue(input.id);
  if (!issue) return { resubmitted: false, reason: 'not-found' };
  const current = readAgentReviewState(issue.payload);
  if (!current) return { resubmitted: false, reason: 'not-agent-review' };
  if (current.submittedBy !== input.submittedBy) return { resubmitted: false, state: current, reason: 'not-submitter' };
  if (current.status !== 'revision-requested') {
    return { resubmitted: false, state: current, reason: `not-revision-requested:${current.status}` };
  }
  const next: AgentReviewState = { ...current, status: 'pending', round: current.round + 1 };
  const merged = await deps.mergeIssuePayload(issue.id, { agentReview: next }, { unset: ['needsHuman'] });
  if (!merged) throw new Error(`resubmitAgentReview: work item '${issue.id}' disappeared`);
  if (issue.assignee) {
    const released = await deps.releaseIssue(issue.id, { expectedAssignee: input.submittedBy });
    if (!released) throw new Error(`resubmitAgentReview: '${issue.id}' is held by another agent`);
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
  const issue = await deps.getIssue(ledger.workItemId);
  const state = issue ? readAgentReviewState(issue.payload) : null;
  if (!state || state.ledgerIdeaId !== input.ideaId) return { applicable: false };
  if (state.status !== 'pending') {
    return { applicable: true, workItemId: issue!.id, state, refusal: 'agent-review-not-pending' };
  }
  if (input.grade <= AGENT_REVIEW_MAX_REVISION_GRADE && !input.feedback?.trim()) {
    return { applicable: true, workItemId: issue!.id, state, refusal: 'agent-review-feedback-required' };
  }
  return { applicable: true, workItemId: issue!.id, state };
}

function revisionComment(round: number, grade: number, feedback: string, gradedBy: string): string {
  return `Agent review round ${round}: revision requested by ${gradedBy} (grade ${grade}/5).\n\n${feedback}`;
}

function approvalComment(round: number, grade: number, gradedBy: string): string {
  return `Agent review round ${round}: approved by ${gradedBy} (grade ${grade}/5). Implementation is re-admitted; this approval does not close the work item.`;
}

async function ensureComment(
  issue: EngineerIssue,
  body: string,
  author: string,
  deps: AgentReviewDeps,
): Promise<boolean> {
  const detail = await deps.getIssueDetail(issue.id);
  if (detail?.posts.some((post) => post.body === body)) return false;
  const written = await deps.commentIssue(issue.id, body, author);
  if (!written) throw new Error(`agent review could not persist round history on '${issue.id}'`);
  return true;
}

export interface AgentReviewReconcileOutcome {
  workItemId: string;
  status: 'revision-requested' | 'approved';
  round: number;
  changed: boolean;
  woken?: number;
}

export async function reconcileAgentReviewGrade(
  input: { ideaId: string; gradedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewReconcileOutcome | null> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return null;
  const issue = await deps.getIssue(ledger.workItemId);
  if (!issue) return null;
  const current = readAgentReviewState(issue.payload);
  if (!current || current.ledgerIdeaId !== input.ideaId) return null;
  if (ledger.grade == null) throw new Error(`agent review ledger '${input.ideaId}' has no standing grade`);

  const grade = ledger.grade;
  const gradedBy = ledger.gradedBy ?? input.gradedBy;
  if (grade <= AGENT_REVIEW_MAX_REVISION_GRADE) {
    const feedback = ledger.feedback?.trim();
    if (!feedback) throw new Error('agent-review-feedback-required');
    const next: AgentReviewState = { ...current, status: 'revision-requested' };
    const changed = current.status !== next.status;
    const merged = await deps.mergeIssuePayload(issue.id, { agentReview: next }, { unset: ['needsHuman'] });
    if (!merged) throw new Error(`agent review could not persist revision state on '${issue.id}'`);
    const commentAdded = await ensureComment(issue, revisionComment(current.round, grade, feedback, gradedBy), gradedBy, deps);
    if (changed) {
      const transferred = await deps.claimIssue(issue.id, current.submittedBy, {
        ...(issue.assignee ? { fromHolder: gradedBy } : {}),
      });
      if (!transferred) throw new Error(`agent review could not return '${issue.id}' to ${current.submittedBy}`);
    }
    let woken: number | undefined;
    if (changed || commentAdded) {
      woken = (await deps.deliverRevision({
        to: current.submittedBy,
        workItemId: issue.id,
        round: current.round,
        grade,
        feedback,
        gradedBy,
      })).woken;
    }
    return { workItemId: issue.id, status: 'revision-requested', round: current.round, changed, ...(woken === undefined ? {} : { woken }) };
  }

  const next: AgentReviewState = { ...current, status: 'approved' };
  const changed = current.status !== next.status;
  const merged = await deps.mergeIssuePayload(issue.id, { agentReview: next }, { unset: ['needsHuman'] });
  if (!merged) throw new Error(`agent review could not persist approval state on '${issue.id}'`);
  await ensureComment(issue, approvalComment(current.round, grade, gradedBy), gradedBy, deps);
  if (issue.assignee) {
    const released = await deps.releaseIssue(issue.id, { expectedAssignee: gradedBy });
    if (!released) throw new Error(`agent review could not release reviewer claim on '${issue.id}'`);
  }
  return { workItemId: issue.id, status: 'approved', round: current.round, changed };
}

/** Reviewer pickup over the existing issue-family queue; direct claims still use claimIssue's CAS. */
export async function claimNextAgentReview(
  input: { reviewer: string; harnessSlug?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const ws = issuesScopeWorkspace();
  const rows = await sql<{ issue_id: string }[]>`
    SELECT issue_id
      FROM harness_shared.engineer_issues wi
     WHERE workspace_id = ${ws}
       AND state = 'open'
       AND kind = 'change'
       AND (assignee IS NULL OR btrim(assignee) = '')
       AND ${depsBlockedExclusionSql(sql)}
       AND ${agentReviewPendingSelectorSql(sql)}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${input.reviewer}
       AND ${input.harnessSlug ? sql`scope = ${`harness:${input.harnessSlug}`}` : sql`TRUE`}
     ORDER BY feature_order ASC NULLS LAST, created_at ASC
     LIMIT 25`;
  for (const row of rows) {
    const issue = await getIssueInWorkspace(ws, row.issue_id);
    if (!issue || !agentReviewEligibility(issue).eligible) continue;
    const claimed = await deps.claimIssue(issue.id, input.reviewer, { workspaceId: ws });
    if (claimed) return claimed;
  }
  return null;
}
