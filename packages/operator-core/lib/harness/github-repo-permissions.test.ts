import { describe, it, expect, vi } from 'vitest';
import {
  fetchRepoPushPermission,
  type RepoPermissionsOctokit,
} from './github-repo-permissions';

/** Build an injectable narrow client from a repos.get implementation. */
function client(
  get: RepoPermissionsOctokit['repos']['get'],
): RepoPermissionsOctokit {
  return { repos: { get } };
}

describe('fetchRepoPushPermission (injected client — no live GitHub calls)', () => {
  it('returns true when GitHub reports permissions.push === true', async () => {
    const get = vi.fn(async () => ({ data: { permissions: { push: true } } }));
    const out = await fetchRepoPushPermission('acme', 'widgets', { getOctokit: async () => client(get) });
    expect(out).toBe(true);
    expect(get).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
  });

  it('returns false when GitHub reports permissions.push === false', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: { permissions: { push: false } } })),
    });
    expect(out).toBe(false);
  });

  it('returns null when the response has no permissions block', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: {} })),
    });
    expect(out).toBeNull();
  });

  it('returns null when permissions is present but push is absent', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: { permissions: {} } })),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the request fails — 404', async () => {
    const out = await fetchRepoPushPermission('acme', 'gone', {
      getOctokit: async () =>
        client(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the request fails — rate limit (403)', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) on a network-level failure', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw new Error('connect ETIMEDOUT 140.82.0.1:443');
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null when unauthenticated (getOctokit → null, the gh-not-logged-in case)', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', { getOctokit: async () => null });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the client getter itself throws', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => {
        throw new Error('gh CLI exploded');
      },
    });
    expect(out).toBeNull();
  });
});

describe('fetchRepoPushPermission feeds decideGitSyncPush (the B-01 seed-time pairing)', () => {
  it('probe failure → null → the decider goes optimistic true', async () => {
    const { decideGitSyncPush } = await import('./git-sync/decide-git-sync-push');
    const permissionsPush = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw new Error('offline');
        }),
    });
    expect(permissionsPush).toBeNull();
    const d = decideGitSyncPush({ joinerSide: false, hasUpstreamRemote: true, permissionsPush });
    expect(d.push).toBe(true);
    expect(d.reason).toMatch(/^permissions_unknown_optimistic/);
  });
});
