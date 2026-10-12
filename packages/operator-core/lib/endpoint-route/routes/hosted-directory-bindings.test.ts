import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import { createHostedPrincipal, type HostedPrincipal } from '../../auth/hosted-principal';
import type { HostedDirectoryBindingManager, DirectoryBindingInput } from '../../auth/hosted/governance';
import { createHostedDirectoryBindingRoutes } from './hosted-directory-bindings';

function context(organizationId = 'org', permissions = ['members:manage']): RouteContext {
  return { principal: createHostedPrincipal({ workspaceId: 'control', userId: 'admin', activeOrganizationId: 'org',
    sessionId: 'session', sessionVersion: 1, permissions }), params: { organizationId, userId: 'member' },
    input: undefined, log: () => {}, signal: new AbortController().signal };
}
const body = { externalOrganizationId: 'workos-org', directoryId: 'dir', directoryUserId: 'dsync-user',
  authorizedGroupIds: ['group'], purpose: 'Approved mapping', organizationId: 'foreign', userId: 'foreign-user', role: 'owner' };
const request = (method: string, payload = body) => new Request('https://app.papercusp.com/api/hosted/organizations/org/members/member/directory-binding',
  { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('hosted directory binding routes', () => {
  it('passes only path-bound target and requested reduction to the manager', async () => {
    const reduceMembership = vi.fn(async () => ({ membershipId: 'membership', status: 'suspended', auditId: 'audit', changed: true }));
    const route = createHostedDirectoryBindingRoutes({ reduceMembership } as unknown as HostedDirectoryBindingManager)[3];
    const response = await route.handler(request('POST', { status: 'suspended', purpose: 'Remove access' } as never), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reduceMembership.mock.calls[0]).toEqual([context().principal,
      { organizationId: 'org', userId: 'member', status: 'suspended', purpose: 'Remove access' }]);
    expect(await response.json()).toMatchObject({ ok: true, membership: { status: 'suspended', changed: true } });
  });
  it('rejects foreign/unauthorized reductions and body authority overrides before calling the manager', async () => {
    const reduceMembership = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ reduceMembership } as unknown as HostedDirectoryBindingManager)[3];
    expect((await route.handler(request('POST'), context('foreign'))).status).toBe(403);
    expect((await route.handler(request('POST'), context('org', ['workspace:view']))).status).toBe(403);
    expect((await route.handler(request('POST'), context())).status).toBe(400);
    expect(reduceMembership).not.toHaveBeenCalled();
  });
  it.each([
    ['membership_reduction_forbidden', 403], ['membership_reduction_restore_forbidden', 409],
    ['membership_reduction_member_not_found', 404], ['membership_reduction_organization_not_found', 404],
    ['membership_reduction_invalid:status', 400], ['database credential=internal-secret', 503],
  ])('maps reduction %s without leaking internal failure details', async (code, status) => {
    const route = createHostedDirectoryBindingRoutes({ reduceMembership: vi.fn().mockRejectedValue(new TypeError(code)) } as unknown as HostedDirectoryBindingManager)[3];
    const response = await route.handler(request('POST', { status: 'revoked', purpose: 'Remove access' } as never), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: status === 503 ? 'membership_reduction_unavailable' : code } });
  });
  it('exports only the session/path organization with no-store download headers', async () => {
    const review = vi.fn(async (_principal: HostedPrincipal, _input: { organizationId: string; purpose: string }) => ({ members: [], auditId: 'audit' }));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST', { ...body, purpose: 'Quarterly review' }), context());
    expect(response.status).toBe(200);
    expect(review.mock.calls[0]?.[1]).toEqual({ organizationId: 'org', purpose: 'Quarterly review' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('directory-access-review.json');
    expect(await response.json()).toEqual({ ok: true, review: { members: [], auditId: 'audit' } });
  });

  it('rejects unauthorized access review before calling the manager', async () => {
    const review = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    expect((await route.handler(request('POST'), context('foreign'))).status).toBe(403);
    expect((await route.handler(request('POST'), context('org', ['workspace:view']))).status).toBe(403);
    expect(review).not.toHaveBeenCalled();
  });

  it('conceals unexpected TypeError details instead of treating all TypeErrors as input failures', async () => {
    const review = vi.fn().mockRejectedValue(new TypeError('credential=internal-secret'));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST'), context());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'directory_access_review_unavailable' } });
  });

  it.each([
    ['directory_access_review_forbidden', 403], ['directory_access_review_organization_not_found', 404],
    ['directory_access_review_member_limit', 409], ['directory_access_review_identity_limit', 409],
    ['database query credential=internal-secret', 503],
  ])('maps access-review %s without exposing internal failures', async (code, status) => {
    const review = vi.fn().mockRejectedValue(new Error(code));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST'), context());
    expect(response.status).toBe(status);
    if (status === 503) expect(await response.json()).toEqual({ error: { code: 'directory_access_review_unavailable' } });
  });
  it.each([0, 1])('rejects foreign organization and non-admin permissions on route %i before writes', async (index) => {
    const set = vi.fn(); const remove = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ set, remove } as unknown as HostedDirectoryBindingManager)[index];
    expect((await route.handler(request(route.method), context('foreign'))).status).toBe(403);
    expect((await route.handler(request(route.method), context('org', ['workspace:view']))).status).toBe(403);
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it.each([0, 1])('uses path/session tenant binding and excludes email, roles and body user overrides on route %i', async (index) => {
    const set = vi.fn(async (_principal: HostedPrincipal, _input: DirectoryBindingInput) => ({ identityId: 'identity', auditId: 'audit' }));
    const remove = vi.fn(async (_principal: HostedPrincipal, _input: DirectoryBindingInput) => ({ identityId: 'identity', auditId: 'audit' }));
    const route = createHostedDirectoryBindingRoutes({ set, remove } as unknown as HostedDirectoryBindingManager)[index];
    const response = await route.handler(request(route.method), context());
    expect(response.status).toBe(200);
    expect((index === 0 ? set : remove).mock.calls[0]?.[1]).toEqual({ organizationId: 'org', userId: 'member',
      externalOrganizationId: 'workos-org', directoryId: 'dir', directoryUserId: 'dsync-user', authorizedGroupIds: ['group'], purpose: 'Approved mapping' });
  });

  it('returns conflict for subject collision and conceals database errors', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('directory_binding_subject_conflict'))
      .mockRejectedValueOnce(new Error('database query credential=internal-secret'));
    const route = createHostedDirectoryBindingRoutes({ set } as unknown as HostedDirectoryBindingManager)[0];
    expect((await route.handler(request('PUT'), context())).status).toBe(409);
    const failed = await route.handler(request('PUT'), context());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: 'directory_binding_unavailable' } });
  });
});
