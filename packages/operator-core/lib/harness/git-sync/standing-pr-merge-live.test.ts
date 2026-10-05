import { describe, expect, it, vi } from 'vitest';
import type { Pr } from '../../pr-host/types';
import { makeLiveStandingPrMerge, suiteCommandFromScripts, type LiveStandingPrMergeResolvers } from './standing-pr-merge-live';
import type { StandingPrMergeDeps } from './standing-pr-merge';

const PR = {
  ref: { number: 7 },
  head_ref: 'papercusp/standing',
  base_ref: 'main',
  head_sha: 'a'.repeat(40),
  review_decision: 'approved',
  checks_state: 'success',
} as unknown as Pr;

const store = { readMeta: async () => ({}), patchMeta: async () => undefined };

function fakeDeps(): StandingPrMergeDeps & { started: number } {
  const d = {
    started: 0,
    readTargetTip: async () => 'b'.repeat(40),
    loadLastTest: async () => null,
    saveTest: async () => undefined,
    buildMergeResult: async () => 'c'.repeat(40),
    async startTests() {
      d.started += 1;
    },
    advanceTarget: async () => ({ ok: true as const }),
  };
  return d;
}

function resolvers(over: Partial<LiveStandingPrMergeResolvers> = {}): Partial<LiveStandingPrMergeResolvers> {
  const deps = fakeDeps();
  return {
    repoDir: async () => '/repo',
    integration: async () => ({ mode: 'review', source: 'set' }) as never,
    promotedSha: async () => PR.head_sha,
    suiteCommand: async () => 'npm ci && npm test',
    runSuite: () => async () => true,
    buildDeps: () => deps,
    ...over,
  };
}

const args = { workspaceId: 'ws', installSlug: 'pot', remote: 'o/r', pr: PR, autoMerge: true, authorRevoked: false };

describe('makeLiveStandingPrMerge', () => {
  it('starts the exact-merge suite in working-copy mode with auto-merge on', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ buildDeps }) });
    const out = await step(args);
    expect(out).toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: 'c'.repeat(40) });
    expect(buildDeps).toHaveBeenCalledWith(expect.objectContaining({ repoDir: '/repo', prNumber: 7 }));
  });

  it('leaves the PR for the owner outside working-copy mode', async () => {
    const step = makeLiveStandingPrMerge({
      store,
      resolvers: resolvers({ integration: async () => ({ mode: 'direct', source: 'set' }) as never }),
    });
    expect(await step(args)).toEqual({ action: 'left-for-owner' });
  });

  it('leaves the PR for the owner when auto-merge is off', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers() });
    expect(await step({ ...args, autoMerge: false })).toEqual({ action: 'left-for-owner' });
  });

  it('refuses without a test suite instead of merging untested code', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ suiteCommand: async () => null, buildDeps }) });
    expect(await step(args)).toMatchObject({ action: 'error' });
    expect(buildDeps).not.toHaveBeenCalled();
  });

  it('refuses a revoked author', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers() });
    expect(await step({ ...args, authorRevoked: true })).toMatchObject({ action: 'refused', reason: 'author-revoked' });
  });

  it('refuses when nothing was promoted to the working copy main', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ promotedSha: async () => null }) });
    expect(await step(args)).toMatchObject({ action: 'refused', reason: 'nothing-promoted' });
  });

  it('turns a resolver failure into an error outcome', async () => {
    const step = makeLiveStandingPrMerge({
      store,
      resolvers: resolvers({ repoDir: async () => { throw new Error('registry down'); } }),
    });
    expect(await step(args)).toEqual({ action: 'error', detail: 'registry down' });
  });
});

describe('suiteCommandFromScripts', () => {
  it('prefers test:affected, then test, else none', () => {
    expect(suiteCommandFromScripts({ test: 'x', 'test:affected': 'y' })).toBe('npm ci && npm run test:affected');
    expect(suiteCommandFromScripts({ test: 'x' })).toBe('npm ci && npm test');
    expect(suiteCommandFromScripts({})).toBeNull();
    expect(suiteCommandFromScripts(undefined)).toBeNull();
  });
});
