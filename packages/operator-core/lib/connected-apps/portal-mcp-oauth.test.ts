/**
 * The PORTAL half of MCP OAuth (plan external-app-access-to-workspaces-2026-09-29 P-325,
 * WI-10004189; D-019, D-021), driven through the real handler with an in-memory store and a fake
 * connector port. The port stands in for HostedWorkspaceSessionBroker: it reports liveness and
 * opens the `app-key-mint` channel the handler asks the machine to mint on. The machine end of that
 * channel is pinned by hosted-app-key-mint-channel.test.ts.
 *
 * What is pinned here: discovery for one workspace's issuer; registration and authorization refuse
 * an offline workspace; only a signed-in account of the owning organization may consent, only from
 * the consent page itself; the approver may only NARROW the requested scope (R-37 analogue); the
 * token endpoint burns a code on a PKCE or redirect mismatch, refuses a replay, and gives the code
 * back when the machine is offline so the app can retry.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostedPrincipal } from '../auth/hosted-principal';
import type { AppRelayConnector, AppRelayPort } from '../workspace-host/hosted-app-relay';
import {
  InMemoryPortalOAuthStore,
  handleHostedMcpOAuth,
  isPortalMcpOAuthPath,
  narrowedGrant,
  type PortalMcpOAuthDependencies,
} from './portal-mcp-oauth';

const PORTAL = 'https://app.papercusp.com';
const WS = 'ws-1';
const ISSUER = `${PORTAL}/api/workspaces/${WS}`;
const REDIRECT = 'https://client.example/callback';
const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

type MintRequest = { type: string; requestId: string; label: string; scopes: Record<string, unknown>; approvedBy: string };

function principal(organization = 'org-1', permissions: string[] = ['workspace:operate']): HostedPrincipal {
  return {
    userId: 'user-1',
    workspaceId: 'control-1',
    activeOrganizationId: organization,
    permissions: new Set(permissions),
  } as unknown as HostedPrincipal;
}

function harness() {
  const state = { live: true, mints: [] as MintRequest[], closed: [] as string[] };
  let answer: (request: MintRequest) => Record<string, unknown> | null = (request) => ({
    type: 'mint.issued',
    requestId: request.requestId,
    key: APP_KEY,
    scopes: request.scopes,
  });
  const connector = (): AppRelayConnector => ({
    binding: { controlPlaneWorkspaceId: 'control-1', organizationId: 'org-1', customerWorkspaceId: WS, hostId: 'h', generation: 1 },
    lastSeenAt: new Date(),
  });
  const port: AppRelayPort = {
    appConnector: (id) => (state.live && id === WS ? connector() : null),
    openAppChannel(_connector, handlers, kind) {
      if (kind !== 'app-key-mint') throw new Error(`unexpected channel kind ${kind}`);
      return {
        send(payload) {
          const request = payload as unknown as MintRequest;
          state.mints.push(request);
          queueMicrotask(() => {
            const frame = answer(request);
            if (frame) handlers.onFrame(frame);
            else handlers.onClose('connector_closed');
          });
          return true;
        },
        close(reason) {
          state.closed.push(reason);
        },
      };
    },
  };
  const sessions = new Map<string, HostedPrincipal>([['me', principal()], ['other', principal('org-2')]]);
  const deps: PortalMcpOAuthDependencies = {
    store: new InMemoryPortalOAuthStore(),
    port,
    async resolvePrincipal(headers) {
      const who = /session=(\w+)/.exec(headers.get('cookie') ?? '')?.[1];
      const found = who ? sessions.get(who) : undefined;
      return found ? { ok: true, principal: found } : { ok: false, reason: 'session_cookie_missing' };
    },
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await handleHostedMcpOAuth(new Request(`${PORTAL}${path}`, init), deps);
    if (!response) throw new Error(`not served: ${path}`);
    return response;
  };
  return {
    state,
    deps,
    call,
    setAnswer(next: typeof answer) {
      answer = next;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function register(h: Harness): Promise<string> {
  const response = await h.call(`/api/workspaces/${WS}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(h: Harness, clientId: string, scope = 'tool:plans:get tool:work_items:list harness:papercusp'): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope,
  });
  const response = await h.call(`/api/workspaces/${WS}/oauth/authorize?${q}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/oauth/consent`);
  return location.searchParams.get('request')!;
}

function consent(h: Harness, handle: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return h.call(`/api/workspaces/${WS}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=me', origin: PORTAL, ...headers },
    body: new URLSearchParams({ request: handle, ...fields }).toString(),
  });
}

async function approve(h: Harness, handle: string, fields: Record<string, string> = { tools: 'plans:get', harnesses: 'papercusp' }) {
  const response = await consent(h, handle, { decision: 'approve', ...fields });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('st-1');
  expect(location.searchParams.get('iss')).toBe(ISSUER);
  return location.searchParams.get('code')!;
}

function token(h: Harness, clientId: string, code: string, verifier = VERIFIER, redirect = REDIRECT) {
  return h.call(`/api/workspaces/${WS}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect }).toString(),
  });
}

describe('portal MCP OAuth discovery (P-325)', () => {
  it('publishes one issuer per workspace, at both RFC 8414 locations', async () => {
    const h = harness();
    const resource = await (await h.call(`/.well-known/oauth-protected-resource/api/workspaces/${WS}/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    for (const path of [`/.well-known/oauth-authorization-server/api/workspaces/${WS}`, `/api/workspaces/${WS}/.well-known/oauth-authorization-server`]) {
      const server = await (await h.call(path)).json();
      expect(server).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
      });
    }
  });

  it('claims only its own paths, so the relay and the plane keep theirs', () => {
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/oauth/token`)).toBe(true);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/mcp`)).toBe(false);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/agent-tools/plans/get`)).toBe(false);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/oauth/../mcp`)).toBe(false);
  });
});

describe('portal MCP OAuth flow (P-325)', () => {
  it('refuses to register or authorize for an offline workspace', async () => {
    const h = harness();
    const clientId = await register(h);
    h.state.live = false;
    const offline = await h.call(`/api/workspaces/${WS}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    });
    expect(offline.status).toBe(503);
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    const auth = await h.call(`/api/workspaces/${WS}/oauth/authorize?${q}`);
    expect(auth.status).toBe(302);
    expect(new URL(auth.headers.get('location')!).searchParams.get('error')).toBe('temporarily_unavailable');
  });

  it('issues the key the MACHINE minted, for exactly the narrowed grant, approved by the signed-in account', async () => {
    const h = harness();
    const clientId = await register(h);
    const handle = await authorize(h, clientId);
    const code = await approve(h, handle);

    const response = await token(h, clientId, code);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: APP_KEY, token_type: 'Bearer', scope: 'tool:plans:get harness:papercusp' });
    expect(h.state.mints).toEqual([
      {
        type: 'mint.request',
        requestId: expect.any(String),
        label: 'Claude',
        scopes: { tools: ['plans:get'], harnesses: ['papercusp'] },
        approvedBy: 'portal:user-1',
      },
    ]);
    expect(h.state.closed).toEqual(['mint_complete']);

    // The code is single-use.
    const replay = await token(h, clientId, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(h.state.mints).toHaveLength(1);
  });

  it('asks a signed-out visitor to sign in, and refuses an account of another organization', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    const page = (cookie?: string) =>
      h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, cookie ? { headers: { cookie } } : {});
    const signedOut = await page();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain('/api/hosted/auth/sign-in');
    expect((await page('session=other')).status).toBe(403);
    expect((await consent(h, handle, { decision: 'approve', tools: 'plans:get' }, { cookie: 'session=other' })).status).toBe(403);
    const form = await page('session=me');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="tools" value="plans:get work_items:list"');
  });

  it('accepts a consent only from its own page (same Origin)', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    expect((await consent(h, handle, { decision: 'approve', tools: 'plans:get' }, { origin: 'https://evil.example' })).status).toBe(403);
    const noOrigin = await h.call(`/api/workspaces/${WS}/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=me' },
      body: new URLSearchParams({ request: handle, decision: 'approve', tools: 'plans:get' }).toString(),
    });
    expect(noOrigin.status).toBe(403);
    // Still pending: the refused posts decided nothing.
    await approve(h, handle);
  });

  it('lets the approver narrow the grant but never widen it, or empty a list the app restricted', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    const widened = await consent(h, handle, { decision: 'approve', tools: 'plans:get admin:shutdown', harnesses: 'papercusp' });
    expect(widened.status).toBe(400);
    expect(await widened.text()).toContain('admin:shutdown was not requested by the app');
    const emptiedHarnesses = await consent(h, handle, { decision: 'approve', tools: 'plans:get', harnesses: '' });
    expect(emptiedHarnesses.status).toBe(400);
    const emptiedTools = await consent(h, handle, { decision: 'approve', tools: ' ', harnesses: 'papercusp' });
    expect(emptiedTools.status).toBe(400);
    expect(h.state.mints).toHaveLength(0);
  });

  it('narrowedGrant: a request that named no tools gets only what the approver lists', () => {
    expect(narrowedGrant({}, { tools: 'plans:get' })).toEqual({ ok: true, scopes: { tools: ['plans:get'] } });
    expect(narrowedGrant({}, {})).toEqual({ ok: true, scopes: {} });
    expect(narrowedGrant({ harnesses: ['a'] }, { harnesses: 'a b' })).toEqual({ ok: false, problem: 'b was not requested by the app' });
  });

  it('tells the approver that a request naming no tools grants none until they list some', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h), '');
    const html = await (await h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, { headers: { cookie: 'session=me' } })).text();
    expect(html).toContain('none yet (the app named no tools)');
    expect(html).not.toContain('every tool');
  });

  it('burns the code on a PKCE or redirect mismatch', async () => {
    for (const [verifier, redirect] of [['w'.repeat(64), REDIRECT], [VERIFIER, 'https://client.example/other']] as const) {
      const h = harness();
      const clientId = await register(h);
      const code = await approve(h, await authorize(h, clientId));
      const bad = await token(h, clientId, code, verifier, redirect);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
      const retry = await token(h, clientId, code);
      expect(retry.status).toBe(400);
      expect(h.state.mints).toHaveLength(0);
    }
  });

  it('gives the code back when the machine is offline or silent, so the app can retry', async () => {
    const h = harness();
    const clientId = await register(h);
    const code = await approve(h, await authorize(h, clientId));
    h.state.live = false;
    const offline = await token(h, clientId, code);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ error: 'temporarily_unavailable' });

    h.state.live = true;
    h.setAnswer(() => null); // the channel closes without an answer
    expect((await token(h, clientId, code)).status).toBe(503);

    h.setAnswer((request) => ({ type: 'mint.issued', requestId: request.requestId, key: APP_KEY, scopes: request.scopes }));
    const retried = await token(h, clientId, code);
    expect(retried.status).toBe(200);
  });

  it('consumes the code when the machine refuses the consented scope', async () => {
    const h = harness();
    const clientId = await register(h);
    const code = await approve(h, await authorize(h, clientId));
    h.setAnswer((request) => ({ type: 'mint.error', requestId: request.requestId, code: 'invalid_scope' }));
    const refused = await token(h, clientId, code);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_scope' });
    h.setAnswer((request) => ({ type: 'mint.issued', requestId: request.requestId, key: APP_KEY, scopes: request.scopes }));
    expect((await token(h, clientId, code)).status).toBe(400);
  });
});
