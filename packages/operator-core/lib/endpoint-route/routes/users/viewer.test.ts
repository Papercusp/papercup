/**
 * Tests for the GET /api/viewer endpoint handler — anonymous-vs-authenticated
 * resolution + the hard rule that the OAuth token is never returned.
 * Run with: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/users/viewer.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

const idMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: idMock.fn,
}));

import viewerRoutes from './viewer';

const handler = (viewerRoutes[0] as { handler: (ctx: unknown) => Promise<Response> }).handler;
const body = async () => (await handler({})).json();

describe('GET /viewer', () => {
  it('returns the resolved GitHub identity (without the token)', async () => {
    idMock.fn.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'octocat', token: 'super-secret' });
    const out = await body();
    expect(out).toEqual({ github_user_id: 42, github_login: 'octocat' });
    expect(out.token).toBeUndefined();
  });

  it('returns the anonymous shape when not authenticated (kind !== ok)', async () => {
    idMock.fn.mockResolvedValue({ kind: 'anonymous' });
    expect(await body()).toEqual({ github_user_id: null, github_login: null });
  });

  it('treats a resolution failure as anonymous, never a 500', async () => {
    idMock.fn.mockRejectedValue(new Error('gh cli missing'));
    const res = await handler({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ github_user_id: null, github_login: null });
  });
});
