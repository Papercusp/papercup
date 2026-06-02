import { describe, it, expect, vi } from 'vitest';
import { tryAutoMerge } from './auto-merge';
import type { PrHost, Pr } from './types';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makeHost(
  mergeResult:
    | { ok: true; data: { merge_commit_sha: string } }
    | { ok: false; error: { kind: string; message: string } } = {
    ok: true,
    data: { merge_commit_sha: 'abc123' },
  },
): PrHost {
  return {
    kind: 'github',
    openPr: vi.fn(),
    getPr: vi.fn(),
    postReview: vi.fn(),
    merge: vi.fn().mockResolvedValue(mergeResult),
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
    review_decision: 'approved',
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
  autoMerge: true,
  mergeMethod: 'squash' as const,
};

describe('tryAutoMerge P-045', () => {
  it('P-045a: skips when autoMerge=false', async () => {
    const result = await tryAutoMerge(makeHost(), makePr(), { ...baseCtx, autoMerge: false });
    expect(result.action).toBe('skipped_disabled');
  });

  it('P-045a: skips when PR not approved', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ review_decision: 'none' }), baseCtx);
    expect(result.action).toBe('skipped_not_approved');
  });

  it('P-045a: skips when checks are failing', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ checks_state: 'failure' }), baseCtx);
    expect(result.action).toBe('skipped_checks_failing');
  });

  it('P-045a: skips when checks are pending', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ checks_state: 'pending' }), baseCtx);
    expect(result.action).toBe('skipped_checks_failing');
  });

  it('P-045a: merges when approved + checks unknown (no CI configured)', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ checks_state: 'unknown' }), baseCtx);
    expect(result.action).toBe('merged');
    if (result.action === 'merged') expect(result.mergeCommitSha).toBe('abc123');
  });

  it('P-045a: merges when approved + checks success', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ checks_state: 'success' }), baseCtx);
    expect(result.action).toBe('merged');
  });

  it('P-045b: uses the configured merge method', async () => {
    const host = makeHost();
    await tryAutoMerge(host, makePr(), { ...baseCtx, mergeMethod: 'rebase' });
    expect(vi.mocked(host.merge)).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'rebase' }),
    );
  });

  it('P-045c: records merged action in audit (merge called)', async () => {
    const host = makeHost();
    const result = await tryAutoMerge(host, makePr(), baseCtx);
    expect(result.action).toBe('merged');
    expect(vi.mocked(host.merge)).toHaveBeenCalledTimes(1);
  });

  it('returns error on merge failure', async () => {
    const host = makeHost({ ok: false, error: { kind: 'conflict', message: 'Head diverged' } });
    const result = await tryAutoMerge(host, makePr(), baseCtx);
    expect(result.action).toBe('error');
    if (result.action === 'error') expect(result.detail).toContain('diverged');
  });
});
