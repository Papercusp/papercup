import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPollDaemon, _resetDaemonState } from './poll-daemon';
import type { PrHost, Pr } from './types';

vi.mock('../ensure-schema-dogfood', () => ({
  ensurePrCheckStatusCacheTable: vi.fn().mockResolvedValue(undefined),
  ensureAutoReviewAuditTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makePr(number = 1): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number },
    title: 'PR ' + number,
    body: '',
    state: 'open',
    head_sha: 'sha' + number,
    base_ref: 'main',
    head_ref: 'fix/' + number,
    author: { github_user_id: 1, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'unknown',
    mergeable_state: 'unknown',
    is_draft: false,
    url: 'https://github.com/owner/repo/pull/' + number,
    updated_at: 1716544800000,
    merge_commit_sha: null,
  };
}

function makeHost(impl: Partial<PrHost> = {}): PrHost {
  return {
    kind: 'github',
    openPr: vi.fn().mockResolvedValue({ ok: true, data: makePr() }),
    getPr: vi.fn().mockResolvedValue({ ok: true, data: makePr() }),
    postReview: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    merge: vi.fn().mockResolvedValue({ ok: true, data: { merge_commit_sha: 'abc' } }),
    listOpenPrs: vi.fn().mockResolvedValue({ ok: true, data: [makePr(1)] }),
    ...impl,
  };
}

beforeEach(() => {
  _resetDaemonState();
});

describe('poll-daemon P-042', () => {
  it('P-042a: calls listOpenPrs and fires onUpdate on success', async () => {
    const onUpdate = vi.fn();
    const host = makeHost();
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onUpdate,
    });
    daemon.start();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled());
    daemon.stop();
    expect(onUpdate).toHaveBeenCalledWith('papercup', [makePr(1)]);
  });

  it('P-042c: backs off exponentially on server_error', async () => {
    const onUpdate = vi.fn();
    const host = makeHost({
      listOpenPrs: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { kind: 'server_error', message: '500' } })
        .mockResolvedValue({ ok: true, data: [makePr(1)] }),
    });
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onUpdate,
    });
    daemon.start();
    // First tick → server_error → sets nextAllowedAt in the future. onUpdate not called yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(onUpdate).not.toHaveBeenCalled();
    daemon.stop();
  });

  it('P-042d: honors X-RateLimit-Reset on rate_limit', async () => {
    const onUpdate = vi.fn();
    const resetTs = Math.floor(Date.now() / 1000) + 3600;
    const host = makeHost({
      listOpenPrs: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { kind: 'rate_limit', resetAt: resetTs } })
        .mockResolvedValue({ ok: true, data: [makePr(1)] }),
    });
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onUpdate,
    });
    daemon.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(onUpdate).not.toHaveBeenCalled();
    daemon.stop();
  });

  it('P-042e: calls onAuthFailure on unauthorized error', async () => {
    const onAuthFailure = vi.fn();
    const host = makeHost({
      listOpenPrs: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'unauthorized' },
      }),
    });
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onUpdate: vi.fn(),
      onAuthFailure,
    });
    daemon.start();
    await vi.waitFor(() => expect(onAuthFailure).toHaveBeenCalled());
    daemon.stop();
  });

  it('P-042f: fires onPrGone when a previously-seen PR disappears', async () => {
    const onPrGone = vi.fn();
    const host = makeHost({
      listOpenPrs: vi.fn()
        .mockResolvedValueOnce({ ok: true, data: [makePr(10), makePr(11)] })
        .mockResolvedValue({ ok: true, data: [makePr(11)] }), // PR 10 is gone
    });
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onUpdate: vi.fn(),
      onPrGone,
      _pollIntervalMs: 20,
    });
    daemon.start();
    await vi.waitFor(() => expect(onPrGone).toHaveBeenCalled());
    daemon.stop();
    expect(onPrGone).toHaveBeenCalledWith('papercup', 10);
  });
});
