import { describe, expect, it } from 'vitest';
import type { RouteDefinition } from '@papercusp/tooldef/define-tool';
import {
  HostedSessionCookieCodec,
  type CreateHostedSessionInput,
  type HostedSession,
} from '../../../auth/hosted-session';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_NOW_MS } from '../../../auth/hosted/fake-provider';
import { hostedIdentityProviderFailure } from '../../../auth/hosted/provider';
import {
  HOSTED_AUTH_CALLBACK_PATH,
  HOSTED_AUTH_FLOW_COOKIE,
  HOSTED_AUTH_ROUTES,
  createHostedAuthRoutes,
  safeHostedReturnTarget,
  type HostedAuthRouteDependencies,
  type HostedAuthSessionStore,
} from './index';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult, HostedAuthFlowStore } from './flow';

const ORIGIN = 'https://app.papercusp.com';
const NOW = new Date(FAKE_HOSTED_IDENTITY_NOW_MS);
const SECRET = 'hosted-route-test-cookie-secret-is-at-least-32-bytes';
const SESSION_ID = `hs_${'A'.repeat(43)}`;

class MemoryFlowStore implements HostedAuthFlowStore {
  readonly flows = new Map<string, HostedAuthFlow>();
  private next = 1;

  async create(flow: HostedAuthFlow): Promise<string> {
    const state = `state-${this.next++}`;
    this.flows.set(state, flow);
    return state;
  }

  async consume(state: string): Promise<HostedAuthFlowConsumeResult> {
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, error: 'already-consumed' };
    this.flows.delete(state);
    return { ok: true, flow };
  }
}

class MemorySessionStore implements HostedAuthSessionStore {
  readonly created: CreateHostedSessionInput[] = [];
  readonly revoked: Array<{ id: string; reason: string }> = [];
  current: HostedSession | null = null;

  async create(input: CreateHostedSessionInput): Promise<HostedSession> {
    this.created.push(input);
    this.current = {
      id: SESSION_ID,
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId ?? null,
      permissionVersion: input.permissionVersion,
      upstreamProvider: input.upstreamProvider,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: NOW,
      rotatedAt: null,
      expiresAt: input.expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt: NOW,
    };
    return this.current;
  }

  async resolve(id: string): Promise<HostedSession | null> {
    return id === this.current?.id && !this.current.revokedAt ? this.current : null;
  }

  async revoke(id: string, reason = 'logout', at = NOW): Promise<boolean> {
    if (id !== this.current?.id || this.current.revokedAt) return false;
    this.revoked.push({ id, reason });
    this.current = { ...this.current, revokedAt: at, revocationReason: reason };
    return true;
  }
}

function fixedEntropy() {
  let value = 1;
  return (size: number) => new Uint8Array(size).fill(value++);
}

function setup(
  provider = createFakeHostedIdentityProvider(),
  bindIdentity: HostedAuthRouteDependencies['bindIdentity'] = async () => ({
    userId: 'user-local-1',
    organizationId: 'org-local-1',
    workspaceId: 'workspace-local-1',
    permissionVersion: 7,
  }),
) {
  const flowStore = new MemoryFlowStore();
  const sessionStore = new MemorySessionStore();
  const codec = new HostedSessionCookieCodec(SECRET);
  const routes = createHostedAuthRoutes({
    provider,
    flowStore,
    sessionStore,
    sessionCookieCodec: codec,
    bindIdentity,
    publicOrigin: ORIGIN,
    clock: () => NOW,
    randomBytes: fixedEntropy(),
  });
  const route = (method: string, path: string) => {
    const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (!found) throw new Error(`missing route ${method} ${path}`);
    return found as RouteDefinition<any>;
  };
  return { provider, flowStore, sessionStore, codec, route };
}

async function invoke(route: RouteDefinition<any>, req: Request): Promise<Response> {
  return route.handler(req, {} as never);
}

function responseCookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`missing response cookie ${name}: ${header}`);
  return decodeURIComponent(match[1]);
}

async function begin(setupResult: ReturnType<typeof setup>, returnTo = '/workspaces/ws-1') {
  const response = await invoke(
    setupResult.route('GET', '/hosted/auth/sign-in'),
    new Request(`${ORIGIN}/api/hosted/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`),
  );
  const location = response.headers.get('location') ?? '';
  return {
    response,
    state: new URL(location).searchParams.get('state') ?? '',
    flowCookie: responseCookieValue(response, HOSTED_AUTH_FLOW_COOKIE),
  };
}

describe('hosted auth route contract', () => {
  it('publishes the explicit route manifest with concrete hosted auth posture', () => {
    expect(HOSTED_AUTH_ROUTES).toEqual([
      { method: 'GET', path: '/hosted/auth/sign-in', access: 'public' },
      { method: 'GET', path: '/hosted/auth/callback', access: 'public' },
      { method: 'POST', path: '/hosted/auth/logout', access: 'authenticated' },
      { method: 'GET', path: '/hosted/auth/session', access: 'authenticated' },
    ]);
    const { route } = setup();
    expect(route('GET', '/hosted/auth/sign-in').auth).toBe('public');
    expect(route('GET', '/hosted/auth/callback').auth).toBe('public');
    expect(route('POST', '/hosted/auth/logout').auth).toEqual({ capabilities: ['workspace:view'] });
    expect(route('GET', '/hosted/auth/session').auth).toEqual({ capabilities: ['workspace:view'] });
  });

  it('starts a browser-bound state/nonce/PKCE flow without exposing the verifier', async () => {
    const s = setup();
    const started = await begin(s);

    expect(started.response.status).toBe(302);
    expect(started.response.headers.get('set-cookie')).toContain(
      `Path=${HOSTED_AUTH_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(s.provider.calls.beginSignIn).toHaveLength(1);
    const input = s.provider.calls.beginSignIn[0];
    expect(input.redirectUri).toBe(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}`);
    expect(input.pkce.method).toBe('S256');
    expect(input.pkce.challenge).not.toBe(s.flowStore.flows.get(started.state)?.pkceCodeVerifier);
    expect(started.response.headers.get('location')).not.toContain('pkceCodeVerifier');
    expect(started.response.headers.get('set-cookie')).not.toContain(
      s.flowStore.flows.get(started.state)?.pkceCodeVerifier ?? 'never',
    );
  });

  it('consumes the callback once, binds membership, and issues only a signed opaque session id', async () => {
    const s = setup();
    const started = await begin(s, '/workspaces/ws-1?tab=activity');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/workspaces/ws-1?tab=activity`);
    expect(response.headers.get('set-cookie')).toContain('__Host-papercusp_session=');
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback[0]).toMatchObject({
      code: 'code-1',
      redirectUri: `${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}`,
    });
    expect(s.sessionStore.created).toEqual([
      {
        userId: 'user-local-1',
        organizationId: 'org-local-1',
        workspaceId: 'workspace-local-1',
        permissionVersion: 7,
        upstreamProvider: 'fake',
        upstreamSessionId: 'session_test_001',
        expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
      },
    ]);
    expect(s.sessionStore.created[0]).not.toHaveProperty('permissions');
    expect(s.sessionStore.created[0]).not.toHaveProperty('capabilities');
    const signedCookie = responseCookieValue(response, '__Host-papercusp_session');
    expect(s.codec.decode(signedCookie)).toBe(SESSION_ID);

    const replay = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: 'invalid_state_already-consumed' } });
  });

  it('rejects an external return target and a callback from the wrong browser', async () => {
    const s = setup();
    const invalid = await invoke(
      s.route('GET', '/hosted/auth/sign-in'),
      new Request(`${ORIGIN}/api/hosted/auth/sign-in?returnTo=${encodeURIComponent('//evil.example')}`),
    );
    expect(invalid.status).toBe(400);
    expect(s.provider.calls.beginSignIn).toHaveLength(0);

    const started = await begin(s);
    const mismatch = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=wrong-browser` },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'browser_flow_mismatch' } });
    expect(s.provider.calls.exchangeCallback).toHaveLength(0);
  });

  it('recovers a callback that omitted state to the public unified-auth entry point', async () => {
    const s = setup();
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1`),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=state_required&hosted_auth_recovery=1`,
    );
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback).toHaveLength(0);
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('recovers a valid provider callback with no active Papercusp membership', async () => {
    const s = setup(createFakeHostedIdentityProvider(), async () => null);
    const started = await begin(s, '/workspaces/ws-1');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=membership_required&hosted_auth_recovery=1`,
    );
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback).toHaveLength(1);
    expect(s.provider.calls.revokeSession).toEqual([{ externalSessionId: 'session_test_001', reason: 'security_event' }]);
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('validates an upstream session and returns metadata with no authority payload', async () => {
    const s = setup();
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: 'workspace-local-1',
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);
    const response = await invoke(
      s.route('GET', '/hosted/auth/session'),
      new Request(`${ORIGIN}/api/hosted/auth/session`, { headers: { cookie } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      identity: { externalUserId: 'user_test_001', emailVerified: true },
      session: {
        sessionId: SESSION_ID,
        userId: 'user-local-1',
        organizationId: 'org-local-1',
        workspaceId: 'workspace-local-1',
        permissionVersion: 7,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/permissions|capabilities/);
  });

  it('revokes and clears a locally valid session when upstream rejects it', async () => {
    const provider = createFakeHostedIdentityProvider({
      script: {
        validateSession: hostedIdentityProviderFailure({
          code: 'session_revoked',
          safeMessage: 'The session was revoked.',
          retryable: false,
        }),
      },
    });
    const s = setup(provider);
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: null,
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);
    const response = await invoke(
      s.route('GET', '/hosted/auth/session'),
      new Request(`${ORIGIN}/api/hosted/auth/session`, { headers: { cookie } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(s.sessionStore.revoked[0]).toMatchObject({ id: SESSION_ID });
  });

  it('requires exact-origin logout and clears locally even when upstream operations fail', async () => {
    const provider = createFakeHostedIdentityProvider({
      script: {
        beginLogout: hostedIdentityProviderFailure({
          code: 'provider_unavailable',
          safeMessage: 'Unavailable.',
          retryable: true,
        }),
        revokeSession: hostedIdentityProviderFailure({
          code: 'provider_unavailable',
          safeMessage: 'Unavailable.',
          retryable: true,
        }),
      },
    });
    const s = setup(provider);
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: null,
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);

    const crossOrigin = await invoke(
      s.route('POST', '/hosted/auth/logout'),
      new Request(`${ORIGIN}/api/hosted/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie },
        body: '{}',
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(s.sessionStore.revoked).toHaveLength(0);

    const response = await invoke(
      s.route('POST', '/hosted/auth/logout'),
      new Request(`${ORIGIN}/api/hosted/auth/logout`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: '/signed-out' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      returnTo: '/signed-out',
      redirectTo: '/signed-out',
      upstreamRevoked: false,
    });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(s.sessionStore.revoked).toEqual([{ id: SESSION_ID, reason: 'user_logout' }]);
  });
});

describe('safeHostedReturnTarget', () => {
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'rejects %s',
    (value) => {
      expect(safeHostedReturnTarget(value, ORIGIN)).toBeNull();
    },
  );

  it('preserves a same-origin relative path, query, and hash', () => {
    expect(safeHostedReturnTarget('/workspaces/ws-1?tab=activity#recent', ORIGIN)).toBe(
      '/workspaces/ws-1?tab=activity#recent',
    );
  });
});
