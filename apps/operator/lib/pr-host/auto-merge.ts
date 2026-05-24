/**
 * pr-host/auto-merge — Auto-merge logic (Phase 7 P-045).
 *
 * Fires after auto-approve when auto_merge is also enabled.
 * Gates on: auto_merge=true AND PR was auto-approved by us AND checks green.
 */

import { ensureAutoReviewAuditTable } from '../ensure-schema-dogfood';
import { getOrgPg } from '../pg';
import type { PrHost, Pr, PrMergeMethod } from './types';

export interface AutoMergeContext {
  harnessSlug: string;
  reviewerGithubId: number;
  reviewerLogin: string;
  /** auto_merge must be true. */
  autoMerge: boolean;
  /** Default squash. */
  mergeMethod: PrMergeMethod;
}

export type AutoMergeResult =
  | { action: 'merged'; mergeCommitSha: string; prNumber: number }
  | { action: 'skipped_disabled'; prNumber: number }
  | { action: 'skipped_checks_failing'; prNumber: number }
  | { action: 'skipped_not_approved'; prNumber: number }
  | { action: 'error'; prNumber: number; detail: string };

/**
 * Attempt to auto-merge a PR.
 *
 * P-045a: gates on autoMerge + approved by us + checks green (check_conclusion='success'|null).
 * P-045b: uses ctx.mergeMethod (default squash).
 * P-045c: records action in auto_review_audit.
 */
export async function tryAutoMerge(
  host: PrHost,
  pr: Pr,
  ctx: AutoMergeContext,
): Promise<AutoMergeResult> {
  if (!ctx.autoMerge) {
    return { action: 'skipped_disabled', prNumber: pr.number };
  }

  // Must have been approved (by us or anyone — in auto-approve+auto-merge
  // flow the PR will already have review_decision='approved').
  if (pr.review_decision !== 'approved') {
    return { action: 'skipped_not_approved', prNumber: pr.number };
  }

  // Checks must be green or absent (null = no check runs configured).
  if (pr.check_conclusion !== null && pr.check_conclusion !== 'success') {
    await writeAudit(ctx.harnessSlug, pr.number, pr.html_url, pr.author_github_id, ctx.reviewerGithubId, 'skipped_checks_failing', `check_conclusion: ${pr.check_conclusion}`);
    return { action: 'skipped_checks_failing', prNumber: pr.number };
  }

  const mergeResult = await host.merge({
    ref: { remote: pr.remote, number: pr.number },
    method: ctx.mergeMethod,
    commit_title: `${pr.title} (#${pr.number})`,
    commit_message: `Auto-merged by Papercusp via @${ctx.reviewerLogin}.`,
    expected_head_sha: pr.head_sha,
  });

  if (!mergeResult.ok) {
    await writeAudit(ctx.harnessSlug, pr.number, pr.html_url, pr.author_github_id, ctx.reviewerGithubId, 'error', mergeResult.error.message);
    return { action: 'error', prNumber: pr.number, detail: mergeResult.error.message };
  }

  await writeAudit(ctx.harnessSlug, pr.number, pr.html_url, pr.author_github_id, ctx.reviewerGithubId, 'auto_merge', null);
  return { action: 'merged', prNumber: pr.number, mergeCommitSha: mergeResult.data.merge_commit_sha };
}

async function writeAudit(
  harnessSlug: string,
  prNumber: number,
  prUrl: string | undefined,
  authorId: number,
  reviewerId: number,
  action: string,
  detail: string | null,
): Promise<void> {
  try {
    await ensureAutoReviewAuditTable();
    const { sql } = getOrgPg();
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, harness_slug, pr_number, pr_url, author_github_id, reviewer_github_id, action, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['', harnessSlug, prNumber, prUrl ?? null, authorId, reviewerId, action, detail],
    );
  } catch {
    // Non-fatal.
  }
}
