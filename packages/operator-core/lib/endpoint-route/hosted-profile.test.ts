import { describe, expect, it } from 'vitest';
import type { RouteDefinition } from './define-route';
import { ALL_ROUTES } from './routes';
import {
  HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
  createHostedControlPlaneApp,
  selectHostedControlPlaneRoutes,
  type HostedRouteAllowlistEntry,
} from './hosted-profile';

function route(
  method: RouteDefinition['method'],
  path: string,
  auth: RouteDefinition['auth'],
  body = path,
): RouteDefinition {
  return {
    method,
    path,
    auth,
    handler: () => new Response(body),
  };
}

describe('hosted control-plane route profile', () => {
  it('keeps the production default allowlist explicit and minimal', () => {
    expect(HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST).toEqual([
      { method: 'GET', path: '/health', access: 'public' },
      { method: 'GET', path: '/health/ready', access: 'public' },
    ]);

    expect(
      selectHostedControlPlaneRoutes(ALL_ROUTES).map(({ method, path }) => `${method} ${path}`),
    ).toEqual(['GET /health', 'GET /health/ready']);
  });

  it('mounts only explicitly approved public and capability-scoped routes', async () => {
    const routes = [
      route('GET', '/status', 'public', 'public'),
      route('GET', '/workspaces/:id', { capabilities: ['workspace:view'] }, 'authenticated'),
      route('POST', '/local-only', 'loopback', 'local'),
    ];
    const allowlist: HostedRouteAllowlistEntry[] = [
      { method: 'GET', path: '/status', access: 'public' },
      { method: 'GET', path: '/workspaces/:id', access: 'authenticated' },
    ];
    const app = createHostedControlPlaneApp(routes, allowlist);

    expect((await app.request('/api/status')).status).toBe(200);
    expect((await app.request('/api/local-only')).status).toBe(404);
    // The route is mounted, then the ordinary route stack owns the exact auth
    // response. This focused profile test intentionally does not mock the
    // principal resolver; a non-404 proves registration without coupling the
    // mount matrix to that resolver's infrastructure.
    expect((await app.request('/api/workspaces/ws-1')).status).not.toBe(404);
    expect((await app.request('/api/not-allowlisted')).status).toBe(404);
  });

  it.each([
    ['POST', '/auth/login'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/signup'],
    ['POST', '/auth/change-password'],
    ['GET', '/auth/me'],
    ['PATCH', '/auth/me'],
    ['POST', '/cupboard/install-plugin'],
    ['POST', '/desktop/install-papercusp-files'],
    ['POST', '/provision/run'],
  ] as const)('rejects forbidden local surface %s %s even when explicitly allowlisted', (method, path) => {
    const def = route(method, path, 'public');
    expect(() => selectHostedControlPlaneRoutes(
      [def],
      [{ method, path, access: 'public' }],
    )).toThrow(/forbidden/);
  });

  it('fails closed on missing, duplicate, catch-all, and auth-drifted entries', () => {
    expect(() => selectHostedControlPlaneRoutes([], [
      { method: 'GET', path: '/missing', access: 'public' },
    ])).toThrow(/not registered/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/same', 'public')],
      [
        { method: 'GET', path: '/same', access: 'public' },
        { method: 'GET', path: '/same', access: 'public' },
      ],
    )).toThrow(/duplicate allowlist/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/files/*', 'public')],
      [{ method: 'GET', path: '/files/*', access: 'public' }],
    )).toThrow(/catch-all/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/private', 'loopback')],
      [{ method: 'GET', path: '/private', access: 'authenticated' }],
    )).toThrow(/authenticated principal/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/weak', {})],
      [{ method: 'GET', path: '/weak', access: 'authenticated' }],
    )).toThrow(/concrete capability/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/wildcard', { capabilities: ['*'] })],
      [{ method: 'GET', path: '/wildcard', access: 'authenticated' }],
    )).toThrow(/wildcard capability/);
  });
});
