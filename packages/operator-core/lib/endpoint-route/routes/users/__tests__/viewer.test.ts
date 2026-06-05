import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the identity source so the test never touches gh / the network.
const resolveMock = vi.fn();
vi.mock('../../../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: () => resolveMock(),
}));

import routes from '../viewer';

const invoke = async () => {
  const res = await (routes[0] as { handler: (req: unknown, ctx: unknown) => Promise<Response> }).handler(
    {},
    {},
  );
  return { status: res.status, body: await res.json() };
};

describe('GET /api/viewer route shape', () => {
  it('exports one public GET route at /viewer', () => {
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('GET');
    expect(routes[0].path).toBe('/viewer');
    expect(routes[0].auth).toBe('public');
  });
});

describe('viewer handler', () => {
  beforeEach(() => resolveMock.mockReset());

  it('returns the resolved github id + login (NEVER the token) when authenticated', async () => {
    resolveMock.mockResolvedValue({
      kind: 'ok',
      token: 'gho_secret_should_not_leak',
      githubUserId: 1567022,
      githubLogin: 'aviynw',
    });
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toEqual({ github_user_id: 1567022, github_login: 'aviynw' });
    expect(JSON.stringify(body)).not.toContain('gho_secret');
    expect(body).not.toHaveProperty('token');
  });

  it('returns anonymous nulls (200, not an error) when gh is not authenticated', async () => {
    resolveMock.mockResolvedValue({ kind: 'gh_auth_required' });
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toEqual({ github_user_id: null, github_login: null });
  });

  // (The handler also has a defensive try/catch around the resolver — belt-and-
  // suspenders for a documented-never-throws function. Not unit-tested here: a
  // forced mock throw trips vitest's global error detection even when caught.)
});
