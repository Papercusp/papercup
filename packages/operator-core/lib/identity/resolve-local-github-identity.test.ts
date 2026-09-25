import { describe, it, expect } from 'vitest';
import { resolveLocalGithubIdentity } from './resolve-local-github-identity';

const okToken = async () => ({ kind: 'ok', token: 'tok' });
const okUser = async () => ({ id: 7, login: 'aviynw' });

describe('resolveLocalGithubIdentity — definitive vs transient failures', () => {
  it('resolves ok when the token and /user both succeed', async () => {
    const id = await resolveLocalGithubIdentity({ getToken: okToken, getUser: okUser });
    expect(id).toEqual({ kind: 'ok', token: 'tok', githubUserId: 7, githubLogin: 'aviynw' });
  });

  it('gh not logged in → definitive (no transient flag)', async () => {
    const id = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'error', error: { kind: 'not_authenticated' } }),
      getUser: okUser,
    });
    expect(id).toEqual({ kind: 'gh_auth_required', reason: 'not_authenticated' });
  });

  it('gh missing → definitive', async () => {
    const id = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'error', error: { kind: 'gh_cli_missing' } }),
      getUser: okUser,
    });
    expect(id.kind).toBe('gh_auth_required');
    expect(id.kind === 'gh_auth_required' && id.transient).toBeUndefined();
  });

  it('gh failed to run (spawn timeout) → transient, with the reason', async () => {
    const id = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'error', error: { kind: 'gh_cli_failed', reason: 'Command failed: gh auth token' } }),
      getUser: okUser,
    });
    expect(id).toEqual({
      kind: 'gh_auth_required',
      transient: true,
      reason: 'gh auth token failed: Command failed: gh auth token',
    });
  });

  it('token read throws → transient', async () => {
    const id = await resolveLocalGithubIdentity({
      getToken: async () => {
        throw new Error('spawn EAGAIN');
      },
      getUser: okUser,
    });
    expect(id.kind === 'gh_auth_required' && id.transient).toBe(true);
  });

  it('/user network failure (no status / 5xx) → transient', async () => {
    const noStatus = await resolveLocalGithubIdentity({
      getToken: okToken,
      getUser: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(noStatus).toEqual({ kind: 'gh_auth_required', transient: true, reason: 'GET /user failed: fetch failed' });
    const fiveHundred = await resolveLocalGithubIdentity({
      getToken: okToken,
      getUser: async () => {
        throw Object.assign(new Error('Bad Gateway'), { status: 502 });
      },
    });
    expect(fiveHundred.kind === 'gh_auth_required' && fiveHundred.transient).toBe(true);
  });

  it('/user 401 or 403 → definitive (GitHub rejected the token)', async () => {
    for (const status of [401, 403]) {
      const id = await resolveLocalGithubIdentity({
        getToken: okToken,
        getUser: async () => {
          throw Object.assign(new Error('Bad credentials'), { status });
        },
      });
      expect(id).toEqual({ kind: 'gh_auth_required', reason: `GitHub rejected the token (${status})` });
    }
  });

  it('/user returns no user → definitive', async () => {
    const id = await resolveLocalGithubIdentity({ getToken: okToken, getUser: async () => null });
    expect(id).toEqual({ kind: 'gh_auth_required', reason: 'GET /user returned no user' });
  });
});
