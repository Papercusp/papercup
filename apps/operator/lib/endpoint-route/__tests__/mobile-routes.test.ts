/**
 * E4 tests (endpoint-unification-2026-05-21) — the migrated `/api/mobile/*`
 * routes.
 *
 * The 33 legacy `_hono/mobile.ts` routes were ported to `defineRoute`
 * modules under `routes/mobile/`. Registration (no path collisions, the
 * literal-before-sub-app shadowing) is covered by
 * `route-shadowing-invariant.test.ts`; mobile auth + CORS are covered by
 * `agent-tools-mobile-auth.test.ts` (E2) and `mobile-cors.test.ts` (E3).
 *
 * This suite drives the DB-free handlers directly with a hand-built
 * `RouteContext` — proving the port preserved the claim → principal
 * field mapping and the handler logic, without standing up PG.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { RouteContext, RouteDefinition } from '../define-route';
import mobileVoice from '../routes/mobile/voice';
import mobilePair from '../routes/mobile/pair';

/** A resolved mobile principal, as `requirePrincipal` would produce. */
const MOBILE_PRINCIPAL: Principal = {
  kind: 'mobile',
  slug: 'device-e4',
  workspaceId: 'ws-e4',
  authMethod: 'jwt',
  trust: 'verified',
  capabilities: new Set(['mobile:*', 'voice:*', 'harness:read']),
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

describe('migrated /api/mobile/* routes — handler behavior (E4)', () => {
  it('GET /mobile/voice returns the 426 "use a websocket" stub', async () => {
    const def = routeByPath(mobileVoice as RouteDefinition<never>[], 'GET', '/mobile/voice');
    const res = await def.handler(new Request('http://x.test/api/mobile/voice'), ctx());
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string; upgrade: string };
    expect(body.error).toBe('use_websocket');
    expect(body.upgrade).toContain('wss://');
  });

  it('GET /mobile/runtime-config maps the principal onto the config payload', async () => {
    const def = routeByPath(mobilePair as RouteDefinition<never>[], 'GET', '/mobile/runtime-config');
    const res = await def.handler(new Request('http://x.test/api/mobile/runtime-config'), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      deviceKind: string;
      voiceWs: { path: string };
    };
    // claims.workspace_id → principal.workspaceId on the migrated route.
    expect(body.workspaceId).toBe('ws-e4');
    expect(body.deviceKind).toBe('mobile');
    expect(body.voiceWs.path).toBe('/api/mobile/voice');
  });

  it('every migrated mobile route is mobile-eligible + carries an auth stance', () => {
    const all = [
      ...(mobileVoice as RouteDefinition<never>[]),
      ...(mobilePair as RouteDefinition<never>[]),
    ];
    for (const def of all) {
      expect(def.mobile, `${def.method} ${def.path} should be mobile:true`).toBe(true);
      expect(def.auth, `${def.method} ${def.path} must declare auth`).toBeDefined();
    }
  });

  it('JWT-gated routes resolve to kind:["mobile"]; pair/mint stay public', () => {
    const pairRoutes = mobilePair as RouteDefinition<never>[];
    const pub = pairRoutes.filter((r) => r.auth === 'public').map((r) => r.path).sort();
    // /pair (one-time token) and /desktop/mint-pair-token (loopback) are
    // the only non-JWT routes in the pair family.
    expect(pub).toEqual(['/mobile/desktop/mint-pair-token', '/mobile/pair']);

    const jwtGated = pairRoutes.filter((r) => r.auth !== 'public');
    for (const def of jwtGated) {
      expect((def.auth as { kind: string[] }).kind).toContain('mobile');
    }
  });
});
