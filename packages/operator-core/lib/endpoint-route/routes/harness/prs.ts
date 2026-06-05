/**
 * PRs tab routes (Phase 7 P-043).
 *
 *   GET  /api/harness/:slug/prs
 *        → PrsResponse: { prs: PrRowData[], pollingFailedAt? }
 *
 *   POST /api/harness/:slug/prs/:number/review
 *        body: { action: 'approve' | 'approve_and_merge' }
 *        → { ok: true } or { error: string }
 *
 * Auth: 'public' — loopback gate is the trust boundary (same as
 * sibling harness routes).
 *
 * Data source: live GitHub via PrHost (P-040). check_conclusion
 * is supplemented from pr_check_status_cache when the row exists.
 * In Phase 5a this moves to harness_feature_prs HYPERBEE; the
 * response shape is identical so the UI doesn't change.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveProject } from '../../../harness-core';
import { createGitHubPrHost } from '../../../pr-host/github';
import {
  resolveMergedPrFeatureId,
  stampCompletionRefOnMerge,
} from '../../../harness/completion-ref-writer';

const execFileP = promisify(execFile);

/**
 * #5: harness projects frequently carry no `remote` in their metadata, so the
 * PR pane silently returned an empty list. Derive a `github.com/<owner>/<repo>`
 * remote (the format parseRemote expects) from the checkout's git origin so the
 * pane works for ANY harness whose project is a GitHub clone. Best-effort:
 * returns null when the path isn't a git repo or origin isn't a github remote.
 */
async function gitOriginRemote(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', projectPath, 'config', '--get', 'remote.origin.url'],
      { timeout: 3000 },
    );
    const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(stdout.trim());
    return m ? `github.com/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}
import {
  tryAutoApprove,
  type AutoApproveContext,
} from '../../../pr-host/auto-approve';
import { tryAutoMerge, type AutoMergeContext } from '../../../pr-host/auto-merge';
import { getOrgPg } from '@papercusp/db-org';
import type { PrRowData } from '../../../pr-host/pr-row-data';

/** Flat runtime shape that github.ts actually returns (predates types.ts restructure). */
interface FlatPr {
  remote: string;
  number: number;
  title: string;
  body: string;
  state: string;
  head_sha: string;
  base_branch: string;
  head_branch: string;
  author_github_id: number;
  author_login: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  review_decision: string;
  check_conclusion: string | null;
}

// ─── GET /harness/:slug/prs ───────────────────────────────────────

const listPrs = defineTool({
  method: 'GET',
  path: '/harness/:slug/prs',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const host = await createGitHubPrHost();
    if (!host) {
      return Response.json({ prs: [], pollingFailedAt: new Date().toISOString() });
    }

    // Read remote from project metadata; fall back to the checkout's git origin
    // (#5) so a harness with no `remote` field still lists PRs.
    let remote = (project as unknown as { remote?: string }).remote ?? '';
    if (!remote) {
      const projectPath = (project as unknown as { path?: string }).path ?? '';
      if (projectPath) remote = (await gitOriginRemote(projectPath)) ?? '';
    }
    if (!remote) {
      // Explicit signal so the UI shows an actionable message rather than a
      // silent empty "no PRs" pane (which read as "broken").
      return Response.json({ prs: [], noRemote: true });
    }

    const result = await host.listOpenPrs({ remote });
    if (!result.ok) {
      return Response.json({
        prs: [],
        pollingFailedAt: new Date().toISOString(),
      });
    }

    // Supplement check_conclusion from pr_check_status_cache.
    let checkCache: Map<string, string> = new Map();
    try {
      const { sql } = getOrgPg();
      const rows = await sql.unsafe<{ head_sha: string; conclusion: string }[]>(
        `SELECT head_sha, conclusion
         FROM harness_shared.pr_check_status_cache
         WHERE workspace_id = $1 AND harness_slug = $2
           AND check_name != '__pr_open__'
         ORDER BY fetched_at DESC`,
        ['', slug],
      );
      for (const row of rows) {
        if (!checkCache.has(row.head_sha)) {
          checkCache.set(row.head_sha, row.conclusion);
        }
      }
    } catch {
      // Cache miss is fine — UI renders without check detail.
    }

    const prs: PrRowData[] = (result.data as unknown as FlatPr[]).map((pr) => ({
      remote: pr.remote,
      number: pr.number,
      title: pr.title,
      author_login: pr.author_login,
      author_github_id: pr.author_github_id,
      html_url: pr.html_url,
      state: pr.state as PrRowData['state'],
      review_decision: pr.review_decision as PrRowData['review_decision'],
      check_conclusion: checkCache.get(pr.head_sha) ?? pr.check_conclusion,
      // trusted + reviewerRoleEnabled are resolved client-side in PrsTab.
      trusted: false,
      reviewerRoleEnabled: false,
    }));

    return Response.json({ prs });
  },
});

// ─── POST /harness/:slug/prs/:number/review ───────────────────────

const reviewPr = defineTool({
  method: 'POST',
  path: '/harness/:slug/prs/:number/review',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const prNumber = parseInt(ctx.params.number as string, 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      return Response.json({ error: 'invalid pr number' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      reviewer_github_id?: number;
      reviewer_login?: string;
      /** Phase 2 D-001: a feature-context review supplies the feature id so the
       *  completion_ref stamp resolves without the (substrate-gated)
       *  harness_feature_prs fallback. */
      feature_id?: string;
    };
    const action = body.action;
    if (action !== 'approve' && action !== 'approve_and_merge') {
      return Response.json(
        { error: 'action must be "approve" or "approve_and_merge"' },
        { status: 400 },
      );
    }

    const host = await createGitHubPrHost();
    if (!host) {
      return Response.json(
        { error: 'GitHub not authenticated — run `gh auth login`' },
        { status: 503 },
      );
    }

    const remote = (project as unknown as { remote?: string }).remote ?? '';
    if (!remote) {
      return Response.json({ error: 'no remote configured for this harness' }, { status: 422 });
    }

    // Fetch the PR to get current state.
    const prResult = await host.getPr({ remote, number: prNumber });
    if (!prResult.ok) {
      return Response.json({ error: prResult.error.message }, { status: 502 });
    }
    const pr = prResult.data;

    const reviewerGithubId = body.reviewer_github_id ?? 0;
    const reviewerLogin = body.reviewer_login ?? 'papercusp';

    const flatPr = pr as unknown as FlatPr;

    const approveCtx: AutoApproveContext = {
      harnessSlug: slug,
      reviewerGithubId,
      reviewerLogin,
      trustedAuthorIds: new Set([flatPr.author_github_id]), // manual action bypasses trust gate
      reviewerRoleEnabled: true,
      autoReview: true,
    };

    const approveResult = await tryAutoApprove(host, pr, approveCtx);
    if (approveResult.action === 'error') {
      return Response.json({ error: approveResult.detail ?? 'approve failed' }, { status: 502 });
    }

    if (action === 'approve_and_merge') {
      // Re-fetch so review_decision reflects the approval we just posted.
      const refreshed = await host.getPr({ remote, number: prNumber });
      const prForMerge = refreshed.ok ? refreshed.data : pr;

      const mergeCtx: AutoMergeContext = {
        harnessSlug: slug,
        reviewerGithubId,
        reviewerLogin,
        autoMerge: true,
        mergeMethod: 'squash',
      };
      const mergeResult = await tryAutoMerge(host, prForMerge, mergeCtx);
      if (mergeResult.action === 'error') {
        return Response.json({ error: mergeResult.detail }, { status: 502 });
      }
      // Phase 2 (D-001): on an ACTUAL merge, stamp completion_ref +
      // status='shipped' so the verifier daemon + the tier-B "shipped ✓" stat
      // activate. Only the 'merged' variant carries a mergeCommitSha — a skipped
      // merge (disabled / checks-failing / not-approved) has nothing to stamp.
      // Best-effort: the merge already succeeded, so a stamp failure must never
      // fail the response.
      if (mergeResult.action === 'merged') {
        try {
          const featureId = await resolveMergedPrFeatureId({
            harnessSlug: slug,
            prUrl: flatPr.html_url,
            bodyFeatureId: body.feature_id,
          });
          await stampCompletionRefOnMerge({
            harnessSlug: slug,
            featureId,
            remote,
            branch: flatPr.base_branch,
            mergeCommitSha: mergeResult.mergeCommitSha,
            prUrl: flatPr.html_url,
            prNumber,
          });
        } catch {
          // best-effort; the merge already succeeded.
        }
      }
    }

    return Response.json({ ok: true });
  },
});

export default [listPrs, reviewPr];
