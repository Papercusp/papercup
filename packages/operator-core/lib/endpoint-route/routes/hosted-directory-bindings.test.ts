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
