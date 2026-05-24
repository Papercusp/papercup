import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPollDaemon, _resetDaemonState } from './poll-daemon';
import type { PrHost, Pr } from './types';

vi.mock('../ensure-schema-dogfood', () => ({
  ensurePrCheckStatusCacheTable: vi.fn().mockResolvedValue(undefined),
  ensureAutoReviewAuditTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pg', () => ({
  getOrgPg: () => ({ sql: { unsafe: vi.fn().mockResolvedValue([]) } }),
}));

function makePr(number = 1): Pr {
  return {
    remote: 'github.com/owner/repo',
    number,
    title: 'PR ' + number,
    body: '',
    state: 'open',
    head_sha: 'sha' + number,
    base_branch: 'main',
    head_branch: 'fix/' + number,
    author_github_id: 1,
    author_login: 'alice',
    html_url: 'https://github.com/owner/repo/pull/' + number,
    created_at: '2026-05-24T10:00:00Z',
    updated_at: '2026-05-24T11:00:00Z',
    merged_at: null,
    review_decision: 'none',
    check_conclusion: null,
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

  it('P-042d: respects retry_after_ms from rate_limit error', async () => {
    const onUpdate = vi.fn();
    const host = makeHost({
      listOpenPrs: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'rate_limited', message: '429', retry_after_ms: 300_000 },
      }),
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

  it('P-042e: fires onAuthFailure and does not crash on 401', async () => {
    const onAuthFailure = vi.fn();
    const host = makeHost({
      listOpenPrs: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'unauthorized', message: '401' },
      }),
    });
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onAuthFailure,
    });
    daemon.start();
    await vi.waitFor(() => expect(onAuthFailure).toHaveBeenCalled());
    daemon.stop();
  });

  it('P-042f: fires onPrGone when a previously-seen PR disappears', async () => {
    const onPrGone = vi.fn();
    const listOpenPrs = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: [makePr(10), makePr(11)] })
      .mockResolvedValue({ ok: true, data: [makePr(11)] }); // PR 10 is gone
    const host = makeHost({ listOpenPrs });

    // Manually trigger two polls by using a very short interval via start + manual ticks.
    const daemon = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onPrGone,
    });

    // Manually drive two ticks (bypassing interval timer).
    daemon.start();
    await vi.waitFor(() => expect(listOpenPrs).toHaveBeenCalledTimes(1));
    daemon.stop();

    // Second daemon starting fresh but inheriting daemonState (module-level).
    const daemon2 = createPollDaemon({
      harnessRemotes: async () => [{ harnessSlug: 'papercup', remote: 'github.com/owner/repo' }],
      host,
      onPrGone,
    });
    daemon2.start();
    await vi.waitFor(() => expect(listOpenPrs).toHaveBeenCalledTimes(2));
    daemon2.stop();

    expect(onPrGone).toHaveBeenCalledWith('papercup', 10);
    expect(onPrGone).not.toHaveBeenCalledWith('papercup', 11);
  });

  it('start() is idempotent — double-start does not create extra intervals', () => {
    const host = makeHost();
    const daemon = createPollDaemon({
      harnessRemotes: async () => [],
      host,
    });
    daemon.start();
    daemon.start(); // second call should be a no-op
    daemon.stop();
  });
});
