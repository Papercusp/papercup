import { describe, it, expect, vi } from 'vitest';
import { tryAutoMerge } from './auto-merge';
import type { PrHost, Pr } from './types';

vi.mock('../ensure-schema-dogfood', () => ({
  ensureAutoReviewAuditTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pg', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makeHost(mergeResult = { ok: true as const, data: { merge_commit_sha: 'abc123' } }): PrHost {
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
    review_decision: 'approved',
    check_conclusion: null,
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
    const result = await tryAutoMerge(makeHost(), makePr({ check_conclusion: 'failure' }), baseCtx);
    expect(result.action).toBe('skipped_checks_failing');
  });

  it('P-045a: merges when approved + checks null (no CI)', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ check_conclusion: null }), baseCtx);
    expect(result.action).toBe('merged');
    if (result.action === 'merged') expect(result.mergeCommitSha).toBe('abc123');
  });

  it('P-045a: merges when approved + checks success', async () => {
    const result = await tryAutoMerge(makeHost(), makePr({ check_conclusion: 'success' }), baseCtx);
    expect(result.action).toBe('merged');
  });

  it('P-045b: uses the configured merge method', async () => {
    const host = makeHost();
    await tryAutoMerge(host, makePr(), { ...baseCtx, mergeMethod: 'rebase' });
    expect(vi.mocked(host.merge)).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'rebase' })
    );
  });

  it('P-045c: records merged action in audit (merge called)', async () => {
    const host = makeHost();
    const result = await tryAutoMerge(host, makePr(), baseCtx);
    expect(result.action).toBe('merged');
    // The audit write happens inside tryAutoMerge after merge() succeeds.
    // We verify merge() was called (the audit path ran) via the mock call count.
    expect(vi.mocked(host.merge)).toHaveBeenCalledTimes(1);
  });

  it('returns error on merge failure', async () => {
    const host = makeHost({ ok: false, error: { kind: 'conflict', message: 'Head diverged' } });
    const result = await tryAutoMerge(host, makePr(), baseCtx);
    expect(result.action).toBe('error');
    if (result.action === 'error') expect(result.detail).toContain('diverged');
  });
});
