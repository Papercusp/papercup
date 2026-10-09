/**
 * pot-review-integration-mode P-020: publishPromotion — where green-checkpoint
 * publishes a promoted commit, and the standing-PR refresh that follows it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import type { PotIntegrationModeRead } from './pot-integration-mode';
import { githubOwnerOf, publishPromotion, type PublishPromotionDeps } from './promotion-push-target';
import type { StandingPrDeps } from './standing-pr';

const REPO = '/pots/acme';
const FORK = 'https://github.com/acme-bot/widgets.git';
const UPSTREAM = 'github.com/acme/widgets';
const SHA = 'a'.repeat(40);

function entry(over: Partial<Record<string, unknown>> = {}): ProjectEntry {
  return {
    slug: 'acme',
    path: REPO,
    self_repo: true,
    fork_remote: FORK,
    github_remote: UPSTREAM,
    ...over,
  } as unknown as ProjectEntry;
}

const PR_DEPS: StandingPrDeps = {
  listOpenPrs: vi.fn(),
  openPr: vi.fn(),
  pushHead: vi.fn(),
};

function deps(opts: {
  projects?: ProjectEntry[];
  mode?: PotIntegrationModeRead;
  pushError?: Error;
  prDeps?: StandingPrDeps | null;
} = {}) {
  const log = vi.fn();
  const pushToFork = vi.fn(async () => {
    if (opts.pushError) throw opts.pushError;
  });
  const ensureRemote = vi.fn(async () => 'unchanged');
  const publishStandingPr = vi.fn(async (_input: Record<string, unknown>, _prDeps: StandingPrDeps) => ({
    ok: true as const,
    decision: { action: 'open' as const, headSha: SHA, reason: 'opened' },
    prNumber: 7,
    prUrl: 'https://github.com/acme/widgets/pull/7',
  }));
  const d: PublishPromotionDeps = {
    loadProjects: async () => opts.projects ?? [entry()],
    readMode: async () => opts.mode ?? { mode: 'review', source: 'set' },
    canonical: (p) => p,
    ensureRemote,
    pushToFork,
    createStandingPrDeps: async () => (opts.prDeps === undefined ? PR_DEPS : opts.prDeps),
    publishStandingPr: publishStandingPr as unknown as PublishPromotionDeps['publishStandingPr'],
    log,
  };
  return { d, log, pushToFork, ensureRemote, publishStandingPr };
}

const INPUT = { repoPath: REPO, workspaceId: 'ws-1', sha: SHA, ref: 'main' };

describe('publishPromotion', () => {
  it('direct mode returns origin and touches no fork', async () => {
    const { d, pushToFork, publishStandingPr } = deps({ mode: { mode: 'direct', source: 'set' } });
    await expect(publishPromotion(INPUT, d)).resolves.toEqual({ kind: 'origin' });
    expect(pushToFork).not.toHaveBeenCalled();
    expect(publishStandingPr).not.toHaveBeenCalled();
  });

  it('an unowned checkout returns origin', async () => {
    const { d } = deps({ projects: [entry({ path: '/elsewhere' })] });
    await expect(publishPromotion(INPUT, d)).resolves.toEqual({ kind: 'origin' });
  });

  it('review mode pushes the tested sha to the fork main, then refreshes the standing PR', async () => {
    const { d, pushToFork, ensureRemote, publishStandingPr } = deps();
    const out = await publishPromotion(INPUT, d);
    expect(ensureRemote).toHaveBeenCalledWith(REPO, FORK);
    expect(pushToFork).toHaveBeenCalledWith(REPO, SHA, 'refs/heads/main');
    expect(publishStandingPr).toHaveBeenCalledTimes(1);
    expect(publishStandingPr.mock.calls[0]?.[0]).toMatchObject({
      forkRemote: FORK,
      forkOwner: 'acme-bot',
      upstreamRemote: UPSTREAM,
      upstreamOwner: 'acme',
      baseBranch: 'main',
      promotedSha: SHA,
      trigger: 'promotion',
    });
    expect(out).toMatchObject({ kind: 'fork', remoteRef: 'refs/heads/main', standingPr: { ok: true } });
  });

  it('review mode never falls back to origin when the fork push fails — it throws', async () => {
    const { d, publishStandingPr } = deps({ pushError: new Error('rejected') });
    await expect(publishPromotion(INPUT, d)).rejects.toThrow('rejected');
    expect(publishStandingPr).not.toHaveBeenCalled();
  });

  it('links source fixes only after a successful standing PR refresh, and retries bookkeeping without republishing a new PR', async () => {
    const { d, log, publishStandingPr } = deps();
    const record = vi.fn().mockRejectedValueOnce(new Error('tracker bookkeeping unavailable'))
      .mockResolvedValue({ linked: ['WI-fixed'], failed: [] });
    d.recordStandingPr = record;
    expect(await publishPromotion(INPUT, d)).toMatchObject({ kind: 'fork', standingPr: { ok: true } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('source linkage pending'));
    expect(await publishPromotion(INPUT, d)).toMatchObject({ kind: 'fork', standingPr: { ok: true } });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      sha: SHA, potHomeSlug: 'acme', prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7',
    }));
    publishStandingPr.mockRejectedValueOnce(new Error('host unavailable'));
    await publishPromotion(INPUT, d);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('an unreadable mode holds promotion (throws) instead of publishing', async () => {
    const { d, pushToFork } = deps({ mode: { mode: 'direct', source: 'error' } });
    await expect(publishPromotion(INPUT, d)).rejects.toThrow(/promotion held/);
    expect(pushToFork).not.toHaveBeenCalled();
  });

  it('review mode without a fork skips publication entirely', async () => {
    const { d, pushToFork } = deps({ projects: [entry({ fork_remote: undefined })] });
    const out = await publishPromotion(INPUT, d);
    expect(out.kind).toBe('skipped');
    expect(pushToFork).not.toHaveBeenCalled();
  });

  it('a missing PR host does not fail the promotion', async () => {
    const { d, pushToFork } = deps({ prDeps: null });
    const out = await publishPromotion(INPUT, d);
    expect(pushToFork).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: 'fork', standingPr: { ok: false, stage: 'setup' } });
  });

  it('a throwing standing-PR refresh is contained', async () => {
    const { d, publishStandingPr } = deps();
    publishStandingPr.mockRejectedValueOnce(new Error('api down'));
    const out = await publishPromotion(INPUT, d);
    expect(out).toMatchObject({ kind: 'fork', standingPr: { ok: false, error: 'api down' } });
  });
});

describe('githubOwnerOf', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme'],
    ['git@github.com:acme/widgets.git', 'acme'],
    ['github.com/acme/widgets', 'acme'],
    ['https://gitlab.com/acme/widgets', null],
  ])('%s -> %s', (remote, owner) => {
    expect(githubOwnerOf(remote)).toBe(owner);
  });
});
