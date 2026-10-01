/**
 * mcp-oauth.integration.test.ts — MCP OAuth on a LOCAL install, end to end, against REAL Postgres
 * with every migration applied (1256 included) and REAL RLS
 * (external-app-access-to-workspaces-2026-09-29 P-006: R-14, R-37).
 *
 * The client is the MCP TypeScript SDK's own OAuth client (`auth()` from
 * `@modelcontextprotocol/sdk/client/auth.js`), given only the server URL — the same code path an
 * off-the-shelf MCP client runs. Its fetch is routed in-process to the real server pieces:
 *
 *   - `/api/mcp`: the real HTTP challenge (`mcpAuthChallenge` with the real loopback verdict and the
 *     real key verifier) — an unauthenticated outside request gets the 401 that starts discovery;
 *   - the root well-known paths: the SAME `MCP_OAUTH_WELL_KNOWN` map the host uses;
 *   - `/api/connected-apps/*`: the real OAuth routes and the real device-approval routes, over the
 *     real `PostgresOAuthStore` / `PostgresDeviceGrantStore`, the real scope resolver and the real
 *     `isLoopbackHost`.
 *
 * Network position is modelled the way a tunnel delivers it (D-001): a public Host, plain http to
 * the operator, X-Forwarded-Proto/For from the tunnel. The approver is a loopback caller. The
 * global fetch is poisoned, so nothing leaves the process (no portal is involved).
 *
 * Harness copied from ./device-grants.integration.test.ts: withWorkspace runs as harness_app
 * (RLS-subject) with the workspace GUC set; getOrgPg().sql is the admin client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
  getOrgPg: () => ({ sql: h.adminSql }),
}));

const { auth, extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
const { createMcpOAuthRoutes } = await import('../endpoint-route/routes/connected-apps/oauth');
const { createConnectedAppRoutes } = await import('../endpoint-route/routes/connected-apps/index');
const { isLoopbackHost } = await import('../endpoint-route/routes/device/_shared');
const { mcpAuthChallenge } = await import('../endpoint-route/routes/transport/mcp-auth-challenge');
const { isLoopbackRequest } = await import('../superuser-token');
const { PostgresOAuthStore } = await import('./mcp-oauth');
const { PostgresDeviceGrantStore } = await import('./device-grants');
const { MCP_OAUTH_WELL_KNOWN } = await import('./mcp-oauth-discovery');
const { createAppKey, resolveAppKeyScopes, rotateAppKey, verifyAppKey } = await import('./store');
const { isAppKeyShaped } = await import('./key');
const { cspAdmitsFormTarget } = await import('./consent-csp');
const { resolveAppKeyPrincipal } = await import('./principal');
const { enforceAppKeyScope } = await import('./enforce');
const { createOrgTestDb } = await import('../../test/_org-test-db');

/** The user's own tunnel (D-001). A browser or client elsewhere reaches the install here. */
const PUBLIC = 'https://ws.example.org';
/** The computer running Papercusp. */
const LOCAL = 'http://127.0.0.1:3070';
const WS = `oauth_ws_${randomBytes(3).toString('hex')}`;
const MCP_SESSION_REACHED = 'mcp-session-reached';

type AnyRoute = { method: string; path: string; handler: (req: Request, ctx: never) => Promise<Response> | Response };

const routes: AnyRoute[] = [
  ...(createMcpOAuthRoutes({
    store: new PostgresOAuthStore(),
    resolveScopes: resolveAppKeyScopes,
    listWorkspaces: () => [{ id: WS, name: 'Test workspace' }],
    isLocal: isLoopbackHost,
  }) as unknown as AnyRoute[]),
  ...(createConnectedAppRoutes({
    grants: new PostgresDeviceGrantStore(),
    createKey: createAppKey,
    rotateKey: rotateAppKey,
    resolveScopes: resolveAppKeyScopes,
    workspaceExists: (id) => id === WS,
    listWorkspaces: () => [{ id: WS, name: 'Test workspace' }],
    isLocal: isLoopbackHost,
  }) as unknown as AnyRoute[]),
];

/** What the operator's HTTP host does with one request that has already reached it. */
async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/api/mcp') {
    const refused = await mcpAuthChallenge(req, { isLocal: isLoopbackRequest, isAppKeyShaped, verifyAppKey });
    // The transport itself is not under test: reaching it is the observable.
    return refused ?? new Response(MCP_SESSION_REACHED, { status: 200 });
  }
  const mapped = MCP_OAUTH_WELL_KNOWN[url.pathname];
  const path = mapped ?? url.pathname;
  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });
  const route = routes.find((r) => r.method === req.method && r.path === path.slice('/api'.length));
  if (!route) return new Response('not found', { status: 404 });
  if (mapped) {
    const target = new URL(url);
    target.pathname = mapped;
    target.search = '';
    req = new Request(target, { method: 'GET', headers: req.headers });
  }
  return route.handler(req, { params: {}, principal: null } as never);
}

/**
 * The wire between a caller and the operator. Anything addressed to the public origin arrives
 * through the tunnel: plain http, the public Host, and the tunnel's forwarding headers. Anything
 * addressed to the local origin is a caller on this machine.
 */
async function wire(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const sent = new Request(input, init);
  const url = new URL(sent.url);
  const headers = new Headers(sent.headers);
  headers.set('host', url.host);
  let arrived = url;
  if (url.origin === PUBLIC) {
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-for', '203.0.113.9');
    arrived = new URL(`http://${url.host}${url.pathname}${url.search}`);
  } else if (url.origin !== LOCAL) {
    throw new Error(`test wire refused ${url.origin}: only the tunnel and this computer exist here`);
  }
  const body = sent.method === 'GET' || sent.method === 'HEAD' ? undefined : await sent.arrayBuffer();
  return serve(new Request(arrived, { method: sent.method, headers, body, redirect: 'manual' }));
}

/** An in-memory OAuth client, shaped like Claude.ai's custom connector (a public client). */
class MemoryClient implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  constructor(private readonly redirect: string, private readonly name = 'Claude') {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'client-state-7f3a';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const initialize = () => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } },
  }),
});

/** The browser follows the waiting page: the user code it shows and the URL it keeps checking. */
async function remoteConsentPage(authorizationUrl: URL): Promise<{ userCode: string; continueUrl: string }> {
  const page = await wire(authorizationUrl);
  expect(page.status).toBe(200);
  const html = await page.text();
  const userCode = /<code>([A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/.exec(html)?.[1];
  const refresh = /url=(\S+)$/.exec(page.headers.get('refresh') ?? '')?.[1];
  expect(userCode, html).toBeTruthy();
  expect(refresh).toMatch(/^\/api\/connected-apps\/oauth\/continue\?request=paz_/);
  return { userCode: userCode!, continueUrl: `${authorizationUrl.origin}${refresh}` };
}

/** The owner, at the computer running Papercusp, decides the code (Settings → Remote access). */
async function ownerDecides(userCode: string, decision: 'approve' | 'deny', narrow?: { tools?: string[] }) {
  const res = await wire(`${LOCAL}/api/connected-apps/device/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_code: userCode, decision, workspace_id: WS, ...(narrow ?? {}) }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** The redirect the client's callback receives. */
function callbackParams(res: Response, redirectUri: string): URLSearchParams {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  return location.searchParams;
}

describe('MCP OAuth on a local install (real PG + real RLS)', () => {
  let db: OrgTestDb;
  let net: MockInstance<typeof fetch>;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('the network was reached; every request here must stay on the test wire');
    });
  });

  afterEach(() => {
    expect(net).not.toHaveBeenCalled();
    net.mockRestore();
  });

  it('R-14: a standard MCP client given only the server URL obtains an access token (discovery, registration, PKCE, consent)', async () => {
    const serverUrl = `${PUBLIC}/api/mcp`;
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const client = new MemoryClient(redirect);

    // 1. The client's first request is refused in the one shape that starts discovery.
    const first = await wire(serverUrl, initialize());
    expect(first.status).toBe(401);
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(first);
    expect(resourceMetadataUrl?.href).toBe(`${PUBLIC}/.well-known/oauth-protected-resource/api/mcp`);

    // 2. Discovery + dynamic registration + PKCE authorization request, all by the SDK.
    expect(await auth(client, { serverUrl, resourceMetadataUrl, scope: 'tool:plans:*', fetchFn: wire })).toBe('REDIRECT');
    expect(client.info?.client_id).toMatch(/^pcoc_/);
    const authorizationUrl = client.authorizationUrl!;
    expect(authorizationUrl.href.startsWith(`${PUBLIC}/api/connected-apps/oauth/authorize?`)).toBe(true);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(serverUrl);

    // 3. The browser is elsewhere: it shows a code and waits; the owner approves on this computer.
    const { userCode, continueUrl } = await remoteConsentPage(authorizationUrl);
    const waiting = await wire(continueUrl);
    expect(waiting.status).toBe(200);
    expect(await waiting.text()).toContain(userCode);
    await ownerDecides(userCode, 'approve');

    // 4. The next check redirects to the client with a one-time code, its state and the issuer.
    const params = callbackParams(await wire(continueUrl), redirect);
    expect(params.get('state')).toBe('client-state-7f3a');
    expect(params.get('iss')).toBe(PUBLIC);
    const code = params.get('code')!;
    expect(code).toMatch(/^pac_/);
    // A replayed continue URL mints nothing further.
    expect((await wire(continueUrl)).status).toBe(400);

    // 5. The SDK exchanges the code (with its PKCE verifier) for an access token.
    expect(await auth(client, { serverUrl, resourceMetadataUrl, authorizationCode: code, fetchFn: wire })).toBe('AUTHORIZED');
    const token = client.tokens()!;
    expect(token.token_type).toBe('Bearer');
    expect(token.access_token).toMatch(/^pcapp_/);
    expect(token.scope).toBe('tool:plans:*');

    // 6. The token opens the MCP endpoint, is a key of the approved workspace, and the code is spent.
    const again = await wire(serverUrl, { ...initialize(), headers: { ...initialize().headers, authorization: `Bearer ${token.access_token}` } });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(MCP_SESSION_REACHED);
    const verdict = await verifyAppKey(token.access_token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.app).toMatchObject({ workspace_id: WS, kind: 'app', label: 'Claude' });
    const [grant] = await db.adminSql`
      SELECT state, app_id, oauth_client_id FROM harness_shared.connected_app_device_grants WHERE user_code = ${userCode}`;
    expect(grant).toEqual({ state: 'consumed', app_id: verdict.app.id, oauth_client_id: client.info!.client_id });
    await expect(auth(client, { serverUrl, resourceMetadataUrl, authorizationCode: code, fetchFn: wire })).rejects.toThrow(/invalid_grant|already used|unknown/i);
  });

  it('R-14: a client on this computer is consented on the local consent page and returns with a code', async () => {
    const serverUrl = `${LOCAL}/api/mcp`;
    const redirect = 'http://localhost:43117/callback';
    const client = new MemoryClient(redirect, 'Local MCP client');

    // No 401 for a local caller; the SDK goes straight to discovery from the server URL.
    expect(await auth(client, { serverUrl, scope: 'tool:plans:*', fetchFn: wire })).toBe('REDIRECT');
    const page = await wire(client.authorizationUrl!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Local MCP client');
    expect(html).toContain('Test workspace');
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? '';
    const tools = /name="tools" size="48" value="([^"]*)"/.exec(html)?.[1];
    expect(tools).toBe('plans:*');

    const decided = await wire(`${LOCAL}/api/connected-apps/device/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: LOCAL, 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({
        user_code: hidden('user_code'),
        oauth_handle: hidden('oauth_handle'),
        workspace_id: WS,
        tools: tools!,
        harnesses: '',
        decision: 'approve',
      }).toString(),
    });
    expect(decided.status).toBe(303);
    const continueHop = `${LOCAL}${decided.headers.get('location')}`;
    const lastHop = await wire(continueHop);
    // WI-10004470: a browser enforces the consent page's form-action on EVERY hop of the form's
    // redirect chain (decision → continue → the client). Under 'self' alone it never reaches the client.
    const csp = page.headers.get('content-security-policy') ?? '';
    const pageUrl = String(client.authorizationUrl);
    for (const hop of [continueHop, lastHop.headers.get('location')!]) {
      expect(cspAdmitsFormTarget(csp, pageUrl, hop), `${hop} under ${csp}`).toBe(true);
    }
    const params = callbackParams(lastHop, redirect);
    expect(params.get('iss')).toBe(LOCAL);

    expect(await auth(client, { serverUrl, authorizationCode: params.get('code')!, fetchFn: wire })).toBe('AUTHORIZED');
    const verdict = await verifyAppKey(client.tokens()!.access_token);
    expect(verdict.ok && verdict.app.workspace_id).toBe(WS);
  });

  it('R-37: the token grants no scope beyond what the owner consented to, even when the client asked for more', async () => {
    const serverUrl = `${PUBLIC}/api/mcp`;
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const client = new MemoryClient(redirect, 'ChatGPT');

    const first = await wire(serverUrl, initialize());
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(first);
    expect(await auth(client, { serverUrl, resourceMetadataUrl, scope: 'tool:plans:* tool:work_items:*', fetchFn: wire })).toBe('REDIRECT');
    const { userCode, continueUrl } = await remoteConsentPage(client.authorizationUrl!);

    // The owner removes work_items:* before allowing.
    await ownerDecides(userCode, 'approve', { tools: ['plans:*'] });
    const code = callbackParams(await wire(continueUrl), redirect).get('code')!;

    // An overreaching client re-asks for the removed scope at the token endpoint; it is ignored.
    const widening: typeof wire = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith('/oauth/token') && init?.body) {
        const form = new URLSearchParams(String(init.body));
        form.set('scope', 'tool:plans:* tool:work_items:*');
        return wire(input, { ...init, body: form.toString() });
      }
      return wire(input, init);
    };
    expect(await auth(client, { serverUrl, resourceMetadataUrl, authorizationCode: code, fetchFn: widening })).toBe('AUTHORIZED');
    const token = client.tokens()!;
    expect(token.scope).toBe('tool:plans:*');

    const verdict = await verifyAppKey(token.access_token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.app.scopes.tools).toEqual(['plans:*']);

    // At the dispatch seat, the consented tool is allowed and the removed one is refused.
    const principal = await resolveAppKeyPrincipal(new Headers({ authorization: `Bearer ${token.access_token}` }));
    expect(principal?.ok).toBe(true);
    if (!principal?.ok) return;
    const call = (toolName: string) =>
      enforceAppKeyScope({
        phase: 'enforce',
        boundary: 'dispatch',
        toolName,
        capabilities: [],
        args: {},
        ctx: { principal: principal.principal, workspaceId: WS } as never,
      });
    expect(await call('plans:list')).toBeNull();
    const refused = await call('work_items:get');
    expect(refused?.decision).toBe('deny');
    expect(refused?.code).toBe('app_scope:tool_not_in_scope');
  });

  it('a denied consent returns access_denied to the client and mints no key', async () => {
    const serverUrl = `${PUBLIC}/api/mcp`;
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const client = new MemoryClient(redirect);
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(await wire(serverUrl, initialize()));
    expect(await auth(client, { serverUrl, resourceMetadataUrl, scope: 'tool:plans:*', fetchFn: wire })).toBe('REDIRECT');
    const { userCode, continueUrl } = await remoteConsentPage(client.authorizationUrl!);
    await ownerDecides(userCode, 'deny');
    const params = callbackParams(await wire(continueUrl), redirect);
    expect(params.get('error')).toBe('access_denied');
    expect(params.get('code')).toBeNull();
    const [grant] = await db.adminSql`
      SELECT state, app_id FROM harness_shared.connected_app_device_grants WHERE user_code = ${userCode}`;
    expect(grant).toEqual({ state: 'denied', app_id: null });
  });
});
