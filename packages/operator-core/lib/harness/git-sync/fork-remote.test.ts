import { describe, it, expect, beforeEach, vi } from 'vitest';

// G19 (test-coverage-gap): fork-remote.ts shipped with ZERO tests. This covers
// the contribution-lane config seam (per-hive-learning-loops P-072 / D-007b) —
// the resolution logic that decides WHERE a git-sync pushes (fork vs upstream vs
// none) and the registry write that normalizes a fork URL. A wrong resolution or
// a mis-normalized URL silently breaks the "sync to my fork" contribution path.

// Controllable in-memory registry for the setForkRemote mutation path.
const h = vi.hoisted(() => ({
  registry: { projects: [] as Array<Record<string, unknown>> },
}));
vi.mock('../../harness-registry', () => ({
  mutateHarnessRegistry: async (mutator: (reg: unknown) => unknown) => {
    h.registry = mutator(h.registry) as typeof h.registry;
  },
}));

import { resolveForkPushTarget, setForkRemote, forkRemoteOf } from './fork-remote';

describe('resolveForkPushTarget — fork ALWAYS wins, else upstream-write, else none (D-007b)', () => {
  it('fork configured → target fork', () => {
    const r = resolveForkPushTarget({ forkRemote: 'https://github.com/me/fork.git' });
    expect(r.target).toBe('fork');
    if (r.target === 'fork') {
      expect(r.remote).toBe('https://github.com/me/fork.git');
      expect(r.reason).toMatch(/fork/);
    }
  });

  it('fork wins over upstream EVEN WITH upstream write (a user loop never direct-pushes upstream)', () => {
    const r = resolveForkPushTarget({
      forkRemote: 'https://github.com/me/fork.git',
      upstreamRemote: 'https://github.com/org/up.git',
      upstreamWrite: true,
    });
    expect(r.target).toBe('fork');
    if (r.target === 'fork') expect(r.remote).toBe('https://github.com/me/fork.git');
  });

  it('no fork + upstream write → target upstream (push upstream directly)', () => {
    const r = resolveForkPushTarget({ upstreamRemote: 'https://github.com/org/up.git', upstreamWrite: true });
    expect(r.target).toBe('upstream');
    if (r.target === 'upstream') expect(r.remote).toBe('https://github.com/org/up.git');
  });

  it('no fork + upstream WITHOUT write → none (commit-only; configure a fork to contribute)', () => {
    const r = resolveForkPushTarget({ upstreamRemote: 'https://github.com/org/up.git', upstreamWrite: false });
    expect(r.target).toBe('none');
    if (r.target === 'none') expect(r.reason).toMatch(/configure a fork/);
  });

  it('no fork + unknown upstream write (null) → none (no optimistic upstream push without a fork)', () => {
    const r = resolveForkPushTarget({ upstreamRemote: 'https://github.com/org/up.git', upstreamWrite: null });
    expect(r.target).toBe('none');
  });

  it('no fork + no upstream at all → none (local checkout)', () => {
    const r = resolveForkPushTarget({});
    expect(r.target).toBe('none');
    if (r.target === 'none') expect(r.reason).toMatch(/local checkout/);
  });
});

describe('forkRemoteOf — pure accessor', () => {
  it('returns the configured fork remote', () => {
    expect(forkRemoteOf({ fork_remote: 'https://github.com/me/fork.git' })).toBe('https://github.com/me/fork.git');
  });
  it('returns undefined when unset', () => {
    expect(forkRemoteOf({})).toBeUndefined();
  });
});

describe('setForkRemote — registry write + URL normalization', () => {
  beforeEach(() => {
    h.registry = { projects: [{ slug: 'demo', github_remote: 'https://github.com/org/up.git' }] };
  });

  it('normalizes an SSH fork URL to the canonical HTTPS clone URL', async () => {
    const r = await setForkRemote('demo', 'git@github.com:me/fork.git');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.forkRemote).toBe('https://github.com/me/fork.git');
      expect(r.cleared).toBe(false);
    }
    expect(h.registry.projects[0].fork_remote).toBe('https://github.com/me/fork.git');
  });

  it('normalizes an HTTPS fork URL without a .git suffix', async () => {
    const r = await setForkRemote('demo', 'https://github.com/me/fork');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.forkRemote).toBe('https://github.com/me/fork.git');
    expect(h.registry.projects[0].fork_remote).toBe('https://github.com/me/fork.git');
  });

  it('clears the fork remote with forkUrl=null (field dropped, cleared=true)', async () => {
    h.registry.projects[0].fork_remote = 'https://github.com/me/fork.git';
    const r = await setForkRemote('demo', null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cleared).toBe(true);
    expect('fork_remote' in h.registry.projects[0]).toBe(false);
  });

  it('rejects a non-GitHub URL with invalid_url (registry untouched)', async () => {
    const r = await setForkRemote('demo', 'https://gitlab.com/me/fork');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_url');
    expect(h.registry.projects[0].fork_remote).toBeUndefined();
  });

  it('returns harness_not_found for an unknown slug', async () => {
    const r = await setForkRemote('nope', 'https://github.com/me/fork');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('harness_not_found');
  });
});
