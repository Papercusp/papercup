import { describe, it, expect, vi } from 'vitest';
import { tryAutoApprove, formatAutoApproveToast } from './auto-approve';
import type { PrHost, Pr } from './types';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makeHost(postReviewResult: { ok: true; data: undefined } | { ok: false; error: { kind: string; message: string } } = { ok: true, data: undefined }): PrHost {
  return {
    kind: 'github',
    openPr: vi.fn(),
    getPr: vi.fn(),
    postReview: vi.fn().mockResolvedValue(postReviewResult),
    merge: vi.fn(),
    listOpenPrs: vi.fn(),
  };
}

function makePr(overrides: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number: 42 },
    state: 'open',
    title: 'Fix thing',
    body: null,
    head_ref: 'fix/thing',
    base_ref: 'main',
    head_sha: 'abc123',
    merge_commit_sha: null,
    author: { github_user_id: 999, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'unknown',
    mergeable_state: 'unknown',
    is_draft: false,
    url: 'https://github.com/owner/repo/pull/42',
    updated_at: 1716508800000,
    ...overrides,
  };
}

const baseCtx = {
  harnessSlug: 'papercup',
  reviewerGithubId: 1,
  reviewerLogin: 'bot',
  trustedAuthorIds: new Set([999]),
  reviewerRoleEnabled: true,
  autoReview: true,
};

describe('tryAutoApprove P-044', () => {
  it('P-044a: skips when reviewerRoleEnabled=false', async () => {
    const result = await tryAutoApprove(makeHost(), makePr(), { ...baseCtx, reviewerRoleEnabled: false });
    expect(result.action).toBe('skipped_disabled');
  });

  it('P-044a: skips when autoReview=false', async () => {
    const result = await tryAutoApprove(makeHost(), makePr(), { ...baseCtx, autoReview: false });
    expect(result.action).toBe('skipped_disabled');
  });

  it('P-044a: skips when author not in trust list', async () => {
    const result = await tryAutoApprove(
      makeHost(),
      makePr({ author: { github_user_id: 888, github_login: 'mallory' } }),
      baseCtx,
    );
    expect(result.action).toBe('skipped_untrusted');
  });

  it('P-044b: skips when PR already approved', async () => {
    const result = await tryAutoApprove(makeHost(), makePr({ review_decision: 'approved' }), baseCtx);
    expect(result.action).toBe('skipped_already_approved');
  });

  it('P-044a+b: approves trusted author with no prior review', async () => {
    const result = await tryAutoApprove(makeHost(), makePr(), baseCtx);
    expect(result.action).toBe('approved');
    expect(result.prNumber).toBe(42);
  });

  it('P-044c: errors are recorded and returned', async () => {
    const host = makeHost({ ok: false, error: { kind: 'validation', message: 'Cannot approve own PR' } });
    const result = await tryAutoApprove(host, makePr(), baseCtx);
    expect(result.action).toBe('error');
    if (result.action === 'error') expect(result.detail).toContain('Cannot approve');
  });
});

describe('formatAutoApproveToast P-044d', () => {
  it('returns null for non-action', () => {
    expect(formatAutoApproveToast({ action: 'skipped_disabled', prNumber: 1 }, 'url')).toBeNull();
  });
  it('returns toast string for approved', () => {
    const toast = formatAutoApproveToast({ action: 'approved', prNumber: 42 }, 'https://github.com/x');
    expect(toast).toMatch(/Auto-approved PR #42/);
  });
  it('returns error string for error action', () => {
    const toast = formatAutoApproveToast({ action: 'error', prNumber: 42, detail: 'Network timeout' }, 'url');
    expect(toast).toMatch(/failed.*42/);
  });
});
