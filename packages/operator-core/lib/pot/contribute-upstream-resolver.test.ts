/**
 * Unit coverage for defaultResolveSelfPotMember (contribute-upstream.ts) — the
 * default seam that picks WHICH member repo of the self-pot to contribute
 * upstream from. The contributeUpstream tests inject their own resolver, so the
 * DEFAULT one (registry-backed) is untested. `loadHarnessRegistry` is mocked.
 *
 * Selection contract: among members of `<slug>-pot` that have a path and are
 * NOT the pot home, prefer one carrying a github_remote (the cloned upstream
 * checkout); else the first; null when none qualify.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { loadHarnessRegistry } = vi.hoisted(() => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry }));

import { defaultResolveSelfPotMember } from './contribute-upstream';

const proj = (over: Record<string, unknown>) =>
  ({ slug: 'm', hive_slug: 'web-pot', harness_kind: 'member', path: '/p', ...over }) as never;

beforeEach(() => loadHarnessRegistry.mockReset());

describe('defaultResolveSelfPotMember', () => {
  it('prefers the member carrying a github_remote (and maps upstream + default branch)', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        proj({ slug: 'no-remote', path: '/a' }),
        proj({ slug: 'has-remote', path: '/b', github_remote: 'git@github.com:o/r.git', github_default_branch: 'main' }),
      ],
    });
    const r = await defaultResolveSelfPotMember('web', 'ws');
    expect(r).toMatchObject({
      memberSlug: 'has-remote',
      potSlug: 'web-pot',
      path: '/b',
      upstreamRemote: 'git@github.com:o/r.git',
      defaultBranch: 'main',
    });
  });

  it('falls back to the FIRST member when none carry a remote (no upstreamRemote set)', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [proj({ slug: 'first', path: '/a' }), proj({ slug: 'second', path: '/b' })],
    });
    const r = await defaultResolveSelfPotMember('web', 'ws');
    expect(r?.memberSlug).toBe('first');
    expect(r?.upstreamRemote).toBeUndefined();
  });

  it('excludes the pot HOME (harness_kind:pot) and path-less members', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        proj({ slug: 'web-pot', harness_kind: 'hive', path: '/home' }), // the repo-less home
        proj({ slug: 'no-path', path: undefined }), // not checked out → skip
        proj({ slug: 'real', path: '/r' }),
      ],
    });
    expect((await defaultResolveSelfPotMember('web', 'ws'))?.memberSlug).toBe('real');
  });

  it('only considers members of THIS pot (<slug>-pot), and returns null when none qualify', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [proj({ slug: 'elsewhere', hive_slug: 'other-pot', path: '/x' })],
    });
    expect(await defaultResolveSelfPotMember('web', 'ws')).toBeNull();
  });

  it('maps the fork remote when present', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [proj({ slug: 'm', path: '/p', github_remote: 'up', fork_remote: 'fork' })],
    });
    expect(await defaultResolveSelfPotMember('web', 'ws')).toMatchObject({ upstreamRemote: 'up', forkRemote: 'fork' });
  });
});
