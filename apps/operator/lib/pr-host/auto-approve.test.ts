import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryAutoApprove, formatAutoApproveToast } from './auto-approve';
import type { PrHost, Pr } from './types';

vi.mock('../ensure-schema-dogfood', () => ({
  ensureAutoReviewAuditTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pg', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makeHost(postReviewResult = { ok: true as const, data: undefined }): PrHost {
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
    remote: 'github.com/owner/repo',
    number: 42,
    title: 'Fix thing',
    body: '',
    state: 'open',
    head_sha: 'abc',
    base_branch: 'main',
    head_branch: 'fix/thing',
    author_github_id: 999,
    author_login: 'alice',
    html_url: 'https://github.com/owner/repo/pull/42',
    created_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
    merged_at: null,
    review_decision: 'none',
    check_conclusion: null,
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
    const result = await tryAutoApprove(makeHost(), makePr({ author_github_id: 888 }), baseCtx);
    expect(result.action).toBe('skipped_untrusted');
  });

  it('P-044b: skips when PR already approved', async () => {
    const result = await tryAutoApprove(makeHost(), makePr({ review_decision: 'approved' }), baseCtx);
    expect(result.action).toBe('skipped_already_approved');
  });

  it('P-044a+b: approves trusted author with no prior review', async () => {
    const result = await tryAutoApprove(makeHost(), makePr(), baseCtx);
    expect(result.action).toBe('approved');
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
