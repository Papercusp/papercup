import { describe, it, expect, vi } from 'vitest';
import {
  evaluateForkForGc,
  gcForksForUpstreams,
  DEFAULT_FORK_RETENTION_MS,
} from './fork-gc';

// getOctokit is never called (every test injects opts.octokit) — mock the import
// so the module's top-level dep doesn't pull in real gh-token resolution.
vi.mock('../identity/octokit-client', () => ({ getOctokit: async () => null }));

const NOW = 1_700_000_000_000;
const old = () => new Date(NOW - DEFAULT_FORK_RETENTION_MS - 86_400_000).toISOString();
const recent = () => new Date(NOW - 60_000).toISOString();

/** Build a mock Octokit. forkOwner defaults to 'alice'; upstream 'Papercusp/papercup'. */
function makeOctokit(opts: {
  login?: string;
  /** repos.get response or 'not_found' (404) for the fork. */
  repo?: { fork?: boolean; parent?: { full_name?: string } | null; pushed_at?: string | null } | 'not_found';
  openPrs?: unknown[];
  onDelete?: () => Promise<void> | void;
}) {
  const login = opts.login ?? 'alice';
  const reposGet = vi.fn(async () => {
    if (opts.repo === 'not_found') {
      const err = new Error('Not Found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return { data: opts.repo ?? {} };
  });
  const reposDelete = vi.fn(async () => {
    if (opts.onDelete) await opts.onDelete();
    return { data: {} };
  });
  const pullsList = vi.fn(async () => ({ data: opts.openPrs ?? [] }));
  return {
    octokit: {
      rest: {
        users: { getAuthenticated: vi.fn(async () => ({ data: { login } })) },
        repos: { get: reposGet, delete: reposDelete },
        pulls: { list: pullsList },
      },
    },
    reposDelete,
    pullsList,
  };
}

const UP = { owner: 'Papercusp', repo: 'papercup' };
const PARENT = 'Papercusp/papercup';

describe('evaluateForkForGc', () => {
  it('TEETH: an abandoned fork (fork of upstream, no open PR, old) → collect', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('collect');
    expect(r.forkFullName).toBe('alice/papercup');
    expect(r.openPrCount).toBe(0);
  });

  it('a fork with an OPEN PR against upstream is kept (live contribution)', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [{ number: 7 }],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_active_pr');
    expect(r.openPrCount).toBe(1);
  });

  it('a recently-pushed fork is kept (covers a just-merged PR)', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: recent() },
      openPrs: [],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_recent');
  });

  it('a repo that is NOT a fork of this upstream is never touched', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: false, parent: null, pushed_at: old() },
      openPrs: [],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_not_a_fork');
  });

  it('a fork whose parent is a DIFFERENT repo (name collision) is never touched', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: 'SomeoneElse/papercup' }, pushed_at: old() },
      openPrs: [],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_not_a_fork');
  });

  it('no fork (404) → keep_absent', async () => {
    const { octokit } = makeOctokit({ repo: 'not_found' });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_absent');
  });

  it('the operator IS the upstream owner ⇒ keep_not_a_fork (no fork to GC)', async () => {
    const { octokit } = makeOctokit({ login: 'Papercusp' });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_not_a_fork');
  });

  it('FAIL-SAFE: an unparseable pushed_at is kept, never collected on a guess', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: null },
      openPrs: [],
    });
    const r = await evaluateForkForGc({ upstreamOwner: UP.owner, upstreamRepo: UP.repo, octokit, now: () => NOW });
    expect(r.decision).toBe('keep_recent');
    expect(r.ageMs).toBeNull();
  });
});

describe('gcForksForUpstreams', () => {
  it('TEETH: dry-run (default) reports would-collect but DELETES NOTHING', async () => {
    const { octokit, reposDelete } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [],
    });
    const report = await gcForksForUpstreams({ upstreams: [UP], octokit, now: () => NOW });
    expect(report.dryRun).toBe(true);
    expect(report.wouldCollect).toEqual(['alice/papercup']);
    expect(report.collected).toEqual([]);
    expect(reposDelete).not.toHaveBeenCalled();
  });

  it('TEETH: dryRun:false deletes the abandoned fork (operator-owned only)', async () => {
    const { octokit, reposDelete } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [],
    });
    const report = await gcForksForUpstreams({ upstreams: [UP], octokit, now: () => NOW, dryRun: false });
    expect(report.collected).toEqual(['alice/papercup']);
    expect(reposDelete).toHaveBeenCalledWith({ owner: 'alice', repo: 'papercup' });
  });

  it('TEETH: an ACTIVE fork (open PR) is NOT deleted even in the destructive pass', async () => {
    const { octokit, reposDelete } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [{ number: 1 }],
    });
    const report = await gcForksForUpstreams({ upstreams: [UP], octokit, now: () => NOW, dryRun: false });
    expect(report.collected).toEqual([]);
    expect(reposDelete).not.toHaveBeenCalled();
  });

  it('a delete failure (e.g. missing delete_repo scope) is recorded, not thrown', async () => {
    const { octokit } = makeOctokit({
      repo: { fork: true, parent: { full_name: PARENT }, pushed_at: old() },
      openPrs: [],
      onDelete: () => {
        throw new Error('Must have admin rights to Repository (delete_repo scope)');
      },
    });
    const report = await gcForksForUpstreams({ upstreams: [UP], octokit, now: () => NOW, dryRun: false });
    expect(report.collected).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain('delete failed');
  });

  it('one upstream erroring does not abort the sweep', async () => {
    const reposGet = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ data: { fork: true, parent: { full_name: 'Papercusp/other' }, pushed_at: old() } });
    const octokit = {
      rest: {
        users: { getAuthenticated: vi.fn(async () => ({ data: { login: 'alice' } })) },
        repos: { get: reposGet, delete: vi.fn() },
        pulls: { list: vi.fn(async () => ({ data: [] })) },
      },
    };
    const report = await gcForksForUpstreams({
      upstreams: [UP, { owner: 'Papercusp', repo: 'other' }],
      octokit,
      now: () => NOW,
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].upstream).toBe('Papercusp/papercup');
    // The second upstream was still evaluated.
    expect(report.evaluations.some((e) => e.forkFullName === 'alice/other')).toBe(true);
  });
});
