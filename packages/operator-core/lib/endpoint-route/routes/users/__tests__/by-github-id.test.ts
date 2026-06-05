/**
 * by-github-id.test.ts — GET /api/users/github/:id (P-072 user profile read).
 *
 * Route-shaped (defineTool), public. Mocks loadUserProfile, the session
 * viewer resolver, and the org pool. Covers id validation, viewer-id
 * resolution (the privacy filter input), and the profile passthrough.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const state: {
    sessionUser: unknown;
    sessionThrows: boolean;
    localIdentity: unknown;
  } = { sessionUser: null, sessionThrows: false, localIdentity: { kind: 'gh_auth_required' } };
  return {
    state,
    loadUserProfile: vi.fn(async () => ({ github_user_id: 0, harnesses: [] })),
    getSessionUserOrDefault: vi.fn(async () => {
      if (state.sessionThrows) throw new Error('no session');
      return state.sessionUser;
    }),
    resolveLocalGithubIdentity: vi.fn(async () => state.localIdentity),
  };
});

vi.mock('../../../../user-profile/load', () => ({ loadUserProfile: H.loadUserProfile }));
vi.mock('../../../../auth', () => ({ getSessionUserOrDefault: H.getSessionUserOrDefault }));
vi.mock('../../../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: H.resolveLocalGithubIdentity,
}));
// Spread the real module — agent-mcp bootstrap imports `generated` from here.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: vi.fn(async () => []) } }),
}));

import route from '../by-github-id';

function ctx(id: string): RouteContext {
  return { principal: null, input: undefined, params: { id }, log: () => {}, signal: new AbortController().signal } as RouteContext;
}
const req = () => new Request('http://localhost/api/users/github/1');

beforeEach(() => {
  H.state.sessionUser = null;
  H.state.sessionThrows = false;
  H.state.localIdentity = { kind: 'gh_auth_required' };
  H.loadUserProfile.mockClear();
  H.loadUserProfile.mockResolvedValue({ github_user_id: 0, harnesses: [] });
  H.resolveLocalGithubIdentity.mockClear();
  H.getSessionUserOrDefault.mockClear();
});

describe('by-github-id route metadata', () => {
  it('exports one public GET route at /users/github/:id', () => {
    expect(route).toHaveLength(1);
    expect(route[0].method).toBe('GET');
    expect(route[0].path).toBe('/users/github/:id');
    expect(route[0].auth).toBe('public');
  });
});

describe('GET /users/github/:id', () => {
  it('400 for a non-numeric id', async () => {
    const res = await route[0].handler(req(), ctx('alice'));
    expect(res.status).toBe(400);
    expect(H.loadUserProfile).not.toHaveBeenCalled();
  });

  it('400 for a non-positive id', async () => {
    expect((await route[0].handler(req(), ctx('0'))).status).toBe(400);
    expect((await route[0].handler(req(), ctx('-5'))).status).toBe(400);
  });

  it('loads the profile for a valid numeric id and returns it', async () => {
    const profile = { github_user_id: 12345, harnesses: [{ slug: 'x' }] };
    H.loadUserProfile.mockResolvedValue(profile);
    const res = await route[0].handler(req(), ctx('12345'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toEqual(profile);
    expect(H.loadUserProfile).toHaveBeenCalledWith(expect.objectContaining({ github_user_id: 12345 }));
  });

  it('passes the session viewer id into the privacy filter', async () => {
    H.state.sessionUser = { github_user_id: 99 };
    await route[0].handler(req(), ctx('12345'));
    expect(H.loadUserProfile).toHaveBeenCalledWith(expect.objectContaining({ viewer_github_user_id: 99 }));
  });

  it('falls back to the LOCAL github identity (desktop viewer) when no session resolves', async () => {
    H.state.sessionThrows = true;
    H.state.localIdentity = { kind: 'ok', token: 'gho_x', githubUserId: 777, githubLogin: 'localdev' };
    await route[0].handler(req(), ctx('12345'));
    expect(H.loadUserProfile).toHaveBeenCalledWith(expect.objectContaining({ viewer_github_user_id: 777 }));
  });

  it('falls back to a null viewer id when neither session nor local identity resolves', async () => {
    H.state.sessionThrows = true;
    H.state.localIdentity = { kind: 'gh_auth_required' };
    await route[0].handler(req(), ctx('12345'));
    expect(H.loadUserProfile).toHaveBeenCalledWith(expect.objectContaining({ viewer_github_user_id: null }));
  });

  it('prefers the session viewer over the local identity (does not consult local when session resolves)', async () => {
    H.state.sessionUser = { github_user_id: 99 };
    H.state.localIdentity = { kind: 'ok', token: 'gho_x', githubUserId: 777, githubLogin: 'localdev' };
    await route[0].handler(req(), ctx('12345'));
    expect(H.loadUserProfile).toHaveBeenCalledWith(expect.objectContaining({ viewer_github_user_id: 99 }));
    expect(H.resolveLocalGithubIdentity).not.toHaveBeenCalled();
  });
});
