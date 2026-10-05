/**
 * pot-review-integration-mode P-020 (D-006/D-007): end-to-end with REAL git.
 *
 * A working-copy (review-mode) pot's green-gate promotion must land on the
 * pot's own fork and reach the main repository only as the standing PR. The
 * unit tests (promotion-publish.test.ts) stub every git seam; this test runs
 * the real ones — `ensurePotForkGitRemote` and the default `pushToFork` — against
 * two bare repositories standing in for GitHub:
 *
 *   upstream.git — the main repository (the checkout's `origin`)
 *   fork.git     — the pot's working copy (reached through `pot-fork`)
 *
 * The registry stores GitHub URLs; a per-checkout `url.<path>.insteadOf` rule
 * maps them onto the bare repositories, so the code under test sees exactly the
 * URLs it would see in production while git writes to local disk.
 *
 * Only the registry read, the mode read and the PR host's HTTP calls are faked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import type { OpenPrArgs, Pr } from '../../pr-host/types';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import { POT_FORK_REMOTE_NAME, type PotIntegrationModeRead } from './pot-integration-mode';
import {
  createDefaultPublishPromotionDeps,
  createDefaultSendStandingPrNowDeps,
  publishPromotion,
  sendStandingPrNow,
  type PublishPromotionDeps,
  type SendStandingPrNowDeps,
} from './promotion-push-target';
import type { StandingPrDeps } from './standing-pr';

const FORK_URL = 'https://github.com/acme-bot/widgets.git';
const UPSTREAM_URL = 'https://github.com/acme/widgets.git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      // Keep the operator's own hooks (e.g. the pre-push main guard) out of the fixture.
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

/** The sha a bare repository's branch points at, or null when the branch does not exist. */
function branchSha(bare: string, branch: string): string | null {
  try {
    return git(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** Whether a repository holds an object at all (on any ref or none). */
function hasObject(repo: string, sha: string): boolean {
  try {
    git(repo, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  root: string;
  upstream: string;
  fork: string;
  checkout: string;
  baseSha: string;
  promotedSha: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'working-copy-standing-pr-'));
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork.git');
  const checkout = join(root, 'checkout');

  git(root, 'init', '--bare', '--initial-branch=main', upstream);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(join(seed, 'README.md'), 'widgets\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', upstream, 'main:refs/heads/main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');

  // The working copy starts as a fork of the main repository.
  git(root, 'clone', '--bare', upstream, fork);

  // The pot's integration checkout: origin = the main repository.
  git(root, 'clone', upstream, checkout);
  git(checkout, 'config', `url.${fork}.insteadOf`, FORK_URL);
  git(checkout, 'config', `url.${upstream}.insteadOf`, UPSTREAM_URL);
  writeFileSync(join(checkout, 'feature.txt'), 'tested work\n');
  git(checkout, 'add', 'feature.txt');
  git(checkout, 'commit', '-m', 'tested candidate');
  const promotedSha = git(checkout, 'rev-parse', 'HEAD');

  return { root, upstream, fork, checkout, baseSha, promotedSha };
}

function registryEntry(fx: Fixture, over: Partial<Record<string, unknown>> = {}): ProjectEntry {
  return {
    slug: 'widgets',
    path: fx.checkout,
    self_repo: true,
    fork_remote: FORK_URL,
    github_remote: UPSTREAM_URL,
    ...over,
  } as unknown as ProjectEntry;
}

/** A PR host that records calls; its pushHead is a real non-force push through `pot-fork`. */
function fakePrHost(checkout: string, openPrs: Pr[] = []) {
  const opened: OpenPrArgs[] = [];
  const listed: string[] = [];
  const deps: StandingPrDeps = {
    listOpenPrs: async ({ remote }) => {
      listed.push(remote);
      return { ok: true, data: openPrs };
    },
    openPr: async (args) => {
      opened.push(args);
      return {
        ok: true,
        data: {
          ref: { remote: args.remote, number: 42 },
          state: 'open',
          title: args.title,
          body: args.body,
          head_ref: args.head_ref,
          base_ref: args.base_ref,
          head_sha: '',
          url: 'https://github.com/acme/widgets/pull/42',
        } as unknown as Pr,
      };
    },
    pushHead: async ({ sha, branch }) => {
      git(checkout, 'push', POT_FORK_REMOTE_NAME, `${sha}:refs/heads/${branch}`);
    },
  };
  return { deps, opened, listed };
}

async function realDeps(
  fx: Fixture,
  opts: { mode: PotIntegrationModeRead | Error; entry?: ProjectEntry; prHost?: StandingPrDeps | null },
): Promise<{ deps: PublishPromotionDeps; logs: string[] }> {
  const logs: string[] = [];
  const base = await createDefaultPublishPromotionDeps((line) => logs.push(line));
  const deps: PublishPromotionDeps = {
    ...base,
    // Faked: the registry and the federated settings read (both need Postgres).
    loadProjects: async () => [opts.entry ?? registryEntry(fx)],
    readMode: async () => {
      if (opts.mode instanceof Error) throw opts.mode;
      return opts.mode;
    },
    // Faked: GitHub's HTTP API. The branch push inside it is still real git.
    createStandingPrDeps: async () => (opts.prHost === undefined ? fakePrHost(fx.checkout).deps : opts.prHost),
  };
  return { deps, logs };
}

/** realDeps plus the real `git ls-remote pot-fork <ref>` reader the on-demand send uses. */
async function realSendDeps(
  fx: Fixture,
  opts: { mode: PotIntegrationModeRead | Error; prHost?: StandingPrDeps | null },
): Promise<SendStandingPrNowDeps> {
  const { deps } = await realDeps(fx, opts);
  const { readForkHead } = await createDefaultSendStandingPrNowDeps(() => {});
  return { ...deps, readForkHead };
}

describe('on-demand "send what is green now" with real git (P-020)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('sends the working copy main that already passed the gate, and pushes no code of its own', async () => {
    const first = fakePrHost(fx.checkout);
    const publish = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: first.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      publish.deps,
    );
    // A local commit that never passed the gate must NOT ride along on an on-demand send.
    writeFileSync(join(fx.checkout, 'feature.txt'), 'untested\n');
    git(fx.checkout, 'commit', '-am', 'untested local work');
    const untestedSha = git(fx.checkout, 'rev-parse', 'HEAD');

    const existing = {
      ref: { remote: UPSTREAM_URL, number: 42 },
      state: 'open',
      title: 'standing',
      body: null,
      head_ref: STANDING_PR_BRANCH,
      base_ref: 'main',
      head_sha: fx.promotedSha,
      url: 'https://github.com/acme/widgets/pull/42',
    } as unknown as Pr;
    const host = fakePrHost(fx.checkout, [existing]);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome).toMatchObject({ kind: 'sent', potHomeSlug: 'widgets', sha: fx.promotedSha });
    if (outcome.kind === 'sent') expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
    expect(host.opened).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(fx.promotedSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.promotedSha);
    expect(hasObject(fx.fork, untestedSha)).toBe(false);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
  });

  it('a working copy with no main yet: nothing has passed the gate, so nothing is sent', async () => {
    git(fx.fork, 'symbolic-ref', 'HEAD', 'refs/heads/standby');
    git(fx.fork, 'update-ref', '-d', 'refs/heads/main');
    const host = fakePrHost(fx.checkout);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome.kind).toBe('nothing-green');
    expect(host.listed).toHaveLength(0);
    expect(host.opened).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
  });

  it('direct mode: there is no standing PR to send', async () => {
    const host = fakePrHost(fx.checkout);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'direct', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome.kind).toBe('not-review');
    expect(host.listed).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
  });
});

describe('working-copy promotion with real git (P-020)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('review mode: the promoted commit lands on the fork, never on the main repository, and opens the standing PR', async () => {
    const host = fakePrHost(fx.checkout);
    const { deps, logs } = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome.kind).toBe('fork');
    if (outcome.kind !== 'fork') return;
    expect(outcome.remoteRef).toBe('refs/heads/main');
    expect(outcome.potHomeSlug).toBe('widgets');

    // The working copy's main carries the tested commit…
    expect(branchSha(fx.fork, 'main')).toBe(fx.promotedSha);
    // …and the main repository never received it.
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(hasObject(fx.upstream, fx.promotedSha)).toBe(false);
    expect(hasObject(fx.fork, fx.promotedSha)).toBe(true);

    // The checkout's pot-fork remote stores the registry URL (insteadOf maps it at transport time).
    expect(git(fx.checkout, 'config', '--get', `remote.${POT_FORK_REMOTE_NAME}.url`)).toBe(FORK_URL);

    // The standing PR: the fork's standing branch at the tested commit, opened against upstream main.
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(fx.promotedSha);
    expect(host.listed).toEqual([UPSTREAM_URL]);
    expect(host.opened).toHaveLength(1);
    expect(host.opened[0]).toMatchObject({
      remote: UPSTREAM_URL,
      head_ref: STANDING_PR_BRANCH,
      head_owner: 'acme-bot',
      base_ref: 'main',
    });
    expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
    expect(logs.some((l) => l.includes('the main repository receives it only through the standing PR'))).toBe(true);
  });

  it('review mode: a second promotion moves the existing standing PR instead of opening another', async () => {
    const first = fakePrHost(fx.checkout);
    const firstRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: first.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      firstRun.deps,
    );

    writeFileSync(join(fx.checkout, 'feature.txt'), 'more tested work\n');
    git(fx.checkout, 'commit', '-am', 'second tested candidate');
    const nextSha = git(fx.checkout, 'rev-parse', 'HEAD');

    const existing = {
      ref: { remote: UPSTREAM_URL, number: 42 },
      state: 'open',
      title: 'standing',
      body: null,
      head_ref: STANDING_PR_BRANCH,
      base_ref: 'main',
      head_sha: fx.promotedSha,
      url: 'https://github.com/acme/widgets/pull/42',
    } as unknown as Pr;
    const second = fakePrHost(fx.checkout, [existing]);
    const secondRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: second.deps });
    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: nextSha, ref: 'main' },
      secondRun.deps,
    );

    expect(outcome.kind).toBe('fork');
    expect(branchSha(fx.fork, 'main')).toBe(nextSha);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(nextSha);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(second.opened).toHaveLength(0);
    if (outcome.kind === 'fork') expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
  });

  it('direct mode: publishes nothing itself and hands the push back to the caller (origin)', async () => {
    const host = fakePrHost(fx.checkout);
    const { deps } = await realDeps(fx, { mode: { mode: 'direct', source: 'absent' }, prHost: host.deps });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome).toEqual({ kind: 'origin' });
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
    expect(host.opened).toHaveLength(0);
  });

  it('review mode without a fork: published nowhere — never falls back to the main repository', async () => {
    const { deps } = await realDeps(fx, {
      mode: { mode: 'review', source: 'set' },
      entry: registryEntry(fx, { fork_remote: undefined }),
    });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome.kind).toBe('skipped');
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
  });

  it('an unreadable mode holds promotion: it throws and pushes nothing anywhere', async () => {
    const { deps } = await realDeps(fx, { mode: { mode: 'direct', source: 'error' } });

    await expect(
      publishPromotion({ repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' }, deps),
    ).rejects.toThrow(/promotion held/);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
  });

  it('a rejected fork push throws, so local main is never advanced past an unpublished commit', async () => {
    // Diverge the fork's main so a non-fast-forward push is rejected.
    const other = join(fx.root, 'other');
    git(fx.root, 'clone', fx.fork, other);
    writeFileSync(join(other, 'conflict.txt'), 'someone else\n');
    git(other, 'add', 'conflict.txt');
    git(other, 'commit', '-m', 'diverging commit on the working copy');
    git(other, 'push', 'origin', 'main');
    const divergedSha = git(other, 'rev-parse', 'HEAD');

    const { deps } = await realDeps(fx, { mode: { mode: 'review', source: 'set' } });
    await expect(
      publishPromotion({ repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' }, deps),
    ).rejects.toThrow(/push to the working copy failed/);
    expect(branchSha(fx.fork, 'main')).toBe(divergedSha);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
  });
});
