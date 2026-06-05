import { describe, it, expect } from 'vitest';
import { resolveLocalGithubIdentity } from '../resolve-local-github-identity';

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
    expect(r).toEqual({ kind: 'gh_auth_required' });
  });

  it('returns gh_auth_required when GET /user yields no user', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => null,
    });
    expect(r).toEqual({ kind: 'gh_auth_required' });
  });
});
