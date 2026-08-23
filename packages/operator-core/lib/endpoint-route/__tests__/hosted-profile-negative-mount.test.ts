import { describe, expect, it } from 'vitest';
import type { RouteDefinition } from '../define-route';
import {
  createHostedControlPlaneApp,
  selectHostedControlPlaneRoutes,
  type HostedRouteAllowlistEntry,
} from '../hosted-profile';

type SyntheticResponse = () => Response;

function syntheticRoute(
  method: RouteDefinition['method'],
  path: string,
  auth: RouteDefinition['auth'],
  invocations: string[],
  response: SyntheticResponse = () => Response.json({ ok: true }),
): RouteDefinition {
  return {
    method,
    path,
    auth,
    handler: () => {
      invocations.push(`${method} ${path}`);
      return response();
    },
  };
}

describe('hosted profile negative local-auth mount matrix', () => {
  it('leaves every local-auth authority surface unreachable while mounting an authenticated control', async () => {
    const invocations: string[] = [];
    const routes: RouteDefinition[] = [
      syntheticRoute('POST', '/auth/signup', 'public', invocations, () =>
        Response.json({ ok: true, user: { username: 'local-user' } }),
      ),
      syntheticRoute('POST', '/auth/login', 'public', invocations, () =>
        Response.json(
          { ok: true, capabilities: ['*'] },
          { headers: { 'set-cookie': 'session=local; Domain=.papercusp.com; Path=/; HttpOnly' } },
        ),
      ),
      syntheticRoute('GET', '/auth/me', 'public', invocations, () =>
        Response.json({ user: { username: 'default', has_password: false }, autoLogin: true }),
      ),
      syntheticRoute('POST', '/hosted/session/wildcard', { capabilities: ['*'] }, invocations, () =>
        Response.json({ capabilities: ['*'] }),
      ),
      syntheticRoute(
        'POST',
        '/hosted/session/domain-cookie',
        'loopback',
        invocations,
        () =>
          new Response('local cookie', {
            headers: { 'set-cookie': 'session=local; Domain=.papercusp.com; Path=/; HttpOnly' },
          }),
      ),
      syntheticRoute('GET', '/hosted/health', 'public', invocations, () => Response.json({ ok: true })),
      syntheticRoute('GET', '/hosted/workspaces/:id', { capabilities: ['workspace:view'] }, invocations, () =>
        Response.json({ workspace: 'mounted' }),
      ),
    ];
    const allowlist: HostedRouteAllowlistEntry[] = [
      { method: 'GET', path: '/hosted/health', access: 'public' },
      { method: 'GET', path: '/hosted/workspaces/:id', access: 'authenticated' },
    ];

    expect(selectHostedControlPlaneRoutes(routes, allowlist).map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /hosted/health',
      'GET /hosted/workspaces/:id',
    ]);

    const app = createHostedControlPlaneApp(routes, allowlist);
    // The public control proves registration occurred. The selector assertion
    // above separately proves the capability-scoped authenticated control was
    // admitted without coupling this hermetic test to a real principal store.
    expect((await app.request('/api/hosted/health')).status).toBe(200);

    const unreachable = [
      ['POST', '/auth/signup'],
      ['POST', '/auth/login'],
      ['GET', '/auth/me'],
      ['POST', '/hosted/session/wildcard'],
      ['POST', '/hosted/session/domain-cookie'],
    ] as const;

    for (const [method, path] of unreachable) {
      const response = await app.request(`/api${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get('set-cookie'), `${method} ${path}`).toBeNull();
    }
    expect(invocations).toEqual(['GET /hosted/health']);
  });

  it('fails closed before mounting when a forbidden or overpowered route is accidentally allowlisted', () => {
    const invocations: string[] = [];
    const cases: Array<{
      route: RouteDefinition;
      entry: HostedRouteAllowlistEntry;
      error: RegExp;
    }> = [
      {
        route: syntheticRoute('POST', '/auth/signup', 'public', invocations),
        entry: { method: 'POST', path: '/auth/signup', access: 'public' },
        error: /local authentication route is forbidden/,
      },
      {
        route: syntheticRoute('POST', '/auth/login', 'public', invocations),
        entry: { method: 'POST', path: '/auth/login', access: 'public' },
        error: /local authentication route is forbidden/,
      },
      {
        route: syntheticRoute('GET', '/auth/me', 'public', invocations),
        entry: { method: 'GET', path: '/auth/me', access: 'public' },
        error: /local authentication route is forbidden/,
      },
      {
        route: syntheticRoute('POST', '/hosted/session/wildcard', { capabilities: ['*'] }, invocations),
        entry: { method: 'POST', path: '/hosted/session/wildcard', access: 'authenticated' },
        error: /wildcard capability authority/,
      },
      {
        route: syntheticRoute('POST', '/hosted/session/domain-cookie', 'loopback', invocations),
        entry: { method: 'POST', path: '/hosted/session/domain-cookie', access: 'authenticated' },
        error: /authenticated principal/,
      },
    ];

    for (const { route, entry, error } of cases) {
      expect(() => createHostedControlPlaneApp([route], [entry])).toThrow(error);
    }
    expect(invocations).toEqual([]);
  });
});
