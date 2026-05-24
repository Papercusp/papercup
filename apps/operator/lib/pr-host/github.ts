/**
 * pr-host/github — GitHub implementation of PrHost (Phase 7 P-040).
 *
 * Uses getOctokit() from lib/identity/octokit-client for auth; the
 * Octokit instance handles token caching + 401-retry automatically.
 *
 * Remote format: "github.com/<owner>/<repo>" (same as completion_ref.remote).
 * parseRemote() extracts owner + repo from that string.
 */

import type { Octokit } from '@octokit/rest';
import { getOctokit } from '../identity/octokit-client';
import {
  type Pr,
  type PrHost,
  type PrHostResult,
  type OpenPrArgs,
  type PostReviewArgs,
  type MergePrArgs,
  type ListOpenPrsArgs,
  type PrState,
  type PrReviewDecision,
  ok,
  err,
  statusToErrorKind,
} from './types';

/** Parse "github.com/owner/repo" → { owner, repo } or null. */
export function parseRemote(remote: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function mapOctokitError(e: unknown): ReturnType<typeof err> {
  if (e && typeof e === 'object') {
    const status: number = (e as { status?: number }).status ?? 0;
    const message: string =
      (e as { message?: string }).message ?? 'GitHub API error';
    const rateLimitReset =
      (e as { response?: { headers?: { 'x-ratelimit-reset'?: string } } }).response?.headers?.[
        'x-ratelimit-reset'
      ];
    const kind = statusToErrorKind(status || 500);
    const retry_after_ms =
      kind === 'rate_limited' && rateLimitReset
        ? Math.max(0, Number(rateLimitReset) * 1000 - Date.now())
        : undefined;
    return err({ kind, message, status: status || undefined, retry_after_ms });
  }
  return err({ kind: 'network_error', message: String(e) });
}

function ghStateToPrState(state: string, merged: boolean): PrState {
  if (merged) return 'merged';
  if (state === 'open') return 'open';
  return 'closed';
}

function ghReviewStateToPrDecision(state: string): PrReviewDecision {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return 'none';
  }
}

export class GitHubPrHost implements PrHost {
  readonly kind = 'github' as const;

  constructor(private readonly oc: Octokit) {}

  async openPr(args: OpenPrArgs): Promise<PrHostResult<Pr>> {
    const parsed = parseRemote(args.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.remote}` });
    }
    try {
      const { data } = await this.oc.pulls.create({
        owner: parsed.owner,
        repo: parsed.repo,
        title: args.title,
        body: args.body,
        head: args.head_branch,
        base: args.base_branch,
        draft: args.draft ?? false,
      });
      return ok({
        remote: args.remote,
        number: data.number,
        title: data.title,
        body: data.body ?? '',
        state: 'open',
        head_sha: data.head.sha,
        base_branch: data.base.ref,
        head_branch: data.head.ref,
        author_github_id: data.user?.id ?? 0,
        author_login: data.user?.login ?? '',
        html_url: data.html_url,
        created_at: data.created_at,
        updated_at: data.updated_at,
        merged_at: null,
        review_decision: 'none',
        check_conclusion: null,
      });
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async getPr(ref: { remote: string; number: number }): Promise<PrHostResult<Pr>> {
    const parsed = parseRemote(ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${ref.remote}` });
    }
    try {
      const { data } = await this.oc.pulls.get({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: ref.number,
      });
      const state = ghStateToPrState(data.state, data.merged ?? false);
      const reviews = await this.oc.pulls.listReviews({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: ref.number,
        per_page: 50,
      });
      const latestDecision = reviews.data.length
        ? ghReviewStateToPrDecision(reviews.data[reviews.data.length - 1].state)
        : 'none';
      return ok({
        remote: ref.remote,
        number: data.number,
        title: data.title,
        body: data.body ?? '',
        state,
        head_sha: data.head.sha,
        base_branch: data.base.ref,
        head_branch: data.head.ref,
        author_github_id: data.user?.id ?? 0,
        author_login: data.user?.login ?? '',
        html_url: data.html_url,
        created_at: data.created_at,
        updated_at: data.updated_at,
        merged_at: (data as { merged_at?: string | null }).merged_at ?? null,
        review_decision: latestDecision,
        check_conclusion: null,
      });
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async postReview(args: PostReviewArgs): Promise<PrHostResult<void>> {
    const parsed = parseRemote(args.ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.ref.remote}` });
    }
    const eventMap: Record<string, string> = {
      approve: 'APPROVE',
      request_changes: 'REQUEST_CHANGES',
      comment: 'COMMENT',
    };
    try {
      await this.oc.pulls.createReview({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: args.ref.number,
        event: eventMap[args.event] as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        body: args.body,
      });
      return ok(undefined);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async merge(args: MergePrArgs): Promise<PrHostResult<{ merge_commit_sha: string }>> {
    const parsed = parseRemote(args.ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.ref.remote}` });
    }
    const mergeMethodMap: Record<string, 'merge' | 'squash' | 'rebase'> = {
      merge: 'merge',
      squash: 'squash',
      rebase: 'rebase',
    };
    try {
      const { data } = await this.oc.pulls.merge({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: args.ref.number,
        merge_method: mergeMethodMap[args.method] ?? 'squash',
        commit_title: args.commit_title,
        commit_message: args.commit_message,
        sha: args.expected_head_sha,
      });
      return ok({ merge_commit_sha: data.sha ?? '' });
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async listOpenPrs(args: ListOpenPrsArgs): Promise<PrHostResult<Pr[]>> {
    const parsed = parseRemote(args.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.remote}` });
    }
    try {
      const { data } = await this.oc.pulls.list({
        owner: parsed.owner,
        repo: parsed.repo,
        state: 'open',
        per_page: args.per_page ?? 100,
      });
      const prs: Pr[] = data.map((d) => ({
        remote: args.remote,
        number: d.number,
        title: d.title,
        body: d.body ?? '',
        state: 'open' as PrState,
        head_sha: d.head.sha,
        base_branch: d.base.ref,
        head_branch: d.head.ref,
        author_github_id: d.user?.id ?? 0,
        author_login: d.user?.login ?? '',
        html_url: d.html_url,
        created_at: d.created_at,
        updated_at: d.updated_at,
        merged_at: null,
        review_decision: 'none',
        check_conclusion: null,
      }));
      return ok(prs);
    } catch (e) {
      return mapOctokitError(e);
    }
  }
}

/** Factory: resolves getOctokit() and wraps in GitHubPrHost. Returns null if not authed. */
export async function createGitHubPrHost(): Promise<GitHubPrHost | null> {
  const oc = await getOctokit();
  if (!oc) return null;
  return new GitHubPrHost(oc);
}
