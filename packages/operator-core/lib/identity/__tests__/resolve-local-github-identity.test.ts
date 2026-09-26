import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveLocalGithubIdentity, invalidateLocalGithubIdentityCache } from '../resolve-local-github-identity';

describe('resolveLocalGithubIdentity', () => {
  it('returns identity when gh is authed', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => ({ id: 42, login: 'alice' }),
    });
    expect(r).toEqual({ kind: 'ok', token: 'tok', githubUserId: 42, githubLogin: 'alice' });
  });

  it('returns gh_auth_required when no token', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'missing' }),
      getUser: async () => { throw new Error('should not be called'); },
    });
    expect(r).toEqual({ kind: 'gh_auth_required', reason: 'no gh token' });
  });

  it('returns gh_auth_required when GET /user yields no user', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => null,
    });
    expect(r).toEqual({ kind: 'gh_auth_required', reason: 'GET /user returned no user' });
  });

  it('returns gh_auth_required when GET /user throws', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => {
        throw new Error('Connect Timeout Error');
      },
    });
    expect(r).toEqual({ kind: 'gh_auth_required', transient: true, reason: 'GET /user failed: Connect Timeout Error' });
  });
});

// phase2 P-005: the GET /user resolution is cached, keyed by the current token,
// so the ~27 callers don't each pay a GitHub network round-trip on the read path.
describe('resolveLocalGithubIdentity — identity cache (P-005)', () => {
  beforeEach(() => invalidateLocalGithubIdentityCache());

  it('serves the second call from cache (getUser NOT re-invoked) for the same token', async () => {
    const getToken = vi.fn(async () => ({ kind: 'ok', token: 'tok-A' }));
    const getUser = vi.fn(async () => ({ id: 7, login: 'bob' }));
    const first = await resolveLocalGithubIdentity({ getToken, getUser, _cache: true });
    const second = await resolveLocalGithubIdentity({ getToken, getUser, _cache: true });
    expect(first).toEqual({ kind: 'ok', token: 'tok-A', githubUserId: 7, githubLogin: 'bob' });
    expect(second).toEqual(first);
    expect(getUser).toHaveBeenCalledTimes(1); // /user hop paid once, not twice
    expect(getToken).toHaveBeenCalledTimes(2); // token freshness still checked every call
  });

  it('a rotated token (re-auth) is a cache MISS — never serves a stale identity', async () => {
    const getUser = vi
      .fn<() => Promise<{ id: number; login: string }>>()
      .mockResolvedValueOnce({ id: 7, login: 'bob' })
      .mockResolvedValueOnce({ id: 9, login: 'carol' });
    const r1 = await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-A' }), getUser, _cache: true });
    const r2 = await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-B' }), getUser, _cache: true });
    expect(r1).toMatchObject({ githubUserId: 7, token: 'tok-A' });
    expect(r2).toMatchObject({ githubUserId: 9, token: 'tok-B' }); // fresh, not cached tok-A
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('invalidateLocalGithubIdentityCache() forces a fresh /user resolution', async () => {
    const getUser = vi.fn(async () => ({ id: 7, login: 'bob' }));
    await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-A' }), getUser, _cache: true });
    invalidateLocalGithubIdentityCache();
    await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-A' }), getUser, _cache: true });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache across injected-mock cases by default (no _cache flag)', async () => {
    const getUser = vi.fn(async () => ({ id: 7, login: 'bob' }));
    await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-A' }), getUser });
    await resolveLocalGithubIdentity({ getToken: async () => ({ kind: 'ok', token: 'tok-A' }), getUser });
    expect(getUser).toHaveBeenCalledTimes(2); // no caching without opt-in
  });
});
