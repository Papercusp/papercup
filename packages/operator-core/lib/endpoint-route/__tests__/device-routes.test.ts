/**
 * E4 tests (endpoint-unification-2026-05-21) — the migrated `/api/device/*`
 * routes.
 *
 * The 33 legacy `_hono/mobile.ts` routes were ported to `defineTool`
 * modules under `routes/device/`. Registration (no path collisions, the
 * literal-before-sub-app shadowing) is covered by
 * `route-shadowing-invariant.test.ts`; mobile auth + CORS are covered by
 * `agent-tools-device-auth.test.ts` (E2) and `device-cors.test.ts` (E3).
 *
 * This suite drives the DB-free handlers directly with a hand-built
 * `RouteContext` — proving the port preserved the claim → principal
 * field mapping and the handler logic, without standing up PG.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { RouteContext, RouteDefinition } from '../define-route';
import mobileVoice from '../routes/device/voice';
import mobilePair from '../routes/device/pair';

/** A resolved mobile principal, as `requirePrincipal` would produce. */
const MOBILE_PRINCIPAL: Principal = {
  kind: 'device',
  slug: 'device-e4',
  workspaceId: 'ws-e4',
  authMethod: 'jwt',
  trust: 'verified',
  capabilities: new Set(['device:*', 'voice:*', 'harness:read']),
  label: 'avi@storewolf.com',
};

function ctx(overrides: Partial<RouteContext<unknown>> = {}): RouteContext<unknown> {
  return {
    principal: MOBILE_PRINCIPAL,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

function routeByPath(
  routes: RouteDefinition<never>[],
  method: string,
  path: string,
): RouteDefinition<never> {
  const def = routes.find((r) => r.method === method && r.path === path);
  if (!def) throw new Error(`no ${method} ${path} in the family file`);
  return def;
}

describe('migrated /api/device/* routes — handler behavior (E4)', () => {
  it('GET /device/runtime-config maps the principal onto the config payload', async () => {
    const def = routeByPath(mobilePair as RouteDefinition<never>[], 'GET', '/device/runtime-config');
    const res = await def.handler(new Request('http://x.test/api/device/runtime-config'), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      deviceKind: string;
      voiceWs: { path: string };
    };
    // claims.workspace_id → principal.workspaceId on the migrated route.
    expect(body.workspaceId).toBe('ws-e4');
    expect(body.deviceKind).toBe('mobile');
    expect(body.voiceWs.path).toBe('/api/device/voice');
  });

  it('every migrated mobile route carries an auth stance; cross-origin ones declare cors', () => {
    const all = [
      ...(mobileVoice as RouteDefinition<never>[]),
      ...(mobilePair as RouteDefinition<never>[]),
    ];
    for (const def of all) {
      expect(def.auth, `${def.method} ${def.path} must declare auth`).toBeDefined();
      // The `/device/desktop/*` routes are loopback-only (desktop,
      // same-origin) — no cors. Every other route the phone reaches
      // cross-origin → cors: true.
      if (!def.path.startsWith('/device/desktop/')) {
        expect(def.cors, `${def.method} ${def.path} should be cors:true`).toBe(true);
      }
    }
  });

  it('JWT-gated routes resolve to kind:["device"]; pair/mint stay public', () => {
    const pairRoutes = mobilePair as RouteDefinition<never>[];
    const pub = pairRoutes.filter((r) => r.auth === 'public').map((r) => r.path).sort();
    // /pair (one-time token) and the loopback `/device/desktop/*` routes
    // (mint-pair-token + device list/revoke) are the non-JWT routes.
    expect(pub).toEqual([
      '/device/desktop/devices',
      '/device/desktop/devices/:deviceId',
      '/device/desktop/mint-pair-token',
      '/device/pair',
    ]);

    const jwtGated = pairRoutes.filter((r) => r.auth !== 'public');
    for (const def of jwtGated) {
      expect((def.auth as { kind: string[] }).kind).toContain("device");
    }
  });

  it('desktop device routes (loopback-gated) reject a non-loopback Host with 403', async () => {
    const pairRoutes = mobilePair as RouteDefinition<never>[];
    const evilHost = { host: 'evil.example.com' };

    const list = routeByPath(pairRoutes, 'GET', '/device/desktop/devices');
    const listRes = await list.handler(
      new Request('http://evil.example.com/api/device/desktop/devices', { headers: evilHost }),
      ctx(),
    );
    expect(listRes.status).toBe(403);

    const revoke = routeByPath(pairRoutes, 'DELETE', '/device/desktop/devices/:deviceId');
    const revokeRes = await revoke.handler(
      new Request('http://evil.example.com/api/device/desktop/devices/d1', {
        method: 'DELETE',
        headers: evilHost,
      }),
      ctx({ params: { deviceId: 'd1' } }),
    );
    expect(revokeRes.status).toBe(403);
  });
});
