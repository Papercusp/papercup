/**
 * ensure-fork.test.ts — unit tests for `ensureFork`.
 *
 * Uses a configurable fake Octokit (no network). Covers the four cases of the
 * non-collaborator fork-based code→PR path (non-collaborator-join-fork-pr B1):
 *   1. Fork missing → createFork + poll-until-ready → { created: true }.
 *   2. Fork already exists → no createFork, no poll → { created: false }.
 *   3. Fork never becomes ready within maxWaitMs → throws.
 *   4. Authed user IS the upstream owner → no fork needed → { created: false }.
 */

import { describe, it, expect, vi } from 'vitest';
import { ensureFork, type EnsureForkOpts } from '../ensure-fork';

// ─── Fake Octokit factory ──────────────────────────────────────────────────────

interface FakeOctokitOpts {
  /** Login returned by users.getAuthenticated. */
  login: string;
  /**
   * Sequence of responses for repos.get(forkOwner, repo). Each entry is either
   * `'ok'` (resolves with a fork-shaped repo) or a status to throw (e.g. 404).
   * Consumed in order; the last entry repeats once exhausted.
   */
  reposGetSequence: Array<'ok' | number>;
  /** full_name returned by createFork.data + the 'ok' repos.get. */
  forkFullName: string;
}

function makeFakeOctokit(opts: FakeOctokitOpts) {
  let getCalls = 0;
  const createForkSpy = vi.fn(async () => ({
    data: { full_name: opts.forkFullName, owner: { login: opts.login } },
  }));
  return {
    spy: { createFork: createForkSpy, getReposGetCalls: () => getCalls },
    oc: {
      rest: {
        users: {
          getAuthenticated: vi.fn(async () => ({ data: { login: opts.login } })),
        },
        repos: {
          get: vi.fn(async () => {
            const idx = Math.min(getCalls, opts.reposGetSequence.length - 1);
            const entry = opts.reposGetSequence[idx];
            getCalls++;
            if (entry === 'ok') {
              return {
                data: { full_name: opts.forkFullName, fork: true },
              };
            }
            const err = Object.assign(new Error(`HTTP ${entry}`), { status: entry });
            throw err;
          }),
          createFork: createForkSpy,
        },
      },
    },
  };
}

const baseOpts = (oc: unknown, extra: Partial<EnsureForkOpts> = {}): EnsureForkOpts => ({
  upstreamOwner: 'papercupai',
  upstreamRepo: 'papercup',
  octokit: oc,
  pollIntervalMs: 10,
  maxWaitMs: 100,
  sleep: async () => {}, // instant — no real waiting in tests
  ...extra,
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('ensureFork — fork missing', () => {
  it('creates the fork and polls repos.get until it is ready', async () => {
    // precheck 404 (no fork yet) → createFork → poll 404 (propagating) → poll ok
    const fake = makeFakeOctokit({
      login: 'aviynw',
      reposGetSequence: [404, 404, 'ok'],
      forkFullName: 'aviynw/papercup',
    });
    const result = await ensureFork(baseOpts(fake.oc));
    expect(result.created).toBe(true);
    expect(result.forkOwner).toBe('aviynw');
    expect(result.forkFullName).toBe('aviynw/papercup');
    expect(fake.spy.createFork).toHaveBeenCalledTimes(1);
  });
});

describe('ensureFork — fork already exists', () => {
  it('returns the existing fork without calling createFork', async () => {
    const fake = makeFakeOctokit({
      login: 'aviynw',
      reposGetSequence: ['ok'], // precheck succeeds immediately
      forkFullName: 'aviynw/papercup',
    });
    const result = await ensureFork(baseOpts(fake.oc));
    expect(result.created).toBe(false);
    expect(result.forkOwner).toBe('aviynw');
    expect(result.forkFullName).toBe('aviynw/papercup');
    expect(fake.spy.createFork).not.toHaveBeenCalled();
  });
});

describe('ensureFork — fork never ready', () => {
  it('throws when the fork is not ready within maxWaitMs', async () => {
    const fake = makeFakeOctokit({
      login: 'aviynw',
      reposGetSequence: [404], // precheck 404, and every poll 404 forever
      forkFullName: 'aviynw/papercup',
    });
    await expect(
      ensureFork(baseOpts(fake.oc, { maxWaitMs: 30, pollIntervalMs: 10 })),
    ).rejects.toThrow(/not ready|timed out|timeout/i);
    expect(fake.spy.createFork).toHaveBeenCalledTimes(1);
  });
});

describe('ensureFork — authed user is the upstream owner', () => {
  it('short-circuits: no fork needed, no createFork, no repos.get', async () => {
    const fake = makeFakeOctokit({
      login: 'papercupai', // same as upstreamOwner
      reposGetSequence: ['ok'],
      forkFullName: 'papercupai/papercup',
    });
    const result = await ensureFork(baseOpts(fake.oc));
    expect(result.created).toBe(false);
    expect(result.forkOwner).toBe('papercupai');
    expect(result.forkFullName).toBe('papercupai/papercup');
    expect(fake.spy.createFork).not.toHaveBeenCalled();
    expect(fake.spy.getReposGetCalls()).toBe(0); // short-circuit before any repos.get
  });
});
